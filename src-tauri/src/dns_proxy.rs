// Local DNS-aware forward proxy: resolves upstream hosts through a per-playlist DNS server.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::StreamExt;
use hickory_resolver::config::{LookupIpStrategy, NameServerConfigGroup, ResolverConfig};
use hickory_resolver::name_server::TokioConnectionProvider;
use hickory_resolver::{Resolver, TokioResolver};
use serde::Serialize;

const MAX_SESSIONS: usize = 16;
const RESOLVE_TEST_TIMEOUT: Duration = Duration::from_secs(8);
const M3U8_BUFFER_CAP: usize = 8 * 1024 * 1024;
const RAW_PASSTHROUGH_HEADER: &str = "x-xt-dns-raw";
const M3U8_CONTENT_TYPES: &[&str] = &[
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
];
const URI_ATTRIBUTE_TAGS: &[&str] = &[
    "#EXT-X-KEY",
    "#EXT-X-MAP",
    "#EXT-X-MEDIA",
    "#EXT-X-I-FRAME-STREAM-INF",
    "#EXT-X-PART",
    "#EXT-X-PRELOAD-HINT",
    "#EXT-X-RENDITION-REPORT",
    "#EXT-X-SESSION-KEY",
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct DnsProxySession {
    token: String,
    raw_server: String,
    base_url: String,
    client: reqwest::Client,
    last_used: Mutex<Instant>,
}

type SessionMap = Arc<Mutex<HashMap<String, Arc<DnsProxySession>>>>;
type KeyMap = Arc<Mutex<HashMap<String, String>>>;

struct ServerHandle {
    port: u16,
    // Kept for a future "stop the proxy" path; only a lost startup race fires it today.
    #[allow(dead_code)]
    shutdown: tokio::sync::oneshot::Sender<()>,
}

#[derive(Default)]
pub struct DnsProxyState {
    server: Mutex<Option<ServerHandle>>,
    sessions: SessionMap,
    keys: KeyMap,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsProxyInfo {
    pub base_url: String,
}

#[tauri::command]
pub async fn dns_proxy_register(
    state: tauri::State<'_, DnsProxyState>,
    session_key: String,
    server: String,
) -> Result<DnsProxyInfo, String> {
    let target = parse_dns_server(&server)?;

    if let Some(base_url) = existing_session_base_url(&state, &session_key, &server) {
        return Ok(DnsProxyInfo { base_url });
    }

    let client = build_dns_client(&target).await?;
    let port = ensure_server_started(&state).await?;

    let token = generate_token();
    let base_url = format!("http://127.0.0.1:{port}/{token}");
    let session = Arc::new(DnsProxySession {
        token: token.clone(),
        raw_server: server,
        base_url: base_url.clone(),
        client,
        last_used: Mutex::new(Instant::now()),
    });

    replace_session_for_key(&state, session_key, session);

    Ok(DnsProxyInfo { base_url })
}

#[tauri::command]
pub fn dns_proxy_unregister(
    state: tauri::State<'_, DnsProxyState>,
    session_key: String,
) -> Result<(), String> {
    let token = {
        let mut keys = state
            .keys
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        keys.remove(&session_key)
    };
    if let Some(token) = token {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.remove(&token);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResolveTestResult {
    pub addresses: Vec<String>,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub async fn dns_resolve_test(
    server: String,
    host: String,
) -> Result<DnsResolveTestResult, String> {
    let target = parse_dns_server(&server)?;
    let resolver = build_hickory_resolver(&target).await?;

    let started = Instant::now();
    let lookup =
        tokio::time::timeout(RESOLVE_TEST_TIMEOUT, resolver.lookup_ip(host.as_str())).await;
    let lookup = match lookup {
        Err(_) => return Err("TIMEOUT:resolve test timed out".to_string()),
        Ok(result) => result,
    };
    let addresses: Vec<String> = match lookup {
        Ok(lookup_ip) => lookup_ip.iter().map(|ip| ip.to_string()).collect(),
        Err(error) => return Err(format!("RESOLVE:{error}")),
    };
    if addresses.is_empty() {
        return Err("RESOLVE:no A or AAAA records found".to_string());
    }

    Ok(DnsResolveTestResult {
        addresses,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn existing_session_base_url(
    state: &DnsProxyState,
    session_key: &str,
    server: &str,
) -> Option<String> {
    let token = {
        let keys = state
            .keys
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        keys.get(session_key)?.clone()
    };
    let sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let session = sessions.get(&token)?;
    (session.raw_server == server).then(|| session.base_url.clone())
}

fn replace_session_for_key(
    state: &DnsProxyState,
    session_key: String,
    session: Arc<DnsProxySession>,
) {
    let mut keys = state
        .keys
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(previous_token) = keys.insert(session_key, session.token.clone()) {
        sessions.remove(&previous_token);
    }
    sessions.insert(session.token.clone(), session);
    evict_least_recently_used(&mut sessions, &mut keys);
}

fn evict_least_recently_used(
    sessions: &mut HashMap<String, Arc<DnsProxySession>>,
    keys: &mut HashMap<String, String>,
) {
    if sessions.len() <= MAX_SESSIONS {
        return;
    }
    let victim = sessions
        .iter()
        .min_by_key(|(_, session)| {
            *session
                .last_used
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
        })
        .map(|(token, _)| token.clone());
    if let Some(victim) = victim {
        sessions.remove(&victim);
        keys.retain(|_, token| token != &victim);
    }
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async fn ensure_server_started(state: &DnsProxyState) -> Result<u16, String> {
    {
        let guard = state
            .server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(handle) = guard.as_ref() {
            return Ok(handle.port);
        }
    }

    let (port, shutdown) = start_server(state.sessions.clone())
        .await
        .map_err(|error| format!("BIND:failed to start dns proxy server: {error}"))?;

    let mut guard = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(handle) = guard.as_ref() {
        // Lost a startup race against a concurrent register call; drop the spare listener.
        let _ = shutdown.send(());
        return Ok(handle.port);
    }
    *guard = Some(ServerHandle { port, shutdown });
    Ok(port)
}

struct ServerState {
    sessions: SessionMap,
    port: u16,
}

async fn start_server(
    sessions: SessionMap,
) -> std::io::Result<(u16, tokio::sync::oneshot::Sender<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let server_state = Arc::new(ServerState { sessions, port });
    let router = axum::Router::new()
        .route("/{token}/{*rest}", axum::routing::any(handle_forward))
        .with_state(server_state);

    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = serve.await {
            log::warn!("[dns-proxy] server exited: {error}");
        }
    });

    Ok((port, shutdown_tx))
}

// ---------------------------------------------------------------------------
// Forwarding handler
// ---------------------------------------------------------------------------

struct ForwardTarget<'a> {
    token: &'a str,
    scheme: &'a str,
    hostport: &'a str,
    path: &'a str,
}

// Split the raw, never percent-decoded path so %3F / %2F reach the origin intact.
fn split_forward_path(raw_path: &str) -> ForwardTarget<'_> {
    let trimmed = raw_path.strip_prefix('/').unwrap_or(raw_path);
    let mut segments = trimmed.splitn(4, '/');
    ForwardTarget {
        token: segments.next().unwrap_or(""),
        scheme: segments.next().unwrap_or(""),
        hostport: segments.next().unwrap_or(""),
        path: segments.next().unwrap_or(""),
    }
}

// Some WebView URL implementations percent-encode the brackets of an IPv6 literal host.
fn decode_bracketed_host(hostport: &str) -> String {
    hostport
        .replace("%5B", "[")
        .replace("%5b", "[")
        .replace("%5D", "]")
        .replace("%5d", "]")
}

fn build_upstream_url(target: &ForwardTarget<'_>, query: Option<&str>) -> Option<reqwest::Url> {
    let scheme = target.scheme;
    let hostport = decode_bracketed_host(target.hostport);
    let path = target.path;
    let mut text = if path.is_empty() {
        format!("{scheme}://{hostport}")
    } else {
        format!("{scheme}://{hostport}/{path}")
    };
    if let Some(query) = query {
        text.push('?');
        text.push_str(query);
    }
    reqwest::Url::parse(&text).ok()
}

async fn handle_forward(
    State(state): State<Arc<ServerState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    let expected_host = format!("127.0.0.1:{}", state.port);
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(|host| host == expected_host)
        .unwrap_or(false);
    if !host_ok {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let target = split_forward_path(uri.path());
    let session = {
        let sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.get(target.token).cloned()
    };
    let Some(session) = session else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    *session
        .last_used
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Instant::now();

    if target.scheme != "http" && target.scheme != "https" {
        return (StatusCode::BAD_REQUEST, "scheme must be http or https").into_response();
    }
    if target.hostport.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing upstream host").into_response();
    }
    let Some(upstream_url) = build_upstream_url(&target, uri.query()) else {
        return (StatusCode::BAD_REQUEST, "invalid upstream url").into_response();
    };

    let raw_mode = is_raw_passthrough(&headers);
    let forward_body = request_can_have_body(&method, &headers);
    let mut request_builder = session.client.request(method, upstream_url.clone());
    for (name, value) in headers.iter() {
        if !should_forward_request_header(name) {
            continue;
        }
        request_builder = request_builder.header(name.clone(), value.clone());
    }
    if let Some(accept_encoding) =
        forwarded_accept_encoding(raw_mode, headers.get(axum::http::header::ACCEPT_ENCODING))
    {
        request_builder = request_builder.header(axum::http::header::ACCEPT_ENCODING, accept_encoding);
    }
    if forward_body {
        request_builder = request_builder.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let upstream_response = match request_builder.send().await {
        Ok(response) => response,
        Err(error) => {
            let reason = classify_forward_error(&error);
            log::warn!(
                "[dns-proxy] upstream request failed for {}://{}: {}",
                target.scheme,
                target.hostport,
                error.without_url()
            );
            return (StatusCode::BAD_GATEWAY, format!("dns-proxy: {reason}")).into_response();
        }
    };

    build_forward_response(
        upstream_response,
        &session.base_url,
        &upstream_url,
        raw_mode,
    )
    .await
}

fn classify_forward_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "upstream timed out"
    } else if error.is_connect() {
        "upstream connection failed"
    } else {
        "upstream request failed"
    }
}

fn is_hop_by_hop_header(name: &axum::http::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host" | "connection" | "keep-alive" | "transfer-encoding" | "te" | "trailer" | "upgrade"
    ) || name.as_str().starts_with("proxy-")
}

fn should_forward_request_header(name: &axum::http::HeaderName) -> bool {
    !is_hop_by_hop_header(name)
        && name.as_str() != RAW_PASSTHROUGH_HEADER
        && *name != axum::http::header::ACCEPT_ENCODING
}

// reqwest has no auto-decompression here, so rewritten manifests must arrive uncompressed.
fn forwarded_accept_encoding(
    raw_mode: bool,
    client_value: Option<&axum::http::HeaderValue>,
) -> Option<axum::http::HeaderValue> {
    if raw_mode {
        client_value.cloned()
    } else {
        Some(axum::http::HeaderValue::from_static("identity"))
    }
}

fn is_raw_passthrough(headers: &HeaderMap) -> bool {
    headers
        .get(RAW_PASSTHROUGH_HEADER)
        .is_some_and(|value| value.as_bytes() == b"1")
}

// Some origins reject a chunked GET with 400/411, so only bodied methods stream a body.
fn request_can_have_body(method: &Method, headers: &HeaderMap) -> bool {
    if *method == Method::GET || *method == Method::HEAD {
        return false;
    }
    match headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        Some(0) => false,
        Some(_) => true,
        None => headers.contains_key(axum::http::header::TRANSFER_ENCODING),
    }
}

fn should_rewrite_body(raw_mode: bool, content_type: Option<&str>, upstream_path: &str) -> bool {
    !raw_mode && looks_like_m3u8(content_type, upstream_path)
}

fn looks_like_m3u8(content_type: Option<&str>, upstream_path: &str) -> bool {
    let media_type = content_type.map(|value| {
        value
            .split(';')
            .next()
            .unwrap_or(value)
            .trim()
            .to_ascii_lowercase()
    });
    if let Some(media_type) = media_type.as_deref() {
        if M3U8_CONTENT_TYPES.contains(&media_type) {
            return true;
        }
        if is_never_manifest_media_type(media_type) {
            return false;
        }
    }
    let path_lower = upstream_path.to_ascii_lowercase();
    path_lower.ends_with(".m3u8") || path_lower.ends_with(".m3u")
}

// Xtream panels answer /live/u/p/123.m3u8 with an infinite video/mp2t stream.
fn is_never_manifest_media_type(media_type: &str) -> bool {
    if media_type.starts_with("video/") {
        return true;
    }
    media_type
        .strip_prefix("audio/")
        .is_some_and(|subtype| subtype != "mpegurl" && subtype != "x-mpegurl")
}

fn has_non_identity_content_encoding(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.trim().eq_ignore_ascii_case("identity"))
}

fn body_starts_like_m3u8(prefix: &[u8]) -> bool {
    let mut bytes = prefix;
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        bytes = rest;
    }
    while matches!(bytes.first(), Some(byte) if byte.is_ascii_whitespace()) {
        bytes = &bytes[1..];
    }
    bytes.starts_with(b"#EXTM3U")
}

