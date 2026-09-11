# Phase 1 summary

Built: version-2 explicit checked journal encoding, version-1 migration reader, ordered per-node and per-relationship trees, centralized WriteOp application, Fsync durability with compatibility spelling, best-effort Drop sync, replayed mutation revisions, and migration/decoder fault tests. Existing runtime data was not opened or changed.

Files: core model, graph, index, storage and tests; workspace dependency/version metadata; REQUIREMENTS.md; reusable check-phase.py runner. The server and benchmark use the new Fsync spelling.

Dependencies: removed unmaintained bincode. No new engine dependencies.

All four mandatory commands passed; exact transcripts are in build.log, test.log, clippy.log and fmt.log, with exit codes and timing in results.json. The crash_child ignored test is deliberately invoked by its parent crash-recovery test.

Deviation: the unavailable PRD is not claimed as verified. The old v1 fixture now exercises explicit migration rather than implicit open. The previous vector/block index was replaced by the specified ordered trees; benchmark differences will be reported in Phase 2. Existing read methods remain as source-compatible conveniences alongside view().

Known gaps: branching is Phase 5; service authentication/API migration is Phase 3; other accepted requirements are tracked in docs/REQUIREMENTS.md. No managed code has been started.

Continuation: proceed automatically to Phase 2 under the user's community-batch instruction.
