use std::{path::Path, sync::Arc};

use arrow::{
    array::{ArrayRef, FixedSizeBinaryBuilder, Int64Builder, UInt16Builder, UInt64Builder},
    datatypes::{DataType, Field, Schema},
    record_batch::RecordBatch,
};
use rand::{Rng, SeedableRng, rngs::SmallRng};
use rayon::prelude::*;

use crate::{
    BoundedEdgeInput, Edge, EdgeId, EdgeInput, EdgeKind, EdgeRef, Error, GraphStats, NodeId,
    OpenOptions, Result, SampleStrategy, WriteOp, WriteResult,
    index::{Adjacency, Index},
    storage::{Journal, MAX_FRAME, Record},
};

/// An embedded temporal graph with one writer and concurrent immutable readers.
///
/// Writes require `&mut self`; views and query iterators borrow the graph and prevent
/// mutation until dropped. External modification of the open database file is unsupported.
/// Call [`Self::sync`] or [`Self::close`] to establish a durability checkpoint.
///
/// ```compile_fail
/// # use chronograph_db::{Graph, NodeId};
/// # fn example(graph: &mut Graph) {
/// let view = graph.as_of(0);
/// graph.add_node(NodeId(1)).unwrap();
/// println!("{}", view.edges().count());
/// # }
/// ```
pub struct Graph {
    pub(crate) index: Index,
    pub(crate) journal: Journal,
    pub(crate) checkpoints: crate::ingestion::Checkpoints,
    pub(crate) branches: crate::branch::BranchStore,
}

