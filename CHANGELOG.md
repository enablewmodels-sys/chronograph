# Changelog

## 0.4.0-alpha.3 — development checkout

- Community SDKs for Python, TypeScript/JavaScript, Java, C++, Go, Dart and C#, plus a Q# Python host example. Native transports enforce bounded bodies, TLS for remote endpoints, redirect rejection and structured errors.
- Shared OpenAPI 3.1 input schemas derived from the MCP operation registry; JSON responses remain extensible.
- Five additional migration descriptors: BrainFlow, Q#, portable quantum results, named model outputs and physical-AI transitions (35 presets total). Python adapters preserve source clocks, tensor bytes, quantum counts and decoded ROS media.
- Real-server polyglot conformance tests, controlled transport fault tests and synthetic/local BrainFlow, LSL and QDK fixtures. Physical hardware and QPU jobs are not certified.
- Source distribution only at this step; no SDK package registry or new binary release is implied.

## 0.4.0-alpha.2 — 2026-09-11

- First public Community release preparation: source, Apple Silicon native bundle and Python connector wheel.
- Apply unmodified PolyForm Perimeter 1.0.0 to Chronograph-owned code and docs. Modification and noncompeting commercial use are permitted; competing products, including free alternatives, are restricted. Third-party licenses remain unchanged. This does not revoke rights already granted for earlier copies.
- Publishable static landing page, documentation and synthetic read-only demo, with Vercel configuration and no database credentials.
- Updated install, licensing, security and edition guidance; reproducible release and source-boundary checks.


## 0.4.0-alpha.1 — connector transport

- Format-3 atomic ingestion receipts and explicit format-2 upgrade; latest identical retries are durable and idempotent.
- Shared registry with 28 presets, immutable migration-v2 bindings and explicit sidecar payload encoding. Migration-v1 checksums remain stable.
- Checksummed binary/tensor assets, resumable chunk publication and bounded byte-range retrieval.
- HTTP/MCP connector operations, migration dropdowns and connector console.
- Python client, durable local agent queue and external JEPA, hierarchy, transition, MNE, LeRobot, Qiskit and Cirq adapters.
- This is an alpha. Remaining native adapters and managed infrastructure are tracked separately; no public deployment has occurred.


## 0.3.0 — Community local release candidate

- Checked format-2 journal, ordered temporal indexes, centralized atomic mutations,
  bounded validity intervals, explicit durability and exclusive file ownership.
  Format-1 migration writes a new destination; opening never silently migrates.
- Durable copy-on-write branches with shared frozen bases, isolated deltas,
  conflict-checked atomic merge, new-ID mappings and retained lifecycle results.
- Axum HTTP service, scoped expiring/revocable Argon2id machine tokens, bounded
  work queues, exact Host/Origin checks and native Rust MCP stdio bridge.
- Consistent checksummed journal/index/sidecar backup and staged independent restore.
- BCI simulation and optional native LSL, bounded rosbag2/MCAP and LeRobot adapters,
  complete-state world-model/Minari replay, and exploratory OpenQASM/calibration support.
- Light landing with generated artwork; dark temporal explorer, branch workspace,
  writes, connector guides, agent access and operations. Exact IDs stay strings.
- Offline manual, native packaging, dependency inventory/license notices,
  container bootstrap recipe, CI gates and retained test/benchmark evidence.

Breaking changes: the old password/session service and legacy SHA-based machine
credentials are removed. Create fresh scoped tokens in an external config path.
This service remains a preview; no hosted Managed platform or billing is included.
GitHub/crates publication, signed downloads, external infrastructure and deployment
validation are separate gates. See docs/REQUIREMENTS.md and docs/LIMITATIONS.md.
