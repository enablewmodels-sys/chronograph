//! Episode acquisition over the public graph API, with explicit complete-state codecs.
use arrow::record_batch::RecordBatch;
use chronograph_connector_common::{self as common, ArrowStore};
use chronograph_db::{Edge, EdgeId, EdgeInput, EdgeKind, ForkId, Graph, NodeId};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::HashMap;
pub mod gridworld;

const FORMAT: &str = "worldmodel-v1";
const MAX_STEPS: usize = 100_000;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid world-model input: {0}")]
    Invalid(String),
    #[error(transparent)]
    Graph(#[from] chronograph_db::Error),
    #[error(transparent)]
    Sidecar(#[from] common::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub environment_id: String,
    pub environment_node: u64,
    pub episode_base: u64,
    pub max_episodes: u64,
    pub state_kind: u16,
    pub state_codec: String,
    pub observation_dim: usize,
    pub action_count: u32,
    pub clock_domain: String,
}
impl Mapping {
    pub fn from_toml(text: &str) -> Result<Self> {
        let v: Self = toml::from_str(text)?;
        v.validate()?;
        Ok(v)
    }
    pub fn validate(&self) -> Result<()> {
        let end = self.episode_base.checked_add(self.max_episodes);
        if !(1..=1_000_000).contains(&self.max_episodes)
            || end.is_none()
            || (self.episode_base..end.unwrap_or(0)).contains(&self.environment_node)
            || self.environment_id.is_empty()
            || self.environment_id.len() > 128
            || self.state_codec.is_empty()
            || self.state_codec.len() > 128
            || !(1..=4096).contains(&self.observation_dim)
            || !(1..=1_000_000).contains(&self.action_count)
            || !matches!(self.clock_domain.as_str(), "simulation_us" | "unix_us")
        {
            return Err(Error::Invalid("invalid environment/episode namespace, codec, observation shape, discrete action space or clock".into()));
        }
        Ok(())
    }
    fn metadata(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }
    pub fn episode_node(&self, episode: u64) -> Result<NodeId> {
        self.validate()?;
        if episode >= self.max_episodes {
            return Err(Error::Invalid("episode outside mapped namespace".into()));
        }
        Ok(NodeId(self.episode_base + episode))
    }
}
/// Implement for a versioned environment-specific state containing every variable and RNG state
/// needed to resume dynamics. Observations alone are not a complete state codec.
pub trait StateCodec {
    const ID: &'static str;
    type State: Clone + Serialize + DeserializeOwned;
    /// Validate the state, its derived observation, and codec-specific step invariants.
    fn validate(step: &Step<Self::State>) -> Result<()>;
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step<S> {
    pub episode: u64,
    pub index: u64,
    pub timestamp_us: i64,
    /// Observation after the action; index zero is the reset observation.
    pub observation: Vec<f64>,
    /// None only for the reset record; otherwise a zero-based discrete action.
    pub action: Option<u32>,
    pub reward: f64,
    pub terminated: bool,
    pub truncated: bool,
    pub state: S,
}
fn validate<C: StateCodec>(map: &Mapping, step: &Step<C::State>) -> Result<()> {
    map.episode_node(step.episode)?;
    if map.state_codec != C::ID
        || step.index >= MAX_STEPS as u64
        || step.timestamp_us == i64::MAX
        || step.observation.len() != map.observation_dim
        || step.observation.iter().any(|v| !v.is_finite())
        || !step.reward.is_finite()
        || step.action.is_some_and(|v| v >= map.action_count)
        || (step.index == 0
            && (step.action.is_some() || step.reward != 0.0 || step.terminated || step.truncated))
        || (step.index != 0 && step.action.is_none())
    {
        return Err(Error::Invalid(
            "invalid step/observation/action or wrong state codec".into(),
        ));
    }
    C::validate(step)
}
/// Decode a validated graph edge, including an edge obtained from an independent graph view.
pub fn decode_edge<C: StateCodec>(
    store: &ArrowStore,
    map: &Mapping,
    edge: &Edge,
) -> Result<Step<C::State>> {
    map.validate()?;
    if edge.dst.0 != map.environment_node
        || edge.kind.0 != map.state_kind
        || edge.src.0 < map.episode_base
        || edge.src.0 >= map.episode_base + map.max_episodes
    {
        return Err(Error::Invalid(
            "edge is outside the environment mapping".into(),
        ));
    }
    let (batch, row) = store.read(edge.payload)?;
    let step: Step<C::State> = common::decode(&batch, row, FORMAT, &map.metadata()?)?;
    validate::<C>(map, &step)?;
    if map.episode_node(step.episode)? != edge.src || step.timestamp_us != edge.valid_from {
        return Err(Error::Invalid("graph/sidecar state mismatch".into()));
    }
    Ok(step)
}
/// Append contiguous steps in strictly increasing time per episode. Reset must be index zero;
/// finished episodes cannot be extended. One sidecar sync precedes one atomic graph append.
pub fn ingest<C: StateCodec>(
    graph: &mut Graph,
    store: &ArrowStore,
    map: &Mapping,
    steps: &[Step<C::State>],
) -> Result<Vec<EdgeId>> {
    ingest_into::<C>(graph, store, map, steps, None)
}
/// Continue an inherited episode in an active fork. Register the environment and reset episode
/// in the parent before forking, so a later merge preserves the mapping's node identities.
/// Parent future steps are excluded: validation resumes from the fork's latest stored state.
pub fn ingest_fork<C: StateCodec>(
    graph: &mut Graph,
    store: &ArrowStore,
    map: &Mapping,
    fork: ForkId,
    steps: &[Step<C::State>],
) -> Result<Vec<EdgeId>> {
    let info = graph.fork_info(fork)?;
    graph.fork_view(fork, info.timestamp)?;
    for step in steps {
        if step.timestamp_us < info.timestamp
            || !graph.contains_node(map.episode_node(step.episode)?)
            || !graph.contains_node(NodeId(map.environment_node))
        {
            return Err(Error::Invalid("fork steps require inherited episode/environment nodes and times at or after the fork".into()));
        }
    }
    ingest_into::<C>(graph, store, map, steps, Some(fork))
}
fn ingest_into<C: StateCodec>(
    graph: &mut Graph,
    store: &ArrowStore,
    map: &Mapping,
    steps: &[Step<C::State>],
    fork: Option<ForkId>,
) -> Result<Vec<EdgeId>> {
    map.validate()?;
    if steps.is_empty() || steps.len() > MAX_STEPS {
        return Err(Error::Invalid("require 1–100000 steps".into()));
    }
    let mut latest = HashMap::new();
    for step in steps {
        validate::<C>(map, step)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = latest.entry(step.episode) {
            let node = map.episode_node(step.episode)?;
            let matches = |e: &Edge| {
                e.src == node && e.dst.0 == map.environment_node && e.kind.0 == map.state_kind
            };
            let last = if let Some(fork) = fork {
                graph.fork_history(fork)?.filter(matches).last()
            } else {
                graph.history().iter().rev().find(|e| matches(e)).copied()
            };
            let prior = if let Some(edge) = last {
                if edge.valid_to != i64::MAX {
                    return Err(Error::Invalid(
                        "episode timeline was externally shortened".into(),
                    ));
                }
                let prev = decode_edge::<C>(store, map, &edge)?;
                Some((
                    prev.index,
                    prev.timestamp_us,
                    prev.terminated || prev.truncated,
                ))
            } else {
                None
            };
            entry.insert(prior);
        }
        match latest[&step.episode] {
            None if step.index != 0 => {
                return Err(Error::Invalid(
                    "first episode record must be reset index zero".into(),
                ));
            }
            Some((index, time, ended))
                if ended || step.index != index + 1 || step.timestamp_us <= time =>
            {
                return Err(Error::Invalid(
                    "steps must be contiguous, chronological and before termination/truncation"
                        .into(),
                ));
            }
            _ => {}
        }
        latest.insert(
            step.episode,
            Some((
                step.index,
                step.timestamp_us,
                step.terminated || step.truncated,
            )),
        );
    }
    let batch = common::records(FORMAT, &map.metadata()?, steps)?;
    let refs = store.put(&batch)?;
    let edges = steps
        .iter()
        .zip(refs)
        .map(|(step, payload)| {
            Ok(EdgeInput {
                src: map.episode_node(step.episode)?,
                dst: NodeId(map.environment_node),
                kind: EdgeKind(map.state_kind),
                valid_from: step.timestamp_us,
                payload,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(if let Some(fork) = fork {
        graph.add_edges_to_fork(fork, &edges)?
    } else {
        graph.add_edges(&edges)?
    })
}
/// Restore complete episode state from a selected fork at or after its snapshot time.
pub fn restore_fork<C: StateCodec>(
    graph: &Graph,
    store: &ArrowStore,
    map: &Mapping,
    fork: ForkId,
    episode: u64,
    t: i64,
) -> Result<Option<Step<C::State>>> {
    let node = map.episode_node(episode)?;
    graph
        .fork_view(fork, t)?
        .neighbors(node)
        .into_iter()
        .find(|e| e.dst.0 == map.environment_node && e.kind.0 == map.state_kind)
        .map(|edge| decode_edge::<C>(store, map, &edge))
        .transpose()
}
/// Restore the complete state at `t`; caller passes it to the matching environment codec/runtime.
pub fn restore<C: StateCodec>(
    graph: &Graph,
    store: &ArrowStore,
    map: &Mapping,
    episode: u64,
    t: i64,
) -> Result<Option<Step<C::State>>> {
    let node = map.episode_node(episode)?;
    graph
        .neighbors(node, t)
        .filter_map(|r| graph.edge(r.id))
        .find(|e| e.dst.0 == map.environment_node && e.kind.0 == map.state_kind)
        .map(|edge| decode_edge::<C>(store, map, edge))
        .transpose()
}
/// Export complete episodes, retaining reset observations and full state snapshots.
pub fn export_steps<C: StateCodec>(
    graph: &Graph,
    store: &ArrowStore,
    map: &Mapping,
    episodes: &[u64],
) -> Result<Vec<Step<C::State>>> {
    map.validate()?;
    if episodes.is_empty() || episodes.len() > 1000 {
        return Err(Error::Invalid("select 1–1000 episodes".into()));
    }
    let nodes = episodes
        .iter()
        .map(|v| map.episode_node(*v))
        .collect::<Result<std::collections::HashSet<_>>>()?;
    let metadata = map.metadata()?;
    let mut result = Vec::new();
    let mut cache = None;
    for edge in graph.history().iter().filter(|e| {
        nodes.contains(&e.src) && e.dst.0 == map.environment_node && e.kind.0 == map.state_kind
    }) {
        if result.len() >= MAX_STEPS {
            return Err(Error::Invalid("export exceeds 100000 steps".into()));
        }
        let key: [u8; 12] = edge.payload[..12].try_into().unwrap();
        if cache.as_ref().is_none_or(|(k, _)| k != &key) {
            cache = Some((key, store.read(edge.payload)?.0));
        }
        let row = u32::from_le_bytes(edge.payload[12..].try_into().unwrap()) as usize;
        let step: Step<C::State> =
            common::decode(&cache.as_ref().unwrap().1, row, FORMAT, &metadata)?;
        validate::<C>(map, &step)?;
        if map.episode_node(step.episode)? != edge.src || step.timestamp_us != edge.valid_from {
            return Err(Error::Invalid("graph/sidecar mismatch".into()));
        }
        result.push(step);
    }
    result.sort_by_key(|s| (s.episode, s.index));
    for node in nodes {
        let selected: Vec<_> = result
            .iter()
            .filter(|s| map.episode_base + s.episode == node.0)
            .collect();
        if selected.len() < 2
            || !selected.last().is_some_and(|s| s.terminated || s.truncated)
            || selected
                .iter()
                .enumerate()
                .any(|(i, s)| s.index != i as u64)
            || selected.windows(2).any(|pair| {
                pair[1].timestamp_us <= pair[0].timestamp_us
                    || pair[0].terminated
                    || pair[0].truncated
            })
        {
            return Err(Error::Invalid(
                "export requires complete contiguous episodes ending in termination or truncation"
                    .into(),
            ));
        }
    }
    Ok(result)
}
pub fn export_arrow<C: StateCodec>(
    graph: &Graph,
    store: &ArrowStore,
    map: &Mapping,
    episodes: &[u64],
) -> Result<RecordBatch> {
    Ok(common::records(
        FORMAT,
        &map.metadata()?,
        &export_steps::<C>(graph, store, map, episodes)?,
    )?)
}
