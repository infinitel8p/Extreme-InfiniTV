// Desktop-only ffmpeg remux proxy for switching a VOD's audio track.

use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::Stream;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::external_player;
use crate::http_range::{range_request_start, ranged_response_is_corrupted};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ERROR_EVENT: &str = "xt:vodaudio-error";
const DETECT_TIMEOUT_MS: u64 = 2000;
const OUTPUT_CHUNK_SIZE: usize = 64 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 256;
const STDERR_RING_CAPACITY: usize = 10;
const STARTUP_SILENCE_TIMEOUT: Duration = Duration::from_secs(10);
const STDOUT_STALL_TIMEOUT: Duration = Duration::from_secs(20);
// Fires only when no client is attached; a connected-but-slow client gets CLIENT_BACKPRESSURE_TIMEOUT instead.
const CLIENT_RECONNECT_GRACE: Duration = Duration::from_secs(120);
// Backstop for a client that stays connected but stops reading; generous enough to survive a long pause.
const CLIENT_BACKPRESSURE_TIMEOUT: Duration = Duration::from_secs(45 * 60);
const STALL_CHECK_INTERVAL: Duration = Duration::from_secs(1);
// A fresh -reconnect attempt gets this long to deliver a byte before the cut is final;
// comfortably above -reconnect_delay_max so a healing reconnect doesn't lose the race.
const UPSTREAM_EOF_GRACE: Duration = Duration::from_secs(15);

// --- State ---

type ActiveSlot = Arc<Mutex<Option<Arc<VodAudioSession>>>>;
// Keyed by id so the forward route and unregister can find a session directly.
type SessionMap = Arc<Mutex<HashMap<String, Arc<VodAudioSession>>>>;

#[derive(Debug, Clone, PartialEq)]
struct FfmpegProbe {
    path: String,
}

// Path-keyed, process-lifetime cache: a binary swapped in place serves a stale verdict.
struct CachedProbeResolution {
    custom_path: Option<String>,
    // None = cached "no capable ffmpeg found".
    probe: Option<FfmpegProbe>,
    // True when a supplied custom path failed and a fallback candidate was used instead.
    custom_path_ignored: bool,
}

struct ServerHandle {
    port: u16,
    #[allow(dead_code)]
    shutdown: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct VodAudioProxyState {
    server: Mutex<Option<ServerHandle>>,
    active: ActiveSlot,
    sessions: SessionMap,
    probe: Mutex<Option<CachedProbeResolution>>,
    // Serializes teardown -> spawn -> activate so a lost race can't orphan ffmpeg.
    register_lock: tokio::sync::Mutex<()>,
}

struct VodAudioSession {
    session_id: String,
    upstream_url: String,
    user_agent: Option<String>,
    authorization: Option<String>,
    torn_down: AtomicBool,
    // Client-timeout marker; makes the watchdog emit the error.
    client_gone: AtomicBool,
    // New GET replaces the previous client's sender.
    current_client: Mutex<Option<mpsc::Sender<Bytes>>>,
    // Wakes stdout delivery on client connect or replace.
    client_notify: Notify,
    stderr_tail: Mutex<VecDeque<String>>,
    // Held only until run_watchdog takes ownership.
    child: tokio::sync::Mutex<Option<Child>>,
    // Wakes teardown without touching the child mutex.
    kill_notify: Notify,
    // Self-abort here is safe: abort takes effect only at the next await.
    io_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    // Separate from `io_tasks` so the watchdog never aborts its own handle.
    watchdog_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    // Reset on every stdout read; compared against STDOUT_STALL_TIMEOUT.
    last_activity: Mutex<Instant>,
    // True while blocked on send, so a slow consumer isn't read as a stall.
    blocked_on_send: AtomicBool,
    // Set when teardown came from CLIENT_BACKPRESSURE_TIMEOUT rather than a vanished client.
    backpressure_timed_out: AtomicBool,
    // Truncated forward body; a later forward's first byte clears it (reconnect healed).
    upstream_eof: Mutex<Option<UpstreamEofRecord>>,
}

struct UpstreamEofRecord {
    at: Instant,
    detail: String,
}

// --- Commands ---

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VodAudioRemuxAvailability {
    pub available: bool,
    pub custom_path_ignored: bool,
}

#[tauri::command]
pub async fn vod_audio_remux_available(
    app: AppHandle,
    ffmpeg_path: Option<String>,
) -> VodAudioRemuxAvailability {
    let state = app.state::<VodAudioProxyState>();
    let (probe, custom_path_ignored) = ensure_probed(&state, ffmpeg_path).await;
    VodAudioRemuxAvailability {
        available: probe.is_some(),
        custom_path_ignored,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterVodAudioRemuxResponse {
    pub session_id: String,
    pub playback_url: String,
}

#[tauri::command]
pub async fn register_vod_audio_remux(
    app: AppHandle,
    state: tauri::State<'_, VodAudioProxyState>,
    url: String,
    user_agent: Option<String>,
    authorization: Option<String>,
    audio_stream_index: u32,
    start_seconds: f64,
    transcode_audio: bool,
    ffmpeg_path: Option<String>,
) -> Result<RegisterVodAudioRemuxResponse, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("OTHER:{e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("OTHER:url must be http or https".to_string());
    }

    // A loopback tee (e.g. vod_proxy) already applies user_agent/authorization.
    let is_loopback = is_loopback_http(&url);

    let _register_guard = state.register_lock.lock().await;

    // One live session at a time; tear down before starting the next.
    teardown_active_session(&state).await;

    let resolved_ffmpeg_path = match ensure_probed(&state, ffmpeg_path).await {
        (Some(probe), _) => probe.path,
        (None, _) => {
            return Err(
                "NOT_FOUND:ffmpeg with Matroska/MOV demuxers and H.264/HEVC decoders not found"
                    .to_string(),
            )
        }
    };

    let port = ensure_server_started(&state).await?;
    let token = generate_token();

    let session = Arc::new(VodAudioSession {
        session_id: token.clone(),
        upstream_url: url.clone(),
        user_agent: if is_loopback { None } else { user_agent },
        authorization: if is_loopback { None } else { authorization },
        torn_down: AtomicBool::new(false),
        client_gone: AtomicBool::new(false),
        current_client: Mutex::new(None),
        client_notify: Notify::new(),
        stderr_tail: Mutex::new(VecDeque::new()),
        child: tokio::sync::Mutex::new(None),
        kill_notify: Notify::new(),
        io_tasks: Mutex::new(Vec::new()),
        watchdog_task: Mutex::new(None),
        last_activity: Mutex::new(Instant::now()),
        blocked_on_send: AtomicBool::new(false),
        backpressure_timed_out: AtomicBool::new(false),
        upstream_eof: Mutex::new(None),
    });

    // Inserted before spawn so ffmpeg's request can resolve this token.
    insert_session(&state, session.clone());

    let input_url = if is_loopback {
        url
    } else {
        format!("http://127.0.0.1:{port}/forward/{token}/stream")
    };
    let ffmpeg_args = build_ffmpeg_args(&input_url, audio_stream_index, start_seconds, transcode_audio);

    let mut command = TokioCommand::new(&resolved_ffmpeg_path);
    command
        .args(&ffmpeg_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            remove_session(&state, &token);
            return Err(format!("OTHER:failed to spawn ffmpeg: {e}"));
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.start_kill();
            remove_session(&state, &token);
            return Err("OTHER:ffmpeg stdout unavailable".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.start_kill();
            remove_session(&state, &token);
            return Err("OTHER:ffmpeg stderr unavailable".to_string());
        }
    };

    {
        let mut child_guard = session.child.lock().await;
        *child_guard = Some(child);
    }

    let (first_byte_tx, first_byte_rx) = oneshot::channel();
    let output_handle = spawn_output_task(session.clone(), stdout, first_byte_tx);
    let stderr_handle = spawn_stderr_task(session.clone(), stderr);
    {
        let mut tasks = session
            .io_tasks
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        tasks.push(output_handle);
        tasks.push(stderr_handle);
    }

    let watchdog_handle =
        tauri::async_runtime::spawn(run_watchdog(app.clone(), session.clone(), first_byte_rx));
    {
        let mut watchdog = session
            .watchdog_task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *watchdog = Some(watchdog_handle);
    }

    set_active_session(&state, session);

    Ok(RegisterVodAudioRemuxResponse {
        session_id: token.clone(),
        playback_url: format!("http://127.0.0.1:{port}/live/{token}"),
    })
}

#[tauri::command]
pub async fn unregister_vod_audio_remux(
    state: tauri::State<'_, VodAudioProxyState>,
    session_id: String,
) -> Result<(), String> {
    let matched = {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.remove(&session_id)
    };
    if let Some(session) = matched {
        {
            let mut active = state
                .active
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if active.as_ref().is_some_and(|current| current.session_id == session_id) {
                *active = None;
            }
        }
        teardown_session(&session).await;
    }
    Ok(())
}

fn insert_session(state: &VodAudioProxyState, session: Arc<VodAudioSession>) {
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    sessions.insert(session.session_id.clone(), session);
}

fn set_active_session(state: &VodAudioProxyState, session: Arc<VodAudioSession>) {
    let mut active = state
        .active
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *active = Some(session);
}

fn remove_session(state: &VodAudioProxyState, token: &str) {
    let mut sessions = state
        .sessions
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    sessions.remove(token);
}

async fn teardown_active_session(state: &VodAudioProxyState) {
    let previous = {
        let mut active = state
            .active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        active.take()
    };
    if let Some(session) = previous {
        {
            let mut sessions = state
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            sessions.remove(&session.session_id);
        }
        teardown_session(&session).await;
    }
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// Matches plain http to 127.0.0.1/localhost on any port (e.g. vod_proxy's tee).
fn is_loopback_http(url: &str) -> bool {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"))
}

// --- ffmpeg argv (pure, unit-tested) ---

// -reconnect* are http-protocol options; other inputs must not receive them.
fn http_input_reconnect_args(input_url: &str) -> Vec<String> {
    let is_http = tauri::Url::parse(input_url)
        .map(|parsed| parsed.scheme() == "http" || parsed.scheme() == "https")
        .unwrap_or(false);
    if !is_http {
        return Vec::new();
    }
    [
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn build_ffmpeg_args(input_url: &str, audio_stream_index: u32, start_seconds: f64, transcode_audio: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];
    // -noaccurate_seek keeps audio pre-roll aligned with the copied video.
    if start_seconds > 0.1 {
        args.push("-noaccurate_seek".to_string());
        args.push("-ss".to_string());
        args.push(format!("{start_seconds}"));
    }
    args.extend(http_input_reconnect_args(input_url));
    // Paces ffmpeg's reads to 1.5x realtime so the WebView's MSE buffer never overflows.
    args.push("-readrate".to_string());
    args.push("1.5".to_string());
    args.push("-readrate_initial_burst".to_string());
    args.push("30".to_string());
    args.push("-i".to_string());
    args.push(input_url.to_string());
    args.push("-map".to_string());
    args.push("0:v:0".to_string());
    args.push("-map".to_string());
    args.push(format!("0:a:{audio_stream_index}?"));
    args.push("-c:v".to_string());
    args.push("copy".to_string());
    if transcode_audio {
        args.extend(
            [
                "-c:a",
                "aac",
                "-af",
                "aresample=async=1",
                "-ac",
                "2",
                "-b:a",
                "192k",
            ]
            .into_iter()
            .map(str::to_string),
        );
    } else {
        args.push("-c:a".to_string());
        args.push("copy".to_string());
    }
    args.extend(
        [
            "-muxdelay",
            "0",
            "-muxpreload",
            "0",
            "-flush_packets",
            "1",
            "-f",
            "mpegts",
            "pipe:1",
        ]
        .into_iter()
        .map(str::to_string),
    );
    args
}

// --- ffmpeg binary resolution + capability probe ---

fn classify_io_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("NOT_FOUND:{err}"),
        std::io::ErrorKind::PermissionDenied => format!("PERMISSION:{err}"),
        _ => format!("OTHER:{err}"),
    }
}

fn ffmpeg_path_candidates<F>(
    path_var: &std::ffi::OsStr,
    binary_name: &str,
    is_file: F,
) -> Vec<String>
where
    F: Fn(&std::path::Path) -> bool,
{
    std::env::split_paths(path_var)
        .map(|directory| directory.join(binary_name))
        .filter(|candidate| is_file(candidate))
        .map(|candidate| candidate.to_string_lossy().into_owned())
        .collect()
}

fn same_ffmpeg_candidate(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn ffmpeg_candidates() -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let mut push_candidate = |candidate: String| {
        if !candidates
            .iter()
            .any(|existing| same_ffmpeg_candidate(existing, &candidate))
        {
            candidates.push(candidate);
        }
    };
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let sidecar_name = if cfg!(windows) {
                "infinitv-ffmpeg.exe"
            } else {
                "infinitv-ffmpeg"
            };
            push_candidate(parent.join(sidecar_name).to_string_lossy().into_owned());
        }
    }

