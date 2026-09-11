use chronograph_conn_quantum::*;
use chronograph_connector_common::{self as common, ArrowStore};
use chronograph_db::{Graph, NodeId};
fn mapping() -> Mapping {
    Mapping::from_toml(include_str!(
        "../../../examples/datasets/quantum/mapping.toml"
    ))
    .unwrap()
}
fn source() -> &'static str {
    include_str!("../../../examples/datasets/quantum/circuit.qasm")
}

#[test]
fn openqasm_ast_dag_reopen_arrow_and_tamper_detection() {
    let map = mapping();
    let circuit = parser::parse(source()).unwrap();
    assert_eq!(circuit.qubits, 3);
    assert_eq!(circuit.operations.len(), 5);
    assert_eq!(
        circuit
            .operations
            .iter()
            .map(|op| op.predecessors.clone())
            .collect::<Vec<_>>(),
        vec![vec![], vec![], vec![0], vec![2], vec![1, 3]]
    );
    assert_eq!(
        circuit.operations[3].parameters,
        vec![std::f64::consts::FRAC_PI_2]
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graph.cgraph");
    let store = ArrowStore::open(dir.path().join("sidecars/quantum")).unwrap();
    let mut graph = Graph::open(&path).unwrap();
    let ids = ingest_circuit(&mut graph, &store, &map, &circuit, 10).unwrap();
    assert_eq!(ids.len(), 20);
    assert_eq!(graph.as_of(9).edges().count(), 0);
    assert_eq!(graph.as_of(10).edges().count(), 20);
    assert!(ingest_circuit(&mut graph, &store, &map, &circuit, 20).is_err());
    graph.close().unwrap();
    let mut graph = Graph::open(&path).unwrap();
    assert_eq!(export_circuit(&graph, &store, &map).unwrap(), circuit);
    let batch = export_arrow(&graph, &store, &map).unwrap();
    common::write_ipc(&batch, dir.path().join("circuit.arrow")).unwrap();
    let loaded = arrow::ipc::reader::StreamReader::try_new(
        std::fs::File::open(dir.path().join("circuit.arrow")).unwrap(),
        None,
    )
    .unwrap()
    .next()
    .unwrap()
    .unwrap();
    let restored: Circuit = common::decode(
        &loaded,
        0,
        "quantum-circuit-v1",
        &serde_json::to_string(&map).unwrap(),
    )
    .unwrap();
    assert_eq!(restored.source, source());
    assert_eq!(restored, circuit);
    graph.invalidate_edge(ids[2], 20).unwrap();
    assert!(export_circuit(&graph, &store, &map).is_err());
}

#[test]
fn calibration_windows_are_atomic_durable_and_have_real_gaps() {
    let map = mapping();
    let windows: Vec<Calibration> = serde_json::from_str(include_str!(
        "../../../examples/datasets/quantum/calibrations.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graph.cgraph");
    let mut graph = Graph::open(&path).unwrap();
    ingest_calibrations(&mut graph, &map, &windows).unwrap();
    assert_eq!(graph.revision(), 1);
    assert_eq!(graph.neighbors(NodeId(map.qubit_base), 199).count(), 1);
    assert_eq!(graph.neighbors(NodeId(map.qubit_base), 200).count(), 0);
    assert_eq!(graph.neighbors(NodeId(map.qubit_base), 299).count(), 0);
    assert_eq!(graph.neighbors(NodeId(map.qubit_base), 300).count(), 1);
    graph.close().unwrap();
    let mut graph = Graph::open(&path).unwrap();
    assert_eq!(export_calibrations(&graph, &map).unwrap(), windows);
    let mut bad = windows.clone();
    bad[2].duration_ns = f64::NAN;
    assert!(ingest_calibrations(&mut graph, &map, &bad).is_err());
    assert_eq!(graph.revision(), 1);
    let correction = Calibration {
        from_qubit: 0,
        to_qubit: 1,
        valid_from: 150,
        valid_to: 160,
        error_rate: 0.005,
        duration_ns: 100.0,
    };
    ingest_calibrations(&mut graph, &map, std::slice::from_ref(&correction)).unwrap();
    assert_eq!(graph.neighbors(NodeId(map.qubit_base), 160).count(), 0);
    let exported = export_calibrations(&graph, &map).unwrap();
    assert_eq!(exported[0].valid_to, 150);
    assert_eq!(exported[3], correction);
    let arrow = export_calibration_arrow(&graph, &map).unwrap();
    assert_eq!(arrow.num_rows(), 4);
}

#[test]
fn unsupported_qasm_is_rejected_instead_of_silently_lowered() {
    let prefix = "OPENQASM 3.0; include \"stdgates.inc\"; qubit[2] q; ";
    for suffix in [
        "measure q[0];",
        "h q;",
        "cx q[0],q[0];",
        "cx q[0],q[2];",
        "h(1) q[0];",
        "rx q[0];",
        "ctrl @ x q[0],q[1];",
        "for int i in [0:1] { h q[i]; }",
        "bit c; c = measure q[0];",
        "barrier q;",
        "reset q[0];",
        "defcal x $0 {}",
        "unknown q[0];",
        "rz(pi/0) q[0];",
        "rz(1e999) q[0];",
        "h q[0]",
    ] {
        assert!(
            parser::parse(&format!("{prefix}{suffix}")).is_err(),
            "accepted {suffix}"
        );
    }
    for text in [
        "OPENQASM 2.0; qreg q[2]; h q[0];",
        "OPENQASM 3.0; include \"../../secret\"; qubit q; h q;",
        "qubit q; h q;",
        "OPENQASM 3.0; qubit[65] q; U(0,0,0) q[0];",
        "OPENQASM 3.0; qubit pi; U(0,0,0) pi;",
    ] {
        assert!(parser::parse(text).is_err());
    }
    let scalar = parser::parse("OPENQASM 3.0; qubit q; U(0, 1.0, -pi/2) q;").unwrap();
    assert_eq!(
        scalar.operations[0].parameters,
        vec![0.0, 1.0, -std::f64::consts::FRAC_PI_2]
    );
    assert!(
        parser::parse(&format!(
            "{prefix}rx({}1{}) q[0];",
            "(".repeat(10000),
            ")".repeat(10000)
        ))
        .is_err()
    );
    let mut mapping = mapping();
    mapping.operation_base = mapping.qubit_base;
    assert!(mapping.validate().is_err());
}