fn build_response_headers(
    upstream_headers: &reqwest::header::HeaderMap,
    base_url: &str,
    upstream_url: &reqwest::Url,
    status: reqwest::StatusCode,
    drop_content_length: bool,
) -> axum::http::response::Builder {
    let mut response_builder = axum::http::Response::builder().status(status.as_u16());
    for (name, value) in upstream_headers.iter() {
        if is_hop_by_hop_header(name) {
            continue;
        }
        if drop_content_length && name == reqwest::header::CONTENT_LENGTH {
            continue;
        }
        if name == reqwest::header::LOCATION {
            if let Some(rewritten) = value
                .to_str()
                .ok()
                .and_then(|text| rewrite_location(text, base_url, upstream_url))
                .and_then(|text| axum::http::HeaderValue::from_str(&text).ok())
            {
                response_builder = response_builder.header(name.clone(), rewritten);
                continue;
            }
        }
        response_builder = response_builder.header(name.clone(), value.clone());
    }
    response_builder
}

async fn build_forward_response(
    upstream_response: reqwest::Response,
    base_url: &str,
    upstream_url: &reqwest::Url,
    raw_mode: bool,
) -> Response {
    let status = upstream_response.status();
    let headers = upstream_response.headers().clone();
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let manifest_candidate = should_rewrite_body(raw_mode, content_type, upstream_url.path())
        && !has_non_identity_content_encoding(&headers);

    if !manifest_candidate {
        let response_builder = build_response_headers(&headers, base_url, upstream_url, status, false);
        return finish_response(
            response_builder,
            axum::body::Body::from_stream(upstream_response.bytes_stream()),
        );
    }

    let mut stream = upstream_response.bytes_stream();
    let first_chunk = match stream.next().await {
        None => {
            let response_builder =
                build_response_headers(&headers, base_url, upstream_url, status, false);
            return finish_response(response_builder, axum::body::Body::empty());
        }
        Some(Ok(chunk)) => chunk,
        Some(Err(error)) => {
            log::warn!("[dns-proxy] upstream stream error: {}", error.without_url());
            return (StatusCode::BAD_GATEWAY, "dns-proxy: upstream stream error").into_response();
        }
    };

    if !body_starts_like_m3u8(&first_chunk) {
        let combined =
            futures_util::stream::once(async move { Ok::<Bytes, reqwest::Error>(first_chunk) })
                .chain(stream);
        let response_builder =
            build_response_headers(&headers, base_url, upstream_url, status, false);
        return finish_response(response_builder, axum::body::Body::from_stream(combined));
    }

    let mut collected: Vec<u8> = first_chunk.to_vec();
    let mut overflowed = collected.len() > M3U8_BUFFER_CAP;
    while !overflowed {
        match stream.next().await {
            None => break,
            Some(Ok(chunk)) => {
                collected.extend_from_slice(&chunk);
                overflowed = collected.len() > M3U8_BUFFER_CAP;
            }
            Some(Err(error)) => {
                log::warn!("[dns-proxy] upstream stream error: {}", error.without_url());
                return (StatusCode::BAD_GATEWAY, "dns-proxy: upstream stream error")
                    .into_response();
            }
        }
    }

    if overflowed {
        let prefix = Bytes::from(collected);
        let combined =
            futures_util::stream::once(async move { Ok::<Bytes, reqwest::Error>(prefix) })
                .chain(stream);
        let response_builder =
            build_response_headers(&headers, base_url, upstream_url, status, false);
        return finish_response(response_builder, axum::body::Body::from_stream(combined));
    }

    let text = String::from_utf8_lossy(&collected).into_owned();
    let rewritten = rewrite_m3u8(&text, base_url, upstream_url);
    let response_builder = build_response_headers(&headers, base_url, upstream_url, status, true);
    finish_response(
        response_builder,
        axum::body::Body::from(rewritten.into_bytes()),
    )
}

