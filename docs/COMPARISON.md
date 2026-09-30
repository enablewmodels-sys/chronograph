# Comparison and alternatives

This page answers one question: why would you use ChronoDB instead of a database you
may already run? It compares ChronoDB Community 0.4.0-alpha.3 against PostgreSQL,
SQLite, DuckDB, Neo4j, Memgraph, XTDB, Dolt/Doltgres, TerminusDB, Kuzu/LadybugDB,
CozoDB, a plain Arrow or Parquet lake and an in-process hash map.

ChronoDB figures here come from this repository and are cited where they matter.
Competitor capabilities and licences describe each project's public documentation
and licence file at the time of writing; licences that differ by edition are marked
**approximate** rather than guessed. ChronoDB Community is source-available under
PolyForm Perimeter 1.0.0, not OSI open source, and it remains an alpha.

## The short answer

Choose ChronoDB when you are embedding a Rust process that must keep the valid-time
history of typed directed relationships, answer "what was true at `t`", and fork the
whole current state into isolated futures that you later merge or discard — all
in-process, with no server to operate. Choose something else when you need SQL or
Cypher, ad-hoc filters, aggregation or multi-hop traversal; when your data must
exceed RAM; when you need more than one writer, replication or high availability; or
when you expect to install the database from a package registry. Those are real
requirements that ChronoDB does not meet today, and the [known limits](LIMITATIONS.md)
say so in the same words.

## If you need this, use that

| Tool | What it is | Licence or model | When it beats ChronoDB | When ChronoDB beats it |
| --- | --- | --- | --- | --- |
| PostgreSQL | General-purpose relational server | PostgreSQL License, permissive and OSI-approved | SQL, MVCC transactions, extensions, replication and a mature operations ecosystem; almost always the safer default | You want an embedded library with no server, no connection pool and valid-time edge history without audit tables |
| SQLite | Embedded relational engine in one file | Public domain | SQL, decades of tooling, ACID transactions, runs everywhere including in-process | You need per-edge valid-time history and durable branches, and your application is already Rust |
| DuckDB | Embedded columnar analytics engine | MIT | Analytical SQL over CSV and Parquet, joins and aggregation, spill-to-disk for larger-than-memory scans | Your workload is point-in-time relationship state and branch-and-merge, not aggregation; ChronoDB keeps per-version history rather than columnar scans |
| Neo4j | Graph server with Cypher and an embedded JVM library | GPLv3 for Community Edition; Enterprise and Aura are commercial (**approximate** by edition) | Cypher, variable-length traversal, indexes for incoming edges, clustering in Enterprise, and a large tool ecosystem | You need valid-time history and branch/merge, must stay off a JVM, or want a small embedded library with no cluster and no server to operate |
| Memgraph | In-memory Cypher graph server | Business Source License 1.1, plus the Memgraph Enterprise License for some files | Cypher, streaming ingest, incoming-edge traversal, replication in Enterprise, and a supported product | You need durable version history and in-process embedding, and you need a licence without a competing-use restriction |
| XTDB | Immutable bitemporal SQL database | MPL-2.0, with commercial support from JUXT | SQL:2011 temporal queries over both system time and valid time, object-storage-backed storage that can exceed RAM, and a stable SQL API | You need branch/merge of database state, a Rust library rather than a JVM deployment, or a strict 16-byte payload model |
| Dolt / Doltgres | Versioned SQL database with Git-like remotes | Apache 2.0 | SQL, cell-level three-way merge with conflict resolution, clone/fetch/push distribution, MySQL or Postgres wire compatibility, and far more mature versioning tooling | Your history axis is application valid time rather than commit order, your model is a graph rather than tables, or you need the engine inside a non-Go process |
| TerminusDB | Collaborative document and RDF graph server with versioning | Apache 2.0 | WOQL and GraphQL query surfaces, branch/merge/rebase/reset over immutable layers, and a document/RDF data model with schema reasoning | You need per-edge valid intervals with corrections, an embedded Rust library, or fixed-size payloads with no server process |
| Kuzu to LadybugDB | Embedded property-graph library; Kuzu's successor | MIT | Cypher, vector and full-text search, a full relational-style optimizer, and columnar scans over large graphs; Kuzu itself was archived in October 2025 and LadybugDB continues it | You need valid-time history and durable branches, which neither project provides |
| CozoDB | Embedded Datalog database with graph, vector and full-text features | MPL-2.0 | A real query language (CozoScript Datalog), time-travel queries on eligible relations, and pluggable storage engines including SQLite, RocksDB and TiKV | You need fork and merge of a state, one canonical on-disk journal, or an authenticated service in the same project |
| Plain Arrow or Parquet lake | Files plus whatever engine reads them | Apache 2.0 | Cheap object storage, universal interoperability, and effectively unlimited scale with DuckDB, DataFusion, Spark or similar | You need indexed point-in-time queries and navigation without scanning files, plus branch and merge semantics |
| In-memory hash map | A `HashMap` in your own program | Your own code | Zero dependency, maximum speed, and exactly the API you wrote | You need durability, replayable history, valid-time queries, and branches that survive a restart |

