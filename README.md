# Chronograph

**An embedded temporal graph database in Rust. Replay a world, branch its future,
and carry the selected history forward.**

Community 0.4.0-alpha.3 (development checkout) stores directed, typed relationship versions with microsecond
validity and 16-byte opaque payloads. It runs inside a Rust application or through
an optional single-workspace service with a browser console and scoped MCP tools.
Domain adapters connect BCI streams, robotics recordings and world-model episodes;
quantum circuit/calibration support is exploratory.

This checkout is a **Community alpha**, **source-available under PolyForm Perimeter 1.0.0**. The new [connector platform](docs/CONNECTOR_PLATFORM.md) adds 36 migration presets, typed assets and durable ingestion receipts. Existing format-2 workspaces require an [explicit upgrade to a separate destination](docs/UPGRADE_0_4.md).
Modification and noncompeting commercial use are allowed; offering a competing product is restricted, including free competing products. See [licensing](docs/LICENSING.md).

[Source repository](https://github.com/enablewmodels-sys/chronograph) · [Download the alpha](https://github.com/enablewmodels-sys/chronograph/releases/tag/v0.4.0-alpha.2).
An invitation-only [hosted alpha](docs/HOSTED.md) is available with operator-issued tokens. Self-service accounts and billing are not implemented. See [release status](docs/REQUIREMENTS.md),
[known limits](docs/LIMITATIONS.md) and [edition boundaries](docs/EDITIONS.md).

To host the Community landing, documentation and read-only demo on Vercel, import this repository with its root directory unchanged. [Vercel setup](docs/WEBSITE.md). The Rust database runs separately on your own machine or server.

## Language SDKs

[Python, TypeScript/JavaScript, Java, C++, Go, Dart and C#](docs/SDK.md) share the authenticated API. [Q# uses a Python host bridge](docs/INTEGRATIONS.md); Rust applications can embed the engine directly. The SDK guide covers source installation, retry semantics and tested platform adapters. New SDK sources are on `main`; the linked alpha.2 release predates this expansion.

## Start locally

Requires Rust 1.93+, Node 20.19+ or 22.12+, and npm. Clone the Community repository, then build:

```sh
git clone https://github.com/enablewmodels-sys/chronograph.git
cd chronograph
npm --prefix ui ci
npm --prefix ui run build
cargo build --locked --release -p chronograph-server --bins
./target/release/chronograph-server admin create-token local-admin admin 90 config/admin.token
./target/release/chronograph-server serve
```

Open http://127.0.0.1:8080, read `config/admin.token` privately and paste it into
the console. The token is kept in browser memory and cleared on reload. Config
stays outside graph data; no password, cookie session or cloud account is needed.
Ctrl+C synchronizes and stops the service. No server starts during installation.
The [native bundle guide](docs/INSTALL.md) avoids compiler/Node requirements on a
matching prebuilt target. Download only the assets attached to the versioned GitHub release; no crates.io, PyPI or container-registry publication is assumed.

The console supports exact temporal queries, clickable graph inspection, durable
branches, bounded writes, Arrow export, expiring scoped tokens and local backups.
[Schema & migrations](docs/SCHEMA.md) adds a visual relation designer, typed payload
properties, importable JSON migrations, settings, preview/apply and tracked history.
The landing's synthetic preview works without a backend and is explicitly read only.

## Fork a world into 100 futures

```sh
cargo run --locked --release -p chronograph-conn-worldmodel --example fork_demo -- ./fork-demo
```

Use a new output directory. This example restores a full gridworld state and RNG,
runs 100 policies in parallel, persists every branch, verifies replay after reopen,
merges the best outcome, discards the others and exports the completed episode.
Simulation computation and serialized durable persistence are timed separately.
See [the measured demo](docs/BENCHMARKS.md).

## Embed the engine

Use a path dependency on `crates/chronograph-core`, package `chronograph-db`.
The import is `chronograph_db`; no published crate version is assumed.

```rust
use chronograph_db::{EdgeKind, Graph, NodeId, Result};

fn main() -> Result<()> {
    let mut graph = Graph::open("world.cgraph")?;
    graph.add_edge(NodeId(1), NodeId(2), EdgeKind(7), 1_000, [1; 16])?;
    graph.add_edge(NodeId(1), NodeId(2), EdgeKind(7), 3_000, [3; 16])?;
    graph.add_edge(NodeId(1), NodeId(2), EdgeKind(7), 2_000, [2; 16])?;
    assert_eq!(graph.as_of(2_500).edges().next().unwrap().payload, [2; 16]);

    let fork = graph.fork(3_000)?;
    // Forks inherit only the active state and freeze its ends open.
    let state = graph.fork_view(fork, 4_000)?;
    assert_eq!(state.export_arrow()?.num_rows(), 1);
    graph.discard(fork)?;
    graph.sync()?;
    graph.close()
}
```

A relationship is active when `valid_from <= t && t < valid_to`. A late observation
shortens its active predecessor and stops at its successor. Explicit ends and
invalidations preserve gaps. Equal starts keep superseded history as empty
intervals. Nodes are non-temporal identities; neighbors are outgoing. This is
valid-time history after corrections, without a second transaction-time axis.

`as_of(t)` creates a view; consuming it scans retained versions in O(E).
Neighborhood queries use ordered per-node indexes. Sampling supports latest-first
or seeded unbiased reservoir sampling. Arrow export copies six typed columns.
Queries borrow `&Graph`; writes require `&mut Graph`. One handle owns the journal.

Branches at the same parent revision/time share an immutable base. New versions,
new node IDs and inherited-end overrides remain isolated. Merge rejects changed
parents and conflicting pre-existing future observations, then commits atomically
and returns ID mappings. The engine never rewrites IDs inside opaque payloads.
See [branch semantics](docs/BRANCHES.md).

Both embedded and service writes default to buffered. Use `sync()`, `close()`,
`Durability::Fsync` or API `durability: "fsync"` for an error-reporting checkpoint.
The console requests fsync. Ambiguous failures can persist unacknowledged writes;
inspect state before retrying. Drop is best effort. [Storage format](docs/FORMAT.md).

## Connect your domain and agents

| Workflow | Delivered adapter | Guide |
|---|---|---|
| BCI | Synthetic frames, optional native LSL, typed Arrow epochs | [BCI](docs/connectors/bci.md) |
| Physical AI | Bounded JointState rosbag2/MCAP, referenced video, LeRobot datasets | [Robotics](docs/connectors/robotics.md) |
| World models | Versioned complete-state/RNG codec, durable rollouts, Minari/Arrow | [World models](docs/connectors/worldmodel.md) |
| Quantum experiments | Static unitary OpenQASM subset and bounded calibration windows | [Quantum](docs/connectors/quantum.md) |
| Coding agents | Authenticated MCP HTTP and native Rust stdio bridge | [Codex, Cursor and Claude](docs/MCP.md) |

Actual format/transport tests are distinguished from physical hardware, video
codec and interactive client-app validation. Raw sensor acquisition, model
training and robot control remain application responsibilities.

## Performance and evidence

The [benchmark report](bench/RESULTS.md) records the actual 10M-version workload,
hardware, durability, returned rows, raw samples and Criterion results. Targets
remain targets when missed. Service loopback latency is measured separately from
full engine traversals and from any future deployed TLS service. No Neo4j result
is invented when Docker is unavailable.

Final measured engine results: Apple M5, 10 workers, 16 GiB, Rust 1.93 release,
warm caches, AC Low Power Mode enabled; 100k nodes / 10M versions:

| Workload | Measured | Target / result |
|---|---:|---|
| Ordered batch insertion + final sync | 1.105M versions/s | ≥2M — missed |
| Ordered single insertion + final sync | 547k versions/s | ≥500k — passed |
| Fully consumed as-of p50 / p99 | 19.053 / 19.805 ms | p50 <10 ms — missed |
| LatestFirst / Uniform sampling | 27.69M / 24.74M returned edges/s | ≥5M — passed |

The earlier checkpoint was faster; its power state was not recorded. A controlled
baseline comparison remains open. Final sync is not per-edge fsync. HTTP first-page
p50 was 4.031 ms on a separate 100k-version loopback workload; see the full report
for sample counts, p95/p99 and durability. These are not cloud guarantees.

Verification includes randomized reference models, late/bounded intervals,
branch isolation, every byte boundary of new journal records, malformed replay,
ambiguous sync failures, killed-process restart, scoped auth, queue saturation,
backup/restore and twice-repeated desktop/mobile user journeys.

```sh
python3 scripts/check-phase.py phase-local
PROPTEST_RNG_SEED=4848215499434033153 cargo test --locked --workspace --all-features -- --test-threads=2
RUSTDOCFLAGS='-D warnings' cargo doc --locked --workspace --no-deps
# With cargo-audit, mdbook 0.5.3 and browser prerequisites installed:
bash scripts/verify.sh
```

## Documentation and operation

Start with [Quickstart](docs/QUICKSTART.md), [temporal tutorial](docs/TUTORIAL.md),
[architecture](docs/ARCHITECTURE.md), [HTTP API](docs/API.md) and [MCP](docs/MCP.md).
Operators should read [security](docs/SECURITY.md), [backup/restore and upgrade](docs/OPERATIONS.md),
[deployment](docs/DEPLOYMENT.md) and [testing](docs/TESTING.md).
`mdbook build` creates an offline manual in `target/book` using mdBook 0.5.3.

History and indexes are memory-resident; reopening replays the journal. There is
no compaction, replication, multiwriter ownership, SQL/Cypher query language,
Python engine binding or automatic retention in this version. Do not point two
services at one journal. Format-1 migration creates a separate destination and
preserves the source. Existing password/SHA credentials require fresh scoped tokens.

Future Community work is driven by measured workloads: compact history and indexes,
broader adapter schemas and stronger platform coverage. Managed planning adds
isolated hosted workspaces, GitHub teams, off-host recovery and Stripe billing
in a separate private platform. Those features are not part of this candidate.

[Contribute](CONTRIBUTING.md) · [Security reporting](SECURITY.md) · [Changelog](CHANGELOG.md)

Licensed under [PolyForm Perimeter 1.0.0](LICENSE), with required [notices](NOTICE).
This restriction means Community is source-available, not OSI open source.
Bundled third-party code retains its own license notices and dependency inventory.
