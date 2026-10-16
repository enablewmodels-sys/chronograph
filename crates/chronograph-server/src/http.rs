//! A hand-written HTTP/1.1 connection layer.
//!
//! WHY: axum on hyper is correct, portable and well tested, and this module does not replace it
//! as the default. What it replaces is the bytes-to-request and response-to-bytes half of it: a
//! general-purpose server allocates a request head, a response head and often a body buffer for
//! every exchange, and parses through a body type that can stream from anywhere. This serves the
//! same router through the same handlers with a parser that reads straight out of one buffer the
//! connection reuses, so a keep-alive conversation stops allocating after its first request.
//!
//! It is opt-in: `CHRONOGRAPH_HTTP=own` selects it on start-up, and the noise of a wrong
//! connection layer is exactly the kind of change that should not arrive by default. The tests
//! below hold it to the same answers as hyper for the same bytes, which is the property that
//! matters; `CHRONOGRAPH_HTTP=hyper` gets the general-purpose path back.

use std::io;

use axum::body::Body;
use axum::http::{HeaderName, HeaderValue, Method, Request, Response, StatusCode, Version};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tower::ServiceExt;

/// Longest request line accepted, including the method and version.
pub const MAX_REQUEST_LINE: usize = 8 * 1024;
/// Most header fields accepted in one request. A field repeated is still one line each.
pub const MAX_HEADERS: usize = 100;
/// Head plus body, matching the 4 MiB request-body limit the router already enforces.
pub const MAX_TOTAL: usize = 4 * 1024 * 1024 + 64 * 1024;

/// One parsed request, or why the buffer does not hold one yet.
#[derive(Debug)]
pub enum Step {
    /// A complete request and the number of bytes it occupied.
    Ready {
        method: Method,
        target: String,
        version: Version,
        headers: Vec<(HeaderName, HeaderValue)>,
        body: Vec<u8>,
        consumed: usize,
        keep_alive: bool,
    },
    /// The buffer holds a prefix of a request; read more.
    Incomplete,
    /// The request cannot be served as written. The reason is what the client is told.
    Invalid(&'static str),
}

/// Parse one request from the front of `buf`.
///
/// The rules that matter are the ones a proxy in front of the database also checks, because two
/// parsers disagreeing about one message is how a request is smuggled past the outer one: a
/// message may not carry both `Content-Length` and `Transfer-Encoding`, two `Content-Length`
/// values may not disagree, `Transfer-Encoding` may only be `chunked`, and a header line may
/// not begin with whitespace (obs-fold), which some proxies unfold and others reject.
pub fn parse(buf: &[u8]) -> Step {
    let head_end = match find_head_end(buf) {
        Some(end) => end,
        None => {
            if buf.len() > MAX_REQUEST_LINE + MAX_HEADERS * 256 {
                return Step::Invalid("Request head is too large");
            }
            return Step::Incomplete;
        }
    };
    let head = &buf[..head_end];
    if head.len() > MAX_REQUEST_LINE + MAX_HEADERS * 256 {
        return Step::Invalid("Request head is too large");
    }
    let mut lines = head.split(|byte| *byte == b'\n').map(trim_cr);
    let Some(request_line) = lines.next() else {
        return Step::Invalid("Empty request");
    };
    let mut parts = request_line
        .split(|byte| *byte == b' ')
        .filter(|p| !p.is_empty());
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Step::Invalid("Malformed request line");
    };
    if parts.next().is_some() {
        return Step::Invalid("Malformed request line");
    }
    let Ok(method) = Method::from_bytes(method) else {
        return Step::Invalid("Unknown method");
    };
    let Ok(target) = std::str::from_utf8(target) else {
        return Step::Invalid("Request target is not UTF-8");
    };
    // Origin-form only: a server is not a proxy, and accepting an absolute target invites one.
    if !target.starts_with('/') && target != "*" {
        return Step::Invalid("Request target must be origin-form");
    }
    let version = match version {
        b"HTTP/1.1" => Version::HTTP_11,
        b"HTTP/1.0" => Version::HTTP_10,
        _ => return Step::Invalid("Unsupported HTTP version"),
    };