Two related tools are worth naming for honesty. Milvus, Qdrant and pgvector solve
similarity search, which ChronoDB does not attempt at all; use them if that is your
problem. SQLite and DuckDB already appear above and cover most small embedded data
cases better than ChronoDB does.

Marks and licences for competitors are drawn from their public documentation and
licence files; where editions differ, treat the entry as approximate rather than
authoritative.

## Capability matrix

Legend: ✓ first-class and documented, ~ partial, limited or edition-dependent,
✗ absent. Marks describe the tool's core engine, not extensions or third-party
add-ons.

| Tool | Temporality and time travel | Branching and versioning | Embedded | Query language | Payload and property model | Scale | Distribution and install |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ChronoDB Community 0.4 alpha | ✓ valid time per edge version; `as_of`, `between` and `history` | ✓ durable fork, conflict-checked merge and discard; 256 active and 65,536 lifetime forks | ✓ Rust crate, in-process | ✗ no SQL, Cypher or query language; seven fixed read calls | ~ 16-byte inline payload with schema-catalog offsets for bool, u32/i32, u64/i64 and f32/f64; assets up to 16 MiB, not queryable | ✗ all history and indexes in RAM; 1M-version Arrow export cap; no compaction | ✗ no crates.io, PyPI or container-registry publication; source, Python wheel and Apple Silicon bundle |
| PostgreSQL | ~ none native; audit tables, triggers or extensions needed | ✗ | ✗ client library only | ✓ SQL | ✓ full rows, JSON and arrays | ✓ multi-terabyte with replication | ✓ packaged nearly everywhere |
| SQLite | ✗ | ✗ | ✓ | ✓ SQL | ✓ typed columns and JSON | ~ single writer, file-based | ✓ ubiquitous |
| DuckDB | ~ none in core; DuckLake adds snapshot-level time travel (**approximate**) | ✗ | ✓ | ✓ SQL | ✓ typed columnar and nested types | ✓ larger-than-memory analytical scans | ✓ many platforms and package managers |
| Neo4j | ~ temporal types, not versioned history; audit features vary by edition | ✗ | ~ embedded JVM library exists; usually a server | ✓ Cypher | ✓ labelled property graph | ✓ clustered in Enterprise | ✓ packages, containers and a managed service |
| Memgraph | ✗ | ✗ | ✗ server process | ✓ Cypher | ✓ property graph | ~ RAM-resident; replication in Enterprise | ✓ Docker image and packages |
| XTDB v2 | ✓ bitemporal system time and valid time, SQL:2011 style | ✗ no branch or merge of database state | ✓ JVM library, also standalone | ✓ SQL | ✓ documents and rows | ✓ object storage, can exceed RAM | ~ Maven and Clojure artifacts; no single native binary (**approximate**) |
| Dolt / Doltgres | ✗ commit history only, no valid time | ✓ Git-style branch, merge, diff and remotes with three-way cell merge | ✗ server and CLI | ✓ SQL in a MySQL or Postgres dialect | ✓ relational rows and JSON | ✓ terabyte scale with DoltHub or self-hosted remotes | ✓ binaries, Homebrew and Docker |
| TerminusDB | ~ commit-graph time travel; no per-edge valid intervals | ✓ branch, merge, rebase and reset over immutable layers | ✗ server with HTTP clients | ✓ WOQL and GraphQL | ✓ JSON and RDF documents | ~ bounded by server capacity | ✓ Docker image and binaries |
| Kuzu to LadybugDB | ✗ | ✗ | ✓ | ✓ Cypher | ✓ property graph with vector and full-text indexes | ~ depends on memory and disk layout | ~ Kuzu archived October 2025; LadybugDB is the active continuation |
| CozoDB | ✓ time-travel queries on relations eligible for them | ✗ | ✓ Rust with Python, Node and other bindings | ✓ CozoScript Datalog | ✓ relations, JSON and vectors | ~ set by the chosen storage engine | ~ crates.io, PyPI, npm and a single binary |
| Plain Arrow or Parquet lake | ~ versioning at file or dataset level only | ✗ | ✓ files only | ~ whatever engine you attach | ✓ columnar with nested types | ✓ object storage, effectively unbounded | ✓ universal |
| In-memory hash map | ✗ | ✗ | ✓ | ✗ | ~ whatever your struct holds | ✗ RAM-bound | ✓ part of your program |

