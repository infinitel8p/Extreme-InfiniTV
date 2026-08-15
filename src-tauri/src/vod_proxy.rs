// Local tee-proxy for MKV VOD (desktop only): forwards Range requests 1:1 while demuxing subtitle cues.

use std::collections::{HashMap, HashSet};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::http_range::{range_request_start, ranged_response_is_corrupted};
use crate::matroska::{self, ClusterScanner, HeadInfo, ScannedCue, SubtitleCodec};

const TRACKS_EVENT: &str = "xt:vodproxy-tracks";
const CUES_EVENT: &str = "xt:vodproxy-cues";
const SUBTITLE_TRACK_TYPE: u8 = 0x11;
const AUDIO_TRACK_TYPE: u8 = 0x02;
const HEAD_PROBE_SMALL_END: u64 = 2_097_151;
const HEAD_PROBE_LARGE_END: u64 = 8_388_607;
const HEAD_PROBE_SLACK: usize = 64 * 1024;
const TEE_PREFIX_CAP: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Event emitter abstraction (testable without a Tauri AppHandle)
// ---------------------------------------------------------------------------

pub trait VodProxyEvents: Send + Sync + 'static {
    fn tracks(&self, payload: Value);
    fn cues(&self, payload: Value);
}

impl VodProxyEvents for AppHandle {
    fn tracks(&self, payload: Value) {
        let _ = self.emit(TRACKS_EVENT, payload);
    }
    fn cues(&self, payload: Value) {
        let _ = self.emit(CUES_EVENT, payload);
    }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct HeadContext {
    timestamp_scale_ns: u64,
    subtitle_tracks: HashMap<u64, SubtitleCodec>,
}

/// Where a session's bytes come from: an upstream provider URL, or a file already on disk.
#[derive(Debug, Clone)]
enum VodSource {
    Upstream(String),
    LocalFile(PathBuf),
}

struct VodSession {
    session_id: String,
    #[allow(dead_code)]
    token: String,
    source: VodSource,
    user_agent: Option<String>,
    head: OnceLock<Option<HeadContext>>,
    dedupe: Mutex<HashSet<(u64, u64, u64)>>,
    created_at: std::time::Instant,
}

// Caps leaks from navigation races: an unload mid-register orphans a session forever.
const MAX_SESSIONS: usize = 8;

type SessionMap = Arc<Mutex<HashMap<String, Arc<VodSession>>>>;

struct ServerHandle {
    port: u16,
    client: reqwest::Client,
    // Kept for a future "stop the proxy" path; only a lost startup race fires it today.
    #[allow(dead_code)]
    shutdown: tokio::sync::oneshot::Sender<()>,
}

#[derive(Default)]
pub struct VodProxyState {
    server: Mutex<Option<ServerHandle>>,
    sessions: SessionMap,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterVodProxyResponse {
    pub session_id: String,
    pub proxy_url: String,
}

#[tauri::command]
pub async fn register_vod_proxy(
    app: AppHandle,
    state: tauri::State<'_, VodProxyState>,
    url: String,
    user_agent: Option<String>,
) -> Result<RegisterVodProxyResponse, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("OTHER:{e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("OTHER:url must be http or https".to_string());
    }
    let extension = extract_extension(&parsed);

    let events: Arc<dyn VodProxyEvents> = Arc::new(app);
    let (port, client) = ensure_server_started(&state, events.clone()).await?;

    // Token doubles as the session id: both are opaque identifiers, no reason to mint two.
    let token = generate_token();
    let session = Arc::new(VodSession {
        session_id: token.clone(),
        token: token.clone(),
        source: VodSource::Upstream(url),
        user_agent,
        head: OnceLock::new(),
        dedupe: Mutex::new(HashSet::new()),
        created_at: std::time::Instant::now(),
    });

    {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.insert(token.clone(), session.clone());
        evict_oldest_if_over_capacity(&mut sessions);
    }

    spawn_head_parse(events, session, client);

    Ok(RegisterVodProxyResponse {
        session_id: token.clone(),
        proxy_url: format!("http://127.0.0.1:{port}/{token}/stream{extension}"),
    })
}

/// Same tee-proxy, fed from a file on disk: local downloads mount as asset.localhost sources
/// WebKit can't demux, and the ffmpeg sidecar only speaks http/pipe/tcp, so the file is re-served over HTTP first.
#[tauri::command]
pub async fn register_vod_proxy_file(
    app: AppHandle,
    state: tauri::State<'_, VodProxyState>,
    path: String,
    extra_allowed_root: Option<String>,
) -> Result<RegisterVodProxyResponse, String> {
    let canonical_path = tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| format!("OTHER:file not found: {e}"))?;
    let metadata = tokio::fs::metadata(&canonical_path)
        .await
        .map_err(|e| format!("OTHER:file not found: {e}"))?;
    if !metadata.is_file() {
        return Err("OTHER:path is not a file".to_string());
    }
    let mut allowed_roots = local_file_allowed_roots(&app);
    if let Some(extra_root) = extra_allowed_root {
        if let Some(canonical_root) = canonicalize_allowed_root(&extra_root).await {
            allowed_roots.push(canonical_root);
        }
    }
    if !is_local_file_path_allowed(&canonical_path, &allowed_roots) {
        return Err("OTHER:path is outside the allowed media directories".to_string());
    }
    let extension = extract_extension_from_path(&canonical_path);

    let events: Arc<dyn VodProxyEvents> = Arc::new(app);
    let (port, client) = ensure_server_started(&state, events.clone()).await?;

