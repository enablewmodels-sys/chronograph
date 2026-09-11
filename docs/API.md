# HTTP API — Community 0.4 alpha

The service and built UI share one origin. Default: `http://127.0.0.1:8080`.
All `/v1` and `/mcp` requests require `Authorization: Bearer <token>`.
There are no browser sessions, cookies, CSRF tokens or login/password endpoints.
The console retains its bearer token only in memory and disconnects on reload.

Host must match `CHRONOGRAPH_ORIGIN`; any supplied Origin must also match exactly.
The proxy preserves Host. No CORS or forwarded-host trust is enabled. Remote
connections require an HTTPS origin. Responses are private and `no-store`.

## Scopes

| Scope | Permissions |
|---|---|
| `read` | Graph queries, stats, identity, sampling, Arrow export |
| `ingest` | Read plus nodes, edge versions, invalidation, synchronization, fork creation, merge and discard |
| `admin` | Ingest plus credential management, demo loading and backups |

Scope covers an entire workspace. Revocation/expiry blocks subsequent requests,
including established MCP clients. Already authorized work can finish.

## Request contract

Send JSON objects with `Content-Type: application/json`. IDs, revisions, counters
and signed microsecond timestamps are decimal **strings**. `kind` is a JSON u16
integer; `limit`, `k` and token expiry days are bounded JSON integers. Unknown
argument fields are rejected. Payloads are exactly 32 hex characters (16 bytes),
defaulting to zero. Open end is `"9223372036854775807"`.

| Method / path | JSON input | Result |
|---|---|---|
| GET `/v1/info` | — | Version, edition, current scope, limits, MCP URL |
| GET or POST `/v1/stats` | `{}` for POST | Counts, log bytes, revision, default durability |
| POST `/v1/edges` | `{"edges":[{"src":"1","dst":"2","kind":1,"valid_from":"1000000"}],"durability":"fsync"}` | Input-order IDs, revision, durability |
| POST `/v1/nodes` | `{"id":"1","durability":"fsync"}` | Register an isolated identity; repeated registration is a no-op |
| POST `/v1/invalidate` | `{"id":"0","t":"2000000","durability":"fsync"}` | Shorten a stored version without deleting history |
| POST `/v1/as_of` | `{"t":"1500000","limit":100}` | Versions active at t |
| POST `/v1/between` | `{"start":"0","end":"2000000","limit":100}` | Nonempty versions overlapping `[start,end)` |
| POST `/v1/history` | `{"limit":100}` | All stored versions, including superseded empty intervals |
| POST `/v1/neighbors` | `{"node":"1","t":"1500000","limit":100}` | Active outgoing relationships |
| POST `/v1/sample` | `{"nodes":["1"],"t":"1500000","k":10,"strategy":"uniform","seed":"42"}` | One `samples` entry per input node, containing edges |
| POST `/v1/get_edge` | `{"id":"0"}` | One version, even when inactive |
| POST `/v1/contains_node` | `{"id":"1"}` | Identity existence, including isolated nodes |
| POST `/v1/sync` | `{}` | Disk synchronization checkpoint |
| POST `/v1/export_arrow` | `{"t":"1500000"}` | Arrow IPC stream; six nonnullable columns |
| POST `/v1/backup` | `{}` | Synchronized archive ID, revision, file count and size |
| GET `/v1/backups` | — | Completed local archives |
| GET / DELETE `/v1/backups/{id}` | — | Stream tar download / delete local archive |
| GET `/v1/tokens` | — | Token metadata, never hashes or secrets |
| POST `/v1/tokens` | `{"name":"research","scope":"read","days":30}` | One-time token and public metadata |
| DELETE `/v1/tokens/{id}` | — | Persisted revocation |
| POST `/v1/load_demo` | `{"durability":"fsync"}` | 8 synthetic nodes / 40 versions, empty workspace only |

Compatibility names within `/v1`: `add_edges`/`ingest_edges` → `edges`,
`add_node` → `nodes`, `invalidate_edge` → `invalidate`, `sample_neighbors` →
`sample`. `/v1/query` also accepts `mode: as_of|between|history|neighbors|sample`;
its legacy single-node sample form uses `node`, `k`, `strategy`, `seed` and `limit`.
Old `/api/*` cookie/password endpoints return 404.

