use serde::{Deserialize, Serialize};

/// Application-assigned node identifier. Nodes are not themselves time-versioned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct NodeId(pub u64);

/// Database-assigned, stable edge-version identifier, local to one parent graph or selected fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EdgeId(pub u64);

/// Application-defined directed relationship type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EdgeKind(pub u16);

/// Stable identifier for a durable fork within one database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ForkId(pub u64);

/// Persistent lifecycle of a fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkStatus {
    /// Reads and writes are allowed.
    Active,
    /// Changes were atomically merged into the parent.
    Merged,
    /// The fork was discarded without changing the parent.
    Discarded,
}

/// Mapping from a new fork-local node to its committed parent identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeRemap {
    /// Node identifier in the selected fork.
    pub branch: NodeId,
    /// Newly allocated identifier in the parent graph.
    pub parent: NodeId,
}

/// Mapping for an inserted or modified fork edge version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeRemap {
    /// Edge identifier local to the selected fork.
    pub branch: EdgeId,
    /// Its corresponding version identifier in the parent graph.
    pub parent: EdgeId,
}

/// Result of a durable, atomic merge. Payload bytes remain application-owned and are not rewritten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeResult {
    /// Fork which was merged.
    pub fork: ForkId,
    /// Parent state revision after the merge.
    pub parent_revision: u64,
    /// Mappings for new nodes; inherited node IDs retain their parent identity.
    pub nodes: Vec<NodeRemap>,
    /// Mappings for inserted versions and inherited versions whose ends changed.
    pub edges: Vec<EdgeRemap>,
}

/// Persistent metadata for an active or closed fork.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkInfo {
    /// Database-local fork identifier.
    pub id: ForkId,
    /// Human-readable label, at most 80 UTF-8 bytes.
    pub name: String,
    /// Earliest query/write time in this fork, in microseconds.
    pub timestamp: i64,
    /// Parent state revision captured by this fork.
    pub parent_revision: u64,
    /// Number of state-changing writes accepted by this fork.
    pub revision: u64,
    /// Number of edge versions in the immutable active-at-fork base.
    pub inherited_edges: usize,
    /// Number of newly inserted edge versions, including empty/invalidated versions.
    pub delta_edges: usize,
    /// Number of branch-local nodes not present in the inherited base.
    pub new_nodes: usize,
    /// Whether the fork can still be read or modified.
    pub status: ForkStatus,
    /// Retained merge result for resolving an uncertain client response.
    pub merge: Option<MergeResult>,
}

/// An operation whose IDs are interpreted within one selected fork.
#[derive(Debug, Clone)]
pub enum ForkWriteOp {
    /// Register an isolated branch-local node.
    AddNode(NodeId),
    /// Insert an atomic batch of branch-local edge versions.
    AddEdges(Vec<EdgeInput>),
    /// Insert versions with explicit validity ends.
    AddBoundedEdges(Vec<BoundedEdgeInput>),
    /// Shorten a branch-local version, including an inherited version.
    Invalidate(EdgeId, i64),
}

/// A directed edge version, valid on `[valid_from, valid_to)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    /// Stable identifier for this version.
    pub id: EdgeId,
    /// Source node.
    pub src: NodeId,
    /// Destination node.
    pub dst: NodeId,
    /// Relationship type.
    pub kind: EdgeKind,
    /// Inclusive start, in microseconds since Unix epoch.
    pub valid_from: i64,
    /// Exclusive end; `i64::MAX` denotes an open interval.
    pub valid_to: i64,
    /// Application-defined inline data. The engine does not interpret these bytes.
    pub payload: [u8; 16],
}

impl Edge {
    /// Whether this edge is valid at `t`. At `i64::MAX`, no edge is valid.
    pub fn is_valid_at(&self, t: i64) -> bool {
        self.valid_from <= t && t < self.valid_to
    }

    /// Whether this nonempty interval overlaps the nonempty window `[start, end)`.
    pub fn overlaps(&self, start: i64, end: i64) -> bool {
        start < end
            && self.valid_from < self.valid_to
            && self.valid_from < end
            && self.valid_to > start
    }
}

/// A compact, copyable edge handle. Resolve with [`crate::Graph::edge`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EdgeRef {
    /// Identifier local to the graph from which this handle was obtained.
    pub id: EdgeId,
}

/// Input for an insertion. Its end is determined by the relationship timeline.
#[derive(Debug, Clone, Copy)]
pub struct EdgeInput {
    /// Source node, created implicitly if absent.
    pub src: NodeId,
    /// Destination node, created implicitly if absent.
    pub dst: NodeId,
    /// Application-defined relationship type.
    pub kind: EdgeKind,
    /// Inclusive start in microseconds since Unix epoch; must be below `i64::MAX`.
    pub valid_from: i64,
    /// Opaque inline payload.
    pub payload: [u8; 16],
}

/// An insertion with an explicit upper validity bound, applied atomically with its start.
#[derive(Debug, Clone, Copy)]
pub struct BoundedEdgeInput {
    /// The ordinary insertion fields.
    pub edge: EdgeInput,
    /// Requested exclusive end. A pre-existing successor can shorten this further.
    pub valid_to: i64,
}

/// Temporal neighborhood sampling policy. Samples never contain duplicate versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleStrategy {
    /// Uniform sampling without replacement over edges active at the query time.
    Uniform,
    /// Most recent active versions, descending by `(valid_from, EdgeId)`.
    LatestFirst,
}

