// Desktop-only ffmpeg remux proxy for switching a VOD's audio track.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{mpsc, oneshot, Notify};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ERROR_EVENT: &str = "xt:vodaudio-error";
const DETECT_TIMEOUT_MS: u64 = 2000;
const OUTPUT_CHUNK_SIZE: usize = 64 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 256;
const STDERR_RING_CAPACITY: usize = 10;
const STARTUP_SILENCE_TIMEOUT: Duration = Duration::from_secs(10);
const STDOUT_STALL_TIMEOUT: Duration = Duration::from_secs(20);
const STALL_CHECK_INTERVAL: Duration = Duration::from_secs(1);

// --- State ---

type ActiveSlot = Arc<Mutex<Option<Arc<VodAudioSession>>>>;
// Keyed by id so a race-losing session can still be reaped.
type SessionMap = Arc<Mutex<HashMap<String, Arc<VodAudioSession>>>>;

#[derive(Debug, Clone)]
struct FfmpegProbe {
    path: String,
    demuxers_ok: bool,
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
    probe: Mutex<Option<FfmpegProbe>>,
}

struct VodAudioSession {
    session_id: String,
    upstream_url: String,
    user_agent: Option<String>,
    authorization: Option<String>,
    torn_down: AtomicBool,
    // New GET replaces the previous client's sender.
    current_client: Mutex<Option<mpsc::Sender<Bytes>>>,
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
}

// --- Commands ---

#[tauri::command]
pub async fn vod_audio_remux_available(app: AppHandle) -> bool {
    let state = app.state::<VodAudioProxyState>();
    ensure_probed(&state).await.map(|probe| probe.demuxers_ok).unwrap_or(false)
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
) -> Result<RegisterVodAudioRemuxResponse, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("OTHER:{e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("OTHER:url must be http or https".to_string());
    }

    // A loopback tee (e.g. vod_proxy) already applies user_agent/authorization.
    let is_loopback = is_loopback_http(&url);

    // One live session at a time; tear down before starting the next.
    teardown_active_session(&state).await;

    let ffmpeg_path = match ensure_probed(&state).await {
        Some(probe) => probe.path,
        None => return Err("NOT_FOUND:ffmpeg binary not found".to_string()),
    };

    let port = ensure_server_started(&state).await?;
    let token = generate_token();

    let session = Arc::new(VodAudioSession {
        session_id: token.clone(),
        upstream_url: url.clone(),
        user_agent: if is_loopback { None } else { user_agent },
        authorization: if is_loopback { None } else { authorization },
        torn_down: AtomicBool::new(false),
        current_client: Mutex::new(None),
        stderr_tail: Mutex::new(VecDeque::new()),
        child: tokio::sync::Mutex::new(None),
        kill_notify: Notify::new(),
        io_tasks: Mutex::new(Vec::new()),
        watchdog_task: Mutex::new(None),
        last_activity: Mutex::new(Instant::now()),
        blocked_on_send: AtomicBool::new(false),
    });

    // Inserted before spawn so ffmpeg's request can resolve this token.
    {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.insert(token.clone(), session.clone());
    }

    let input_url = if is_loopback {
        url
    } else {
        format!("http://127.0.0.1:{port}/forward/{token}/stream")
    };
    let ffmpeg_args = build_ffmpeg_args(&input_url, audio_stream_index, start_seconds, transcode_audio);

    let mut command = TokioCommand::new(&ffmpeg_path);
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

    {
        let mut active = state
            .active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *active = Some(session);
    }

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

fn build_ffmpeg_args(input_url: &str, audio_stream_index: u32, start_seconds: f64, transcode_audio: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];
    // -ss must precede -i for input seeking.
    if start_seconds > 0.1 {
        args.push("-ss".to_string());
        args.push(format!("{start_seconds}"));
    }
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
                "aresample=async=1:first_pts=0",
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

fn ffmpeg_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let sidecar_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            candidates.push(parent.join(sidecar_name).to_string_lossy().into_owned());
        }
    }
    candidates.push("ffmpeg".to_string());
    candidates
}

fn demuxers_support_matroska_and_mov(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("matroska") && lower.contains("mov")
}