    let mut headers: Vec<(HeaderName, HeaderValue)> = Vec::new();
    let mut content_length: Option<u64> = None;
    let mut chunked = false;
    let mut keep_alive = version == Version::HTTP_11;
    let mut count = 0;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if line[0] == b' ' || line[0] == b'\t' {
            return Step::Invalid("Obsolete line folding is not accepted");
        }
        count += 1;
        if count > MAX_HEADERS {
            return Step::Invalid("Too many header fields");
        }
        let Some(colon) = line.iter().position(|byte| *byte == b':') else {
            return Step::Invalid("Header without a colon");
        };
        let Ok(name) = HeaderName::from_bytes(trim(&line[..colon])) else {
            return Step::Invalid("Invalid header name");
        };
        let value = trim(&line[colon + 1..]);
        let Ok(value) = HeaderValue::from_bytes(value) else {
            return Step::Invalid("Invalid header value");
        };
        if name == axum::http::header::CONTENT_LENGTH {
            let Ok(text) = std::str::from_utf8(value.as_bytes()) else {
                return Step::Invalid("Content-Length is not a number");
            };
            let Ok(length) = text.trim().parse::<u64>() else {
                return Step::Invalid("Content-Length is not a number");
            };
            // Two identical values are tolerated; two different ones are a smuggling attempt.
            match content_length {
                Some(previous) if previous != length => {
                    return Step::Invalid("Conflicting Content-Length values");
                }
                _ => content_length = Some(length),
            }
        }
        if name == axum::http::header::TRANSFER_ENCODING {
            if !value.as_bytes().eq_ignore_ascii_case(b"chunked") {
                return Step::Invalid("Only chunked transfer-encoding is supported");
            }
            chunked = true;
        }
        if name == axum::http::header::CONNECTION {
            if value.as_bytes().eq_ignore_ascii_case(b"close") {
                keep_alive = false;
            } else if value.as_bytes().eq_ignore_ascii_case(b"keep-alive") {
                keep_alive = true;
            }
        }
        headers.push((name, value));
    }

    if chunked && content_length.is_some() {
        return Step::Invalid("Content-Length and Transfer-Encoding together");
    }

    let body_start = head_end;
    if chunked {
        return match decode_chunked(&buf[body_start..]) {
            Ok(Some((body, used))) => Step::Ready {
                method,
                target: target.to_string(),
                version,
                headers,
                body,
                consumed: body_start + used,
                keep_alive,
            },
            Ok(None) => {
                if buf.len() > MAX_TOTAL {
                    Step::Invalid("Request is too large")
                } else {
                    Step::Incomplete
                }
            }
            Err(reason) => Step::Invalid(reason),
        };
    }

    let length = content_length.unwrap_or(0);
    if length as usize > MAX_TOTAL {
        return Step::Invalid("Request body is too large");
    }
    let Some(total) = body_start.checked_add(length as usize) else {
        return Step::Invalid("Request length overflows");
    };
    if buf.len() < total {
        return Step::Incomplete;
    }
    Step::Ready {
        method,
        target: target.to_string(),
        version,
        headers,
        body: buf[body_start..total].to_vec(),
        consumed: total,
        keep_alive,
    }
}

/// Where the head ends, if the whole head is present.
fn find_head_end(buf: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < buf.len() {
        if i + 3 < buf.len() && &buf[i..i + 4] == b"\r\n\r\n" {
            return Some(i + 4);
        }
        if &buf[i..i + 2] == b"\n\n" {
            return Some(i + 2);
        }
        i += 1;
    }
    None
}

fn trim_cr(line: &[u8]) -> &[u8] {
    match line.last() {
        Some(b'\r') => &line[..line.len() - 1],
        _ => line,
    }
}

fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(0);
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map(|i| i + 1)
        .unwrap_or(start);
    &bytes[start..end]
}