    let token = generate_token();
    let session = Arc::new(VodSession {
        session_id: token.clone(),
        token: token.clone(),
        source: VodSource::LocalFile(canonical_path),
        user_agent: None,
        head: OnceLock::new(),
        dedupe: Mutex::new(HashSet::new()),
        created_at: std::time::Instant::now(),
    });

    {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.insert(token.clone(), session.clone());
        evict_oldest_if_over_capacity(&mut sessions);
    }

    spawn_head_parse(events, session, client);

    Ok(RegisterVodProxyResponse {
        session_id: token.clone(),
        proxy_url: format!("http://127.0.0.1:{port}/{token}/stream{extension}"),
    })
}

#[tauri::command]
pub fn unregister_vod_proxy(
    state: tauri::State<'_, VodProxyState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    sessions.remove(&session_id);
    Ok(())
}

fn evict_oldest_if_over_capacity(sessions: &mut HashMap<String, Arc<VodSession>>) {
    if sessions.len() <= MAX_SESSIONS {
        return;
    }
    if let Some(oldest) = sessions
        .iter()
        .min_by_key(|(_, session)| session.created_at)
        .map(|(token, _)| token.clone())
    {
        sessions.remove(&oldest);
    }
}

fn extract_extension(parsed: &tauri::Url) -> String {
    let path = parsed.path();
    let file_name = path.rsplit('/').next().unwrap_or("");
    match file_name.rfind('.') {
        Some(index) => file_name[index..].to_string(),
        None => String::new(),
    }
}

fn extract_extension_from_path(path: &FsPath) -> String {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => format!(".{ext}"),
        None => String::new(),
    }
}

/// Media extensions the frontend can hand to `register_vod_proxy_file` (mirrors the container
/// list in `player-runtime.ts`'s `streamKindHint`).
const ALLOWED_LOCAL_FILE_EXTENSIONS: &[&str] = &[
    "mkv", "webm", "avi", "mp4", "m4v", "mov", "ts", "mp3", "aac", "flac", "m4a", "ogg",
];

/// Download/video/home/app-data dirs, matching the fs capability scope in `default.json` so this
/// command can never be pointed at a path the app has no other access to.
fn local_file_allowed_roots(app: &AppHandle) -> Vec<PathBuf> {
    let resolver = app.path();
    [
        resolver.download_dir().ok(),
        resolver.video_dir().ok(),
        resolver.home_dir().ok(),
        resolver.app_data_dir().ok(),
        resolver.app_local_data_dir().ok(),
    ]
    .into_iter()
    .flatten()
    .map(|root| std::fs::canonicalize(&root).unwrap_or(root))
    .collect()
}

/// Resolves a user-configured extra root; None unless it canonicalizes to an existing directory.
async fn canonicalize_allowed_root(root: &str) -> Option<PathBuf> {
    let canonical_root = tokio::fs::canonicalize(root).await.ok()?;
    let metadata = tokio::fs::metadata(&canonical_root).await.ok()?;
    if metadata.is_dir() {
        Some(canonical_root)
    } else {
        None
    }
}

/// Pure path-confinement check: `canonical_path` must sit under one of `allowed_roots` and carry
/// one of `ALLOWED_LOCAL_FILE_EXTENSIONS`.
fn is_local_file_path_allowed(canonical_path: &FsPath, allowed_roots: &[PathBuf]) -> bool {
    let extension_allowed = canonical_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ALLOWED_LOCAL_FILE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    extension_allowed && allowed_roots.iter().any(|root| canonical_path.starts_with(root))
}

// Best-effort MIME hint for the local-file variant; the upstream variant relies on the provider's own Content-Type header instead.
fn content_type_for_path(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("mkv") => "video/x-matroska",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("ts") => "video/mp2t",
        _ => "application/octet-stream",
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

async fn ensure_server_started(
    state: &VodProxyState,
    events: Arc<dyn VodProxyEvents>,
) -> Result<(u16, reqwest::Client), String> {
    {
        let guard = state
            .server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(handle) = guard.as_ref() {
            return Ok((handle.port, handle.client.clone()));
        }
    }

    let (port, shutdown, client) = start_server(events, state.sessions.clone())
        .await
        .map_err(|e| format!("OTHER:failed to start vod proxy server: {e}"))?;

    let mut guard = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(handle) = guard.as_ref() {
        // Lost a startup race against a concurrent register call; drop the spare listener.
        let _ = shutdown.send(());
        return Ok((handle.port, handle.client.clone()));
    }
    *guard = Some(ServerHandle {
        port,
        client: client.clone(),
        shutdown,
    });
    Ok((port, client))
}

struct ServerState {
    events: Arc<dyn VodProxyEvents>,
    sessions: SessionMap,
    port: u16,
    client: reqwest::Client,
}

async fn start_server(
    events: Arc<dyn VodProxyEvents>,
    sessions: SessionMap,
) -> std::io::Result<(u16, tokio::sync::oneshot::Sender<()>, reqwest::Client)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let client = reqwest::Client::new();

    let server_state = Arc::new(ServerState {
        events,
        sessions,
        port,
        client: client.clone(),
    });
    let router = axum::Router::new()
        .route("/{token}/{*rest}", axum::routing::get(handle_stream))
        .with_state(server_state);

    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = serve.await {
            log::warn!("[vod-proxy] server exited: {error}");
        }
    });

    Ok((port, shutdown_tx, client))
}

