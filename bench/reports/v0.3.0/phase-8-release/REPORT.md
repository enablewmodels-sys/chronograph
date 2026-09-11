# Chronograph 0.3.0 — Community release candidate

Community implementation and available local correctness checks are complete.
The result is a usable embedded engine and single-workspace service, with durable
branches, four domain adapters, a redesigned console, agent integration, docs and
installable local artifacts. **This is not a public or production-certified release.**
The final 10M run missed the batch-ingestion and as-of latency targets. Docker/TLS,
Linux runtime, signing and public publication remain open. Managed is blocked on
the agreed human review, before any control-plane or billing implementation.

## What was built

- Engine: checked format-2 append-only journal, ordered temporal indexes, explicit
  buffered/fsync durability, exclusive ownership, bounded validity windows,
  late/equal correction semantics, sampling and Arrow. Format-1 migration writes
  a separate destination and preserves its source.
- Durable forks: frozen active-state bases shared by parent revision/time, isolated
  deltas, per-fork queries/writes, conflict-aware merge preview, atomic merge,
  ID remappings, discard and retained lifecycle results after restart.
- Service: Axum/Tokio, versioned HTTP, exact string IDs/timestamps, scoped expiring
  Argon2id credentials outside data, revocation, rate/body/worker/queue bounds,
  exact Host/Origin checks, native Rust MCP bridge and consistent checksummed
  journal/index/sidecar backup with independent staged restore.
- Adapters: BCI simulation + optional native LSL; bounded JointState rosbag2/MCAP
  with video references and real LeRobot export; complete-state/RNG world models
  with real Minari and durable fork rollouts; exploratory static OpenQASM DAGs
  and bounded calibration windows. Each guide states its schema and limits.
- UI: light generated-artwork landing; dark explorer, parent/fork scope picker,
  selected graph/edge details, exact writes, branch lifecycle/merge inspection,
  connector workflows, scoped agent access, operations and 20 linked public guides.
- Release: MIT + Apache-2.0, changelog, security/contribution guides, offline mdBook,
  SVG/Mermaid architecture, positive package/build-context allowlists, relocatable
  launcher, SHA-256 manifests, SPDX 2.3 inventory and upstream license texts,
  prepared Docker/Compose bootstrap and native/verification CI jobs.

Main source paths: `crates/chronograph-core`, `crates/chronograph-server`, the five
connector/common crates, `ui/src`, `examples`, `docs`, `scripts/release`,
`scripts/container-smoke.py`, `Dockerfile`, `deploy/compose.yaml` and `.github/workflows`.
The final source archive is allowlisted and excludes runtime data, auth stores,
private test traces, node_modules, targets, local tool environments and secrets.

## Actual verification

`results.json` records the final exact commands, all exit code 0:

```text
cargo build --locked --workspace
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo fmt --all -- --check

Doc-tests chronograph_server
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
All required checks passed; exact output retained in bench/reports/v0.3.0/phase-8-release
```

Across workspace/unit/doctest groups: **51 passed, 0 failed, 1 ignored**. The ignored
subprocess helper is invoked by the ordinary crash test. The final gate used
`PROPTEST_RNG_SEED=4848215499434033153`. `cargo test --locked --workspace --all-features
-- --test-threads=2` also passed 51, with two opt-in helpers ignored; all-feature
Clippy passed. Native synthetic LSL transport was separately tested in phase 4.
Rustdoc with `RUSTDOCFLAGS='-D warnings'` passed after one documentation-only fix
for an interval that had been interpreted as an intra-doc link. The initial error
is retained in `rustdoc-initial.log`, and corrected output in `rustdoc.log`.

The tests cover randomized reference semantics, fork isolation, every byte
boundary of new journal record types, malformed replay, failed sync and uncertain
merge outcomes, scope/expiry/revocation, queue saturation and cancellation, bounded
queries/cursors, immutable sidecars, atomic adapters and backup/restore.

Actual final browser tail, headed Chromium:

```text
✓ 15 [mobile-chromium] durable branches: write in isolation, inspect, preview, merge and reject stale alternatives
✓ 16 [mobile-chromium] landing artwork, documentation and connector navigation render at this viewport
16 passed (1.5m)
```

`e2e.json`: 16 expected, 0 unexpected, 0 skipped, 0 flaky; 91.649 seconds.
Four journeys × desktop 1536×1024 and mobile 390×664 × two repetitions. Real
backend writes/auth/revocation/backups/reloads, synthetic mode with blocked API,
branch merge/remapping/conflict/discard/restart, clipboard commands, graph controls,
all 20 documents and architecture SVG are exercised. No force-click workaround
was used. Earlier failures exposed mobile min-content overflow; corrected viewport
assertions and the final run passed. `screenshots/` contains the reviewed public
views; the five-point design ledger is in `docs/DESIGN.md` in the working checkout.
Raw browser traces remain private because they can contain disposable credentials.

