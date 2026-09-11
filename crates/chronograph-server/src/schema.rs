//! Service-level schema catalog. The graph lock must precede the catalog lock.
//! Migrations never execute code or rewrite temporal records.
use crate::{ApiError, AppResult, auth, operations::parse};
use chronograph_db::{Edge, ForkStatus, Graph};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, fs, path::Path};

const MAX_SOURCE: usize = 256 * 1024;
const MAX_CATALOG: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Durability {
    #[default]
    Buffered,
    Fsync,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub name: String,
    pub description: String,
    pub default_durability: Durability,
    pub default_query_limit: usize,
    pub strict_relations: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            name: "My graph".into(),
            description: String::new(),
            default_durability: Durability::Buffered,
            default_query_limit: 100,
            strict_relations: false,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Bool,
    U32,
    I32,
    U64,
    I64,
    F32,
    F64,
}
impl PropertyType {
    pub fn bytes(&self) -> usize {
        match self {
            Self::Bool => 1,
            Self::U32 | Self::I32 | Self::F32 => 4,
            _ => 8,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Property {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: PropertyType,
    pub offset: usize,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadEncoding {
    #[default]
    Inline,
    ArrowRecordV1,
}
impl PayloadEncoding {
    fn is_inline(&self) -> bool {
        *self == Self::Inline
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relation {
    #[serde(default, skip_serializing_if = "PayloadEncoding::is_inline")]
    pub payload_encoding: PayloadEncoding,
    pub kind: u16,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Documentation labels: core node identities have no stored type tags.
    pub source_label: String,
    pub target_label: String,
    #[serde(default)]
    pub properties: Vec<Property>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connectors: Vec<chronograph_connector_common::registry::Binding>,
    pub settings: Settings,
    pub relations: Vec<Relation>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub default_durability: Option<Durability>,
    pub default_query_limit: Option<usize>,
    pub strict_relations: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    UpsertRelation {
        relation: Relation,
    },
    BindConnector {
        binding: chronograph_connector_common::registry::Binding,
    },
    DropRelation {
        kind: u16,
    },
    SetSettings {
        settings: SettingsPatch,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Migration {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub operations: Vec<Operation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Applied {
    source: String,
    checksum: String,
    applied_at: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    snapshot: Snapshot,
    history: Vec<Applied>,
    #[serde(skip)]
    poisoned: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewRequest {
    pub source: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyRequest {
    pub source: String,
    pub expected_revision: usize,
    pub checksum: String,
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}
fn label(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn migration(source: &str) -> AppResult<(Migration, String)> {
    if source.len() > MAX_SOURCE {
        return Err(ApiError::bad("Migration exceeds 256 KiB"));
    }
    let m: Migration = serde_json::from_str(source).map_err(ApiError::bad)?;
    if !matches!(m.version, 1 | 2)
        || m.id.is_empty()
        || m.id.len() > 96
        || !m
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !label(&m.name, 120)
        || m.operations.is_empty()
        || m.operations.len() > 128
    {
        return Err(ApiError::bad(
            "Use migration version 1 or 2, an ID of 1–96 letters/digits/_/-, a name of 1–120 bytes and 1–128 operations",
        ));
    }
    if m.version == 1 && m.operations.iter().any(|op| matches!(op, Operation::BindConnector { .. }) || matches!(op, Operation::UpsertRelation { relation } if !relation.payload_encoding.is_inline())) {
        return Err(ApiError::bad("Connector bindings and sidecar encodings require migration version 2"));
    }
    let checksum = auth::hash(&serde_json::to_string(&m).map_err(ApiError::internal)?);
    Ok((m, checksum))
}
impl Snapshot {
    pub fn relation(&self, kind: u16) -> Option<&Relation> {
        self.relations
            .binary_search_by_key(&kind, |r| r.kind)
            .ok()
            .map(|i| &self.relations[i])
    }
    fn validate(&self) -> AppResult<()> {
        let s = &self.settings;
        if !label(&s.name, 80)
            || s.description.len() > 2000
            || !(1..=1000).contains(&s.default_query_limit)
            || self.relations.len() > 1024
        {
            return Err(ApiError::bad(
                "Settings require a name of 1–80 bytes, description ≤2000 bytes, query limit 1–1000 and ≤1024 relations",
            ));
        }
        if self.connectors.len() > 256 {
            return Err(ApiError::bad("At most 256 connector bindings"));
        }
        let mut binding_ids = HashSet::new();
        let mut binding_kinds = HashSet::new();
        for b in &self.connectors {
            b.validate().map_err(ApiError::bad)?;
            if !binding_ids.insert(&b.id)
                || !binding_kinds.insert(b.kind)
                || self
                    .relation(b.kind)
                    .is_none_or(|r| r.payload_encoding != PayloadEncoding::ArrowRecordV1)
            {
                return Err(ApiError::bad(
                    "Bindings need unique IDs/kinds and a matching arrow_record_v1 relation",
                ));
            }
        }
        let mut kinds = HashSet::new();
        let mut names = HashSet::new();
        for r in &self.relations {
            if !identifier(&r.name)
                || !identifier(&r.source_label)
                || !identifier(&r.target_label)
                || r.description.len() > 2000
                || !kinds.insert(r.kind)
                || !names.insert(&r.name)
                || (!r.payload_encoding.is_inline() && !r.properties.is_empty())
                || r.properties.len() > 16
            {
                return Err(ApiError::bad(
                    "Relations need unique kinds and identifier names, endpoint labels, description ≤2000 bytes and ≤16 properties",
                ));
            }
            let mut occupied = [false; 16];
            let mut names = HashSet::new();
            for p in &r.properties {
                if !identifier(&p.name)
                    || !names.insert(&p.name)
                    || p.offset > 16
                    || p.ty.bytes() > 16 - p.offset
                    || occupied[p.offset..p.offset + p.ty.bytes()]
                        .iter()
                        .any(|b| *b)
                {
                    return Err(ApiError::bad(
                        "Properties need unique identifier names and non-overlapping offsets within the 16-byte payload",
                    ));
                }
                occupied[p.offset..p.offset + p.ty.bytes()].fill(true);
            }
        }
        Ok(())
    }
    fn changed(&self, m: &Migration) -> AppResult<Self> {
        let mut next = self.clone();
        for op in &m.operations {
            match op {
                Operation::BindConnector { binding } => {
                    if let Some(existing) = next.connectors.iter().find(|b| b.id == binding.id) {
                        if existing != binding {
                            return Err(ApiError::conflict(
                                "Connector bindings are immutable; create a new instance and kind for a new configuration",
                            ));
                        }
                    } else {
                        next.connectors.push(binding.clone());
                    }
                }
                Operation::UpsertRelation { relation } => {
                    next.relations.retain(|r| r.kind != relation.kind);
                    next.relations.push(relation.clone());
                }
                Operation::DropRelation { kind } => {
                    let len = next.relations.len();
                    next.relations.retain(|r| r.kind != *kind);
                    if len == next.relations.len() {
                        return Err(ApiError::bad(format!(
                            "Relation kind {kind} is not defined"
                        )));
                    }
                }
                Operation::SetSettings { settings: s } => {
                    if let Some(v) = &s.name {
                        next.settings.name = v.clone();
                    }
                    if let Some(v) = &s.description {
                        next.settings.description = v.clone();
                    }
                    if let Some(v) = &s.default_durability {
                        next.settings.default_durability = v.clone();
                    }
                    if let Some(v) = s.default_query_limit {
                        next.settings.default_query_limit = v;
                    }
                    if let Some(v) = s.strict_relations {
                        next.settings.strict_relations = v;
                    }
                }
            }
        }
        next.relations.sort_by_key(|r| r.kind);
        next.validate()?;
        Ok(next)
    }
    pub fn validate_edge(&self, kind: u16, payload: &[u8; 16]) -> AppResult<()> {
        if let Some(r) = self.relation(kind) {
            r.decode(payload)?;
        } else if self.settings.strict_relations {
            return Err(ApiError::bad(format!(
                "Relation kind {kind} is not defined; add it through a schema migration"
            )));
        }
        Ok(())
    }
    pub fn encode(&self, kind: u16, properties: &Value) -> AppResult<[u8; 16]> {
        self.relation(kind)
            .ok_or_else(|| ApiError::bad("Define the relation before using structured properties"))?
            .encode(properties)
    }
}
impl Relation {
    pub fn decode(&self, payload: &[u8; 16]) -> AppResult<Value> {
        if !self.payload_encoding.is_inline() {
            return Ok(json!({"encoding":"arrow_record_v1","reference":auth::hex(payload)}));
        }
        let mut values = serde_json::Map::new();
        for p in &self.properties {
            let b = &payload[p.offset..p.offset + p.ty.bytes()];
            let v = match p.ty {
                PropertyType::Bool => match b[0] {
                    0 => json!(false),
                    1 => json!(true),
                    _ => {
                        return Err(ApiError::bad(format!(
                            "{}.{} must be encoded as 0 or 1",
                            self.name, p.name
                        )));
                    }
                },
                PropertyType::U32 => json!(u32::from_le_bytes(b.try_into().unwrap())),
                PropertyType::I32 => json!(i32::from_le_bytes(b.try_into().unwrap())),
                PropertyType::U64 => json!(u64::from_le_bytes(b.try_into().unwrap()).to_string()),
                PropertyType::I64 => json!(i64::from_le_bytes(b.try_into().unwrap()).to_string()),
                PropertyType::F32 | PropertyType::F64 => {
                    let f = if p.ty == PropertyType::F32 {
                        f32::from_le_bytes(b.try_into().unwrap()) as f64
                    } else {
                        f64::from_le_bytes(b.try_into().unwrap())
                    };
                    if !f.is_finite() {
                        return Err(ApiError::bad(format!(
                            "{}.{} must be finite",
                            self.name, p.name
                        )));
                    }
                    json!(f)
                }
            };
            values.insert(p.name.clone(), v);
        }
        Ok(Value::Object(values))
    }
    fn encode(&self, properties: &Value) -> AppResult<[u8; 16]> {
        if !self.payload_encoding.is_inline() {
            return Err(ApiError::bad("Use connector_ingest for sidecar records"));
        }
        let values = properties
            .as_object()
            .ok_or_else(|| ApiError::bad("properties must be an object"))?;
        if values.len() != self.properties.len()
            || values
                .keys()
                .any(|k| !self.properties.iter().any(|p| &p.name == k))
        {
            return Err(ApiError::bad(
                "Provide exactly the properties defined in the relation",
            ));
        }
        let mut out = [0; 16];
        for p in &self.properties {
            let v = &values[&p.name];
            let bad = || {
                ApiError::bad(format!(
                    "Invalid value for {}.{}; u64/i64 values require decimal strings, other numbers require JSON numbers",
                    self.name, p.name
                ))
            };
            let b = &mut out[p.offset..p.offset + p.ty.bytes()];
            match p.ty {
                PropertyType::Bool => b[0] = u8::from(v.as_bool().ok_or_else(bad)?),
                PropertyType::U32 => b.copy_from_slice(
                    &u32::try_from(v.as_u64().ok_or_else(bad)?)
                        .map_err(|_| bad())?
                        .to_le_bytes(),
                ),
                PropertyType::I32 => b.copy_from_slice(
                    &i32::try_from(v.as_i64().ok_or_else(bad)?)
                        .map_err(|_| bad())?
                        .to_le_bytes(),
                ),
                PropertyType::U64 => b.copy_from_slice(
                    &v.as_str()
                        .ok_or_else(bad)?
                        .parse::<u64>()
                        .map_err(|_| bad())?
                        .to_le_bytes(),
                ),
                PropertyType::I64 => b.copy_from_slice(
                    &v.as_str()
                        .ok_or_else(bad)?
                        .parse::<i64>()
                        .map_err(|_| bad())?
                        .to_le_bytes(),
                ),
                PropertyType::F32 => {
                    b.copy_from_slice(&(v.as_f64().ok_or_else(bad)? as f32).to_le_bytes())
                }
                PropertyType::F64 => b.copy_from_slice(&v.as_f64().ok_or_else(bad)?.to_le_bytes()),
            }
        }
        self.decode(&out)?;
        Ok(out)
    }
}
impl Catalog {
    pub fn open(data: &Path) -> AppResult<Self> {
        let path = data.join("schema.json");
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        if !meta.is_file() || meta.len() > MAX_CATALOG as u64 {
            return Err(ApiError::bad(
                "schema.json must be a regular file within 8 MiB",
            ));
        }
        let catalog: Self = serde_json::from_slice(&fs::read(path)?).map_err(ApiError::bad)?;
        if catalog.history.len() > 1024 {
            return Err(ApiError::bad("Schema history exceeds 1024 migrations"));
        }
        let mut replay = Snapshot::default();
        let mut ids = HashSet::new();
        for h in &catalog.history {
            let (m, checksum) = migration(&h.source)?;
            if checksum != h.checksum || !ids.insert(m.id.clone()) {
                return Err(ApiError::bad(
                    "Schema migration checksum mismatch or duplicate ID",
                ));
            }
            replay = replay.changed(&m)?;
        }
        if replay != catalog.snapshot {
            return Err(ApiError::bad(
                "Schema catalog does not match its migration history",
            ));
        }
        Ok(catalog)
    }
    pub fn snapshot(&self) -> AppResult<&Snapshot> {
        if self.poisoned {
            return Err(ApiError::unavailable(
                "Schema persistence failed; restart to reconcile disk state",
            ));
        }
        Ok(&self.snapshot)
    }
    pub fn public(&self) -> AppResult<Value> {
        self.snapshot()?;
        let history = self.history.iter().enumerate().rev().map(|(i, h)| {
            let (m, _) = migration(&h.source)?;
            Ok(json!({"id":m.id,"name":m.name,"revision":i + 1,"checksum":h.checksum,"applied_at":h.applied_at,"operations":m.operations.len()}))
        }).collect::<AppResult<Vec<_>>>()?;
        Ok(
            json!({"version":2,"connectors":self.snapshot.connectors,"revision":self.history.len(),"settings":self.snapshot.settings,"relations":self.snapshot.relations,"history":history,"limits":{"migration_bytes":MAX_SOURCE,"history":1024,"relations":1024,"payload_bytes":16},"scope":"workspace"}),
        )
    }
    pub fn source(&self, id: &str) -> AppResult<Value> {
        self.snapshot()?;
        for h in &self.history {
            let (m, _) = migration(&h.source)?;
            if m.id == id {
                return Ok(json!({"source":h.source,"checksum":h.checksum}));
            }
        }
        Err(ApiError::missing("Migration does not exist"))
    }
    fn prior(&self, m: &Migration, checksum: &str) -> AppResult<Option<usize>> {
        for (i, h) in self.history.iter().enumerate() {
            if migration(&h.source)?.0.id == m.id {
                if h.checksum != checksum {
                    return Err(ApiError::conflict(
                        "Migration ID already exists with a different checksum; use a new ID",
                    ));
                }
                return Ok(Some(i + 1));
            }
        }
        Ok(None)
    }
    fn plan(&self, g: &Graph, m: &Migration) -> AppResult<Snapshot> {
        let next = self.snapshot()?.changed(m)?;
        // Metadata-only renames/settings are O(catalog). Inspect graph history only
        // for constraint changes, including deltas that can still be merged.
        let constrained: HashSet<_> = self
            .snapshot
            .relations
            .iter()
            .filter(|r| {
                next.relation(r.kind).is_none_or(|n| {
                    n.properties != r.properties || n.payload_encoding != r.payload_encoding
                })
            })
            .map(|r| r.kind)
            .collect();
        let adopted: HashSet<_> = next
            .relations
            .iter()
            .filter(|r| {
                self.snapshot.relation(r.kind).is_none()
                    && (!r.properties.is_empty() || !r.payload_encoding.is_inline())
            })
            .map(|r| r.kind)
            .collect();
        let strict = next.settings.strict_relations && !self.snapshot.settings.strict_relations;
        if !constrained.is_empty() || !adopted.is_empty() || strict {
            let check = |e: &Edge| -> AppResult<()> {
                if constrained.contains(&e.kind.0) {
                    return Err(ApiError::conflict(format!(
                        "Kind {} has stored versions in main or an active branch; its property layout cannot change and its definition cannot be dropped. Use a new kind and retain the historical definition.",
                        e.kind.0
                    )));
                }
                if adopted.contains(&e.kind.0)
                    && next
                        .relation(e.kind.0)
                        .is_some_and(|r| !r.payload_encoding.is_inline())
                {
                    return Err(ApiError::conflict(
                        "Sidecar relations require an unused kind",
                    ));
                }
                if adopted.contains(&e.kind.0) || strict {
                    next.validate_edge(e.kind.0, &e.payload)?;
                }
                Ok(())
            };
            for e in g.history() {
                check(e)?;
            }
            for f in g.forks().filter(|f| f.status == ForkStatus::Active) {
                for e in g.fork_history(f.id)? {
                    check(&e)?;
                }
            }
        }
        Ok(next)
    }
    pub fn preview(&self, g: &Graph, source: &str) -> AppResult<Value> {
        self.snapshot()?;
        let (m, checksum) = migration(source)?;
        let prior = self.prior(&m, &checksum)?;
        let next = if prior.is_some() {
            self.snapshot.clone()
        } else {
            self.plan(g, &m)?
        };
        Ok(
            json!({"id":m.id,"name":m.name,"checksum":checksum,"expected_revision":self.history.len(),"already_applied":prior.is_some(),"applied_revision":prior,"before":self.snapshot,"after":next,"operations":m.operations,"warnings":["Schema is shared by main and all branches. Endpoint labels document intent; nodes do not store type tags.","Existing payload bytes are never rewritten. New definitions interpret them as little-endian fields. Core Rust writers bypass service schema validation."]}),
        )
    }
    pub fn apply(&mut self, g: &mut Graph, data: &Path, request: ApplyRequest) -> AppResult<Value> {
        self.snapshot()?;
        let (m, checksum) = migration(&request.source)?;
        if request.checksum != checksum {
            return Err(ApiError::conflict(
                "Preview checksum does not match this migration; preview again",
            ));
        }
        if let Some(revision) = self.prior(&m, &checksum)? {
            return Ok(
                json!({"applied":false,"already_applied":true,"schema_revision":self.history.len(),"applied_revision":revision,"id":m.id}),
            );
        }
        if request.expected_revision != self.history.len() {
            return Err(ApiError::conflict(
                "Schema changed since preview; refresh and preview again",
            ));
        }
        if self.history.len() >= 1024 {
            return Err(ApiError::bad(
                "Schema history is limited to 1024 migrations",
            ));
        }
        let next = self.plan(g, &m)?;
        let mut history = self.history.clone();
        history.push(Applied {
            source: request.source,
            checksum,
            applied_at: auth::now(),
        });
        let new = Self {
            snapshot: next,
            history,
            poisoned: false,
        };
        let bytes = serde_json::to_vec(&new).map_err(ApiError::internal)?;
        if bytes.len() > MAX_CATALOG {
            return Err(ApiError::bad("Schema catalog exceeds 8 MiB"));
        }
        g.sync()?;
        if let Err(e) = auth::atomic_write(&data.join("schema.json"), &bytes) {
            self.poisoned = true;
            return Err(e);
        }
        *self = new;
        Ok(
            json!({"applied":true,"already_applied":false,"schema_revision":self.history.len(),"id":m.id}),
        )
    }
    pub fn encode_request(&self, args: Value) -> AppResult<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            kind: u16,
            properties: Value,
        }
        let input: Input = parse(args)?;
        let s = self.snapshot()?;
        let payload = s.encode(input.kind, &input.properties)?;
        Ok(
            json!({"kind":input.kind,"payload":auth::hex(&payload),"properties":s.relation(input.kind).unwrap().decode(&payload)?}),
        )
    }
    pub fn enrich(&self, value: &mut Value) {
        // Bounded REST/MCP results only. Raw hex stays available when an external
        // core writer supplied bytes that do not satisfy the service definition.
        match value {
            Value::Array(items) => {
                for item in items {
                    self.enrich(item);
                }
            }
            Value::Object(map) => {
                if let (Some(kind), Some(hex)) = (
                    map.get("kind").and_then(Value::as_u64),
                    map.get("payload").and_then(Value::as_str),
                ) && let Ok(kind) = u16::try_from(kind)
                    && let Some(r) = self.snapshot.relation(kind)
                    && hex.len() == 32
                    && hex.is_ascii()
                {
                    let bytes = (0..16)
                        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16))
                        .collect::<Result<Vec<_>, _>>();
                    if let Ok(bytes) = bytes {
                        map.insert("relation".into(), json!(r.name));
                        match r.decode(bytes.as_slice().try_into().unwrap()) {
                            Ok(v) => {
                                map.insert("properties".into(), v);
                            }
                            Err(e) => {
                                map.insert("schema_error".into(), json!(e.1));
                            }
                        }
                    }
                }
                if let Some(edges) = map.get_mut("edges") {
                    self.enrich(edges);
                }
                if let Some(samples) = map.get_mut("samples") {
                    self.enrich(samples);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chronograph_db::{EdgeInput, EdgeKind, NodeId};
    fn source(id: &str, operations: Value) -> String {
        json!({"version":1,"id":id,"name":"Test migration","operations":operations}).to_string()
    }
    fn relation() -> Value {
        json!({"op":"upsert_relation","relation":{"kind":42,"name":"observes","source_label":"sensor","target_label":"object","properties":[{"name":"confidence","type":"f32","offset":0},{"name":"sequence","type":"u64","offset":8}]}})
    }
    fn apply(c: &mut Catalog, g: &mut Graph, path: &Path, source: &str) -> Value {
        let p = c.preview(g, source).unwrap();
        c.apply(
            g,
            path,
            ApplyRequest {
                source: source.into(),
                checksum: p["checksum"].as_str().unwrap().into(),
                expected_revision: p["expected_revision"].as_u64().unwrap() as usize,
            },
        )
        .unwrap()
    }
    #[test]
    fn persistence_retry_drift_and_backup_restore() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        auth::private_dir(&data).unwrap();
        let mut g = Graph::open(data.join("graph.cgraph")).unwrap();
        let mut c = Catalog::open(&data).unwrap();
        let source = source("001_observes", json!([relation()]));
        let p = c.preview(&g, &source).unwrap();
        assert_eq!(c.public().unwrap()["revision"], 0);
        assert!(!data.join("schema.json").exists());
        assert_eq!(apply(&mut c, &mut g, &data, &source)["applied"], true);
        assert_eq!(
            c.apply(
                &mut g,
                &data,
                ApplyRequest {
                    source: source.clone(),
                    checksum: p["checksum"].as_str().unwrap().into(),
                    expected_revision: 0
                }
            )
            .unwrap()["already_applied"],
            true
        );
        let mut drift: Value = serde_json::from_str(&source).unwrap();
        drift["operations"][0]["relation"]["name"] = json!("watches");
        assert!(c.preview(&g, &drift.to_string()).is_err());
        let reopened = Catalog::open(&data).unwrap();
        assert_eq!(reopened.public().unwrap(), c.public().unwrap());
        assert_eq!(reopened.source("001_observes").unwrap()["source"], source);
        let b = crate::backup::create(&mut g, &data).unwrap();
        let dest = d.path().join("restore");
        crate::backup::restore(
            &crate::backup::path(&data, b["id"].as_str().unwrap()).unwrap(),
            &dest,
        )
        .unwrap();
        assert_eq!(
            Catalog::open(&dest).unwrap().public().unwrap(),
            c.public().unwrap()
        );
        let mut corrupt: Value =
            serde_json::from_slice(&fs::read(data.join("schema.json")).unwrap()).unwrap();
        corrupt["snapshot"]["settings"]["name"] = json!("untracked edit");
        fs::write(data.join("schema.json"), corrupt.to_string()).unwrap();
        assert!(Catalog::open(&data).is_err());
    }
    #[test]
    fn rejects_stale_preview_checksum_and_partial_migration() {
        let d = tempfile::tempdir().unwrap();
        let mut g = Graph::open(d.path().join("graph.cgraph")).unwrap();
        let mut c = Catalog::default();
        let first = source("001", json!([relation()]));
        let second = source(
            "002",
            json!([{"op":"set_settings","settings":{"name":"My world"}}]),
        );
        let p = c.preview(&g, &second).unwrap();
        apply(&mut c, &mut g, d.path(), &first);
        assert!(
            c.apply(
                &mut g,
                d.path(),
                ApplyRequest {
                    source: second.clone(),
                    expected_revision: 0,
                    checksum: p["checksum"].as_str().unwrap().into()
                }
            )
            .is_err()
        );
        assert!(
            c.apply(
                &mut g,
                d.path(),
                ApplyRequest {
                    source: second,
                    expected_revision: 1,
                    checksum: "wrong".into()
                }
            )
            .is_err()
        );
        let invalid = source(
            "003",
            json!([{"op":"set_settings","settings":{"name":"Should not persist"}}, {"op":"drop_relation","kind":999}]),
        );
        assert!(c.preview(&g, &invalid).is_err());
        assert_eq!(
            Catalog::open(d.path()).unwrap().snapshot.settings.name,
            "My graph"
        );
        assert_eq!(c.public().unwrap()["revision"], 1);
    }
    #[test]
    fn protects_main_and_active_branch_layouts_and_enforces_strict_kinds() {
        let d = tempfile::tempdir().unwrap();
        let mut g = Graph::open(d.path().join("graph.cgraph")).unwrap();
        let mut c = Catalog::default();
        apply(
            &mut c,
            &mut g,
            d.path(),
            &source("001", json!([relation()])),
        );
        let payload = c
            .snapshot
            .encode(
                42,
                &json!({"confidence":0.75,"sequence":u64::MAX.to_string()}),
            )
            .unwrap();
        let branch = g.fork(0).unwrap();
        g.add_edges_to_fork(
            branch,
            &[EdgeInput {
                src: NodeId(1),
                dst: NodeId(2),
                kind: EdgeKind(42),
                valid_from: 0,
                payload,
            }],
        )
        .unwrap();
        let drop = source("002", json!([{"op":"drop_relation","kind":42}]));
        assert!(c.preview(&g, &drop).is_err());
        let mut changed = relation();
        changed["relation"]["properties"][0]["offset"] = json!(4);
        assert!(c.preview(&g, &source("003", json!([changed]))).is_err());
        let mut rename = relation();
        rename["relation"]["name"] = json!("watches");
        apply(&mut c, &mut g, d.path(), &source("004", json!([rename])));
        apply(
            &mut c,
            &mut g,
            d.path(),
            &source(
                "005",
                json!([{"op":"set_settings","settings":{"strict_relations":true}}]),
            ),
        );
        assert!(c.snapshot.validate_edge(99, &[0; 16]).is_err());
        g.add_edge(NodeId(3), NodeId(4), EdgeKind(42), 0, payload)
            .unwrap();
        g.discard(branch).unwrap();
        assert!(c.preview(&g, &drop).is_err());
        g.add_edge(NodeId(5), NodeId(6), EdgeKind(99), 0, [0; 16])
            .unwrap();
        apply(
            &mut c,
            &mut g,
            d.path(),
            &source(
                "006",
                json!([{"op":"set_settings","settings":{"strict_relations":false}}]),
            ),
        );
        assert!(
            c.preview(
                &g,
                &source(
                    "007",
                    json!([{"op":"set_settings","settings":{"strict_relations":true}}])
                )
            )
            .is_err()
        );
    }
    #[test]
    fn typed_properties_preserve_exact_integers_and_validate_bytes() {
        let m = migration(&source("001", json!([relation()]))).unwrap().0;
        let s = Snapshot::default().changed(&m).unwrap();
        let properties = json!({"confidence":0.5,"sequence":u64::MAX.to_string()});
        let encoded = s.encode(42, &properties).unwrap();
        assert_eq!(&encoded[..4], &0.5f32.to_le_bytes());
        assert_eq!(&encoded[8..], &u64::MAX.to_le_bytes());
        assert_eq!(
            s.relation(42).unwrap().decode(&encoded).unwrap(),
            properties
        );
        for invalid in [
            json!({"confidence":0.5,"sequence":42}),
            json!({"confidence":1e100,"sequence":"2"}),
            json!({"confidence":0.5}),
            json!({"confidence":0.5,"sequence":"1","extra":0}),
        ] {
            assert!(s.encode(42, &invalid).is_err());
        }
        let mut bad = encoded;
        bad[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(s.validate_edge(42, &bad).is_err());
        let bool_m = migration(&source("002", json!([{"op":"upsert_relation","relation":{"kind":1,"name":"flag","source_label":"a","target_label":"b","properties":[{"name":"enabled","type":"bool","offset":15}]}}]))).unwrap().0;
        let s = s.changed(&bool_m).unwrap();
        let mut bytes = [0; 16];
        bytes[15] = 2;
        assert!(s.validate_edge(1, &bytes).is_err());
    }
    #[test]
    fn invalid_layout_limits_and_adoption_are_checked() {
        let d = tempfile::tempdir().unwrap();
        let mut g = Graph::open(d.path().join("graph.cgraph")).unwrap();
        let c = Catalog::default();
        for offset in [0, 13, usize::MAX] {
            let mut op = relation();
            op["relation"]["properties"][1]["offset"] = json!(offset);
            assert!(c.preview(&g, &source("001", json!([op]))).is_err());
        }
        assert!(c.preview(&g, &" ".repeat(MAX_SOURCE + 1)).is_err());
        assert!(
            c.preview(
                &g,
                r#"{"version":1,"id":"x","name":"x","operations":[],"sql":"drop database"}"#
            )
            .is_err()
        );
        let mut bytes = [0; 16];
        bytes[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        g.add_edge(NodeId(1), NodeId(2), EdgeKind(42), 0, bytes)
            .unwrap();
        assert!(c.preview(&g, &source("002", json!([relation()]))).is_err());
    }
    #[test]
    fn persistence_failure_fails_closed_and_symlinks_are_rejected() {
        let d = tempfile::tempdir().unwrap();
        let mut g = Graph::open(d.path().join("graph.cgraph")).unwrap();
        let mut c = Catalog::default();
        let s = source("001", json!([relation()]));
        let p = c.preview(&g, &s).unwrap();
        fs::create_dir(d.path().join("schema.json")).unwrap();
        assert!(
            c.apply(
                &mut g,
                d.path(),
                ApplyRequest {
                    source: s,
                    expected_revision: 0,
                    checksum: p["checksum"].as_str().unwrap().into()
                }
            )
            .is_err()
        );
        assert!(c.snapshot().is_err());
        assert!(c.public().is_err());
        #[cfg(unix)]
        {
            fs::remove_dir(d.path().join("schema.json")).unwrap();
            std::os::unix::fs::symlink(d.path().join("missing"), d.path().join("schema.json"))
                .unwrap();
            assert!(Catalog::open(d.path()).is_err());
        }
    }
}

#[cfg(test)]
#[test]
fn version_one_checksum_serialization_is_frozen() {
    let source = r#"{"version":1,"id":"frozen","name":"Define observations","operations":[{"op":"upsert_relation","relation":{"kind":7,"name":"observes","description":"","source_label":"source","target_label":"target","properties":[{"name":"value","type":"f32","offset":0}]}}]}"#;
    let (_, checksum) = migration(source).unwrap();
    assert_eq!(checksum, auth::hash(source));
}