    // A dev-mode sidecar can shadow a capable system ffmpeg on PATH.
    if let Some(path_var) = std::env::var_os("PATH") {
        let binary_name = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        for candidate in ffmpeg_path_candidates(&path_var, binary_name, |path| path.is_file()) {
            push_candidate(candidate);
        }
    }

    // Bare fallback for virtual PATH lookups.
    push_candidate("ffmpeg".to_string());
    candidates
}

fn demuxers_support_matroska_and_mov(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("matroska") && lower.contains("mov")
}

fn decoders_support_video_timestamp_inference(stdout: &str) -> bool {
    let has_decoder = |name: &str| {
        stdout.lines().any(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            fields.get(1).is_some_and(|field| field.eq_ignore_ascii_case(name))
        })
    };
    has_decoder("h264") && has_decoder("hevc")
}

async fn probe_ffmpeg_listing(path: &str, flag: &str) -> Result<String, String> {
    let mut command = TokioCommand::new(path);
    command
        .args(["-hide_banner", flag])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| classify_io_error(&e))?;
    match tokio::time::timeout(Duration::from_millis(DETECT_TIMEOUT_MS), child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
        Ok(Err(e)) => Err(format!("OTHER:{e}")),
        Err(_) => Err(format!("TIMEOUT:{path} did not exit within {DETECT_TIMEOUT_MS}ms")),
    }
}

async fn probe_candidate(path: &str) -> Option<FfmpegProbe> {
    let demuxers_stdout = probe_ffmpeg_listing(path, "-demuxers").await.ok()?;
    if !demuxers_support_matroska_and_mov(&demuxers_stdout) {
        return None;
    }
    // Matroska often omits video DTS; decoders let ffmpeg infer it.
    if !probe_ffmpeg_listing(path, "-decoders")
        .await
        .map(|stdout| decoders_support_video_timestamp_inference(&stdout))
        .unwrap_or(false)
    {
        return None;
    }
    Some(FfmpegProbe {
        path: path.to_string(),
    })
}

