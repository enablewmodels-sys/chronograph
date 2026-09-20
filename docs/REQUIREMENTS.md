# Community release status

Community **0.4.0-alpha.2** is the first public source-available alpha prepared for
[this repository](https://github.com/enablewmodels-sys/chronograph). The
[release page](https://github.com/enablewmodels-sys/chronograph/releases/tag/v0.4.0-alpha.2)
is the source of truth for published binaries and checksums. It is an alpha with
documented limitations, not a managed-service launch or a production SLA.

The table below describes the current **alpha.3 development checkout**. Its multi-language SDKs and expanded catalog are distributed as source on `main`; alpha.2 downloads remain unchanged. No alpha.3 binary or package-registry publication is implied.

| Area | Delivered | Limit or remaining work |
| --- | --- | --- |
| Temporal engine | Directed typed relationships, valid-time history, late observations, ordered neighborhood indexes | History/indexes reside in RAM; no compaction or replication |
| Durable branching | Fork, conflict-checked merge, discard, replay and backup | One journal owner; application payload references remain opaque |
| Community service | Scoped expiring tokens, bounded API, HTTP MCP, native stdio bridge, local backups | One workspace per process; public TLS and official MCP client verified on the pilot; interactive agent-app checks remain separate |
| Schema and connectors | Visual designer, checksum migrations, 36 presets, 18 connector descriptors, typed assets, durable ingestion/checkpoint transactions | See connector-specific limits; descriptors do not imply every native format is decoded |
| Language SDKs and agent | Python, TypeScript/JavaScript, Java, C++, Go, Dart, C# transports; Q# Python host; durable Python spool and optional adapters | Source packages; physical hardware/QPUs and Windows remain unverified. See [SDK coverage](SDK.md) |
| Operational checks | Authenticated Prometheus metrics, writer readiness, enforced fsync option, read-only deployment probe | Host capacity, restore drills and off-host backup remain operator duties; see [production operations](PRODUCTION.md) |
| Browser console | Temporal queries, branches, schemas, connectors, access and operations; desktop/mobile tests | Public static demo is synthetic and read only |
| Packaging | Source, Apple Silicon native bundle, Python wheel, checksums, license and third-party inventory | Unsigned/not notarized; inspect CI before assuming Linux/container support |
| Public website | Static landing, full docs and synthetic demo; Vercel configuration | Owner imports and deploys repository in Vercel |
| Managed preview | Public TLS, GitHub/invited email accounts, MFA, project databases and roles, API/MCP routing, encrypted secrets, enforced fsync, protected metrics, graceful shutdown and scheduled local backups | Shared-host process isolation; email delivery, billing, automated off-host recovery, HA and SLA absent; see [hosted limits](HOSTED.md) |

## Evidence and compatibility

The 0.4 connector checks cover Rust tests, browser flows, real optional SDK
adapters, killed-process recovery, backup/restore and separately measured local
ingestion latency. The 10M-version engine benchmark remains the earlier workload;
its batch-insert and as-of targets were missed under recorded Low Power Mode.
See [testing](TESTING.md), [benchmarks](BENCHMARKS.md), [connector scope](CONNECTOR_PLATFORM.md)
and [known limits](LIMITATIONS.md). A passing build does not establish hardware
connectivity, public TLS safety or production throughput.

Storage format 3 requires an [explicit upgrade](UPGRADE_0_4.md) of format-2 data
into a separate destination. Preserve the source, auth configuration and previous
binary for rollback. No release step modifies an existing workspace.

The public tree contains Community code and sanitized evidence. Runtime graph
files, tokens, authentication stores, private planning material and Managed source
are excluded. [Licensing](LICENSING.md) describes the modification and competition
terms. [Website deployment](WEBSITE.md) separates static publication from hosting
a real database service.
