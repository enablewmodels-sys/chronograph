# Phase 4 / world-model checkpoint

## Built

- `chronograph-conn-worldmodel`: typed versioned full-state codecs, chronological Gym-style reset/step ingestion, as-of restore, complete-episode Arrow export.
- Explicit gridworld implementations in Rust and Gymnasium, including identical serialized xorshift64 RNG, internal state and horizon handling.
- Real Minari HDF5 export/reader verification, environment recovery, reconstruction back into a second Rust graph, repeated twice.
- Committed source mapping/dataset, examples and `docs/connectors/worldmodel.md`.

## Verification evidence

The required whole-workspace build/test/Clippy/fmt gate passed (see results.json and exact logs). Three world-model tests passed, including a 32-case property test over random seeds/actions that restores every snapshot and compares its complete remaining future.

Actual end-to-end outcomes:

```text
repeat=1 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/make-worldmodel-fixture.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-l19fdq6o/source.json
repeat=1 exit=0 command=cargo run --locked -p chronograph-conn-worldmodel --example worldmodel_connector -- /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-l19fdq6o/graph /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-l19fdq6o/source.json
repeat=1 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/export-minari.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-l19fdq6o/graph/worldmodel.arrow /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-l19fdq6o/minari
repeat=1 exit=0 command=cargo run --locked -p chronograph-conn-worldmodel --example worldmodel_connector -- /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-l19fdq6o/restored /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-l19fdq6o/minari/roundtrip-steps.json
repeat=2 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/make-worldmodel-fixture.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-hs0jbqh3/source.json
repeat=2 exit=0 command=cargo run --locked -p chronograph-conn-worldmodel --example worldmodel_connector -- /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-hs0jbqh3/graph /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-hs0jbqh3/source.json
repeat=2 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/export-minari.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-hs0jbqh3/graph/worldmodel.arrow /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-hs0jbqh3/minari
repeat=2 exit=0 command=cargo run --locked -p chronograph-conn-worldmodel --example worldmodel_connector -- /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-hs0jbqh3/restored /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-worldmodel-e2e-hs0jbqh3/minari/roundtrip-steps.json
```

Each repeat independently generates 26 Gymnasium reset/step records, including two complete episodes and 24 transitions. Rust replay, actual Minari reader comparisons, Minari recovered-environment transitions and second-graph Rust replay all matched exact state/RNG, observations, rewards, flags and timestamps. Full output and package versions are in minari-roundtrip.log/json.

Actual workspace test tail:

```text

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests chronograph_db

running 1 test
test crates/chronograph-core/src/lib.rs - (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s


running 1 test
test crates/chronograph-core/src/graph.rs - graph::Graph (line 24) - compile fail ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s

all doctests ran in 0.89s; merged doctests compilation took 0.44s
   Doc-tests chronograph_server

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

## Dependencies / deviations

- `toml` 1.1 and `serde_json` 1 with float_roundtrip: typed mapping/state serialization and exact f64 source values.
- Shared `chronograph-connector-common` and workspace Arrow IPC: reuse verified sidecar durability and standard export rather than private engine internals.
- `tempfile` / workspace `proptest` (development): isolated files and randomized restore/dynamics validation.
- Optional Python Minari 0.5.3 + HDF5, Gymnasium 1.3.0 and PyArrow: actual public format export and an independent source environment. No Python dependency enters the embedded Rust engine.
- The supplied PRD file remains unavailable; current mapping supports fixed f64 observation vectors and discrete actions. Broader tensor/continuous-space claims are not made.

## Known gaps

PENDING: continuous/nested spaces and external simulator codecs. Fork-based rollouts remain blocked on F12 / Phase 5, as required; this phase verifies state restoration, not branch isolation. A custom codec must capture all state/RNG needed by its matching runtime. Only the included gridworld's Minari environment recovery is verified. Minari emitted metadata recommendations because publication permalink/author/contact are not yet configured; no fabricated identity or source URL was inserted.

Next: exploratory static OpenQASM circuit/calibration mapping, then durable core branching. Continue Community phases under the accepted plan.
