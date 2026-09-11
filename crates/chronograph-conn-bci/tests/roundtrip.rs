use arrow::array::{Float32Array, Int64Array, UInt32Array, UInt64Array};
use chronograph_conn_bci::*;
use chronograph_db::Graph;
fn config() -> Mapping {
    Mapping::from_toml(include_str!("../../../examples/datasets/bci/mapping.toml")).unwrap()
}
#[test]
fn source_graph_arrow_roundtrip_and_late_arrival() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("graph.cgraph");
    let mut g = Graph::open(&path).unwrap();
    let mapping = config();
    let frames: Vec<Frame> =
        serde_json::from_str(include_str!("../../../examples/datasets/bci/frames.json")).unwrap();
    for i in [3, 0, 2, 1] {
        ingest(&mut g, &mapping, &frames[i..i + 1]).unwrap();
    }
    g.close().unwrap();
    let g = Graph::open(&path).unwrap();
    assert_eq!(g.as_of(1500).edges().count(), 4);
    let batch = export_epoch(&g, &mapping, 0, 4000).unwrap();
    write_epoch(&batch, d.path().join("epoch.arrow")).unwrap();
    assert!(write_epoch(&batch, d.path().join("epoch.arrow")).is_err());
    let mut reader = arrow::ipc::reader::StreamReader::try_new(
        std::fs::File::open(d.path().join("epoch.arrow")).unwrap(),
        None,
    )
    .unwrap();
    let restored = reader.next().unwrap().unwrap();
    assert_eq!(batch, restored);
    assert!(reader.next().is_none());
    let sequence = restored
        .column_by_name("sequence")
        .unwrap()
        .as_any()
        .downcast_ref::<UInt64Array>()
        .unwrap();
    let time = restored
        .column_by_name("timestamp_us")
        .unwrap()
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    let channel = restored
        .column_by_name("channel")
        .unwrap()
        .as_any()
        .downcast_ref::<UInt32Array>()
        .unwrap();
    let values = restored
        .column_by_name("value")
        .unwrap()
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    for (i, frame) in frames.iter().enumerate() {
        for c in 0..4 {
            let row = i * 4 + c;
            assert_eq!(sequence.value(row), frame.sequence);
            assert_eq!(time.value(row), frame.timestamp_us);
            assert_eq!(channel.value(row), c as u32);
            assert_eq!(values.value(row).to_bits(), frame.values[c].to_bits());
        }
    }
    assert_eq!(
        export_epoch(&g, &mapping, 1000, 3000).unwrap().num_rows(),
        8
    );
    assert_eq!(
        restored.schema().metadata()["chronograph.connector"],
        "bci-v1"
    );
}
#[test]
fn invalid_frames_are_atomic_and_simulator_is_deterministic() {
    let d = tempfile::tempdir().unwrap();
    let mut g = Graph::open(d.path().join("graph.cgraph")).unwrap();
    let mapping = config();
    let frames = simulate(&mapping, 128, -100).unwrap();
    assert_eq!(frames, simulate(&mapping, 128, -100).unwrap());
    let mut bad = frames.clone();
    bad[127].values[0] = f32::NAN;
    assert!(ingest(&mut g, &mapping, &bad).is_err());
    assert_eq!(g.stats().edge_versions, 0);
    assert!(simulate(&mapping, 10, i64::MAX - 2).is_err());
    let mut invalid = mapping.clone();
    invalid.channel_base = u64::MAX;
    assert!(invalid.validate().is_err());
    ingest(&mut g, &mapping, &frames).unwrap();
    assert_eq!(g.stats().edge_versions, 512);
    assert!(export_epoch(&g, &mapping, 1, 1).is_err());
}