/// Decode a chunked body. `Ok(None)` means the terminator has not arrived.
fn decode_chunked(mut rest: &[u8]) -> Result<Option<(Vec<u8>, usize)>, &'static str> {
    let start = rest.len();
    let mut body = Vec::new();
    loop {
        let Some(line_end) = rest.iter().position(|b| *b == b'\n') else {
            return Ok(None);
        };
        let header = trim_cr(&rest[..line_end]);
        let size_text = header.split(|b| *b == b';').next().unwrap_or(header);
        let Ok(size_text) = std::str::from_utf8(trim(size_text)) else {
            return Err("Chunk size is not a number");
        };
        let Ok(size) = u64::from_str_radix(size_text, 16) else {
            return Err("Chunk size is not a number");
        };
        rest = &rest[line_end + 1..];
        if size == 0 {
            // The trailer section ends with an empty line; ignore tools that omit it.
            let used = start - rest.len();
            let trailer = rest
                .iter()
                .position(|b| *b == b'\n')
                .map(|end| end + 1)
                .unwrap_or(0);
            return Ok(Some((body, used + trailer)));
        }
        if size as usize > MAX_TOTAL {
            return Err("Chunk is too large");
        }
        let size = size as usize;
        if rest.len() < size + 1 {
            return Ok(None);
        }
        body.extend_from_slice(&rest[..size]);
        rest = &rest[size..];
        if rest.first() == Some(&b'\r') {
            rest = &rest[1..];
        }
        if rest.first() != Some(&b'\n') {
            return Err("Chunk is not terminated");
        }
        rest = &rest[1..];
    }
}

/// Serve one connection until the client closes it or a request says not to keep it.
pub async fn serve_connection(app: axum::Router, mut io: TcpStream) -> io::Result<()> {
    // One buffer per connection, reused for every request on it.
    let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
    let mut start = 0;
    loop {
        match parse(&buf[start..]) {
            Step::Ready {
                method,
                target,
                version,
                headers,
                body,
                consumed,
                keep_alive,
            } => {
                start += consumed;
                let mut builder = Request::builder()
                    .method(method)
                    .uri(target)
                    .version(version);
                for (name, value) in headers {
                    builder = builder.header(name, value);
                }
                let request = match builder.body(Body::from(body)) {
                    Ok(request) => request,
                    Err(_) => {
                        write_error(&mut io, StatusCode::BAD_REQUEST, "Malformed request", false)
                            .await?;
                        return Ok(());
                    }
                };
                let response = match app.clone().oneshot(request).await {
                    Ok(response) => response,
                    Err(error) => {
                        let _ = error;
                        write_error(
                            &mut io,
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Handler failed",
                            keep_alive,
                        )
                        .await?;
                        if !keep_alive {
                            return Ok(());
                        }
                        continue;
                    }
                };
                let keep_alive = keep_alive && response_keeps_alive(&response);
                write_response(&mut io, response, version, keep_alive).await?;
                if !keep_alive {
                    return Ok(());
                }
                // Keep the tail of the buffer (a pipelined request may already be in it).
                if start > 0 {
                    buf.drain(..start);
                    start = 0;
                }
                if buf.len() > MAX_TOTAL {
                    return Ok(());
                }
            }
            Step::Incomplete => {
                if start > 0 {
                    buf.drain(..start);
                    start = 0;
                }
                let read = io.read_buf(&mut buf).await?;
                if read == 0 {
                    return Ok(());
                }
            }
            Step::Invalid(reason) => {
                write_error(&mut io, StatusCode::BAD_REQUEST, reason, false).await?;
                return Ok(());
            }
        }
    }
}

/// Whether the handler's own headers ask for the connection to close.
fn response_keeps_alive(response: &Response<Body>) -> bool {
    response
        .headers()
        .get(axum::http::header::CONNECTION)
        .and_then(|value| value.to_str().ok())
        .map(|value| !value.eq_ignore_ascii_case("close"))
        .unwrap_or(true)
}

/// Write a response, with the framing this layer owns.
async fn write_response(
    io: &mut TcpStream,
    response: Response<Body>,
    version: Version,
    keep_alive: bool,
) -> io::Result<()> {
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, MAX_TOTAL)
        .await
        .map_err(|_| io::Error::other("response body could not be collected"))?;
    let mut out = Vec::with_capacity(bytes.len() + 512);
    let status = parts.status;
    // Answer with the version the client spoke, the way hyper does: an HTTP/1.0 client is told
    // 1.0 back, and an HTTP/1.1 client 1.1.
    out.extend_from_slice(match version {
        Version::HTTP_10 => b"HTTP/1.0 ".as_slice(),
        _ => b"HTTP/1.1 ".as_slice(),
    });
    out.extend_from_slice(status.as_str().as_bytes());
    out.push(b' ');
    out.extend_from_slice(status.canonical_reason().unwrap_or("").as_bytes());
    out.extend_from_slice(b"\r\n");
    for (name, value) in parts.headers.iter() {
        // Framing and hop-by-hop headers belong to this layer, not to the handler.
        if name == axum::http::header::CONTENT_LENGTH
            || name == axum::http::header::TRANSFER_ENCODING
            || name == axum::http::header::CONNECTION
        {
            continue;
        }
        out.extend_from_slice(name.as_str().as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"content-length: ");
    out.extend_from_slice(bytes.len().to_string().as_bytes());
    // State the connection only when it differs from what the version already means: HTTP/1.1
    // keeps alive unless told otherwise, HTTP/1.0 closes unless told otherwise.
    let implicit = match version {
        Version::HTTP_10 => !keep_alive,
        _ => keep_alive,
    };
    if !implicit {
        out.extend_from_slice(b"\r\nconnection: ");
        out.extend_from_slice(if keep_alive { b"keep-alive" } else { b"close" });
    }
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(&bytes);
    io.write_all(&out).await
}

