use std::{
    collections::BTreeMap,
    ops::Bound::{Excluded, Unbounded},
    sync::{Arc, Weak},
};

use arrow::record_batch::RecordBatch;
use rand::{Rng, SeedableRng, rngs::SmallRng};
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{
    BoundedEdgeInput, Edge, EdgeId, EdgeInput, EdgeKind, EdgeRemap, Error, ForkId, ForkInfo,
    ForkStatus, ForkWriteOp, Graph, MergeResult, NodeId, NodeRemap, Result, WriteOp, WriteResult,
    index::Index,
    storage::{Insert, MAX_FRAME, MergeData, Record, corrupt},
};

const MAX_ACTIVE: usize = 256;
const MAX_FORKS: usize = 65_536;
type Relation = (NodeId, NodeId, EdgeKind);
type Timeline = BTreeMap<(i64, EdgeId), i64>;

struct Base {
    index: Index,
    origins: Vec<EdgeId>,
}
struct Branch {
    base: Arc<Base>,
    delta: Index,
    overrides: FxHashMap<EdgeId, i64>,
    new_nodes: FxHashSet<NodeId>,
    timestamp: i64,
}
struct Entry {
    info: ForkInfo,
    state: Option<Branch>,
}

#[derive(Default)]
pub(crate) struct BranchStore {
    entries: BTreeMap<ForkId, Entry>,
    bases: FxHashMap<(u64, i64), Weak<Base>>,
    pub revision: u64,
}

