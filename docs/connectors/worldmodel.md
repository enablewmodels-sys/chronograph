# World-model episodes and state restoration

`chronograph-conn-worldmodel` records Gymnasium-style reset/step data through public `Graph` APIs and exports complete episodes as Arrow and real Minari datasets. The current adapter supports fixed-length f64 observations and a discrete action space. It includes an explicit gridworld state codec and matching Rust/Gymnasium simulators.

## Mapping and step model

Configure `examples/datasets/worldmodel/mapping.toml`: environment ID/node, episode node range, relationship kind, observation dimension, discrete action count, versioned state codec and an explicit `simulation_us` or `unix_us` clock. Reserve this namespace; exact mapping metadata is checked when reading sidecars.

Each `Step<State>` contains an episode ID, contiguous index, timestamp, post-action observation, optional action, reward, separate `terminated`/`truncated` flags and the full internal state. Index zero is a reset: action `None`, reward zero, both flags false. Later records require an action, strictly increasing time and contiguous indices. Once either completion flag is true, start a new episode. The distinction follows the [Gymnasium step API](https://gymnasium.farama.org/api/env/); a time-limit truncation is not silently changed into a task termination.

The relationship is `(episode_base + episode) → environment_node`, with `state_kind`. The payload references a row in an immutable Arrow sidecar under `data/sidecars/worldmodel/`. See the [sidecar layout and durability rules](robotics.md#arrow-sidecars-and-durability). All state remains in Arrow, and only the compact reference enters the graph. `ingest::<Codec>` validates the full batch and existing episode continuation, synchronizes the sidecar, and then appends one atomic graph batch. Call `graph.sync()` or use `Durability::Fsync` for a durable acknowledgement.

Up to 100,000 reset/step records fit one episode/export; the shared 8 MiB normalized JSON and 16 MiB IPC bounds also apply. At most 1000 complete episodes can be selected in an export, within the total record bound. Ingestion is chronological per episode; late sensor corrections belong in an independently mapped sensor relationship rather than silently rewriting a recorded action trajectory.

## Complete state codecs

Implement `StateCodec` with a stable version ID, a typed serializable `State`, and validation of state/observation/step invariants. Capture all variables that influence future dynamics: positions, velocities, hidden simulator state, parameters, time counters and **the exact RNG state**. Do not label an observation vector as restorable state unless it actually contains all of those variables. The adapter never deserializes executable Python pickles.

`restore::<Codec>(graph, store, mapping, episode, t)` obtains the active state at `t` and verifies its codec, mapping and graph relationship. Before reset it returns `None`; at and after the final episode timestamp it returns the completed state. Pass that state to the matching runtime's restore constructor. `decode_edge` also accepts an edge returned by another graph view. Each codec's owner is responsible for compatibility with that environment version; the adapter validates snapshots and trajectory sequencing, not arbitrary physical equations.

The included `chronograph-gridworld-xorshift64-v1` codec stores grid dimensions, agent/goal positions, step/horizon counters and a nonzero u64 RNG state. Its four actions are right/down/left/up; one quarter of transitions slip to an RNG-selected direction. Xorshift64 uses defined wrapping integer arithmetic and is explicitly part of this codec version. This is a deterministic demonstration environment. Its state validator checks the observation, reward and completion flags against the snapshot. The Python Gymnasium implementation uses this same explicit RNG for all dynamics; Gymnasium's auxiliary RNG is not used by its transitions.

```rust,ignore
let snapshot = chronograph_conn_worldmodel::restore::<
    chronograph_conn_worldmodel::gridworld::Codec
>(&graph, &sidecars, &mapping, 0, 150_000)?.unwrap();
let mut world = chronograph_conn_worldmodel::gridworld::Environment::from_state(snapshot.state)?;
let next = world.step(1, 0, 200_000)?;
```

## Run the example

```sh
cargo run --locked -p chronograph-conn-worldmodel --example worldmodel_connector
# Keep a new graph and standard Arrow IPC export:
cargo run --locked -p chronograph-conn-worldmodel --example worldmodel_connector -- ./worldmodel-demo
```

The fixture was generated independently by `scripts/connectors/gridworld_env.py` through the Gymnasium reset/step API. It includes both task termination and horizon truncation: 26 reset/step records, two complete episodes and 24 transitions. The Rust example ingests in batches, reopens the journal, restores before every subsequent action and compares the full next state, including RNG, with the Python source.

## Actual Minari export

`export_arrow::<Codec>` exports complete episodes, including reset observations and full snapshots. Incomplete, noncontiguous or prematurely terminated trajectories are rejected. The Python exporter uses [Minari's official buffer writer](https://minari.farama.org/main/api/minari_functions/), not a lookalike JSON directory:

```sh
python3 -m venv .venv-connectors
.venv-connectors/bin/python -m pip install -r scripts/connectors/requirements.txt
.venv-connectors/bin/python scripts/connectors/export-minari.py \
  worldmodel-demo/worldmodel.arrow worldmodel-demo/minari
```

Minari stores `N+1` observations and state snapshots for `N` actions/rewards/completion flags. Original microsecond timestamps remain int64 in `infos.chronograph_timestamp_us`; complete state JSON remains in `infos.chronograph_state_json`. IDs and mapping provenance are saved in `chronograph.json`; Minari assigns its own sequential episode indices. No dataset is uploaded or downloaded. Output must be a new directory.

For the included gridworld, the exporter records a real Gymnasium environment spec and verifies `recover_environment()`: every loaded snapshot is restored and its next action reproduces the source. To recover it in another Python process, put `scripts/connectors` on `PYTHONPATH` so the committed `gridworld_env` module is available, then load the dataset with its `MINARI_DATASETS_PATH`. Other codecs export declared observation/action spaces without pretending that Minari can reconstruct an unregistered environment. Supply and validate your matching runtime separately.

The exporter reopens all observations, actions, rewards, flags, timestamps and snapshots, then writes `roundtrip-steps.json` reconstructed from the actual Minari reader. The end-to-end test reingests that file into a second Rust graph and verifies exact next-state/RNG replay again.

```sh
cargo test --locked -p chronograph-conn-worldmodel
.venv-connectors/bin/python scripts/connectors/test-worldmodel.py
```

Evidence: `bench/reports/v0.3.0/phase-4-worldmodel/`. Property tests cover 32 random seeds/action sequences and restoration at every snapshot, including the rest of the future trajectory. No rollout benchmark or external physics simulator compatibility is inferred from these tests.

PENDING: continuous/nested action and observation spaces, external simulator codecs, and automatically materialized image/tensor observations. Fork-based rollouts use the durable branch API described below.


## Durable fork rollouts

Create and ingest the episode reset and any shared prefix in the parent before forking. `ingest_fork::<Codec>(graph, store, mapping, fork, steps)` validates continuation against the selected branch, synchronizes its sidecar batch and commits only to that branch. Times must be at or after the fork. The mapped episode/environment nodes must exist in the parent; this preserves their namespace on merge. Do not register branch-local replacement episode IDs and assume opaque sidecar data will be remapped.

`restore_fork::<Codec>(graph, store, mapping, fork, episode, t)` reads the complete state from that branch. A branch inherits only the snapshot active at its creation time, so a fork taken mid-episode does not itself contain the earlier trajectory. Merge an eligible future into the parent to export the full completed episode with its original prefix through Minari/Arrow.

Run `cargo run --locked --release -p chronograph-conn-worldmodel --example fork_demo -- ./fork-demo` for 100 actual futures, parallel action-policy simulation, persistent branch verification, best-future merge and selected-episode Arrow export. The example preserves complete environment RNG state and varies action policies. Its computation timings do not represent a GPU physics simulator or distributed rollout service. [Branch guide](../BRANCHES.md).
