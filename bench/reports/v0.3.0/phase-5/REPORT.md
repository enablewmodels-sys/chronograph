# Phase 5 — durable branching snapshots

Status: **PASS**, Community implementation. The Managed Phase 6 review gate remains closed. Community UI and release hardening continue under the accepted plan.

## Built

- `crates/chronograph-core/src/branch.rs`: shared immutable snapshot bases, per-branch deltas, indexed reads/sampling/Arrow, lifecycle metadata, deterministic merge preview/remapping and conflict checks.
- `model.rs`, `graph.rs`, `index.rs`, `storage.rs`: public branch mutation/read APIs, separate parent/global revisions, checked tags 5–10, replay at historical fork points, atomic merges and bounds.
- `crates/chronograph-server/src/{operations,mcp,lib,backup}.rs`: scoped HTTP/MCP branch operations, optional branch selection on graph reads/writes, bounded end support, exact string IDs, bounded mapping responses, backup/restore verification.
- `crates/chronograph-conn-worldmodel/src/lib.rs` and `examples/fork_demo.rs`: validated fork episode continuation/restoration; 100 actual parallel action-policy futures, persistent verification, best-future merge, selected-episode Arrow export.
- Core/service/connector tests and `scripts/protocol-test.mjs`: randomized branch reference comparison, all-byte torn records, injected failed merge sync, malformed records, scopes, cursors, native stdio MCP, downloaded backup restoration and actual process kill/restart.
- `docs/BRANCHES.md`, `BRANCHING_DESIGN.md`, `FORMAT.md`, `API.md`, `MCP.md`, connector guide and release matrix.

The first fork at a parent revision/time builds the frozen base from the active parent snapshot. A hundred forks at that same point share one `Arc`; closing the last one releases it. New versions and inherited-end overrides are separate. Merge rejects parent revision changes and touched pre-existing future versions/finite expirations, preserving untargeted history. One frame applies deterministic node/edge remappings and closes the branch. Reopening retains closed statuses and merge results; payload bytes remain opaque.

## Required verification

`python3 scripts/check-phase.py phase-5` passed all four whole-workspace commands. Exact outputs: `build.log`, `test.log`, `clippy.log`, `fmt.log`; exit codes and timing: `results.json`. Total: **51 passed, 0 failed, 1 ignored subprocess-only crash helper** (invoked by its parent test). The first Clippy run identified an unnecessary cloned one-element test slice; it was changed to `std::slice::from_ref` and the whole gate rerun successfully.

Actual core test output:

```text
running 27 tests
test tests::arrow_export_and_parallel_reads ... ok
test tests::application_revision_and_drop_durability ... ok
test tests::crash_child ... ignored, subprocess-only crash writer
test branch::tests::one_hundred_forks_share_one_frozen_base_and_release_it_when_closed ... ok
test tests::bounded_batch_preserves_gaps_late_arrivals_atomicity_and_replay ... ok
test tests::corrupted_length_cannot_hide_later_records_as_a_torn_tail ... ok
test tests::codec_rejects_unbounded_counts_and_invalid_options ... ok
test tests::failed_sync_disables_writer_and_requires_reopen ... ok
test tests::durable_forks_freeze_state_isolate_writes_and_remap_on_merge ... ok
test tests::failed_merge_sync_has_atomic_recoverable_result ... ok
test tests::corruption_and_format_errors_do_not_rewrite_files ... ok
test tests::batches_match_sequential_and_reject_invalid_input_atomically ... ok
test tests::interval_math_and_late_replacement ... ok
test tests::independently_encoded_v1_fixture_is_compatible ... ok
test tests::late_event_fills_gap_without_changing_successor ... ok
test tests::lock_and_sync_mode ... ok
test tests::kill_mid_append_recovers_whole_operations ... ok
test tests::frozen_forks_exclude_parent_future_and_reject_conflicting_merges ... ok
test tests::migration_rejects_existing_locked_and_incomplete_files ... ok
test tests::malformed_branch_records_never_rewrite_the_source ... ok
test tests::sampling_and_temporal_filtering ... ok
test tests::partial_header_and_trailing_checksum_recovery ... ok
test tests::bounded_temporal_batches_match_reference ... ok
test tests::arbitrary_history_matches_naive_model ... ok
test tests::branch_batches_and_merge_match_reference ... ok
test tests::partial_append_every_byte_preserves_atomic_replacement ... ok
test tests::every_truncated_branch_operation_recovers_atomically ... ok

test result: ok. 26 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 4.97s
```

