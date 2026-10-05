//! Research recording contracts and a derived, append-only session index.
//! Signal bytes stay in verified immutable assets; the journal remains authoritative.
use crate::{
    ApiError, AppResult, Shared,
    connectors::{Record, hex},
    operations::{number, parse},
    schema::Snapshot,
};
use chronograph_connector_common::{
    ArrowStore,
    assets::{AssetMetadata, AssetStore, Dtype},
    registry::Binding,
};
use chronograph_db::Graph;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
};

const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
const MAX_CHUNK_US: i64 = 60_000_000;
fn text<'a>(r: &'a Record, key: &str) -> AppResult<&'a str> {
    r.fields
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control))
        .ok_or_else(|| ApiError::bad(format!("BCI requires printable {key}")))
}
fn integer(r: &Record, key: &str) -> AppResult<u64> {
    number(text(r, key)?)
}
fn end(r: &Record) -> AppResult<i64> {
    number(text(r, "end_us")?)
}
fn array<'a>(r: &'a Record, key: &str) -> AppResult<&'a Vec<Value>> {
    r.fields
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::bad(format!("BCI requires {key} array")))
}
fn channel_labels(r: &Record) -> AppResult<()> {
    let names = array(r, "channels")?;
    let units = array(r, "units")?;
    let kinds = array(r, "channel_types")?;
    if names.is_empty()
        || names.len() > 512
        || names.len() != units.len()
        || names.len() != kinds.len()
    {
        return Err(ApiError::bad(
            "Provide 1–512 channels with matching units and channel types",
        ));
    }
    let mut seen = BTreeSet::new();
    for (i, v) in names.iter().enumerate() {
        for label in [v, &units[i], &kinds[i]] {
            if label
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 128 || s.chars().any(char::is_control))
            {
                return Err(ApiError::bad("Invalid channel metadata"));
            }
        }
        if !seen.insert(v.as_str().unwrap()) {
            return Err(ApiError::bad("Channel names must be unique"));
        }
    }
    Ok(())
}
pub fn validate(
    r: &Record,
    b: &Binding,
    assets: &BTreeMap<String, AssetMetadata>,
) -> AppResult<()> {
    if serde_json::to_vec(&r.fields).map_err(ApiError::bad)?.len() > 64 * 1024 {
        return Err(ApiError::bad("BCI metadata exceeds 64 KiB"));
    }
    let session = text(r, "session_id")?;
    if session != r.src || number::<u64>(session)? == 0 {
        return Err(ApiError::bad("BCI src must equal its nonzero session_id"));
    }
    if text(r, "clock_domain")? != b.clock_domain {
        return Err(ApiError::bad("BCI clock must match its immutable binding"));
    }
    let from = number::<i64>(&r.timestamp_us)?;
    if r.valid_to.is_some() {
        return Err(ApiError::bad(
            "BCI records are immutable; use end_us for acquisition coverage",
        ));
    }
    match text(r, "type")? {
        "session" => {
            if r.src != r.dst {
                return Err(ApiError::bad("Session metadata uses src=dst=session_id"));
            }
            for key in ["name", "study", "participant", "source", "device", "driver"] {
                text(r, key)?;
            }
        }
        "stream" => {
            channel_labels(r)?;
            for key in ["stream_id", "reference", "source_clock"] {
                text(r, key)?;
            }
            if r.fields
                .get("sample_rate_hz")
                .and_then(Value::as_f64)
                .is_none_or(|n| !n.is_finite() || n <= 0.0 || n > 100_000.0)
            {
                return Err(ApiError::bad("Invalid nominal sample rate"));
            }
        }
        "signal" => {
            text(r, "stream_id")?;
            text(r, "segment_id")?;
            let count = integer(r, "sample_count")?;
            integer(r, "sample_start")?
                .checked_add(count)
                .ok_or_else(|| ApiError::bad("Sample index overflow"))?;
            let to = end(r)?;
            if count == 0 || to <= from || to.checked_sub(from).is_none_or(|n| n > MAX_CHUNK_US) {
                return Err(ApiError::bad(
                    "A signal chunk must span more than zero and at most 60 seconds",
                ));
            }
            let signal = r
                .assets
                .get("signal")
                .and_then(|a| assets.get(a))
                .ok_or_else(|| ApiError::bad("Signal asset is required"))?;
            let times = r
                .assets
                .get("timestamps")
                .and_then(|a| assets.get(a))
                .ok_or_else(|| ApiError::bad("Original timestamps are required"))?;
            if signal.kind != "tensor"
                || !matches!(signal.dtype, Some(Dtype::F32 | Dtype::F64))
                || signal.shape.len() != 2
                || signal.shape[0] > 512
                || signal.shape[1] != count
                || times.kind != "tensor"
                || times.dtype != Some(Dtype::F64)
                || times.shape != [count]
            {
                return Err(ApiError::bad(
                    "BCI signal must be [channels,samples] f32/f64 with matching f64 timestamp vector",
                ));
            }
            if r.fields
                .get("correction_seconds")
                .and_then(Value::as_f64)
                .is_none_or(|v| !v.is_finite())
            {
                return Err(ApiError::bad(
                    "Explicit finite clock correction is required (zero for source time)",
                ));
            }
        }
        "event" | "gap" | "clock" | "prediction" => {
            text(r, "stream_id")?;
            if end(r)? < from {
                return Err(ApiError::bad(
                    "BCI end_us must be at or after acquisition time",
                ));
            }
            match text(r, "type")? {
                "event" => {
                    text(r, "label")?;
                    text(r, "category")?;
                }
                "gap" => {
                    text(r, "reason")?;
                    if r.fields.get("lost_samples") != Some(&Value::Null) {
                        integer(r, "lost_samples")?;
                    }
                }
                "clock" => {
                    text(r, "source_clock")?;
                    if r.fields
                        .get("offset_seconds")
                        .and_then(Value::as_f64)
                        .is_none_or(|n| !n.is_finite())
                    {
                        return Err(ApiError::bad("Clock offset must be finite"));
                    }
                    if r.fields.get("uncertainty_seconds").is_some_and(|v| {
                        !v.is_null() && v.as_f64().is_none_or(|n| !n.is_finite() || n < 0.0)
                    }) {
                        return Err(ApiError::bad(
                            "Clock uncertainty must be nonnegative or unknown",
                        ));
                    }
                }
                "prediction" => {
                    text(r, "run_id")?;
                    text(r, "label")?;
                    if r.fields
                        .get("probability")
                        .and_then(Value::as_f64)
                        .is_none_or(|n| !n.is_finite() || !(0.0..=1.0).contains(&n))
                    {
                        return Err(ApiError::bad(
                            "Prediction probability must be between zero and one",
                        ));
                    }
                }
                _ => {}
            }
        }
        "dataset" => {
            text(r, "name")?;
            let manifest = r
                .fields
                .get("manifest")
                .filter(|v| v.is_object())
                .ok_or_else(|| ApiError::bad("Dataset manifest is required"))?;
            if manifest["version"] != 1
                || manifest["sessions"]
                    .as_array()
                    .is_none_or(|s| s.is_empty() || s.len() > 100)
            {
                return Err(ApiError::bad(
                    "Dataset manifest v1 requires 1–100 session IDs",
                ));
            }
            let ids = manifest["sessions"].as_array().unwrap();
            let mut seen = BTreeSet::new();
            for id in ids {
                let id = id.as_str().unwrap_or("");
                if number::<u64>(id)? == 0 || !seen.insert(id) {
                    return Err(ApiError::bad(
                        "Dataset sessions must be distinct nonzero IDs",
                    ));
                }
            }
            let snapshots = manifest["source_snapshots"]
                .as_array()
                .filter(|s| s.len() == ids.len())
                .ok_or_else(|| {
                    ApiError::bad("Dataset requires one frozen source snapshot per session")
                })?;
            if manifest["instance"].as_str() != Some(b.id.as_str())
                || manifest["stream"].as_str().is_none_or(str::is_empty)
            {
                return Err(ApiError::bad(
                    "Dataset instance and stream must match its binding",
                ));
            }
            for (id, snapshot) in ids.iter().zip(snapshots) {
                let hash = snapshot["sha256"].as_str().unwrap_or("");
                if snapshot["session"] != *id
                    || hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    || snapshot["participant"].as_str().is_none_or(str::is_empty)
                {
                    return Err(ApiError::bad("Invalid dataset source snapshot"));
                }
                number::<u64>(snapshot["through_edge"].as_str().unwrap_or(""))?;
            }
        }
        "run" => {
            for key in ["name", "dataset_id", "recipe", "status"] {
                text(r, key)?;
            }
            if !matches!(text(r, "status")?, "succeeded" | "failed") {
                return Err(ApiError::bad(
                    "Published runs are immutable terminal results",
                ));
            }
        }
        _ => return Err(ApiError::bad("Unknown BCI record type")),
    }
    if text(r, "type")? != "session" && r.src == r.dst {
        return Err(ApiError::bad(
            "Each BCI observation needs a unique destination ID",
        ));
    }
    Ok(())
}
/// Read one normalized connector record from the immutable sidecar store.
fn read_record(store: &ArrowStore, payload: [u8; 16], b: &Binding) -> AppResult<Record> {
    let (batch, row) = store.read(payload).map_err(ApiError::bad)?;
    let mapping = serde_json::to_string(b).map_err(ApiError::internal)?;
    chronograph_connector_common::decode(&batch, row, "normalized_records_v1", &mapping)
        .map_err(ApiError::bad)
}

