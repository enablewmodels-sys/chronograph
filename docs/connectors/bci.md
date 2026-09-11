# BCI and neural streams

`chronograph-conn-bci` ingests complete float32 channel frames through the public engine API. This is an acquisition adapter; it does not decode intentions or provide a device-specific control loop.

## Mapping

Use `examples/datasets/bci/mapping.toml`. Reserve its node range and edge kind for this stream. Channel `c` is source `channel_base + c`; `stream_node` is the destination. Each acquisition creates one version per channel. The 16-byte payload is little-endian `(value: f32, channel: u32, sequence: u64)`. Values must be finite. Timestamps are signed microseconds below `i64::MAX` in the explicit `clock_domain`; the engine does not convert clocks. `as_of(t)` returns the latest active version per channel. Late arrivals follow the engine's interval truncation rules.

`ingest` validates an entire batch before changing the graph, accepts at most 500,000 scalar observations, and leaves the sync boundary to the caller. Use `Graph::sync()` before acknowledging a durable acquisition batch or open with `Durability::Fsync`.

`export_epoch(graph, mapping, start, end)` selects **acquisition timestamps** in `[start,end)`, including corrections and equal-time arrivals, sorted by time, sequence, channel and edge ID. Its Arrow columns are `edge_id: u64`, `sequence: u64`, `timestamp_us: i64`, `channel: u32`, and `value: f32`. Schema metadata carries the full mapping, including unit and clock domain. This differs from an interval-overlap query: a sample acquired before the epoch is not exported merely because it remains active. `write_epoch` writes a new synchronized Arrow IPC stream and refuses to overwrite an existing path.

## Synthetic acquisition

```sh
cargo run --locked -p chronograph-conn-bci --example bci_connector
cargo test --locked -p chronograph-conn-bci
```

The deterministic simulator produces multi-channel waveforms without sleeping or contacting hardware. It is bounded to one million scalar observations. The committed fixture includes four frames; the round-trip test inserts them out of order, reopens the journal and compares every exported scalar and timestamp to the source.

## Live LSL

Enable `--features lsl` on this crate. A C++ compiler and CMake are required. The pinned `lamquant-lsl` 0.1.2 binding fork bundles liblsl 1.16.2; the original `lsl` 0.1.1 fails to compile with Apple Clang 17. The compatible fork was built and its native transport tested on this Apple Silicon host. See the [binding source](https://github.com/Quitetall/liblsl-rust) and [LSL clock guidance](https://labstreaminglayer.readthedocs.io/info/time_synchronization.html).

Set `clock_domain = "lsl_local"` and a unique `lsl_source_id`. `live::Input::connect(mapping, timeout_seconds)` resolves that source and verifies channel count, float32 format and nominal sample rate. `read(count, timeout_seconds)` applies LSL's time correction to convert the provider's timestamp to the receiving machine's LSL clock. It does **not** convert to Unix time. Each call refreshes the correction. No partial batch is returned on timeout or malformed data; earlier samples may already have been consumed by LSL, so acquisition software must report/reconcile gaps rather than silently retry as though nothing was read. Sequence numbers are local to this Input instance and restart at zero after reconnection.

Run the native synthetic transport test explicitly:

```sh
LSLAPICFG="$PWD/examples/datasets/bci/lsl-loopback.cfg" \
  cargo test --locked -p chronograph-conn-bci --features lsl \
  --test lsl_loopback -- --ignored --nocapture
```

This test discovers a synthetic source, receives 32 four-channel frames over native LSL sockets, checks their values and exports 128 graph versions to Arrow. The config limits discovery to the local machine. The test is ignored in the default suite because it needs local socket discovery; CI can opt in. Real EEG/BCI devices, cross-host synchronization, long-running loss behavior and Windows/Linux LSL builds remain PENDING. Configure network access to the source according to the LSL deployment; the connector does not add authentication to the LSL protocol.
