use chronograph_conn_quantum::*;
use chronograph_connector_common::{ArrowStore, write_ipc};
use chronograph_db::{Graph, NodeId};
fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let map = Mapping::from_toml(include_str!("datasets/quantum/mapping.toml"))?;
    let circuit = parser::parse(include_str!("datasets/quantum/circuit.qasm"))?;
    let windows: Vec<Calibration> =
        serde_json::from_str(include_str!("datasets/quantum/calibrations.json"))?;
    let supplied = std::env::args().nth(1);
    let dir = supplied
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chronograph-quantum-{}", std::process::id()))
        });
    std::fs::create_dir(&dir)?;
    let store = ArrowStore::open(dir.join("sidecars/quantum"))?;
    let mut graph = Graph::open(dir.join("graph.cgraph"))?;
    let ids = ingest_circuit(&mut graph, &store, &map, &circuit, 0)?;
    ingest_calibrations(&mut graph, &map, &windows)?;
    graph.close()?;
    let graph = Graph::open(dir.join("graph.cgraph"))?;
    assert_eq!(export_circuit(&graph, &store, &map)?, circuit);
    assert_eq!(export_calibrations(&graph, &map)?, windows);
    assert_eq!(graph.neighbors(NodeId(map.qubit_base), 250).count(), 0);
    write_ipc(
        &export_arrow(&graph, &store, &map)?,
        dir.join("circuit.arrow"),
    )?;
    write_ipc(
        &export_calibration_arrow(&graph, &map)?,
        dir.join("calibration.arrow"),
    )?;
    println!(
        "EXPLORATORY quantum: {} qubits, {} gates, {} DAG edges, {} exact calibration windows; gap at t=250 and reopen/Arrow comparisons passed",
        circuit.qubits,
        circuit.operations.len(),
        ids.len(),
        windows.len()
    );
    graph.close()?;
    if supplied.is_none() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}
