# Community 0.4.0-alpha.1 verification

This alpha implements normalized connector transport, not the complete managed launch.

## Passed

- 63 Rust tests/doctests; one pre-existing ignored test. Workspace clippy passes with warnings denied.
- Migration-v1 serialization checksum regression fixture; separate-destination format-2 upgrade preserves source and branches.
- Every byte truncation of an ingestion frame: no half checkpoint/batch. Injected fsync failure poisons the handle, and restart reconciles an identical retry.
- All 28 registry presets: generated migration, ingestion, exact source export, idempotent retry and conflicting/stale sequence rejection. Read-scope mutation denial, missing assets and malformed tensor shape checks.
- Official MCP discovery and existing HTTP/native MCP flows, token revocation, schema persistence and backup/restore.
- SIGKILL and restore to an independent server preserve every preset, binary asset, schema binding and checkpoint.
- Python spool lost-ack, pause/resume/cancel, restart and capacity tests; real HTTP lost-ack reconciliation and multi-chunk endian-preserving tensor upload/download.
- MNE 1.13.0 FIF samples/timestamps; Qiskit 2.5.2 official OpenQASM export; Cirq 1.6.1 JSON and simulator measurements; PyTorch 2.11.0 BF16/hierarchy; LeRobot 0.6.1 actual v3 image dataset.
- Existing 24 browser checks passed: two runs on desktop/mobile. New connector configure → preview → apply → ingest → retry → checkpoint flow passed twice at 1536×1024 and 390×844, with no page/console errors or horizontal overflow. Fixed accessible dropdown labels and mobile guide overflow.
- TypeScript/Vite build and mdBook/manual links (23 chapters).

Browser plugin/skill was unavailable; existing Playwright with visible Chromium was used. Page identity, nonblank render, lack of framework overlay, console health, screenshots and interaction proof were checked. Screenshots are local `/tmp/chronograph-connector-*` artifacts, outside shipped source.

## Latency

Same Apple M5 host as the 0.3 schema baseline, optimized Rust build, loopback HTTP without TLS. These are local observations, not production SLOs. Existing query fixture contains 100,000 versions. No existing workload's median regressed more than 2%; raw 1000-row page median is 2.225 ms and typed page is 2.653 ms.

| New workload | p50 ms | p95 ms |
|---|---:|---:|
| JEPA record, 256 KiB tensor verified, Arrow publication + journal fsync | 12.383 | 14.499 |
| 500 JEPA records sharing that tensor, fsync | 13.802 | 15.946 |
| Identical latest-batch retry | 0.224 | 0.527 |
| Read checkpoint | 0.181 | 0.371 |
| Verified source-record export | 0.206 | 0.398 |

Raw measurements, sample counts and baseline comparisons accompany this report. Single-record durable writes pay both sidecar and journal synchronization; batching amortizes this cost. Cross-host TLS, sustained load, disk-full behavior and maximum resident-memory pressure remain unverified.

## Still pending

Hosted control plane, invitations/GitHub auth, workspace provisioning, AWS/TLS/backup deployment validation; remaining ROS decoders, LSL reconnect/spool integration, native LeRobot video shard export/v2 conversion; real model checkpoint and physical device certification; remote job UI and disk quotas/asset GC. EDF/BDF reader paths exist but this run independently exercised FIF. No public GitHub release or cloud deployment has occurred.
