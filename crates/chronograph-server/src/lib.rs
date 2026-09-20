pub mod auth;
pub mod backup;
mod connectors;
pub mod contract;
mod mcp;
mod operations;
pub mod schema;

use auth::{Principal, Scope, Token, Verification};
use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Extension, Path as RoutePath, Request, State, rejection::JsonRejection,
    },
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chronograph_db::Graph;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tower_http::{
    limit::RequestBodyLimitLayer,
    services::{ServeDir, ServeFile},
};

pub type Shared = Arc<AppState>;
pub type AppResult<T> = Result<T, ApiError>;
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
impl ApiError {
    pub fn bad(s: impl ToString) -> Self {
        Self(StatusCode::BAD_REQUEST, s.to_string())
    }
    pub fn conflict(s: impl ToString) -> Self {
        Self(StatusCode::CONFLICT, s.to_string())
    }
    pub fn missing(s: impl ToString) -> Self {
        Self(StatusCode::NOT_FOUND, s.to_string())
    }
    pub fn unavailable(s: impl ToString) -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, s.to_string())
    }
    pub fn busy() -> Self {
        Self::unavailable("Worker queue is full; retry later")
    }
    pub fn rate_limited() -> Self {
        Self(
            StatusCode::TOO_MANY_REQUESTS,
            "Rate limit reached; retry later".into(),
        )
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        eprintln!("Internal operation error: {e}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Operation failed; inspect server logs".into(),
        )
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "Authentication required".into())
    }
    pub fn forbidden() -> Self {
        Self(
            StatusCode::FORBIDDEN,
            "This credential or origin does not authorize the operation".into(),
        )
    }
    pub fn code(&self) -> &'static str {
        match self.0 {
            StatusCode::BAD_REQUEST
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::UNSUPPORTED_MEDIA_TYPE => "INVALID_ARGUMENT",
            StatusCode::CONFLICT => "CONFLICT",
            StatusCode::NOT_FOUND => "NOT_FOUND",
            StatusCode::UNAUTHORIZED => "UNAUTHENTICATED",
            StatusCode::FORBIDDEN => "FORBIDDEN",
            StatusCode::TOO_MANY_REQUESTS => "RATE_LIMITED",
            StatusCode::SERVICE_UNAVAILABLE => "UNAVAILABLE",
            StatusCode::PAYLOAD_TOO_LARGE => "PAYLOAD_TOO_LARGE",
            _ => "INTERNAL",
        }
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.0, self.1)
    }
}
impl std::error::Error for ApiError {}
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(e)
    }
}
impl From<chronograph_db::Error> for ApiError {
    fn from(e: chronograph_db::Error) -> Self {
        match e {
            chronograph_db::Error::UnknownEdge(_) | chronograph_db::Error::UnknownFork(_) => {
                Self::missing(e)
            }
            chronograph_db::Error::IngestConflict(_)
            | chronograph_db::Error::ForkClosed(_)
            | chronograph_db::Error::ForkConflict(_) => Self::conflict(e),
            chronograph_db::Error::InvalidIngest(_) | chronograph_db::Error::InvalidFork(_) => {
                Self::bad(e)
            }
            chronograph_db::Error::InvalidTimestamp(_) | chronograph_db::Error::RecordTooLarge => {
                Self::bad(e)
            }
            _ => Self::internal(e),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut r = (
            self.0,
            Json(json!({"error":{"code":self.code(),"message":self.1}})),
        )
            .into_response();
        if self.0 == StatusCode::UNAUTHORIZED {
            r.headers_mut().insert(
                "www-authenticate",
                HeaderValue::from_static("Bearer realm=\"chronograph\""),
            );
        }
        if matches!(
            self.0,
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
        ) {
            r.headers_mut()
                .insert("retry-after", HeaderValue::from_static("60"));
        }
        r
    }
}
pub struct AppState {
    graph: RwLock<Graph>,
    schema: RwLock<schema::Catalog>,
    auth: Mutex<auth::Auth>,
    pub data: PathBuf,
    origin: String,
    authority: String,
    secure: bool,
    jobs: Arc<Semaphore>,
    admission: Arc<Semaphore>,
    auth_jobs: Arc<Semaphore>,
    started: Instant,
    require_fsync: bool,
    requests_total: AtomicU64,
    server_errors_total: AtomicU64,
}
pub struct WorkPermit {
    _admission: OwnedSemaphorePermit,
    _worker: OwnedSemaphorePermit,
}
impl AppState {
    pub fn open(
        data: impl AsRef<Path>,
        config: impl AsRef<Path>,
        origin: &str,
    ) -> AppResult<Shared> {
        Self::open_with_policy(data, config, origin, false)
    }
    /// Open a workspace with an operator-enforced durable acknowledgement floor.
    pub fn open_with_policy(
        data: impl AsRef<Path>,
        config: impl AsRef<Path>,
        origin: &str,
        require_fsync: bool,
    ) -> AppResult<Shared> {
        let url = validate_origin(origin)?;
        auth::private_dir(data.as_ref())?;
        let data = data.as_ref().canonicalize()?;
        let config = config.as_ref();
        let config_parent = config
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .canonicalize()?;
        if config_parent.starts_with(&data) {
            return Err(ApiError::bad(
                "CHRONOGRAPH_AUTH must be outside CHRONOGRAPH_DATA so backups never contain credentials",
            ));
        }
        // Ownership is acquired before opening auth, and old journal formats fail explicitly.
        let graph = Graph::open(data.join("graph.cgraph"))?;
        let schema = schema::Catalog::open(&data)?;
        let auth = auth::Auth::open(config, false)?;
        if !auth
            .credentials
            .tokens
            .iter()
            .any(|t| t.scope == Scope::Admin && t.expires_at > auth::now())
        {
            return Err(ApiError::bad(
                "No active admin token; run the offline admin create-token command first",
            ));
        }
        let authority = url[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
        Ok(Arc::new(Self {
            graph: RwLock::new(graph),
            schema: RwLock::new(schema),
            auth: Mutex::new(auth),
            data,
            origin: url.origin().ascii_serialization(),
            authority,
            secure: url.scheme() == "https",
            jobs: Arc::new(Semaphore::new(8)),
            admission: Arc::new(Semaphore::new(40)),
            auth_jobs: Arc::new(Semaphore::new(2)),
            started: Instant::now(),
            require_fsync,
            requests_total: AtomicU64::new(0),
            server_errors_total: AtomicU64::new(0),
        }))
    }
    pub fn sync(&self) -> AppResult<()> {
        self.graph.write().map_err(ApiError::internal)?.sync()?;
        Ok(())
    }
    pub async fn admit(&self) -> AppResult<WorkPermit> {
        let admission = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy())?;
        let worker = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.jobs.clone().acquire_owned(),
        )
        .await
        .map_err(|_| ApiError::busy())?
        .map_err(|_| ApiError::busy())?;
        Ok(WorkPermit {
            _admission: admission,
            _worker: worker,
        })
    }
}
pub fn validate_origin(origin: &str) -> AppResult<url::Url> {
    let url = url::Url::parse(origin).map_err(ApiError::bad)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ApiError::bad(
            "Expected an HTTP(S) origin without credentials, path, query or fragment",
        ));
    }
    if url.scheme() == "http"
        && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err(ApiError::bad("Remote connections require HTTPS"));
    }
    Ok(url)
}
async fn authenticate(
    State(state): State<Shared>,
    mut req: Request,
    next: Next,
) -> AppResult<Response> {
    let raw = req
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_owned();
    let check = state.auth.lock().map_err(ApiError::internal)?.begin(&raw)?;
    let principal = match check {
        Verification::Cached(p) => p,
        Verification::Hash(token) => {
            let permit = state
                .auth_jobs
                .clone()
                .try_acquire_owned()
                .map_err(|_| ApiError::busy())?;
            let s = state.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let ok = auth::verify(&raw, &token.argon2id);
                s.auth
                    .lock()
                    .map_err(ApiError::internal)?
                    .finish(&token, &raw, ok)
            })
            .await
            .map_err(ApiError::internal)??
        }
    };
    req.extensions_mut().insert(principal);
    Ok(next.run(req).await)
}
async fn boundary(State(s): State<Shared>, req: Request, next: Next) -> Response {
    s.requests_total.fetch_add(1, Ordering::Relaxed);
    // Reject DNS rebinding and cross-origin requests. Never trust forwarded host headers.
    let origin_ok = req
        .headers()
        .get("origin")
        .is_none_or(|v| v.to_str().ok() == Some(&s.origin));
    let host_ok = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| h.eq_ignore_ascii_case(&s.authority));
    let mut r = if origin_ok && host_ok {
        next.run(req).await
    } else {
        ApiError::forbidden().into_response()
    };
    if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
        r = ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Request body exceeds 4 MiB".into(),
        )
        .into_response();
    }
    for (k, v) in [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=()",
        ),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        r.headers_mut().insert(k, HeaderValue::from_static(v));
    }
    if r.status().is_server_error() {
        s.server_errors_total.fetch_add(1, Ordering::Relaxed);
    }
    if s.secure {
        r.headers_mut().insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    r
}