Actual protocol transcript, `protocol.log` / `protocol.json`, 1.251 seconds:

```text
PASS token bootstrap, private permissions and hash-only external credential store
PASS scope enforcement, exact u64 IDs, explicit durability and atomic validation
PASS temporal semantics, revision-bound pagination, batch sampling and Arrow stream
PASS origin boundary, retired cookies, JSON errors and body limit
PASS official JS client: HTTP MCP and native Rust stdio bridge tool discovery/read/write
PASS HTTP and native MCP branches: scoped IDs, bounded intervals, cursor isolation, preview, merge remapping, retries and conflicts
PASS revocation invalidates cached HTTP and existing MCP credentials immediately
PASS downloaded bundle restores to an independent service; sidecars retained, secrets excluded, overwrite rejected
PASS fsync-acknowledged parent and branch history, discard and merge results survive backup restoration and process kill/restart
```

mdBook 0.5.3 builds the offline manual; the local link checker passes all 20
chapters. The production UI build and Prettier checks pass. npm audit reports
zero vulnerabilities; cargo-audit reports zero vulnerability advisories and one
informational unmaintained `paste` 1.0.15 macro dependency via robotics/mcap.
No advisory was suppressed. The inventory has 423 target-filtered workspace
entries, each with upstream license text; optional/development requirements are
included, so this is a superset, not binary reachability analysis. SPDX JSON passes
the official 2.3 schema. Source URLs and hashes preserve notice provenance.

The native preflight archive passes all file checksums, relocated launcher,
external private token bootstrap, unauthenticated rejection, UI/nested docs,
server restart with a persisted fork and graceful shutdown. The source preflight
passes archive boundaries, credential-pattern scan, checksums, offline locked Cargo
metadata, all eight member/target files and public doc links. Final distribution
archives are generated after this report; exact archive hashes live beside them
in `dist/v0.3.0/release-manifest.json` and `SHA256SUMS`. Final archive smoke outcomes
are retained beside this report after packaging to avoid a self-referential archive.

## Final benchmark results and limits

9 September 2026; Apple M5, 4 performance + 6 efficiency cores, 16 GiB, macOS 26.5
arm64, Rust 1.93.0, release/thin LTO, ten Rayon workers, warm OS cache, developer
host without isolation. **AC Low Power Mode was enabled**. No machine settings
were changed. Phase-2 power state was not recorded, so the difference cannot be
attributed to code or power mode without a matched controlled baseline.

Dataset: 100k nodes, 10M versions, one-hour span, about 10% invalidations, seed
4848215499434033153. All final intervals validated. Ingestion counts insertion and
one final sync; explicit invalidations happen afterward, outside insertion timing.

| Workload | Final measured | Target/result |
|---|---:|---|
| Ordered batches + final sync | 1,104,833 versions/s | ≥2M — MISSED |
| Ordered singles + final sync | 547,251 versions/s | ≥500k — PASS |
| Shuffled batches + final sync | 941,933 versions/s | Separate workload |
| Shuffled singles + final sync | 559,132 versions/s | Separate workload |
| Fully consumed as-of p50 / p99 | 19.053 / 19.805 ms | p50 <10 — MISSED |
| Fully consumed 36-second between p50 / p99 | 22.812 / 23.782 ms | No target |
| LatestFirst / Uniform returned sampling | 27.69M / 24.74M edges/s | ≥5M — PASS |
| Arrow, 949,342 rows | 31.187 ms | Materialized |

Whole-run peak RSS 3.49–4.04 GB includes generation/validation/replay/close work.
Ordered batch journal: 698,050,224 bytes; reopen 10.645 seconds. Criterion is
separate: full as-of estimate 11.749 ms (CI 11.543–12.105), between 21.791 ms
(21.037–22.599). Fixed-timestamp sampling and 100k insertion Criterion results
are in `bench/RESULTS.md`; they never replace the full 10M figures. The earlier
2.304M batch/s and 8.440 ms checkpoint remains in phase 2, not as final marketing.
The between window is **36 seconds** (`HOUR/100`); earlier prose saying one second
was corrected. Actual workload code and raw results were unchanged.

The final BCI example ingested 1M versions at 1,213,640/s including sync and found
its expected synchrony window. World-model replay/Arrow/reopen passed. The phase-5
100-future demo restored 3158 records, merged reward 0.85 and discarded 99 forks.
Its three-record-base creation 0.166 ms and toy compute 0.312 ms are separate from
824.965 ms serialized persistence and 4.052 ms merge/sync; no large-fork claim.

Authenticated loopback service, 100k retained / 32k active versions, 1000-row first
page, 20 warmups, warmed token cache, complete client response parsing, no TLS:

