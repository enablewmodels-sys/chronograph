use chronograph_conn_worldmodel::{
    Mapping, Step, export_arrow, export_steps,
    gridworld::{Codec, Environment, State},
    ingest, restore,
};
use chronograph_connector_common::{ArrowStore, write_ipc};
use chronograph_db::Graph;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mapping = Mapping::from_toml(include_str!("datasets/worldmodel/mapping.toml"))?;
    let source: Vec<Step<State>> = if let Some(path) = args.get(1) {
        serde_json::from_slice(&std::fs::read(path)?)?
    } else {
        serde_json::from_str(include_str!("datasets/worldmodel/steps.json"))?
    };
    let dir = args
        .first()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chronograph-worldmodel-{}", std::process::id()))
        });
    std::fs::create_dir(&dir)?;
    let store = ArrowStore::open(dir.join("sidecars/worldmodel"))?;
    let mut graph = Graph::open(dir.join("graph.cgraph"))?;
    for batch in source.chunks(3) {
        ingest::<Codec>(&mut graph, &store, &mapping, batch)?;
    }
    graph.close()?;
    let graph = Graph::open(dir.join("graph.cgraph"))?;
    let output = export_steps::<Codec>(&graph, &store, &mapping, &[0, 1])?;
    assert_eq!(output, source);
    let mut replayed = 0;
    for pair in source.windows(2).filter(|p| p[0].episode == p[1].episode) {
        let snapshot = restore::<Codec>(
            &graph,
            &store,
            &mapping,
            pair[0].episode,
            pair[0].timestamp_us,
        )?
        .unwrap();
        let mut env = Environment::from_state(snapshot.state)?;
        let next = env.step(
            pair[1].action.unwrap(),
            pair[1].episode,
            pair[1].timestamp_us,
        )?;
        assert_eq!(next, pair[1]);
        replayed += 1;
    }
    write_ipc(
        &export_arrow::<Codec>(&graph, &store, &mapping, &[0, 1])?,
        dir.join("worldmodel.arrow"),
    )?;
    println!(
        "World model: {} source/reset records, two complete episodes; {} exact next-step/RNG restores and Arrow source comparisons passed",
        source.len(),
        replayed
    );
    graph.close()?;
    if args.is_empty() {
        std::fs::remove_dir_all(dir)?;
    } else {
        println!("Dataset retained at {}", dir.display());
    }
    Ok(())
}
