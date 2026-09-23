# Connector platform — 0.4 alpha

This alpha adds a shared registry, generated migrations, typed binary assets and resumable normalized ingestion. It connects processes you run: it does not host model inference, connect to a QPU, synchronize devices or execute uploaded code.

## Configure in the console

Open **Schema & migrations → Migrations**. Choose **Family → Connector / model → Version / preset**, enter a unique instance name and unused relation kind, and choose the source clock. Optional fields define channels, units, topics, modalities and exact tensor shapes. Generate the migration, inspect its JSON, preview it, and apply it with an admin credential.

The server checks both catalog definitions and stored main/active-branch kinds. Migration version 2 atomically publishes the relation definition and connector binding in the catalog. A binding is immutable: change incompatible configuration by creating a new instance and relation kind. Existing version-1 migration serialization/checksums remain unchanged. Arbitrary SQL, Python and shell code are not migration operations.

**Connectors** lists configured instances and offers asset upload, normalized record submission, checkpoint inspection and source-record export. Read-only credentials can inspect these resources; ingestion requires ingest/admin scope. Configuration changes require admin scope.

## What the presets mean

The registry contains 36 normalized presets across 18 connectors. Retrieve the authoritative catalog through `POST /v1/connector_catalog` or the MCP tool with the same name.

| Connector | Presets | Local integration boundary |
|---|---|---|
| JEPA | I-JEPA, V-JEPA 1, 2, 2-AC, 2.1, JEPA-WMs | Python NumPy/PyTorch output adapter; latent tensors and explicit checkpoint provenance. No weights or inference are loaded. |
| H-JEPA | hierarchical-v1 | Generic coarse-to-fine latent levels with parent node IDs and horizons. No single upstream H-JEPA implementation is assumed. |
| Gymnasium, Minari | transition-v1, episode-v1 | Multimodal observation tensors, structured actions, reward and separate termination/truncation flags. The existing Minari CLI remains limited to its documented complete-state codec. |
| LSL | signal, marker, gap | Normalized signal tensors, string markers and explicit loss records; existing optional Rust LSL acquisition remains separate. Automatic reconnect integration with the new spool is still pending. |
| MNE | eeg-v1 | Python local EDF/BDF/FIF reader, chunked MNE Raw access. Requires optional MNE. Configure channels and SI units explicitly. |
| LeRobot | v3-records, v2.1-records | Adapter consumes an already opened official dataset, including decoded image tensors. Native v2.1 conversion and MP4 shard export are not implemented by this transport. |
| ROS 2 / MCAP | JointState, Image, CompressedImage, Imu, Odometry, TF | Normalized message records. Existing Rust bag decoding supports JointState; the other native message decoders remain pending. |
| OpenQASM | source, calibration | Opaque source retention or normalized calibration records. Existing strict static unitary parser remains separate. |
| Qiskit | circuit, result | Official OpenQASM exporter and Result count/provenance adapter in the local process. Unsupported source export raises an error. |
| Cirq | circuit, result | Official JSON serialization retained as an opaque asset and exact measurement tensors. No server-side Cirq deserialization. |
| Custom | record-v1 | User-defined normalized records, named tensor/media assets and temporal relations. |