async fn probe_demuxers(path: &str) -> Result<String, String> {
    let mut command = TokioCommand::new(path);
    command
        .args(["-hide_banner", "-demuxers"])
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

async fn resolve_and_probe_ffmpeg() -> Option<FfmpegProbe> {
    for candidate in ffmpeg_candidates() {
        if let Ok(stdout) = probe_demuxers(&candidate).await {
            return Some(FfmpegProbe {
                path: candidate,
                demuxers_ok: demuxers_support_matroska_and_mov(&stdout),
            });
        }
    }
    None
}

async fn ensure_probed(state: &VodAudioProxyState) -> Option<FfmpegProbe> {
    {
        let cached = state
            .probe
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(probe) = cached.as_ref() {
            return Some(probe.clone());
        }
    }
    let probe = resolve_and_probe_ffmpeg().await;
    if let Some(probe) = probe.clone() {
        let mut cached = state
            .probe
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *cached = Some(probe);
    }
    probe
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
    if let Some(range) = headers.get(axum::http::header::RANGE) {
        if let Ok(value) = range.to_str() {
            upstream_request = upstream_request.header(reqwest::header::RANGE, value);
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

    match response_builder.body(axum::body::Body::from_stream(upstream_response.bytes_stream())) {
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

    // Fresh channel per client; storing the sender ends any previous one.
    let (sender, mut receiver) = mpsc::channel::<Bytes>(OUTPUT_CHANNEL_CAPACITY);
    {
        let mut guard = session
            .current_client
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(sender);
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

// Discards the chunk if no client is connected; stdout must still drain.
async fn send_to_current_client(session: &Arc<VodAudioSession>, chunk: Bytes) {
    let sender = {
        let guard = session
            .current_client
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.clone()
    };
    let Some(sender) = sender else {
        return;
    };
    // Blocked here means the HTTP consumer is slow, not that ffmpeg stalled.
    session.blocked_on_send.store(true, Ordering::SeqCst);
    let send_result = sender.send(chunk).await;
    session.blocked_on_send.store(false, Ordering::SeqCst);
    if send_result.is_err() {
        let mut guard = session
            .current_client
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.as_ref().is_some_and(|current| current.same_channel(&sender)) {
            *guard = None;
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
            _ = session.kill_notify.notified() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
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

// --- Teardown ---

/// Never blocks on the child mutex; killing goes through kill_notify instead.
async fn teardown_io(session: &Arc<VodAudioSession>) {
    session.torn_down.store(true, Ordering::SeqCst);
    session.kill_notify.notify_one();

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
                "aresample=async=1:first_pts=0",
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
        let ss_index = args.iter().position(|arg| arg == "-ss").expect("-ss must be present");
        let i_index = args.iter().position(|arg| arg == "-i").expect("-i must be present");
        assert!(ss_index < i_index, "-ss must precede -i for input seeking");
        assert_eq!(args[ss_index + 1], "12.5");
    }

    #[test]
    fn build_ffmpeg_args_omits_ss_for_negligible_start_seconds() {
        let args = build_ffmpeg_args("http://127.0.0.1:9000/forward/abc/stream", 0, 0.05, false);
        assert!(!args.iter().any(|arg| arg == "-ss"), "-ss must be omitted below the threshold");
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
    fn demuxers_support_matroska_and_mov_requires_both() {
        let listing = " D  matroska,webm      Matroska / WebM\n D  mov,mp4,m4a,3gp     QuickTime / MOV\n";
        assert!(demuxers_support_matroska_and_mov(listing));
        assert!(!demuxers_support_matroska_and_mov(" D  mpegts     MPEG-TS"));
    }

    #[test]
    fn stderr_tail_suffix_is_empty_when_no_lines_captured() {
        let session = Arc::new(VodAudioSession {
            session_id: "sess".to_string(),
            upstream_url: "https://example.test/movie.mkv".to_string(),
            user_agent: None,
            authorization: None,
            torn_down: AtomicBool::new(false),
            current_client: Mutex::new(None),
            stderr_tail: Mutex::new(VecDeque::new()),
            child: tokio::sync::Mutex::new(None),
            kill_notify: Notify::new(),
            io_tasks: Mutex::new(Vec::new()),
            watchdog_task: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            blocked_on_send: AtomicBool::new(false),
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
            current_client: Mutex::new(None),
            stderr_tail: Mutex::new(tail),
            child: tokio::sync::Mutex::new(None),
            kill_notify: Notify::new(),
            io_tasks: Mutex::new(Vec::new()),
            watchdog_task: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            blocked_on_send: AtomicBool::new(false),
        });
        assert_eq!(
            stderr_tail_suffix(&session),
            " (first warning | second warning)"
        );
    }

    fn test_vod_audio_session() -> Arc<VodAudioSession> {
        Arc::new(VodAudioSession {
            session_id: "sess".to_string(),
            upstream_url: "https://example.test/movie.mkv".to_string(),
            user_agent: None,
            authorization: None,
            torn_down: AtomicBool::new(false),
            current_client: Mutex::new(None),
            stderr_tail: Mutex::new(VecDeque::new()),
            child: tokio::sync::Mutex::new(None),
            kill_notify: Notify::new(),
            io_tasks: Mutex::new(Vec::new()),
            watchdog_task: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            blocked_on_send: AtomicBool::new(false),
        })
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
}
