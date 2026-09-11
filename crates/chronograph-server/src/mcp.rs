use crate::{Shared, auth::Principal, operations};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::*,
    service::RequestContext,
    transport::{
        StreamableHttpServerConfig,
        streamable_http_server::{
            session::local::LocalSessionManager, tower::StreamableHttpService,
        },
    },
};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct GraphMcp {
    state: Shared,
}
pub fn service(state: Shared) -> StreamableHttpService<GraphMcp, LocalSessionManager> {
    let mut config = StreamableHttpServerConfig::default();
    config.legacy_session_mode = false;
    config.json_response = true;
    config.allowed_hosts = vec![state.authority.clone()];
    config.allowed_origins = vec![state.origin.clone()];
    StreamableHttpService::new(
        move || {
            Ok(GraphMcp {
                state: state.clone(),
            })
        },
        LocalSessionManager::default().into(),
        config,
    )
}
pub fn definitions() -> Vec<Tool> {
    let integer = json!({"type":"string","pattern":"^-?[0-9]+$","description":"Exact i64 microseconds as a decimal string"});
    let id = json!({"type":"string","pattern":"^[0-9]+$","description":"Exact u64 ID as a decimal string"});
    let limit = json!({"type":"integer","minimum":1,"maximum":1000});
    let cursor = json!({"type":"string","description":"Opaque revision-bound cursor from the previous identical query; restart after a conflict"});
    let durability = json!({"type":"string","enum":["buffered","fsync"],"description":"Omitted uses schema settings. fsync acknowledges disk synchronization; buffered needs a later sync"});
    let input = json!({"type":"object","additionalProperties":false,"properties":{"src":id,"dst":id,"kind":{"type":"integer","minimum":0,"maximum":65535},"valid_from":integer,"valid_to":integer,"payload":{"type":"string","pattern":"^[0-9a-fA-F]{32}$"},"properties":{"type":"object","description":"Values matching schema property names/types. Use this or payload. u64/i64 values are decimal strings."}},"required":["src","dst","kind","valid_from"]});
    let batch = json!({"edges":{"type":"array","minItems":1,"maxItems":10000,"items":input},"durability":durability});
    let specs = vec![
        (
            "asset_compose",
            "Publish a typed asset from 1–16 immutable chunk_v1 uploads in order (≤16 MiB). Safe to retry.",
            json!({"metadata":{"type":"object"},"chunks":{"type":"array","minItems":1,"maxItems":16,"items":{"type":"string"}}}),
            vec!["metadata", "chunks"],
        ),
        (
            "connector_catalog",
            "Read versioned connector families, presets and exact native/normalized capabilities.",
            json!({}),
            vec![],
        ),
        (
            "connector_template",
            "Generate a version-2 migration with immutable connector binding and unused sidecar kind. Preview then apply the returned source.",
            json!({"id":{"type":"string"},"connector":{"type":"string"},"preset":{"type":"string"},"contract_version":{"type":"integer","const":1},"kind":{"type":"integer","minimum":0,"maximum":65535},"clock_domain":{"type":"string","enum":["unix_us","simulation_us","lsl_local_us","device_us"]},"modalities":{"type":"array","items":{"type":"string"}},"channels":{"type":"array","items":{"type":"string"}},"units":{"type":"array","items":{"type":"string"}},"topics":{"type":"array","items":{"type":"string"}},"tensor_shapes":{"type":"object"},"secret_refs":{"type":"array","items":{"type":"string"}}}),
            vec![
                "id",
                "connector",
                "preset",
                "contract_version",
                "kind",
                "clock_domain",
            ],
        ),
        (
            "connector_ingest",
            "Durably ingest 1–500 normalized records. Sequence starts at zero per instance/partition. Identical latest retries return the original receipt; conflicts fail. Upload referenced assets first.",
            json!({"instance":{"type":"string"},"partition":{"type":"string"},"sequence":id,"records":{"type":"array","minItems":1,"maxItems":500,"items":{"type":"object","description":"src/dst/timestamp_us decimal strings, optional valid_to/episode, assets name-to-ID map, fields object. See CONNECTOR_PLATFORM.md."}}}),
            vec!["instance", "partition", "sequence", "records"],
        ),
        (
            "connector_checkpoint",
            "Read the last durable ingestion receipt for a configured instance and partition.",
            json!({"instance":{"type":"string"},"partition":{"type":"string"}}),
            vec!["instance", "partition"],
        ),
        (
            "connector_record",
            "Read the verified normalized source record and immutable binding associated with a main graph edge.",
            json!({"edge":id}),
            vec!["edge"],
        ),
        (
            "asset_put",
            "Synchronize one content-addressed binary asset, up to 1 MiB decoded. Tensor metadata requires dtype, shape and raw_le encoding. No content is executed.",
            json!({"metadata":{"type":"object"},"data_hex":{"type":"string","maxLength":2097152}}),
            vec!["metadata", "data_hex"],
        ),
        (
            "asset_get",
            "Read verified asset metadata; set content=true to return bounded binary content as hex.",
            json!({"asset":{"type":"string","pattern":"^[0-9a-f]{32}$"},"content":{"type":"boolean"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":1048576}}),
            vec!["asset"],
        ),
        (
            "schema",
            "Read workspace relation definitions, property layouts, settings and migration history. Shared by main and all branches; service constraints do not change the embedded Rust engine.",
            json!({}),
            vec![],
        ),
        (
            "schema_preview",
            "Validate a version-1 or version-2 JSON migration without writing. Returns checksum, expected_revision and before/after catalogs. Use schema_apply with both values after review.",
            json!({"source":{"type":"string","maxLength":262144,"description":"JSON migration file contents with version, id, name and operations. Operations: upsert_relation, drop_relation, set_settings. See /docs/SCHEMA.md."}}),
            vec!["source"],
        ),
        (
            "schema_apply",
            "Admin only. Revalidate and durably apply a previewed migration atomically. Same ID and checksum retries are idempotent. Different checksum or stale schema revision fails. Does not rewrite existing edges.",
            json!({"source":{"type":"string","maxLength":262144},"checksum":{"type":"string"},"expected_revision":{"type":"integer","minimum":0}}),
            vec!["source", "checksum", "expected_revision"],
        ),
        (
            "schema_migration",
            "Read the original applied migration source for export or review.",
            json!({"id":{"type":"string"}}),
            vec!["id"],
        ),
        (
            "schema_encode",
            "Validate and encode typed relation properties into 16 little-endian bytes without writing. All defined properties are required. u64/i64 require decimal strings.",
            json!({"kind":{"type":"integer","minimum":0,"maximum":65535},"properties":{"type":"object"}}),
            vec!["kind", "properties"],
        ),
        (
            "fork",
            "Freeze the parent state active at t into a durable named fork. Ingest/admin scope. Future parent observations are excluded. Do not retry an ambiguous creation without listing forks.",
            json!({"t":integer,"name":{"type":"string","minLength":1,"maxLength":80},"durability":durability}),
            vec!["t", "name"],
        ),
        (
            "forks",
            "List fork metadata in ID order, including closed forks. after is the last ID from the prior page; metadata can change between pages.",
            json!({"limit":limit,"after":id}),
            vec![],
        ),
        (
            "fork_info",
            "Read one fork and its retained merge mappings if it is merged. All fork edge IDs are local to the selected fork.",
            json!({"fork":id}),
            vec!["fork"],
        ),
        (
            "preview_merge",
            "Validate a proposed merge and read ID mappings without changing state. Parent changes or known future observations/expirations on touched relationships cause a conflict. Actual merge validates again.",
            json!({"fork":id}),
            vec!["fork"],
        ),
        (
            "merge",
            "Atomically apply an eligible fork delta to the unchanged parent, remap new IDs and close the fork. Payloads are unchanged. Ingest/admin scope. Returns retained result on retries. HTTP/MCP limit: 10000 mappings.",
            json!({"fork":id,"durability":durability}),
            vec!["fork"],
        ),
        (
            "discard",
            "Durably discard an active fork without changing the parent. Closed metadata is retained; repeating a discard is a no-op. Ingest/admin scope.",
            json!({"fork":id,"durability":durability}),
            vec!["fork"],
        ),
        (
            "stats",
            "Read workspace size, revision and default durability.",
            json!({}),
            vec![],
        ),
        (
            "ingest_edges",
            "Atomically append 1–10000 versions. Ingest/admin scope. Replacements shorten earlier versions. Do not retry ambiguous writes without inspecting history.",
            batch.clone(),
            vec!["edges"],
        ),
        (
            "as_of",
            "Read a bounded page of relationships active at t, using [from,to) validity.",
            json!({"t":integer,"limit":limit,"cursor":cursor}),
            vec!["t"],
        ),
        (
            "between",
            "Read versions overlapping [start,end). Superseded empty intervals are excluded.",
            json!({"start":integer,"end":integer,"limit":limit,"cursor":cursor}),
            vec!["start", "end"],
        ),
        (
            "history",
            "Read all stored versions, including inactive and empty intervals.",
            json!({"limit":limit,"cursor":cursor}),
            vec![],
        ),
        (
            "neighbors",
            "Read outgoing edges active at t for one node.",
            json!({"node":id,"t":integer,"limit":limit,"cursor":cursor}),
            vec!["node", "t"],
        ),
        (
            "sample_neighbors",
            "Sample up to k active neighbors per node. nodes × k must be at most 1000. Uniform is seeded reservoir sampling.",
            json!({"nodes":{"type":"array","minItems":1,"maxItems":1000,"items":id},"t":integer,"k":{"type":"integer","minimum":0,"maximum":1000},"strategy":{"type":"string","enum":["latest","uniform"]},"seed":id}),
            vec!["nodes", "t"],
        ),
        (
            "backup",
            "Synchronize and create a checksummed journal/index/sidecar backup, excluding credentials. Admin scope; download through the HTTP backup endpoint.",
            json!({}),
            vec![],
        ),
        (
            "get_edge",
            "Read one stored edge version by ID.",
            json!({"id":id}),
            vec!["id"],
        ),
        (
            "contains_node",
            "Check an identity, including isolated nodes.",
            json!({"id":id}),
            vec!["id"],
        ),
        (
            "add_node",
            "Register an isolated node. Ingest/admin scope; repeating it is a no-op.",
            json!({"id":id,"durability":durability}),
            vec!["id"],
        ),
        (
            "add_edges",
            "Compatibility alias for ingest_edges with the same durability and scope rules.",
            batch,
            vec!["edges"],
        ),
        (
            "invalidate_edge",
            "Shorten an interval without erasing history. Cannot extend or resurrect it. Ingest/admin scope.",
            json!({"id":id,"t":integer,"durability":durability}),
            vec!["id", "t"],
        ),
        (
            "sync",
            "Flush and synchronize the journal. Ingest/admin scope.",
            json!({}),
            vec![],
        ),
        (
            "query",
            "Compatibility query tool. Prefer the specific as_of/between/history/neighbors tools. Cursor must be the opaque string returned by 0.3.0.",
            json!({"mode":{"type":"string","enum":["as_of","between","history","neighbors","sample"]},"t":integer,"start":integer,"end":integer,"node":id,"limit":limit,"cursor":cursor,"k":{"type":"integer","minimum":0,"maximum":1000},"strategy":{"type":"string","enum":["latest","uniform"]},"seed":id}),
            vec![],
        ),
    ];
    specs.into_iter().map(|(name,description,mut properties,required)|{
        let op=operations::canonical(name);let write=operations::is_write(op);
        if matches!(op, "as_of"|"between"|"history"|"neighbors"|"sample"|"get_edge"|"contains_node"|"add_node"|"add_edges"|"invalidate_edge"|"query") { properties["fork"] = json!({"type":"string","pattern":"^[0-9]+$","description":"Optional selected fork ID; omitted uses the parent. Edge IDs belong to the selected fork. Query/write times must be at or after the fork time."}); }
        serde_json::from_value(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":!write,"destructiveHint":write && !matches!(op,"sync"|"add_node"|"backup"),"idempotentHint":!matches!(op,"add_edges"|"backup"|"fork"),"openWorldHint":false}})).expect("static valid MCP schema")
    }).collect()
}
impl ServerHandler for GraphMcp {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.server_info = Implementation::new("chronograph", env!("CARGO_PKG_VERSION"));
        info.instructions=Some("Chronograph stores directed temporal relationships. IDs and microsecond timestamps must be decimal strings. Query bounded pages and check next_cursor. Intervals are [from,to); 9223372036854775807 means open end. Writes require ingest/admin scope and change persistent state. Read schema settings for default acknowledgment; choose fsync or call sync for disk durability. Schema migration apply requires admin scope and a current preview. Raw add_edges insertions cannot be safely retried. connector_ingest supports identical latest-batch retries. Backup requires admin scope.".into());
        info
    }
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: definitions(),
            ..Default::default()
        })
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        definitions().into_iter().find(|t| t.name == name)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let op = request.name.to_string();
        if self.get_tool(&op).is_none() {
            return Err(ErrorData::invalid_params("Unknown tool", None));
        }
        let principal = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|p| p.extensions.get::<Principal>());
        let op = operations::canonical(&op).to_owned();
        if principal.is_none_or(|p| p.authorize(&op).is_err()) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "Credential does not authorize this operation",
            )])
            .into());
        }
        let args = Value::Object(request.arguments.unwrap_or_default());
        let result = match operations::execute(self.state.clone(), op, args).await {
            Ok(value) => CallToolResult::structured(value),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(
                json!({"code":e.code(),"message":e.1}).to_string(),
            )]),
        };
        Ok(result.into())
    }
}
