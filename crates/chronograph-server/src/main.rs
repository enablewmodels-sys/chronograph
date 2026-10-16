use chronograph_server::{AppState, router};
use std::{net::SocketAddr, path::PathBuf};

/// One listening socket per acceptor.
///
/// A single listener leaves every connection to one accept queue and one task, so a burst is
/// serialised before any handler runs. `SO_REUSEPORT` lets the kernel hash an incoming
/// connection straight to a worker's own queue, which is why the count follows the machine.
/// Unsupported platforms, and a kernel that refuses the option, keep the single-listener path.
fn acceptors() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(1, 8))
        .unwrap_or(1)
}

fn listeners(addr: SocketAddr, count: usize) -> std::io::Result<Vec<tokio::net::TcpListener>> {
    let mut bound = Vec::with_capacity(count);
    for _ in 0..count {
        let domain = if addr.is_ipv4() {
            socket2::Domain::IPV4
        } else {
            socket2::Domain::IPV6
        };
        let socket =
            socket2::Socket::new(domain, socket2::Type::STREAM, Some(socket2::Protocol::TCP))?;
        socket.set_reuse_address(true)?;
        #[cfg(unix)]
        socket.set_reuse_port(true)?;
        socket.set_nonblocking(true)?;
        socket.bind(&addr.into())?;
        socket.listen(1024)?;
        bound.push(tokio::net::TcpListener::from_std(socket.into())?);
    }
    Ok(bound)
}

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
            "alpha — validate operational limits for your deployment\nchronograph-server [serve|check|import FILE.csv|restore BACKUP|migrate-v1 SOURCE DEST|migrate-v2 SOURCE DEST|admin create-token NAME SCOPE DAYS OUTPUT_FILE]\nSCOPE: read, ingest, admin. Offline commands lock the workspace; stop the service first. Tokens are written once to a new mode-0600 file.\nEnvironment: CHRONOGRAPH_DATA (./community-data), CHRONOGRAPH_AUTH (./config/auth.json, outside data), CHRONOGRAPH_BIND (127.0.0.1:8080), CHRONOGRAPH_ORIGIN (http://127.0.0.1:8080), CHRONOGRAPH_UI (ui/dist), CHRONOGRAPH_DOCS (docs), CHRONOGRAPH_REQUIRE_FSYNC (false; set true to require durable writes).\nImport reads src,dst,kind,valid_from[,valid_to][,payload] and validates every row before writing. Restore requires an absent or empty destination. Migration preserves its source and creates a new journal destination. Legacy password/cookie auth is retired."
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
    if cmd == "import" {
        let source = PathBuf::from(args.next().ok_or("CSV file required")?);
        if args.next().is_some() {
            return Err("Unexpected arguments".into());
        }
        println!(
            "{}",
            chronograph_server::import::import_csv(&data, &source)?
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
    let app = router(state.clone(), ui, docs);
    let wanted = acceptors();
    let listeners = match listeners(addr, wanted) {
        Ok(listeners) => listeners,
        Err(error) => {
            eprintln!("Reusing one listening socket instead of {wanted}: {error}");
            vec![tokio::net::TcpListener::bind(addr).await?]
        }
    };
    let count = listeners.len();
    eprintln!("ChronoDB listening on {addr} with {count} acceptor(s); public origin {origin}");
    // Reported rather than acted on: the completion backend is implemented and type-checked for
    // Linux, and switching the serving path to it needs a Linux run that can measure it.
    match chronograph_uring::available() {
        true => eprintln!("io_uring is available on this kernel (the portable listener is serving)"),
        false => eprintln!(
            "io_uring is unavailable: {}",
            chronograph_uring::unavailable_reason().unwrap_or_else(|| "refused".into())
        ),
    }
    // One shutdown signal for every acceptor, so Ctrl+C drains all of them and then syncs.
    let (stop, signal) = tokio::sync::watch::channel(false);
    let mut servers = Vec::with_capacity(count);
    for listener in listeners {
        let app = app.clone();
        let mut signal = signal.clone();
        servers.push(tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = signal.wait_for(|stop| *stop).await;
                })
                .await;
        }));
    }
    shutdown().await;
    let _ = stop.send(true);
    for server in servers {
        let _ = server.await;
    }
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
