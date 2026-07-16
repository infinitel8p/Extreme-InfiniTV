// Local HTTP tee-proxy for MKV VOD playback (desktop only): forwards Range requests to the provider 1:1
// while feeding the passing bytes through `matroska::ClusterScanner` to pull subtitle cues, reported as
// `xt:vodproxy-tracks` / `xt:vodproxy-cues` events. Core takes `Arc<dyn VodProxyEvents>` so it's testable without a Tauri AppHandle.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::matroska::{self, ClusterScanner, HeadInfo, ScannedCue, SubtitleCodec};

const TRACKS_EVENT: &str = "xt:vodproxy-tracks";
const CUES_EVENT: &str = "xt:vodproxy-cues";
const SUBTITLE_TRACK_TYPE: u8 = 0x11;
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

struct VodSession {
    session_id: String,
    #[allow(dead_code)]
    token: String,
    upstream_url: String,
    user_agent: Option<String>,
    head: OnceLock<Option<HeadContext>>,
    dedupe: Mutex<HashSet<(u64, u64, u64)>>,
    created_at: std::time::Instant,
}

// A user cannot realistically have more than a handful of concurrent VOD
// players; capping the session table bounds leaks from navigation races
// (an unload mid-register orphans a session forever otherwise).
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
        upstream_url: url,
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

    let mut upstream_request = state.client.get(&session.upstream_url);
    if let Some(range) = headers.get(axum::http::header::RANGE) {
        if let Ok(value) = range.to_str() {
            upstream_request = upstream_request.header(reqwest::header::RANGE, value);
        }
    }
    if let Some(ua) = &session.user_agent {
        upstream_request = upstream_request.header(reqwest::header::USER_AGENT, ua.clone());
    }

    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[vod-proxy] upstream request failed: {error}");
            return (StatusCode::BAD_GATEWAY, "upstream request failed").into_response();
        }
    };

    let status = upstream_response.status();
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

/// Per-request tee state. A request that starts before the head parse lands
/// (almost always true for the very first `bytes=0-` request, since Chromium
/// holds that connection open for the whole session) buffers passing chunks
/// into a capped prefix instead of dropping the tee outright; once the head
/// resolves, the prefix is fed to a freshly built scanner before the live
/// chunk, so cues embedded in the stream's opening clusters aren't lost.
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

    /// Feeds a chunk through the (possibly not-yet-attached) scanner, returning
    /// any cues produced. Guarded against parser panics with a sticky disable.
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

fn tee_stream<S>(
    upstream: S,
    mut tee_state: TeeState,
    session: Arc<VodSession>,
    events: Arc<dyn VodProxyEvents>,
) -> impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static
where
    S: futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    upstream.map(move |item| {
        if let Ok(chunk) = &item {
            let cues = tee_state.process(chunk);
            emit_cues(&session, &events, cues);
        }
        item
    })
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

// Only announce tracks the scanner can actually decode: PGS/VobSub/WebVTT
// etc. would otherwise show up as selectable but permanently dead menu entries.
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

async fn fetch_range(
    client: &reqwest::Client,
    session: &VodSession,
    start: u64,
    end_inclusive: u64,
) -> Option<Vec<u8>> {
    let mut request = client
        .get(&session.upstream_url)
        .header(reqwest::header::RANGE, format!("bytes={start}-{end_inclusive}"));
    if let Some(ua) = &session.user_agent {
        request = request.header(reqwest::header::USER_AGENT, ua.clone());
    }
    let response = request.send().await.ok()?;
    // A Range-ignoring server answers 200 with the entire (possibly multi-GB)
    // file; only a genuine 206 guarantees the body is bounded to what we asked for.
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
            upstream_url: "https://example.test/movie.mkv".to_string(),
            user_agent: None,
            head,
            dedupe: Mutex::new(HashSet::new()),
            created_at: std::time::Instant::now(),
        })
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
                },
                MkvTrack {
                    number: 2,
                    track_type: SUBTITLE_TRACK_TYPE,
                    codec: "S_HDMV/PGS".to_string(),
                    language: Some("fre".to_string()),
                    name: None,
                },
                MkvTrack {
                    number: 3,
                    track_type: 1, // video, not a subtitle track at all
                    codec: "V_MPEG4/ISO/AVC".to_string(),
                    language: None,
                    name: None,
                },
            ],
        };

        let payload = subtitle_tracks_payload(&head_info);
        assert_eq!(payload.len(), 1, "PGS and video tracks must not be announced");
        assert_eq!(payload[0]["number"], 1);
    }

    #[test]
    fn tee_state_replays_buffered_prefix_once_head_resolves_after_streaming_started() {
        // The bytes=0- request's first chunks race spawn_head_parse and
        // usually win; TeeState must not drop the cues buried in them.
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

        // The next chunk (here, an otherwise-empty tail) triggers scanner
        // attach and replay of everything buffered before the head landed.
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

    /// Registers a real provider URL against the proxy core (no AppHandle
    /// involved) and simulates a Chromium-style playback pattern: an
    /// open-ended range read partway then dropped, followed by a later seek.
    /// Requires `XT_VOD_PROXY_TEST_URL` pointing at a real MKV with embedded
    /// subtitles; skipped otherwise. Run with:
    /// `XT_VOD_PROXY_TEST_URL=... cargo test --features "" -- --ignored live_provider_tee`
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
            upstream_url: url,
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
