use std::collections::BTreeMap;
use std::ops::Bound::{Excluded, Unbounded};

use rayon::prelude::*;
use rustc_hash::FxHashMap;

use crate::{
    Edge, EdgeId, EdgeInput, EdgeKind, EdgeRef, NodeId, Result,
    storage::{Insert, Record, corrupt},
};

type Relation = (NodeId, EdgeKind);

#[derive(Default)]
pub(crate) struct Adjacency {
    pub refs: BTreeMap<(i64, EdgeId), EdgeRef>,
    pub timelines: FxHashMap<Relation, BTreeMap<(i64, EdgeId), EdgeRef>>,
}

#[derive(Default)]
pub(crate) struct Index {
    pub nodes: FxHashMap<NodeId, Adjacency>,
    pub edges: Vec<Edge>,
    // The frame offset is sufficient to locate an edge; a batch shares one frame.
    pub offsets: Vec<u64>,
    pub revision: u64,
}

impl Index {
    pub fn prepare_bounded(&self, input: EdgeInput, id: EdgeId, end: i64) -> Insert {
        let mut insert = self.prepare(input, id);
        insert.edge.valid_to = insert.edge.valid_to.min(end);
        insert
    }
    pub fn prepare(&self, input: EdgeInput, id: EdgeId) -> Insert {
        let timeline = self
            .nodes
            .get(&input.src)
            .and_then(|n| n.timelines.get(&(input.dst, input.kind)));
        let key = (input.valid_from, EdgeId(u64::MAX));
        let end = timeline
            .and_then(|t| t.range((Excluded(key), Unbounded)).next())
            .map_or(i64::MAX, |((start, _), _)| *start);
        let predecessor = timeline
            .and_then(|t| t.range(..=key).next_back())
            .and_then(|(_, r)| {
                let edge = &self.edges[r.id.0 as usize];
                edge.is_valid_at(input.valid_from).then_some(edge.id)
            });
        Insert {
            edge: from_input(input, id, end),
            predecessor,
        }
    }

    pub fn prepare_batch_with_ends(
        &self,
        inputs: &[EdgeInput],
        ends: Option<&[i64]>,
    ) -> Vec<Insert> {
        self.prepare_batch_overrides(inputs, ends, None)
    }

    pub fn prepare_batch_overrides(
        &self,
        inputs: &[EdgeInput],
        ends: Option<&[i64]>,
        overrides: Option<&FxHashMap<EdgeId, i64>>,
    ) -> Vec<Insert> {
        let base = self.edges.len() as u64;
        let mut order: Vec<_> = (0..inputs.len()).collect();
        order.sort_unstable_by_key(|&i| (inputs[i].src, i));
        let prepared: Vec<Vec<(usize, Insert)>> = order
            .par_chunk_by(|&a, &b| inputs[a].src == inputs[b].src)
            .map(|ordinals| {
                if ordinals.len() == 1 {
                    let ordinal = ordinals[0];
                    let mut insert = self.prepare_bounded(
                        inputs[ordinal],
                        EdgeId(base + ordinal as u64),
                        ends.map_or(i64::MAX, |e| e[ordinal]),
                    );
                    if let Some(id) = insert.predecessor
                        && overrides
                            .and_then(|o| o.get(&id))
                            .is_some_and(|end| *end <= insert.edge.valid_from)
                    {
                        insert.predecessor = None;
                    }
                    return vec![(ordinal, insert)];
                }
                let src = inputs[ordinals[0]].src;
                let mut working: FxHashMap<Relation, BTreeMap<(i64, EdgeId), i64>> =
                    FxHashMap::default();
                let mut result = Vec::with_capacity(ordinals.len());
                for &ordinal in ordinals {
                    let input = inputs[ordinal];
                    let timeline = working.entry((input.dst, input.kind)).or_insert_with(|| {
                        self.nodes
                            .get(&src)
                            .and_then(|n| n.timelines.get(&(input.dst, input.kind)))
                            .map(|refs| {
                                refs.iter()
                                    .map(|(&key, r)| {
                                        (
                                            key,
                                            overrides
                                                .and_then(|o| o.get(&r.id))
                                                .copied()
                                                .unwrap_or(self.edges[r.id.0 as usize].valid_to),
                                        )
                                    })
                                    .collect()
                            })
                            .unwrap_or_default()
                    });
                    let bound = (input.valid_from, EdgeId(u64::MAX));
                    let end = timeline
                        .range((Excluded(bound), Unbounded))
                        .next()
                        .map_or(i64::MAX, |((t, _), _)| *t)
                        .min(ends.map_or(i64::MAX, |e| e[ordinal]));
                    let predecessor =
                        timeline
                            .range_mut(..=bound)
                            .next_back()
                            .and_then(|((_, id), to)| {
                                if *to > input.valid_from {
                                    *to = input.valid_from;
                                    Some(*id)
                                } else {
                                    None
                                }
                            });
                    let id = EdgeId(base + ordinal as u64);
                    timeline.insert((input.valid_from, id), end);
                    result.push((
                        ordinal,
                        Insert {
                            edge: from_input(input, id, end),
                            predecessor,
                        },
                    ));
                }
                result
            })
            .collect();
        let mut ordered: Vec<_> = prepared.into_iter().flatten().collect();
        ordered.par_sort_unstable_by_key(|(ordinal, _)| *ordinal);
        ordered.into_iter().map(|(_, insert)| insert).collect()
    }

