# Phase 4 / BCI checkpoint

## Built

- `crates/chronograph-conn-bci`: validated TOML mapping, atomic public-API frame ingestion, deterministic simulator, Arrow epoch export, optional native LSL input.
- `examples/bci_connector.rs` and committed four-frame source dataset / local LSL discovery config.
- `docs/connectors/bci.md`: payload layout, clocks, late arrivals, bounds and live acquisition semantics.

## Verification evidence

All workspace build/test/Clippy/fmt commands passed; exact output and exit codes are in `results.json` and the four logs. The optional feature build passed (`lsl-compatible-feature.log`).

```text
$ cargo run --locked -p chronograph-conn-bci --example bci_connector
   Compiling chronograph-conn-bci v0.3.0 (<workspace>/crates/chronograph-conn-bci)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.66s
     Running `target/debug/examples/bci_connector`
Synthetic BCI: 10000 frames, 40000 channel versions, 4000 epoch rows, 4 active at 2.5 s
```

Native socket transport test (explicit opt-in):

```text
Native LSL loopback: 32 four-channel frames received, 128 graph versions and Arrow rows matched
test native_lsl_source_to_graph_to_arrow ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.22s
```

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

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s

all doctests ran in 0.95s; merged doctests compilation took 0.41s
   Doc-tests chronograph_server

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

## Dependencies and deviations

- `toml` 1.1: checked human-readable mapping configuration.
- `serde_json` 1: lossless source fixture parsing and Arrow schema provenance.
- Optional `lamquant-lsl` =0.1.2: compatible safe Rust bindings bundling liblsl 1.16.2. The original `lsl` =0.1.1 failed Apple Clang 17 in bundled Boost; suppressing its enum diagnostic still failed on missing `flat_tree::insert`. Actual failed build retained in `lsl-feature.log`. No dependency source was edited.
- `tempfile` (development): isolated graph/export directories. Arrow IPC uses the workspace Arrow release.
- Synthetic fixture and native synthetic transport are separately tested; neither establishes device compatibility. The native library logged a receiver reconnection when its synthetic outlet closed at test completion, after all samples were received and compared.

## Known gaps

PENDING: actual EEG/BCI device integration, cross-host clock validation, sustained loss/reconnection behavior, and live-feature Linux/Windows builds. The default adapter has no native LSL dependency.

Next: robotics rosbag2/MCAP and actual LeRobot writer/reader round trip, under the user's continuous Community-phase authorization.
