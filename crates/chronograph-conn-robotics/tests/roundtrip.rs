use chronograph_conn_robotics::*;
use chronograph_connector_common::{self as common, ArrowStore};
use chronograph_db::Graph;
use std::path::{Path, PathBuf};
fn mapping() -> Mapping {
    Mapping::from_toml(include_str!(
        "../../../examples/datasets/robotics/mapping.toml"
    ))
    .unwrap()
}
fn fixture(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/datasets/robotics")
        .join(path)
}
fn source() -> Vec<Message> {
    serde_json::from_str(include_str!(
        "../../../examples/datasets/robotics/messages.json"
    ))
    .unwrap()
}
fn sorted(mut m: Vec<Message>) -> Vec<Message> {
    m.sort_by(|a, b| {
        (a.log_time_ns, &a.topic, a.sequence).cmp(&(b.log_time_ns, &b.topic, b.sequence))
    });
    m
}

#[test]
fn independent_rosbag_and_compressed_mcap_to_reopen_arrow_and_training() {
    let map = mapping();
    let expected = source();
    let db3 = std::fs::read_dir(fixture("rosbag2"))
        .unwrap()
        .map(|x| x.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "db3"))
        .unwrap();
    let original = std::fs::read(&db3).unwrap();
    let bags = [
        files::rosbag2(&db3, &map).unwrap(),
        files::mcap(fixture("joints.mcap"), &map).unwrap(),
    ];
    assert_eq!(std::fs::read(&db3).unwrap(), original);
    for bag in bags {
        assert_eq!(bag.skipped, 0);
        assert_eq!(bag.messages, expected);
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("graph.cgraph");
        let store = ArrowStore::open(d.path().join("sidecars/robotics")).unwrap();
        let mut graph = Graph::open(&path).unwrap();
        ingest(&mut graph, &store, &map, &bag.messages).unwrap();
        graph.close().unwrap();
        let graph = Graph::open(&path).unwrap();
        assert_eq!(graph.as_of(1_075_000).edges().count(), 2);
        assert_eq!(
            export_messages(&graph, &store, &map, 0, i64::MAX).unwrap(),
            sorted(expected.clone())
        );
        let arrow = export_arrow(&graph, &store, &map, 0, i64::MAX).unwrap();
        common::write_ipc(&arrow, d.path().join("export.arrow")).unwrap();
        let mut reader = arrow::ipc::reader::StreamReader::try_new(
            std::fs::File::open(d.path().join("export.arrow")).unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(reader.next().unwrap().unwrap(), arrow);
        assert!(reader.next().is_none());
        let training = lerobot_frames(&graph, &store, &map, 1_000_000, 4, 100_000).unwrap();
        for i in 0..4 {
            let frame: TrainingFrame = common::decode(
                &training,
                i,
                "lerobot-handoff-v1",
                &serde_json::to_string(&map).unwrap(),
            )
            .unwrap();
            assert_eq!(frame.observation, vec![i as f64, -(i as f64)]);
            assert_eq!(frame.action, vec![i as f64 + 0.25, -(i as f64) - 0.25]);
            assert_eq!(
                frame.observation_time_ns,
                (1_000_000 + i as i64 * 50_000) * 1000
            );
            assert_eq!(frame.timestamp_us * 1000, frame.action_time_ns);
        }
        assert!(lerobot_frames(&graph, &store, &map, 900_000, 1, 100_000).is_err());
        assert!(lerobot_frames(&graph, &store, &map, 2_000_000, 1, 100_000).is_err());
    }
}

