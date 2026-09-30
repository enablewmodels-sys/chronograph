# Embedded and local quickstart

Using the hosted service? Start with the [Managed quickstart](HOSTED.md) for
GitHub/email login, projects, API keys and secrets. The instructions below are
for local Community development. Use the [isolated deployment guide](ISOLATED.md)
and [production operations](PRODUCTION.md) for an independently operated service.

ChronoDB Community runs embedded in Rust or as a single-workspace service with
a console and MCP. The service remains a preview pending the release gates.

## One command

Requires **Rust 1.93+** and **Node 20.19+ or 22.12+**. From the workspace root:

```sh
./scripts/quickstart.sh
```

That script builds the console and the server, mints an admin token if you do not
have one, and serves the console. It prints the console URL and the path of the
token file. Read the token locally and paste it into the sign-in page. Nothing is
downloaded beyond the dependencies the build already declares, and no existing
workspace or credential file is overwritten. Stop the service with Ctrl+C.

Useful environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHRONOGRAPH_BIND` | `127.0.0.1:8080` | Listen address |
| `CHRONOGRAPH_DATA` | `./community-data` | Workspace directory holding `graph.cgraph` |
| `CHRONOGRAPH_AUTH` | `./config/auth.json` | Credential file, deliberately outside graph data |
| `CHRONOGRAPH_TOKEN_FILE` | `./config/admin.token` | Where a newly minted token is written |
| `SKIP_BUILD=1` | unset | Reuse existing build output instead of rebuilding |

The first run compiles a release build, which takes a few minutes. Later runs
with `SKIP_BUILD=1` start immediately.

## Or do it by hand

The same steps, if you would rather run them yourself or want to see each stage:

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
"Explore synthetic preview" needs no backend and never writes to a database.
It is visibly labeled and does not display fabricated latency measurements.

## Load your own data

`chronograph-server import` reads one CSV file and appends edge versions to the
workspace. Every row is parsed and validated before the journal is opened, so a
file rejected by validation writes nothing and leaves an existing journal
byte-identical.

```sh
./target/release/chronograph-server import examples/episodes.csv
```

The columns are `src,dst,kind,valid_from[,valid_to][,payload]`:

- `src`, `dst` — decimal node identifiers. Nodes are created as needed.
- `kind` — decimal relationship type in `0..=65535`.
- `valid_from` — inclusive start, microseconds since the Unix epoch.
- `valid_to` — optional exclusive end. Empty means the interval is still open.
- `payload` — optional hex, an even number of digits up to 32 (16 bytes).
  Empty means sixteen zero bytes. Longer or odd-length values are rejected rather
  than reinterpreted. See [schema and migrations](SCHEMA.md) for typed properties.

A first row whose first field is `src` is treated as a header. Blank lines and
lines starting with `#` are ignored. Fields may be double-quoted. Rows are
applied in sorted order, so the resulting intervals do not depend on the order of
lines in the file. Re-running an import appends again; it does not deduplicate.

A small sample is included: `examples/episodes.csv` records six relationship
versions for an agent observing and acting on objects. Import it, then query
`2000000` microseconds to see four active relationships. This is a different,
smaller dataset from the one the console's **Load sample** button writes below.

Like `restore` and `migrate-*`, import opens the workspace for exclusive writing.
Stop the service first: a running server holds the journal lock and the import
fails with a lock error rather than competing for the writer. There is no HTTP or
MCP import endpoint, and no importer for any other database format yet — see
[known limits](LIMITATIONS.md).

## A five-minute tour

1. With an admin token, load the sample into an empty workspace: eight nodes,
   forty versions over five moments.
2. At `2000000` microseconds, inspect eight active relationships. Try `-1` to
   see the empty earlier state. Use Between for overlapping versions.
3. Fork the graph state into a branch, write a different relationship there, and
   compare it with the parent. See [durable branches](BRANCHES.md).
4. Write one relationship or a batch. The console requests fsync explicitly.
5. Create a read-scoped machine token and configure [MCP](MCP.md).
6. Create, download and [restore a backup](OPERATIONS.md) into a separate directory.

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

The embedded default and an unconfigured local service default are buffered.
Managed and production deployments enforce fsync with `CHRONOGRAPH_REQUIRE_FSYNC=true`. The embedded `OpenOptions`
can select `Durability::Fsync`; API writers select per request. Use `sync()` or
`close()` for an error-reporting checkpoint. Drop synchronizes best effort only.

## Frontend development

`npm --prefix ui run dev` binds to loopback. Its `/v1` proxy targets port 8080 and
rewrites Host/Origin for development. Or open the synthetic preview without a
service. Production serves the built UI and API together from one origin.

## Windows

`scripts/quickstart.sh` is a POSIX shell script. On Windows, run the manual steps
above from a shell that has `cargo` and `npm` on `PATH`, or use WSL. Native Windows
SDK clients are exercised in CI; see [testing](TESTING.md).

Continue with [API](API.md), [temporal tutorial](TUTORIAL.md), [comparison and alternatives](COMPARISON.md),
[security](SECURITY.md), [operations](OPERATIONS.md), [testing](TESTING.md) and [limitations](LIMITATIONS.md).