impl Branch {
    fn base_len(&self) -> u64 {
        self.base.index.edges.len() as u64
    }
    fn node(&self, id: NodeId) -> bool {
        self.base.index.nodes.contains_key(&id) || self.new_nodes.contains(&id)
    }
    fn register(&mut self, id: NodeId) {
        if !self.base.index.nodes.contains_key(&id) {
            self.new_nodes.insert(id);
        }
    }
    fn time(&self, t: i64) -> Result<()> {
        if t < self.timestamp {
            Err(Error::InvalidTimestamp(t))
        } else {
            Ok(())
        }
    }
    fn edge(&self, id: EdgeId) -> Option<Edge> {
        if id.0 < self.base_len() {
            let mut edge = *self.base.index.edges.get(id.0 as usize)?;
            if let Some(&end) = self.overrides.get(&id) {
                edge.valid_to = end;
            }
            Some(edge)
        } else {
            let ordinal = usize::try_from(id.0 - self.base_len()).ok()?;
            let mut edge = *self.delta.edges.get(ordinal)?;
            edge.id = id;
            Some(edge)
        }
    }
    fn history(&self) -> impl Iterator<Item = Edge> + '_ {
        self.base
            .index
            .edges
            .iter()
            .map(|edge| {
                let mut edge = *edge;
                if let Some(&end) = self.overrides.get(&edge.id) {
                    edge.valid_to = end;
                }
                edge
            })
            .chain(self.delta.edges.iter().map(|edge| {
                let mut edge = *edge;
                edge.id.0 += self.base_len();
                edge
            }))
    }
    fn timeline(&self, relation: Relation) -> Timeline {
        let mut result = Timeline::new();
        for (index, base) in [(&self.base.index, 0), (&self.delta, self.base_len())] {
            if let Some(refs) = index
                .nodes
                .get(&relation.0)
                .and_then(|n| n.timelines.get(&(relation.1, relation.2)))
            {
                for &(t, id) in refs.keys() {
                    let id = EdgeId(id.0 + base);
                    result.insert((t, id), self.edge(id).unwrap().valid_to);
                }
            }
        }
        result
    }
    fn prepare(&self, inputs: &[EdgeInput], ends: Option<&[i64]>) -> Result<Vec<Insert>> {
        if inputs.len() > (MAX_FRAME - 28) / 67 {
            return Err(Error::RecordTooLarge);
        }
        let base = self
            .base_len()
            .checked_add(self.delta.edges.len() as u64)
            .ok_or(Error::IdExhausted)?;
        base.checked_add(inputs.len() as u64)
            .ok_or(Error::IdExhausted)?;
        // Only touched relationship timelines are copied, never the full frozen base.
        let mut working: FxHashMap<Relation, Timeline> = FxHashMap::default();
        let mut inserts = Vec::with_capacity(inputs.len());
        for (ordinal, input) in inputs.iter().enumerate() {
            self.time(input.valid_from)?;
            if input.valid_from == i64::MAX {
                return Err(Error::InvalidTimestamp(input.valid_from));
            }
            let requested_end = ends.map_or(i64::MAX, |e| e[ordinal]);
            if requested_end < input.valid_from {
                return Err(Error::InvalidTimestamp(requested_end));
            }
            let relation = (input.src, input.dst, input.kind);
            let timeline = working
                .entry(relation)
                .or_insert_with(|| self.timeline(relation));
            let bound = (input.valid_from, EdgeId(u64::MAX));
            let end = timeline
                .range((Excluded(bound), Unbounded))
                .next()
                .map_or(i64::MAX, |((t, _), _)| *t)
                .min(requested_end);
            let predecessor =
                timeline
                    .range_mut(..=bound)
                    .next_back()
                    .and_then(|((_, id), end)| {
                        if *end > input.valid_from {
                            *end = input.valid_from;
                            Some(*id)
                        } else {
                            None
                        }
                    });
            let id = EdgeId(base + ordinal as u64);
            timeline.insert((input.valid_from, id), end);
            inserts.push(Insert {
                edge: Edge {
                    id,
                    src: input.src,
                    dst: input.dst,
                    kind: input.kind,
                    valid_from: input.valid_from,
                    valid_to: end,
                    payload: input.payload,
                },
                predecessor,
            });
        }
        Ok(inserts)
    }
    fn invalidate(&mut self, id: EdgeId, t: i64) {
        if id.0 < self.base_len() {
            self.overrides.insert(id, t);
        } else {
            self.delta
                .invalidate(EdgeId(id.0 - self.base_len()), t, true);
        }
    }
    fn insert(&mut self, insert: Insert, offset: u64) {
        if let Some(id) = insert.predecessor {
            self.invalidate(id, insert.edge.valid_from);
        }
        let mut edge = insert.edge;
        self.register(edge.src);
        self.register(edge.dst);
        edge.id.0 -= self.base_len();
        self.delta.apply_insert(
            Insert {
                edge,
                predecessor: None,
            },
            offset,
            true,
        );
    }
    fn check_invalidation(&self, id: EdgeId, t: i64) -> Result<bool> {
        self.time(t)?;
        let edge = self.edge(id).ok_or(Error::UnknownEdge(id))?;
        if t < edge.valid_from {
            return Err(Error::InvalidTimestamp(t));
        }
        Ok(t < edge.valid_to)
    }
}