pub fn router(state: Shared, ui: impl AsRef<Path>, docs: impl AsRef<Path>) -> Router {
    let v1 = Router::new()
        .route("/info", get(info))
        .route("/metrics", get(metrics))
        .route("/stats", get(stats).post(stats_post))
        .route("/tokens", get(tokens).post(create_token))
        .route("/tokens/{id}", axum::routing::delete(revoke_token))
        .route("/export_arrow", post(export))
        .route("/backups", get(backups))
        .route("/backups/{id}", get(download_backup).delete(delete_backup))
        .route("/{op}", post(graph))
        .fallback(|| async { ApiError::missing("Unknown endpoint") });
    let private = Router::new()
        .nest("/v1", v1)
        .nest_service("/mcp", mcp::service(state.clone()))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .merge(private)
        .route(
            "/healthz",
            get(|| async {
                Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"stage":"alpha"}))
            }),
        )
        .route("/readyz", get(ready))
        .route(
            "/api/{*path}",
            axum::routing::any(|| async {
                ApiError::missing(
                    "Legacy password/cookie API was retired; use /v1 with a scoped bearer token",
                )
            }),
        )
        .nest_service("/docs", ServeDir::new(docs))
        .fallback_service(
            ServeDir::new(&ui).fallback(ServeFile::new(ui.as_ref().join("index.html"))),
        )
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .layer(RequestBodyLimitLayer::new(4 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .with_state(state)
}
fn body(input: Result<Json<Value>, JsonRejection>) -> AppResult<Value> {
    input.map(|Json(v)| v).map_err(|e| {
        ApiError(
            e.status(),
            "Expected a valid JSON request within the 4 MiB limit".into(),
        )
    })
}
async fn info(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
) -> AppResult<Json<Value>> {
    let catalog = s.schema.read().map_err(ApiError::internal)?;
    let settings = &catalog.snapshot()?.settings;
    let effective = if s.require_fsync {
        schema::Durability::Fsync
    } else {
        settings.default_durability.clone()
    };
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"edition":"community","credential":{"id":p.id,"scope":p.scope},"mcp_url":format!("{}/mcp",s.origin),"uptime_seconds":s.started.elapsed().as_secs(),"limits":{"body_bytes":4194304,"batch_edges":10000,"query_results":1000,"workers":8,"queue":32},"default_durability":effective,"require_fsync":s.require_fsync,"configured_default_durability":settings.default_durability,"workspace_name":settings.name}),
    ))
}
async fn ready(State(s): State<Shared>) -> AppResult<Json<Value>> {
    readiness(&s)
}
fn readiness(s: &Shared) -> AppResult<Json<Value>> {
    s.schema
        .try_read()
        .map_err(|_| ApiError::unavailable("Schema busy"))?
        .snapshot()?;
    if !s
        .graph
        .try_read()
        .map_err(|_| ApiError::unavailable("Engine busy"))?
        .is_writable()
    {
        return Err(ApiError::unavailable(
            "Journal writer requires operator recovery",
        ));
    }
    Ok(Json(json!({"status":"ready"})))
}
/// Prometheus text format; protected by the same read-scope authentication as stats.
async fn metrics(State(s): State<Shared>) -> AppResult<Response> {
    let graph = s
        .graph
        .try_read()
        .map_err(|_| ApiError::unavailable("Engine busy"))?;
    let stats = graph.stats();
    let body = format!(
        "# TYPE chronograph_uptime_seconds gauge\nchronograph_uptime_seconds {}\n\
# TYPE chronograph_http_requests_total counter\nchronograph_http_requests_total {}\n\
# TYPE chronograph_http_server_errors_total counter\nchronograph_http_server_errors_total {}\n\
# TYPE chronograph_graph_nodes gauge\nchronograph_graph_nodes {}\n\
# TYPE chronograph_edge_versions gauge\nchronograph_edge_versions {}\n\
# TYPE chronograph_journal_bytes gauge\nchronograph_journal_bytes {}\n\
# TYPE chronograph_recovered_tail_bytes gauge\nchronograph_recovered_tail_bytes {}\n\
# TYPE chronograph_writer_healthy gauge\nchronograph_writer_healthy {}\n\
# TYPE chronograph_workers_available gauge\nchronograph_workers_available {}\n\
# TYPE chronograph_admission_available gauge\nchronograph_admission_available {}\n\
# TYPE chronograph_fsync_required gauge\nchronograph_fsync_required {}\n",
        s.started.elapsed().as_secs(),
        s.requests_total.load(Ordering::Relaxed),
        s.server_errors_total.load(Ordering::Relaxed),
        stats.nodes,
        stats.edge_versions,
        stats.log_bytes,
        stats.recovered_tail_bytes,
        u8::from(graph.is_writable()),
        s.jobs.available_permits(),
        s.admission.available_permits(),
        u8::from(s.require_fsync)
    );
    Ok((
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
        .into_response())
}
async fn stats(State(s): State<Shared>) -> AppResult<Json<Value>> {
    Ok(Json(
        operations::execute(s, "stats".into(), json!({})).await?,
    ))
}
async fn stats_post(
    State(s): State<Shared>,
    input: Result<Json<Value>, JsonRejection>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        operations::execute(s, "stats".into(), body(input)?).await?,
    ))
}
async fn graph(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
    RoutePath(op): RoutePath<String>,
    input: Result<Json<Value>, JsonRejection>,
) -> AppResult<Json<Value>> {
    let op = operations::canonical(&op).to_owned();
    p.authorize(&op)?;
    Ok(Json(operations::execute(s, op, body(input)?).await?))
}
async fn tokens(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
) -> AppResult<Json<Value>> {
    p.authorize("tokens")?;
    Ok(Json(
        json!({"tokens":s.auth.lock().map_err(ApiError::internal)?.credentials.tokens.iter().map(Token::public).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewToken {
    name: String,
    scope: Scope,
    days: u64,
}
async fn create_token(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
    input: Result<Json<Value>, JsonRejection>,
) -> AppResult<Json<Value>> {
    p.authorize("create_token")?;
    let i: NewToken = operations::parse(body(input)?)?;
    let permit = s
        .auth_jobs
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::busy())?;
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let (token, raw) = Token::generate(&i.name, i.scope, i.days)?;
        let result = json!({"token":raw,"credential":token.public()});
        s.auth.lock().map_err(ApiError::internal)?.insert(token)?;
        Ok::<_, ApiError>(result)
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(Json(result))
}
async fn revoke_token(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
    RoutePath(id): RoutePath<String>,
) -> AppResult<Json<Value>> {
    p.authorize("revoke_token")?;
    let permit = s.admit().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        s.auth.lock().map_err(ApiError::internal)?.revoke(&id)
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(Json(json!({"revoked":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    t: String,
    #[serde(default)]
    fork: Option<String>,
}
async fn export(
    State(s): State<Shared>,
    input: Result<Json<Value>, JsonRejection>,
) -> AppResult<Response> {
    let input: Export = operations::parse(body(input)?)?;
    let t = operations::number(&input.t)?;
    let permit = s.admit().await?;
    let bytes=tokio::task::spawn_blocking(move ||->AppResult<Vec<u8>> { let _permit=permit;let g=s.graph.read().map_err(ApiError::internal)?;
        let fork = input.fork.as_deref().map(|s| operations::number(s).map(chronograph_db::ForkId)).transpose()?;
        let versions = if let Some(fork) = fork { let info = g.fork_info(fork)?; info.inherited_edges.saturating_add(info.delta_edges) } else { g.stats().edge_versions };
        if versions>1_000_000 { return Err(ApiError::bad("HTTP Arrow export is limited to 1M stored versions; use the Rust API for larger graphs")); }
        let batch=if let Some(fork) = fork {g.fork_view(fork,t)?.export_arrow()?} else {g.export_arrow(t)?};let mut bytes=vec![];{let mut writer=arrow::ipc::writer::StreamWriter::try_new(&mut bytes,&batch.schema()).map_err(ApiError::internal)?;writer.write(&batch).map_err(ApiError::internal)?;writer.finish().map_err(ApiError::internal)?;}Ok(bytes)
    }).await.map_err(ApiError::internal)??;
    Ok((
        [
            ("content-type", "application/vnd.apache.arrow.stream"),
            (
                "content-disposition",
                "attachment; filename=chronograph.arrow",
            ),
        ],
        bytes,
    )
        .into_response())
}
async fn backups(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
) -> AppResult<Json<Value>> {
    p.authorize("backups")?;
    let permit = s.admit().await?;
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            Ok::<_, ApiError>(json!({"backups":backup::list(&s.data)?}))
        })
        .await
        .map_err(ApiError::internal)??,
    ))
}
async fn download_backup(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
    RoutePath(id): RoutePath<String>,
) -> AppResult<Response> {
    p.authorize("backup")?;
    let permit = s.admit().await?;
    let file = tokio::fs::File::open(backup::path(&s.data, &id)?)
        .await
        .map_err(|_| ApiError::missing("Backup does not exist"))?;
    // Streaming holds a permit until the response body is dropped/completed.
    let stream = tokio_util::io::ReaderStream::new(PermittedFile {
        file,
        _permit: permit,
    });
    Ok((
        [
            ("content-type", "application/x-tar"),
            (
                "content-disposition",
                "attachment; filename=chronograph-backup.tar",
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
struct PermittedFile {
    file: tokio::fs::File,
    _permit: WorkPermit,
}
impl tokio::io::AsyncRead for PermittedFile {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.file).poll_read(cx, buf)
    }
}
async fn delete_backup(
    State(s): State<Shared>,
    Extension(p): Extension<Principal>,
    RoutePath(id): RoutePath<String>,
) -> AppResult<Json<Value>> {
    p.authorize("delete_backup")?;
    let permit = s.admit().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        std::fs::remove_file(backup::path(&s.data, &id)?)?;
        std::fs::File::open(s.data.join("backups"))?.sync_all()?;
        Ok::<_, ApiError>(())
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(Json(json!({"deleted":true})))
}

#[cfg(test)]
mod service_tests {
    use super::*;
    use axum::body::to_bytes;
    use tower::ServiceExt;
    struct Fixture {
        _dir: tempfile::TempDir,
        state: Shared,
        app: Router,
        admin: String,
        read: String,
        ingest: String,
        read_id: String,
    }
    fn fixture() -> Fixture {
        fixture_with_policy(false)
    }
    fn fixture_with_policy(require_fsync: bool) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config/auth.json");
        let mut auth = auth::Auth::open(&config, true).unwrap();
        let (a, admin) = Token::generate("admin", Scope::Admin, 1).unwrap();
        let (r, read) = Token::generate("reader", Scope::Read, 1).unwrap();
        let read_id = r.id.clone();
        let (i, ingest) = Token::generate("writer", Scope::Ingest, 1).unwrap();
        for t in [a, r, i] {
            auth.insert(t).unwrap();
        }
        drop(auth);
        let state = AppState::open_with_policy(
            dir.path().join("data"),
            config,
            "http://127.0.0.1:18081",
            require_fsync,
        )
        .unwrap();
        let app = router(
            state.clone(),
            dir.path().join("ui"),
            dir.path().join("docs"),
        );
        Fixture {
            _dir: dir,
            state,
            app,
            admin,
            read,
            ingest,
            read_id,
        }
    }
    fn request(path: &str, token: &str, args: Value) -> Request {
        Request::builder()
            .method("POST")
            .uri(path)
            .header("host", "127.0.0.1:18081")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(args.to_string()))
            .unwrap()
    }
    async fn call(f: &Fixture, path: &str, token: &str, args: Value) -> (StatusCode, Value) {
        let r = f
            .app
            .clone()
            .oneshot(request(path, token, args))
            .await
            .unwrap();
        let status = r.status();
        let bytes = to_bytes(r.into_body(), 8 * 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    #[tokio::test]
    async fn migration_plan_scopes_and_concurrent_compare_and_swap() {
        let f = fixture();
        let source = json!({"version":3,"id":"a","name":"First","operations":[{"op":"set_settings","settings":{"name":"First"}}]}).to_string();
        let preview = call(&f, "/v1/schema_plan", &f.read, json!({"sources":[source]})).await;
        assert_eq!(preview.0, StatusCode::OK);
        let request =
            json!({"sources":[source],"checksum":preview.1["checksum"],"expected_revision":0});
        for token in [&f.read, &f.ingest] {
            assert_eq!(
                call(&f, "/v1/schema_apply_plan", token, request.clone())
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
        let other = json!({"version":3,"id":"b","name":"Other","operations":[{"op":"set_settings","settings":{"name":"Other"}}]}).to_string();
        let preview2 = call(&f, "/v1/schema_plan", &f.read, json!({"sources":[other]}))
            .await
            .1;
        let other_request =
            json!({"sources":[other],"checksum":preview2["checksum"],"expected_revision":0});
        let (a, b) = tokio::join!(
            call(&f, "/v1/schema_apply_plan", &f.admin, request),
            call(&f, "/v1/schema_apply_plan", &f.admin, other_request)
        );
        assert!(
            (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
                || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
        );
        assert_eq!(
            call(&f, "/v1/schema", &f.read, json!({})).await.1["revision"],
            1
        );
    }
    #[tokio::test]
    async fn production_policy_requires_durable_writes_and_protects_metrics() {
        let f = fixture_with_policy(true);
        let (status, _) = call(
            &f,
            "/v1/add_node",
            &f.ingest,
            json!({"id":"90","durability":"buffered"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(f.state.graph.read().unwrap().stats().nodes, 0);
        assert_eq!(
            call(&f, "/v1/add_node", &f.ingest, json!({"id":"90"}))
                .await
                .0,
            StatusCode::OK
        );
        let stats = call(&f, "/v1/stats", &f.read, json!({})).await.1;
        assert_eq!(stats["default_durability"], "fsync");
        assert_eq!(stats["require_fsync"], true);
        assert_eq!(stats["writer_healthy"], true);
        let source = json!({"version":1,"id":"unsafe_policy","name":"Unsafe","operations":[{"op":"set_settings","settings":{"default_durability":"buffered"}}]}).to_string();
        for op in ["schema_preview", "schema_apply"] {
            assert_eq!(
                call(&f, &format!("/v1/{op}"), &f.admin, json!({"source":source}))
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        for op in ["schema_plan", "schema_apply_plan"] {
            assert_eq!(
                call(
                    &f,
                    &format!("/v1/{op}"),
                    &f.admin,
                    json!({"sources":[source]})
                )
                .await
                .0,
                StatusCode::BAD_REQUEST
            );
        }
        for (token, expected) in [
            ("", StatusCode::UNAUTHORIZED),
            (f.read.as_str(), StatusCode::OK),
        ] {
            let request = Request::builder()
                .uri("/v1/metrics")
                .header("host", "127.0.0.1:18081")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap();
            let response = f.app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected);
            let body = to_bytes(response.into_body(), 65536).await.unwrap();
            let text = String::from_utf8(body.to_vec()).unwrap();
            assert!(!text.contains(&f.admin));
            assert!(!text.contains(&f.read));
            if expected == StatusCode::OK {
                assert!(text.contains("chronograph_graph_nodes 1\n"));
                assert!(text.contains("chronograph_fsync_required 1\n"));
            }
        }
        let mut lock = f.state.graph.write().unwrap();
        lock.sync().unwrap();
        assert_eq!(
            readiness(&f.state).unwrap_err().0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        drop(lock);
        assert!(readiness(&f.state).is_ok());
    }
    #[tokio::test]
    async fn schema_scope_settings_structured_writes_and_concurrent_apply() {
        let f = fixture();
        let source = json!({"version":1,"id":"001","name":"Observations","operations":[{"op":"upsert_relation","relation":{"kind":7,"name":"observes","source_label":"sensor","target_label":"object","properties":[{"name":"sequence","type":"u64","offset":0}]}},{"op":"set_settings","settings":{"default_durability":"fsync","default_query_limit":1,"strict_relations":true}}]}).to_string();
        assert_eq!(
            call(&f, "/v1/schema", &f.read, json!({})).await.0,
            StatusCode::OK
        );
        let (status, preview) =
            call(&f, "/v1/schema_preview", &f.read, json!({"source":source})).await;
        assert_eq!(status, StatusCode::OK);
        let request = json!({"source":source,"expected_revision":0,"checksum":preview["checksum"]});
        for token in [&f.read, &f.ingest] {
            assert_eq!(
                call(&f, "/v1/schema_apply", token, request.clone()).await.0,
                StatusCode::FORBIDDEN
            );
        }
        let (a, b) = tokio::join!(
            call(&f, "/v1/schema_apply", &f.admin, request.clone()),
            call(&f, "/v1/schema_apply", &f.admin, request)
        );
        assert_eq!(a.0, StatusCode::OK);
        assert_eq!(b.0, StatusCode::OK);
        assert_ne!(a.1["applied"], b.1["applied"]);
        assert_eq!(
            call(&f, "/v1/schema", &f.read, json!({})).await.1["revision"],
            1
        );
        let edge = json!({"src":"1","dst":"2","kind":7,"valid_from":"0","properties":{"sequence":u64::MAX.to_string()}});
        let mut bad = edge.clone();
        bad["properties"]["sequence"] = json!(12);
        assert_eq!(
            call(&f, "/v1/edges", &f.ingest, json!({"edges":[edge,bad]}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&f, "/v1/stats", &f.read, json!({})).await.1["edge_versions"],
            "0"
        );
        let (status, write) = call(
            &f,
            "/v1/edges",
            &f.ingest,
            json!({"edges":[edge.clone(),{ "src":"3","dst":"4","kind":7,"valid_from":"0" }]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(write["durability"], "fsync");
        let (_, result) = call(&f, "/v1/history", &f.read, json!({})).await;
        assert_eq!(result["edges"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["edges"][0]["properties"]["sequence"],
            u64::MAX.to_string()
        );
        assert_eq!(result["edges"][0]["relation"], "observes");
        assert_eq!(
            call(&f, "/v1/history", &f.read, json!({"limit":2})).await.1["edges"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let mut unknown = edge.clone();
        unknown["kind"] = json!(8);
        unknown.as_object_mut().unwrap().remove("properties");
        assert_eq!(
            call(&f, "/v1/edges", &f.ingest, json!({"edges":[unknown]}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let (_, buffered) = call(
            &f,
            "/v1/nodes",
            &f.ingest,
            json!({"id":"5","durability":"buffered"}),
        )
        .await;
        assert_eq!(buffered["durability"], "buffered");
    }
    #[tokio::test]
    async fn scopes_exact_ids_durability_pagination_and_revocation() {
        let f = fixture();
        let batch = json!({"edges":[{"src":"18446744073709551615","dst":"2","kind":1,"valid_from":"-9"},{"src":"3","dst":"4","kind":2,"valid_from":"0"}],"durability":"fsync"});
        assert_eq!(
            call(&f, "/v1/edges", &f.read, batch.clone()).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&f, "/v1/backup", &f.ingest, json!({})).await.0,
            StatusCode::FORBIDDEN
        );
        let (status, write) = call(&f, "/v1/edges", &f.ingest, batch).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(write["durability"], "fsync");
        assert_eq!(write["ids"], json!(["0", "1"]));
        let (status, first) = call(&f, "/v1/as_of", &f.read, json!({"t":"0","limit":1})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["edges"][0]["src"], u64::MAX.to_string());
        let cursor = first["next_cursor"].clone();
        assert!(cursor.is_string());
        let (status, second) = call(
            &f,
            "/v1/as_of",
            &f.read,
            json!({"t":"0","limit":1,"cursor":cursor}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(second["edges"][0]["src"], "3");
        assert!(second["next_cursor"].is_null());
        assert_eq!(
            call(
                &f,
                "/v1/as_of",
                &f.read,
                json!({"t":"1","limit":1,"cursor":cursor})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let (_, write) = call(&f, "/v1/nodes", &f.ingest, json!({"id":"9"})).await;
        assert_eq!(write["durability"], "buffered");
        assert_eq!(
            call(
                &f,
                "/v1/as_of",
                &f.read,
                json!({"t":"0","limit":1,"cursor":cursor})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/v1/tokens/{}", f.read_id))
            .header("host", "127.0.0.1:18081")
            .header("authorization", format!("Bearer {}", f.admin))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            f.app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            call(&f, "/v1/stats", &f.read, json!({})).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn invalid_requests_cannot_mutate_and_cookie_routes_are_retired() {
        let f = fixture();
        let (_, before) = call(&f, "/v1/stats", &f.admin, json!({})).await;
        for args in [
            json!({"edges":[]}),
            json!({"edges":[{"src":1,"dst":"2","kind":0,"valid_from":"0"}]}),
            json!({"edges":[{"src":"1","dst":"2","kind":0,"valid_from":"9223372036854775807"}]}),
            json!({"edges":[{"src":"1","dst":"2","kind":0,"valid_from":"0","extra":1}]}),
            json!({"edges":[{"src":"1","dst":"2","kind":0,"valid_from":"0"}],"durability":"maybe"}),
        ] {
            assert_eq!(
                call(&f, "/v1/edges", &f.admin, args).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let (_, after) = call(&f, "/v1/stats", &f.admin, json!({})).await;
        assert_eq!(before["revision"], after["revision"]);
        let mut req = request("/v1/stats", "", json!({}));
        req.headers_mut().remove("authorization");
        req.headers_mut()
            .insert("cookie", HeaderValue::from_static("cg_session=old"));
        let r = f.app.clone().oneshot(req).await.unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert!(r.headers().contains_key("www-authenticate"));
        assert!(r.headers().contains_key("content-security-policy"));
        assert_eq!(
            call(&f, "/api/login", &f.admin, json!({"password":"unused"}))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let mut req = request("/v1/stats", &f.admin, json!({}));
        req.headers_mut().insert(
            "origin",
            HeaderValue::from_static("https://attacker.invalid"),
        );
        assert_eq!(
            f.app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let mut req = request("/v1/stats", &f.admin, json!({}));
        req.headers_mut()
            .insert("host", HeaderValue::from_static("attacker.invalid"));
        assert_eq!(
            f.app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let mut req = request("/v1/edges", &f.admin, json!({}));
        *req.body_mut() = Body::from_stream(tokio_util::io::ReaderStream::new(
            std::io::Cursor::new(vec![b'x'; 4 * 1024 * 1024 + 1]),
        ));
        let r = f.app.clone().oneshot(req).await.unwrap();
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let bytes = to_bytes(r.into_body(), 1000).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["error"]["code"],
            "PAYLOAD_TOO_LARGE"
        );
    }
    #[tokio::test]
    async fn branch_scopes_preview_merge_cursor_and_bounded_edges() {
        let f = fixture();
        let input = json!({"src":"1","dst":"2","kind":1,"valid_from":"0"});
        assert_eq!(
            call(&f, "/v1/add_edges", &f.ingest, json!({"edges":[input]}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&f, "/v1/fork", &f.read, json!({"t":"10","name":"denied"}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (status, created) = call(
            &f,
            "/v1/fork",
            &f.ingest,
            json!({"t":"10","name":"candidate","durability":"fsync"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let id = created["fork"]["id"].clone();
        assert_eq!(created["fork"]["timestamp"], "10");
        assert_eq!(created["durability"], "fsync");
        let (status,write) = call(&f,"/v1/add_edges",&f.ingest,json!({"fork":id,"edges":[{"src":"1","dst":"2","kind":1,"valid_from":"20","valid_to":"25"},{"src":"1","dst":"9","kind":1,"valid_from":"30"}]})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(write["ids"], json!(["1", "2"]));
        assert_eq!(
            call(&f, "/v1/as_of", &f.read, json!({"fork":id,"t":"9"}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let (status, history) =
            call(&f, "/v1/history", &f.read, json!({"fork":id,"limit":1})).await;
        assert_eq!(status, StatusCode::OK);
        let cursor = history["next_cursor"].clone();
        assert!(cursor.is_string());
        assert_eq!(
            call(
                &f,
                "/v1/history",
                &f.read,
                json!({"limit":1,"cursor":cursor})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(&f, "/v1/get_edge", &f.read, json!({"fork":id,"id":"1"}))
                .await
                .1["valid_to"],
            "25"
        );
        assert_eq!(
            call(&f, "/v1/as_of", &f.read, json!({"fork":id,"t":"27"}))
                .await
                .1["count"],
            0
        );
        let (status, preview) = call(&f, "/v1/preview_merge", &f.read, json!({"fork":id})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            preview["merge"]["nodes"],
            json!([{"branch":"9","parent":"0"}])
        );
        assert_eq!(
            call(&f, "/v1/merge", &f.read, json!({"fork":id})).await.0,
            StatusCode::FORBIDDEN
        );
        let (status, merged) = call(
            &f,
            "/v1/merge",
            &f.ingest,
            json!({"fork":id,"durability":"fsync"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(merged["merge"], preview["merge"]);
        let retry = call(
            &f,
            "/v1/merge",
            &f.ingest,
            json!({"fork":id,"durability":"fsync"}),
        )
        .await
        .1;
        assert_eq!(retry["revision"], merged["revision"]);
        assert_eq!(retry["merge"], merged["merge"]);
        assert_eq!(
            call(&f, "/v1/history", &f.read, json!({"fork":id})).await.0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(&f, "/v1/fork_info", &f.read, json!({"fork":"999"}))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(&f, "/v1/forks", &f.read, json!({"limit":1})).await.1["forks"][0]["status"],
            "merged"
        );
        assert_eq!(
            call(&f, "/v1/as_of", &f.read, json!({"t":"27"})).await.1["count"],
            0
        );
    }
    #[tokio::test]
    async fn worker_queue_is_bounded_and_cancellation_releases_waiters() {
        let f = fixture();
        assert_eq!(
            call(&f, "/v1/stats", &f.read, json!({})).await.0,
            StatusCode::OK
        );
        let mut running = vec![];
        for _ in 0..8 {
            running.push(f.state.admit().await.unwrap());
        }
        let mut queued = vec![];
        for _ in 0..32 {
            let app = f.app.clone();
            let req = request("/v1/stats", &f.read, json!({}));
            queued.push(tokio::spawn(async move { app.oneshot(req).await.unwrap() }));
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while f.state.admission.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            call(&f, "/v1/stats", &f.read, json!({})).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        for job in queued {
            job.abort();
            let _ = job.await;
        }
        assert_eq!(f.state.admission.available_permits(), 32);
        drop(running);
        assert_eq!(f.state.admission.available_permits(), 40);
        assert_eq!(f.state.jobs.available_permits(), 8);
    }
}