#[derive(Clone)]
struct Row {
    edge: u64,
    record: Record,
}
#[derive(Default)]
struct Session {
    rows: Vec<Row>,
    ids: BTreeSet<String>,
    metadata: Option<Record>,
    streams: BTreeMap<String, Record>,
    // Chunks have bounded 60s coverage, so a window only examines its local range.
    signal_times: BTreeMap<String, BTreeMap<(i64, usize), usize>>,
    samples: BTreeMap<(String, String), BTreeMap<u64, u64>>,
    last_us: i64,
    signal_count: usize,
}
/// Derived session index over the parent graph and every branch.
///
/// Sessions are keyed by scope, so one writer's records for the parent and for any number
/// of branches are indexed by the same code without a per-branch index or writer.
pub const PARENT_SCOPE: &str = "parent";

pub fn fork_scope(fork: u64) -> String {
    format!("fork:{fork}")
}

pub fn parse_scope(fork: &str) -> AppResult<String> {
    if fork.is_empty() {
        return Err(ApiError::bad("Fork must be a decimal branch ID"));
    }
    Ok(fork_scope(number::<u64>(fork)?))
}

#[derive(Default)]
pub struct Index {
    scanned: usize,
    fork_scanned: BTreeMap<u64, usize>,
    bytes: usize,
    sessions: BTreeMap<(String, String, String), Session>,
}
impl Index {
    pub fn refresh(&mut self, g: &Graph, schema: &Snapshot, path: &Path) -> AppResult<()> {
        let store = ArrowStore::open(path.join("sidecars/records-v1")).map_err(ApiError::bad)?;
        let bindings: BTreeMap<_, _> = schema
            .connectors
            .iter()
            .filter(|b| b.connector == "bci")
            .map(|b| (b.kind, b))
            .collect();
        for e in &g.history()[self.scanned..] {
            if let Some(b) = bindings.get(&e.kind.0) {
                let record = read_record(&store, e.payload, b)?;
                self.insert(b, PARENT_SCOPE, e.id.0, record)?;
            }
            self.scanned += 1;
        }
        if bindings.is_empty() {
            return Ok(());
        }
        // Branch records are derived through the same reader and the same writer contract.
        let active: Vec<(u64, u64)> = g
            .forks()
            .filter(|f| f.status == chronograph_db::ForkStatus::Active)
            .map(|f| (f.id.0, f.revision))
            .collect();
        for (fork, _) in &active {
            let scanned = *self.fork_scanned.get(fork).unwrap_or(&0);
            let edges: Vec<(u64, [u8; 16], u16)> = g
                .fork_history(chronograph_db::ForkId(*fork))?
                .skip(scanned)
                .map(|e| (e.id.0, e.payload, e.kind.0))
                .collect();
            for (edge, payload, kind) in edges {
                if let Some(b) = bindings.get(&kind) {
                    let record = read_record(&store, payload, b)?;
                    self.insert(b, &fork_scope(*fork), edge, record)?;
                }
                *self.fork_scanned.entry(*fork).or_default() += 1;
            }
        }
        // A merged or discarded branch is no longer queryable, so drop its derived rows.
        let live: BTreeSet<String> = active.iter().map(|(f, _)| fork_scope(*f)).collect();
        self.sessions
            .retain(|(scope, _, _), _| scope == PARENT_SCOPE || live.contains(scope));
        self.fork_scanned
            .retain(|fork, _| active.iter().any(|(f, _)| f == fork));
        Ok(())
    }
    fn insert(&mut self, b: &Binding, scope: &str, edge: u64, r: Record) -> AppResult<()> {
        let s = self
            .sessions
            .entry((scope.to_owned(), b.id.clone(), r.src.clone()))
            .or_default();
        if !s.ids.insert(r.dst.clone()) {
            return Ok(());
        } // inherited/merged references are not new observations
        self.bytes += serde_json::to_vec(&r).map_err(ApiError::internal)?.len() + 256;
        let typ = text(&r, "type")?;
        let from = number::<i64>(&r.timestamp_us)?;
        s.last_us = s.last_us.max(
            r.fields
                .get("end_us")
                .and_then(Value::as_str)
                .and_then(|x| x.parse().ok())
                .unwrap_or(from),
        );
        if typ == "session" {
            s.metadata = Some(r.clone());
        }
        if typ == "stream" {
            s.streams.insert(text(&r, "stream_id")?.into(), r.clone());
        }
        if typ == "signal" {
            let stream = text(&r, "stream_id")?.to_owned();
            s.signal_times
                .entry(stream.clone())
                .or_default()
                .insert((from, s.rows.len()), s.rows.len());
            let start = integer(&r, "sample_start")?;
            s.samples
                .entry((stream, text(&r, "segment_id")?.into()))
                .or_default()
                .insert(start, start + integer(&r, "sample_count")?);
            s.signal_count += 1;
        }
        s.rows.push(Row { edge, record: r });
        Ok(())
    }
    /// Validate a pending batch against the parent or one selected branch scope.
    /// The same rules apply to every branch, so a new branch never needs a new validator.
    pub fn validate_batch(
        &self,
        scope: &str,
        b: &Binding,
        records: &[Record],
        store: &AssetStore,
    ) -> AppResult<()> {
        let bytes = records.iter().try_fold(self.bytes, |n, r| {
            Ok::<_, ApiError>(n + serde_json::to_vec(r).map_err(ApiError::bad)?.len() + 256)
        })?;
        if bytes > MAX_INDEX_BYTES {
            return Err(ApiError::conflict(
                "BCI index quota reached (64 MiB); start a new workspace",
            ));
        }
        let mut new_ids = BTreeSet::new();
        let mut new_sessions = BTreeSet::new();
        let mut new_streams = BTreeMap::new();
        let mut pending_samples: BTreeMap<(String, String, String), Vec<(u64, u64)>> =
            BTreeMap::new();
        for r in records {
            let s = self
                .sessions
                .get(&(scope.to_owned(), b.id.clone(), r.src.clone()));
            if s.is_some_and(|s| s.ids.contains(&r.dst))
                || !new_ids.insert((r.src.clone(), r.dst.clone()))
            {
                return Err(ApiError::conflict(
                    "BCI observation IDs are immutable; retry the original partition/sequence or use a new ID",
                ));
            }
            let typ = text(r, "type")?;
            if typ == "session" {
                new_sessions.insert(r.src.clone());
            } else if s.and_then(|s| s.metadata.as_ref()).is_none()
                && !new_sessions.contains(&r.src)
            {
                return Err(ApiError::bad(
                    "Publish session metadata before its observations",
                ));
            }
            if typ == "stream" {
                let key = (r.src.clone(), text(r, "stream_id")?.to_owned());
                if s.is_some_and(|s| s.streams.contains_key(&key.1))
                    || new_streams.insert(key, r).is_some()
                {
                    return Err(ApiError::conflict(
                        "Stream metadata is immutable; configure a new stream ID",
                    ));
                }
            }
            if matches!(typ, "signal" | "event" | "gap" | "clock" | "prediction") {
                let stream = text(r, "stream_id")?;
                let meta = s
                    .and_then(|s| s.streams.get(stream))
                    .or_else(|| new_streams.get(&(r.src.clone(), stream.into())).copied())
                    .ok_or_else(|| ApiError::bad("Publish stream metadata first"))?;
                if typ == "signal" {
                    let signal = store
                        .get(&hex(&r.assets["signal"])?)
                        .map_err(ApiError::bad)?;
                    if signal.metadata.shape[0] as usize != array(meta, "channels")?.len() {
                        return Err(ApiError::bad(
                            "Signal channel count does not match stream metadata",
                        ));
                    }
                    if !b.channels.is_empty()
                        && (json!(b.channels) != meta.fields["channels"]
                            || json!(b.units) != meta.fields["units"])
                    {
                        return Err(ApiError::bad("Stream channels/units differ from binding"));
                    }
                    let times = store
                        .get(&hex(&r.assets["timestamps"])?)
                        .map_err(ApiError::bad)?;
                    let correction = r.fields["correction_seconds"].as_f64().unwrap();
                    let from = number::<i64>(&r.timestamp_us)?;
                    let to = end(r)?;
                    let mut previous = f64::NEG_INFINITY;
                    for (i, part) in times.bytes.chunks_exact(8).enumerate() {
                        let t = f64::from_le_bytes(part.try_into().unwrap());
                        let mapped = ((t + correction) * 1e6).round();
                        if !t.is_finite()
                            || t < previous
                            || mapped < i64::MIN as f64
                            || mapped >= i64::MAX as f64
                            || (i == 0 && mapped as i64 != from)
                            || mapped as i64 >= to
                        {
                            return Err(ApiError::bad(
                                "Signal timestamps must be finite, nondecreasing and within declared coverage",
                            ));
                        }
                        previous = t;
                    }
                    let start = integer(r, "sample_start")?;
                    let stop = start + integer(r, "sample_count")?;
                    let segment = text(r, "segment_id")?.to_owned();
                    if let Some(existing) =
                        s.and_then(|s| s.samples.get(&(stream.into(), segment.clone())))
                        && existing
                            .range(..stop)
                            .next_back()
                            .is_some_and(|(_, e)| *e > start)
                    {
                        return Err(ApiError::conflict(
                            "Overlapping sample indices within a stream segment",
                        ));
                    }
                    let ranges = pending_samples
                        .entry((r.src.clone(), stream.into(), segment))
                        .or_default();
                    if ranges.iter().any(|(a, z)| *a < stop && *z > start) {
                        return Err(ApiError::conflict("Batch overlaps sample indices"));
                    }
                    ranges.push((start, stop));
                }
            }
        }
        Ok(())
    }
}
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Query {
    sessions: Vec<String>,
    cutoffs: BTreeMap<String, String>,
    /// Selected branch. Empty selects the parent graph, exactly like every other read.
    fork: String,
    /// Causal path origin, as a decimal observation destination ID.
    observation: String,
    /// Maximum causal path depth, 1-8.
    depth: usize,
    instance: String,
    session: String,
    stream: String,
    start: String,
    end: String,
    after: String,
    limit: usize,
    record_type: String,
    channels: Vec<usize>,
    points: usize,
}
fn wire(row: &Row) -> Value {
    json!({"edge":row.edge.to_string(),"record":row.record})
}

