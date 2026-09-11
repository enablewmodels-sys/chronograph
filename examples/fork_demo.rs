use chronograph_conn_worldmodel::{
    Mapping, Step, export_arrow,
    gridworld::{Codec, Environment, State},
    ingest, ingest_fork, restore, restore_fork,
};
use chronograph_connector_common::{ArrowStore, write_ipc};
use chronograph_db::{ForkId, ForkStatus, Graph};
use rand::{Rng, SeedableRng, rngs::SmallRng};
use rayon::prelude::*;
use serde_json::json;
use std::{path::PathBuf, time::Instant};

struct Rollout {
    id: ForkId,
    steps: Vec<Step<State>>,
    reward: f64,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args().nth(1).map(PathBuf::from);
    let dir = output.clone().unwrap_or_else(|| {
        std::env::temp_dir().join(format!("chronograph-futures-{}", std::process::id()))
    });
    std::fs::create_dir(&dir)?;
    let map = Mapping::from_toml(include_str!("datasets/worldmodel/mapping.toml"))?;
    let store = ArrowStore::open(dir.join("sidecars/worldmodel"))?;
    let mut graph = Graph::open(dir.join("graph.cgraph"))?;
    let mut env = Environment::new(8, 42, 64)?;
    let prefix = [
        env.reset_record(0, 0)?,
        env.step(0, 0, 1000)?,
        env.step(0, 0, 2000)?,
    ];
    ingest::<Codec>(&mut graph, &store, &map, &prefix)?;
    graph.sync()?;
    let began = Instant::now();
    let ids: Vec<_> = (0..100)
        .map(|i| graph.fork_named(2000, format!("policy-{i:03}")))
        .collect::<Result<_, _>>()?;
    let create_ms = began.elapsed().as_secs_f64() * 1000.0;
    let snapshots: Vec<_> = ids
        .iter()
        .map(|id| {
            restore_fork::<Codec>(&graph, &store, &map, *id, 0, 2000).map(|s| (*id, s.unwrap()))
        })
        .collect::<Result<_, _>>()?;
    let began = Instant::now();
    let rollouts: Vec<Rollout> = snapshots
        .into_par_iter()
        .enumerate()
        .map(
            |(ordinal, (id, snapshot))| -> chronograph_conn_worldmodel::Result<_> {
                let mut env = Environment::from_state(snapshot.state)?;
                let mut rng = SmallRng::seed_from_u64(0x4348524f4e4f ^ ordinal as u64);
                let mut steps = vec![];
                while !env.state().terminated() && !env.state().truncated() {
                    let state = env.state();
                    let greedy = if state.x < state.goal_x { 0 } else { 1 };
                    let action = if ordinal == 0 || rng.random_range(0..100) >= (ordinal % 5) * 20 {
                        greedy
                    } else {
                        rng.random_range(0..4)
                    };
                    steps.push(env.step(action, 0, (env.state().steps as i64 + 1) * 1000)?);
                }
                let reward = steps.iter().map(|s| s.reward).sum();
                Ok(Rollout { id, steps, reward })
            },
        )
        .collect::<Result<_, _>>()?;
    let compute_ms = began.elapsed().as_secs_f64() * 1000.0;
    let began = Instant::now();
    for r in &rollouts {
        ingest_fork::<Codec>(&mut graph, &store, &map, r.id, &r.steps)?;
    }
    graph.close()?;
    let persist_and_sync_ms = began.elapsed().as_secs_f64() * 1000.0;
    let mut graph = Graph::open(dir.join("graph.cgraph"))?;
    let mut restored_records = 0;
    for r in &rollouts {
        for expected in &r.steps {
            assert_eq!(
                restore_fork::<Codec>(&graph, &store, &map, r.id, 0, expected.timestamp_us)?
                    .as_ref(),
                Some(expected)
            );
            restored_records += 1;
        }
    }
    assert_eq!(graph.history().len(), prefix.len());
    let best = rollouts
        .iter()
        .max_by(|a, b| a.reward.total_cmp(&b.reward).then_with(|| b.id.cmp(&a.id)))
        .unwrap();
    let preview = graph.preview_merge(best.id)?;
    let began = Instant::now();
    let merged = graph.merge(best.id)?;
    assert_eq!(merged, preview);
    assert!(merged.nodes.is_empty());
    graph.sync()?;
    let merge_and_sync_ms = began.elapsed().as_secs_f64() * 1000.0;
    for id in ids.iter().filter(|id| **id != best.id) {
        graph.discard(*id)?;
    }
    graph.close()?;
    let graph = Graph::open(dir.join("graph.cgraph"))?;
    assert_eq!(
        graph
            .forks()
            .filter(|f| f.status == ForkStatus::Merged)
            .count(),
        1
    );
    assert_eq!(
        graph
            .forks()
            .filter(|f| f.status == ForkStatus::Discarded)
            .count(),
        99
    );
    for expected in prefix.iter().chain(best.steps.iter()) {
        assert_eq!(
            restore::<Codec>(&graph, &store, &map, 0, expected.timestamp_us)?.as_ref(),
            Some(expected)
        );
    }
    write_ipc(
        &export_arrow::<Codec>(&graph, &store, &map, &[0])?,
        dir.join("selected-episode.arrow"),
    )?;
    let report = json!({
        "status":"passed","version":"0.3.0","forks":100,"fork_time_us":"2000","seed":42,"rayon_workers":rayon::current_num_threads(),
        "create_ms":create_ms,"parallel_compute_ms":compute_ms,"serialized_persist_and_sync_ms":persist_and_sync_ms,"merge_and_sync_ms":merge_and_sync_ms,
        "restored_branch_records":restored_records,"selected_fork":best.id.0.to_string(),"selected_reward":best.reward,
        "terminated":rollouts.iter().filter(|r|r.steps.last().unwrap().terminated).count(),"truncated":rollouts.iter().filter(|r|r.steps.last().unwrap().truncated).count(),
        "parent_versions_after_merge":graph.history().len(),"discarded":99,
        "verification":"All branch states compared after reopening; selected parent episode compared after merge, discard and reopening. Arrow export contains the completed selected episode.",
        "outcomes":rollouts.iter().map(|r|json!({"fork":r.id.0.to_string(),"steps":r.steps.len(),"reward":r.reward,"terminated":r.steps.last().unwrap().terminated})).collect::<Vec<_>>()
    });
    std::fs::write(dir.join("report.json"), serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    graph.close()?;
    if output.is_none() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}
