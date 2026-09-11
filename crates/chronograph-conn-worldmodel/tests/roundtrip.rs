use chronograph_conn_worldmodel::{
    gridworld::{Codec, Environment, State},
    *,
};
use chronograph_connector_common::{self as common, ArrowStore};
use chronograph_db::Graph;
use proptest::prelude::*;
fn mapping() -> Mapping {
    Mapping::from_toml(include_str!(
        "../../../examples/datasets/worldmodel/mapping.toml"
    ))
    .unwrap()
}
fn source() -> Vec<Step<State>> {
    serde_json::from_str(include_str!(
        "../../../examples/datasets/worldmodel/steps.json"
    ))
    .unwrap()
}

#[test]
fn independent_gymnasium_source_reopen_arrow_and_exact_dynamics_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graph.cgraph");
    let store = ArrowStore::open(dir.path().join("sidecars/worldmodel")).unwrap();
    let map = mapping();
    let input = source();
    let mut graph = Graph::open(&path).unwrap();
    for chunk in input.chunks(3) {
        ingest::<Codec>(&mut graph, &store, &map, chunk).unwrap();
    }
    graph.close().unwrap();
    let graph = Graph::open(&path).unwrap();
    assert!(
        restore::<Codec>(&graph, &store, &map, 0, -1)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        export_steps::<Codec>(&graph, &store, &map, &[0, 1]).unwrap(),
        input
    );
    let batch = export_arrow::<Codec>(&graph, &store, &map, &[0, 1]).unwrap();
    common::write_ipc(&batch, dir.path().join("worldmodel.arrow")).unwrap();
    let loaded = arrow::ipc::reader::StreamReader::try_new(
        std::fs::File::open(dir.path().join("worldmodel.arrow")).unwrap(),
        None,
    )
    .unwrap()
    .next()
    .unwrap()
    .unwrap();
    assert_eq!(loaded, batch);
    for pair in input.windows(2).filter(|p| p[0].episode == p[1].episode) {
        let snapshot = restore::<Codec>(
            &graph,
            &store,
            &map,
            pair[0].episode,
            pair[1].timestamp_us - 1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(snapshot, pair[0]);
        let mut env = Environment::from_state(snapshot.state).unwrap();
        assert_eq!(
            env.step(
                pair[1].action.unwrap(),
                pair[1].episode,
                pair[1].timestamp_us
            )
            .unwrap(),
            pair[1]
        );
    }
    assert!(input.iter().any(|s| s.terminated));
    assert!(input.iter().any(|s| s.truncated));
}

