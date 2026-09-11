use crate::{ApiError, AppResult, Shared};
use chronograph_db::{
    BoundedEdgeInput, Edge, EdgeId, EdgeInput, EdgeKind, ForkId, ForkInfo, ForkWriteOp, Graph,
    MergeResult, NodeId, SampleStrategy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const WRITES: &[&str] = &[
    "fork",
    "merge",
    "discard",
    "add_node",
    "add_edges",
    "invalidate_edge",
    "sync",
    "load_demo",
    "backup",
    "schema_apply",
    "asset_put",
    "asset_compose",
    "connector_ingest",
];
pub fn canonical(op: &str) -> &str {
    match op {
        "edges" | "ingest_edges" => "add_edges",
        "nodes" => "add_node",
        "invalidate" => "invalidate_edge",
        "sample_neighbors" => "sample",
        other => other,
    }
}
pub fn is_write(op: &str) -> bool {
    WRITES.contains(&op)
}
pub fn parse<T: serde::de::DeserializeOwned>(v: Value) -> AppResult<T> {
    serde_json::from_value(v).map_err(|e| ApiError::bad(e.to_string()))
}
pub fn number<T: std::str::FromStr>(s: &str) -> AppResult<T> {
    s.parse()
        .map_err(|_| ApiError::bad("Expected an in-range decimal integer string"))
}
pub fn edge(e: &Edge) -> Value {
    json!({"id":e.id.0.to_string(),"src":e.src.0.to_string(),"dst":e.dst.0.to_string(),"kind":e.kind.0,"valid_from":e.valid_from.to_string(),"valid_to":e.valid_to.to_string(),"payload":crate::auth::hex(&e.payload)})
}
fn stats(g: &Graph) -> Value {
    let s = g.stats();
    json!({"nodes":s.nodes.to_string(),"edge_versions":s.edge_versions.to_string(),"revision":g.revision().to_string(),"parent_revision":g.parent_revision().to_string(),"active_forks":g.forks().filter(|f|f.status==chronograph_db::ForkStatus::Active).count().to_string(),"log_bytes":s.log_bytes.to_string(),"recovered_tail_bytes":s.recovered_tail_bytes.to_string(),"default_durability":"buffered"})
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    id: String,
    #[serde(default)]
    fork: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    src: String,
    dst: String,
    kind: u16,
    valid_from: String,
    #[serde(default)]
    valid_to: Option<String>,
    #[serde(default)]
    payload: Option<String>,
    #[serde(default)]
    properties: Option<Value>,
}
impl Input {
    pub fn convert(self, schema: &crate::schema::Snapshot) -> AppResult<BoundedEdgeInput> {
        crate::connectors::reject_raw_sidecar(schema, self.kind)?;
        if self.payload.is_some() && self.properties.is_some() {
            return Err(ApiError::bad("Provide payload or properties, not both"));
        }
        let hex = self.payload.unwrap_or_else(|| "00".repeat(16));
        if hex.len() != 32 || !hex.is_ascii() {
            return Err(ApiError::bad(
                "Payload must be 32 hexadecimal characters (16 bytes)",
            ));
        }
        let mut payload = [0; 16];
        for (i, b) in payload.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|_| ApiError::bad("Invalid hex payload"))?;
        }
        if let Some(properties) = self.properties {
            payload = schema.encode(self.kind, &properties)?;
        }
        schema.validate_edge(self.kind, &payload)?;
        let valid_from = number(&self.valid_from)?;
        if valid_from == i64::MAX {
            return Err(ApiError::bad("valid_from must be below i64::MAX"));
        }
        let valid_to = self
            .valid_to
            .as_deref()
            .map(number)
            .transpose()?
            .unwrap_or(i64::MAX);
        if valid_to < valid_from {
            return Err(ApiError::bad("valid_to must be at or after valid_from"));
        }
        Ok(BoundedEdgeInput {
            valid_to,
            edge: EdgeInput {
                src: NodeId(number(&self.src)?),
                dst: NodeId(number(&self.dst)?),
                kind: EdgeKind(self.kind),
                valid_from,
                payload,
            },
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    edges: Vec<Input>,
    #[serde(default)]
    fork: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invalidate {
    id: String,
    t: String,
    #[serde(default)]
    fork: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateFork {
    t: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectFork {
    fork: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListForks {
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    after: Option<String>,
}
fn selected(s: Option<&str>) -> AppResult<Option<ForkId>> {
    s.map(|v| number(v).map(ForkId)).transpose()
}
fn merge_json(m: &MergeResult) -> AppResult<Value> {
    if m.nodes.len() + m.edges.len() > 10000 {
        return Err(ApiError::bad(
            "HTTP/MCP merge mappings are limited to 10000; use the Rust API for larger merges",
        ));
    }
    Ok(
        json!({"fork":m.fork.0.to_string(),"parent_revision":m.parent_revision.to_string(),"nodes":m.nodes.iter().map(|n|json!({"branch":n.branch.0.to_string(),"parent":n.parent.0.to_string()})).collect::<Vec<_>>(),"edges":m.edges.iter().map(|e|json!({"branch":e.branch.0.to_string(),"parent":e.parent.0.to_string()})).collect::<Vec<_>>()}),
    )
}
fn fork_json(f: &ForkInfo) -> Value {
    json!({"id":f.id.0.to_string(),"name":f.name,"timestamp":f.timestamp.to_string(),"parent_revision":f.parent_revision.to_string(),"revision":f.revision.to_string(),"inherited_edges":f.inherited_edges.to_string(),"delta_edges":f.delta_edges.to_string(),"new_nodes":f.new_nodes.to_string(),"status":f.status,"merge":f.merge.as_ref().map(|m|json!({"parent_revision":m.parent_revision.to_string(),"node_mappings":m.nodes.len().to_string(),"edge_mappings":m.edges.len().to_string()}))})
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    #[serde(default)]
    pub fork: Option<String>,
    #[serde(default = "as_of")]
    pub mode: String,
    #[serde(default = "zero")]
    pub t: String,
    #[serde(default = "zero")]
    pub start: String,
    #[serde(default = "max_time")]
    pub end: String,
    #[serde(default = "zero")]
    pub node: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_k")]
    pub k: usize,
    #[serde(default = "latest")]
    pub strategy: String,
    #[serde(default = "zero")]
    pub seed: String,
}
fn as_of() -> String {
    "as_of".into()
}
fn zero() -> String {
    "0".into()
}
fn max_time() -> String {
    i64::MAX.to_string()
}
fn default_limit() -> usize {
    100
}
fn default_k() -> usize {
    10
}
fn latest() -> String {
    "latest".into()
}

pub async fn execute(state: Shared, op: String, mut args: Value) -> AppResult<Value> {
    if !args.is_object() {
        return Err(ApiError::bad("Expected a JSON object"));
    }
    let durability = if is_write(&op) {
        args.as_object_mut()
            .unwrap()
            .remove("durability")
            .unwrap_or(Value::Null)
    } else {
        json!("buffered")
    };
    if !durability.is_null() && durability != "buffered" && durability != "fsync" {
        return Err(ApiError::bad("durability must be buffered or fsync"));
    }
    let permit = state.admit().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let began = std::time::Instant::now();
        if matches!(op.as_str(), "asset_put" | "asset_compose" | "asset_get" | "connector_ingest" | "connector_checkpoint" | "connector_record") {
            return crate::connectors::execute(&state, &op, args);
        }
        let mut result = if is_write(&op) {
            let mut g = state.graph.write().map_err(ApiError::internal)?;
            if op == "schema_apply" {
                return state.schema.write().map_err(ApiError::internal)?.apply(&mut g, &state.data, parse(args)?);
            }
            let catalog = state.schema.read().map_err(ApiError::internal)?;
            let schema = catalog.snapshot()?;
            let durability = if durability.is_null() { json!(schema.settings.default_durability) } else { durability };
            let mut result = match op.as_str() {
                "fork" => {
                    let f: CreateFork = parse(args)?;
                    let id = g.fork_named(number(&f.t)?, f.name)?;
                    json!({"fork":fork_json(g.fork_info(id)?)})
                }
                "merge" => {
                    let f: SelectFork = parse(args)?;
                    let id = ForkId(number(&f.fork)?);
                    if let Some(result) = &g.fork_info(id)?.merge { merge_json(result)?; }
                    else {
                        merge_json(&g.preview_merge(id)?)?;
                        for e in g.fork_history(id)? { schema.validate_edge(e.kind.0, &e.payload)?; }
                    }
                    json!({"merge":merge_json(&g.merge(id)?)?})
                }
                "discard" => {
                    let f: SelectFork = parse(args)?;
                    let id = ForkId(number(&f.fork)?);
                    g.discard(id)?;
                    json!({"fork":fork_json(g.fork_info(id)?)})
                }
                "add_node" => {
                    let n: Node = parse(args)?;
                    if let Some(fork) = selected(n.fork.as_deref())? { g.write_fork(fork, ForkWriteOp::AddNode(NodeId(number(&n.id)?)))?; }
                    else { g.add_node(NodeId(number(&n.id)?))?; }
                    json!({"id":n.id,"fork":n.fork})
                }
                "add_edges" => {
                    let b: Batch = parse(args)?;
                    if b.edges.is_empty() || b.edges.len() > 10_000 {
                        return Err(ApiError::bad("Batch requires 1–10000 edges"));
                    }
                    let inputs = b
                        .edges
                        .into_iter()
                        .map(|input| input.convert(schema))
                        .collect::<AppResult<Vec<_>>>()?;
                    let ids = if let Some(fork) = selected(b.fork.as_deref())? { g.add_bounded_edges_to_fork(fork, &inputs)? } else { g.add_edges_bounded(&inputs)? };
                    json!({"ids":ids.iter().map(|i|i.0.to_string()).collect::<Vec<_>>(),"fork":b.fork})
                }
                "invalidate_edge" => {
                    let i: Invalidate = parse(args)?;
                    if let Some(fork) = selected(i.fork.as_deref())? { g.write_fork(fork, ForkWriteOp::Invalidate(EdgeId(number(&i.id)?),number(&i.t)?))?; }
                    else { g.invalidate_edge(EdgeId(number(&i.id)?), number(&i.t)?)?; }
                    json!({"invalidated":i.id,"fork":i.fork})
                }
                "sync" => {
                    empty(&args)?;
                    g.sync()?;
                    json!({"synced":true})
                }
                "backup" => {
                    empty(&args)?;
                    crate::backup::create(&mut g, &state.data)?
                }
                "load_demo" => {
                    empty(&args)?;
                    if g.stats().nodes != 0 {
                        return Err(ApiError::conflict(
                            "Demo can only be loaded into an empty workspace",
                        ));
                    }
                    let mut inputs = vec![];
                    for tick in 0..5 {
                        for (src, dst, kind) in [
                            (1001, 1002, 1),
                            (1001, 1005, 2),
                            (1005, 1003, 3),
                            (1005, 1004, 1),
                            (1006, 1005, 1),
                            (1005, 1007, 4),
                            (1005, 1008, 2),
                            (1002, 1008, 3),
                        ] {
                            inputs.push(EdgeInput {
                                src: NodeId(src),
                                dst: NodeId(dst),
                                kind: EdgeKind(kind),
                                valid_from: tick * 1_000_000,
                                payload: [tick as u8; 16],
                            });
                        }
                    }
                    for e in &inputs { schema.validate_edge(e.kind.0, &e.payload)?; }
                    g.add_edges(&inputs)?;
                    stats(&g)
                }
                _ => unreachable!(),
            };
            if durability == "fsync" {
                g.sync()?;
            }
            result["revision"] = json!(g.revision().to_string());
            result["durability"] = if matches!(op.as_str(), "sync" | "backup") {
                json!("fsync")
            } else {
                durability
            };
            result
        } else {
            let g = state.graph.read().map_err(ApiError::internal)?;
            let catalog = state.schema.read().map_err(ApiError::internal)?;
            let schema = catalog.snapshot()?;
            if matches!(op.as_str(), "query" | "as_of" | "between" | "history" | "neighbors") {
                args.as_object_mut().unwrap().entry("limit").or_insert(json!(schema.settings.default_query_limit));
            }
            match op.as_str() {
                "schema" => { empty(&args)?; catalog.public()? }
                "connector_catalog" => { empty(&args)?; crate::connectors::catalog() },
                "connector_template" => crate::connectors::template(&g, catalog.snapshot()?, args)?,
                "schema_preview" => {
                    let request: crate::schema::PreviewRequest = parse(args)?;
                    catalog.preview(&g, &request.source)?
                }
                "schema_migration" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct MigrationId { id: String }
                    let request: MigrationId = parse(args)?;
                    catalog.source(&request.id)?
                }
                "schema_encode" => catalog.encode_request(args)?,
                "forks" => {
                    let q: ListForks = parse(args)?;
                    if q.limit == 0 || q.limit > 1000 { return Err(ApiError::bad("limit must be 1–1000")); }
                    let after = selected(q.after.as_deref())?.unwrap_or(ForkId(0));
                    let items: Vec<_> = g.forks().filter(|f|f.id > after).take(q.limit + 1).collect();
                    let next = if items.len() > q.limit { Some(items[q.limit-1].id.0.to_string()) } else { None };
                    json!({"forks":items.iter().take(q.limit).map(|f|fork_json(f)).collect::<Vec<_>>(),"next_after":next,"revision":g.revision().to_string()})
                }
                "fork_info" => {
                    let f: SelectFork = parse(args)?;
                    let info = g.fork_info(ForkId(number(&f.fork)?))?;
                    let mut value = json!({"fork":fork_json(info)});
                    if let Some(m) = &info.merge { value["merge"] = merge_json(m)?; }
                    value
                }
                "preview_merge" => {
                    let f: SelectFork = parse(args)?;
                    json!({"merge":merge_json(&g.preview_merge(ForkId(number(&f.fork)?))?)?,"preview":true,"revision":g.revision().to_string()})
                }
                "stats" => {
                    empty(&args)?;
                    let mut result = stats(&g);
                    result["default_durability"] = json!(schema.settings.default_durability);
                    result
                }
                "sample" => sample(&g, parse(args)?)?,
                "as_of" | "between" | "history" | "neighbors" => {
                    let map = args.as_object_mut().unwrap();
                    if map.get("mode").is_some_and(|m| m != &op) {
                        return Err(ApiError::bad("mode does not match endpoint"));
                    }
                    map.insert("mode".into(), json!(op));
                    query(&g, parse(args)?)?
                }
                "get_edge" => {
                    let n: Node = parse(args)?;
                    let id = EdgeId(number(&n.id)?);
                    let found = if let Some(fork) = selected(n.fork.as_deref())? { g.fork_edge(fork,id)? } else { g.edge(id).copied() };
                    let mut result = edge(&found.ok_or_else(||ApiError::missing("Edge does not exist"))?);
                    result["fork"] = json!(n.fork);
                    result
                }
                "contains_node" => {
                    let n: Node = parse(args)?;
                    let id = NodeId(number(&n.id)?);
                    let exists = if let Some(fork) = selected(n.fork.as_deref())? { g.fork_view(fork,g.fork_info(fork)?.timestamp)?.nodes().any(|n|n==id) } else {g.contains_node(id)};
                    json!({"exists":exists,"fork":n.fork})
                }
                "query" => query(&g, parse(args)?)?,
                _ => return Err(ApiError::missing("Unknown graph operation")),
            }
        };
        if matches!(op.as_str(), "query" | "as_of" | "between" | "history" | "neighbors" | "sample" | "get_edge") {
            state.schema.read().map_err(ApiError::internal)?.enrich(&mut result);
        }
        result["duration_ms"] = json!(began.elapsed().as_secs_f64() * 1000.0);
        Ok(result)
    })
    .await
    .map_err(ApiError::internal)?
}
fn query(g: &Graph, q: Query) -> AppResult<Value> {
    if q.limit == 0 || q.limit > 1000 || q.k > 1000 {
        return Err(ApiError::bad("limit must be 1–1000; k must be 0–1000"));
    }
    let t = number(&q.t)?;
    let start = number(&q.start)?;
    let end = number(&q.end)?;
    let mut signature = serde_json::to_value(&q).map_err(ApiError::internal)?;
    signature.as_object_mut().unwrap().remove("cursor");
    let fingerprint = crate::auth::hash(&signature.to_string())[..16].to_owned();
    let cursor = if let Some(cursor) = &q.cursor {
        let parts = cursor.split(':').collect::<Vec<_>>();
        if parts.len() != 3 {
            return Err(ApiError::bad("Invalid pagination cursor"));
        }
        if parts[0] != g.revision().to_string() || parts[1] != fingerprint {
            return Err(ApiError::conflict(
                "Pagination cursor is stale or belongs to another query; restart from the first page",
            ));
        }
        number::<usize>(parts[2])?
    } else {
        0
    };
    let fork = selected(q.fork.as_deref())?;
    let mut rows = vec![];
    let mut next = None;
    match q.mode.as_str() {
        "as_of" | "between" | "history" => {
            if q.mode == "between" && start >= end {
                return Err(ApiError::bad("start must be below end"));
            }
            let history: Box<dyn Iterator<Item = Edge> + '_> = if let Some(fork) = fork {
                if q.mode != "history" {
                    g.fork_view(fork, if q.mode == "between" { start } else { t })?;
                }
                Box::new(g.fork_history(fork)?)
            } else {
                Box::new(g.history().iter().copied())
            };
            for (i, e) in history.enumerate().skip(cursor) {
                if q.mode == "history"
                    || (q.mode == "as_of" && e.is_valid_at(t))
                    || (q.mode == "between" && e.overlaps(start, end))
                {
                    if rows.len() == q.limit {
                        next = Some(i);
                        break;
                    }
                    rows.push(edge(&e));
                }
            }
        }
        "neighbors" | "sample" => {
            let node = NodeId(number(&q.node)?);
            if q.mode == "sample" {
                if q.cursor.is_some() {
                    return Err(ApiError::bad("Sampling does not accept a cursor"));
                }
                let strategy = match q.strategy.as_str() {
                    "latest" => SampleStrategy::LatestFirst,
                    "uniform" => SampleStrategy::Uniform,
                    _ => return Err(ApiError::bad("strategy must be latest or uniform")),
                };
                if q.k > q.limit {
                    return Err(ApiError::bad("k must not exceed limit"));
                }
                rows = if let Some(fork) = fork {
                    g.fork_view(fork, t)?.sample_neighbors_seeded(
                        &[node],
                        q.k,
                        strategy,
                        number(&q.seed)?,
                    )[0]
                    .iter()
                    .map(edge)
                    .collect()
                } else {
                    g.sample_neighbors_seeded(&[node], q.k, t, strategy, number(&q.seed)?)[0]
                        .iter()
                        .map(|r| edge(g.edge(r.id).unwrap()))
                        .collect()
                };
            } else {
                let candidates: Box<dyn Iterator<Item = Edge> + '_> = if let Some(fork) = fork {
                    Box::new(g.fork_view(fork, t)?.neighbors(node).into_iter())
                } else {
                    Box::new(g.neighbors(node, t).map(|r| *g.edge(r.id).unwrap()))
                };
                for (i, e) in candidates.enumerate().skip(cursor) {
                    if rows.len() == q.limit {
                        next = Some(i);
                        break;
                    }
                    rows.push(edge(&e));
                }
            }
        }
        _ => {
            return Err(ApiError::bad(
                "mode must be as_of, between, history, neighbors or sample",
            ));
        }
    }
    Ok(
        json!({"edges":rows,"next_cursor":next.map(|n|format!("{}:{}:{n}",g.revision(),fingerprint)),"count":rows.len(),"mode":q.mode,"fork":q.fork,"revision":g.revision().to_string()}),
    )
}

fn empty(args: &Value) -> AppResult<()> {
    if args.as_object().is_some_and(|m| m.is_empty()) {
        Ok(())
    } else {
        Err(ApiError::bad(
            "This operation does not accept additional arguments",
        ))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample {
    #[serde(default)]
    fork: Option<String>,
    nodes: Vec<String>,
    t: String,
    #[serde(default = "default_k")]
    k: usize,
    #[serde(default = "latest")]
    strategy: String,
    #[serde(default = "zero")]
    seed: String,
}
fn sample(g: &Graph, q: Sample) -> AppResult<Value> {
    if q.nodes.is_empty()
        || q.nodes.len() > 1000
        || q.k > 1000
        || q.nodes.len().saturating_mul(q.k) > 1000
    {
        return Err(ApiError::bad(
            "Sample requires 1–1000 nodes and at most 1000 potential results (nodes × k)",
        ));
    }
    let nodes = q
        .nodes
        .iter()
        .map(|n| number(n).map(NodeId))
        .collect::<AppResult<Vec<_>>>()?;
    let strategy = match q.strategy.as_str() {
        "latest" => SampleStrategy::LatestFirst,
        "uniform" => SampleStrategy::Uniform,
        _ => return Err(ApiError::bad("strategy must be latest or uniform")),
    };
    let results = if let Some(fork) = selected(q.fork.as_deref())? {
        g.fork_view(fork, number(&q.t)?)?.sample_neighbors_seeded(
            &nodes,
            q.k,
            strategy,
            number(&q.seed)?,
        )
    } else {
        g.sample_neighbors_seeded(&nodes, q.k, number(&q.t)?, strategy, number(&q.seed)?)
            .into_iter()
            .map(|refs| refs.into_iter().map(|r| *g.edge(r.id).unwrap()).collect())
            .collect()
    };
    let batches=nodes.iter().zip(results).map(|(n,edges)|json!({"node":n.0.to_string(),"edges":edges.iter().map(edge).collect::<Vec<_>>()})).collect::<Vec<_>>();
    Ok(json!({"samples":batches,"fork":q.fork,"revision":g.revision().to_string()}))
}