fn normalize_custom_path(path: Option<String>) -> Option<String> {
    path.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// Second value is custom_path_ignored: true when a supplied custom path
// failed but a fallback candidate satisfied the probe.
async fn resolve_and_probe_ffmpeg(custom_path: Option<&str>) -> (Option<FfmpegProbe>, bool) {
    let mut custom_failed = false;
    if let Some(custom) = custom_path {
        if external_player::validate_arg(custom, "ffmpeg path").is_ok() {
            if let Some(probe) = probe_candidate(custom).await {
                return (Some(probe), false);
            }
        }
        custom_failed = true;
    }
    for candidate in ffmpeg_candidates() {
        if let Some(probe) = probe_candidate(&candidate).await {
            return (Some(probe), custom_failed);
        }
    }
    (None, false)
}

// Outer None is a miss; Some((probe, custom_path_ignored)) is a cached hit.
fn cached_probe_hit(
    cached: &Option<CachedProbeResolution>,
    normalized_custom: &Option<String>,
) -> Option<(Option<FfmpegProbe>, bool)> {
    let cache = cached.as_ref()?;
    if cache.custom_path == *normalized_custom {
        Some((cache.probe.clone(), cache.custom_path_ignored))
    } else {
        None
    }
}

async fn ensure_probed(
    state: &VodAudioProxyState,
    custom_path: Option<String>,
) -> (Option<FfmpegProbe>, bool) {
    let normalized_custom = normalize_custom_path(custom_path);
    {
        let cached = state
            .probe
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(hit) = cached_probe_hit(&cached, &normalized_custom) {
            return hit;
        }
    }
    let (probe, custom_path_ignored) = resolve_and_probe_ffmpeg(normalized_custom.as_deref()).await;
    let mut cached = state
        .probe
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *cached = Some(CachedProbeResolution {
        custom_path: normalized_custom,
        probe: probe.clone(),
        custom_path_ignored,
    });
    (probe, custom_path_ignored)
}

// --- Server lifecycle ---

async fn ensure_server_started(state: &VodAudioProxyState) -> Result<u16, String> {
    {
        let guard = state
            .server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(handle) = guard.as_ref() {
            return Ok(handle.port);
        }
    }

    let (port, shutdown) = start_server(state.active.clone(), state.sessions.clone())
        .await
        .map_err(|e| format!("OTHER:failed to start vod audio proxy server: {e}"))?;

    let mut guard = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(handle) = guard.as_ref() {
        // Lost a startup race; drop the spare listener.
        let _ = shutdown.send(());
        return Ok(handle.port);
    }
    *guard = Some(ServerHandle { port, shutdown });
    Ok(port)
}

struct ServerState {
    active: ActiveSlot,
    sessions: SessionMap,
    port: u16,
    client: reqwest::Client,
}

async fn start_server(active: ActiveSlot, sessions: SessionMap) -> std::io::Result<(u16, oneshot::Sender<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let server_state = Arc::new(ServerState {
        active,
        sessions,
        port,
        client: reqwest::Client::new(),
    });
    let router = axum::Router::new()
        .route("/forward/{token}/stream", axum::routing::get(handle_forward))
        .route(
            "/live/{session_id}",
            axum::routing::get(handle_live).options(handle_live_options),
        )
        .with_state(server_state);

    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = serve.await {
            log::warn!("[vod-audio-proxy] server exited: {error}");
        }
    });

    Ok((port, shutdown_tx))
}

