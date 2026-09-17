//! Normalized connector transport. Conversion and asset publication precede graph locks.
use crate::{
    ApiError, AppResult, Shared, auth,
    operations::{number, parse},
    schema::{PayloadEncoding, Snapshot},
};
use chronograph_connector_common::{
    ArrowStore,
    assets::{AssetMetadata, AssetStore},
    registry::{self, Binding},
};
use chronograph_db::{
    BoundedEdgeInput, EdgeId, EdgeInput, EdgeKind, Graph, IngestCursor, IngestReceipt, NodeId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub src: String,
    pub dst: String,
    pub timestamp_us: String,
    #[serde(default)]
    pub valid_to: Option<String>,
    #[serde(default)]
    pub episode: Option<String>,
    #[serde(default)]
    pub assets: BTreeMap<String, String>,
    pub fields: BTreeMap<String, Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ingest {
    instance: String,
    partition: String,
    sequence: String,
    records: Vec<Record>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Select {
    instance: String,
    partition: String,
}
pub fn hex<const N: usize>(s: &str) -> AppResult<[u8; N]> {
    if s.len() != N * 2 || !s.is_ascii() {
        return Err(ApiError::bad("Invalid hexadecimal identifier length"));
    }
    let mut out = [0; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|_| ApiError::bad("Invalid hexadecimal identifier"))?;
    }
    Ok(out)
}
fn binding<'a>(schema: &'a Snapshot, id: &str) -> AppResult<&'a Binding> {
    schema
        .connectors
        .iter()
        .find(|b| b.id == id)
        .ok_or_else(|| {
            ApiError::missing("Connector instance is not configured; apply its migration first")
        })
}
fn receipt(r: &IngestReceipt) -> Value {
    json!({"instance":r.cursor.source,"partition":r.cursor.partition,"sequence":r.cursor.sequence.to_string(),"digest":auth::hex(&r.cursor.digest),"first_edge":r.first_edge.0.to_string(),"edge_count":r.edge_count.to_string(),"revision":r.revision.to_string(),"durability":"fsync"})
}
pub fn catalog() -> Value {
    json!({"registry_version":registry::VERSION,"connectors":registry::DEFINITIONS,"limits":{"records_per_batch":500,"assets_per_batch":64,"http_asset_bytes":1048576,"partitions":4096},"execution":"external producers; normalized transport does not load models or execute uploaded files"})
}
pub fn template(g: &Graph, schema: &Snapshot, args: Value) -> AppResult<Value> {
    let b: Binding = parse(args)?;
    b.validate().map_err(ApiError::bad)?;
    if schema.connectors.iter().any(|v| v.id == b.id)
        || schema.relation(b.kind).is_some()
        || g.history().iter().any(|e| e.kind.0 == b.kind)
    {
        return Err(ApiError::conflict(
            "Instance or kind is already in use; choose a new instance and kind",
        ));
    }
    for f in g
        .forks()
        .filter(|f| f.status == chronograph_db::ForkStatus::Active)
    {
        if g.fork_history(f.id)?.any(|e| e.kind.0 == b.kind) {
            return Err(ApiError::conflict("Kind is used in an active branch"));
        }
    }
    let source=serde_json::to_string_pretty(&json!({"version":2,"id":format!("connector_{}_{}",b.id,&auth::secret()[..12]),"name":format!("Configure {}",b.id),"operations":[{"op":"upsert_relation","relation":{"kind":b.kind,"name":format!("{}_record",b.id),"source_label":"source","target_label":"observation","description":format!("{} / {} contract v{}; {}",b.connector,b.preset,b.contract_version,b.clock_domain),"payload_encoding":"arrow_record_v1","properties":[]}},{"op":"bind_connector","binding":b}]})).map_err(ApiError::internal)?;
    Ok(json!({"source":source,"binding":b,"registry_version":registry::VERSION}))
}

