use chronograph_db::{EdgeInput, EdgeKind, Graph, NodeId, Result, SampleStrategy};
use std::time::Instant;

fn main() -> Result<()> {
    let supplied = std::env::args_os().nth(1);
    let path = supplied
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chronograph-bci-{}.cgraph", std::process::id()))
        });
    let mut graph = Graph::open(&path)?;
    const CHANNELS: usize = 128;
    const EDGES: usize = 1_000_000;
    let mut batch = Vec::with_capacity(4096);
    let start = Instant::now();
    for i in 0..EDGES {
        let channel = i % CHANNELS;
        let tick = i / CHANNELS;
        // Synthetic coherence values, not a physiological model or raw signal storage.
        let coherence: f32 = if (2000..3000).contains(&tick) {
            0.97
        } else {
            0.15 + (channel % 7) as f32 * 0.01
        };
        let mut payload = [0; 16];
        payload[..4].copy_from_slice(&coherence.to_le_bytes());
        batch.push(EdgeInput {
            src: NodeId(channel as u64),
            dst: NodeId(((channel + 1) % CHANNELS) as u64),
            kind: EdgeKind(1),
            valid_from: tick as i64 * 1000,
            payload,
        });
        if batch.len() == 4096 {
            graph.add_edges(&batch)?;
            batch.clear();
        }
    }
    graph.add_edges(&batch)?;
    graph.sync()?;
    let elapsed = start.elapsed().as_secs_f64();
    println!(
        "128 channels, simulated 1 kHz: {EDGES} edges in {elapsed:.3}s ({:.0} edges/s including sync)",
        EDGES as f64 / elapsed
    );
    let high = graph
        .between(2_000_000, 3_000_000)
        .filter(|edge| f32::from_le_bytes(edge.payload[..4].try_into().unwrap()) > 0.9)
        .count();
    assert_eq!(high, 128_000);
    let nodes: Vec<_> = (0..128).map(NodeId).collect();
    let samples = graph.sample_neighbors(&nodes, 10, 2_500_000, SampleStrategy::LatestFirst);
    println!("High-synchrony window [2s, 3s): {high} edge versions");
    println!(
        "At 2.5s: {} active relations; {} sampled relations",
        graph.as_of(2_500_000).edges().count(),
        samples.iter().map(Vec::len).sum::<usize>()
    );
    println!(
        "History: {} versions; log: {} bytes",
        graph.stats().edge_versions,
        graph.stats().log_bytes
    );
    graph.close()?;
    if supplied.is_none() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