fn cors_response(status: StatusCode, body: &'static str) -> Response {
    (
        status,
        [(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        body,
    )
        .into_response()
}

async fn handle_live_options() -> Response {
    match axum::http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(axum::http::header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
        .body(axum::body::Body::empty())
    {
        Ok(response) => response,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}


// --- Upstream premature-EOF detection (pure, unit-tested) ---

fn expected_forward_body_length(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

fn classify_upstream_end(expected_total: Option<u64>, delivered: u64) -> Option<String> {
    let expected_total = expected_total?;
    if expected_total == 0 || delivered >= expected_total {
        return None;
    }
    Some(format!(
        "OTHER:upstream stream ended prematurely at {delivered}/{expected_total} bytes"
    ))
}

fn record_upstream_eof(session: &VodAudioSession, detail: String) {
    let mut guard = session
        .upstream_eof
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = Some(UpstreamEofRecord {
        at: Instant::now(),
        detail,
    });
}

fn clear_upstream_eof(session: &VodAudioSession) {
    let mut guard = session
        .upstream_eof
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = None;
}

struct DeliveryTrackedStream {
    inner: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    session: Arc<VodAudioSession>,
    expected_total: Option<u64>,
    delivered: u64,
    first_byte_seen: bool,
    ended: bool,
}

impl Stream for DeliveryTrackedStream {
    type Item = reqwest::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ended {
            return Poll::Ready(None);
        }
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.delivered += chunk.len() as u64;
                if !self.first_byte_seen {
                    self.first_byte_seen = true;
                    clear_upstream_eof(&self.session);
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(other) => {
                self.ended = true;
                if let Some(detail) = classify_upstream_end(self.expected_total, self.delivered) {
                    record_upstream_eof(&self.session, detail);
                }
                Poll::Ready(other)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

// Lets the https-less ffmpeg sidecar read a remote https source via loopback.
async fn handle_forward(
    State(state): State<Arc<ServerState>>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let expected_host = format!("127.0.0.1:{}", state.port);
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(|host| host == expected_host)
        .unwrap_or(false);
    if !host_ok {
        return cors_response(StatusCode::FORBIDDEN, "forbidden");
    }

    let session = {
        let sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.get(&token).cloned()
    };
    let Some(session) = session else {
        return cors_response(StatusCode::NOT_FOUND, "unknown session");
    };

    let mut upstream_request = state.client.get(&session.upstream_url);
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
    if let Some(authorization) = &session.authorization {
        upstream_request = upstream_request.header(reqwest::header::AUTHORIZATION, authorization.clone());
    }

    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[vod-audio-proxy] upstream request failed: {}", error.without_url());
            return cors_response(StatusCode::BAD_GATEWAY, "upstream request failed");
        }
    };

    let status = upstream_response.status();
    if let Some(requested_start) = requested_range_start {
        if ranged_response_is_corrupted(status, upstream_response.headers(), requested_start) {
            log::warn!("[vod-audio-proxy] upstream sent a 206 starting at the wrong byte for range {requested_start}");
            return cors_response(StatusCode::BAD_GATEWAY, "upstream range response mismatch");
        }
    }
    let expected_total = expected_forward_body_length(upstream_response.headers());
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

    let tracked_stream = DeliveryTrackedStream {
        inner: Box::pin(upstream_response.bytes_stream()),
        session: session.clone(),
        expected_total,
        delivered: 0,
        first_byte_seen: false,
        ended: false,
    };

    match response_builder.body(axum::body::Body::from_stream(tracked_stream)) {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[vod-audio-proxy] failed to build forward response: {error}");
            cors_response(StatusCode::INTERNAL_SERVER_ERROR, "response build failed")
        }
    }
}

async fn handle_live(
    State(state): State<Arc<ServerState>>,
    AxumPath(session_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let expected_host = format!("127.0.0.1:{}", state.port);
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(|host| host == expected_host)
        .unwrap_or(false);
    if !host_ok {
        return cors_response(StatusCode::FORBIDDEN, "forbidden");
    }

    // `/live` is an unseekable pipe; a Range resume would splice misaligned bytes.
    if headers
        .get(axum::http::header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(range_request_start)
        .is_some_and(|start| start != 0)
    {
        return cors_response(StatusCode::RANGE_NOT_SATISFIABLE, "resuming mid-stream is not supported");
    }

    let session = {
        let guard = state
            .active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.clone()
    };
    let Some(session) = session else {
        return cors_response(StatusCode::NOT_FOUND, "unknown session");
    };
    if session.session_id != session_id {
        return cors_response(StatusCode::NOT_FOUND, "unknown session");
    }
    if session.torn_down.load(Ordering::SeqCst) {
        return cors_response(StatusCode::NOT_FOUND, "session is no longer active");
    }

    // Fresh channel per client; storing the sender ends any previous one.
    let (sender, mut receiver) = mpsc::channel::<Bytes>(OUTPUT_CHANNEL_CAPACITY);
    set_current_client(&session, sender.clone());

    // A teardown racing the store must not leave a dead sender in place.
    if session.torn_down.load(Ordering::SeqCst) {
        let mut guard = session
            .current_client
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.as_ref().is_some_and(|current| current.same_channel(&sender)) {
            *guard = None;
        }
        drop(guard);
        return cors_response(StatusCode::NOT_FOUND, "session is no longer active");
    }

    let body_stream = futures_util::stream::poll_fn(move |cx| {
        receiver
            .poll_recv(cx)
            .map(|item| item.map(Ok::<Bytes, std::io::Error>))
    });

    match axum::http::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "video/mp2t")
        .header(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(axum::body::Body::from_stream(body_stream))
    {
        Ok(response) => response,
        Err(error) => {
            log::warn!("[vod-audio-proxy] failed to build live response: {error}");
            cors_response(StatusCode::INTERNAL_SERVER_ERROR, "response build failed")
        }
    }
}

// --- Pipeline tasks ---

fn mark_activity(session: &VodAudioSession) {
    let mut last_activity = session
        .last_activity
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *last_activity = Instant::now();
}

fn set_current_client(session: &VodAudioSession, sender: mpsc::Sender<Bytes>) {
    {
        let mut guard = session
            .current_client
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(sender);
    }
    session.client_notify.notify_one();
}

fn stop_after_client_disconnect(session: &VodAudioSession) {
    {
        let mut guard = session
            .current_client
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *guard = None;
    }
    session.blocked_on_send.store(false, Ordering::SeqCst);
    session.torn_down.store(true, Ordering::SeqCst);
    session.client_gone.store(true, Ordering::SeqCst);
    session.kill_notify.notify_one();
    session.client_notify.notify_one();
}

// Dropped bytes here would corrupt the TS header.
async fn send_to_current_client(session: &Arc<VodAudioSession>, chunk: Bytes) {
    send_to_current_client_with_timeouts(
        session,
        chunk,
        CLIENT_RECONNECT_GRACE,
        CLIENT_BACKPRESSURE_TIMEOUT,
    )
    .await;
}

async fn send_to_current_client_with_timeouts(
    session: &Arc<VodAudioSession>,
    chunk: Bytes,
    reconnect_grace: Duration,
    backpressure_timeout: Duration,
) {
    loop {
        if session.torn_down.load(Ordering::SeqCst) {
            session.blocked_on_send.store(false, Ordering::SeqCst);
            return;
        }

        // Waiter before sender read so a racing connect isn't missed.
        let client_changed = session.client_notify.notified();
        let sender = {
            let guard = session
                .current_client
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            guard.clone()
        };

        // Downstream backpressure, not an ffmpeg stall.
        session.blocked_on_send.store(true, Ordering::SeqCst);
        let Some(sender) = sender else {
            if tokio::time::timeout(reconnect_grace, client_changed).await.is_err() {
                stop_after_client_disconnect(session);
                return;
            }
            continue;
        };

        // Connected-but-slow clients (long pauses) get backpressure_timeout before teardown, not reconnect_grace.
        tokio::select! {
            send_result = sender.send(chunk.clone()) => {
                session.blocked_on_send.store(false, Ordering::SeqCst);
                if send_result.is_ok() {
                    let still_current = {
                        let guard = session
                            .current_client
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        guard.as_ref().is_some_and(|current| current.same_channel(&sender))
                    };
                    if still_current {
                        return;
                    }
                    // Replacement raced the send; resend the chunk to it.
                    continue;
                }
                let mut guard = session
                    .current_client
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if guard.as_ref().is_some_and(|current| current.same_channel(&sender)) {
                    *guard = None;
                }
            }
            _ = client_changed => {
                // A cancelled send never enqueued; the loop resends.
            }
            _ = tokio::time::sleep(backpressure_timeout) => {
                session.backpressure_timed_out.store(true, Ordering::SeqCst);
                stop_after_client_disconnect(session);
                return;
            }
        }
    }
}

fn spawn_output_task(
    session: Arc<VodAudioSession>,
    mut stdout: tokio::process::ChildStdout,
    first_byte_tx: oneshot::Sender<()>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut first_byte_tx = Some(first_byte_tx);
        let mut buffer = vec![0u8; OUTPUT_CHUNK_SIZE];
        loop {
            match stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read_count) => {
                    if let Some(tx) = first_byte_tx.take() {
                        let _ = tx.send(());
                    }
                    mark_activity(&session);
                    let chunk = Bytes::copy_from_slice(&buffer[..read_count]);
                    send_to_current_client(&session, chunk).await;
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_stderr_task(
    session: Arc<VodAudioSession>,
    stderr: tokio::process::ChildStderr,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut tail = session
                .stderr_tail
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if tail.len() >= STDERR_RING_CAPACITY {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    })
}

fn stderr_tail_suffix(session: &VodAudioSession) -> String {
    let tail = session
        .stderr_tail
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if tail.is_empty() {
        String::new()
    } else {
        format!(" ({})", tail.iter().cloned().collect::<Vec<_>>().join(" | "))
    }
}

// --- Watchdog ---

// Resolves only when stdout stalls and the reader isn't blocked on the consumer.
async fn wait_for_stdout_stall(session: &Arc<VodAudioSession>) {
    loop {
        tokio::time::sleep(STALL_CHECK_INTERVAL).await;
        if session.blocked_on_send.load(Ordering::SeqCst) {
            continue;
        }
        let elapsed = session
            .last_activity
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .elapsed();
        if elapsed >= STDOUT_STALL_TIMEOUT {
            return;
        }
    }
}

// A session still draining ffmpeg's own output to the client is not stuck: child.wait()
// wins that race once ffmpeg finishes, so this only fires once output has also gone quiet.
async fn wait_for_upstream_eof_expiry(session: &Arc<VodAudioSession>) -> String {
    loop {
        tokio::time::sleep(STALL_CHECK_INTERVAL).await;
        let expired_detail = {
            let guard = session
                .upstream_eof
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            guard.as_ref().and_then(|record| {
                if record.at.elapsed() >= UPSTREAM_EOF_GRACE {
                    Some(record.detail.clone())
                } else {
                    None
                }
            })
        };
        let Some(detail) = expired_detail else {
            continue;
        };
        if session.blocked_on_send.load(Ordering::SeqCst) {
            continue;
        }
        let idle_for = session
            .last_activity
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .elapsed();
        if idle_for < UPSTREAM_EOF_GRACE {
            continue;
        }
        return detail;
    }
}

// Owns the child for its lifetime; teardown wakes it via kill_notify.
async fn run_watchdog(
    app: AppHandle,
    session: Arc<VodAudioSession>,
    mut first_byte_rx: oneshot::Receiver<()>,
) {
    let mut child = {
        let mut child_guard = session.child.lock().await;
        let Some(child) = child_guard.take() else {
            return;
        };
        child
    };

    let early_exit = tokio::select! {
        status = child.wait() => Some(status),
        _ = &mut first_byte_rx => None,
        _ = session.kill_notify.notified() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            teardown_io(&session).await;
            emit_client_timeout_if_disconnected(&app, &session).await;
            return;
        }
        _ = tokio::time::sleep(STARTUP_SILENCE_TIMEOUT) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            finish_with_error(
                &app,
                &session,
                "TIMEOUT:no output from ffmpeg within 10s".to_string(),
            )
            .await;
            return;
        }
    };

    let exit_status = match early_exit {
        Some(status) => status,
        None => tokio::select! {
            status = child.wait() => status,
            _ = wait_for_stdout_stall(&session) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                finish_with_error(
                    &app,
                    &session,
                    format!(
                        "TIMEOUT:no output from ffmpeg for {}s{}",
                        STDOUT_STALL_TIMEOUT.as_secs(),
                        stderr_tail_suffix(&session)
                    ),
                )
                .await;
                return;
            }
            detail = wait_for_upstream_eof_expiry(&session) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                finish_with_error(
                    &app,
                    &session,
                    format!("{detail}{}", stderr_tail_suffix(&session)),
                )
                .await;
                return;
            }
            _ = session.kill_notify.notified() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                teardown_io(&session).await;
                emit_client_timeout_if_disconnected(&app, &session).await;
                return;
            }
        },
    };

    let succeeded = matches!(&exit_status, Ok(status) if status.success());
    if succeeded {
        teardown_io(&session).await;
        return;
    }

    let detail = match exit_status {
        Ok(status) => format!("OTHER:ffmpeg exited with {status}{}", stderr_tail_suffix(&session)),
        Err(error) => format!(
            "OTHER:ffmpeg wait failed: {error}{}",
            stderr_tail_suffix(&session)
        ),
    };
    finish_with_error(&app, &session, detail).await;
}

async fn finish_with_error(app: &AppHandle, session: &Arc<VodAudioSession>, detail: String) {
    let already_torn_down = session.torn_down.swap(true, Ordering::SeqCst);
    teardown_io(session).await;
    if !already_torn_down {
        let _ = app.emit(
            ERROR_EVENT,
            json!({
                "sessionId": session.session_id,
                "detail": detail,
            }),
        );
    }
}

async fn emit_client_timeout_if_disconnected(app: &AppHandle, session: &Arc<VodAudioSession>) {
    if !session.client_gone.load(Ordering::SeqCst) {
        return;
    }
    // Distinguishes a vanished client from one that stayed connected but stopped reading.
    let detail = if session.backpressure_timed_out.load(Ordering::SeqCst) {
        format!(
            "TIMEOUT:playback client stopped reading for {}s{}",
            CLIENT_BACKPRESSURE_TIMEOUT.as_secs(),
            stderr_tail_suffix(session)
        )
    } else {
        format!(
            "TIMEOUT:no playback client for {}s{}",
            CLIENT_RECONNECT_GRACE.as_secs(),
            stderr_tail_suffix(session)
        )
    };
    let _ = app.emit(
        ERROR_EVENT,
        json!({
            "sessionId": session.session_id,
            "detail": detail,
        }),
    );
}

// --- Teardown ---

/// Never blocks on the child mutex; killing goes through kill_notify instead.
async fn teardown_io(session: &Arc<VodAudioSession>) {
    session.torn_down.store(true, Ordering::SeqCst);
    {
        let mut guard = session
            .current_client
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.take();
    }
    session.kill_notify.notify_one();
    session.client_notify.notify_one();

    if let Ok(mut guard) = session.child.try_lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
        }
    }

    let tasks: Vec<_> = {
        let mut guard = session
            .io_tasks
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.drain(..).collect()
    };
    for task in tasks {
        task.abort();
    }
}

/// Full teardown including the watchdog; only called outside its own task.
async fn teardown_session(session: &Arc<VodAudioSession>) {
    teardown_io(session).await;
    let watchdog = {
        let mut guard = session
            .watchdog_task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.take()
    };
    if let Some(task) = watchdog {
        task.abort();
    }
}

/// Best-effort teardown for app-exit paths that can't await; uses `try_lock`.
pub fn shutdown(state: &VodAudioProxyState) {
    {
        let mut active = state
            .active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *active = None;
    }
    let sessions: Vec<Arc<VodAudioSession>> = {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.drain().map(|(_, session)| session).collect()
    };

    for session in sessions {
        session.torn_down.store(true, Ordering::SeqCst);
        session.kill_notify.notify_one();
        session.client_notify.notify_one();

        if let Ok(mut child_guard) = session.child.try_lock() {
            if let Some(child) = child_guard.as_mut() {
                let _ = child.start_kill();
            }
        }

        let tasks: Vec<_> = {
            let mut guard = session
                .io_tasks
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            guard.drain(..).collect()
        };
        for task in tasks {
            task.abort();
        }

        let watchdog = {
            let mut guard = session
                .watchdog_task
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            guard.take()
        };
        // Aborting the watchdog drops the child; kill_on_drop kills it too.
        if let Some(task) = watchdog {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_ffmpeg_args_copies_audio_by_default() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 1, 0.0, false);
        assert_eq!(
            args,
            vec![
                "-hide_banner",
                "-loglevel",
                "warning",
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "5",
                "-readrate",
                "1.5",
                "-readrate_initial_burst",
                "30",
                "-i",
                "http://127.0.0.1:9000/forward/abc/stream",
                "-map",
                "0:v:0",
                "-map",
                "0:a:1?",
                "-c:v",
                "copy",
                "-c:a",
                "copy",
                "-muxdelay",
                "0",
                "-muxpreload",
                "0",
                "-flush_packets",
                "1",
                "-f",
                "mpegts",
                "pipe:1",
            ]
        );
    }

    #[test]
    fn build_ffmpeg_args_transcodes_audio_to_aac_when_requested() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 2, 0.0, true);
        assert_eq!(
            args,
            vec![
                "-hide_banner",
                "-loglevel",
                "warning",
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "5",
                "-readrate",
                "1.5",
                "-readrate_initial_burst",
                "30",
                "-i",
                "http://127.0.0.1:9000/forward/abc/stream",
                "-map",
                "0:v:0",
                "-map",
                "0:a:2?",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-af",
                "aresample=async=1",
                "-ac",
                "2",
                "-b:a",
                "192k",
                "-muxdelay",
                "0",
                "-muxpreload",
                "0",
                "-flush_packets",
                "1",
                "-f",
                "mpegts",
                "pipe:1",
            ]
        );
    }

    #[test]
    fn build_ffmpeg_args_places_ss_before_i_when_start_seconds_is_meaningful() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 0, 12.5, false);
        let no_accurate_seek_index = args
            .iter()
            .position(|arg| arg == "-noaccurate_seek")
            .expect("-noaccurate_seek must be present");
        let ss_index = args.iter().position(|arg| arg == "-ss").expect("-ss must be present");
        let i_index = args.iter().position(|arg| arg == "-i").expect("-i must be present");
        assert!(
            no_accurate_seek_index < ss_index,
            "-noaccurate_seek must precede -ss"
        );
        assert!(ss_index < i_index, "-ss must precede -i for input seeking");
        assert_eq!(args[ss_index + 1], "12.5");
    }

    #[test]
    fn build_ffmpeg_args_omits_ss_for_negligible_start_seconds() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 0, 0.05, false);
        assert!(!args.iter().any(|arg| arg == "-ss"), "-ss must be omitted below the threshold");
        assert!(
            !args.iter().any(|arg| arg == "-noaccurate_seek"),
            "-noaccurate_seek must be omitted when no input seek is performed"
        );
    }

    #[test]
    fn build_ffmpeg_args_places_reconnect_flags_before_i() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 0, 0.0, false);
        let reconnect_index = args
            .iter()
            .position(|arg| arg == "-reconnect")
            .expect("-reconnect must be present for an http input");
        let i_index = args.iter().position(|arg| arg == "-i").expect("-i must be present");
        assert!(reconnect_index < i_index, "-reconnect must precede -i");
    }

    #[test]
    fn build_ffmpeg_args_places_readrate_pacing_flags_before_i() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 0, 0.0, false);
        let readrate_index = args.iter().position(|arg| arg == "-readrate").expect("-readrate must be present");
        assert_eq!(args[readrate_index + 1], "1.5");
        let burst_index = args
            .iter()
            .position(|arg| arg == "-readrate_initial_burst")
            .expect("-readrate_initial_burst must be present");
        assert_eq!(args[burst_index + 1], "30");
        let i_index = args.iter().position(|arg| arg == "-i").expect("-i must be present");
        assert!(readrate_index < i_index, "-readrate must precede -i");
        assert!(burst_index < i_index, "-readrate_initial_burst must precede -i");
    }

    #[test]
    fn build_ffmpeg_args_keeps_readrate_pacing_after_a_seek() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 0, 12.5, false);
        assert!(
            args.iter().any(|arg| arg == "-readrate"),
            "seeking must not drop the pacing flags: readrate applies to post-seek reading"
        );
    }

    #[test]
    fn http_input_reconnect_args_covers_http_and_https() {
        assert_eq!(
            http_input_reconnect_args("http://127.0.0.1:9000/forward/abc/stream"),
            vec!["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
        );
        assert_eq!(
            http_input_reconnect_args("https://provider.test/movie.mkv"),
            vec!["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
        );
    }

    #[test]
    fn http_input_reconnect_args_is_empty_for_a_local_file_path() {
        assert!(http_input_reconnect_args("/Users/example/movie.mkv").is_empty());
        assert!(http_input_reconnect_args("file:///Users/example/movie.mkv").is_empty());
    }

    #[test]
    fn build_ffmpeg_args_omits_reconnect_flags_for_a_local_file_input() {
        let args = build_ffmpeg_args("/Users/example/movie.mkv", 0, 0.0, false);
        assert!(
            !args.iter().any(|arg| arg == "-reconnect"),
            "-reconnect must be omitted for a non-http input"
        );
    }

    #[test]
    fn is_loopback_http_accepts_127_0_0_1() {
        assert!(is_loopback_http("http://127.0.0.1:5173/abc/stream.mkv"));
    }

    #[test]
    fn is_loopback_http_accepts_localhost() {
        assert!(is_loopback_http("http://localhost:5173/abc/stream.mkv"));
    }

    #[test]
    fn is_loopback_http_accepts_weird_ports() {
        assert!(is_loopback_http("http://127.0.0.1:1/stream"));
        assert!(is_loopback_http("http://127.0.0.1:65535/stream"));
    }

    #[test]
    fn is_loopback_http_rejects_https() {
        assert!(!is_loopback_http("https://127.0.0.1:5173/abc/stream.mkv"));
    }

    #[test]
    fn is_loopback_http_rejects_remote_host() {
        assert!(!is_loopback_http("http://example.test/abc/stream.mkv"));
    }

    #[test]
    fn is_loopback_http_rejects_unparseable_url() {
        assert!(!is_loopback_http("not a url"));
    }

    #[test]
    fn ffmpeg_candidates_falls_back_to_bare_binary_name() {
        let candidates = ffmpeg_candidates();
        assert_eq!(candidates.last().map(String::as_str), Some("ffmpeg"));
    }

    #[test]
    fn classify_io_error_prefixes_not_found() {
        let err = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(classify_io_error(&err).starts_with("NOT_FOUND:"));
    }

    #[test]
    fn classify_io_error_prefixes_permission_denied() {
        let err = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(classify_io_error(&err).starts_with("PERMISSION:"));
    }

    #[test]
    fn classify_io_error_prefixes_other() {
        let err = std::io::Error::from(std::io::ErrorKind::Other);
        assert!(classify_io_error(&err).starts_with("OTHER:"));
    }

    #[test]
    fn classify_upstream_end_is_none_without_a_content_length() {
        assert_eq!(classify_upstream_end(None, 1_000), None);
    }

    #[test]
    fn classify_upstream_end_is_none_when_delivery_matches_the_declared_length() {
        assert_eq!(classify_upstream_end(Some(1_000), 1_000), None);
    }

    #[test]
    fn classify_upstream_end_is_none_when_the_declared_length_is_zero() {
        assert_eq!(classify_upstream_end(Some(0), 0), None);
    }

    #[test]
    fn classify_upstream_end_flags_a_short_delivery() {
        assert_eq!(
            classify_upstream_end(Some(1_000), 400),
            Some("OTHER:upstream stream ended prematurely at 400/1000 bytes".to_string())
        );
    }

    #[test]
    fn ffmpeg_path_candidates_keep_searching_after_a_shadowed_binary() {
        let shadowed_dir = std::path::PathBuf::from("shadowed");
        let working_dir = std::path::PathBuf::from("working");
        let missing_dir = std::path::PathBuf::from("missing");
        let path_var = std::env::join_paths([&shadowed_dir, &working_dir, &missing_dir])
            .expect("test PATH entries should be joinable");
        let binary_name = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };

        let candidates = ffmpeg_path_candidates(&path_var, binary_name, |candidate| {
            candidate
                .parent()
                .is_some_and(|parent| parent != missing_dir)
        });
        let candidates: Vec<std::path::PathBuf> = candidates.into_iter().map(Into::into).collect();

        assert_eq!(
            candidates,
            vec![
                shadowed_dir.join(binary_name),
                working_dir.join(binary_name)
            ]
        );
    }

    #[test]
    fn ffmpeg_candidate_comparison_matches_filesystem_case_rules() {
        #[cfg(windows)]
        assert!(same_ffmpeg_candidate("C:\\FFMPEG\\ffmpeg.exe", "c:\\ffmpeg\\FFMPEG.EXE"));
        #[cfg(not(windows))]
        assert!(!same_ffmpeg_candidate("/opt/FFmpeg/ffmpeg", "/opt/ffmpeg/ffmpeg"));
    }

    #[test]
    fn demuxers_support_matroska_and_mov_requires_both() {
        let listing = " D  matroska,webm      Matroska / WebM\n D  mov,mp4,m4a,3gp     QuickTime / MOV\n";
        assert!(demuxers_support_matroska_and_mov(listing));
        assert!(!demuxers_support_matroska_and_mov(" D  mpegts     MPEG-TS"));
    }

    #[test]
    fn decoders_support_video_timestamp_inference_requires_h264_and_hevc() {
        let listing = " VFS..D h264                 H.264 / AVC\n VFS..D hevc                 H.265 / HEVC\n";
        assert!(decoders_support_video_timestamp_inference(listing));
        assert!(!decoders_support_video_timestamp_inference(" VFS..D h264 H.264 / AVC\n"));
    }

    #[test]
    fn normalize_custom_path_trims_and_drops_blank() {
        assert_eq!(normalize_custom_path(None), None);
        assert_eq!(normalize_custom_path(Some("".to_string())), None);
        assert_eq!(normalize_custom_path(Some("   ".to_string())), None);
        assert_eq!(
            normalize_custom_path(Some("  /usr/bin/ffmpeg  ".to_string())),
            Some("/usr/bin/ffmpeg".to_string())
        );
    }

    #[test]
    fn cached_probe_hit_returns_none_without_a_cache_entry() {
        assert!(cached_probe_hit(&None, &None).is_none());
    }

    #[test]
    fn cached_probe_hit_returns_the_cached_negative_outcome_without_reprobing() {
        let cached = Some(CachedProbeResolution {
            custom_path: None,
            probe: None,
            custom_path_ignored: false,
        });
        assert_eq!(cached_probe_hit(&cached, &None), Some((None, false)));
    }

    #[test]
    fn cached_probe_hit_returns_the_cached_probe_when_the_path_matches() {
        let probe = FfmpegProbe {
            path: "/usr/bin/ffmpeg".to_string(),
        };
        let cached = Some(CachedProbeResolution {
            custom_path: Some("/usr/bin/ffmpeg".to_string()),
            probe: Some(probe.clone()),
            custom_path_ignored: false,
        });
        assert_eq!(
            cached_probe_hit(&cached, &Some("/usr/bin/ffmpeg".to_string())),
            Some((Some(probe), false))
        );
    }

    #[test]
    fn cached_probe_hit_returns_none_when_the_custom_path_changed() {
        let cached = Some(CachedProbeResolution {
            custom_path: Some("/usr/bin/ffmpeg".to_string()),
            probe: None,
            custom_path_ignored: false,
        });
        assert!(cached_probe_hit(&cached, &Some("/opt/ffmpeg/ffmpeg".to_string())).is_none());
    }

    #[test]
    fn cached_probe_hit_surfaces_a_cached_custom_path_ignored_flag() {
        let probe = FfmpegProbe {
            path: "/usr/bin/ffmpeg".to_string(),
        };
        let cached = Some(CachedProbeResolution {
            custom_path: Some("/bad/ffmpeg".to_string()),
            probe: Some(probe.clone()),
            custom_path_ignored: true,
        });
        assert_eq!(
            cached_probe_hit(&cached, &Some("/bad/ffmpeg".to_string())),
            Some((Some(probe), true))
        );
    }

    #[test]
    fn stderr_tail_suffix_is_empty_when_no_lines_captured() {
        let session = Arc::new(VodAudioSession {
            session_id: "sess".to_string(),
            upstream_url: "https://example.test/movie.mkv".to_string(),
            user_agent: None,
            authorization: None,
            torn_down: AtomicBool::new(false),
            client_gone: AtomicBool::new(false),
            current_client: Mutex::new(None),
            client_notify: Notify::new(),
            stderr_tail: Mutex::new(VecDeque::new()),
            child: tokio::sync::Mutex::new(None),
            kill_notify: Notify::new(),
            io_tasks: Mutex::new(Vec::new()),
            watchdog_task: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            blocked_on_send: AtomicBool::new(false),
            backpressure_timed_out: AtomicBool::new(false),
            upstream_eof: Mutex::new(None),
        });
        assert_eq!(stderr_tail_suffix(&session), "");
    }

    #[test]
    fn stderr_tail_suffix_joins_captured_lines() {
        let mut tail = VecDeque::new();
        tail.push_back("first warning".to_string());
        tail.push_back("second warning".to_string());
        let session = Arc::new(VodAudioSession {
            session_id: "sess".to_string(),
            upstream_url: "https://example.test/movie.mkv".to_string(),
            user_agent: None,
            authorization: None,
            torn_down: AtomicBool::new(false),
            client_gone: AtomicBool::new(false),
            current_client: Mutex::new(None),
            client_notify: Notify::new(),
            stderr_tail: Mutex::new(tail),
            child: tokio::sync::Mutex::new(None),
            kill_notify: Notify::new(),
            io_tasks: Mutex::new(Vec::new()),
            watchdog_task: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            blocked_on_send: AtomicBool::new(false),
            backpressure_timed_out: AtomicBool::new(false),
            upstream_eof: Mutex::new(None),
        });
        assert_eq!(
            stderr_tail_suffix(&session),
            " (first warning | second warning)"
        );
    }

    fn test_vod_audio_session_with_id(session_id: &str) -> Arc<VodAudioSession> {
        Arc::new(VodAudioSession {
            session_id: session_id.to_string(),
            upstream_url: "https://example.test/movie.mkv".to_string(),
            user_agent: None,
            authorization: None,
            torn_down: AtomicBool::new(false),
            client_gone: AtomicBool::new(false),
            current_client: Mutex::new(None),
            client_notify: Notify::new(),
            stderr_tail: Mutex::new(VecDeque::new()),
            child: tokio::sync::Mutex::new(None),
            kill_notify: Notify::new(),
            io_tasks: Mutex::new(Vec::new()),
            watchdog_task: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            blocked_on_send: AtomicBool::new(false),
            backpressure_timed_out: AtomicBool::new(false),
            upstream_eof: Mutex::new(None),
        })
    }

    fn test_vod_audio_session() -> Arc<VodAudioSession> {
        test_vod_audio_session_with_id("sess")
    }

    // Register's critical section without ffmpeg: the sleep stands in for the spawn.
    async fn register_under_lock(
        state: &VodAudioProxyState,
        session_id: &str,
        spawn_delay: Duration,
    ) {
        let _register_guard = state.register_lock.lock().await;
        teardown_active_session(state).await;
        let session = test_vod_audio_session_with_id(session_id);
        insert_session(state, session.clone());
        tokio::time::sleep(spawn_delay).await;
        set_active_session(state, session);
    }

    #[tokio::test]
    async fn concurrent_registrations_leave_exactly_one_live_session() {
        let state = Arc::new(VodAudioProxyState::default());

        let slow_state = state.clone();
        let slow = tokio::spawn(async move {
            register_under_lock(&slow_state, "slow", Duration::from_millis(50)).await;
        });
        tokio::task::yield_now().await;
        let fast_state = state.clone();
        let fast = tokio::spawn(async move {
            register_under_lock(&fast_state, "fast", Duration::from_millis(0)).await;
        });
        slow.await.expect("slow registration");
        fast.await.expect("fast registration");

        let active_id = {
            let active = state
                .active
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            active
                .as_ref()
                .map(|session| session.session_id.clone())
                .expect("a session must stay active")
        };
        let sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert_eq!(sessions.len(), 1, "the losing registration must not orphan a session");
        assert!(sessions.contains_key(&active_id));
    }

    async fn wait_until_output_is_backpressured(session: &VodAudioSession) {
        for _ in 0..100 {
            if session.blocked_on_send.load(Ordering::SeqCst) {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("output delivery did not enter downstream backpressure");
    }

    #[tokio::test]
    async fn output_waits_for_first_client_without_dropping_the_chunk() {
        let session = test_vod_audio_session();
        let expected = Bytes::from_static(b"transport stream header");
        let sending_session = session.clone();
        let sending_chunk = expected.clone();
        let send_task = tokio::spawn(async move {
            send_to_current_client(&sending_session, sending_chunk).await;
        });

        wait_until_output_is_backpressured(&session).await;
        assert!(!send_task.is_finished(), "the chunk must wait for the first HTTP client");

        let (sender, mut receiver) = mpsc::channel(1);
        set_current_client(&session, sender);

        let received = tokio::time::timeout(Duration::from_millis(500), receiver.recv())
            .await
            .expect("the client should receive the waiting chunk")
            .expect("the client channel should remain open");
        assert_eq!(received, expected);
        tokio::time::timeout(Duration::from_millis(500), send_task)
            .await
            .expect("delivery should finish after the client connects")
            .expect("delivery task should not panic");
    }

    #[tokio::test]
    async fn replacement_client_receives_a_chunk_blocked_on_the_old_client() {
        let session = test_vod_audio_session();
        let (old_sender, _old_receiver) = mpsc::channel(1);
        old_sender
            .send(Bytes::from_static(b"already queued"))
            .await
            .expect("old channel should accept its first chunk");
        set_current_client(&session, old_sender);

        let expected = Bytes::from_static(b"rerouted chunk");
        let sending_session = session.clone();
        let sending_chunk = expected.clone();
        let send_task = tokio::spawn(async move {
            send_to_current_client(&sending_session, sending_chunk).await;
        });
        wait_until_output_is_backpressured(&session).await;

        let (new_sender, mut new_receiver) = mpsc::channel(1);
        set_current_client(&session, new_sender);

        let received = tokio::time::timeout(Duration::from_millis(500), new_receiver.recv())
            .await
            .expect("replacement client should receive the blocked chunk")
            .expect("replacement channel should remain open");
        assert_eq!(received, expected);
        tokio::time::timeout(Duration::from_millis(500), send_task)
            .await
            .expect("delivery should finish through the replacement client")
            .expect("delivery task should not panic");
    }

    #[tokio::test]
    async fn teardown_wakes_output_waiting_for_a_client() {
        let session = test_vod_audio_session();
        let sending_session = session.clone();
        let send_task = tokio::spawn(async move {
            send_to_current_client(&sending_session, Bytes::from_static(b"pending")).await;
        });
        wait_until_output_is_backpressured(&session).await;

        teardown_io(&session).await;

        tokio::time::timeout(Duration::from_millis(500), send_task)
            .await
            .expect("teardown should wake client delivery")
            .expect("delivery task should not panic");
        assert!(!session.blocked_on_send.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn disconnected_client_timeout_stops_output_backpressure() {
        let session = test_vod_audio_session();
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        set_current_client(&session, sender);
        let kill_wakeup = session.kill_notify.notified();
        let sending_session = session.clone();
        let send_task = tokio::spawn(async move {
            send_to_current_client_with_timeouts(
                &sending_session,
                Bytes::from_static(b"orphaned"),
                Duration::from_millis(10),
                Duration::from_secs(3600),
            )
            .await;
        });

        tokio::time::timeout(Duration::from_millis(500), send_task)
            .await
            .expect("disconnected delivery must have a finite wait")
            .expect("delivery task should not panic");
        tokio::time::timeout(Duration::from_millis(500), kill_wakeup)
            .await
            .expect("client timeout must wake the watchdog");
        assert!(session.torn_down.load(Ordering::SeqCst));
        assert!(session.client_gone.load(Ordering::SeqCst));
        assert!(!session.backpressure_timed_out.load(Ordering::SeqCst));
        assert!(!session.blocked_on_send.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn connected_but_slow_client_survives_within_the_backpressure_window() {
        let session = test_vod_audio_session();
        let (sender, _receiver) = mpsc::channel(1);
        // full channel: backpressure, not a missing client
        sender
            .send(Bytes::from_static(b"already queued"))
            .await
            .expect("channel should accept its first chunk");
        set_current_client(&session, sender);

        let sending_session = session.clone();
        let send_task = tokio::spawn(async move {
            send_to_current_client_with_timeouts(
                &sending_session,
                Bytes::from_static(b"waiting"),
                Duration::from_millis(10),
                Duration::from_millis(200),
            )
            .await;
        });
        wait_until_output_is_backpressured(&session).await;

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!send_task.is_finished(), "a connected client must survive within the backpressure window");
        assert!(!session.torn_down.load(Ordering::SeqCst));

        send_task.abort();
    }

    #[tokio::test]
    async fn connected_but_slow_client_is_torn_down_after_the_backpressure_timeout() {
        let session = test_vod_audio_session();
        let (sender, _receiver) = mpsc::channel(1);
        // full channel: backpressure, not a missing client
        sender
            .send(Bytes::from_static(b"already queued"))
            .await
            .expect("channel should accept its first chunk");
        set_current_client(&session, sender);
        let kill_wakeup = session.kill_notify.notified();
        let sending_session = session.clone();
        let send_task = tokio::spawn(async move {
            send_to_current_client_with_timeouts(
                &sending_session,
                Bytes::from_static(b"waiting"),
                Duration::from_secs(3600),
                Duration::from_millis(10),
            )
            .await;
        });
        wait_until_output_is_backpressured(&session).await;

        tokio::time::timeout(Duration::from_millis(500), send_task)
            .await
            .expect("a client that never reads again must have a finite wait")
            .expect("delivery task should not panic");
        tokio::time::timeout(Duration::from_millis(500), kill_wakeup)
            .await
            .expect("the backpressure timeout must wake the watchdog");
        assert!(session.torn_down.load(Ordering::SeqCst));
        assert!(session.client_gone.load(Ordering::SeqCst));
        assert!(session.backpressure_timed_out.load(Ordering::SeqCst));
    }

    // Regression test: teardown_io blocking while the watchdog owned the child.
    #[tokio::test]
    async fn teardown_io_wakes_a_task_parked_on_kill_notify_without_blocking() {
        let session = test_vod_audio_session();

        let waiting_session = session.clone();
        let woken = tokio::spawn(async move {
            waiting_session.kill_notify.notified().await;
        });
        tokio::task::yield_now().await;

        let teardown = tokio::time::timeout(Duration::from_millis(500), teardown_io(&session)).await;
        assert!(teardown.is_ok(), "teardown_io must not block on the child mutex");

        let wake_result = tokio::time::timeout(Duration::from_millis(500), woken).await;
        assert!(wake_result.is_ok(), "kill_notify must wake a task already parked on notified()");
    }

    #[tokio::test]
    async fn a_later_forwards_first_byte_clears_a_stale_upstream_eof_record() {
        use futures_util::StreamExt;

        let session = test_vod_audio_session();
        record_upstream_eof(&session, "OTHER:stale".to_string());

        let inner = futures_util::stream::iter(vec![Ok::<Bytes, reqwest::Error>(Bytes::from_static(
            b"chunk",
        ))]);
        let mut tracked = DeliveryTrackedStream {
            inner: Box::pin(inner),
            session: session.clone(),
            expected_total: None,
            delivered: 0,
            first_byte_seen: false,
            ended: false,
        };

        tracked.next().await;

        assert!(
            session
                .upstream_eof
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .is_none(),
            "a fresh byte from a later forward must clear the stale premature-EOF record"
        );
    }

    #[tokio::test]
    async fn premature_upstream_eof_unhealed_past_grace_is_returned_by_the_watchdog_wait() {
        let session = test_vod_audio_session();
        {
            let mut guard = session
                .upstream_eof
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *guard = Some(UpstreamEofRecord {
                at: Instant::now() - UPSTREAM_EOF_GRACE - Duration::from_millis(1),
                detail: "OTHER:upstream stream ended prematurely at 400/1000 bytes".to_string(),
            });
        }
        {
            // No recent stdout activity either: ffmpeg is genuinely stuck, not draining.
            let mut guard = session
                .last_activity
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *guard = Instant::now() - UPSTREAM_EOF_GRACE - Duration::from_millis(1);
        }

        let detail = tokio::time::timeout(
            Duration::from_millis(1500),
            wait_for_upstream_eof_expiry(&session),
        )
        .await
        .expect("an unhealed premature-EOF record past grace must resolve");

        assert_eq!(detail, "OTHER:upstream stream ended prematurely at 400/1000 bytes");
    }

    #[tokio::test]
    async fn premature_upstream_eof_does_not_fire_while_ffmpeg_output_is_still_draining() {
        let session = test_vod_audio_session();
        {
            let mut guard = session
                .upstream_eof
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *guard = Some(UpstreamEofRecord {
                at: Instant::now() - UPSTREAM_EOF_GRACE - Duration::from_millis(1),
                detail: "OTHER:upstream stream ended prematurely at 400/1000 bytes".to_string(),
            });
        }
        // last_activity stays fresh (default = session creation time): ffmpeg is still
        // producing output, so the expiry must not fire even though the record is old.
        let outcome = tokio::time::timeout(
            Duration::from_millis(300),
            wait_for_upstream_eof_expiry(&session),
        )
        .await;
        assert!(
            outcome.is_err(),
            "a still-draining session must not be torn down by the upstream-EOF expiry"
        );
    }
}