impl Graph {
    /// Open or create an append-only log file with buffered durability.
    ///
    /// Replays its history and repairs a torn trailing record. Fails on interior
    /// corruption, unsupported formats, or an already locked file. The parent must exist.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_options(path, OpenOptions::default())
    }

    /// Open or create a graph with an explicit durability and buffering policy.
    pub fn open_with_options(path: impl AsRef<Path>, options: OpenOptions) -> Result<Self> {
        let mut index = Index::default();
        let mut branches = crate::branch::BranchStore::default();
        let mut checkpoints = crate::ingestion::Checkpoints::default();
        let journal = Journal::open(path.as_ref(), options, |record, offset| {
            if let Record::Ingest(receipt, inserts) = record {
                checkpoints
                    .replay(
                        &receipt,
                        &inserts,
                        index.revision + branches.revision + 1,
                        index.edges.len() as u64,
                    )
                    .map_err(|e| crate::storage::corrupt(offset, e.to_string()))?;
                branches.replay(&mut index, Record::Batch(inserts), offset)?;
                checkpoints.insert(receipt);
                Ok(())
            } else {
                branches.replay(&mut index, record, offset)
            }
        })?;
        index.finish();
        Ok(Self {
            index,
            journal,
            branches,
            checkpoints,
        })
    }

    /// Register a persistent node. Repeated registration is a no-op.
    fn apply_node(&mut self, id: NodeId) -> Result<()> {
        self.journal.ensure_writable()?;
        if !self.index.nodes.contains_key(&id) {
            self.journal.append(&Record::Node(id))?;
            self.index.nodes.entry(id).or_default();
            self.index.revision += 1;
        }
        Ok(())
    }

    /// Insert a directed version, shortening an active predecessor and preserving successors.
    ///
    /// Accepts late arrivals; equal start times use insertion order, retaining replaced
    /// versions as empty intervals. Missing endpoints are registered automatically.
    pub fn add_edge(
        &mut self,
        src: NodeId,
        dst: NodeId,
        kind: EdgeKind,
        valid_from: i64,
        payload: [u8; 16],
    ) -> Result<EdgeId> {
        let input = EdgeInput {
            src,
            dst,
            kind,
            valid_from,
            payload,
        };
        Ok(self.add_edges(&[input])?[0])
    }

    /// Apply a mutation through the single validated write path.
    pub fn apply(&mut self, operation: WriteOp) -> Result<WriteResult> {
        match operation {
            WriteOp::AddNode(id) => {
                self.apply_node(id)?;
                Ok(WriteResult::Node(id))
            }
            WriteOp::AddEdges(inputs) => Ok(WriteResult::Edges(self.apply_edges(&inputs, None)?)),
            WriteOp::AddBoundedEdges(inputs) => {
                let edges: Vec<_> = inputs.iter().map(|i| i.edge).collect();
                let ends: Vec<_> = inputs.iter().map(|i| i.valid_to).collect();
                Ok(WriteResult::Edges(self.apply_edges(&edges, Some(&ends))?))
            }
            WriteOp::Invalidate(id, t) => {
                self.apply_invalidation(id, t)?;
                Ok(WriteResult::Invalidated(id))
            }
            operation => self.apply_branch(operation),
        }
    }

    /// Register a persistent node through the mutation path.
    pub fn add_node(&mut self, id: NodeId) -> Result<()> {
        self.apply(WriteOp::AddNode(id)).map(|_| ())
    }

    /// Atomically insert a batch, returning IDs in input order.
    pub fn add_edges(&mut self, inputs: &[EdgeInput]) -> Result<Vec<EdgeId>> {
        if inputs.len() > (MAX_FRAME - 20) / 67 {
            return Err(Error::RecordTooLarge);
        }
        match self.apply(WriteOp::AddEdges(inputs.to_vec()))? {
            WriteResult::Edges(ids) => Ok(ids),
            _ => unreachable!(),
        }
    }

    /// Atomically insert versions with explicit ends. This avoids an observable or durable
    /// open interval between separate insert/invalidate calls. Ends never extend predecessors;
    /// late arrivals still truncate an active predecessor and stop at an existing successor.
    pub fn add_edges_bounded(&mut self, inputs: &[BoundedEdgeInput]) -> Result<Vec<EdgeId>> {
        if inputs.len() > (MAX_FRAME - 20) / 67 {
            return Err(Error::RecordTooLarge);
        }
        match self.apply(WriteOp::AddBoundedEdges(inputs.to_vec()))? {
            WriteResult::Edges(ids) => Ok(ids),
            _ => unreachable!(),
        }
    }

    pub(crate) fn prepare_edges(
        &self,
        inputs: &[EdgeInput],
        ends: Option<&[i64]>,
    ) -> Result<Vec<crate::storage::Insert>> {
        self.journal.ensure_writable()?;
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        if inputs.len() > (MAX_FRAME - 20) / 67 {
            return Err(Error::RecordTooLarge);
        }
        let end = self
            .index
            .edges
            .len()
            .checked_add(inputs.len())
            .ok_or(Error::IdExhausted)?;
        u64::try_from(end).map_err(|_| Error::IdExhausted)?;
        for (i, input) in inputs.iter().enumerate() {
            validate_start(input.valid_from)?;
            if let Some(ends) = ends
                && ends[i] < input.valid_from
            {
                return Err(Error::InvalidTimestamp(ends[i]));
            }
        }
        let inserts = if inputs.len() == 1 {
            vec![self.index.prepare_bounded(
                inputs[0],
                EdgeId(self.index.edges.len() as u64),
                ends.map_or(i64::MAX, |e| e[0]),
            )]
        } else {
            self.index.prepare_batch_with_ends(inputs, ends)
        };
        Ok(inserts)
    }

    fn apply_edges(&mut self, inputs: &[EdgeInput], ends: Option<&[i64]>) -> Result<Vec<EdgeId>> {
        let inserts = self.prepare_edges(inputs, ends)?;
        if inserts.is_empty() {
            return Ok(Vec::new());
        }
        let ids = inserts.iter().map(|insert| insert.edge.id).collect();
        let record = Record::Batch(inserts);
        let offset = self.journal.append(&record)?;
        if let Record::Batch(inserts) = record {
            for insert in inserts {
                self.index.apply_insert(insert, offset, true);
            }
        }
        self.index.revision += 1;
        Ok(ids)
    }

    /// Shorten a version's interval, retaining all history.
    ///
    /// Rejects unknown IDs and timestamps before the start. Equal or later ends are
    /// no-ops: invalidation can never extend an interval or resurrect a version.
    fn apply_invalidation(&mut self, id: EdgeId, t: i64) -> Result<()> {
        self.journal.ensure_writable()?;
        let edge = self.edge(id).ok_or(Error::UnknownEdge(id))?;
        if t < edge.valid_from {
            return Err(Error::InvalidTimestamp(t));
        }
        if t >= edge.valid_to {
            return Ok(());
        }
        self.journal.append(&Record::Invalidate(id, t))?;
        self.index.invalidate(id, t, true);
        self.index.revision += 1;
        Ok(())
    }

    /// Shorten a version through the mutation path.
    pub fn invalidate_edge(&mut self, id: EdgeId, t: i64) -> Result<()> {
        self.apply(WriteOp::Invalidate(id, t)).map(|_| ())
    }

    /// Current durable-operation revision, also reconstructed by replay.
    pub fn revision(&self) -> u64 {
        self.index.revision + self.branches.revision
    }

    /// Revision of the parent graph alone, excluding unmerged branch operations.
    pub fn parent_revision(&self) -> u64 {
        self.index.revision
    }

    /// Borrow the graph for immutable operations.
    pub fn view(&self) -> &Self {
        self
    }

    /// Explicitly migrate version-1 input into a new current-format destination.
    /// The source is locked and never modified; the destination must not exist.
    pub fn migrate_v1(
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
    ) -> Result<GraphStats> {
        crate::storage::migrate_v1(source.as_ref(), destination.as_ref())
    }

    /// Upgrade a complete format-2 journal into a new format-3 destination.
    /// The source is locked and never modified; the destination must not exist.
    pub fn migrate_v2(
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
    ) -> Result<GraphStats> {
        crate::storage::migrate_v2(source.as_ref(), destination.as_ref())
    }

    /// Resolve an edge ID, including invalidated and empty versions.
    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        usize::try_from(id.0)
            .ok()
            .and_then(|i| self.index.edges.get(i))
    }

    /// All stored versions in insertion order, including empty and invalidated intervals.
    pub fn history(&self) -> &[Edge] {
        &self.index.edges
    }

    /// All registered nodes, including isolated ones; order is unspecified.
    pub fn nodes(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.index.nodes.keys().copied()
    }

    /// Whether a node has been registered, explicitly or by inserting an incident edge.
    pub fn contains_node(&self, id: NodeId) -> bool {
        self.index.nodes.contains_key(&id)
    }

    /// Borrow a historical view. Construction is O(1); traversing results does actual work.
    pub fn as_of(&self, t: i64) -> GraphView<'_> {
        GraphView { graph: self, t }
    }

    /// Iterate nonempty edge versions overlapping `[start, end)` in insertion order.
    /// Empty or reversed windows return no results. This is an O(E) history scan.
    pub fn between(&self, start: i64, end: i64) -> impl Iterator<Item = Edge> + '_ {
        self.index
            .edges
            .iter()
            .filter(move |edge| edge.overlaps(start, end))
            .copied()
    }

    /// Active outgoing edges, descending by `(valid_from, EdgeId)`.
    ///
    /// Binary search costs O(log d), followed by candidate inspection and output.
    /// The ordered tree bounds candidates by start time; worst-case traversal is O(d).
    pub fn neighbors(&self, node: NodeId, t: i64) -> Neighbors<'_> {
        Neighbors::new(&self.index.edges, self.index.nodes.get(&node), t)
    }

    /// Sample active neighbors without replacement, parallel over the node batch.
    /// Missing nodes and `k == 0` produce empty samples; output follows input-node order.
    pub fn sample_neighbors(
        &self,
        nodes: &[NodeId],
        k: usize,
        t: i64,
        strategy: SampleStrategy,
    ) -> Vec<Vec<EdgeRef>> {
        self.sample_neighbors_seeded(nodes, k, t, strategy, rand::rng().random())
    }

    /// Reproducible sampling, independent of Rayon scheduling and thread count.
    /// Reproduction assumes the same seed, graph history, arguments, and crate/dependency versions.
    pub fn sample_neighbors_seeded(
        &self,
        nodes: &[NodeId],
        k: usize,
        t: i64,
        strategy: SampleStrategy,
        seed: u64,
    ) -> Vec<Vec<EdgeRef>> {
        nodes
            .par_iter()
            .enumerate()
            .map(|(ordinal, &node)| {
                let iter = self.neighbors(node, t);
                if k == 0 {
                    return Vec::new();
                }
                if strategy == SampleStrategy::LatestFirst {
                    return iter.take(k).collect();
                }
                let mut rng = SmallRng::seed_from_u64(
                    seed ^ (ordinal as u64).wrapping_mul(0x9e3779b97f4a7c15)
                        ^ node.0.rotate_left(23),
                );
                let mut reservoir = Vec::with_capacity(k.min(iter.upper));
                for (seen, edge) in iter.enumerate() {
                    if reservoir.len() < k {
                        reservoir.push(edge);
                    } else {
                        let selected = rng.random_range(0..=seen);
                        if selected < k {
                            reservoir[selected] = edge;
                        }
                    }
                }
                reservoir
            })
            .collect()
    }

    /// Materialize the active graph as six nonnullable Arrow columns.
    ///
    /// Columns are `src: UInt64`, `dst: UInt64`, `kind: UInt16`, `valid_from: Int64`,
    /// `valid_to: Int64` (microseconds), and `payload: FixedSizeBinary(16)`.
    /// Buffers are owned by the result; this export copies active edge values.
    pub fn export_arrow(&self, t: i64) -> Result<RecordBatch> {
        edges_to_arrow(self.as_of(t).edges())
    }

    /// Constant-time graph and log statistics.
    pub fn stats(&self) -> GraphStats {
        GraphStats {
            nodes: self.index.nodes.len(),
            edge_versions: self.index.edges.len(),
            log_bytes: self.journal.offset,
            recovered_tail_bytes: self.journal.recovered_tail_bytes,
        }
    }

    /// Flush accepted writes and synchronize the log to the filesystem.
    /// On error the writer is disabled, since the persistent outcome may be ambiguous.
    pub fn sync(&mut self) -> Result<()> {
        self.journal.sync()
    }

    /// Synchronize and consume this handle, releasing the database lock.
    pub fn close(mut self) -> Result<()> {
        self.sync()
    }
}