async fn write_error(
    io: &mut TcpStream,
    status: StatusCode,
    message: &str,
    keep_alive: bool,
) -> io::Result<()> {
    let body = axum::Json(serde_json::json!({"error": message})).into_response();
    let mut response = body;
    *response.status_mut() = status;
    write_response(io, response, Version::HTTP_11, keep_alive).await
}

use axum::response::IntoResponse;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use std::time::Duration;
    use tokio::net::TcpListener;

    fn head(request: &str) -> Vec<u8> {
        request.replace('\n', "\r\n").into_bytes()
    }

    /// Every response on the wire as status, sorted headers and body. The server's own clock is
    /// dropped, and framing headers are dropped because their presence is what varies; each
    /// response is cut at its own content-length so a pipelined pair compares as two answers.
    fn responses(raw: &[u8]) -> Vec<(String, Vec<String>, Vec<u8>)> {
        let mut out = Vec::new();
        let mut rest = raw;
        while !rest.is_empty() {
            let Some(split) = rest.windows(4).position(|w| w == b"\r\n\r\n") else {
                break;
            };
            let head = String::from_utf8_lossy(&rest[..split]).to_string();
            let mut lines = head.lines();
            let status = lines.next().unwrap_or_default().to_string();
            let mut headers = Vec::new();
            let mut length = 0usize;
            for line in lines {
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap_or(0);
                } else if !lower.starts_with("date:") {
                    headers.push(lower);
                }
            }
            headers.sort();
            let start = split + 4;
            let end = (start + length).min(rest.len());
            out.push((status, headers, rest[start..end].to_vec()));
            rest = &rest[end..];
        }
        out
    }

    /// Send raw bytes and read the answers. Every case asks the server to close, so reading to
    /// the end is what delimits the response; a half-close first would reset the connection
    /// before the answer arrives.
    async fn send(address: std::net::SocketAddr, raw: &[u8]) -> Vec<u8> {
        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream.write_all(raw).await.expect("write");
        let mut out = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
        out
    }

    /// The same requests, answered by hyper and by this module, must agree.
    #[tokio::test]
    async fn the_two_paths_answer_identically() {
        let app = axum::Router::new()
            .route(
                "/echo",
                post(|body: String| async move { format!("echo:{}", body.len()) }),
            )
            .route("/get", get(|| async { "ok" }));

        let hyper_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hyper_address = hyper_listener.local_addr().unwrap();
        let hyper_app = app.clone();
        tokio::spawn(async move {
            let _ = axum::serve(hyper_listener, hyper_app).await;
        });

        let own_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let own_address = own_listener.local_addr().unwrap();
        let own_app = app.clone();
        tokio::spawn(async move {
            loop {
                let Ok((io, _)) = own_listener.accept().await else {
                    break;
                };
                let app = own_app.clone();
                tokio::spawn(async move {
                    let _ = serve_connection(app, io).await;
                });
            }
        });

        let cases: Vec<Vec<u8>> = vec![
            head(
                "POST /echo HTTP/1.1\nhost: localhost\ncontent-type: text/plain\ncontent-length: 7\nconnection: close\n\n{\"a\":1}",
            ),
            head(
                "POST /echo HTTP/1.1\nhost: localhost\ncontent-type: text/plain\ntransfer-encoding: chunked\nconnection: close\n\n5\nhello\n0\n\n",
            ),
            head("GET /get HTTP/1.1\nhost: localhost\nconnection: close\n\n"),
            head("GET /get HTTP/1.0\nhost: localhost\n\n"),
            // Two requests in one write: both paths must answer both, in order.
            head(
                "GET /get HTTP/1.1\nhost: localhost\n\nGET /get HTTP/1.1\nhost: localhost\nconnection: close\n\n",
            ),
        ];
        for case in cases {
            let hyper = send(hyper_address, &case).await;
            let own = send(own_address, &case).await;
            assert!(!hyper.is_empty(), "hyper answered nothing for {case:?}");
            assert!(!own.is_empty(), "this module answered nothing for {case:?}");
            assert_eq!(
                responses(&hyper),
                responses(&own),
                "the answers differ for {case:?}"
            );
        }
    }

    #[test]
    fn a_short_buffer_is_incomplete_rather_than_invalid() {
        assert!(matches!(parse(b"GET /x"), Step::Incomplete));
        assert!(matches!(
            parse(b"GET /x HTTP/1.1\r\nhost: localhost\r\n"),
            Step::Incomplete
        ));
        assert!(matches!(
            parse(b"POST /x HTTP/1.1\r\ncontent-length: 5\r\n\r\nab"),
            Step::Incomplete
        ));
    }

    #[test]
    fn a_complete_request_reports_its_own_length() {
        let raw = b"POST /edges HTTP/1.1\r\nhost: x\r\ncontent-length: 4\r\n\r\nbody";
        match parse(raw) {
            Step::Ready {
                ref target,
                ref body,
                consumed,
                keep_alive,
                version,
                ..
            } => {
                assert_eq!(target, "/edges");
                assert_eq!(body, b"body");
                assert_eq!(consumed, raw.len());
                assert!(keep_alive);
                assert_eq!(version, Version::HTTP_11);
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn smuggling_shapes_are_refused() {
        // Both framings at once.
        assert!(matches!(
            parse(
                b"POST /x HTTP/1.1\r\ncontent-length: 4\r\ntransfer-encoding: chunked\r\n\r\nbody"
            ),
            Step::Invalid(_)
        ));
        // Two lengths that disagree.
        assert!(matches!(
            parse(b"POST /x HTTP/1.1\r\ncontent-length: 4\r\ncontent-length: 5\r\n\r\nbody"),
            Step::Invalid(_)
        ));
        // Obsolete folding, which some proxies unfold and others reject.
        assert!(matches!(
            parse(b"GET /x HTTP/1.1\r\nhost: x\r\n folded\r\n\r\n"),
            Step::Invalid(_)
        ));
        // A header without a colon, and an absolute target that would make this a proxy.
        assert!(matches!(
            parse(b"GET /x HTTP/1.1\r\nbad header\r\n\r\n"),
            Step::Invalid(_)
        ));
        assert!(matches!(
            parse(b"GET http://elsewhere/x HTTP/1.1\r\nhost: x\r\n\r\n"),
            Step::Invalid(_)
        ));
    }

    #[test]
    fn a_chunked_body_is_reassembled_with_its_length() {
        let raw =
            b"POST /x HTTP/1.1\r\ntransfer-encoding: chunked\r\n\r\n3\nabc\r\n2\r\nde\r\n0\r\n\r\n";
        match parse(raw) {
            Step::Ready { body, consumed, .. } => {
                assert_eq!(body, b"abcde");
                assert_eq!(consumed, raw.len());
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn a_body_over_the_limit_is_refused_rather_than_buffered() {
        let raw = format!(
            "POST /x HTTP/1.1\r\ncontent-length: {}\r\n\r\n",
            MAX_TOTAL + 1
        );
        assert!(matches!(parse(raw.as_bytes()), Step::Invalid(_)));
    }

    #[test]
    fn http_1_0_closes_unless_it_asks_to_keep_alive() {
        match parse(b"GET /x HTTP/1.0\r\n\r\n") {
            Step::Ready { keep_alive, .. } => assert!(!keep_alive),
            other => panic!("expected a request, got {other:?}"),
        }
        match parse(b"GET /x HTTP/1.0\r\nconnection: keep-alive\r\n\r\n") {
            Step::Ready { keep_alive, .. } => assert!(keep_alive),
            other => panic!("expected a request, got {other:?}"),
        }
    }
}
