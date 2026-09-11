# Durable branching snapshots

A fork is a separate future starting from the parent graph state active at a chosen microsecond. Create one with `Graph::fork(t)` or `fork_named(t, name)`, write to its `ForkId`, inspect it, then merge or discard. Branch operations use the same locked journal and durability policy as parent writes.

## Snapshot semantics

Only versions active at the fork time are inherited. Their original start timestamps remain available, and their ends are frozen at `i64::MAX`. Earlier superseded versions and known later observations are excluded. This freezes the present for a rollout; it does not copy the parent's scheduled future. Queries and mutations before the fork time fail. At `i64::MAX`, no edge is active, as on the parent. A fork cannot be created at that sentinel.

Nodes are non-temporal identities. Every node registered at creation is inherited, including isolated nodes. The first fork at a `(parent revision, time)` builds an immutable indexed base in O(parent history + known nodes). Further forks at exactly that point share its `Arc`. Branch edits keep new versions, new node identities and end overrides for inherited edges. Only touched relationship timelines are copied while preparing a batch. Fork creation at different revisions/times may allocate independent bases; this release does not claim arbitrary snapshots are O(1).

A branch's edge IDs are local to that branch. Always retain the `ForkId` with an edge ID. Parent and branch edge ID `0` can identify different versions. Inherited edges are compactly numbered in parent insertion order; later branch edges follow them. Never pass a fork-local ID to a parent invalidation call.

## Embedded Rust

```rust,ignore
use chronograph_db::{EdgeInput, EdgeKind, ForkWriteOp, NodeId};

let fork = graph.fork_named(2_000_000, "candidate policy")?;
let ids = graph.add_edges_to_fork(fork, &[EdgeInput {
    src: NodeId(1), dst: NodeId(2), kind: EdgeKind(1),
    valid_from: 2_100_000, payload: [7; 16],
}])?;
let view = graph.fork_view(fork, 2_150_000)?;
let active: Vec<_> = view.edges().collect();
let arrow = view.export_arrow()?;
let proposed = graph.preview_merge(fork)?; // no mutation
let committed = graph.merge(fork)?;       // revalidates and commits atomically
assert_eq!(proposed, committed);
graph.sync()?;
```

`write_fork` accepts `ForkWriteOp::{AddNode, AddEdges, AddBoundedEdges, Invalidate}`. `add_bounded_edges_to_fork` inserts explicit ends atomically. Late and equal-time arrivals follow the same truncation rules as the parent. Invalidation only shortens; empty batches and already-existing nodes are no-ops. `fork_history`, `fork_edge`, `fork_between` and `ForkView::{edges, nodes, neighbors, sample_neighbors_seeded, export_arrow}` provide reads. A borrowed view prevents writes until it is no longer used.

## Merge rules and mappings

`preview_merge` and `merge` require the **parent state revision** to equal the fork's captured revision. Branch creation, editing and discarding affect the global revision, but leave this parent revision unchanged. A successful merge is one parent commit; other forks from the old parent then conflict, even if their changes are disjoint. There is no automatic rebase or three-way conflict resolution.

A merge also rejects touched relationships that already contained future versions at creation, or whose active parent version had a finite future end. This conservative rule prevents a frozen branch from resurrecting an expiration or deleting a known future. Future information on untouched relationships is preserved. Failed validation leaves the parent and fork unchanged; an I/O failure can have an ambiguous durable outcome.

A successful merge applies inherited-edge end changes and new versions in one checksummed frame. Inherited node IDs retain their identity. New branch nodes receive deterministic unused parent IDs, selected from zero upward; new edge versions receive parent edge IDs. `MergeResult` returns `nodes` and `edges` mappings and the committed `parent_revision`. Edge mappings include inserted versions and modified inherited versions, rather than every unchanged inherited edge.

The engine does **not** rewrite opaque payload bytes or connector sidecars. Applications embedding node or edge IDs in payloads must handle the mappings. The world-model connector continues an episode whose environment and episode nodes were registered in the parent, avoiding remapping those identities.