Upstream references: [Meta V-JEPA](https://github.com/facebookresearch/vjepa2), [Minari standards](https://minari.farama.org/main/content/dataset_standards/), [LeRobot v3](https://huggingface.co/docs/lerobot/lerobot-dataset-v3), [MNE readers](https://mne.tools/stable/generated/mne.io.read_raw_fif.html), [Qiskit OpenQASM](https://quantum.cloud.ibm.com/docs/en/api/qiskit/qasm3). Preset compatibility refers to the normalized contract, not certification of every upstream version or physical device.

## Request contract

All operations use authenticated JSON POST requests under `/v1/`, or equivalent named MCP tools. IDs, microsecond timestamps and sequence numbers are decimal strings.

```json
{
  "instance": "my_model",
  "partition": "camera_left",
  "sequence": "0",
  "records": [{
    "src": "1", "dst": "2", "timestamp_us": "1000000",
    "episode": "episode_1",
    "assets": {"latent": "32_hex_characters_from_asset_put"},
    "fields": {"checkpoint": "model_repository@commit/checkpoint_sha256"}
  }]
}
```

Send this to `connector_ingest` after uploading referenced assets. A record may include `valid_to`; omitted means the open-end sentinel. Timeline insertion still shortens predecessors and respects successors. Acquisition timestamps may arrive late; transport sequence remains contiguous.

Each batch holds 1–500 records and at most 2 MiB of normalized JSON, referencing at most 64 distinct assets. Configured tensor shapes are enforced. JEPA requires a `latent` tensor and `checkpoint` field; H-JEPA adds `level`, `parent_node` and `horizon_us`. Transitions require `action`, finite `reward`, `terminated` and `truncated`. Signal records require a signal tensor whose first axis matches configured channels, with one unit per channel. A circuit/source preset requires an opaque `source` asset. Other domain-specific fields remain producer responsibilities in this alpha.

The receipt includes instance, partition, sequence, SHA-256 request digest, first edge, count, original revision and `durability: fsync`. Read it with `connector_checkpoint`, and retrieve an exact source record using `connector_record` with an edge ID. Generic graph queries return the sidecar encoding/reference as bounded properties; reference bytes are never interpreted as numeric properties. Raw `add_edges` cannot write a connector relation kind.

## Retry and crash behavior

1. Validate and synchronize immutable assets.
2. Publish a checksummed Arrow batch of source records.
3. Append graph versions and the checkpoint in one journal-format-3 frame.
4. Synchronize the journal, publish the in-memory state, acknowledge.

A new source/partition starts at sequence zero. Only the next sequence is accepted. An identical retry of the latest batch returns its original receipt and creates no versions. Reusing that sequence with changed content, skipping a sequence or retrying an older batch fails with HTTP 409. The service computes the digest from the normalized request; callers of the embedded Rust API must supply a digest that binds their complete input.

There are at most 4096 partition checkpoints per workspace. The latest receipt for each partition is retained in memory; journal history remains append-only. A torn frame recovers neither half a batch nor half a checkpoint. An ambiguous write/fsync failure poisons that graph handle: reopen and retry the identical request. Assets published before an aborted graph commit may remain unreferenced. This alpha has no online asset garbage collector; do not delete sidecars based only on current graph visibility.

Connector ingestion targets the main graph. Connector records can be inherited by a branch, but there is no branch-specific normalized ingestion endpoint yet. Existing raw graph operations retain their original retry semantics.

## Binary assets and tensors

`asset_put` accepts `metadata` and `data_hex`, up to 1 MiB decoded. Metadata version 1 contains `kind`, `encoding`, optional `dtype`, `shape` and a bounded string provenance map. Tensor encoding is `raw_le`: contiguous row-major little-endian bytes. Supported integer types are signed/unsigned 8, 16, 32 and 64 bit; floating types are f16, bf16, f32 and f64; bool uses 0/1 bytes. Exact NaN/Inf tensor bit patterns are retained. Inline numeric graph properties continue to require finite floats.

Shape rank is at most 8; dimensions cannot be zero. An empty shape represents one scalar. Shape × dtype size must match the supplied bytes exactly. `image`, `video`, `audio` and `opaque` assets retain bytes and a declared encoding with no tensor dtype/shape. The server does not decode or execute them.

For larger assets, upload immutable `opaque`/`chunk_v1` pieces of at most 1 MiB, then call `asset_compose` with the final metadata and ordered chunk IDs. Up to 16 chunks/16 MiB can be composed. Retrying chunk uploads or composition is safe and reuses existing content. `asset_get` returns verified metadata; `content: true` returns a byte range as hex, with `offset`, `limit` (≤1 MiB) and `next_offset` for continuation. The Python client handles composition and ranged downloads automatically. Split larger videos/recordings into explicitly described segments.

Assets live under `sidecars/assets-v1`; normalized Arrow records live under `sidecars/records-v1`. Asset IDs are 128-bit SHA-256 prefixes; full SHA-256 checksums are stored and checked on every read. Publication never overwrites a colliding or corrupt existing file. Existing connector Arrow sidecars and their 96-bit-prefix-plus-row references remain supported.

## Python client and outbound agent

Install the dependency-free transport into your own environment:

```sh
python -m pip install ./sdk/python
```

```python
from pathlib import Path
from chronograph_connectors import Client, Spool
from chronograph_connectors.adapters import jepa

client = Client("http://127.0.0.1:8080", Path("config/admin.token").read_text().strip())
# latent is an output from your existing NumPy/PyTorch model process.
row = jepa(client, latent, checkpoint="repo@commit/weights-sha256",
           src=1, dst=2, timestamp_us=1_000_000)
with Spool("./model-spool", "my_model", "camera_left") as queue:
    queue.enqueue([row])
    queue.drain(client)
```

Use an ingest-scoped credential for unattended producers. The client requires HTTPS for remote origins, does not follow redirects, bounds requests/responses and never puts credentials in the spool. Optional model/EEG/quantum dependencies belong to your local runtime.

```sh
chronograph-agent enqueue --spool ./model-spool --instance my_model --input records.jsonl
chronograph-agent run --spool ./model-spool --instance my_model --token-file config/ingest.token
chronograph-agent pause --spool ./model-spool --instance my_model
chronograph-agent resume --spool ./model-spool --instance my_model
chronograph-agent cancel --spool ./model-spool --instance my_model
chronograph-agent status --spool ./model-spool --instance my_model
```

The Linux/macOS agent uses a private SQLite queue with FULL synchronization, a 64 MiB pending-body bound and an exclusive drain lock. Network failures retain exact queued batches and use exponential backoff, capped at 30 seconds. Rejected records and authorization conflicts stop the run for operator correction. Pause/cancel stop subsequent requests; an in-flight request can still commit. Cancel retains pending/uncertain records and all acknowledged graph data. Resume is explicit. The last 1000 local receipts remain inspectable in SQLite.

Use a fresh spool per instance/partition. When attaching a fresh spool to an existing partition, read its server checkpoint and set `--start-sequence` to the next value before enqueueing. Two independent spools must not claim the same partition. CLI JSONL enqueue is chunked by record: earlier lines stay queued if a later line is invalid. Asset uploads happen before enqueue; repeat content-addressed uploads after an interrupted acquisition. Offline acquisition of not-yet-uploaded binary assets is still pending.

## Upgrade and operational limits

See [format-3 upgrade](UPGRADE_0_4.md). Backups include journal/checkpoints, catalog/bindings and both sidecar namespaces; credentials stay separate. Restore validates checksums and catalog history before exposing a new destination. Restoring a format-2 backup upgrades its staged copy, preserving the archive.

This is a Community alpha, not a completed managed release. Hosted invitations/auth/provisioning, remote agent job control, automatic LSL reconnection, full ROS message readers, LeRobot video export, asset GC and hardware compatibility certification remain in the implementation ledger. Request-size limits and worker queues are bounded; disk quotas must still be enforced by the deployment volume.

## Additional alpha.3 producers

The catalog now includes BrainFlow signal chunks, Q# source/results, portable quantum counts/observables, named model tensors and physical-AI transitions. These entries appear automatically in the migration dropdowns. See [platform recipes and verification boundaries](INTEGRATIONS.md) and the [multi-language clients](SDK.md). The alpha.2 binary release does not include these additions.

## Decision-model producers

[Jev and Laya](DECISION_MODELS.md) have separate Decision models entries in the
migration dropdown. Use `jev` for TypeSafe output and `laya` for Convai output;
both use `decisions-v1`. [Laya](LAYA.md) also preserves checkpoint and routing
metadata from your own inference runtime. Inference remains outside the database.