impl BranchStore {
    fn entry(&self, id: ForkId) -> Result<&Entry> {
        self.entries.get(&id).ok_or(Error::UnknownFork(id))
    }
    fn active(&self, id: ForkId) -> Result<&Branch> {
        self.entry(id)?.state.as_ref().ok_or(Error::ForkClosed(id))
    }
    fn next_id(&self) -> Result<ForkId> {
        let previous = self.entries.last_key_value().map_or(0, |(id, _)| id.0);
        Ok(ForkId(previous.checked_add(1).ok_or(Error::IdExhausted)?))
    }
    fn check_create(&self, id: ForkId, t: i64, name: &str) -> Result<()> {
        if id != self.next_id()? || t == i64::MAX {
            return Err(Error::InvalidFork(
                "invalid identifier or snapshot time".into(),
            ));
        }
        if name.is_empty()
            || name.len() > 80
            || name.trim() != name
            || name.chars().any(char::is_control)
        {
            return Err(Error::InvalidFork("name must be trimmed, nonempty, at most 80 UTF-8 bytes, without control characters".into()));
        }
        if self.entries.len() >= MAX_FORKS
            || self.entries.values().filter(|e| e.state.is_some()).count() >= MAX_ACTIVE
        {
            return Err(Error::InvalidFork(
                "limit of 256 active or 65536 lifetime forks reached".into(),
            ));
        }
        Ok(())
    }
    fn base(&mut self, parent: &Index, t: i64) -> Arc<Base> {
        self.bases.retain(|_, weak| weak.strong_count() != 0);
        let key = (parent.revision, t);
        if let Some(base) = self.bases.get(&key).and_then(Weak::upgrade) {
            return base;
        }
        let mut base = Base {
            index: Index::default(),
            origins: Vec::new(),
        };
        for id in parent.nodes.keys() {
            base.index.nodes.entry(*id).or_default();
        }
        for edge in parent.edges.iter().filter(|e| e.is_valid_at(t)) {
            base.origins.push(edge.id);
            let mut edge = *edge;
            edge.id = EdgeId(base.index.edges.len() as u64);
            edge.valid_to = i64::MAX;
            base.index.apply_insert(
                Insert {
                    edge,
                    predecessor: None,
                },
                0,
                true,
            );
        }
        let base = Arc::new(base);
        self.bases.insert(key, Arc::downgrade(&base));
        base
    }
    fn prepare_merge(&self, parent: &Index, id: ForkId) -> Result<MergeData> {
        let entry = self.entry(id)?;
        let branch = self.active(id)?;
        if entry.info.parent_revision != parent.revision {
            return Err(Error::ForkConflict(
                "parent revision changed since the fork".into(),
            ));
        }
        let maximum = 44
            + branch.new_nodes.len() as u128 * 16
            + branch.delta.edges.len() as u128 * 67
            + branch.overrides.len() as u128 * 16;
        if maximum > MAX_FRAME as u128 {
            return Err(Error::RecordTooLarge);
        }
        let mut touched: FxHashSet<Relation> = FxHashSet::default();
        for edge in &branch.delta.edges {
            touched.insert((edge.src, edge.dst, edge.kind));
        }
        for id in branch.overrides.keys() {
            let edge = branch.edge(*id).unwrap();
            touched.insert((edge.src, edge.dst, edge.kind));
        }
        for (src, dst, kind) in touched {
            if let Some(timeline) = parent
                .nodes
                .get(&src)
                .and_then(|n| n.timelines.get(&(dst, kind)))
            {
                for r in timeline.values() {
                    let edge = &parent.edges[r.id.0 as usize];
                    if edge.valid_from > branch.timestamp
                        || (edge.is_valid_at(branch.timestamp) && edge.valid_to != i64::MAX)
                    {
                        return Err(Error::ForkConflict("a touched relationship has known future versions or a finite future expiration".into()));
                    }
                }
            }
        }
        let mut local: Vec<_> = branch.new_nodes.iter().copied().collect();
        local.sort_unstable();
        let mut nodes = Vec::with_capacity(local.len());
        let mut available = 0u64;
        for branch in local {
            while parent.nodes.contains_key(&NodeId(available)) {
                available = available.checked_add(1).ok_or(Error::IdExhausted)?;
            }
            nodes.push(NodeRemap {
                branch,
                parent: NodeId(available),
            });
            available = available.checked_add(1).ok_or(Error::IdExhausted)?;
        }
        let remap: FxHashMap<_, _> = nodes.iter().map(|n| (n.branch, n.parent)).collect();
        let inputs: Vec<_> = branch
            .delta
            .edges
            .iter()
            .map(|e| EdgeInput {
                src: remap.get(&e.src).copied().unwrap_or(e.src),
                dst: remap.get(&e.dst).copied().unwrap_or(e.dst),
                kind: e.kind,
                valid_from: e.valid_from,
                payload: e.payload,
            })
            .collect();
        let ends: Vec<_> = branch.delta.edges.iter().map(|e| e.valid_to).collect();
        let mut invalidations: Vec<_> = branch
            .overrides
            .iter()
            .map(|(id, t)| (branch.base.origins[id.0 as usize], *t))
            .collect();
        invalidations.sort_unstable_by_key(|(id, _)| *id);
        let overrides: FxHashMap<_, _> = invalidations.iter().copied().collect();
        let inserts = parent.prepare_batch_overrides(&inputs, Some(&ends), Some(&overrides));
        let maximum = 44
            + nodes.len() as u128 * 16
            + inserts.len() as u128 * 67
            + invalidations.len() as u128 * 16;
        if maximum > MAX_FRAME as u128 {
            return Err(Error::RecordTooLarge);
        }
        Ok(MergeData {
            fork: id,
            nodes,
            inserts,
            invalidations,
        })
    }
    fn write_done(&mut self, id: ForkId) {
        let entry = self.entries.get_mut(&id).unwrap();
        let branch = entry.state.as_ref().unwrap();
        entry.info.revision += 1;
        entry.info.delta_edges = branch.delta.edges.len();
        entry.info.new_nodes = branch.new_nodes.len();
        self.revision += 1;
    }
    fn merge_result(&self, data: &MergeData, parent_revision: u64) -> Result<MergeResult> {
        let branch = self.active(data.fork)?;
        let mut edges: Vec<_> = branch
            .overrides
            .keys()
            .map(|id| EdgeRemap {
                branch: *id,
                parent: branch.base.origins[id.0 as usize],
            })
            .collect();
        edges.extend(
            data.inserts
                .iter()
                .enumerate()
                .map(|(ordinal, i)| EdgeRemap {
                    branch: EdgeId(branch.base_len() + ordinal as u64),
                    parent: i.edge.id,
                }),
        );
        edges.sort_unstable_by_key(|e| e.branch);
        Ok(MergeResult {
            fork: data.fork,
            parent_revision,
            nodes: data.nodes.clone(),
            edges,
        })
    }
    pub fn replay(&mut self, parent: &mut Index, record: Record, offset: u64) -> Result<()> {
        // Every branch record is fully checked before changing visible in-memory state.
        let result = self.replay_inner(parent, record, offset);
        result.map_err(|e| match e {
            Error::Corrupt { .. } | Error::UnsupportedFormat(_) => e,
            other => corrupt(offset, format!("invalid branch record: {other}")),
        })
    }
    fn replay_inner(&mut self, parent: &mut Index, record: Record, offset: u64) -> Result<()> {
        match record {
            Record::ForkCreate {
                id,
                parent_revision,
                timestamp,
                name,
            } => {
                self.check_create(id, timestamp, &name)?;
                if parent_revision != parent.revision {
                    return Err(Error::ForkConflict("fork base revision mismatch".into()));
                }
                let base = self.base(parent, timestamp);
                let info = ForkInfo {
                    id,
                    name,
                    timestamp,
                    parent_revision,
                    revision: 0,
                    inherited_edges: base.index.edges.len(),
                    delta_edges: 0,
                    new_nodes: 0,
                    status: ForkStatus::Active,
                    merge: None,
                };
                self.entries.insert(
                    id,
                    Entry {
                        info,
                        state: Some(Branch {
                            base,
                            delta: Index::default(),
                            overrides: FxHashMap::default(),
                            new_nodes: FxHashSet::default(),
                            timestamp,
                        }),
                    },
                );
                self.revision += 1;
            }
            Record::ForkNode(id, node) => {
                if self.active(id)?.node(node) {
                    return Err(Error::InvalidFork("duplicate node record".into()));
                }
                self.entries
                    .get_mut(&id)
                    .unwrap()
                    .state
                    .as_mut()
                    .unwrap()
                    .register(node);
                self.write_done(id);
            }
            Record::ForkBatch(id, inserts) => {
                if inserts.is_empty() {
                    return Err(Error::InvalidFork("empty branch batch".into()));
                }
                let inputs: Vec<_> = inserts
                    .iter()
                    .map(|i| EdgeInput {
                        src: i.edge.src,
                        dst: i.edge.dst,
                        kind: i.edge.kind,
                        valid_from: i.edge.valid_from,
                        payload: i.edge.payload,
                    })
                    .collect();
                let ends: Vec<_> = inserts.iter().map(|i| i.edge.valid_to).collect();
                if self.active(id)?.prepare(&inputs, Some(&ends))? != inserts {
                    return Err(Error::InvalidFork(
                        "branch insert IDs, intervals or predecessors do not match its timeline"
                            .into(),
                    ));
                }
                let branch = self.entries.get_mut(&id).unwrap().state.as_mut().unwrap();
                for insert in inserts {
                    branch.insert(insert, offset);
                }
                self.write_done(id);
            }
            Record::ForkInvalidate(id, edge, t) => {
                if !self.active(id)?.check_invalidation(edge, t)? {
                    return Err(Error::InvalidFork(
                        "non-shortening invalidation record".into(),
                    ));
                }
                self.entries
                    .get_mut(&id)
                    .unwrap()
                    .state
                    .as_mut()
                    .unwrap()
                    .invalidate(edge, t);
                self.write_done(id);
            }
            Record::ForkDiscard(id) => {
                self.active(id)?;
                let entry = self.entries.get_mut(&id).unwrap();
                entry.state = None;
                entry.info.status = ForkStatus::Discarded;
                self.revision += 1;
                self.bases.retain(|_, weak| weak.strong_count() != 0);
            }
            Record::ForkMerge(data) => {
                if self.prepare_merge(parent, data.fork)? != data {
                    return Err(Error::ForkConflict(
                        "merge record does not match the prepared delta".into(),
                    ));
                }
                let branch = self.active(data.fork)?;
                let mut edges: Vec<_> = branch
                    .overrides
                    .keys()
                    .map(|id| EdgeRemap {
                        branch: *id,
                        parent: branch.base.origins[id.0 as usize],
                    })
                    .collect();
                edges.extend(
                    data.inserts
                        .iter()
                        .enumerate()
                        .map(|(ordinal, i)| EdgeRemap {
                            branch: EdgeId(branch.base_len() + ordinal as u64),
                            parent: i.edge.id,
                        }),
                );
                edges.sort_unstable_by_key(|e| e.branch);
                for node in &data.nodes {
                    parent.nodes.entry(node.parent).or_default();
                }
                for (id, t) in data.invalidations {
                    parent.invalidate(id, t, true);
                }
                for insert in data.inserts {
                    parent.apply_insert(insert, offset, true);
                }
                parent.revision += 1;
                let entry = self.entries.get_mut(&data.fork).unwrap();
                entry.info.status = ForkStatus::Merged;
                entry.info.merge = Some(MergeResult {
                    fork: data.fork,
                    parent_revision: parent.revision,
                    nodes: data.nodes,
                    edges,
                });
                entry.state = None;
                self.bases.retain(|_, weak| weak.strong_count() != 0);
            }
            other => parent.replay(other, offset)?,
        }
        Ok(())
    }
}

