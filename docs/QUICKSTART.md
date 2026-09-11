# Quickstart

Chronograph Community runs embedded in Rust or as a single-workspace service with
a console and MCP. The service remains a preview pending the release gates.

## Start locally

Requires Rust 1.93+, Node 20.19+ and npm. From the workspace root:

```sh
npm --prefix ui ci
npm --prefix ui run build
cargo build --locked --release -p chronograph-server
./target/release/chronograph-server admin create-token local-admin admin 90 config/admin.token
./target/release/chronograph-server serve
```

Open [the console](http://127.0.0.1:8080/login), read `config/admin.token` locally
and paste the token. The CLI writes a new mode-0600 token file and stores only
its Argon2id hash in `config/auth.json`. It refuses to overwrite an existing
output file. `community-data/graph.cgraph` holds graph data. Config must remain
outside graph data. There is no generated password or online password-reset flow.

The token stays in browser memory: reload or Disconnect clears it. Read scope
opens the explorer; ingest adds writes; admin manages tokens and backups.
“Explore synthetic preview” needs no backend and never writes to a database.
It is visibly labeled and does not display fabricated latency measurements.

1. With an admin token, load the sample into an empty workspace: eight nodes,
   forty versions over five moments.
2. At `2000000` microseconds, inspect eight active relationships. Try `-1` to
   see the empty earlier state. Use Between for overlapping versions.
3. Write one relationship or a batch. The console requests fsync explicitly.
4. Create a read-scoped machine token and configure [MCP](MCP.md).
5. Create, download and [restore a backup](OPERATIONS.md) into a separate directory.

SIGINT/SIGTERM gracefully synchronize and stop the service. Starting two owners
of one journal fails with a file-lock error. Existing version-1 journals require
an [explicit migration](OPERATIONS.md); startup never migrates your data silently.

## Embedded Rust

Add a path dependency on `crates/chronograph-core`, package `chronograph-db`.
The crate import is `chronograph_db`. Network/auth dependencies remain in the service.

```rust
use chronograph_db::{Graph, NodeId, EdgeKind};
let mut graph = Graph::open("world.cgraph")?;
graph.add_edge(NodeId(1), NodeId(2), EdgeKind(1), 1_000_000, [0; 16])?;
graph.sync()?;
for reference in graph.neighbors(NodeId(1), 1_500_000) {
    println!("{:?}", graph.edge(reference.id));
}
graph.close()?;
# Ok::<(), chronograph_db::Error>(())
```

Both embedded and service defaults are buffered. The embedded `OpenOptions`
can select `Durability::Fsync`; API writers select per request. Use `sync()` or
`close()` for an error-reporting checkpoint. Drop synchronizes best effort only.

## Frontend development

`npm --prefix ui run dev` binds to loopback. Its `/v1` proxy targets port 8080 and
rewrites Host/Origin for development. Or open the synthetic preview without a
service. Production serves the built UI and API together from one origin.

Continue with [API](API.md), [temporal tutorial](TUTORIAL.md), [security](SECURITY.md),
[operations](OPERATIONS.md), [testing](TESTING.md) and [limitations](LIMITATIONS.md).
