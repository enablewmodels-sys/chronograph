# Phase 4 / robotics checkpoint

## Built

- `chronograph-conn-robotics`: read-only bounded rosbag2 SQLite / MCAP input; checked CDR v1 JointState decoder; lossless public-API temporal ingestion and Arrow export; fixed-grid LeRobot handoff.
- `chronograph-connector-common`: reusable synchronized immutable Arrow sidecars, full SHA-256 checksum verification, collision rejection and compact batch/row references.
- Independent Python rosbags/MCAP fixtures (both byte orders, late arrivals, compressed chunks, referenced synthetic MP4).
- Official LeRobot writer/reader exporter and twice-repeated cross-language end-to-end runner.
- `docs/connectors/robotics.md`, source fixtures, example and optional pinned Python requirements.

## Verification evidence

Mandatory whole-workspace build/test/Clippy/fmt passed; exact commands, exit codes and logs are retained here. Four robotics tests and one shared-sidecar integrity test passed, in addition to existing workspace tests.

Actual test tail:

```text
   Doc-tests chronograph_connector_common

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests chronograph_db

running 1 test
test crates/chronograph-core/src/lib.rs - (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s


running 1 test
test crates/chronograph-core/src/graph.rs - graph::Graph (line 24) - compile fail ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s

all doctests ran in 0.89s; merged doctests compilation took 0.45s
   Doc-tests chronograph_server

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

Actual cross-language command outcomes:

```text
repeat=1 exit=0 command=cargo run --locked -p chronograph-conn-robotics --example robotics_connector -- /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-98zywjyw/graph <workspace>/examples/datasets/robotics/references.mcap
repeat=1 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/export-lerobot.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-98zywjyw/graph/lerobot.arrow /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-98zywjyw/graph/lerobot --dtype float64
repeat=1 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/export-lerobot.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-98zywjyw/graph/lerobot.arrow /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-98zywjyw/graph/lerobot-f32 --dtype float32
repeat=2 exit=0 command=cargo run --locked -p chronograph-conn-robotics --example robotics_connector -- /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-cadx3bku/graph <workspace>/examples/datasets/robotics/references.mcap
repeat=2 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/export-lerobot.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-cadx3bku/graph/lerobot.arrow /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-cadx3bku/graph/lerobot --dtype float64
repeat=2 exit=0 command=<workspace>/.work/connector-python/bin/python <workspace>/scripts/connectors/export-lerobot.py /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-cadx3bku/graph/lerobot.arrow /var/folders/7p/c670hx3d42960r52hjxy_3kc0000gn/T/chronograph-robotics-e2e-cadx3bku/graph/lerobot-f32 --dtype float32
```

Each repeat ingested 12 mixed CDR/JSON MCAP messages, persisted 12 graph versions, exported 12 records and four training frames. Both float64 and float32 official LeRobot datasets reopened with every value, exact int64 timestamp and video reference compared. LeRobot `delta_timestamps` and boundary padding comparisons passed. Full output is in `lerobot-roundtrip.log`; package versions are in `lerobot-roundtrip.json`.

## Dependencies / deviations

- `mcap` 0.25: official container decoding, chunk decompression, CRC checking and test format support.
- `rusqlite` 0.40 + bundled native SQLite: reproducible read-only rosbag2 storage reader with input limits.
- `toml` 1.1: validated topic mappings. `serde_json` 1 with float_roundtrip: source records and Arrow provenance without f64 precision loss.
- Common crate uses workspace Arrow IPC and `sha2` 0.10 for full content integrity; `tempfile` 3 for atomic no-clobber publication. `tempfile` is also used for isolated tests. The extra shared crate prevents each domain adapter from inventing its own sidecar/durability protocol.
- Optional Python `lerobot[dataset]` 0.6.1 writes and reads the actual v3 dataset; `rosbags` 0.11.0 independently generates ROS CDR and SQLite fixtures; `mcap` 1.3.1 independently generates compressed MCAP fixtures. `minari[hdf5]` 0.5.3 is installed for the next connector. None enters the Rust engine dependency graph.
- LeRobot videos remain external references in a real string feature, with original path/time/checksum, rather than automatically decoded native video tensors. This meets the by-reference mapping and is explicitly documented. The synthetic MP4 is committed separately.
- Recording imports and atomic batches have explicit limits; arbitrary ROS schemas and large streaming bag ingestion are not claimed.

## Known gaps

PENDING: live robot integration, additional ROS message types, multi-file bag orchestration, large streaming imports and automatic native LeRobot video feature materialization. A macOS duplicate FFmpeg Objective-C class warning was emitted by imported Python dependencies; numeric/reference tests passed, and no video decoder was exercised. Sidecar orphan garbage collection is not implemented; unused immutable batches can remain after a failed journal append.

Next: world-model state codecs, Gym-style steps and actual Minari export/restore. Continue under the accepted Community-phase authorization.