    pub fn apply_insert(&mut self, insert: Insert, offset: u64, _maintain_order: bool) {
        let edge = insert.edge;
        if let Some(id) = insert.predecessor {
            self.edges[id.0 as usize].valid_to = edge.valid_from;
        }
        self.edges.push(edge);
        self.offsets.push(offset);
        let reference = EdgeRef { id: edge.id };
        let node = self.nodes.entry(edge.src).or_default();
        node.timelines
            .entry((edge.dst, edge.kind))
            .or_default()
            .insert((edge.valid_from, edge.id), reference);
        node.refs.insert((edge.valid_from, edge.id), reference);
        self.nodes.entry(edge.dst).or_default();
    }

    pub fn invalidate(&mut self, id: EdgeId, t: i64, _maintain_order: bool) {
        self.edges[id.0 as usize].valid_to = t;
    }

    pub fn finish(&mut self) {}

    pub fn replay(&mut self, record: Record, offset: u64) -> Result<()> {
        match record {
            Record::Node(id) => {
                self.nodes.entry(id).or_default();
            }
            Record::Insert(insert) => self.replay_insert(insert, offset)?,
            Record::Batch(inserts) => {
                for insert in inserts {
                    self.replay_insert(insert, offset)?;
                }
            }
            Record::Invalidate(id, t) => {
                let edge = usize::try_from(id.0)
                    .ok()
                    .and_then(|i| self.edges.get(i))
                    .ok_or_else(|| corrupt(offset, "invalidation of missing edge"))?;
                if t < edge.valid_from || t > edge.valid_to {
                    return Err(corrupt(offset, "invalid interval shortening"));
                }
                self.invalidate(id, t, false);
            }
            _ => return Err(corrupt(offset, "branch record routed to main index")),
        }
        self.revision += 1;
        Ok(())
    }

    fn replay_insert(&mut self, insert: Insert, offset: u64) -> Result<()> {
        let edge = insert.edge;
        if edge.id.0 != self.edges.len() as u64
            || edge.valid_from == i64::MAX
            || edge.valid_to < edge.valid_from
        {
            return Err(corrupt(offset, "invalid edge ID or interval"));
        }
        if let Some(id) = insert.predecessor {
            let old = usize::try_from(id.0)
                .ok()
                .and_then(|i| self.edges.get(i))
                .ok_or_else(|| corrupt(offset, "missing predecessor"))?;
            if (old.src, old.dst, old.kind) != (edge.src, edge.dst, edge.kind)
                || !old.is_valid_at(edge.valid_from)
            {
                return Err(corrupt(offset, "invalid predecessor"));
            }
        }
        self.apply_insert(insert, offset, false);
        Ok(())
    }
}

fn from_input(input: EdgeInput, id: EdgeId, valid_to: i64) -> Edge {
    Edge {
        id,
        src: input.src,
        dst: input.dst,
        kind: input.kind,
        valid_from: input.valid_from,
        valid_to,
        payload: input.payload,
    }
}
