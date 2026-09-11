# Robotics recordings and LeRobot

`chronograph-conn-robotics` reads a **closed rosbag2 SQLite `.db3` file** or an **MCAP file**, validates mapped messages, and ingests through the public `Graph` API. It does not run a ROS node or contact a robot. A recording containing other types is usable when those topics are left unmapped; the importer reports how many it skipped.

## Supported mapping

Start from `examples/datasets/robotics/mapping.toml`. Reserve the configured robot node and each `(topic node, edge kind)` relationship for this mapping.

| Input | Supported serialization | Graph mapping |
| --- | --- | --- |
| `sensor_msgs/msg/JointState` | Plain CDR v1, little or big endian; standard ROS JSON in MCAP | Robot → topic, one version per message; observation or action role |
| `chronograph/VideoReference` | JSON in MCAP | Robot → camera-reference topic; path, media timestamp and SHA-256 retained |

The [ROS JointState definition](https://github.com/ros2/common_interfaces/blob/rolling/sensor_msgs/msg/JointState.msg) supplies names, positions, velocities and efforts. The adapter requires 1–4096 unique names; each numeric vector must be empty or match their count, with finite values. Empty position vectors can be archived but cannot form a LeRobot state/action frame. Unknown fields/types, XCDR2, parameter-list CDR, image pixels, point clouds and custom ROS message definitions are rejected when mapped. They are not guessed from bytes. The independently generated fixtures use ROS 2 Humble definitions from `rosbags`.

ROS log time and MCAP log/publish times are preserved as nonnegative signed 64-bit nanoseconds in the Arrow record. Graph `valid_from` is `log_time_ns / 1000`; choose `simulation_ns` or `unix_ns` explicitly. Header acquisition stamps remain unchanged and are not substituted for the recording timestamp. Rosbag2 has no separate publisher sequence/time in the supported schema: its record ID becomes `sequence` and publish time equals log time. MCAP's native sequence/publish time are retained. See the [MCAP format](https://mcap.dev/spec) and [rosbag2 SQLite implementation](https://github.com/ros2/rosbag2/tree/rolling/rosbag2_storage_sqlite3).

Late arrivals and equal microsecond timestamps follow engine versioning. `export_messages` / `export_arrow` select acquisition starts in `[start_us,end_us)` and retain all messages, including versions superseded within the same microsecond. Results sort by original nanoseconds, topic and sequence. `as_of(t)` shows the latest valid version per topic at microsecond resolution.

## Arrow sidecars and durability

Create `ArrowStore` under `data/sidecars/robotics/`. All source fields live in a versioned Arrow UTF-8 `record_json` column; numerical JSON parsing preserves f64 round trips. The graph payload is a 12-byte SHA-256 address prefix followed by a 4-byte little-endian row offset. Each immutable sidecar contains an 8-byte `CGAR0001` header, the full SHA-256 checksum, then a standard Arrow IPC stream. A conflicting address never overwrites another file; reads verify the full checksum, address, row offset, mapping and graph relationship. The public export is plain Arrow IPC without the sidecar wrapper.

An entire normalized batch is validated before mutation. Its sidecar file and containing directory are synchronized **before** the atomic graph batch is appended. Then call `graph.sync()` or use `Durability::Fsync` to persist the references. A failed graph append can leave an unreferenced sidecar; it cannot create a graph reference before the sidecar is durable. Automatic garbage collection is not implemented. Keep the graph and all sidecars together; service backups include this directory. The owning application must control this local directory exclusively. Do not edit sidecars in place or rename a mapping after ingestion: exact mapping metadata is verified during replay/export.

## Bounds

- Recording file: 256 MiB. At most one million source records, 100,000 mapped records and 16 MiB of mapped wire payloads per read.
- MCAP: chunk expansion ≤64 MiB, total expanded chunks ≤256 MiB, official reader CRC validation. LZ4, Zstandard and uncompressed chunks are supported.
- A mapped message: ≤1 MiB. CDR strings ≤4096 bytes. Up to 256 configured topics.
- An atomic normalized Arrow batch: ≤8 MiB of JSON data, ≤16 MiB IPC. Partition larger recordings/batches explicitly. This preview adapter does not claim streaming multi-terabyte ingestion.

## Run and export

```sh
cargo run --locked -p chronograph-conn-robotics --example robotics_connector
# Retain a new demo graph and Arrow exports; destination must not exist:
cargo run --locked -p chronograph-conn-robotics --example robotics_connector -- \
  ./robotics-demo ./examples/datasets/robotics/references.mcap
```

For your application, call `files::rosbag2` or `files::mcap` with your mapping, `ingest`, then `graph.sync()`. Export messages as Arrow or call `lerobot_frames(graph, store, mapping, start_us, count, max_age_us)`. The latter samples a fixed FPS grid, requires exactly one observation and one action topic with stable joint names, and refuses missing, stale or future samples. A nanosecond sample that rounds down into a grid microsecond but is actually later than the grid is rejected; align acquisition/export clocks appropriately.

The optional Python exporter uses the **official LeRobot 0.6.1 v3 dataset writer and reader**, with local files only:

```sh
python3 -m venv .venv-connectors
.venv-connectors/bin/python -m pip install -r scripts/connectors/requirements.txt
.venv-connectors/bin/python scripts/connectors/export-lerobot.py \
  robotics-demo/lerobot.arrow robotics-demo/lerobot-dataset
```

`observation.state` and `action` default to float64 to preserve the ROS values. `--dtype float32` makes an explicit training-oriented conversion; overflow is rejected. LeRobot owns episode-relative timestamps and frame indices. Original graph, observation and action timestamps are separate int64 features. `meta/chronograph.json` retains mapping, origin, dtype, writer version and sample temporal offsets. The exporter reopens every frame and checks values, timestamps and video references. It also reopens with `delta_timestamps`: `[-1/fps,0]` for observations and `[0,1/fps]` for actions, and verifies sampled neighbors and episode-boundary padding. These are offsets on the sampled training grid; irregular source acquisition times remain available in the int64 features.

Video stays **by reference** in the standard string feature `chronograph.video_refs`: a JSON list of safe relative paths, media timestamps and checksums. A synthetic MP4 is included with the mixed-encoding fixture. The graph/exporter neither reads nor copies video, and the LeRobot reader does not automatically decode this custom reference feature. Your training loader must resolve the references against an explicitly selected media root and verify the checksum, or materialize native LeRobot video features separately. The exported dataset is a real LeRobot dataset, but it is not a self-contained video archive. Backup external media separately.

## Verification

```sh
cargo test --locked -p chronograph-conn-robotics
.venv-connectors/bin/python scripts/connectors/test-robotics.py
```

The Rust tests compare independent rosbag2 and compressed MCAP inputs with journal-reopened Arrow records, test both CDR byte orders, every truncated prefix, malformed lengths, atomic rejection, video references, sub-microsecond handling, bad CRCs, excessive chunk expansion and unsupported encodings. The Python pipeline runs twice, including both float64 and float32 LeRobot exports and temporal reader checks. Reports are in `bench/reports/v0.3.0/phase-4-robotics/`.

PENDING: live robot integration, other ROS message types, multi-file bag orchestration, large streaming imports, and automatic materialization of native LeRobot video features. On this macOS host, importing LeRobot emitted a duplicate FFmpeg Objective-C class warning from its installed PyAV/Homebrew libraries; the tested numeric/reference pipeline completed successfully. Video decoding was not exercised.