## What ChronoDB does that none of these do

One combination is genuinely uncommon: **forking the current state of a live
database at an application-chosen microsecond, working in that fork as an isolated
database, and merging it back as one atomic and conflict-checked operation, inside
the process that owns the data.**

The details matter, because they are what differs from other versioned databases.

- A fork inherits only the versions active at its fork time, with their ends frozen
  open. Superseded versions and known future observations are excluded. Queries
  before the fork time are rejected, so a branch cannot silently read a state it did
  not inherit. See [branch semantics](BRANCHES.md).
- A merge requires an unchanged parent revision, rejects touched relationships that
  already had future information, validates twice (preview, then revalidate on
  commit) and writes one checksummed frame. It returns deterministic node and edge
  ID mappings to the caller. Payload bytes and sidecars are never rewritten, so
  applications that embed IDs in payloads must apply the mappings themselves.
- Branch edge IDs are local to their fork and must always be paired with that fork.
  Parent and branch edge ID `0` can identify different versions.
- The operation is tightly bounded, and the bounds are hard: 256 active forks, 65,536
  lifetime fork records, 80-byte names, a 64 MiB atomic frame for one edit or a whole
  merge, and 10,000 total node and edge mappings in an HTTP or MCP merge result.
  Larger eligible merges must use the embedded API.
- Forks sharing a parent revision and time share one immutable in-memory base; the
  first distinct base costs O(parent history + known nodes), and this release does
  not claim that arbitrary snapshots are O(1).
- It is all one Rust library. Reads borrow `&Graph`, writes require `&mut Graph`,
  and there is no server, no connection string and no separate version store.

Dolt and TerminusDB also branch, and both are more mature at it. The difference is
the axis and the packaging. Dolt branches tables: merge is cell-level three-way
reconciliation with explicit conflict resolution, and history is commit order over
relational rows, so it has no application valid-time intervals; it is a Go server and
CLI rather than an in-process library. TerminusDB branches immutable layers
of a document and RDF graph with rebase and reset, over a server you reach by HTTP,
and its time travel follows the commit graph rather than per-edge validity. ChronoDB
branches valid-time graph state at a chosen microsecond, validates a merge against a
captured parent revision, and does it in-process. XTDB has the richer temporal model
(system time and valid time, both) but no branch or merge of database state. CozoDB
has time-travel queries but no branches. Pick the axis you actually need; ChronoDB is
not a superset of any of them.

## Where ChronoDB loses today, and what we are doing about it

This list is deliberately blunt. [Known limits](LIMITATIONS.md) holds the full
detail, including every bound behind these statements.

- **The RAM ceiling.** All history and indexes are rebuilt in memory when the journal
  is replayed, and nothing is ever compacted. The 10M-version benchmark run peaked
  around 3.5-4.0 GB resident and reopened in 10.6-14.7 seconds. XTDB's object store
  and DuckDB's spill-to-disk do not have this shape. Compaction and retention are
  future work driven by measured workloads; there is no retention policy, history
  pruning or sidecar garbage collection today.
- **No query language.** The read surface is exactly `as_of`, `between`,
  `history`, `neighbors`, `sample`, edge-by-id and node existence — see the
  [HTTP API](API.md). There is no filter by kind or destination, no aggregation, no
  multi-hop traversal, no reverse or incoming index, and no query planner, so an
  aggregate means pulling rows into your own code. Every SQL and Cypher tool on this
  page wins here, and it is the most common reason to pick one of them instead.