/// When accepted operations are synchronized to the filesystem.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    /// Buffer writes; only [`crate::Graph::sync`] or [`crate::Graph::close`] guarantees persistence.
    #[default]
    Buffered,
    /// Flush and synchronize each operation or atomic batch before returning.
    Fsync,
}

impl Durability {
    /// Compatibility spelling for `Fsync`; use `Fsync` in new code.
    #[allow(non_upper_case_globals)]
    #[deprecated(since = "0.3.0", note = "use Durability::Fsync")]
    pub const SyncOnCommit: Self = Self::Fsync;
}

/// A public mutation submitted through the engine's single application path.
#[derive(Debug, Clone)]
pub enum WriteOp {
    /// Register a persistent isolated node.
    AddNode(NodeId),
    /// Insert a batch atomically, preserving input order.
    AddEdges(Vec<EdgeInput>),
    /// Insert versions with explicit validity ends in one atomic batch.
    AddBoundedEdges(Vec<BoundedEdgeInput>),
    /// Shorten an existing interval.
    Invalidate(EdgeId, i64),
    /// Create a named durable frozen snapshot of the parent state at a time.
    Fork {
        /// Snapshot time.
        timestamp: i64,
        /// Human-readable label.
        name: String,
    },
    /// Apply a mutation to one active fork.
    ForkWrite {
        /// Selected fork; all edge IDs in the operation are local to this fork.
        fork: ForkId,
        /// Atomic branch operation.
        operation: ForkWriteOp,
    },
    /// Atomically merge an eligible fork and close it.
    MergeFork(ForkId),
    /// Durably discard an active fork without changing the parent.
    DiscardFork(ForkId),
}

/// Result of an accepted mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteResult {
    /// An isolated node was registered, or already existed.
    Node(NodeId),
    /// IDs for inserted versions, in input order.
    Edges(Vec<EdgeId>),
    /// An interval was shortened, or the operation was a no-op.
    Invalidated(EdgeId),
    /// A durable fork was created.
    Fork(ForkId),
    /// A fork was atomically merged.
    Merged(MergeResult),
    /// A fork was durably discarded.
    Discarded(ForkId),
}

/// Options for opening a database. A database file has one owning handle at a time.
#[derive(Debug, Clone, Copy)]
pub struct OpenOptions {
    /// Persistence policy; defaults to buffered writes.
    pub durability: Durability,
    /// Write buffer size in bytes; defaults to 1 MiB. Zero disables buffering.
    pub write_buffer_bytes: usize,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            durability: Durability::Buffered,
            write_buffer_bytes: 1024 * 1024,
        }
    }
}

/// Counts and sizes for monitoring a database, without scanning its history.
#[derive(Debug, Clone, Copy)]
pub struct GraphStats {
    /// Number of known nodes, including isolated nodes.
    pub nodes: usize,
    /// Number of edge versions, including invalidated and empty versions.
    pub edge_versions: usize,
    /// Logical log size, including bytes still in the write buffer.
    pub log_bytes: u64,
    /// Bytes discarded from a torn tail during this open.
    pub recovered_tail_bytes: u64,
}

/// A database operation error.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A filesystem operation failed. Failed writes require reopening the graph.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// Another handle or process already owns the database file.
    #[error("database file is locked")]
    Locked,
    /// Invalid or corrupted persistent data.
    #[error("corrupt database at byte {offset}: {reason}")]
    Corrupt {
        /// Position of the invalid frame or field.
        offset: u64,
        /// Human-readable cause.
        reason: String,
    },
    /// The file requires a format or feature this reader does not understand.
    #[error("unsupported database format: {0}")]
    UnsupportedFormat(String),
    /// Older input must be migrated explicitly to a separate current-format file.
    #[error("older database format requires explicit migration to a separate destination")]
    MigrationRequired,
    /// Malformed ingestion metadata or a resource limit violation.
    #[error("invalid ingestion batch: {0}")]
    InvalidIngest(String),
    /// An ingestion sequence or retry digest conflicts with its durable checkpoint.
    #[error("ingestion checkpoint conflict: {0}")]
    IngestConflict(String),
    /// A graph-local edge identifier does not exist.
    #[error("unknown edge: {0:?}")]
    UnknownEdge(EdgeId),
    /// No fork with this identifier exists.
    #[error("unknown fork: {0:?}")]
    UnknownFork(ForkId),
    /// The fork has already been merged or discarded.
    #[error("fork is closed: {0:?}")]
    ForkClosed(ForkId),
    /// A merge would overwrite changes or pre-existing future timeline information.
    #[error("fork merge conflict: {0}")]
    ForkConflict(String),
    /// Invalid fork metadata or a configured resource bound was reached.
    #[error("invalid fork operation: {0}")]
    InvalidFork(String),
    /// A start is the open-end sentinel, or an invalidation precedes the edge start.
    #[error("invalid timestamp: {0}")]
    InvalidTimestamp(i64),
    /// An atomic operation would exceed the 64 MiB frame limit.
    #[error("atomic record exceeds the 64 MiB limit; use smaller batches")]
    RecordTooLarge,
    /// The graph cannot accept writes after an ambiguous I/O failure.
    #[error("writer failed; close this handle and reopen the database")]
    WriterFailed,
    /// No further edge IDs are representable.
    #[error("edge identifier space exhausted")]
    IdExhausted,
    /// Arrow rejected the constructed output.
    #[error("Arrow export failed: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    /// An internal record could not be encoded.
    #[error("record encoding failed: {0}")]
    Encoding(String),
}

/// Result type for database operations.
pub type Result<T> = std::result::Result<T, Error>;