fn finish_response(builder: axum::http::response::Builder, body: axum::body::Body) -> Response {
    match builder.body(body) {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[dns-proxy] failed to build response: {error}");
            (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// M3U8 rewriting (pure)
// ---------------------------------------------------------------------------

fn is_uri_attribute_line(line: &str) -> bool {
    URI_ATTRIBUTE_TAGS.iter().any(|tag| line.starts_with(tag))
}

pub fn rewrite_m3u8(body: &str, base: &str, upstream_url: &reqwest::Url) -> String {
    let ends_with_newline = body.ends_with('\n');
    let mut lines: Vec<String> = Vec::new();
    for raw_line in body.lines() {
        let line = raw_line.trim_end_matches('\r');
        if is_uri_attribute_line(line) {
            lines.push(rewrite_uri_attribute(line, base, upstream_url));
        } else if line.starts_with('#') || line.trim().is_empty() {
            lines.push(line.to_string());
        } else {
            lines.push(
                resolve_and_wrap(line.trim(), base, upstream_url)
                    .unwrap_or_else(|| line.to_string()),
            );
        }
    }
    let mut result = lines.join("\n");
    if ends_with_newline {
        result.push('\n');
    }
    result
}

fn rewrite_uri_attribute(line: &str, base: &str, upstream_url: &reqwest::Url) -> String {
    const MARKER: &str = "URI=\"";
    let Some(marker_start) = line.find(MARKER) else {
        return line.to_string();
    };
    let value_start = marker_start + MARKER.len();
    let Some(relative_end) = line[value_start..].find('"') else {
        return line.to_string();
    };
    let value_end = value_start + relative_end;
    let original = &line[value_start..value_end];
    match resolve_and_wrap(original, base, upstream_url) {
        Some(rewritten) => format!(
            "{}{}{}",
            &line[..value_start],
            rewritten,
            &line[value_end..]
        ),
        None => line.to_string(),
    }
}

// Location may be relative; resolve it against the upstream URL before proxying it.
fn rewrite_location(candidate: &str, base: &str, upstream_url: &reqwest::Url) -> Option<String> {
    resolve_and_wrap(candidate, base, upstream_url)
}

// Non-http(s) results (data:, skd:) stay untouched.
fn resolve_and_wrap(candidate: &str, base: &str, upstream_url: &reqwest::Url) -> Option<String> {
    let resolved = upstream_url.join(candidate).ok()?;
    if resolved.scheme() != "http" && resolved.scheme() != "https" {
        return None;
    }
    Some(wrap_upstream_url(base, &resolved))
}

pub fn wrap_upstream_url(base: &str, upstream: &reqwest::Url) -> String {
    let Some(host) = upstream.host_str() else {
        return upstream.as_str().to_string();
    };
    let hostport = match upstream.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let scheme = upstream.scheme();
    let path = upstream.path().strip_prefix('/').unwrap_or(upstream.path());
    let mut result = if path.is_empty() {
        format!("{base}/{scheme}/{hostport}")
    } else {
        format!("{base}/{scheme}/{hostport}/{path}")
    };
    if let Some(query) = upstream.query() {
        result.push('?');
        result.push_str(query);
    }
    result
}

// ---------------------------------------------------------------------------
// DNS server parsing + resolver construction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum DnsServerTarget {
    Plain(SocketAddr),
    Doh(String),
}

fn parse_dns_server(raw: &str) -> Result<DnsServerTarget, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("INVALID_SERVER:server is empty".to_string());
    }
    if trimmed.starts_with("https://") {
        let parsed =
            reqwest::Url::parse(trimmed).map_err(|error| format!("INVALID_SERVER:{error}"))?;
        if parsed.host_str().is_none() {
            return Err("INVALID_SERVER:https url has no host".to_string());
        }
        return Ok(DnsServerTarget::Doh(trimmed.to_string()));
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        let Some(bracket_end) = rest.find(']') else {
            return Err("INVALID_SERVER:missing closing bracket".to_string());
        };
        let ip = rest[..bracket_end]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| "INVALID_SERVER:invalid IPv6 address".to_string())?;
        let after = &rest[bracket_end + 1..];
        let port = if let Some(port_str) = after.strip_prefix(':') {
            port_str
                .parse::<u16>()
                .map_err(|_| "INVALID_SERVER:invalid port".to_string())?
        } else if after.is_empty() {
            53
        } else {
            return Err("INVALID_SERVER:unexpected trailing characters".to_string());
        };
        return Ok(DnsServerTarget::Plain(SocketAddr::new(
            IpAddr::V6(ip),
            port,
        )));
    }
    if let Ok(ip) = trimmed.parse::<std::net::Ipv6Addr>() {
        return Ok(DnsServerTarget::Plain(SocketAddr::new(IpAddr::V6(ip), 53)));
    }
    let colon_count = trimmed.matches(':').count();
    if colon_count == 1 {
        let (host_part, port_part) = trimmed.split_once(':').expect("colon present");
        let ip = host_part
            .parse::<std::net::Ipv4Addr>()
            .map_err(|_| "INVALID_SERVER:invalid IPv4 address".to_string())?;
        let port = port_part
            .parse::<u16>()
            .map_err(|_| "INVALID_SERVER:invalid port".to_string())?;
        return Ok(DnsServerTarget::Plain(SocketAddr::new(
            IpAddr::V4(ip),
            port,
        )));
    }
    if colon_count == 0 {
        let ip = trimmed
            .parse::<std::net::Ipv4Addr>()
            .map_err(|_| "INVALID_SERVER:invalid IPv4 address".to_string())?;
        return Ok(DnsServerTarget::Plain(SocketAddr::new(IpAddr::V4(ip), 53)));
    }
    Err("INVALID_SERVER:unrecognized server format".to_string())
}