impl Graph {
    /// Freeze the parent state active at `timestamp` into a durable, isolated fork.
    /// Same-time forks at the same parent revision share one immutable base.
    pub fn fork(&mut self, timestamp: i64) -> Result<ForkId> {
        let id = self.branches.next_id()?;
        self.fork_named(timestamp, format!("fork-{}", id.0))
    }
    /// Create a fork with a trimmed label of 1–80 UTF-8 bytes without control characters.
    /// At most 256 forks may be active and 65536 may be created in one database.
    pub fn fork_named(&mut self, timestamp: i64, name: impl Into<String>) -> Result<ForkId> {
        match self.apply(WriteOp::Fork {
            timestamp,
            name: name.into(),
        })? {
            WriteResult::Fork(id) => Ok(id),
            _ => unreachable!(),
        }
    }
    /// Write to one selected fork. Edge IDs in the operation are local to that fork.
    pub fn write_fork(&mut self, fork: ForkId, operation: ForkWriteOp) -> Result<WriteResult> {
        self.apply(WriteOp::ForkWrite { fork, operation })
    }
    /// Atomically add an ordered batch to a fork, returning fork-local edge IDs.
    pub fn add_edges_to_fork(&mut self, fork: ForkId, inputs: &[EdgeInput]) -> Result<Vec<EdgeId>> {
        if inputs.len() > (MAX_FRAME - 28) / 67 {
            return Err(Error::RecordTooLarge);
        }
        match self.write_fork(fork, ForkWriteOp::AddEdges(inputs.to_vec()))? {
            WriteResult::Edges(ids) => Ok(ids),
            _ => unreachable!(),
        }
    }
    /// Atomically add versions with explicit exclusive ends to a fork.
    pub fn add_bounded_edges_to_fork(
        &mut self,
        fork: ForkId,
        inputs: &[BoundedEdgeInput],
    ) -> Result<Vec<EdgeId>> {
        if inputs.len() > (MAX_FRAME - 28) / 67 {
            return Err(Error::RecordTooLarge);
        }
        match self.write_fork(fork, ForkWriteOp::AddBoundedEdges(inputs.to_vec()))? {
            WriteResult::Edges(ids) => Ok(ids),
            _ => unreachable!(),
        }
    }
    /// Merge a fork atomically if the parent is unchanged and touched timelines have no known
    /// future observations/expirations. New node/edge IDs are remapped; payload bytes are unchanged.
    /// Merged forks retain their result and return it on retries without another journal write.
    pub fn merge(&mut self, fork: ForkId) -> Result<MergeResult> {
        match self.apply(WriteOp::MergeFork(fork))? {
            WriteResult::Merged(result) => Ok(result),
            _ => unreachable!(),
        }
    }
    /// Validate a merge and return its proposed mappings without changing either graph.
    /// A later parent write can invalidate this preview; the actual merge validates again.
    pub fn preview_merge(&self, fork: ForkId) -> Result<MergeResult> {
        let data = self.branches.prepare_merge(&self.index, fork)?;
        self.branches.merge_result(&data, self.index.revision + 1)
    }
    /// Durably discard a fork. Repeating a successful discard is a no-op.
    pub fn discard(&mut self, fork: ForkId) -> Result<()> {
        self.apply(WriteOp::DiscardFork(fork)).map(|_| ())
    }
    /// Metadata for every active or closed fork, ordered by ID.
    pub fn forks(&self) -> impl Iterator<Item = &ForkInfo> {
        self.branches.entries.values().map(|e| &e.info)
    }
    /// Look up metadata, including retained merge results after closure.
    pub fn fork_info(&self, fork: ForkId) -> Result<&ForkInfo> {
        Ok(&self.branches.entry(fork)?.info)
    }
    /// All versions in a selected active fork, including invalidated and empty intervals.
    pub fn fork_history(&self, fork: ForkId) -> Result<impl Iterator<Item = Edge> + '_> {
        Ok(self.branches.active(fork)?.history())
    }
    /// Resolve a fork-local version, including inherited and invalidated versions.
    pub fn fork_edge(&self, fork: ForkId, edge: EdgeId) -> Result<Option<Edge>> {
        Ok(self.branches.active(fork)?.edge(edge))
    }
    /// Borrow an immutable snapshot at or after a fork's creation time.
    pub fn fork_view(&self, fork: ForkId, t: i64) -> Result<ForkView<'_>> {
        let branch = self.branches.active(fork)?;
        branch.time(t)?;
        Ok(ForkView { branch, t })
    }
    /// Versions overlapping a window in an active fork. A start before the fork is rejected.
    pub fn fork_between(
        &self,
        fork: ForkId,
        start: i64,
        end: i64,
    ) -> Result<impl Iterator<Item = Edge> + '_> {
        let branch = self.branches.active(fork)?;
        branch.time(start)?;
        Ok(branch.history().filter(move |e| e.overlaps(start, end)))
    }
    pub(crate) fn apply_branch(&mut self, operation: WriteOp) -> Result<WriteResult> {
        self.journal.ensure_writable()?;
        let (record, result) = match operation {
            WriteOp::Fork { timestamp, name } => {
                let id = self.branches.next_id()?;
                self.branches.check_create(id, timestamp, &name)?;
                (
                    Record::ForkCreate {
                        id,
                        timestamp,
                        name,
                        parent_revision: self.index.revision,
                    },
                    WriteResult::Fork(id),
                )
            }
            WriteOp::ForkWrite { fork, operation } => {
                let branch = self.branches.active(fork)?;
                match operation {
                    ForkWriteOp::AddNode(node) => {
                        if branch.node(node) {
                            return Ok(WriteResult::Node(node));
                        }
                        (Record::ForkNode(fork, node), WriteResult::Node(node))
                    }
                    ForkWriteOp::Invalidate(id, t) => {
                        if !branch.check_invalidation(id, t)? {
                            return Ok(WriteResult::Invalidated(id));
                        }
                        (
                            Record::ForkInvalidate(fork, id, t),
                            WriteResult::Invalidated(id),
                        )
                    }
                    other => {
                        let inserts = match other {
                            ForkWriteOp::AddEdges(inputs) => branch.prepare(&inputs, None)?,
                            ForkWriteOp::AddBoundedEdges(inputs) => {
                                let edges: Vec<_> = inputs.iter().map(|i| i.edge).collect();
                                let ends: Vec<_> = inputs.iter().map(|i| i.valid_to).collect();
                                branch.prepare(&edges, Some(&ends))?
                            }
                            _ => unreachable!(),
                        };
                        let result =
                            WriteResult::Edges(inserts.iter().map(|i| i.edge.id).collect());
                        if inserts.is_empty() {
                            return Ok(result);
                        }
                        (Record::ForkBatch(fork, inserts), result)
                    }
                }
            }
            WriteOp::MergeFork(fork) => {
                if let Some(result) = &self.branches.entry(fork)?.info.merge {
                    return Ok(WriteResult::Merged(result.clone()));
                }
                let data = self.branches.prepare_merge(&self.index, fork)?;
                let offset = self.journal.append(&Record::ForkMerge(data.clone()))?;
                self.branches
                    .replay(&mut self.index, Record::ForkMerge(data), offset)?;
                return Ok(WriteResult::Merged(
                    self.branches.entry(fork)?.info.merge.clone().unwrap(),
                ));
            }
            WriteOp::DiscardFork(fork) => {
                if self.branches.entry(fork)?.info.status == ForkStatus::Discarded {
                    return Ok(WriteResult::Discarded(fork));
                }
                self.branches.active(fork)?;
                (Record::ForkDiscard(fork), WriteResult::Discarded(fork))
            }
            _ => unreachable!(),
        };
        let offset = self.journal.append(&record)?;
        self.branches.replay(&mut self.index, record, offset)?;
        Ok(result)
    }
}