async fn handle_stream(
    State(state): State<Arc<ServerState>>,
    Path(params): Path<HashMap<String, String>>,
    headers: HeaderMap,
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

    let Some(token) = params.get("token") else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    let session = {
        let sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.get(token).cloned()
    };
    let Some(session) = session else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };

    let upstream_url = match &session.source {
        VodSource::Upstream(url) => url.clone(),
        VodSource::LocalFile(path) => {
            let path = path.clone();
            return serve_local_file(
                session.clone(),
                state.events.clone(),
                &path,
                headers.get(axum::http::header::RANGE),
            )
            .await;
        }
    };

    let mut upstream_request = state.client.get(&upstream_url);
    let mut requested_range_start = None;
    if let Some(range) = headers.get(axum::http::header::RANGE) {
        if let Ok(value) = range.to_str() {
            upstream_request = upstream_request.header(reqwest::header::RANGE, value);
            requested_range_start = range_request_start(value);
        }
    }
    if let Some(ua) = &session.user_agent {
        upstream_request = upstream_request.header(reqwest::header::USER_AGENT, ua.clone());
    }

    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[vod-proxy] upstream request failed: {}", error.without_url());
            return (StatusCode::BAD_GATEWAY, "upstream request failed").into_response();
        }
    };

    let status = upstream_response.status();
    if let Some(requested_start) = requested_range_start {
        if ranged_response_is_corrupted(status, upstream_response.headers(), requested_start) {
            log::warn!("[vod-proxy] upstream sent a 206 starting at the wrong byte for range {requested_start}");
            return (StatusCode::BAD_GATEWAY, "upstream range response mismatch").into_response();
        }
    }
    let mut response_builder = axum::http::Response::builder().status(status.as_u16());
    for header_name in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
    ] {
        if let Some(value) = upstream_response.headers().get(header_name) {
            response_builder = response_builder.header(header_name, value.clone());
        }
    }

    let tee_state = TeeState::new(session.clone());
    let body_stream = tee_stream(
        upstream_response.bytes_stream(),
        tee_state,
        session,
        state.events.clone(),
    );

    match response_builder.body(axum::body::Body::from_stream(body_stream)) {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[vod-proxy] failed to build response: {error}");
            (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
        }
    }
}

/// A request usually starts before the head parse lands, so chunks are buffered and replayed once it does.
struct TeeState {
    session: Arc<VodSession>,
    scanner: Option<ClusterScanner>,
    prefix: Option<Vec<u8>>,
    disabled: bool,
}

impl TeeState {
    fn new(session: Arc<VodSession>) -> Self {
        match session.head.get() {
            Some(Some(head_context)) if !head_context.subtitle_tracks.is_empty() => {
                let scanner = ClusterScanner::new(
                    head_context.timestamp_scale_ns,
                    head_context.subtitle_tracks.clone(),
                );
                Self {
                    session,
                    scanner: Some(scanner),
                    prefix: None,
                    disabled: false,
                }
            }
            Some(_) => Self {
                session,
                scanner: None,
                prefix: None,
                disabled: true,
            },
            None => Self {
                session,
                scanner: None,
                prefix: Some(Vec::new()),
                disabled: false,
            },
        }
    }

    /// A parser panic sticks the tee off for the rest of the request.
    fn process(&mut self, chunk: &[u8]) -> Vec<ScannedCue> {
        if self.disabled {
            return Vec::new();
        }

        if self.scanner.is_none() {
            match self.session.head.get() {
                None => {
                    if let Some(prefix) = self.prefix.as_mut() {
                        prefix.extend_from_slice(chunk);
                        if prefix.len() > TEE_PREFIX_CAP {
                            // Drop rather than grow unbounded; the scanner's resync recovers once attached.
                            self.prefix = None;
                        }
                    }
                    return Vec::new();
                }
                Some(None) => {
                    self.disabled = true;
                    self.prefix = None;
                    return Vec::new();
                }
                Some(Some(head_context)) => {
                    if head_context.subtitle_tracks.is_empty() {
                        self.disabled = true;
                        self.prefix = None;
                        return Vec::new();
                    }
                    self.scanner = Some(ClusterScanner::new(
                        head_context.timestamp_scale_ns,
                        head_context.subtitle_tracks.clone(),
                    ));
                }
            }
        }

        let scanner = self.scanner.as_mut().expect("scanner attached above");
        let mut cues = Vec::new();
        if let Some(prefix) = self.prefix.take() {
            if !prefix.is_empty() {
                match feed_guarded(scanner, &prefix) {
                    Some(mut prefix_cues) => cues.append(&mut prefix_cues),
                    None => {
                        self.disabled = true;
                        return cues;
                    }
                }
            }
        }

        match feed_guarded(scanner, chunk) {
            Some(mut chunk_cues) => cues.append(&mut chunk_cues),
            None => self.disabled = true,
        }
        cues
    }
}

fn feed_guarded(scanner: &mut ClusterScanner, chunk: &[u8]) -> Option<Vec<ScannedCue>> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| scanner.feed(chunk))).ok()
}

// Generic over the error type so the same tee wraps both the upstream stream (reqwest::Error) and the local-file stream (std::io::Error).
fn tee_stream<S, E>(
    upstream: S,
    mut tee_state: TeeState,
    session: Arc<VodSession>,
    events: Arc<dyn VodProxyEvents>,
) -> impl futures_util::Stream<Item = Result<Bytes, E>> + Send + 'static
where
    S: futures_util::Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: Send + 'static,
{
    upstream.map(move |item| {
        if let Ok(chunk) = &item {
            let cues = tee_state.process(chunk);
            emit_cues(&session, &events, cues);
        }
        item
    })
}

/// `NoRange` covers an absent or unparseable header (RFC 7233: ignore and serve the whole file);
/// `Unsatisfiable` is only a start past EOF or a multi-range request (this proxy serves one range).
#[derive(Debug, PartialEq)]
enum RangeOutcome {
    NoRange,
    Satisfiable(u64, u64),
    Unsatisfiable,
}

