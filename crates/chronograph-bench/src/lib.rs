//! Reproducible temporal graph workloads and benchmark utilities.

use chronograph_db::{EdgeInput, EdgeKind, Graph, NodeId};
use rand::{Rng, SeedableRng, rngs::SmallRng, seq::SliceRandom};
use std::{
    fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};

/// Fixed seed used for all published workloads.
pub const SEED: u64 = 0x4348_524f_4e4f_0001;
/// Dataset time span in microseconds.
pub const HOUR: i64 = 3_600_000_000;

/// One synthetic event and its expected final end, calculated before ingestion.
#[derive(Clone, Copy)]
pub struct Event {
    /// Event passed to the database.
    pub input: EdgeInput,
    /// Explicit invalidation, when selected (approximately ten percent of versions).
    pub invalidation: Option<i64>,
    /// Expected final interval end from the independently generated timeline.
    pub final_end: i64,
}

/// Generate ten relationships per node and ten versions per relationship.
/// `count` must be a multiple of 100 and at least 2,000; `count / 100` nodes result.
pub fn dataset(count: usize, shuffled: bool) -> Vec<Event> {
    assert!(count >= 2000 && count.is_multiple_of(100));
    let nodes = count / 100;
    let mut rng = SmallRng::seed_from_u64(SEED);
    let mut events = Vec::with_capacity(count);
    for src in 0..nodes {
        for relation in 0..10 {
            let dst = (src + relation + 1) % nodes;
            let mut times = [0i64; 10];
            for t in &mut times {
                *t = rng.random_range(1..HOUR - 10);
            }
            times.sort_unstable();
            // Resolve the extremely rare tie while retaining sorted distinct starts.
            for i in 1..10 {
                if times[i] <= times[i - 1] {
                    times[i] = times[i - 1] + 1;
                }
            }
            for (version, &start) in times.iter().enumerate() {
                let natural_end = times.get(version + 1).copied().unwrap_or(i64::MAX);
                let limit = natural_end.min(HOUR);
                let invalidation = rng.random_bool(0.1).then(|| rng.random_range(start..limit));
                let final_end = invalidation.unwrap_or(natural_end);
                let mut payload = [0; 16];
                payload[..8].copy_from_slice(&(events.len() as u64).to_le_bytes());
                payload[8..].copy_from_slice(&(rng.random::<u64>()).to_le_bytes());
                events.push(Event {
                    input: EdgeInput {
                        src: NodeId(src as u64),
                        dst: NodeId(dst as u64),
                        kind: EdgeKind(relation as u16),
                        valid_from: start,
                        payload,
                    },
                    invalidation,
                    final_end,
                });
            }
        }
    }
    if shuffled {
        events.shuffle(&mut SmallRng::seed_from_u64(SEED ^ 0x1234));
    } else {
        events.sort_unstable_by_key(|e| (e.input.valid_from, e.input.src, e.input.kind));
    }
    events
}

/// Parse the full-dataset size from the environment, defaulting to ten million versions.
pub fn configured_count() -> usize {
    std::env::var("CHRONOGRAPH_BENCH_EDGES")
        .ok()
        .map(|s| s.parse().expect("integer CHRONOGRAPH_BENCH_EDGES"))
        .unwrap_or(10_000_000)
}

/// Root of the source workspace, independent of Cargo's per-package benchmark directory.
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