async fn build_dns_client(target: &DnsServerTarget) -> Result<reqwest::Client, String> {
    let resolver = build_hickory_resolver(target).await?;
    let dns_resolver = Arc::new(HickoryDnsResolver { resolver });
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .dns_resolver(dns_resolver)
        .build()
        .map_err(|error| format!("OTHER:{error}"))
}

async fn build_hickory_resolver(target: &DnsServerTarget) -> Result<TokioResolver, String> {
    let name_servers = match target {
        DnsServerTarget::Plain(addr) => {
            NameServerConfigGroup::from_ips_clear(&[addr.ip()], addr.port(), true)
        }
        DnsServerTarget::Doh(doh_url) => build_doh_name_server_group(doh_url).await?,
    };
    let resolver_config = ResolverConfig::from_parts(None, Vec::new(), name_servers);
    let mut builder =
        Resolver::builder_with_config(resolver_config, TokioConnectionProvider::default());
    let options = builder.options_mut();
    options.timeout = Duration::from_secs(5);
    options.attempts = 2;
    options.ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
    Ok(builder.build())
}

async fn build_doh_name_server_group(doh_url: &str) -> Result<NameServerConfigGroup, String> {
    let parsed = reqwest::Url::parse(doh_url).map_err(|error| format!("INVALID_SERVER:{error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "INVALID_SERVER:https url has no host".to_string())?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let path = if parsed.path().is_empty() {
        "/dns-query".to_string()
    } else {
        parsed.path().to_string()
    };

    let ips = resolve_doh_host(&host).await?;
    let mut name_servers = NameServerConfigGroup::from_ips_https(&ips, port, host, true);
    for config in name_servers.iter_mut() {
        config.http_endpoint = Some(path.clone());
    }
    Ok(name_servers)
}

// One-time system-resolver lookup for the DoH hostname itself; TLS still validates against that name.
async fn resolve_doh_host(host: &str) -> Result<Vec<IpAddr>, String> {
    let host_owned = host.to_string();
    let addrs = tauri::async_runtime::spawn_blocking(move || {
        (host_owned.as_str(), 0u16)
            .to_socket_addrs()
            .map(|iter| iter.map(|addr| addr.ip()).collect::<Vec<_>>())
    })
    .await
    .map_err(|error| format!("OTHER:dns worker failed: {error}"))?
    .map_err(|error| format!("INVALID_SERVER:failed to resolve DoH host: {error}"))?;
    if addrs.is_empty() {
        return Err("INVALID_SERVER:DoH host did not resolve to any address".to_string());
    }
    Ok(addrs)
}

pub(crate) struct HickoryDnsResolver {
    resolver: TokioResolver,
}

// Mirrors CustomDns.kt: custom resolver first, Dns.SYSTEM (here tokio) on failure.
impl reqwest::dns::Resolve for HickoryDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let resolver = self.resolver.clone();
        Box::pin(async move {
            match resolver.lookup_ip(name.as_str()).await {
                Ok(lookup) => {
                    let addrs: Vec<SocketAddr> =
                        lookup.iter().map(|ip| SocketAddr::new(ip, 0)).collect();
                    if !addrs.is_empty() {
                        return Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs);
                    }
                    log::debug!(
                        "[dns-proxy] custom resolver returned no addresses for {}, trying system dns",
                        name.as_str()
                    );
                    match system_resolve_host(name.as_str()).await {
                        Some(addrs) if !addrs.is_empty() => {
                            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
                        }
                        _ => Err(std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            "no A or AAAA records found",
                        )
                        .into()),
                    }
                }
                Err(error) => {
                    log::debug!(
                        "[dns-proxy] custom resolver failed for {}: {error}, trying system dns",
                        name.as_str()
                    );
                    match system_resolve_host(name.as_str()).await {
                        Some(addrs) if !addrs.is_empty() => {
                            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
                        }
                        _ => Err(error.into()),
                    }
                }
            }
        })
    }
}