#[test]
fn reject_broken_sequences_wrong_codec_and_incomplete_exports_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let store = ArrowStore::open(dir.path().join("sidecars")).unwrap();
    let mut graph = Graph::open(dir.path().join("graph.cgraph")).unwrap();
    let map = mapping();
    let mut input = source();
    let mut wrong = map.clone();
    wrong.state_codec = "observation-only".into();
    assert!(ingest::<Codec>(&mut graph, &store, &wrong, &input[..2]).is_err());
    input[1].state.rng_state = 0;
    assert!(ingest::<Codec>(&mut graph, &store, &map, &input).is_err());
    assert_eq!(graph.stats().edge_versions, 0);
    assert_eq!(
        std::fs::read_dir(dir.path().join("sidecars"))
            .unwrap()
            .count(),
        0
    );
    let input = source();
    ingest::<Codec>(&mut graph, &store, &map, &input[..2]).unwrap();
    assert!(export_arrow::<Codec>(&graph, &store, &map, &[0]).is_err());
    assert!(ingest::<Codec>(&mut graph, &store, &map, &input[..2]).is_err());
    assert!(ingest::<Codec>(&mut graph, &store, &map, &input[3..4]).is_err());
    assert_eq!(graph.stats().edge_versions, 2);
    ingest::<Codec>(&mut graph, &store, &map, &input[2..]).unwrap();
    let mut past = input.last().unwrap().clone();
    past.index += 1;
    past.timestamp_us += 50_000;
    assert!(ingest::<Codec>(&mut graph, &store, &map, &[past]).is_err());
    assert!(restore::<Codec>(&graph, &store, &map, 1000, 0).is_err());
    let mut wrong = map.clone();
    wrong.episode_base = u64::MAX;
    assert!(wrong.validate().is_err());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn random_state_restore_preserves_hidden_rng_and_future(seed in 1u64..u64::MAX, actions in prop::collection::vec(0u32..4, 1..32)) {
        let map = mapping(); let dir = tempfile::tempdir().unwrap(); let store = ArrowStore::open(dir.path().join("sidecars")).unwrap();
        let mut graph = Graph::open(dir.path().join("graph.cgraph")).unwrap();
        let mut env = Environment::new(4, seed, actions.len() as u64).unwrap();
        let mut steps = vec![env.reset_record(0, -100).unwrap()];
        for (i, action) in actions.into_iter().enumerate() {
            let step = env.step(action, 0, (i as i64+1)*100-100).unwrap();
            let done = step.terminated || step.truncated; steps.push(step); if done { break; }
        }
        ingest::<Codec>(&mut graph, &store, &map, &steps).unwrap();
        for (i, expected) in steps.iter().enumerate() {
            let restored = restore::<Codec>(&graph, &store, &map, 0, expected.timestamp_us+1).unwrap().unwrap();
            prop_assert_eq!(&restored, expected);
            let mut replay = Environment::from_state(restored.state).unwrap();
            for future in &steps[i+1..] {
                prop_assert_eq!(replay.step(future.action.unwrap(), 0, future.timestamp_us).unwrap(), future.clone());
            }
        }
        prop_assert_eq!(export_steps::<Codec>(&graph, &store, &map, &[0]).unwrap(), steps);
    }
}

#[test]
fn fork_continuation_preserves_complete_state_and_mapping_after_merge() {
    use chronograph_conn_worldmodel::{ingest_fork, restore_fork};
    let d = tempfile::tempdir().unwrap();
    let map = Mapping::from_toml(include_str!(
        "../../../examples/datasets/worldmodel/mapping.toml"
    ))
    .unwrap();
    let store = ArrowStore::open(d.path().join("sidecars")).unwrap();
    let mut graph = Graph::open(d.path().join("graph.cgraph")).unwrap();
    let mut env = Environment::new(4, 42, 16).unwrap();
    let reset = env.reset_record(0, 0).unwrap();
    ingest::<Codec>(&mut graph, &store, &map, std::slice::from_ref(&reset)).unwrap();
    let fork = graph.fork(0).unwrap();
    let a = env.step(0, 0, 1000).unwrap();
    let b = env.step(1, 0, 2000).unwrap();
    ingest_fork::<Codec>(&mut graph, &store, &map, fork, &[a.clone(), b.clone()]).unwrap();
    assert_eq!(
        restore::<Codec>(&graph, &store, &map, 0, 2000).unwrap(),
        Some(reset)
    );
    assert_eq!(
        restore_fork::<Codec>(&graph, &store, &map, fork, 0, 2000).unwrap(),
        Some(b.clone())
    );
    let before = graph.revision();
    assert!(ingest_fork::<Codec>(&mut graph, &store, &map, fork, &[a]).is_err());
    assert_eq!(graph.revision(), before);
    graph.close().unwrap();
    let mut graph = Graph::open(d.path().join("graph.cgraph")).unwrap();
    assert_eq!(
        restore_fork::<Codec>(&graph, &store, &map, fork, 0, 2000).unwrap(),
        Some(b.clone())
    );
    assert!(graph.merge(fork).unwrap().nodes.is_empty());
    assert_eq!(
        restore::<Codec>(&graph, &store, &map, 0, 2000).unwrap(),
        Some(b)
    );
}
