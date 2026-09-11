use chronograph_conn_bci::{Mapping, export_epoch, ingest, simulate, write_epoch};
use chronograph_db::Graph;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mapping = Mapping::from_toml(include_str!("datasets/bci/mapping.toml"))?;
    let supplied = std::env::args().nth(1);
    let dir = supplied
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chronograph-bci-{}", std::process::id()))
        });
    std::fs::create_dir(&dir)?;
    let mut graph = Graph::open(dir.join("graph.cgraph"))?;
    let frames = simulate(&mapping, 10_000, 0)?;
    for chunk in frames.chunks(1000) {
        ingest(&mut graph, &mapping, chunk)?;
    }
    graph.sync()?;
    let epoch = export_epoch(&graph, &mapping, 2_000_000, 3_000_000)?;
    assert_eq!(epoch.num_rows(), 4000);
    write_epoch(&epoch, dir.join("epoch.arrow"))?;
    println!(
        "Synthetic BCI: {} frames, {} channel versions, {} epoch rows, {} active at 2.5 s",
        frames.len(),
        graph.stats().edge_versions,
        epoch.num_rows(),
        graph.as_of(2_500_000).edges().count()
    );
    graph.close()?;
    if supplied.is_none() {
        std::fs::remove_dir_all(dir)?;
    } else {
        println!("Dataset retained at {}", dir.display());
    }
    Ok(())
}