fn validate_record(
    r: &Record,
    b: &Binding,
    assets: &BTreeMap<String, AssetMetadata>,
) -> AppResult<BoundedEdgeInput> {
    let from: i64 = number(&r.timestamp_us)?;
    let to: i64 = r
        .valid_to
        .as_deref()
        .map(number)
        .transpose()?
        .unwrap_or(i64::MAX);
    if from == i64::MAX
        || to < from
        || r.fields.len() > 64
        || r.assets.len() > 32
        || r.episode
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
        || r.fields.keys().any(|k| !registry::identifier(k))
        || r.assets.keys().any(|k| !registry::identifier(k))
    {
        return Err(ApiError::bad(
            "Invalid record interval, episode or field bounds",
        ));
    }
    for (name, shape) in &b.tensor_shapes {
        let asset = r
            .assets
            .get(name)
            .and_then(|id| assets.get(id))
            .ok_or_else(|| ApiError::bad(format!("Missing configured tensor: {name}")))?;
        if asset.kind != "tensor" || &asset.shape != shape {
            return Err(ApiError::bad(format!("Tensor shape mismatch: {name}")));
        }
    }
    let field = |key: &str| r.fields.get(key).unwrap_or(&Value::Null);
    let has_tensor = |name: &str| {
        r.assets
            .get(name)
            .and_then(|id| assets.get(id))
            .is_some_and(|m| m.kind == "tensor")
    };
    match b.connector.as_str() {
        "jepa" | "hierarchical-jepa" => {
            if !has_tensor("latent") || !field("checkpoint").is_string() {
                return Err(ApiError::bad(
                    "JEPA records require a latent tensor asset and checkpoint provenance string",
                ));
            }
            if b.connector == "hierarchical-jepa"
                && (field("level").as_u64().is_none_or(|v| v > 63)
                    || field("horizon_us")
                        .as_str()
                        .and_then(|v| v.parse::<u64>().ok())
                        .is_none()
                    || field("parent_node")
                        .as_str()
                        .and_then(|v| v.parse::<u64>().ok())
                        .is_none())
            {
                return Err(ApiError::bad(
                    "Hierarchical records require level 0–63, horizon_us and parent_node decimal strings",
                ));
            }
        }
        "gymnasium" | "minari" | "physical-ai" => {
            if !field("terminated").is_boolean()
                || !field("truncated").is_boolean()
                || field("reward").as_f64().is_none_or(|v| !v.is_finite())
                || !r.fields.contains_key("action")
            {
                return Err(ApiError::bad(
                    "Transitions require action, finite reward, terminated and truncated",
                ));
            }
        }
        "lsl" if b.preset == "marker-v1" => {
            if !field("marker").is_string() {
                return Err(ApiError::bad("Marker records require a marker string"));
            }
        }
        "lsl" if b.preset == "gap-v1" => {
            if !field("reason").is_string()
                || field("lost_samples")
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_none()
            {
                return Err(ApiError::bad(
                    "Gap records require reason and lost_samples decimal string",
                ));
            }
        }
        "lsl" | "mne" | "brainflow" => {
            if !has_tensor("signal") || b.channels.is_empty() || b.units.len() != b.channels.len() {
                return Err(ApiError::bad(
                    "Signal records require signal tensor, configured channels and units",
                ));
            }
            if r.assets
                .get("signal")
                .and_then(|id| assets.get(id))
                .is_none_or(|m| {
                    m.shape.len() != 2 || m.shape.first().copied() != Some(b.channels.len() as u64)
                })
            {
                return Err(ApiError::bad(
                    "Signal tensor uses [channels, samples] layout",
                ));
            }
        }
        "openqasm" | "qiskit" | "cirq" | "qsharp"
            if b.preset.contains("source") || b.preset.contains("circuit") =>
        {
            if r.assets
                .get("source")
                .and_then(|id| assets.get(id))
                .is_none_or(|m| m.kind != "opaque")
            {
                return Err(ApiError::bad(
                    "Circuit source requires an opaque source asset; no uploaded code is executed",
                ));
            }
        }
        "model-output" => {
            if r.assets.is_empty()
                || !r.assets.keys().all(|name| has_tensor(name))
                || field("model").as_str().is_none_or(str::is_empty)
                || field("checkpoint").as_str().is_none_or(str::is_empty)
            {
                return Err(ApiError::bad(
                    "Model outputs require named tensor assets, model and checkpoint strings",
                ));
            }
        }
        "quantum-results" | "qsharp" if b.preset == "counts-v1" || b.preset == "result-v1" => {
            if field("basis").as_str().is_none_or(str::is_empty)
                || field("counts").as_object().is_none_or(|counts| {
                    counts.is_empty()
                        || counts.len() > 4096
                        || counts.iter().any(|(key, value)| {
                            key.is_empty()
                                || key.len() > 256
                                || value.as_str().and_then(|s| s.parse::<u64>().ok()).is_none()
                        })
                })
            {
                return Err(ApiError::bad(
                    "Quantum counts require an explicit basis and 1–4096 outcome-to-u64-string counts",
                ));
            }
        }
        "quantum-results" => {
            if field("observables").as_object().is_none_or(|values| {
                values.is_empty()
                    || values.len() > 4096
                    || values
                        .values()
                        .any(|v| v.as_f64().is_none_or(|n| !n.is_finite()))
            }) {
                return Err(ApiError::bad(
                    "Quantum observables require 1–4096 named finite numbers",
                ));
            }
        }
        _ => {}
    }
    Ok(BoundedEdgeInput {
        edge: EdgeInput {
            src: NodeId(number(&r.src)?),
            dst: NodeId(number(&r.dst)?),
            kind: EdgeKind(b.kind),
            valid_from: from,
            payload: [0; 16],
        },
        valid_to: to,
    })
}