fn parse_single_range(header_value: &str, file_len: u64) -> RangeOutcome {
    let Some(spec) = header_value.trim().strip_prefix("bytes=") else {
        return RangeOutcome::NoRange;
    };
    if spec.contains(',') {
        return RangeOutcome::Unsatisfiable;
    }
    if file_len == 0 {
        return RangeOutcome::Unsatisfiable;
    }
    let Some((start_str, end_str)) = spec.split_once('-') else {
        return RangeOutcome::NoRange;
    };
    if start_str.is_empty() {
        let Ok(suffix_len) = end_str.parse::<u64>() else {
            return RangeOutcome::NoRange;
        };
        if suffix_len == 0 {
            return RangeOutcome::NoRange;
        }
        let start = file_len.saturating_sub(suffix_len.min(file_len));
        return RangeOutcome::Satisfiable(start, file_len - 1);
    }
    let Ok(start) = start_str.parse::<u64>() else {
        return RangeOutcome::NoRange;
    };
    if start >= file_len {
        return RangeOutcome::Unsatisfiable;
    }
    let end = if end_str.is_empty() {
        file_len - 1
    } else {
        match end_str.parse::<u64>() {
            Ok(value) => value.min(file_len - 1),
            Err(_) => return RangeOutcome::NoRange,
        }
    };
    if end < start {
        return RangeOutcome::NoRange;
    }
    RangeOutcome::Satisfiable(start, end)
}

/// Serves a local file with the same Range semantics the upstream-forwarding path exposes to
/// the player, tee'd through the same subtitle/audio-cue scanner used for provider streams.
async fn serve_local_file(
    session: Arc<VodSession>,
    events: Arc<dyn VodProxyEvents>,
    path: &FsPath,
    range_header: Option<&HeaderValue>,
) -> Response {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) => {
            log::warn!("[vod-proxy] local file open failed: {error}");
            return (StatusCode::NOT_FOUND, "file not found").into_response();
        }
    };
    let file_len = match file.metadata().await {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            log::warn!("[vod-proxy] local file metadata failed: {error}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "metadata failed").into_response();
        }
    };

    if file_len == 0 {
        return axum::http::Response::builder()
            .status(StatusCode::OK)
            .header(axum::http::header::CONTENT_TYPE, content_type_for_path(path))
            .header(axum::http::header::CONTENT_LENGTH, 0)
            .header(axum::http::header::ACCEPT_RANGES, "bytes")
            .body(axum::body::Body::empty())
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
            });
    }

    let range_outcome = match range_header.and_then(|value| value.to_str().ok()) {
        Some(value) => parse_single_range(value, file_len),
        None => RangeOutcome::NoRange,
    };
    let (status, start, end_inclusive) = match range_outcome {
        RangeOutcome::Unsatisfiable => {
            return axum::http::Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(axum::http::header::CONTENT_RANGE, format!("bytes */{file_len}"))
                .body(axum::body::Body::empty())
                .unwrap_or_else(|_| {
                    (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
                });
        }
        RangeOutcome::Satisfiable(start, end) => (StatusCode::PARTIAL_CONTENT, start, end),
        RangeOutcome::NoRange => (StatusCode::OK, 0, file_len - 1),
    };
    if start > 0 {
        if let Err(error) = file.seek(std::io::SeekFrom::Start(start)).await {
            log::warn!("[vod-proxy] local file seek failed: {error}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "seek failed").into_response();
        }
    }

    let content_length = end_inclusive - start + 1;
    let tee_state = TeeState::new(session.clone());
    let body_stream = tee_stream(
        ReaderStream::new(file.take(content_length)),
        tee_state,
        session,
        events,
    );

    let mut response_builder = axum::http::Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, content_type_for_path(path))
        .header(axum::http::header::CONTENT_LENGTH, content_length)
        .header(axum::http::header::ACCEPT_RANGES, "bytes");
    if status == StatusCode::PARTIAL_CONTENT {
        response_builder = response_builder.header(
            axum::http::header::CONTENT_RANGE,
            format!("bytes {start}-{end_inclusive}/{file_len}"),
        );
    }
    match response_builder.body(axum::body::Body::from_stream(body_stream)) {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[vod-proxy] failed to build local file response: {error}");
            (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
        }
    }
}

fn cue_dedupe_key(cue: &ScannedCue) -> (u64, u64, u64) {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    cue.text.hash(&mut hasher);
    (cue.track_number, cue.start_ms, hasher.finish())
}

fn emit_cues(session: &Arc<VodSession>, events: &Arc<dyn VodProxyEvents>, cues: Vec<ScannedCue>) {
    if cues.is_empty() {
        return;
    }
    let fresh: Vec<ScannedCue> = {
        let mut dedupe = session
            .dedupe
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cues.into_iter()
            .filter(|cue| dedupe.insert(cue_dedupe_key(cue)))
            .collect()
    };
    if fresh.is_empty() {
        return;
    }

    let mut by_track: HashMap<u64, Vec<Value>> = HashMap::new();
    for cue in fresh {
        by_track.entry(cue.track_number).or_default().push(json!({
            "startMs": cue.start_ms,
            "endMs": cue.end_ms,
            "text": cue.text,
        }));
    }
    for (track_number, cue_values) in by_track {
        events.cues(json!({
            "sessionId": session.session_id,
            "trackNumber": track_number,
            "cues": cue_values,
        }));
    }
}

// ---------------------------------------------------------------------------
// Head parse
// ---------------------------------------------------------------------------

fn subtitle_codec_for(codec_id: &str) -> Option<SubtitleCodec> {
    match codec_id {
        "S_TEXT/UTF8" => Some(SubtitleCodec::Srt),
        "S_TEXT/ASS" | "S_TEXT/SSA" => Some(SubtitleCodec::Ass),
        _ => None,
    }
}

