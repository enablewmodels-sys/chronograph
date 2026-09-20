use chronograph_server::{AppState, router};
use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "serve".into());
    let data = PathBuf::from(
        std::env::var("CHRONOGRAPH_DATA").unwrap_or_else(|_| "community-data".into()),
    );
    let config = PathBuf::from(
        std::env::var("CHRONOGRAPH_AUTH").unwrap_or_else(|_| "config/auth.json".into()),
    );
    let origin =
        std::env::var("CHRONOGRAPH_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    if matches!(cmd.as_str(), "--help" | "-h") {
        println!(
            "alpha — validate operational limits for your deployment\nchronograph-server [serve|check|restore BACKUP|migrate-v1 SOURCE DEST|migrate-v2 SOURCE DEST|admin create-token NAME SCOPE DAYS OUTPUT_FILE]\nSCOPE: read, ingest, admin. Offline admin locks config; stop the service first. Tokens are written once to a new mode-0600 file.\nEnvironment: CHRONOGRAPH_DATA (./community-data), CHRONOGRAPH_AUTH (./config/auth.json, outside data), CHRONOGRAPH_BIND (127.0.0.1:8080), CHRONOGRAPH_ORIGIN (http://127.0.0.1:8080), CHRONOGRAPH_UI (ui/dist), CHRONOGRAPH_DOCS (docs), CHRONOGRAPH_REQUIRE_FSYNC (false; set true to require durable writes).\nRestore requires an absent or empty destination. Migration preserves its source and creates a new journal destination. Legacy password/cookie auth is retired."
        );
        return Ok(());
    }
    if cmd == "admin" {
        if args.next().as_deref() != Some("create-token") {
            return Err("Expected admin create-token NAME SCOPE DAYS OUTPUT_FILE".into());
        }
        let name = args.next().ok_or("Token name required")?;
        let scope = match args.next().as_deref() {
            Some("read") => chronograph_server::auth::Scope::Read,
            Some("ingest") => chronograph_server::auth::Scope::Ingest,
            Some("admin") => chronograph_server::auth::Scope::Admin,
            _ => return Err("Scope must be read, ingest or admin".into()),
        };
        let days = args.next().ok_or("Expiry days required")?.parse()?;
        let out = PathBuf::from(args.next().ok_or("Output file required")?);
        if args.next().is_some() {
            return Err("Unexpected arguments".into());
        }
        let mut auth = chronograph_server::auth::Auth::open(&config, true)?;
        let (token, raw) = chronograph_server::auth::Token::generate(&name, scope, days)?;
        let public = token.public();
        chronograph_server::auth::write_new_private(&out, format!("{raw}\n").as_bytes())?;
        if let Err(e) = auth.insert(token) {
            let _ = std::fs::remove_file(&out);
            return Err(e.into());
        }
        println!(
            "{}",
            serde_json::json!({"credential":public,"token_file":out})
        );
        return Ok(());
    }
    if matches!(cmd.as_str(), "migrate-v1" | "migrate-v2") {
        let source = PathBuf::from(args.next().ok_or("Source journal required")?);
        let dest = PathBuf::from(args.next().ok_or("New destination journal required")?);
        if args.next().is_some() {
            return Err("Unexpected arguments".into());
        }
        let stats = if cmd == "migrate-v1" {
            chronograph_db::Graph::migrate_v1(source, dest)?
        } else {
            chronograph_db::Graph::migrate_v2(source, dest)?
        };
        println!(
            "{}",
            serde_json::json!({"migrated":true,"nodes":stats.nodes.to_string(),"edge_versions":stats.edge_versions.to_string()})
        );
        return Ok(());
    }
    if cmd == "restore" {
        let source = PathBuf::from(args.next().ok_or("Backup archive required")?);
        if args.next().is_some() {
            return Err("Unexpected arguments".into());
        }
        println!("{}", chronograph_server::backup::restore(&source, &data)?);
        return Ok(());
    }
    if cmd == "check" {
        if !data.join("graph.cgraph").is_file() {
            return Err("Journal does not exist".into());
        }
        let graph = chronograph_db::Graph::open(data.join("graph.cgraph"))?;
        println!(
            "{}",
            serde_json::json!({"revision":graph.revision().to_string(),"nodes":graph.stats().nodes.to_string(),"edge_versions":graph.stats().edge_versions.to_string(),"recovered_tail_bytes":graph.stats().recovered_tail_bytes.to_string()})
        );
        graph.close()?;
        return Ok(());
    }
    if cmd != "serve" || args.next().is_some() {
        return Err("Unknown command or arguments; see --help".into());
    }
    let require_fsync = std::env::var("CHRONOGRAPH_REQUIRE_FSYNC")
        .unwrap_or_else(|_| "false".into())
        .parse::<bool>()?;
    let state = AppState::open_with_policy(&data, &config, &origin, require_fsync)?;
    let ui = std::env::var("CHRONOGRAPH_UI").unwrap_or_else(|_| "ui/dist".into());
    if !PathBuf::from(&ui).join("index.html").is_file() {
        return Err(
            "UI build missing. Run npm ci && npm run build in ui/ first, or set CHRONOGRAPH_UI."
                .into(),
        );
    }
    let docs = std::env::var("CHRONOGRAPH_DOCS").unwrap_or_else(|_| "docs".into());
    let addr: SocketAddr = std::env::var("CHRONOGRAPH_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!("Chronograph listening on {addr}; public origin {origin}");
    axum::serve(listener, router(state.clone(), ui, docs))
        .with_graceful_shutdown(shutdown())
        .await?;
    state.sync()?;
    eprintln!("Shutdown complete; log synchronized.");
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
