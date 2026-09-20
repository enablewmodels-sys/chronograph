# Verification

Current release checks are under `bench/reports/v0.4.0-alpha.2/`. Connector implementation evidence is retained under `bench/reports/v0.4.0-alpha.1/`; earlier engine and domain-adapter measurements are under `bench/reports/v0.3.0/`. Historical measurements do not establish new-version latency. The [release status](REQUIREMENTS.md) tracks remaining limits.

## Reproduce

```sh
python3 scripts/check-phase.py local-verification
npm --prefix ui ci
npm --prefix ui run build
cargo build --locked --release -p chronograph-server
node scripts/protocol-test.mjs
node scripts/schema-test.mjs
npm --prefix ui run test:e2e -- --headed
node scripts/service-latency.mjs
```

The phase runner saves exact build/test/Clippy/fmt output and exit status.
Protocol and browser tests create disposable workspaces and private tokens; they
never use `data/` or modify client-wide MCP configuration. Test servers stop on
completion. Temporary token metadata is in ignored `.work/`. Playwright traces
can contain disposable test secrets, so they stay in ignored `ui/test-results/`.
Do not publish traces without inspecting/redacting them.

The browser suite uses desktop Chromium at 1536×1024 and mobile Chromium at
390×664 (iPhone 13 device profile), repeats each journey twice and verifies real scope, query, write,
revocation, download and reload behavior. Synthetic mode is tested while `/v1`
requests are blocked. The Browser plugin was unavailable; the existing Playwright
workflow was used, headed. Screenshots are stored in `/tmp` for visual inspection.
The phase-7 redesigned UI passed all 16 runs (four journeys × two viewports × two repetitions). It includes isolated branch writes, selected-edge inspection, zoom/reset, merge preview/remapping, stale-parent rejection, discard/reload, clipboard commands, all 20 docs and architecture image, and connector navigation.

## Phase-3 service tests

Rust checks cover Argon2 cache/expiry/revocation, failed auth persistence, auth
locks, scope enforcement, exact u64 JSON, atomic validation, stale/query-bound
cursors, body limits, origin/host rejection, 8-worker/32-waiter saturation and
cancelled waiters. Backup tests retain sidecars, exclude unrelated credentials,
refuse occupied destinations and preserve invalid source archives.

The independent official JS MCP client checks initialization, tool discovery,
HTTP read/write, native Rust stdio forwarding, scope failure and revocation on an
existing client. Downloaded backups are restored into a second live service and
history compared. A killed process is restarted and fsync-acknowledged history
compared. These are protocol tests; app-specific Codex/Cursor/Claude UI sessions
remain separately labeled when not exercised.

## Final local service latency

Host: Apple M5, 10 logical cores, 16 GiB, macOS arm64, Rust 1.93, Node 20.20.2,
release binaries. The Mac was on AC power with Low Power Mode enabled; the host
was not isolated. 100,000 stored versions / 32,000 active at the query timestamp.
Loopback HTTP without TLS; full client response parsed. Twenty warmups per workload,
warmed verified-token cache. Raw samples and environment are in
`phase-8-release/latency-samples.csv` and `phase-8-release/latency.json`.

| Operation | Samples | Concurrency | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| HTTP stats | 500 | 1 | 0.324 | 0.404 | 0.562 |
| HTTP as-of first page (1000 rows) | 300 | 1 | 4.031 | 4.410 | 4.546 |
| HTTP uniform sample (16 edges) | 300 | 1 | 0.255 | 0.335 | 0.434 |
| MCP as-of first page (1000 rows) | 300 | 1 | 5.010 | 5.600 | 5.839 |
| HTTP as-of first page, 8 clients | 400 | 8 | 6.873 | 10.012 | 14.082 |
| MCP as-of first page, 8 concurrent requests | 400 | 8 | 8.681 | 11.638 | 15.218 |
| HTTP durable single insert | 200 | 1 | 4.006 | 4.810 | 4.965 |

These are page-level loopback timings, not complete 10M graph traversals or cloud
SLOs. Initial 100k ingest used buffered batches and a final sync: 216.331 ms,
462,255 versions/s including HTTP overhead. Only the last row requests per-write
fsync. Cold Argon2 verification and remote TLS have different costs. The master
brief's fixed preview label remains in CLI/health responses even though local
measurements exist. There is no production-hardening certification.

Earlier phase-3 checkpoints remain in their own directory. Final engine workloads
and missed performance targets are documented in [benchmark results](BENCHMARKS.md).


## Durable branches — Phase 5

`bench/reports/v0.3.0/phase-5/REPORT.md` records the whole-workspace gate (51 passed, 1 subprocess-only helper ignored), randomized fork/reference comparisons, every byte boundary of all six branch record types, ambiguous merge-sync recovery and malformed-record rejection. The 100-future release example restored 3158 branch records and the selected merged parent episode after reopening.

`CHRONOGRAPH_REPORT_PHASE=phase-5 node scripts/protocol-test.mjs` exercises branch permissions, exact IDs, bounded validity, scoped cursors, merge previews/remappings/retries/conflicts, native MCP calls, downloaded backup restoration, and SIGKILL/restart of parent plus branch state. Reports are phase-specific so the earlier checkpoint evidence remains unchanged. Those semantics are now also exercised by the final repeated browser journeys.


## Final Community gates