// Announcing a codec the scanner can't decode yields a selectable but permanently dead menu entry.
fn subtitle_tracks_payload(head_info: &HeadInfo) -> Vec<Value> {
    head_info
        .tracks
        .iter()
        .filter(|track| track.track_type == SUBTITLE_TRACK_TYPE && subtitle_codec_for(&track.codec).is_some())
        .map(|track| {
            json!({
                "number": track.number,
                "codec": track.codec,
                "language": track.language,
                "name": track.name,
            })
        })
        .collect()
}

// Unlike subtitles, no codec filter; frontend picks copy vs transcode.
fn audio_tracks_payload(head_info: &HeadInfo) -> Vec<Value> {
    head_info
        .tracks
        .iter()
        .filter(|track| track.track_type == AUDIO_TRACK_TYPE)
        .map(|track| {
            json!({
                "number": track.number,
                "codec": track.codec,
                "language": track.language,
                "name": track.name,
                "default": track.default,
            })
        })
        .collect()
}

async fn fetch_range(
    client: &reqwest::Client,
    session: &VodSession,
    start: u64,
    end_inclusive: u64,
) -> Option<Vec<u8>> {
    match &session.source {
        VodSource::Upstream(upstream_url) => {
            fetch_upstream_range(
                client,
                upstream_url,
                session.user_agent.as_deref(),
                start,
                end_inclusive,
            )
            .await
        }
        VodSource::LocalFile(path) => fetch_local_range(path, start, end_inclusive).await,
    }
}

async fn fetch_upstream_range(
    client: &reqwest::Client,
    upstream_url: &str,
    user_agent: Option<&str>,
    start: u64,
    end_inclusive: u64,
) -> Option<Vec<u8>> {
    let mut request = client
        .get(upstream_url)
        .header(reqwest::header::RANGE, format!("bytes={start}-{end_inclusive}"));
    if let Some(ua) = user_agent {
        request = request.header(reqwest::header::USER_AGENT, ua);
    }
    let response = request.send().await.ok()?;
    // A Range-ignoring server answers 200 with the entire multi-GB file; only 206 bounds the body.
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return None;
    }

    let cap = (end_inclusive - start) as usize + 1 + HEAD_PROBE_SLACK;
    let mut buffer = Vec::new();
    let mut stream = response.bytes_stream();
    while buffer.len() < cap {
        match stream.next().await {
            Some(Ok(chunk)) => buffer.extend_from_slice(&chunk),
            _ => break,
        }
    }
    buffer.truncate(cap);
    Some(buffer)
}

// The exact byte count is already known on disk, so no HEAD_PROBE_SLACK is needed here.
async fn fetch_local_range(path: &FsPath, start: u64, end_inclusive: u64) -> Option<Vec<u8>> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let file_len = file.metadata().await.ok()?.len();
    if start >= file_len {
        return None;
    }
    let clamped_end = end_inclusive.min(file_len - 1);
    file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    let want = (clamped_end - start) as usize + 1;
    let mut buffer = vec![0u8; want];
    file.read_exact(&mut buffer).await.ok()?;
    Some(buffer)
}

async fn fetch_and_parse_head(client: &reqwest::Client, session: &VodSession) -> Option<HeadInfo> {
    let first = fetch_range(client, session, 0, HEAD_PROBE_SMALL_END).await?;
    if let Some(head) = matroska::parse_head(&first) {
        return Some(head);
    }
    // Only fetch the incremental range; `first` already covers 0..=HEAD_PROBE_SMALL_END.
    let rest = fetch_range(client, session, HEAD_PROBE_SMALL_END + 1, HEAD_PROBE_LARGE_END).await?;
    let mut extended = first;
    extended.extend_from_slice(&rest);
    matroska::parse_head(&extended)
}

fn spawn_head_parse(events: Arc<dyn VodProxyEvents>, session: Arc<VodSession>, client: reqwest::Client) {
    tauri::async_runtime::spawn(async move {
        let head = fetch_and_parse_head(&client, &session).await;

        let tracks_payload: Vec<Value> = head
            .as_ref()
            .map(subtitle_tracks_payload)
            .unwrap_or_default();
        let audio_tracks_json: Vec<Value> = head
            .as_ref()
            .map(audio_tracks_payload)
            .unwrap_or_default();

        let subtitle_tracks: HashMap<u64, SubtitleCodec> = head
            .as_ref()
            .map(|head_info| {
                head_info
                    .tracks
                    .iter()
                    .filter(|track| track.track_type == SUBTITLE_TRACK_TYPE)
                    .filter_map(|track| {
                        subtitle_codec_for(&track.codec).map(|codec| (track.number, codec))
                    })
                    .collect()
            })
            .unwrap_or_default();

        let head_context = head.map(|head_info| HeadContext {
            timestamp_scale_ns: head_info.timestamp_scale_ns,
            subtitle_tracks,
        });
        let _ = session.head.set(head_context);

        events.tracks(json!({
            "sessionId": session.session_id,
            "tracks": tracks_payload,
            "audioTracks": audio_tracks_json,
        }));
    });
}