pub(crate) fn edges_to_arrow(edges: impl IntoIterator<Item = Edge>) -> Result<RecordBatch> {
    let mut src = UInt64Builder::new();
    let mut dst = UInt64Builder::new();
    let mut kind = UInt16Builder::new();
    let mut start = Int64Builder::new();
    let mut end = Int64Builder::new();
    let mut payload = FixedSizeBinaryBuilder::new(16);
    for edge in edges {
        src.append_value(edge.src.0);
        dst.append_value(edge.dst.0);
        kind.append_value(edge.kind.0);
        start.append_value(edge.valid_from);
        end.append_value(edge.valid_to);
        payload.append_value(edge.payload)?;
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("src", DataType::UInt64, false),
        Field::new("dst", DataType::UInt64, false),
        Field::new("kind", DataType::UInt16, false),
        Field::new("valid_from", DataType::Int64, false),
        Field::new("valid_to", DataType::Int64, false),
        Field::new("payload", DataType::FixedSizeBinary(16), false),
    ]));
    let columns: Vec<ArrayRef> = vec![
        Arc::new(src.finish()),
        Arc::new(dst.finish()),
        Arc::new(kind.finish()),
        Arc::new(start.finish()),
        Arc::new(end.finish()),
        Arc::new(payload.finish()),
    ];
    Ok(RecordBatch::try_new(schema, columns)?)
}