| Operation | Samples/concurrency | p50 / p95 / p99 ms |
|---|---:|---:|
| HTTP stats | 500 / 1 | 0.324 / 0.404 / 0.562 |
| HTTP as-of page | 300 / 1 | 4.031 / 4.410 / 4.546 |
| HTTP uniform sample, 16 rows | 300 / 1 | 0.255 / 0.335 / 0.434 |
| MCP as-of page | 300 / 1 | 5.010 / 5.600 / 5.839 |
| HTTP page, 8 clients | 400 / 8 | 6.873 / 10.012 / 14.082 |
| MCP page, 8 requests | 400 / 8 | 8.681 / 11.638 / 15.218 |
| HTTP single insert + fsync | 200 / 1 | 4.006 / 4.810 / 4.965 |

These page timings are not full graph traversals, deployed SLOs or hard real-time
bounds. Raw samples and machine details are retained. No Neo4j or cloud numbers
were fabricated when Docker was unavailable.

## Contract coverage

| Requirement | Status | Evidence / remaining boundary |
|---|---|---|
| F1–F7, DD-01–03 | DONE | Engine, checked persistence, temporal semantics and reference/crash tests |
| F8–F11 | UNSPECIFIED | Definitions absent from missing PRD v2.1 |
| F12 | DONE | Durable branches, recovery, merge and 100-future demonstration |
| F13–F15 | UNSPECIFIED | Definitions absent from missing PRD v2.1 |
| F16–F17, DD-04–07 | DONE locally | Scoped service/native MCP/durability/backups; production/client-app checks pending |
| F18 | BLOCKED: REVIEW | Separate private Managed control plane/provisioning not implemented |
| F19 | BLOCKED: REVIEW | Stripe billing not implemented; no keys/charges/webhooks created |
| F20 | DONE in stated scope | Synthetic BCI/native LSL round trip; real hardware/cross-host pending |
| F21 | DONE in stated scope | Actual twice-run LeRobot and bounded rosbag2/MCAP/reference round trip; arbitrary ROS/video tensors pending |
| F22 | DONE in stated scope | Complete state/RNG, actual twice-run Minari, durable rollout replay |
| F23 | DONE, EXPLORATORY | Static unitary OpenQASM and calibration windows; hardware/general programs pending |
| N1–N3, N8 | DONE measurement / targets open | Full datasets, examples, Criterion, service; batch and as-of targets missed |
| N4–N7 | UNSPECIFIED | Definitions absent from supplied material |
| N9 | DONE | Bounded workers/queue, saturation and cancellation tests |
| N10 | BLOCKED: REVIEW | Managed off-host control/workspace recovery not implemented |
| Community UI/docs/licenses | DONE | 16 browser runs, public manual, architecture, source notices |
| macOS arm64 candidate | DONE locally | Native/source preflight and final archive verification |
| Linux, Docker/TLS, signing | PENDING | Unexecuted CI targets; Docker info timed out after 8 seconds |
| GitHub/crates/AWS publication | DEFERRED | Owner/deployment decision intentionally postponed |

## Deviations and known gaps

The missing PRD is not invented. Community phases continued under the accepted
batch authorization; Phase 6 remains an explicit stop gate. Existing runtime
`data/` is untouched. No server is left running and no client-wide MCP config was
modified. Available Browser skill was absent; headed Playwright was used. Design
concepts and generated hero artwork preceded the redesign. Public helper scripts
use CLI workflows, not fabricated browser hardware-control panels.

No new engine/UI dependencies were added during UI/release hardening. mdBook 0.5.3
is a build tool installed in an ignored local tool directory. Packaging uses
Python's standard library and the existing lockfiles. Earlier phase reports justify
service and adapter dependencies; optional LSL is isolated from normal builds.

Memory-resident history, no compaction/retention, no replicated/multiwriter service,
no nested forks/rebase, bounded branch/HTTP sizes, no automatic sidecar GC, no actor
audit trail or encryption-at-rest are explicit Community limits. Native archives
are not developer-signed/notarized. CI configuration and Dockerfiles do not prove
remote execution. A Docker daemon query timed out; the prepared container smoke
recipe, TLS deployment and Neo4j harness remain pending. Interactive sessions in
Codex/Cursor/Claude are not claimed from protocol tests alone. Managed is not
marketed as an available hosted service.

## Exact next step

Review the Community candidate and open performance/platform gates. To authorize
Managed development explicitly: “Approve the Community review and begin Phase 6
Managed in a separate private repository. Keep Stripe in test mode and keep public
provisioning behind the agreed deployment decision.” Supply missing PRD definitions
before those F/N items can be marked delivered. GitHub publication still needs the
chosen owner/repository; no remote repository or cloud resource was invented.