Additional service suite: 9 passed; world-model suite: 4 passed. The phase gate also runs the other connector suites and doctests. No new `unsafe` block was introduced. New dependency declarations: existing workspace `rayon` and `rand` were added as world-model dev dependencies to compute the example's parallel futures and reproducible action policies; no new dependency package was added for branching.

## Actual hundred-future output

Command: `cargo build --locked --release -p chronograph-server -p chronograph-conn-worldmodel --bins --example fork_demo`, then `target/release/examples/fork_demo .work/phase-5-fork-demo` (new directory only).

Machine: Apple M5 arm64, 10 logical CPUs, 16 GiB RAM, macOS-26.5-arm64-arm-64bit-Mach-O; Rust 1.93.0; Rayon 10 workers. Run: 2026-09-09T13:42:17.727628+00:00. This is a small 8×8 deterministic gridworld with a three-record parent prefix, seed 42 and 64-step horizon, on an unisolated local host. These are single-run example timings, not a large-graph latency distribution or a physics benchmark.

| Observed result | Value |
| --- | ---: |
| Durable forks | 100 |
| Reached goal | 90 |
| Hit horizon | 10 |
| Branch records exactly restored after reopening | 3158 |
| Selected fork / future reward | 1 / 0.85 |
| Parent versions after merge | 19 |
| Other forks durably discarded | 99 |
| Fork creation (buffered; later sync included below) | 0.165833 ms |
| Parallel simulation only | 0.312125 ms |
| Serialized sidecar writes + branch commits + final close/sync | 824.964583 ms |
| Selected merge + sync | 4.052084 ms |

`fork-demo.json` contains every candidate's real score/outcome. `fork-demo.log` is complete command output. The retained local fixture contains the checked journal, sidecars and `selected-episode.arrow`. All branch states and the final selected parent episode were compared with source states after reopening. Final 10M-version engine and service latency reruns remain due during release hardening.

## Actual protocol output

Release server and native MCP bridge, official TypeScript MCP client, loopback ports 18081/18082, disposable data/config only. Completed in 1.740 seconds on Node v20.20.2. Both services were stopped.

```text
$ CHRONOGRAPH_REPORT_PHASE=phase-5 node scripts/protocol-test.mjs
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

## Deviations and known gaps

- The absent `Chronograph_PRD_v2.1.md` is still not inferred. The supplied F12 brief and accepted durable-fork decision govern this implementation.
- Conservative whole-parent revision conflicts; no nested forks, rebase, auto conflict resolution, pruning or compaction. Active/lifetime bounds: 256 / 65536. The first distinct base costs O(parent history + nodes), so arbitrary fork creation is not claimed to be constant time.
- Atomic merge capped at a 64 MiB frame; HTTP/MCP detailed mapping results capped at 10000 entries. Embedded API supports the full frame bound. Sidecars remain immutable; orphan garbage collection is not implemented.
- `index.snapshot` is a disposable parent cache. All branch state is recovered from the authoritative journal. The backup test does not establish off-host Managed restoration (N10 remains behind review).
- The example varies policies from a complete shared environment/RNG state. It does not connect to external physics simulators or execute distributed/GPU workloads.
- Actual interactive Codex/Cursor/Claude app sessions remain pending; official HTTP and native stdio protocol clients passed.
- Branch console, full landing redesign, mdbook, deploy packaging and final release tests are next. GitHub/AWS publication remains deferred.

## Resume

Continue Community UI and Phase 7 release hardening, including the final twice-repeated browser journeys and latency/engine reruns. Do not write Managed Phase 6/control-plane/billing code until the user reviews the completed Community candidate and confirms.