/// Called within the bounded blocking worker pool, before the generic operation takes locks.
pub fn execute(state: &Shared, op: &str, args: Value) -> AppResult<Value> {
    match op {
        "asset_compose" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Compose {
                metadata: AssetMetadata,
                chunks: Vec<String>,
            }
            let q: Compose = parse(args)?;
            if q.chunks.is_empty() || q.chunks.len() > 16 {
                return Err(ApiError::bad("Provide 1–16 immutable chunks"));
            }
            let store =
                AssetStore::open(state.data.join("sidecars/assets-v1")).map_err(ApiError::bad)?;
            let mut bytes = Vec::new();
            for id in &q.chunks {
                let chunk = store.get(&hex(id)?).map_err(ApiError::bad)?;
                if chunk.metadata.kind != "opaque"
                    || chunk.metadata.encoding != "chunk_v1"
                    || chunk.bytes.len() > 1024 * 1024
                {
                    return Err(ApiError::bad(
                        "Composition requires opaque chunk_v1 assets ≤1 MiB each",
                    ));
                }
                bytes.extend_from_slice(&chunk.bytes);
            }
            let id = store.put(&q.metadata, &bytes).map_err(ApiError::bad)?;
            Ok(
                json!({"asset":auth::hex(&id),"bytes":bytes.len(),"metadata":q.metadata,"durability":"fsync"}),
            )
        }
        "asset_put" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Upload {
                metadata: AssetMetadata,
                data_hex: String,
            }
            let u: Upload = parse(args)?;
            if u.data_hex.len() > 2 * 1024 * 1024
                || !u.data_hex.len().is_multiple_of(2)
                || !u.data_hex.is_ascii()
            {
                return Err(ApiError::bad(
                    "Asset upload limit is 1 MiB of binary content per request",
                ));
            }
            let bytes = (0..u.data_hex.len() / 2)
                .map(|i| {
                    u8::from_str_radix(&u.data_hex[i * 2..i * 2 + 2], 16)
                        .map_err(|_| ApiError::bad("Invalid asset hex"))
                })
                .collect::<AppResult<Vec<_>>>()?;
            let store =
                AssetStore::open(state.data.join("sidecars/assets-v1")).map_err(ApiError::bad)?;
            let id = store.put(&u.metadata, &bytes).map_err(ApiError::bad)?;
            Ok(
                json!({"asset":auth::hex(&id),"bytes":bytes.len(),"metadata":u.metadata,"durability":"fsync"}),
            )
        }
        "asset_get" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Get {
                asset: String,
                #[serde(default)]
                content: bool,
                #[serde(default)]
                offset: usize,
                #[serde(default = "download_limit")]
                limit: usize,
            }
            let q: Get = parse(args)?;
            let store =
                AssetStore::open(state.data.join("sidecars/assets-v1")).map_err(ApiError::bad)?;
            let a = store.get(&hex(&q.asset)?).map_err(ApiError::bad)?;
            if q.offset > a.bytes.len() || q.limit == 0 || q.limit > 1024 * 1024 {
                return Err(ApiError::bad("Invalid asset byte range; limit is 1 MiB"));
            }
            let end = (q.offset + q.limit).min(a.bytes.len());
            Ok(
                json!({"asset":q.asset,"bytes":a.bytes.len(),"sha256":auth::hex(&a.sha256),"metadata":a.metadata,"offset":q.offset,"next_offset":if q.content && end<a.bytes.len() {Some(end)} else {None},"data_hex":if q.content {Some(auth::hex(&a.bytes[q.offset..end]))} else {None}}),
            )
        }
        "connector_checkpoint" => {
            let q: Select = parse(args)?;
            let g = state.graph.read().map_err(ApiError::internal)?;
            let catalog = state.schema.read().map_err(ApiError::internal)?;
            binding(catalog.snapshot()?, &q.instance)?;
            Ok(json!({"checkpoint":g.checkpoint(&q.instance,&q.partition).map(receipt)}))
        }
        "connector_record" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Get {
                edge: String,
            }
            let q: Get = parse(args)?;
            let (payload, b) = {
                let g = state.graph.read().map_err(ApiError::internal)?;
                let catalog = state.schema.read().map_err(ApiError::internal)?;
                let e = g
                    .edge(EdgeId(number(&q.edge)?))
                    .ok_or_else(|| ApiError::missing("Edge not found"))?;
                let b = catalog
                    .snapshot()?
                    .connectors
                    .iter()
                    .find(|b| b.kind == e.kind.0)
                    .ok_or_else(|| ApiError::bad("Edge is not a connector record"))?;
                (e.payload, b.clone())
            };
            let store =
                ArrowStore::open(state.data.join("sidecars/records-v1")).map_err(ApiError::bad)?;
            let (batch, row) = store.read(payload).map_err(ApiError::bad)?;
            let mapping = serde_json::to_string(&b).map_err(ApiError::internal)?;
            let record: Record = chronograph_connector_common::decode(
                &batch,
                row,
                "normalized_records_v1",
                &mapping,
            )
            .map_err(ApiError::bad)?;
            Ok(json!({"record":record,"binding":b}))
        }
        "connector_ingest" => {
            let q: Ingest = parse(args)?;
            if q.records.is_empty() || q.records.len() > 500 {
                return Err(ApiError::bad("Provide 1–500 records per batch"));
            }
            let b = {
                let s = state.schema.read().map_err(ApiError::internal)?;
                binding(s.snapshot()?, &q.instance)?.clone()
            };
            let serialized = serde_json::to_vec(&q).map_err(ApiError::internal)?;
            if serialized.len() > 2 * 1024 * 1024 {
                return Err(ApiError::bad("Normalized records exceed 2 MiB"));
            }
            let cursor = IngestCursor {
                source: q.instance.clone(),
                partition: q.partition.clone(),
                sequence: number(&q.sequence)?,
                digest: Sha256::digest(&serialized).into(),
            };
            // Avoid rewriting sidecars on a lost-ack retry. The graph checks digest again at commit.
            {
                let g = state.graph.read().map_err(ApiError::internal)?;
                if let Some(old) = g.checkpoint(&q.instance, &q.partition) {
                    if old.cursor == cursor {
                        return Ok(json!({"receipt":receipt(old),"already_applied":true}));
                    }
                    if old.cursor.sequence.checked_add(1) != Some(cursor.sequence) {
                        return Err(ApiError::conflict(
                            "Conflicting digest or non-contiguous sequence",
                        ));
                    }
                } else if cursor.sequence != 0 {
                    return Err(ApiError::conflict("Start a new partition at sequence 0"));
                }
            }
            let store =
                AssetStore::open(state.data.join("sidecars/assets-v1")).map_err(ApiError::bad)?;
            let mut assets = BTreeMap::new();
            for r in &q.records {
                for id in r.assets.values() {
                    if !assets.contains_key(id) {
                        if assets.len() >= 64 {
                            return Err(ApiError::bad("At most 64 distinct assets per batch"));
                        }
                        assets.insert(
                            id.clone(),
                            store.get(&hex(id)?).map_err(ApiError::bad)?.metadata,
                        );
                    }
                }
            }
            let mut edges = q
                .records
                .iter()
                .map(|r| validate_record(r, &b, &assets))
                .collect::<AppResult<Vec<_>>>()?;
            let mapping = serde_json::to_string(&b).map_err(ApiError::internal)?;
            let batch = chronograph_connector_common::records(
                "normalized_records_v1",
                &mapping,
                &q.records,
            )
            .map_err(ApiError::bad)?;
            let records =
                ArrowStore::open(state.data.join("sidecars/records-v1")).map_err(ApiError::bad)?;
            let payloads = records.put(&batch).map_err(ApiError::bad)?;
            for (edge, payload) in edges.iter_mut().zip(payloads) {
                edge.edge.payload = payload;
            }
            let mut g = state.graph.write().map_err(ApiError::internal)?;
            let s = state.schema.read().map_err(ApiError::internal)?;
            if binding(s.snapshot()?, &q.instance)? != &b {
                return Err(ApiError::conflict("Connector configuration changed"));
            }
            let already = g
                .checkpoint(&q.instance, &q.partition)
                .is_some_and(|old| old.cursor == cursor);
            let result = g.ingest(cursor, &edges)?;
            Ok(json!({"receipt":receipt(&result),"already_applied":already}))
        }
        _ => Err(ApiError::missing("Unknown connector operation")),
    }
}