#[test]
fn cdr_endianness_truncation_huge_arrays_and_atomic_invalid_input() {
    let le = std::fs::read(fixture("joint-le.cdr")).unwrap();
    let be = std::fs::read(fixture("joint-be.cdr")).unwrap();
    assert_eq!(
        cdr::joint_state(&le).unwrap(),
        cdr::joint_state(&be).unwrap()
    );
    let Data::JointState(expected) = &source()[0].data else {
        panic!()
    };
    assert_eq!(&cdr::joint_state(&le).unwrap(), expected);
    for end in 0..le.len() {
        assert!(
            cdr::joint_state(&le[..end]).is_err(),
            "accepted truncation at {end}"
        );
    }
    let mut corrupt = le.clone();
    corrupt[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(cdr::joint_state(&corrupt).is_err());
    corrupt = le.clone();
    corrupt[1] = 7;
    assert!(cdr::joint_state(&corrupt).is_err());
    let mut messages = source();
    if let Data::JointState(v) = &mut messages[7].data {
        v.position[0] = f64::NAN;
    }
    let dir = tempfile::tempdir().unwrap();
    let store = ArrowStore::open(dir.path().join("sidecars")).unwrap();
    let mut graph = Graph::open(dir.path().join("graph.cgraph")).unwrap();
    assert!(ingest(&mut graph, &store, &mapping(), &messages).is_err());
    assert_eq!(graph.stats().edge_versions, 0);
    assert_eq!(
        std::fs::read_dir(dir.path().join("sidecars"))
            .unwrap()
            .count(),
        0
    );
    let mut map = mapping();
    map.topics[0].message_type = "unknown/msg/Foo".into();
    assert!(map.validate().is_err());
}

#[test]
fn referenced_video_and_sub_microsecond_times_are_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let store = ArrowStore::open(dir.path().join("sidecars")).unwrap();
    let mut graph = Graph::open(dir.path().join("graph.cgraph")).unwrap();
    let map = mapping();
    let mut messages = source();
    let reference = VideoReference {
        path: "camera/episode.mp4".into(),
        timestamp_ns: 0,
        sha256: "ab".repeat(32),
    };
    messages.push(Message {
        topic: "/camera/reference".into(),
        log_time_ns: 1_000_000_000,
        publish_time_ns: 1_000_000_000,
        sequence: 9,
        data: Data::Video(reference.clone()),
    });
    ingest(&mut graph, &store, &map, &messages).unwrap();
    let frames = lerobot_frames(&graph, &store, &map, 1_000_000, 1, 100_000).unwrap();
    let first: TrainingFrame = common::decode(
        &frames,
        0,
        "lerobot-handoff-v1",
        &serde_json::to_string(&map).unwrap(),
    )
    .unwrap();
    assert_eq!(first.video, vec![reference]);
    messages[1].log_time_ns += 500;
    let sub = &messages[1..2];
    ingest(&mut graph, &store, &map, sub).unwrap();
    assert!(lerobot_frames(&graph, &store, &map, 1_150_000, 1, 200_000).is_err());
    let before = graph.stats().edge_versions;
    let Data::Video(v) = &mut messages[8].data else {
        panic!()
    };
    v.path = "../secret".into();
    assert!(ingest(&mut graph, &store, &map, &messages).is_err());
    assert_eq!(graph.stats().edge_versions, before);
}

#[test]
fn damaged_and_unsupported_files_fail_without_source_mutation() {
    let d = tempfile::tempdir().unwrap();
    let map = mapping();
    let original = std::fs::read(fixture("joints.mcap")).unwrap();
    let mut cursor = 8usize;
    let mut mutated = original.clone();
    let mut found = false;
    while cursor + 9 <= original.len() - 8 {
        let op = original[cursor];
        let len = u64::from_le_bytes(original[cursor + 1..cursor + 9].try_into().unwrap()) as usize;
        if op == 6 {
            // Chunk header begins with start/end timestamps, then declared decompressed size.
            mutated[cursor + 9 + 16..cursor + 9 + 24]
                .copy_from_slice(&(65u64 * 1024 * 1024).to_le_bytes());
            found = true;
            break;
        }
        cursor += 9 + len;
    }
    assert!(found);
    let bad = d.path().join("oversized.mcap");
    std::fs::write(&bad, &mutated).unwrap();
    assert!(files::mcap(&bad, &map).is_err());
    assert_eq!(std::fs::read(&bad).unwrap(), mutated);
    mutated = original.clone();
    // Flip the chunk's uncompressed CRC: the official MCAP reader must reject it.
    mutated[cursor + 9 + 24] ^= 1;
    let bad = d.path().join("crc.mcap");
    std::fs::write(&bad, &mutated).unwrap();
    assert!(files::mcap(&bad, &map).is_err());
    std::fs::write(&bad, &original[..original.len() - 1]).unwrap();
    assert!(files::mcap(&bad, &map).is_err());
    let mut limited = map.clone();
    limited.topics.retain(|t| t.role == Role::Observation);
    let filtered = files::mcap(fixture("joints.mcap"), &limited).unwrap();
    assert_eq!(filtered.messages.len(), 4);
    assert_eq!(filtered.skipped, 4);
    let db = d.path().join("bad.db3");
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch("CREATE TABLE topics(id INTEGER, name TEXT, type TEXT, serialization_format TEXT); CREATE TABLE messages(id INTEGER, topic_id INTEGER, timestamp INTEGER, data BLOB); INSERT INTO topics VALUES(1,'/joint_states','sensor_msgs/msg/JointState','unrecognized'); INSERT INTO messages VALUES(1,1,0,X'00');").unwrap();
    drop(c);
    let source = std::fs::read(&db).unwrap();
    assert!(files::rosbag2(&db, &map).is_err());
    assert_eq!(std::fs::read(db).unwrap(), source);
}