/// Walk the recorded lineage backwards from one observation to its sources.
///
/// The path follows only relationships already stored as immutable records: a prediction
/// names its run, a run names its dataset, a dataset names its sessions, a session declares
/// its streams, and a stream observed its chunks and events. Nothing is inferred that was
/// not recorded, and the walk is bounded by depth and row count.
fn causal_path(scope: &str, s: &Session, origin: &str, depth: usize, limit: usize) -> Value {
    let mut by_dst: BTreeMap<&str, &Row> = BTreeMap::new();
    for row in &s.rows {
        by_dst.insert(row.record.dst.as_str(), row);
    }
    let mut nodes: Vec<Value> = Vec::new();
    let mut links: Vec<Value> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::from([(origin.to_owned(), 0usize)]);
    let mut truncated = false;
    while let Some((id, level)) = queue.pop_front() {
        if nodes.len() >= limit {
            truncated = true;
            break;
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(row) = by_dst.get(id.as_str()) else {
            continue;
        };
        let record = &row.record;
        nodes.push(json!({
            "observation": id,
            "edge": row.edge.to_string(),
            "type": record.fields.get("type"),
            "timestamp_us": record.timestamp_us,
            "stream_id": record.fields.get("stream_id"),
        }));
        if level >= depth {
            truncated = true;
            continue;
        }
        let mut parents: Vec<(String, &str)> = Vec::new();
        match record.fields.get("type").and_then(Value::as_str) {
            Some("prediction") => {
                if let Some(run) = record.fields.get("run_id").and_then(Value::as_str) {
                    parents.push((run.to_owned(), "produced_by_run"));
                }
            }
            Some("run") => {
                if let Some(dataset) = record.fields.get("dataset_id").and_then(Value::as_str) {
                    parents.push((dataset.to_owned(), "trained_on_dataset"));
                }
            }
            Some("dataset") => {
                for session in record.fields["manifest"]["sessions"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                {
                    if let Some(id) = session.as_str() {
                        parents.push((id.to_owned(), "includes_session"));
                    }
                }
            }
            Some("session") => {
                for stream in s.streams.values() {
                    parents.push((stream.dst.clone(), "declares_stream"));
                }
            }
            Some("event" | "gap" | "clock" | "signal") => {
                // An observation names the stream it was recorded on.
                if let Some(stream_id) = record.fields.get("stream_id").and_then(Value::as_str)
                    && let Some(stream) = s.streams.get(stream_id)
                {
                    parents.push((stream.dst.clone(), "observed_in"));
                }
            }
            Some("stream") => {
                // The session that declares this stream, and every observation on it.
                if let Some(metadata) = s.metadata.as_ref() {
                    parents.push((metadata.dst.clone(), "declared_by_session"));
                }
                let stream_id = record.fields.get("stream_id");
                for row in &s.rows {
                    if row.record.fields.get("stream_id") == stream_id
                        && matches!(
                            row.record.fields.get("type").and_then(Value::as_str),
                            Some("signal" | "event" | "gap" | "clock")
                        )
                    {
                        parents.push((row.record.dst.clone(), "observed_in"));
                    }
                }
            }
            _ => {}
        }
        for (parent, kind) in parents {
            if links.len() < limit {
                links.push(json!({"from": id, "to": parent, "kind": kind}));
            } else {
                truncated = true;
            }
            queue.push_back((parent, level + 1));
        }
    }
    json!({
        "scope": scope,
        "origin": origin,
        "depth_limit": depth,
        "row_limit": limit,
        "nodes": nodes,
        "links": links,
        "truncated": truncated,
    })
}
pub fn execute(state: &Shared, op: &str, args: Value) -> AppResult<Value> {
    let q: Query = parse(args)?;
    let limit = if q.limit == 0 { 100 } else { q.limit };
    if limit > 500 {
        return Err(ApiError::bad("BCI page limit must be 1–500"));
    }
    let g = state.graph.read().map_err(ApiError::internal)?;
    let schema = state.schema.read().map_err(ApiError::internal)?;
    let mut index = state.bci.lock().map_err(ApiError::internal)?;
    index.refresh(&g, schema.snapshot()?, &state.data)?;
    let scope = if q.fork.is_empty() {
        PARENT_SCOPE.to_owned()
    } else {
        parse_scope(&q.fork)?
    };
    if op == "bci_sessions" {
        let offset = if q.after.is_empty() {
            0
        } else {
            number::<usize>(&q.after)?
        };
        let values:Vec<_>=index.sessions.iter().filter(|((recorded,q_instance,_),s)|(q.instance.is_empty()||*q_instance==q.instance)&&s.metadata.is_some()&&recorded==&scope).skip(offset).take(limit+1).map(|((recorded,instance,id),s)|json!({"scope":recorded,"instance":instance,"session":id,"metadata":s.metadata.as_ref().unwrap().fields,"streams":s.streams.len(),"chunks":s.signal_count,"records":s.rows.len(),"last_us":s.last_us.to_string()})).collect();
        return Ok(
            json!({"sessions":values.iter().take(limit).collect::<Vec<_>>(),"next_cursor":if values.len()>limit{Some((offset+limit).to_string())}else{None},"index_bytes":index.bytes,"index_limit_bytes":MAX_INDEX_BYTES}),
        );
    }
    if op == "bci_manifest" {
        if q.sessions.is_empty()
            || q.sessions.len() > 100
            || q.sessions.iter().collect::<BTreeSet<_>>().len() != q.sessions.len()
        {
            return Err(ApiError::bad("Select 1–100 distinct recording sessions"));
        }
        let mut snapshots = Vec::new();
        for id in &q.sessions {
            let session = index
                .sessions
                .get(&(scope.clone(), q.instance.clone(), id.clone()))
                .ok_or_else(|| ApiError::missing("Dataset session not found"))?;
            if !session.streams.contains_key(&q.stream) {
                return Err(ApiError::bad(
                    "Selected stream is missing from a dataset session",
                ));
            }
            let through = q
                .cutoffs
                .get(id)
                .map(|s| number::<u64>(s))
                .transpose()?
                .unwrap_or_else(|| session.rows.last().map_or(0, |r| r.edge));
            if !session.rows.iter().any(|r| r.edge == through) {
                return Err(ApiError::bad("Invalid source snapshot cutoff"));
            }
            let mut digest = Sha256::new();
            for row in session
                .rows
                .iter()
                .take_while(|r| r.edge <= through)
                .filter(|r| {
                    matches!(
                        r.record.fields["type"].as_str(),
                        Some("session" | "stream" | "signal" | "event" | "gap" | "clock")
                    )
                })
            {
                digest.update(serde_json::to_vec(&row.record).map_err(ApiError::internal)?);
                digest.update(b"\n");
            }
            snapshots.push(json!({"session":id,"through_edge":through.to_string(),"sha256":crate::auth::hex(&digest.finalize()),"participant":session.metadata.as_ref().ok_or_else(||ApiError::bad("Missing session metadata"))?.fields["participant"]}));
        }
        return Ok(
            json!({"manifest":{"version":1,"instance":q.instance,"sessions":q.sessions,"stream":q.stream,"source_snapshots":snapshots,"event_category":"cue","preprocessing":{"low_hz":8.0,"high_hz":30.0,"epoch_start_s":0.5,"epoch_end_s":2.5,"components":4,"seed":42}}}),
        );
    }
    let s = index
        .sessions
        .get(&(scope.clone(), q.instance.clone(), q.session.clone()))
        .ok_or_else(|| ApiError::missing("BCI session not found"))?;
    if op == "bci_session" {
        return Ok(
            json!({"instance":q.instance,"session":q.session,"metadata":s.metadata,"streams":s.streams.values().collect::<Vec<_>>(),"chunks":s.signal_count,"records":s.rows.len(),"last_us":s.last_us.to_string()}),
        );
    }
    if op == "bci_records" {
        let after = if q.after.is_empty() {
            None
        } else {
            Some(number::<u64>(&q.after)?)
        };
        let start = after.map_or(0, |id| s.rows.partition_point(|r| r.edge <= id));
        let mut rows = Vec::new();
        let mut cursor = after;
        let mut more = false;
        for r in &s.rows[start..] {
            let fits = (q.record_type.is_empty() || r.record.fields["type"] == q.record_type)
                && (q.stream.is_empty()
                    || r.record.fields.get("stream_id") == Some(&json!(q.stream)));
            if fits && rows.len() == limit {
                more = true;
                break;
            }
            cursor = Some(r.edge);
            if fits {
                rows.push(wire(r));
            }
        }
        return Ok(json!({"records":rows,"cursor":cursor.map(|v|v.to_string()),"has_more":more}));
    }
    if op == "bci_causal_path" {
        if q.observation.is_empty() || number::<u64>(&q.observation)? == 0 {
            return Err(ApiError::bad("Select a nonzero observation ID"));
        }
        let depth = if q.depth == 0 { 8 } else { q.depth };
        if depth > 8 {
            return Err(ApiError::bad("Causal path depth is 1-8"));
        }
        let value = causal_path(&scope, s, &q.observation, depth, limit);
        return Ok(json!({"path": value, "index_bytes": index.bytes}));
    }
    if op != "bci_window" {
        return Err(ApiError::missing("Unknown BCI operation"));
    }
    let start = number::<i64>(&q.start)?;
    let end = number::<i64>(&q.end)?;
    if end <= start || end.checked_sub(start).is_none_or(|n| n > MAX_CHUNK_US) {
        return Err(ApiError::bad(
            "Window must span more than zero and at most 60 seconds",
        ));
    }
    let stream = s
        .streams
        .get(&q.stream)
        .ok_or_else(|| ApiError::missing("Stream not found"))?;
    let names = array(stream, "channels")?;
    let channels = if q.channels.is_empty() {
        (0..names.len().min(8)).collect::<Vec<_>>()
    } else {
        q.channels
    };
    if channels.len() > 16
        || channels.iter().any(|c| *c >= names.len())
        || channels.iter().collect::<BTreeSet<_>>().len() != channels.len()
    {
        return Err(ApiError::bad("Select at most 16 distinct known channels"));
    }
    let points = if q.points == 0 { 600 } else { q.points };
    if !(16..=2048).contains(&points) {
        return Err(ApiError::bad("Envelope points must be 16–2048"));
    }
    let store = AssetStore::open(state.data.join("sidecars/assets-v1")).map_err(ApiError::bad)?;
    let mut bins = vec![vec![None::<(f64, f64, u64)>; points]; channels.len()];
    let mut coverage = Vec::new();
    let mut nonfinite = 0u64;
    let mut decoded = 0usize;
    if let Some(times) = s.signal_times.get(&q.stream) {
        for (_, i) in times.range((start.saturating_sub(MAX_CHUNK_US), 0)..(end, 0)) {
            let r = &s.rows[*i].record;
            if crate::bci::end(r)? <= start {
                continue;
            }
            let sig = store
                .get(&hex(&r.assets["signal"])?)
                .map_err(ApiError::bad)?;
            let ts = store
                .get(&hex(&r.assets["timestamps"])?)
                .map_err(ApiError::bad)?;
            decoded += sig.bytes.len() + ts.bytes.len();
            if decoded > 64 * 1024 * 1024 {
                return Err(ApiError::bad(
                    "Window exceeds 64 MiB decode budget; request a shorter interval",
                ));
            }
            let width = sig.metadata.dtype.as_ref().unwrap().bytes();
            let count = integer(r, "sample_count")? as usize;
            let correction = r.fields["correction_seconds"].as_f64().unwrap();
            for (j, part) in ts.bytes.chunks_exact(8).enumerate() {
                let t = ((f64::from_le_bytes(part.try_into().unwrap()) + correction) * 1e6).round()
                    as i64;
                if t < start || t >= end {
                    continue;
                }
                let bin = (((t as i128 - start as i128) * points as i128)
                    / (end as i128 - start as i128)) as usize;
                for (c, channel) in channels.iter().enumerate() {
                    let off = (channel * count + j) * width;
                    let value = if width == 4 {
                        f32::from_le_bytes(sig.bytes[off..off + 4].try_into().unwrap()) as f64
                    } else {
                        f64::from_le_bytes(sig.bytes[off..off + 8].try_into().unwrap())
                    };
                    if !value.is_finite() {
                        nonfinite += 1;
                        continue;
                    }
                    bins[c][bin] = Some(match bins[c][bin] {
                        Some((lo, hi, n)) => (lo.min(value), hi.max(value), n + 1),
                        None => (value, value, 1),
                    });
                }
            }
            coverage.push(json!({"edge":s.rows[*i].edge.to_string(),"start_us":r.timestamp_us,"end_us":r.fields["end_us"],"segment_id":r.fields["segment_id"]}));
        }
    }
    let overlays: Vec<_> = s
        .rows
        .iter()
        .filter(|r| {
            matches!(
                r.record.fields["type"].as_str(),
                Some("event" | "gap" | "prediction")
            ) && r.record.fields["stream_id"] == q.stream
        })
        .filter(|r| {
            number::<i64>(&r.record.timestamp_us).is_ok_and(|t| t < end)
                && crate::bci::end(&r.record).is_ok_and(|t| t >= start)
        })
        .take(501)
        .map(wire)
        .collect();
    if overlays.len() > 500 {
        return Err(ApiError::bad(
            "Too many events in this window; request a shorter interval",
        ));
    }
    Ok(
        json!({"session":q.session,"stream":q.stream,"clock_domain":stream.fields["clock_domain"],"start_us":start.to_string(),"end_us":end.to_string(),"points":points,"channels":channels.iter().enumerate().map(|(i,c)|json!({"name":names[*c],"unit":stream.fields["units"][*c],"index":c,"envelope":bins[i]})).collect::<Vec<_>>(),"coverage":coverage,"events":overlays,"nonfinite_values":nonfinite,"display_only":true}),
    )
}
