# Phase 4 summary — connectors

All four adapters are implemented in the prescribed order over public graph APIs and Arrow. Each has a TOML mapping, source fixture, example, mapping-spec document and source-to-graph-to-export comparisons.

| Connector | Verified scope | Evidence |
| --- | --- | --- |
| BCI | Atomic scalar-frame ingest, late arrivals, epoch IPC, optional native LSL synthetic socket transport | [BCI checkpoint](../phase-4-bci/REPORT.md) |
| Robotics | Independent rosbag2/MCAP JointState + video-reference mapping, actual LeRobot writer/reader and delta timestamps, twice | [Robotics checkpoint](../phase-4-robotics/REPORT.md) |
| World model | Gym-style steps, complete-state/RNG restore, actual Minari and recovered Gymnasium environment, second Rust graph, twice | [World-model checkpoint](../phase-4-worldmodel/REPORT.md) |
| Quantum | Exploratory bounded static OpenQASM AST/DAG and atomic directed calibration windows | [Quantum checkpoint](../phase-4-quantum/REPORT.md) |

## Combined verification

The final connector workspace gate passed build, tests, denied-warning Clippy and formatting in `../phase-4-quantum/results.json`. Additional whole-workspace **all-features tests and all-targets Clippy** also passed; exact commands/results are in `all-features.json`. The combined test log reports 42 passed and 2 ignored (the intentional crash-process helper and opt-in LSL socket test). The crash helper is exercised by the parent crash test; the LSL socket test was run separately and passed in the BCI checkpoint.

Actual combined test tail:

```text
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests chronograph_connector_common

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests chronograph_db

running 1 test
test crates/chronograph-core/src/lib.rs - (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s


running 1 test
test crates/chronograph-core/src/graph.rs - graph::Graph (line 24) - compile fail ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s

all doctests ran in 1.45s; merged doctests compilation took 0.99s
   Doc-tests chronograph_server

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

Actual combined Clippy tail:

```text
$ cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
   Compiling lamquant-lsl-sys v0.1.2
    Checking lamquant-lsl v0.1.2
    Checking chronograph-conn-bci v0.3.0 (<workspace>/crates/chronograph-conn-bci)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 7.41s
```

## Deviations and gaps

Full details and one-line dependency justifications are in each checkpoint. The shared Arrow sidecar crate avoids duplicated storage protocols. The small public bounded-interval engine API ensures calibration windows are committed atomically; it reuses the existing checked journal format. The optional LSL dependency uses a pinned compatible binding fork because the original failed on Apple Clang; both default and optional builds were verified.

Hardware-specific BCI/robot/quantum integration, arbitrary ROS schemas, large streaming recordings, automatically decoded video/tensor features, continuous/nested environment spaces and broader OpenQASM semantics remain PENDING, with explicit limits in their guides. These adapters are concrete tested integrations within their stated scopes, not claims of universal device support. Fork rollouts remain blocked on the next core phase.

## Next phase

Implement F12 durable copy-on-write forks, conflict-checked merge/discard, recovery/property tests and the 100-future gridworld demo. Then complete the Community UI and release hardening before the agreed managed review. GitHub publication, AWS provisioning and managed billing remain deferred.