// ---------------------------------------------------------------------------
// Live integration test (opt-in, real provider)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matroska::test_fixtures::*;
    use crate::matroska::MkvTrack;
    use std::sync::Mutex as StdMutex;

    fn test_session(head: OnceLock<Option<HeadContext>>) -> Arc<VodSession> {
        Arc::new(VodSession {
            session_id: "sess".to_string(),
            token: "sess".to_string(),
            source: VodSource::Upstream("https://example.test/movie.mkv".to_string()),
            user_agent: None,
            head,
            dedupe: Mutex::new(HashSet::new()),
            created_at: std::time::Instant::now(),
        })
    }

    #[test]
    fn parse_single_range_handles_bounded_open_ended_and_suffix_forms() {
        assert_eq!(parse_single_range("bytes=0-499", 1000), RangeOutcome::Satisfiable(0, 499));
        assert_eq!(parse_single_range("bytes=500-", 1000), RangeOutcome::Satisfiable(500, 999));
        assert_eq!(parse_single_range("bytes=-200", 1000), RangeOutcome::Satisfiable(800, 999));
    }

    #[test]
    fn parse_single_range_clamps_an_end_past_the_file() {
        assert_eq!(parse_single_range("bytes=900-2000", 1000), RangeOutcome::Satisfiable(900, 999));
    }

    #[test]
    fn parse_single_range_rejects_multi_range_and_out_of_bounds_start_as_unsatisfiable() {
        assert_eq!(parse_single_range("bytes=0-99,200-299", 1000), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_single_range("bytes=1000-1100", 1000), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_single_range("bytes=0-499", 0), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn parse_single_range_falls_back_to_no_range_on_malformed_input() {
        assert_eq!(parse_single_range("not-a-range", 1000), RangeOutcome::NoRange);
        assert_eq!(parse_single_range("bytes=100-50", 1000), RangeOutcome::NoRange, "end before start");
        assert_eq!(parse_single_range("bytes=-0", 1000), RangeOutcome::NoRange, "zero-length suffix");
    }

    #[test]
    fn extract_extension_from_path_includes_the_leading_dot() {
        assert_eq!(extract_extension_from_path(FsPath::new("/tmp/movie.mkv")), ".mkv");
        assert_eq!(extract_extension_from_path(FsPath::new("/tmp/movie")), "");
    }

    #[test]
    fn is_local_file_path_allowed_requires_both_root_and_extension_to_match() {
        let roots = vec![PathBuf::from("/home/user/Downloads")];
        assert!(is_local_file_path_allowed(
            FsPath::new("/home/user/Downloads/movie.mkv"),
            &roots
        ));
        assert!(!is_local_file_path_allowed(
            FsPath::new("/etc/passwd"),
            &roots
        ), "outside every allowed root");
        assert!(!is_local_file_path_allowed(
            FsPath::new("/home/user/Downloads/notes.txt"),
            &roots
        ), "extension not in the allowed media list");
    }

    #[tokio::test]
    async fn serve_local_file_returns_a_206_for_a_ranged_request() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("xt-vod-proxy-test-{}.bin", generate_token()));
        tokio::fs::write(&path, b"0123456789").await.unwrap();

        let session = test_session(OnceLock::new());
        let collector = CollectorEvents::new();
        let events: Arc<dyn VodProxyEvents> = collector.clone();
        let range = HeaderValue::from_static("bytes=2-5");
        let response = serve_local_file(session, events, &path, Some(&range)).await;

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(axum::http::header::CONTENT_RANGE).unwrap(),
            "bytes 2-5/10"
        );
        assert_eq!(response.headers().get(axum::http::header::CONTENT_LENGTH).unwrap(), "4");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"2345");

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn serve_local_file_returns_a_416_for_a_range_past_eof() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("xt-vod-proxy-test-{}.bin", generate_token()));
        tokio::fs::write(&path, b"0123456789").await.unwrap();

        let session = test_session(OnceLock::new());
        let collector = CollectorEvents::new();
        let events: Arc<dyn VodProxyEvents> = collector.clone();
        let range = HeaderValue::from_static("bytes=1000-1100");
        let response = serve_local_file(session, events, &path, Some(&range)).await;

        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers().get(axum::http::header::CONTENT_RANGE).unwrap(),
            "bytes */10"
        );

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn serve_local_file_returns_a_suffix_range() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("xt-vod-proxy-test-{}.bin", generate_token()));
        tokio::fs::write(&path, b"0123456789").await.unwrap();

        let session = test_session(OnceLock::new());
        let collector = CollectorEvents::new();
        let events: Arc<dyn VodProxyEvents> = collector.clone();
        let range = HeaderValue::from_static("bytes=-3");
        let response = serve_local_file(session, events, &path, Some(&range)).await;

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(axum::http::header::CONTENT_RANGE).unwrap(),
            "bytes 7-9/10"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"789");

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn serve_local_file_returns_an_empty_200_for_a_zero_byte_file() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("xt-vod-proxy-test-{}.bin", generate_token()));
        tokio::fs::write(&path, b"").await.unwrap();

        let session = test_session(OnceLock::new());
        let collector = CollectorEvents::new();
        let events: Arc<dyn VodProxyEvents> = collector.clone();
        let response = serve_local_file(session, events, &path, None).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(axum::http::header::CONTENT_LENGTH).unwrap(), "0");
        assert!(response.headers().get(axum::http::header::CONTENT_RANGE).is_none());

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(body.is_empty());

        let _ = tokio::fs::remove_file(&path).await;
    }

    #[test]
    fn evict_oldest_if_over_capacity_keeps_at_most_max_sessions() {
        let mut sessions: HashMap<String, Arc<VodSession>> = HashMap::new();
        let base = std::time::Instant::now();
        let total = MAX_SESSIONS + 3;
        for i in 0..total {
            let mut session = test_session(OnceLock::new());
            let age = std::time::Duration::from_secs((total - i) as u64);
            Arc::get_mut(&mut session).unwrap().created_at = base.checked_sub(age).unwrap();
            sessions.insert(format!("token-{i}"), session);
            evict_oldest_if_over_capacity(&mut sessions);
        }
        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert!(!sessions.contains_key("token-0"), "oldest sessions must be evicted first");
        assert!(sessions.contains_key(&format!("token-{}", total - 1)));
    }

    #[test]
    fn subtitle_tracks_payload_excludes_tracks_without_a_decodable_codec() {
        let head_info = HeadInfo {
            timestamp_scale_ns: 1_000_000,
            tracks: vec![
                MkvTrack {
                    number: 1,
                    track_type: SUBTITLE_TRACK_TYPE,
                    codec: "S_TEXT/UTF8".to_string(),
                    language: Some("eng".to_string()),
                    name: None,
                    default: true,
                },
                MkvTrack {
                    number: 2,
                    track_type: SUBTITLE_TRACK_TYPE,
                    codec: "S_HDMV/PGS".to_string(),
                    language: Some("fre".to_string()),
                    name: None,
                    default: false,
                },
                MkvTrack {
                    number: 3,
                    track_type: 1, // video, not a subtitle track at all
                    codec: "V_MPEG4/ISO/AVC".to_string(),
                    language: None,
                    name: None,
                    default: true,
                },
            ],
        };

        let payload = subtitle_tracks_payload(&head_info);
        assert_eq!(payload.len(), 1, "PGS and video tracks must not be announced");
        assert_eq!(payload[0]["number"], 1);
    }

    #[test]
    fn audio_tracks_payload_includes_every_audio_track_regardless_of_codec() {
        let head_info = HeadInfo {
            timestamp_scale_ns: 1_000_000,
            tracks: vec![
                MkvTrack {
                    number: 1,
                    track_type: 1,
                    codec: "V_MPEG4/ISO/AVC".to_string(),
                    language: None,
                    name: None,
                    default: true,
                },
                MkvTrack {
                    number: 2,
                    track_type: AUDIO_TRACK_TYPE,
                    codec: "A_AC3".to_string(),
                    language: Some("eng".to_string()),
                    name: Some("Stereo".to_string()),
                    default: true,
                },
                MkvTrack {
                    number: 3,
                    track_type: AUDIO_TRACK_TYPE,
                    codec: "A_DTS".to_string(),
                    language: Some("fre".to_string()),
                    name: None,
                    default: false,
                },
            ],
        };

        let payload = audio_tracks_payload(&head_info);
        assert_eq!(payload.len(), 2, "both audio tracks must be announced regardless of codec");
        assert_eq!(payload[0]["number"], 2);
        assert_eq!(payload[0]["codec"], "A_AC3");
        assert_eq!(payload[0]["default"], true);
        assert_eq!(payload[1]["number"], 3);
        assert_eq!(payload[1]["codec"], "A_DTS");
        assert_eq!(payload[1]["default"], false);
    }

    #[test]
    fn tee_state_replays_buffered_prefix_once_head_resolves_after_streaming_started() {
        // The bytes=0- request's first chunks usually win the race against spawn_head_parse.
        let clusters = cluster(1000, &[block_group(2, 500, 0, b"Hello World", Some(2000))]);
        let session = test_session(OnceLock::new());
        let mut tee_state = TeeState::new(session.clone());
        assert!(tee_state.prefix.is_some(), "must start in buffering mode");

        let (first_half, second_half) = clusters.split_at(clusters.len() / 2);
        assert!(tee_state.process(first_half).is_empty());
        assert!(tee_state.process(second_half).is_empty());

        session
            .head
            .set(Some(HeadContext {
                timestamp_scale_ns: 1_000_000,
                subtitle_tracks: subtitle_map(&[(2, SubtitleCodec::Srt)]),
            }))
            .map_err(|_| "head already set")
            .unwrap();

        // The next chunk triggers scanner attach and replay of the buffered prefix.
        let cues = tee_state.process(&[]);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].track_number, 2);
        assert_eq!(cues[0].text, "Hello World");
        assert_eq!(cues[0].start_ms, 1500);
        assert_eq!(cues[0].end_ms, 3500);
        assert!(tee_state.prefix.is_none(), "prefix must be consumed once replayed");
    }

    #[test]
    fn tee_state_keeps_tee_active_and_continues_live_after_prefix_replay() {
        let clusters = cluster(1000, &[block_group(2, 500, 0, b"Hello World", Some(2000))]);
        let second_cluster = cluster(5000, &[block_group(2, 0, 0, b"Second cue", None)]);
        let session = test_session(OnceLock::new());
        let mut tee_state = TeeState::new(session.clone());

        assert!(tee_state.process(&clusters).is_empty());
        session
            .head
            .set(Some(HeadContext {
                timestamp_scale_ns: 1_000_000,
                subtitle_tracks: subtitle_map(&[(2, SubtitleCodec::Srt)]),
            }))
            .unwrap();

        let first_batch = tee_state.process(&second_cluster);
        assert_eq!(first_batch.len(), 2, "prefix cue + live cluster cue");
        assert_eq!(first_batch[0].text, "Hello World");
        assert_eq!(first_batch[1].text, "Second cue");
        assert_eq!(first_batch[1].start_ms, 5000);
    }

    #[test]
    fn tee_state_drops_oversized_prefix_instead_of_growing_unbounded() {
        let session = test_session(OnceLock::new());
        let mut tee_state = TeeState::new(session);
        let oversized_chunk = vec![0u8; TEE_PREFIX_CAP + 1];
        assert!(tee_state.process(&oversized_chunk).is_empty());
        assert!(
            tee_state.prefix.is_none(),
            "prefix must be dropped once it exceeds the cap"
        );
    }

    #[test]
    fn tee_state_skips_tee_when_head_already_resolved_with_no_subtitle_tracks() {
        let head = OnceLock::new();
        head.set(Some(HeadContext {
            timestamp_scale_ns: 1_000_000,
            subtitle_tracks: HashMap::new(),
        }))
        .unwrap();
        let session = test_session(head);
        let mut tee_state = TeeState::new(session);
        assert!(tee_state.disabled);
        assert!(tee_state.process(b"anything").is_empty());
    }

    #[test]
    fn tee_state_builds_scanner_up_front_when_head_already_resolved() {
        let clusters = cluster(2000, &[block_group(4, 0, 0, b"Immediate cue", None)]);
        let head = OnceLock::new();
        head.set(Some(HeadContext {
            timestamp_scale_ns: 1_000_000,
            subtitle_tracks: subtitle_map(&[(4, SubtitleCodec::Srt)]),
        }))
        .unwrap();
        let session = test_session(head);
        let mut tee_state = TeeState::new(session);
        assert!(tee_state.scanner.is_some());
        assert!(tee_state.prefix.is_none());

        let cues = tee_state.process(&clusters);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Immediate cue");
    }

    struct CollectorEvents {
        tracks: StdMutex<Vec<Value>>,
        cues: StdMutex<Vec<Value>>,
    }

    impl CollectorEvents {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                tracks: StdMutex::new(Vec::new()),
                cues: StdMutex::new(Vec::new()),
            })
        }
    }

    impl VodProxyEvents for CollectorEvents {
        fn tracks(&self, payload: Value) {
            self.tracks.lock().unwrap().push(payload);
        }
        fn cues(&self, payload: Value) {
            self.cues.lock().unwrap().push(payload);
        }
    }

    // Bytes re-read through the tee (e.g. audio remux) must not re-emit cues.
    #[test]
    fn emit_cues_never_re_emits_cues_from_bytes_that_pass_through_the_tee_twice() {
        let clusters = cluster(1000, &[block_group(2, 500, 0, b"Hello World", Some(2000))]);
        let head = OnceLock::new();
        head.set(Some(HeadContext {
            timestamp_scale_ns: 1_000_000,
            subtitle_tracks: subtitle_map(&[(2, SubtitleCodec::Srt)]),
        }))
        .unwrap();
        let session = test_session(head);
        let collector = CollectorEvents::new();
        let events: Arc<dyn VodProxyEvents> = collector.clone();

        let mut first_request = TeeState::new(session.clone());
        let first_cues = first_request.process(&clusters);
        assert_eq!(first_cues.len(), 1);
        emit_cues(&session, &events, first_cues);
        assert_eq!(collector.cues.lock().unwrap().len(), 1);

        let mut second_request = TeeState::new(session.clone());
        let second_cues = second_request.process(&clusters);
        assert_eq!(second_cues.len(), 1, "the scanner itself is stateless across requests");
        emit_cues(&session, &events, second_cues);
        assert_eq!(
            collector.cues.lock().unwrap().len(),
            1,
            "already-emitted cues must not reach the frontend a second time"
        );
    }

    /// Needs `XT_VOD_PROXY_TEST_URL` pointing at a real MKV with embedded subtitles; skipped otherwise.
    #[tokio::test]
    #[ignore]
    async fn live_provider_tee() {
        let Ok(url) = std::env::var("XT_VOD_PROXY_TEST_URL") else {
            return;
        };

        let collector = CollectorEvents::new();
        let events: Arc<dyn VodProxyEvents> = collector.clone();
        let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));
        let (port, _shutdown, client) = start_server(events.clone(), sessions.clone())
            .await
            .expect("server must start");

        let token = generate_token();
        let session = Arc::new(VodSession {
            session_id: token.clone(),
            token: token.clone(),
            source: VodSource::Upstream(url),
            user_agent: None,
            head: OnceLock::new(),
            dedupe: Mutex::new(HashSet::new()),
            created_at: std::time::Instant::now(),
        });
        sessions
            .lock()
            .unwrap()
            .insert(token.clone(), session.clone());
        spawn_head_parse(events.clone(), session.clone(), client.clone());

        // Give the head-parse task a moment to land before the first request.
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let proxy_url = format!("http://127.0.0.1:{port}/{token}/stream.mkv");

        let first = client
            .get(&proxy_url)
            .header(reqwest::header::RANGE, "bytes=0-")
            .send()
            .await
            .expect("first request must succeed");
        let mut first_stream = first.bytes_stream();
        let mut read_bytes: usize = 0;
        while read_bytes < 8 * 1024 * 1024 {
            match first_stream.next().await {
                Some(Ok(chunk)) => read_bytes += chunk.len(),
                _ => break,
            }
        }
        drop(first_stream);

        let second = client
            .get(&proxy_url)
            .header(reqwest::header::RANGE, "bytes=3000000000-")
            .send()
            .await
            .expect("second request must succeed");
        let mut second_stream = second.bytes_stream();
        let mut read_bytes_two: usize = 0;
        while read_bytes_two < 8 * 1024 * 1024 {
            match second_stream.next().await {
                Some(Ok(chunk)) => read_bytes_two += chunk.len(),
                _ => break,
            }
        }
        drop(second_stream);

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let tracks = collector.tracks.lock().unwrap();
        assert_eq!(tracks.len(), 1, "tracks event must fire exactly once");
        let subtitle_track_count = tracks[0]["tracks"]
            .as_array()
            .map(|list| list.len())
            .unwrap_or(0);
        assert!(
            subtitle_track_count > 0,
            "expected at least one subtitle track"
        );

        let cues = collector.cues.lock().unwrap();
        assert!(!cues.is_empty(), "expected at least one cues event");
    }
}