async fn system_resolve_host(host: &str) -> Option<Vec<SocketAddr>> {
    match tokio::net::lookup_host((host, 0)).await {
        Ok(addrs) => Some(addrs.collect()),
        Err(error) => {
            log::debug!("[dns-proxy] system dns lookup failed for {host}: {error}");
            None
        }
    }
}

pub(crate) async fn build_resolver_for_raw(raw: &str) -> Result<Arc<HickoryDnsResolver>, String> {
    let target = parse_dns_server(raw)?;
    let resolver = build_hickory_resolver(&target).await?;
    Ok(Arc::new(HickoryDnsResolver { resolver }))
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Some(stripped) = host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        return stripped.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// True for our own wrapped form (`http://<loopback>/<token>/<http|https>/<hostport>/...`),
/// distinguishing it from a plain loopback tee URL like vod_proxy.rs's.
pub(crate) fn is_dns_proxy_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if !is_loopback_host(host) {
        return false;
    }
    let target = split_forward_path(parsed.path());
    !target.token.is_empty()
        && (target.scheme == "http" || target.scheme == "https")
        && !target.hostport.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dns_server_accepts_a_bare_ipv4() {
        assert_eq!(
            parse_dns_server("1.1.1.1").unwrap(),
            DnsServerTarget::Plain("1.1.1.1:53".parse().unwrap())
        );
    }

    #[test]
    fn parse_dns_server_accepts_ipv4_with_port() {
        assert_eq!(
            parse_dns_server("1.1.1.1:5353").unwrap(),
            DnsServerTarget::Plain("1.1.1.1:5353".parse().unwrap())
        );
    }

    #[test]
    fn parse_dns_server_accepts_a_bare_ipv6() {
        assert_eq!(
            parse_dns_server("2606:4700::1111").unwrap(),
            DnsServerTarget::Plain("[2606:4700::1111]:53".parse().unwrap())
        );
    }

    #[test]
    fn parse_dns_server_accepts_bracketed_ipv6_with_port() {
        assert_eq!(
            parse_dns_server("[2606:4700::1111]:8443").unwrap(),
            DnsServerTarget::Plain("[2606:4700::1111]:8443".parse().unwrap())
        );
    }

    #[test]
    fn parse_dns_server_accepts_bracketed_ipv6_without_port() {
        assert_eq!(
            parse_dns_server("[2606:4700::1111]").unwrap(),
            DnsServerTarget::Plain("[2606:4700::1111]:53".parse().unwrap())
        );
    }

    #[test]
    fn parse_dns_server_accepts_a_doh_url() {
        assert_eq!(
            parse_dns_server("https://dnsforge.de/dns-query").unwrap(),
            DnsServerTarget::Doh("https://dnsforge.de/dns-query".to_string())
        );
    }

    #[test]
    fn parse_dns_server_rejects_garbage() {
        assert!(parse_dns_server("not a server").is_err());
        assert!(parse_dns_server("").is_err());
        assert!(parse_dns_server("1.2.3.4.5").is_err());
    }

    #[test]
    fn wrap_upstream_url_includes_an_explicit_port() {
        let upstream =
            reqwest::Url::parse("http://provider.example:8080/live/u/p/1.m3u8?x=1").unwrap();
        assert_eq!(
            wrap_upstream_url("http://127.0.0.1:41234/ab12cd", &upstream),
            "http://127.0.0.1:41234/ab12cd/http/provider.example:8080/live/u/p/1.m3u8?x=1"
        );
    }

    #[test]
    fn wrap_upstream_url_preserves_the_query_string() {
        let upstream =
            reqwest::Url::parse("https://provider.example/path/seg.ts?token=abc&n=1").unwrap();
        assert_eq!(
            wrap_upstream_url("http://127.0.0.1:9000/tok", &upstream),
            "http://127.0.0.1:9000/tok/https/provider.example/path/seg.ts?token=abc&n=1"
        );
    }

    #[test]
    fn wrap_upstream_url_brackets_an_ipv6_literal_host() {
        let upstream = reqwest::Url::parse("https://[2606:4700::1111]/dns-query").unwrap();
        assert_eq!(
            wrap_upstream_url("http://127.0.0.1:9000/tok", &upstream),
            "http://127.0.0.1:9000/tok/https/[2606:4700::1111]/dns-query"
        );
    }

    #[test]
    fn wrap_upstream_url_omits_the_trailing_slash_for_an_empty_path() {
        let upstream = reqwest::Url::parse("http://provider.example/").unwrap();
        assert_eq!(
            wrap_upstream_url("http://127.0.0.1:9000/tok", &upstream),
            "http://127.0.0.1:9000/tok/http/provider.example"
        );
    }

    fn upstream(url: &str) -> reqwest::Url {
        reqwest::Url::parse(url).unwrap()
    }

    #[test]
    fn rewrite_m3u8_rewrites_absolute_variant_urls_in_a_master_playlist() {
        let body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nhttp://provider.example/hd/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nhttp://provider.example/sd/index.m3u8\n";
        let base = upstream("http://provider.example/master.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert!(rewritten.contains("http://127.0.0.1:9000/tok/http/provider.example/hd/index.m3u8"));
        assert!(rewritten.contains("http://127.0.0.1:9000/tok/http/provider.example/sd/index.m3u8"));
        assert!(rewritten.contains("#EXT-X-STREAM-INF:BANDWIDTH=800000"));
    }

    #[test]
    fn rewrite_m3u8_rewrites_relative_segments_against_the_upstream_url() {
        let body = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment0.ts\n#EXTINF:6.0,\nsegment1.ts\n";
        let base = upstream("http://provider.example/live/u/p/index.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert!(rewritten
            .contains("http://127.0.0.1:9000/tok/http/provider.example/live/u/p/segment0.ts"));
        assert!(rewritten
            .contains("http://127.0.0.1:9000/tok/http/provider.example/live/u/p/segment1.ts"));
    }

    #[test]
    fn rewrite_m3u8_rewrites_a_root_relative_segment() {
        let body = "#EXTM3U\n#EXTINF:6.0,\n/hls/1/seg0.ts\n";
        let base = upstream("http://provider.example/live/u/p/index.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert!(rewritten.contains("http://127.0.0.1:9000/tok/http/provider.example/hls/1/seg0.ts"));
    }

    #[test]
    fn rewrite_m3u8_rewrites_a_protocol_relative_segment() {
        let body = "#EXTM3U\n#EXTINF:6.0,\n//cdn.example/seg0.ts\n";
        let base = upstream("https://provider.example/live/u/p/index.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert!(rewritten.contains("http://127.0.0.1:9000/tok/https/cdn.example/seg0.ts"));
    }

    #[test]
    fn rewrite_m3u8_rewrites_an_absolute_uri_attribute_in_ext_x_key() {
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://provider.example/keys/1.key\",IV=0x1\n#EXTINF:6.0,\nsegment0.ts\n";
        let base = upstream("http://provider.example/live/u/p/index.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert!(rewritten
            .contains("URI=\"http://127.0.0.1:9000/tok/https/provider.example/keys/1.key\""));
        assert!(rewritten.contains("METHOD=AES-128"));
        assert!(rewritten.contains("IV=0x1"));
    }

    #[test]
    fn rewrite_m3u8_rewrites_a_relative_uri_attribute() {
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"keys/1.key\",IV=0x1\n#EXTINF:6.0,\nsegment0.ts\n";
        let base = upstream("http://provider.example/live/u/p/index.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert!(rewritten
            .contains("URI=\"http://127.0.0.1:9000/tok/http/provider.example/live/u/p/keys/1.key\""));
    }

    #[test]
    fn rewrite_m3u8_leaves_a_data_uri_untouched() {
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\",IV=0x1\n#EXTINF:6.0,\nsegment0.ts\n";
        let base = upstream("http://provider.example/live/u/p/index.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert!(rewritten.contains("URI=\"data:text/plain;base64,AAAA\""));
    }

    #[test]
    fn rewrite_m3u8_leaves_comment_lines_untouched() {
        let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n";
        let base = upstream("http://provider.example/live/u/p/index.m3u8");
        let rewritten = rewrite_m3u8(body, "http://127.0.0.1:9000/tok", &base);
        assert_eq!(rewritten, body);
    }

    #[test]
    fn looks_like_m3u8_matches_content_type_and_extension() {
        assert!(looks_like_m3u8(
            Some("application/vnd.apple.mpegurl; charset=utf-8"),
            "/live/1"
        ));
        assert!(looks_like_m3u8(None, "/live/1/index.m3u8"));
        assert!(!looks_like_m3u8(Some("video/mp2t"), "/live/1.ts"));
    }

    #[test]
    fn looks_like_m3u8_rejects_media_content_types_despite_a_matching_path_suffix() {
        assert!(!looks_like_m3u8(Some("video/mp2t"), "/live/u/p/123.m3u8"));
        assert!(!looks_like_m3u8(
            Some("audio/aac; charset=utf-8"),
            "/live/u/p/123.m3u8"
        ));
        assert!(looks_like_m3u8(
            Some("audio/x-mpegurl"),
            "/live/u/p/123.m3u8"
        ));
        assert!(!looks_like_m3u8(
            Some("audio/x-mpegurl"),
            "/live/u/p/123.ts"
        ));
    }

    #[test]
    fn body_starts_like_m3u8_handles_bom_and_leading_whitespace() {
        assert!(body_starts_like_m3u8(b"#EXTM3U\n#EXT-X-VERSION:3\n"));
        assert!(body_starts_like_m3u8(b"\xEF\xBB\xBF#EXTM3U\n"));
        assert!(body_starts_like_m3u8(b"\n\n#EXTM3U\n"));
        assert!(!body_starts_like_m3u8(&[0x47, 0x00, 0x00, 0x01]));
        assert!(!body_starts_like_m3u8(b""));
    }

    #[test]
    fn forwarded_accept_encoding_forces_identity_outside_raw_mode() {
        let client_value = axum::http::HeaderValue::from_static("gzip, deflate");
        assert_eq!(
            forwarded_accept_encoding(false, Some(&client_value)),
            Some(axum::http::HeaderValue::from_static("identity"))
        );
        assert_eq!(
            forwarded_accept_encoding(false, None),
            Some(axum::http::HeaderValue::from_static("identity"))
        );
    }

    #[test]
    fn forwarded_accept_encoding_passes_through_the_client_value_in_raw_mode() {
        let client_value = axum::http::HeaderValue::from_static("gzip");
        assert_eq!(
            forwarded_accept_encoding(true, Some(&client_value)),
            Some(client_value.clone())
        );
        assert_eq!(forwarded_accept_encoding(true, None), None);
    }

    #[test]
    fn has_non_identity_content_encoding_flags_gzip_but_not_identity_or_absent() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert!(!has_non_identity_content_encoding(&headers));
        headers.insert(
            reqwest::header::CONTENT_ENCODING,
            reqwest::header::HeaderValue::from_static("identity"),
        );
        assert!(!has_non_identity_content_encoding(&headers));
        headers.insert(
            reqwest::header::CONTENT_ENCODING,
            reqwest::header::HeaderValue::from_static("gzip"),
        );
        assert!(has_non_identity_content_encoding(&headers));
    }

    #[test]
    fn is_hop_by_hop_header_matches_the_documented_set() {
        for name in [
            "host",
            "connection",
            "keep-alive",
            "transfer-encoding",
            "te",
            "trailer",
            "upgrade",
            "proxy-authenticate",
        ] {
            let header_name = axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
            assert!(
                is_hop_by_hop_header(&header_name),
                "{name} must be treated as hop-by-hop"
            );
        }
        let range = axum::http::HeaderName::from_static("range");
        assert!(
            !is_hop_by_hop_header(&range),
            "Range must be forwarded unchanged"
        );
    }

    fn test_session(token: &str, last_used: Instant) -> Arc<DnsProxySession> {
        Arc::new(DnsProxySession {
            token: token.to_string(),
            raw_server: "1.1.1.1".to_string(),
            base_url: format!("http://127.0.0.1:9000/{token}"),
            client: reqwest::Client::new(),
            last_used: Mutex::new(last_used),
        })
    }

    fn forwarded_body(
        raw_mode: bool,
        content_type: Option<&str>,
        upstream_path: &str,
        body: &str,
        base: &str,
    ) -> String {
        let upstream_url = reqwest::Url::parse(&format!("http://provider.example{upstream_path}")).unwrap();
        if should_rewrite_body(raw_mode, content_type, upstream_path) {
            rewrite_m3u8(body, base, &upstream_url)
        } else {
            body.to_string()
        }
    }

    #[test]
    fn evict_least_recently_used_keeps_at_most_max_sessions() {
        let mut sessions: HashMap<String, Arc<DnsProxySession>> = HashMap::new();
        let mut keys: HashMap<String, String> = HashMap::new();
        let base = Instant::now();
        let total = MAX_SESSIONS + 3;
        for i in 0..total {
            let age = Duration::from_secs((total - i) as u64);
            let token = format!("token-{i}");
            sessions.insert(
                token.clone(),
                test_session(&token, base.checked_sub(age).unwrap()),
            );
            keys.insert(format!("key-{i}"), token);
            evict_least_recently_used(&mut sessions, &mut keys);
        }
        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert!(
            !sessions.contains_key("token-0"),
            "oldest sessions must be evicted first"
        );
        assert!(sessions.contains_key(&format!("token-{}", total - 1)));
    }

    #[test]
    fn evict_least_recently_used_keeps_a_recently_used_older_session_over_an_idle_newer_one() {
        let mut sessions: HashMap<String, Arc<DnsProxySession>> = HashMap::new();
        let mut keys: HashMap<String, String> = HashMap::new();
        let base = Instant::now();
        for i in 0..MAX_SESSIONS {
            let age = Duration::from_secs((MAX_SESSIONS - i) as u64);
            let token = format!("token-{i}");
            sessions.insert(
                token.clone(),
                test_session(&token, base.checked_sub(age).unwrap()),
            );
            keys.insert(format!("key-{i}"), token);
        }

        // token-0 is the oldest session by creation order, but a request just came through it.
        *sessions.get("token-0").unwrap().last_used.lock().unwrap() = base;

        sessions.insert("token-new".to_string(), test_session("token-new", base));
        keys.insert("key-new".to_string(), "token-new".to_string());
        evict_least_recently_used(&mut sessions, &mut keys);

        assert!(
            sessions.contains_key("token-0"),
            "a recently used session must survive eviction even though it is the oldest by creation"
        );
        assert!(
            !sessions.contains_key("token-1"),
            "the least recently used session must be evicted instead"
        );
    }

    #[test]
    fn evict_least_recently_used_drops_the_key_mapping_of_the_evicted_session() {
        let mut sessions: HashMap<String, Arc<DnsProxySession>> = HashMap::new();
        let mut keys: HashMap<String, String> = HashMap::new();
        let base = Instant::now();
        for i in 0..=MAX_SESSIONS {
            let age = Duration::from_secs((MAX_SESSIONS + 1 - i) as u64);
            let token = format!("token-{i}");
            sessions.insert(
                token.clone(),
                test_session(&token, base.checked_sub(age).unwrap()),
            );
            keys.insert(format!("key-{i}"), token);
        }
        evict_least_recently_used(&mut sessions, &mut keys);

        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert_eq!(keys.len(), MAX_SESSIONS);
        assert!(!sessions.contains_key("token-0"));
        assert!(
            !keys.contains_key("key-0"),
            "the evicted session must not leave its key mapping behind"
        );
    }

    #[test]
    fn raw_passthrough_leaves_a_manifest_body_untouched_but_the_default_mode_rewrites_it() {
        let body =
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nhttp://provider.example/hd/index.m3u8\n";
        let base = "http://127.0.0.1:9000/tok";
        assert_eq!(
            forwarded_body(true, Some("application/x-mpegurl"), "/get.php", body, base),
            body,
            "raw mode must forward the body verbatim"
        );
        let rewritten =
            forwarded_body(false, Some("application/x-mpegurl"), "/get.php", body, base);
        assert!(
            rewritten.contains("http://127.0.0.1:9000/tok/http/provider.example/hd/index.m3u8"),
            "default mode must still rewrite manifest URLs"
        );
    }

    #[test]
    fn should_rewrite_body_is_off_in_raw_mode() {
        assert!(should_rewrite_body(false, None, "/live/1/index.m3u8"));
        assert!(!should_rewrite_body(true, None, "/live/1/index.m3u8"));
        assert!(!should_rewrite_body(
            false,
            Some("video/mp2t"),
            "/live/1.ts"
        ));
    }

    #[test]
    fn is_raw_passthrough_reads_the_opt_in_header() {
        let mut headers = HeaderMap::new();
        assert!(!is_raw_passthrough(&headers));
        headers.insert(
            RAW_PASSTHROUGH_HEADER,
            axum::http::HeaderValue::from_static("0"),
        );
        assert!(!is_raw_passthrough(&headers));
        headers.insert(
            RAW_PASSTHROUGH_HEADER,
            axum::http::HeaderValue::from_static("1"),
        );
        assert!(is_raw_passthrough(&headers));
    }

    #[test]
    fn should_forward_request_header_drops_the_raw_opt_in_marker() {
        let marker = axum::http::HeaderName::from_static(RAW_PASSTHROUGH_HEADER);
        assert!(!should_forward_request_header(&marker));
        let range = axum::http::HeaderName::from_static("range");
        assert!(should_forward_request_header(&range));
    }

    #[test]
    fn request_can_have_body_skips_get_head_and_empty_bodies() {
        let mut headers = HeaderMap::new();
        assert!(!request_can_have_body(&Method::GET, &headers));
        assert!(!request_can_have_body(&Method::HEAD, &headers));
        assert!(!request_can_have_body(&Method::POST, &headers));

        headers.insert(
            axum::http::header::CONTENT_LENGTH,
            axum::http::HeaderValue::from_static("0"),
        );
        assert!(!request_can_have_body(&Method::POST, &headers));

        headers.insert(
            axum::http::header::CONTENT_LENGTH,
            axum::http::HeaderValue::from_static("12"),
        );
        assert!(request_can_have_body(&Method::POST, &headers));
        assert!(!request_can_have_body(&Method::GET, &headers));
    }

    #[test]
    fn rewrite_location_proxies_a_relative_redirect() {
        let upstream = reqwest::Url::parse("http://provider.example/live/u/p/1.m3u8").unwrap();
        assert_eq!(
            rewrite_location(
                "/hls/123/index.m3u8",
                "http://127.0.0.1:9000/tok",
                &upstream
            ),
            Some("http://127.0.0.1:9000/tok/http/provider.example/hls/123/index.m3u8".to_string())
        );
        assert_eq!(
            rewrite_location("index.m3u8?x=1", "http://127.0.0.1:9000/tok", &upstream),
            Some(
                "http://127.0.0.1:9000/tok/http/provider.example/live/u/p/index.m3u8?x=1"
                    .to_string()
            )
        );
    }

    #[test]
    fn rewrite_location_proxies_an_absolute_redirect() {
        let upstream = reqwest::Url::parse("http://provider.example/live/u/p/1.m3u8").unwrap();
        assert_eq!(
            rewrite_location(
                "https://edge.example:8443/hls/1.m3u8",
                "http://127.0.0.1:9000/tok",
                &upstream
            ),
            Some("http://127.0.0.1:9000/tok/https/edge.example:8443/hls/1.m3u8".to_string())
        );
        assert_eq!(
            rewrite_location(
                "rtsp://provider.example/1",
                "http://127.0.0.1:9000/tok",
                &upstream
            ),
            None
        );
    }

    #[test]
    fn split_forward_path_keeps_the_upstream_path_verbatim() {
        let target = split_forward_path("/tok/http/provider.example/a%3Fb/c%2Fd.m3u8");
        assert_eq!(target.token, "tok");
        assert_eq!(target.scheme, "http");
        assert_eq!(target.hostport, "provider.example");
        assert_eq!(target.path, "a%3Fb/c%2Fd.m3u8");
    }

    #[test]
    fn a_percent_encoded_path_segment_survives_the_proxy_round_trip() {
        let upstream =
            reqwest::Url::parse("http://provider.example/a%3Fb/c%2Fd.m3u8?token=1").unwrap();
        let wrapped = wrap_upstream_url("http://127.0.0.1:9000/tok", &upstream);
        assert_eq!(
            wrapped,
            "http://127.0.0.1:9000/tok/http/provider.example/a%3Fb/c%2Fd.m3u8?token=1"
        );
        let wrapped_url = reqwest::Url::parse(&wrapped).unwrap();
        let target = split_forward_path(wrapped_url.path());
        let rebuilt = build_upstream_url(&target, wrapped_url.query()).unwrap();
        assert_eq!(rebuilt.as_str(), upstream.as_str());
        assert_eq!(rebuilt.path(), "/a%3Fb/c%2Fd.m3u8");
        assert_eq!(rebuilt.query(), Some("token=1"));
    }

    #[test]
    fn build_upstream_url_accepts_a_percent_encoded_ipv6_host() {
        let target = split_forward_path("/tok/https/%5B2606:4700::1111%5D/dns-query");
        let rebuilt = build_upstream_url(&target, None).unwrap();
        assert_eq!(rebuilt.as_str(), "https://[2606:4700::1111]/dns-query");
    }

    #[test]
    fn is_dns_proxy_url_accepts_a_wrapped_url() {
        assert!(is_dns_proxy_url(
            "http://127.0.0.1:9000/tok/https/provider.example/live/u/p/1.m3u8"
        ));
    }

    #[test]
    fn is_dns_proxy_url_rejects_a_vod_proxy_tee_url() {
        assert!(!is_dns_proxy_url("http://127.0.0.1:5173/abc/stream.mkv"));
    }

    #[test]
    fn is_dns_proxy_url_rejects_a_non_loopback_host() {
        assert!(!is_dns_proxy_url(
            "http://provider.example/tok/https/other.example/stream.mkv"
        ));
    }

    #[test]
    fn wrap_upstream_url_keeps_a_double_leading_slash_in_the_path() {
        let upstream = reqwest::Url::parse("http://provider.example//hls/1.m3u8").unwrap();
        assert_eq!(
            wrap_upstream_url("http://127.0.0.1:9000/tok", &upstream),
            "http://127.0.0.1:9000/tok/http/provider.example//hls/1.m3u8"
        );
        let wrapped_url =
            reqwest::Url::parse("http://127.0.0.1:9000/tok/http/provider.example//hls/1.m3u8")
                .unwrap();
        let target = split_forward_path(wrapped_url.path());
        assert_eq!(
            build_upstream_url(&target, None).unwrap().as_str(),
            upstream.as_str()
        );
    }
}
