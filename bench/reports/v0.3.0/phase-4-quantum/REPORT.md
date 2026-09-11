# Phase 4 / exploratory quantum checkpoint

## Built

- `chronograph-conn-quantum`: real OpenQASM lexer/AST with a bounded static unitary subset; circuit DAG graph mapping; verified source/topology Arrow export; directed calibration windows.
- Committed source, TOML mapping and calibration fixtures; example and mapping-spec documentation.
- Public engine `BoundedEdgeInput`, `WriteOp::AddBoundedEdges` and `Graph::add_edges_bounded` for atomically committing explicit validity ends. Existing v2 records already encode these ends; no file format change.

## Verification evidence

All required whole-workspace checks passed (results.json and exact build/test/Clippy/fmt logs). Three connector tests passed; two new engine tests include a 32-case bounded-batch reference-model property test covering 200 query times and journal reopen.

Actual example output:

```text
$ cargo run --locked -p chronograph-conn-quantum --example quantum_connector
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.29s
     Running `target/debug/examples/quantum_connector`
EXPLORATORY quantum: 3 qubits, 5 gates, 20 DAG edges, 3 exact calibration windows; gap at t=250 and reopen/Arrow comparisons passed
```

Actual workspace test tail:

```text

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests chronograph_db

running 1 test
test crates/chronograph-core/src/lib.rs - (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s


running 1 test
test crates/chronograph-core/src/graph.rs - graph::Graph (line 24) - compile fail ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s

all doctests ran in 2.13s; merged doctests compilation took 1.66s
   Doc-tests chronograph_server

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

## Dependencies / deviations

- `oq3_parser` and `oq3_syntax` =0.7.0: the Qiskit project's lexer and typed syntax tree, followed by strict supported-subset validation.
- `toml` 1.1 / `serde_json` 1 float_roundtrip: typed mapping/source provenance and exact f64 calibration values.
- Shared connector Arrow store and workspace Arrow IPC: durable sidecars and standard exports without private engine access. `tempfile` (development) isolates tests.
- The new bounded public write API is necessary to avoid a durable open calibration interval between separate insert/invalidate calls. It preserves the existing late-arrival rules and tracks bounds during batch preparation, so writes cannot extend predecessors through gaps.
- OpenQASM dynamic/classical/measurement programs are deliberately rejected; this exploratory feature is a circuit/calibration mapping, not a simulator or general-purpose compiler.

## Known gaps

PENDING: broader OpenQASM semantics, measurement/classical DAGs, pulse programs, live calibration providers and quantum hardware/runtime interoperability. No quantum runtime or hardware was exercised.

Next: combined Phase 4 feature check, then F12 durable copy-on-write branches and the 100-future world-model demo under the accepted Community-phase authorization.