/// Borrowed view of an active fork. Its edge IDs belong to this fork, not to the parent.
#[derive(Clone, Copy)]
pub struct ForkView<'a> {
    branch: &'a Branch,
    t: i64,
}
impl<'a> ForkView<'a> {
    /// Selected timestamp in microseconds.
    pub fn timestamp(&self) -> i64 {
        self.t
    }
    /// Active versions in stable fork-local insertion order; scans the frozen base and delta.
    pub fn edges(&self) -> impl Iterator<Item = Edge> + 'a {
        let t = self.t;
        self.branch.history().filter(move |e| e.is_valid_at(t))
    }
    /// Known inherited and branch-local nodes. Node identity is not temporal.
    pub fn nodes(&self) -> impl Iterator<Item = NodeId> + 'a {
        self.branch
            .base
            .index
            .nodes
            .keys()
            .chain(self.branch.new_nodes.iter())
            .copied()
    }
    /// Active outgoing versions, newest first. Uses per-node temporal indexes in base and delta.
    pub fn neighbors(&self, node: NodeId) -> Vec<Edge> {
        let mut edges = Vec::new();
        for (index, base) in [
            (&self.branch.base.index, 0),
            (&self.branch.delta, self.branch.base_len()),
        ] {
            if let Some(n) = index.nodes.get(&node) {
                for (_, r) in n.refs.range(..=(self.t, EdgeId(u64::MAX))) {
                    let edge = self.branch.edge(EdgeId(r.id.0 + base)).unwrap();
                    if edge.is_valid_at(self.t) {
                        edges.push(edge);
                    }
                }
            }
        }
        edges.sort_unstable_by_key(|e| std::cmp::Reverse((e.valid_from, e.id)));
        edges
    }
    /// Copy active versions to the same six-column Arrow schema as the parent graph.
    pub fn export_arrow(&self) -> Result<RecordBatch> {
        crate::graph::edges_to_arrow(self.edges())
    }

    /// Deterministic sampling without replacement, parallel over nodes. Output follows input
    /// node order. Reproduction requires identical fork history, arguments and dependency versions.
    pub fn sample_neighbors_seeded(
        &self,
        nodes: &[NodeId],
        k: usize,
        strategy: crate::SampleStrategy,
        seed: u64,
    ) -> Vec<Vec<Edge>> {
        nodes
            .par_iter()
            .enumerate()
            .map(|(ordinal, &node)| {
                if k == 0 {
                    return Vec::new();
                }
                let candidates = self.neighbors(node);
                if strategy == crate::SampleStrategy::LatestFirst {
                    return candidates.into_iter().take(k).collect();
                }
                let mut rng = SmallRng::seed_from_u64(
                    seed ^ (ordinal as u64).wrapping_mul(0x9e3779b97f4a7c15)
                        ^ node.0.rotate_left(23),
                );
                let mut reservoir = Vec::with_capacity(k.min(candidates.len()));
                for (seen, edge) in candidates.into_iter().enumerate() {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_hundred_forks_share_one_frozen_base_and_release_it_when_closed() {
        let path = std::env::temp_dir().join(format!(
            "chronograph-shared-base-{}.cgraph",
            std::process::id()
        ));
        let mut g = Graph::open(&path).unwrap();
        g.add_edge(NodeId(1), NodeId(2), EdgeKind(0), 0, [0; 16])
            .unwrap();
        let ids: Vec<_> = (0..100).map(|_| g.fork(10).unwrap()).collect();
        assert_eq!(g.branches.bases.len(), 1);
        let base = &g.branches.active(ids[0]).unwrap().base;
        assert_eq!(Arc::strong_count(base), 100);
        for id in &ids {
            assert!(Arc::ptr_eq(base, &g.branches.active(*id).unwrap().base));
        }
        g.add_edges_to_fork(
            ids[0],
            &[EdgeInput {
                src: NodeId(1),
                dst: NodeId(2),
                kind: EdgeKind(0),
                valid_from: 20,
                payload: [1; 16],
            }],
        )
        .unwrap();
        assert_eq!(g.branches.active(ids[0]).unwrap().delta.edges.len(), 1);
        assert!(g.branches.active(ids[1]).unwrap().delta.edges.is_empty());
        for id in ids {
            g.discard(id).unwrap();
        }
        assert!(g.branches.bases.is_empty());
        g.close().unwrap();
        let g = Graph::open(&path).unwrap();
        assert!(g.branches.bases.is_empty());
        drop(g);
        std::fs::remove_file(path).unwrap();
    }
}
