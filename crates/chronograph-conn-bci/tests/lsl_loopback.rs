#![cfg(feature = "lsl")]
use chronograph_conn_bci::{Mapping, export_epoch, ingest, live::Input};
use chronograph_db::Graph;
use lsl::Pushable;

/// Exercises the native library and socket transport. Run separately with the loopback LSL config.
#[test]
#[ignore = "requires local LSL socket discovery; see docs/connectors/bci.md"]
fn native_lsl_source_to_graph_to_arrow() {
    let source = format!("chronograph-test-{}", std::process::id());
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let source_id = source.clone();
    let sender = std::thread::spawn(move || {
        let info = lsl::StreamInfo::new(
            "Chronograph synthetic test",
            "EEG",
            4,
            1000.0,
            lsl::ChannelFormat::Float32,
            &source_id,
        )
        .unwrap();
        let outlet = lsl::StreamOutlet::new(&info, 0, 60).unwrap();
        ready_tx.send(()).unwrap();
        assert!(outlet.wait_for_consumers(10.0), "consumer did not connect");
        for i in 0..32 {
            outlet
                .push_sample(&vec![i as f32, 1.25, -2.5, 4.0])
                .unwrap();
        }
        done_rx
            .recv_timeout(std::time::Duration::from_secs(15))
            .unwrap();
    });
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    let mut mapping =
        Mapping::from_toml(include_str!("../../../examples/datasets/bci/mapping.toml")).unwrap();
    mapping.clock_domain = "lsl_local".into();
    mapping.lsl_source_id = Some(source);
    let mut input = Input::connect(mapping.clone(), 5.0).unwrap();
    let frames = input.read(32, 5.0).unwrap();
    done_tx.send(()).unwrap();
    sender.join().unwrap();
    for (i, frame) in frames.iter().enumerate() {
        assert_eq!(frame.sequence, i as u64);
        assert_eq!(frame.values, vec![i as f32, 1.25, -2.5, 4.0]);
    }
    let dir = tempfile::tempdir().unwrap();
    let mut graph = Graph::open(dir.path().join("graph.cgraph")).unwrap();
    ingest(&mut graph, &mapping, &frames).unwrap();
    graph.sync().unwrap();
    let batch = export_epoch(&graph, &mapping, i64::MIN, i64::MAX).unwrap();
    assert_eq!(batch.num_rows(), 128);
    println!(
        "Native LSL loopback: 32 four-channel frames received, 128 graph versions and Arrow rows matched"
    );
}