fn validate_start(t: i64) -> Result<()> {
    if t == i64::MAX {
        Err(Error::InvalidTimestamp(t))
    } else {
        Ok(())
    }
}

/// A borrowed valid-time view after all operations currently accepted by its graph.
/// Node membership is not temporal; isolated nodes remain registered at every timestamp.
#[derive(Clone, Copy)]
pub struct GraphView<'a> {
    graph: &'a Graph,
    t: i64,
}

impl<'a> GraphView<'a> {
    /// Timestamp in microseconds since Unix epoch.
    pub fn timestamp(&self) -> i64 {
        self.t
    }

    /// All active edge versions in insertion order, using an O(E) contiguous scan.
    /// Whole-graph traversal avoids random adjacency gathers; per-node queries use the temporal index.
    pub fn edges(&self) -> impl Iterator<Item = Edge> + 'a {
        let t = self.t;
        self.graph
            .index
            .edges
            .iter()
            .filter(move |edge| edge.is_valid_at(t))
            .copied()
    }

    /// Active outgoing edge handles for one node at the view's timestamp.
    pub fn neighbors(&self, node: NodeId) -> Neighbors<'a> {
        self.graph.neighbors(node, self.t)
    }
}

/// Allocation-free iterator over active outgoing versions, newest first.
pub struct Neighbors<'a> {
    edges: &'a [Edge],
    range: Option<std::collections::btree_map::Range<'a, (i64, EdgeId), EdgeRef>>,
    upper: usize,
    t: i64,
}

impl<'a> Neighbors<'a> {
    fn new(edges: &'a [Edge], node: Option<&'a Adjacency>, t: i64) -> Self {
        Self {
            edges,
            range: node.map(|n| n.refs.range(..=(t, EdgeId(u64::MAX)))),
            upper: node.map_or(0, |n| n.refs.len()),
            t,
        }
    }
}

impl Iterator for Neighbors<'_> {
    type Item = EdgeRef;
    fn next(&mut self) -> Option<Self::Item> {
        let range = self.range.as_mut()?;
        while let Some((_, reference)) = range.next_back() {
            if self.edges[reference.id.0 as usize].is_valid_at(self.t) {
                return Some(*reference);
            }
        }
        None
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        (0, Some(self.upper))
    }
}
impl std::iter::FusedIterator for Neighbors<'_> {}