/// Return the dataset location; relative overrides are resolved against the workspace root.
pub fn data_path() -> PathBuf {
    let configured = std::env::var_os("CHRONOGRAPH_BENCH_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("bench/data/graph.cgraph"));
    if configured.is_absolute() {
        configured
    } else {
        workspace_root().join(configured)
    }
}

/// Insert events and their explicit invalidations; return insert and insert-plus-sync seconds.
/// Explicit invalidations are outside the reported insertion times.
pub fn ingest(graph: &mut Graph, events: &[Event], batch: bool) -> (f64, f64) {
    let started = Instant::now();
    let mut inputs = Vec::with_capacity(10_000);
    for chunk in events.chunks(10_000) {
        if batch {
            inputs.clear();
            inputs.extend(chunk.iter().map(|e| e.input));
            graph.add_edges(&inputs).unwrap();
        } else {
            for e in chunk {
                let i = e.input;
                graph
                    .add_edge(i.src, i.dst, i.kind, i.valid_from, i.payload)
                    .unwrap();
            }
        }
    }
    let buffered = started.elapsed().as_secs_f64();
    graph.sync().unwrap();
    let synced = started.elapsed().as_secs_f64();
    for (id, event) in events.iter().enumerate() {
        if let Some(t) = event.invalidation {
            graph
                .invalidate_edge(chronograph_db::EdgeId(id as u64), t)
                .unwrap();
        }
    }
    graph.sync().unwrap();
    (buffered, synced)
}

/// Validate every stored version against the independent generator's final intervals.
pub fn validate(graph: &Graph, events: &[Event]) {
    assert_eq!(graph.history().len(), events.len());
    for (edge, event) in graph.history().iter().zip(events) {
        assert_eq!(
            (
                edge.src,
                edge.dst,
                edge.kind,
                edge.valid_from,
                edge.valid_to,
                edge.payload
            ),
            (
                event.input.src,
                event.input.dst,
                event.input.kind,
                event.input.valid_from,
                event.final_end,
                event.input.payload
            )
        );
    }
}

/// Deterministic uniformly distributed query timestamps.
pub fn timestamps(count: usize) -> Vec<i64> {
    let mut rng = SmallRng::seed_from_u64(SEED ^ 0x5555);
    (0..count).map(|_| rng.random_range(0..HOUR)).collect()
}

/// Emit the same final graph, operation stream and query timestamps for external comparison.
pub fn export_dataset(dir: &Path, events: &[Event]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let mut nodes = BufWriter::new(fs::File::create(dir.join("nodes.csv"))?);
    writeln!(nodes, "id")?;
    for id in 0..events.len() / 100 {
        writeln!(nodes, "{id}")?;
    }
    nodes.flush()?;
    let mut edges = BufWriter::new(fs::File::create(dir.join("edges.csv"))?);
    writeln!(edges, "edge_id,src,dst,kind,valid_from,valid_to,payload")?;
    let mut operations = BufWriter::new(fs::File::create(dir.join("operations.csv"))?);
    writeln!(
        operations,
        "edge_id,src,dst,kind,valid_from,invalidate_at,payload"
    )?;
    for (id, event) in events.iter().enumerate() {
        let i = event.input;
        let mut payload = String::with_capacity(32);
        use std::fmt::Write as _;
        for byte in i.payload {
            write!(&mut payload, "{byte:02x}").unwrap();
        }
        writeln!(
            edges,
            "{id},{},{},{},{},{},{}",
            i.src.0, i.dst.0, i.kind.0, i.valid_from, event.final_end, payload
        )?;
        let invalidation = event
            .invalidation
            .map(|t| t.to_string())
            .unwrap_or_default();
        writeln!(
            operations,
            "{id},{},{},{},{},{},{}",
            i.src.0, i.dst.0, i.kind.0, i.valid_from, invalidation, payload
        )?;
    }
    edges.flush()?;
    operations.flush()?;
    let mut queries = BufWriter::new(fs::File::create(dir.join("queries.csv"))?);
    writeln!(queries, "t,expected_count,expected_id_sum")?;
    for t in timestamps(200) {
        let count = events
            .iter()
            .filter(|e| e.input.valid_from <= t && t < e.final_end)
            .count();
        let id_sum: u64 = events
            .iter()
            .enumerate()
            .filter(|(_, e)| e.input.valid_from <= t && t < e.final_end)
            .map(|(id, _)| id as u64)
            .sum();
        writeln!(queries, "{t},{count},{id_sum}")?;
    }
    queries.flush()?;
    Ok(())
}