- Whole workspace: 51 passing tests, zero failures; one subprocess helper is ignored
  directly and invoked by its parent crash test. Build, Clippy with denied warnings,
  and fmt checks pass. The final randomized run uses seed 4848215499434033153.
- All features: 51 passing tests, zero failures, two opt-in helpers ignored; native
  LSL transport was separately exercised against a synthetic local outlet in phase 4.
  All-feature Clippy passes. Rustdoc with denied warnings passes after fixing an
  escaped interval in one quantum documentation comment.
- Browser: 16/16 passes, no skips/flaky retries, headed desktop/mobile Chromium.
- Protocol: all nine groups pass with the official JS SDK, native bridge, branch
  lifecycle, scope/revocation, independent restore and SIGKILL/restart.
- Audits: npm reports zero vulnerabilities; cargo-audit reports zero vulnerability
  advisories and one informational unmaintained `paste` 1.0.15 dependency via
  the robotics MCAP crate. No advisory suppression or blanket ignore was added.
- mdBook 0.5.3 builds; all 20 public chapters have valid local links. UI production
  build and formatting checks pass. Upstream license texts accompany all 423
  entries in the target-filtered workspace dependency inventory (including optional
  connector and development requirements, not a binary reachability claim).
- Native bundle smoke tests and clean-source inventory are recorded in the final
  report. Container/TLS and Linux runtime checks remain PENDING with the actual
  Docker timeout; prepared CI jobs have not been executed remotely.

Raw artifacts are retained in `bench/reports/v0.3.0/phase-8-release/`. Test-only
servers are stopped after each run. No existing runtime `data/` directory is used.

## Schema and migration verification

`CHRONOGRAPH_REPORT_PHASE=phase-schema node scripts/schema-test.mjs` tests the five schema tools through the official MCP client, read/admin boundaries, file CLI, exact typed values, backup restoration and abrupt restart. Rust tests cover layout overlap/ranges, invalid input, failed persistence, checksum drift, concurrent idempotency, stale previews, active-branch protection and real settings defaults.

The expanded browser suite has six journeys across two viewports, each repeated twice (24 runs). Schema journeys create a visual definition, import/export a file, review and apply, insert typed values, change settings, preserve drafts, reject stale previews, and check read-only controls. Evidence for this source extension is in `bench/reports/v0.3.0/phase-schema/`; the earlier `dist/v0.3.0` release candidate archives predate this feature.


## Polyglot SDK and alpha.3 connector verification

The [SDK guide](SDK.md) documents the reproducible language conformance suite and optional local runtime fixtures. Seven HTTP clients passed against the release server, including precision above 2^53, migration apply, asset bytes, durable receipts, conflict handling, auth scope, binary Arrow responses and controlled HTTP faults. Python/TypeScript bounded asset and pagination tests also pass. BrainFlow synthetic acquisition, LSL loopback and QDK Bell simulation were exercised; existing MNE, Qiskit, Cirq, PyTorch/JEPA and LeRobot tests remain passing. No physical device or QPU certification is claimed.

The migration catalog now has 35 presets. All were tested through migration, ingest, restart and independent backup restore. Three focused Rust tests enforce new signal axes, exact quantum counts and model-output provenance. The workspace all-feature suite and strict Clippy checks pass. The browser suite passed 24 desktop/mobile runs (each scenario twice), and the new SDK/integration docs passed eight viewport/repeat checks, including trailing-slash direct links.

Sanitized local evidence is in `bench/reports/v0.4.0-alpha.3/phase-sdk` in the source repository. Timing files describe one macOS ARM64 loopback run without TLS, not deployment guarantees. Package checks covered npm contents, a Python wheel, a .NET package and the allowlisted source archive; no package registry upload is implied.

## Hosted alpha and Jev — September 20, 2026

The current catalog has **36 presets across 18 connectors**. The Jev addition
passed Python/TypeScript validation tests, official TypeSafe SDK mock-transport
checks and actual hosted database ingestion through both example programs.
The server's 21 library tests passed on the ARM64 deployment host. The
[hosted alpha guide](HOSTED.md) describes the operational boundary.

Public TLS tests covered unauthorized access, Origin rejection, read-only scopes,
revocation, official MCP discovery, atomic ingestion retry, input/response asset
round trips and independent workspace restoration of an off-host-downloaded
backup. A six-hour local backup timer is installed and its service was exercised.
The Jev notebook and extracted download examples ran without service credentials.
Live Jev inference remains untested without a TypeSafe API key.

For a tiny synthetic graph over warm persistent public TLS, 30 serial samples
measured as-of p50 **172.620 ms**, p99 **228.367 ms**, and single Jev-record fsync
p50 **179.541 ms**, p99 **242.003 ms**. These include the operator's network path;
with this sample count, p99 is the maximum. They establish neither an SLA nor
production capacity. Sanitized evidence is under
`bench/reports/v0.4.0-alpha.3/phase-hosted/` in the source repository.

Public-browser QA passed two full rounds each at 1440×1000 and 390×844: banner,
docs/download, token connection, Jev migration selectors, reload logout, no
credential in browser storage and no console/runtime errors. Browser plugin was
unavailable; headed Playwright provided screenshots and interaction checks.

The private hosted backup job additionally passed four consecutive captures at
the three-archive limit, plus tests for failed-capture rollback and interrupted
rotation recovery. After the final release restart, data, checkpoints, token
revocation and fsync defaults persisted; a newly rotated archive was downloaded
off-host and restored successfully into a separate workspace.