fn download_limit() -> usize {
    1024 * 1024
}

pub fn reject_raw_sidecar(schema: &Snapshot, kind: u16) -> AppResult<()> {
    if schema
        .relation(kind)
        .is_some_and(|r| r.payload_encoding == PayloadEncoding::ArrowRecordV1)
    {
        return Err(ApiError::bad(
            "This kind stores connector records; use connector_ingest",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod domain_tests {
    use super::*;

    fn binding(connector: &str, preset: &str) -> Binding {
        serde_json::from_value(json!({"id":"fixture","connector":connector,"preset":preset,
            "contract_version":1,"kind":500,"clock_domain":"simulation_us",
            "channels":["C3","C4"],"units":["uV","uV"]}))
        .unwrap()
    }
    fn record(fields: Value, asset_names: Value) -> Record {
        serde_json::from_value(
            json!({"src":"9007199254740993","dst":"18446744073709551614",
            "timestamp_us":"0","fields":fields,"assets":asset_names}),
        )
        .unwrap()
    }
    fn tensor(shape: Value) -> AssetMetadata {
        serde_json::from_value(
            json!({"version":1,"kind":"tensor","encoding":"raw_le","dtype":"f32","shape":shape}),
        )
        .unwrap()
    }
    #[test]
    fn signal_contract_requires_channel_sample_axes() {
        let r = record(json!({}), json!({"signal":"a"}));
        for connector in ["brainflow", "lsl", "mne"] {
            let b = binding(
                connector,
                if connector == "mne" {
                    "eeg-v1"
                } else {
                    "signal-v1"
                },
            );
            for shape in [json!([2]), json!([2, 3, 4]), json!([1, 4])] {
                let assets = BTreeMap::from([("a".into(), tensor(shape))]);
                assert!(validate_record(&r, &b, &assets).is_err());
            }
            let assets = BTreeMap::from([("a".into(), tensor(json!([2, 4])))]);
            assert!(validate_record(&r, &b, &assets).is_ok());
        }
    }
    #[test]
    fn quantum_counts_require_exact_unsigned_frequencies_and_basis() {
        for (connector, preset) in [("quantum-results", "counts-v1"), ("qsharp", "result-v1")] {
            let b = binding(connector, preset);
            for counts in [
                json!({"00": 2}),
                json!({"00":"-1"}),
                json!({"00":"18446744073709551616"}),
                json!({}),
            ] {
                assert!(
                    validate_record(
                        &record(json!({"basis":"Z","counts":counts}), json!({})),
                        &b,
                        &BTreeMap::new()
                    )
                    .is_err()
                );
            }
            assert!(
                validate_record(
                    &record(
                        json!({"basis":"Z","counts":{"00":"18446744073709551615"}}),
                        json!({})
                    ),
                    &b,
                    &BTreeMap::new()
                )
                .is_ok()
            );
        }
    }
    #[test]
    fn model_outputs_require_tensor_assets_and_provenance() {
        let b = binding("model-output", "tensors-v1");
        let assets = BTreeMap::from([("a".into(), tensor(json!([2])))]);
        let r = record(
            json!({"model":"model","checkpoint":"sha256:fixture"}),
            json!({"output_0":"a"}),
        );
        assert!(validate_record(&r, &b, &assets).is_ok());
        assert!(validate_record(&r, &b, &BTreeMap::new()).is_err());
        assert!(
            validate_record(
                &record(
                    json!({"model":"model","checkpoint":""}),
                    json!({"output_0":"a"})
                ),
                &b,
                &assets
            )
            .is_err()
        );
    }
}