After merging or discarding, a fork is closed and its edge data cannot be queried. Metadata remains in `forks()` / `fork_info()`. A merged fork retains its merge result. Repeating `merge` returns that result without another write; repeating `discard` on a discarded fork is a no-op. Discarding a merged fork or merging a discarded fork fails. IDs are never reused. New fork creation and edge insertion are not idempotent; inspect state after an uncertain response before retrying.

## HTTP and MCP

All calls are authenticated and use decimal strings for IDs, timestamps and revisions. Ingest/admin tokens can create, edit, merge and discard; read tokens can inspect and preview. Scopes cover the whole workspace, including all forks.

| POST endpoint / MCP tool | Example arguments |
| --- | --- |
| `/v1/fork` / `fork` | `{"t":"2000000","name":"candidate","durability":"fsync"}` |
| `/v1/forks` / `forks` | `{"limit":100}`; follow `next_after` using `after` |
| `/v1/fork_info` / `fork_info` | `{"fork":"1"}` |
| `/v1/preview_merge` / `preview_merge` | `{"fork":"1"}` |
| `/v1/merge` / `merge` | `{"fork":"1","durability":"fsync"}` |
| `/v1/discard` / `discard` | `{"fork":"1","durability":"fsync"}` |

Add optional `"fork":"1"` to ordinary edge/node writes, invalidation, temporal queries, history, neighbor sampling, edge lookup, node existence and HTTP Arrow export. Omit it for the parent. An insertion may include `"valid_to":"2100000"` inside each edge; omission means open-ended before successor truncation. Read responses identify the selected fork. Branch cursors bind to the selected fork, query and global revision. A cursor from another fork or before any mutation returns 409. Fork-list pagination uses increasing stable IDs; metadata may change between pages.

Creation/discard responses contain `fork` metadata. Preview/merge responses contain a `merge` object with proposed/committed mappings. `fork_info` returns retained mappings for a merged fork. List metadata includes only mapping counts, keeping list responses bounded. A 404 means unknown fork; 409 means closed fork or merge/cursor conflict. Actual merge validates again even if a prior preview succeeded.

## Durability, bounds and operations

At most 256 forks are active, and at most 65,536 can be created over a database's lifetime. Names must be trimmed, nonempty, contain no control characters and fit 80 UTF-8 bytes. Closed metadata is retained; no pruning, nested forks or journal compaction is implemented.

The 64 MiB atomic-frame bound applies to each edit and whole merge. A large accumulated delta can exceed the merge bound: smaller ingestion batches do not bypass it. Preview detects this before append. HTTP/MCP additionally limit a merge or retained detailed result to 10,000 total node/edge mappings; use the embedded API for larger results. Existing request, worker, rate, page and Arrow limits also apply.

Normal reopen reconstructs bases at the corresponding historical creation records, never from final parent state. Checked journal tags reject invalid IDs, intervals, predecessors, remappings and lifecycle changes. Backups include this authoritative journal and connector sidecars. The disposable index snapshot contains the parent graph only and cannot replace branch journal replay. Closing a fork releases its in-memory base reference/delta; journal history and unreferenced sidecars remain on disk.

Use `sync()` / `Durability::Fsync` (or HTTP `durability: "fsync"`) for a durable acknowledgement. A failed append/sync disables the writer. After reopening, inspect `fork_info`: a fully appended merge may have completed despite the caller seeing an error. The retained result resolves that uncertainty. No test here represents a power-loss guarantee beyond the filesystem's synchronization contract.

## A hundred futures

```sh
cargo run --locked --release -p chronograph-conn-worldmodel --example fork_demo -- ./fork-demo
```

The example creates 100 real forks at a shared gridworld snapshot with complete RNG state, computes 100 action-policy futures through Rayon, and serializes their validated graph commits after synchronizing Arrow sidecars. It reopens and compares every recorded branch snapshot, selects the highest-reward future, previews and merges it, discards the other 99 forks, then reopens and compares the selected parent episode. A new output directory retains `report.json`, the journal, sidecars and `selected-episode.arrow`. It never modifies an existing directory. See `bench/reports/v0.3.0/phase-5/` for measured output and verification evidence.
