//! Native stdio-to-HTTP bridge. Stdout is reserved for MCP protocol messages.
use rmcp::{
    ErrorData, RoleClient, RoleServer, ServerHandler, ServiceExt,
    model::*,
    service::{Peer, RequestContext},
    transport::{
        StreamableHttpClientTransport, stdio,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
#[derive(Clone)]
struct Bridge {
    peer: Peer<RoleClient>,
    info: ServerInfo,
}
impl ServerHandler for Bridge {
    fn get_info(&self) -> ServerInfo {
        self.info.clone()
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.peer.list_tools(request).await.map_err(|_| {
            ErrorData::internal_error(
                "Upstream tools/list failed; check the service and token",
                None,
            )
        })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        self.peer.call_tool(request).await.map(Into::into).map_err(|_|ErrorData::internal_error("Upstream tool request failed. Its write outcome may be uncertain; inspect history before retrying.",None))
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|a| matches!(a.as_str(), "--help" | "-h")) {
        eprintln!(
            "preview — not benchmarked, not production-hardened\nchronograph-mcp\nEnvironment: CHRONOGRAPH_MCP_URL (http://127.0.0.1:8080/mcp), CHRONOGRAPH_TOKEN_FILE (private token file) or CHRONOGRAPH_TOKEN. No token is accepted in a URL or command-line argument. HTTPS is required for remote services."
        );
        return Ok(());
    }
    let endpoint =
        std::env::var("CHRONOGRAPH_MCP_URL").unwrap_or_else(|_| "http://127.0.0.1:8080/mcp".into());
    let mut origin = url::Url::parse(&endpoint)?;
    if origin.path() != "/mcp" {
        return Err("MCP URL must end in /mcp".into());
    }
    origin.set_path("/");
    chronograph_server::validate_origin(origin.as_str())?;
    let token = if let Ok(path) = std::env::var("CHRONOGRAPH_TOKEN_FILE") {
        let path = std::path::Path::new(&path);
        chronograph_server::auth::check_private_file(path)?;
        std::fs::read_to_string(path)?.trim_end().to_owned()
    } else {
        std::env::var("CHRONOGRAPH_TOKEN")
            .map_err(|_| "Set CHRONOGRAPH_TOKEN_FILE or CHRONOGRAPH_TOKEN")?
    };
    if token.len() != 84 || !token.is_ascii() {
        return Err("Invalid token format".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let mut config = StreamableHttpClientTransportConfig::with_uri(endpoint)
        .auth_header(token)
        .max_concurrent_requests(8);
    config.reinit_on_expired_session = false;
    config.max_sse_event_size = 4 * 1024 * 1024;
    let transport = StreamableHttpClientTransport::with_client(client, config);
    let upstream = ().serve(transport).await?;
    let info = upstream
        .peer_info()
        .ok_or("Upstream initialization did not return server info")?
        .clone();
    let mut server_info = ServerInfo::default();
    server_info.capabilities = info.capabilities.clone();
    server_info.instructions = info.instructions.clone();
    server_info.server_info = info
        .server_info
        .clone()
        .unwrap_or_else(|| Implementation::new("chronograph-mcp", env!("CARGO_PKG_VERSION")));
    let bridge = Bridge {
        peer: upstream.peer().clone(),
        info: server_info,
    }
    .serve(stdio())
    .await?;
    bridge.waiting().await?;
    upstream.cancel().await?;
    Ok(())
}