- **Missed performance targets.** Ordered batch ingestion measured 1.105M versions/s
  against a 2M/s target, and a fully consumed as-of query measured 19.053 ms p50
  against a sub-10 ms target, on an Apple M5 with AC Low Power Mode enabled. Sampling
  passed its target. These numbers stay visible rather than being rounded up; see the
  [benchmarks](BENCHMARKS.md) and the raw results in `bench/RESULTS.md`.
- **One writer, one process, no MVCC.** A single handle owns the journal, an
  exclusive file lock prevents a second owner, and HTTP cursors are invalidated by
  any global mutation. There is no replication, no high availability, no
  shared-engine multi-tenancy and no retained transaction across paginated reads.
- **Packaging is not finished.** There is no crates.io, PyPI or container-registry
  publication; binaries are attached to a GitHub release, are unsigned and not
  notarized, and Windows remains unverified. PostgreSQL, SQLite, DuckDB and Dolt are
  one `apt`, `brew`, `pip` or `docker` command away.
- **Deployment safety is yours.** The service needs a reverse proxy for HTTPS
  remotely and supplies no at-rest encryption, quotas or automated off-host backup.
  One Community service owns one journal on one volume.

We are not asking you to trust a roadmap for any of these. Evaluate the alpha against
your own workload, and treat missing features as missing rather than planned.

## Migrating your data in

What exists today:

- **A CSV import verb.** `chronograph-server import FILE.csv` loads edge versions
  from one CSV file whose columns are
  `src,dst,kind,valid_from[,valid_to][,payload]`.
  The last two are optional: an empty `valid_to` means the interval is open and
  an empty `payload` means sixteen zero bytes.
  These are the same fields the edge API accepts: node IDs, a u16 kind, inclusive
  `valid_from`, exclusive `valid_to` and the 16-byte inline payload. An empty
  `valid_to` means the open end and an empty `payload` means sixteen zero bytes. A
  header row is optional and `#` lines are ignored. Every row is validated before
  anything is written, so a rejected file leaves the journal byte-identical. The
  import takes the exclusive journal lock, so stop the service first.
- **The HTTP and MCP write path.** `POST /v1/edges` and MCP `ingest_edges` accept
  batches with `payload` hex, or `properties` validated against a schema relation,
  and return the committed revision. Structured rows go in through
  [schema and migrations](SCHEMA.md) once a relation maps its property offsets. The
  service accepts at most 4 MiB per HTTP request, so large loads are batched.
- **Checkpointed connector ingestion.** The
  [connector platform](CONNECTOR_PLATFORM.md) takes normalized records in batches of
  1-500 and ships 38 presets across 20 connectors, resumable by sequence with a
  SHA-256 request digest and a durable receipt, so an interrupted load can be retried
  without duplicating versions. The [release status](REQUIREMENTS.md) table records
  the earlier 36-preset, 18-connector boundary for alpha.2.
- **Data out.** Arrow IPC export over HTTP or the embedded API, capped at 1M stored
  versions per request, plus consistent local backups that include the catalog and
  connector sidecars.

What does not exist:

- No SQL, Cypher or query-language importer, and no general ETL or data-transformation
  step inside the database. Migration files change definitions and settings; they
  never move or rewrite graph records.
- No automatic backfill job, no background transformation and no automatic sidecar
  garbage collection. A failed graph append can leave unreferenced asset files.
- No importer other than the CSV verb above: no Parquet loader and no database-dump
  reader is implemented.
- Retrofitting valid time onto data that never had it is your modelling decision.
  Timestamps are signed i64 microseconds in a clock domain you declare; there is no
  hidden device-clock conversion and no second transaction-time axis.
- Existing version-1 archives require an explicit migration to a separate destination
  that preserves the source, and format-2 workspaces need the explicit
  [0.4 upgrade](UPGRADE_0_4.md). Nothing migrates silently.

## Further reading

- [Embedded and local quickstart](QUICKSTART.md) — build the engine and the service.
- [Supported scope and known limits](LIMITATIONS.md) — every bound referenced above.
- [Durable branching snapshots](BRANCHES.md) — fork, merge, mapping and conflict rules.
- [Architecture](ARCHITECTURE.md) — storage, locking, service and sidecar layout.
- [Schema and migrations](SCHEMA.md) and
  [connector platform](CONNECTOR_PLATFORM.md) — typed payloads, presets and
  checkpointed ingestion.
- [Community and Managed](EDITIONS.md) and
  [licence and permitted use](LICENSING.md) — what the PolyForm Perimeter 1.0.0
  terms allow, and what they do not.