## Branches and bounded intervals

Add optional `fork` to graph reads/writes, sampling, identity checks and Arrow export to select an active fork. Omission selects the parent. Edge IDs are local to that selection. Each input edge also accepts an optional `valid_to` decimal string, committed atomically with its start. Stats expose both the global `revision` and `parent_revision`, plus `active_forks`.

POST `/v1/fork`, `/v1/forks`, `/v1/fork_info`, `/v1/preview_merge`, `/v1/merge` and `/v1/discard` manage durable branches. Preview is read-only; creation, merge and discard require ingest/admin scope. See [complete branch API, merge rules, mappings and limits](BRANCHES.md#http-and-mcp). All graph mutation invalidates existing pagination cursors, including branch mutations. No operation silently falls back to the parent when a fork is unknown or closed.

## Time, pages and durability

An edge is active at `valid_from <= t < valid_to`. Late arrivals fit between
versions and truncate an active predecessor. Equal starts use the last insertion.
Explicit invalidation never extends a version. See [temporal semantics](TUTORIAL.md).

Page responses contain `edges`, `count`, `next_cursor`, `revision`, `mode` and
`duration_ms`. Submit the **same query and limit** with the returned cursor string.
A null cursor ends the query. Any graph revision or query change returns 409;
restart from page one. Cursors are not authorization credentials. Pagination is
revision checked, not a retained transaction across HTTP calls. Queries default
to the schema setting (initially 100); as-of t defaults to `"0"`. Between requires `start < end`.

Mutations use the schema durability setting, initially **buffered**. Set `"durability":"fsync"` for acknowledgement
after disk synchronization. Responses label the actual policy and revision.
`sync` and `backup` always synchronize. The console explicitly sends fsync for
writes. Buffered acknowledgements can be lost before a sync. A timeout or I/O
error can have an uncertain outcome; do not automatically retry insertions.
Edge insertions have no idempotency keys. Schema migrations use tracked IDs and checksums. Reopen a writer after ambiguous I/O failure.

`duration_ms` covers graph lock wait and operation/result construction inside the
blocking task. Admission queue wait, HTTP/MCP serialization and network transfer
are excluded. [Client latency evidence](TESTING.md) measures full parsed responses.

## Bounds and errors

- 4 MiB streamed request limit; atomic batches of 1–10,000 versions.
- 1–1000 rows per page. Batch sampling: 1–1000 nodes, k 0–1000, nodes × k ≤1000.
- 8 blocking workers and 32 waiting jobs; excess work returns 503. A queued job
  waits at most 30 seconds. Cancellation releases waiting admission permits;
  running disk work retains its permit until it finishes.
- 2 concurrent Argon2 jobs; 120 uncached/invalid attempts per rolling minute.
  Successfully verified credentials are cached in memory with active-record and
  expiry checks on every request. Each token allows 12,000 requests per minute.
- 100 token records; expiry 1–365 days. Revoke expired entries to free capacity.
- 3 local archives, at most 100 GiB / 10,000 files each. Sidecars must be regular
  files inside `sidecars/`. HTTP Arrow export accepts at most 1M stored versions.

Application errors use `{"error":{"code":"CONFLICT","message":"…"}}`.
400/422 invalid input, 401 unauthenticated, 403 forbidden, 404 missing object,
409 stale cursor or conflict, 413 body too large, 429 rate limited, 503 unavailable,
500 internal failure. 429 and 503 include `Retry-After: 60`. Unsupported methods
can return the router's 405 response. Health endpoints are public but validate Host:
`/healthz` checks liveness; `/readyz` attempts the graph read lock and can return 503
while writes are active. Neither checks free space or full journal integrity.

## Schema management

The console, HTTP API and MCP support relation definitions, typed payloads, service settings and versioned JSON migration files. See [schema and migrations](SCHEMA.md) for all five schema endpoints, file examples, permissions and compatibility limits. `edges` accepts a `properties` object instead of raw `payload` when a definition exists.
