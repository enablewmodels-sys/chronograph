use chronograph_db::{EdgeKind, Graph, NodeId, Result};

fn main() -> Result<()> {
    let supplied = std::env::args_os().nth(1);
    let path = supplied
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chronograph-world-{}.cgraph", std::process::id()))
        });
    let mut graph = Graph::open(&path)?;
    let agent = NodeId(0);
    let object = NodeId(1);
    let relative_position = EdgeKind(1);
    graph.add_node(NodeId(2))?; // An observed, currently unrelated object.
    for step in 0..8 {
        let mut payload = [0; 16];
        for (index, value) in [step as f32, 2.0, 0.0, 0.95].iter().enumerate() {
            payload[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        graph.add_edge(agent, object, relative_position, step * 1_000_000, payload)?;
    }
    // A delayed observation corrects the relation between seconds 2 and 3.
    let mut correction = [0; 16];
    correction[..4].copy_from_slice(&2.5f32.to_le_bytes());
    graph.add_edge(agent, object, relative_position, 2_500_000, correction)?;
    graph.sync()?;
    println!("Gridworld replay: agent -> object relative x position");
    for t in [0, 1_000_000, 2_000_000, 2_750_000, 3_000_000, 7_000_000] {
        for edge in graph.as_of(t).edges() {
            let x = f32::from_le_bytes(edge.payload[..4].try_into().unwrap());
            println!(
                "t={:.2}s  x={x:.1}  version={}  interval=[{}, {})",
                t as f64 / 1e6,
                edge.id.0,
                edge.valid_from,
                edge.valid_to
            );
        }
    }
    let batch = graph.export_arrow(2_750_000)?;
    println!(
        "Arrow snapshot: {} row(s), {} columns",
        batch.num_rows(),
        batch.num_columns()
    );
    graph.close()?;
    let reopened = Graph::open(&path)?;
    println!(
        "Reopened: {} nodes, {} historical versions",
        reopened.stats().nodes,
        reopened.stats().edge_versions
    );
    reopened.close()?;
    if supplied.is_none() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
