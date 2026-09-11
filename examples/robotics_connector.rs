use chronograph_conn_robotics::{Mapping, Message, export_arrow, files, ingest, lerobot_frames};
use chronograph_connector_common::{ArrowStore, write_ipc};
use chronograph_db::Graph;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mapping = Mapping::from_toml(include_str!("datasets/robotics/mapping.toml"))?;
    let dir = args
        .first()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chronograph-robotics-{}", std::process::id()))
        });
    std::fs::create_dir(&dir)?;
    let input = if let Some(path) = args.get(1) {
        if path.ends_with(".mcap") {
            files::mcap(path, &mapping)?.messages
        } else {
            files::rosbag2(path, &mapping)?.messages
        }
    } else {
        serde_json::from_str::<Vec<Message>>(include_str!("datasets/robotics/messages.json"))?
    };
    let store = ArrowStore::open(dir.join("sidecars/robotics"))?;
    let mut graph = Graph::open(dir.join("graph.cgraph"))?;
    ingest(&mut graph, &store, &mapping, &input)?;
    graph.sync()?;
    let exported = export_arrow(&graph, &store, &mapping, 0, i64::MAX)?;
    write_ipc(&exported, dir.join("robotics.arrow"))?;
    let training = lerobot_frames(&graph, &store, &mapping, 1_000_000, 4, 200_000)?;
    write_ipc(&training, dir.join("lerobot.arrow"))?;
    println!(
        "Robotics: {} source messages, {} graph versions, {} exported messages, {} LeRobot handoff frames",
        input.len(),
        graph.stats().edge_versions,
        exported.num_rows(),
        training.num_rows()
    );
    graph.close()?;
    if args.is_empty() {
        std::fs::remove_dir_all(dir)?;
    } else {
        println!("Dataset retained at {}", dir.display());
    }
    Ok(())
}
