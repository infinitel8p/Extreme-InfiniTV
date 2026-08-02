// ffmpeg live audio-transcode proxy (desktop only): copies video, transcodes audio to AAC.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::external_player;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ERROR_EVENT: &str = "xt:audioproxy-error";
const DETECT_TIMEOUT_MS: u64 = 2000;
const DETECT_POLL_INTERVAL_MS: u64 = 25;
const OUTPUT_CHUNK_SIZE: usize = 64 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 256;
const STDERR_RING_CAPACITY: usize = 10;
const STARTUP_SILENCE_TIMEOUT: Duration = Duration::from_secs(10);
const STDOUT_STALL_TIMEOUT: Duration = Duration::from_secs(20);
const STALL_CHECK_INTERVAL: Duration = Duration::from_secs(1);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type ActiveSlot = Arc<Mutex<Option<Arc<AudioSession>>>>;
// Keyed by id so unregister can reap a session that is no longer the active one.
type SessionMap = Arc<Mutex<HashMap<String, Arc<AudioSession>>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FfmpegSource {
    Custom,
    Bundled,
    System,
}

impl FfmpegSource {
    fn as_str(self) -> &'static str {
        match self {
            FfmpegSource::Custom => "custom",
            FfmpegSource::Bundled => "bundled",
            FfmpegSource::System => "system",
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedFfmpeg {
    path: String,
    version: String,
    source: FfmpegSource,
}

// Keyed by the custom_path that produced it, so a changed path never returns a stale hit.
struct CachedResolution {
    custom_path: Option<String>,
    resolved: ResolvedFfmpeg,
    custom_error: Option<String>,
}

struct ServerHandle {
    port: u16,
    // Kept for a future "stop the proxy" path; only a lost startup race fires it today.
    #[allow(dead_code)]
    shutdown: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct AudioProxyState {
    server: Mutex<Option<ServerHandle>>,
    active: ActiveSlot,
    sessions: SessionMap,
    resolved_ffmpeg: Mutex<Option<CachedResolution>>,
    // Serializes teardown -> spawn -> activate so a lost race can't orphan ffmpeg.
    register_lock: tokio::sync::Mutex<()>,
}

struct AudioSession {
    session_id: String,
    torn_down: AtomicBool,
    // Sender for the currently connected HTTP client, if any; a new GET replaces it, dropping the previous sender and ending its stream.
    current_client: Mutex<Option<mpsc::Sender<Bytes>>>,
    stderr_tail: Mutex<VecDeque<String>>,
    // Held only until run_watchdog takes ownership.
    child: tokio::sync::Mutex<Option<Child>>,
    // Wakes teardown without touching the child mutex.
    kill_notify: Notify,
    // Any of the fetch/output/stderr tasks may self-abort via finish_with_error -> teardown_io; harmless since abort only lands at the task's next await point.
    io_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    // Kept separate from `io_tasks` so the watchdog never has to abort its own handle.
    watchdog_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    // Reset on every stdout read; the watchdog compares its age against STDOUT_STALL_TIMEOUT.
    last_activity: Mutex<Instant>,
    // True while the output task is blocked pushing into the bounded channel, so a slow HTTP consumer never reads as a stall.
    blocked_on_send: AtomicBool,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn audio_transcode_available(
    state: tauri::State<'_, AudioProxyState>,
    custom_path: Option<String>,
    force: Option<bool>,
) -> Result<Value, String> {
    let (resolved, custom_error) =
        resolve_with_cache(&state, custom_path, force.unwrap_or(false)).await;
    match resolved {
        Some(resolved) => Ok(json!({
            "available": true,
            "version": resolved.version,
            "path": resolved.path,
            "source": resolved.source.as_str(),
            "customError": custom_error,
        })),
        None => Ok(json!({
            "available": false,
            "version": Value::Null,
            "path": Value::Null,
            "source": Value::Null,
            "customError": custom_error,
        })),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterAudioTranscodeResponse {
    pub session_id: String,
    pub local_url: String,
}

#[tauri::command]
pub async fn register_audio_transcode(
    app: AppHandle,
    state: tauri::State<'_, AudioProxyState>,
    url: String,
    user_agent: Option<String>,
    authorization: Option<String>,
    ffmpeg_path: Option<String>,
) -> Result<RegisterAudioTranscodeResponse, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("OTHER:{e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("OTHER:url must be http or https".to_string());
    }

    let _register_guard = state.register_lock.lock().await;

    // One live session at a time: tear down whatever was there before starting the next.
    teardown_active_session(&state).await;

    let resolved_ffmpeg_path = resolve_and_cache_ffmpeg(&state, ffmpeg_path).await?;
    let port = ensure_server_started(&state).await?;

    let mut command = TokioCommand::new(&resolved_ffmpeg_path);
    command
        .args(build_ffmpeg_args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("OTHER:failed to spawn ffmpeg: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "OTHER:ffmpeg stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "OTHER:ffmpeg stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "OTHER:ffmpeg stderr unavailable".to_string())?;

    let token = generate_token();
    let (first_byte_tx, first_byte_rx) = oneshot::channel();

    let session = Arc::new(AudioSession {
        session_id: token.clone(),
        torn_down: AtomicBool::new(false),
        current_client: Mutex::new(None),
        stderr_tail: Mutex::new(VecDeque::new()),
        child: tokio::sync::Mutex::new(Some(child)),
        kill_notify: Notify::new(),
        io_tasks: Mutex::new(Vec::new()),
        watchdog_task: Mutex::new(None),
        last_activity: Mutex::new(Instant::now()),
        blocked_on_send: AtomicBool::new(false),
    });

    // Redirects are followed by hand so the User-Agent survives every hop.
    let http_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let fetch_handle = spawn_fetch_task(
        app.clone(),
        session.clone(),
        http_client,
        url,
        user_agent,
        authorization,
        stdin,
    );
    let output_handle = spawn_output_task(session.clone(), stdout, first_byte_tx);
    let stderr_handle = spawn_stderr_task(session.clone(), stderr);
    {
        let mut tasks = session
            .io_tasks
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        tasks.push(fetch_handle);
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

    activate_session(&state, session);

    Ok(RegisterAudioTranscodeResponse {
        session_id: token.clone(),
        local_url: format!("http://127.0.0.1:{port}/live/{token}"),
    })
}

#[tauri::command]
pub async fn unregister_audio_transcode(
    state: tauri::State<'_, AudioProxyState>,
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

fn activate_session(state: &AudioProxyState, session: Arc<AudioSession>) {
    {
        let mut sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.insert(session.session_id.clone(), session.clone());
    }
    let mut active = state
        .active
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *active = Some(session);
}

async fn teardown_active_session(state: &AudioProxyState) {
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

// ---------------------------------------------------------------------------
// ffmpeg argv (pure, unit-tested)
// ---------------------------------------------------------------------------

fn build_ffmpeg_args() -> Vec<String> {
    [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-fflags",
        "nobuffer",
        "-probesize",
        "1000000",
        "-analyzeduration",
        "1000000",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
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
    .into_iter()
    .map(str::to_string)
    .collect()
}

// ---------------------------------------------------------------------------
// ffmpeg binary resolution
// ---------------------------------------------------------------------------

fn classify_io_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("NOT_FOUND:{err}"),
        std::io::ErrorKind::PermissionDenied => format!("PERMISSION:{err}"),
        _ => format!("OTHER:{err}"),
    }
}

fn ffmpeg_candidates() -> Vec<(String, FfmpegSource)> {
    let mut candidates = Vec::new();
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let sidecar_name = if cfg!(windows) { "infinitv-ffmpeg.exe" } else { "infinitv-ffmpeg" };
            candidates.push((
                parent.join(sidecar_name).to_string_lossy().into_owned(),
                FfmpegSource::Bundled,
            ));
        }
    }
    candidates.push(("ffmpeg".to_string(), FfmpegSource::System));
    candidates
}

fn normalize_custom_path(path: Option<String>) -> Option<String> {
    path.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// A failing custom path is reported but never blocks the bundled/system fallback.
async fn resolve_ffmpeg(custom_path: Option<&str>) -> (Option<ResolvedFfmpeg>, Option<String>) {
    let mut custom_error = None;
    if let Some(custom) = custom_path {
        match external_player::validate_arg(custom, "ffmpeg path") {
            Ok(()) => match probe_ffmpeg(custom.to_string()).await {
                Ok(version) => {
                    return (
                        Some(ResolvedFfmpeg {
                            path: custom.to_string(),
                            version,
                            source: FfmpegSource::Custom,
                        }),
                        None,
                    );
                }
                Err(err) => custom_error = Some(err),
            },
            Err(err) => custom_error = Some(err),
        }
    }
    for (candidate, source) in ffmpeg_candidates() {
        if let Ok(version) = probe_ffmpeg(candidate.clone()).await {
            return (
                Some(ResolvedFfmpeg {
                    path: candidate,
                    version,
                    source,
                }),
                custom_error,
            );
        }
    }
    (None, custom_error)
}

async fn probe_ffmpeg(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || probe_ffmpeg_blocking(&path))
        .await
        .map_err(|e| format!("OTHER:join: {e}"))?
}

fn probe_ffmpeg_blocking(path: &str) -> Result<String, String> {
    let mut command = std::process::Command::new(path);
    command
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| classify_io_error(&e))?;

    let started = Instant::now();
    let budget = Duration::from_millis(DETECT_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let output = child.wait_with_output().map_err(|e| format!("OTHER:{e}"))?;
                let text = String::from_utf8_lossy(&output.stdout).into_owned();
                let first_line = text
                    .lines()
                    .next()
                    .map(|line| line.trim().to_string())
                    .unwrap_or_default();
                if first_line.is_empty() {
                    return Err("OTHER:ffmpeg -version produced no output".to_string());
                }
                return Ok(first_line);
            }
            Ok(None) => {
                if started.elapsed() >= budget {
                    let _ = child.kill();
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Err(format!(
                        "TIMEOUT:{path} did not exit within {DETECT_TIMEOUT_MS}ms"
                    ));
                }
                std::thread::sleep(Duration::from_millis(DETECT_POLL_INTERVAL_MS));
            }
            Err(e) => return Err(format!("OTHER:{e}")),
        }
    }
}

// Pure cache-lookup decision: a hit requires both an unforced call and a matching custom_path.
fn cached_hit(
    cached: &Option<CachedResolution>,
    normalized_custom: &Option<String>,
    force: bool,
) -> Option<(ResolvedFfmpeg, Option<String>)> {
    if force {
        return None;
    }
    let cache = cached.as_ref()?;
    if cache.custom_path == *normalized_custom {
        Some((cache.resolved.clone(), cache.custom_error.clone()))
    } else {
        None
    }
}

// `force` skips the cache read so a replaced binary at the same path is re-probed.
async fn resolve_with_cache(
    state: &AudioProxyState,
    custom_path: Option<String>,
    force: bool,
) -> (Option<ResolvedFfmpeg>, Option<String>) {
    let normalized_custom = normalize_custom_path(custom_path);
    {
        let cached = state
            .resolved_ffmpeg
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((resolved, custom_error)) = cached_hit(&cached, &normalized_custom, force) {
            return (Some(resolved), custom_error);
        }
    }
    let (resolved, custom_error) = resolve_ffmpeg(normalized_custom.as_deref()).await;
    if let Some(resolved) = resolved.clone() {
        let mut cached = state
            .resolved_ffmpeg
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *cached = Some(CachedResolution {
            custom_path: normalized_custom,
            resolved,
            custom_error: custom_error.clone(),
        });
    }
    (resolved, custom_error)
}

async fn resolve_and_cache_ffmpeg(
    state: &AudioProxyState,
    custom_path: Option<String>,
) -> Result<String, String> {
    let (resolved, custom_error) = resolve_with_cache(state, custom_path, false).await;
    match resolved {
        Some(resolved) => Ok(resolved.path),
        None => Err(custom_error.unwrap_or_else(|| "NOT_FOUND:ffmpeg binary not found".to_string())),
    }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async fn ensure_server_started(state: &AudioProxyState) -> Result<u16, String> {
    {
        let guard = state
            .server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(handle) = guard.as_ref() {
            return Ok(handle.port);
        }
    }

    let (port, shutdown) = start_server(state.active.clone())
        .await
        .map_err(|e| format!("OTHER:failed to start audio proxy server: {e}"))?;

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
    active: ActiveSlot,
    port: u16,
}

async fn start_server(active: ActiveSlot) -> std::io::Result<(u16, oneshot::Sender<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let server_state = Arc::new(ServerState { active, port });
    let router = axum::Router::new()
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
            log::warn!("[audio-proxy] server exited: {error}");
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

    // Storing the sender drops the previous one, ending the previous response stream.
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
            log::warn!("[audio-proxy] failed to build response: {error}");
            cors_response(StatusCode::INTERNAL_SERVER_ERROR, "response build failed")
        }
    }
}

// ---------------------------------------------------------------------------
// Pipeline tasks
// ---------------------------------------------------------------------------

fn spawn_fetch_task(
    app: AppHandle,
    session: Arc<AudioSession>,
    client: reqwest::Client,
    url: String,
    user_agent: Option<String>,
    authorization: Option<String>,
    mut stdin: tokio::process::ChildStdin,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let response = match fetch_following_redirects(
            &client,
            &url,
            user_agent.as_deref(),
            authorization.as_deref(),
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                finish_with_error(
                    &app,
                    &session,
                    format!("OTHER:upstream fetch failed: {}", error.without_url()),
                )
                .await;
                return;
            }
        };
        if !response.status().is_success() {
            finish_with_error(
                &app,
                &session,
                format!("OTHER:upstream status {}", response.status().as_u16()),
            )
            .await;
            return;
        }

        let mut wrote_any = false;
        let mut consumer_gone = false;
        let mut upstream_stream = response.bytes_stream();
        while let Some(chunk) = upstream_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if !bytes.is_empty() {
                        wrote_any = true;
                    }
                    if stdin.write_all(&bytes).await.is_err() {
                        consumer_gone = true;
                        break;
                    }
                }
                Err(error) => {
                    finish_with_error(
                        &app,
                        &session,
                        format!("OTHER:upstream stream error: {}", error.without_url()),
                    )
                    .await;
                    return;
                }
            }
        }
        // Upstream EOF: close stdin so ffmpeg flushes its buffers and exits cleanly.
        let _ = stdin.shutdown().await;
        // A 2xx response that streamed nothing means the upstream refused the content silently.
        if !wrote_any && !consumer_gone {
            finish_with_error(&app, &session, "OTHER:upstream sent no data".to_string()).await;
        }
    })
}

const MAX_REDIRECT_HOPS: usize = 5;

fn is_same_origin(original_url: &str, candidate_url: &str) -> bool {
    let Ok(original) = reqwest::Url::parse(original_url) else {
        return false;
    };
    let Ok(candidate) = reqwest::Url::parse(candidate_url) else {
        return false;
    };
    original.scheme() == candidate.scheme()
        && original.host_str() == candidate.host_str()
        && original.port_or_known_default() == candidate.port_or_known_default()
}

// User-Agent survives every hop; Authorization only while on the original origin.
async fn fetch_following_redirects(
    client: &reqwest::Client,
    url: &str,
    user_agent: Option<&str>,
    authorization: Option<&str>,
) -> reqwest::Result<reqwest::Response> {
    let mut current_url = url.to_string();
    let mut hops = 0;
    loop {
        let mut request = client.get(&current_url);
        if let Some(user_agent) = user_agent {
            request = request.header(reqwest::header::USER_AGENT, user_agent);
        }
        if let Some(authorization) = authorization {
            if is_same_origin(url, &current_url) {
                request = request.header(reqwest::header::AUTHORIZATION, authorization);
            }
        }
        let response = request.send().await?;
        if !response.status().is_redirection() || hops >= MAX_REDIRECT_HOPS {
            return Ok(response);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let Some(location) = location else {
            return Ok(response);
        };
        let next_url = reqwest::Url::parse(&current_url).and_then(|base| base.join(&location));
        match next_url {
            Ok(resolved) => {
                current_url = resolved.into();
                hops += 1;
            }
            Err(_) => return Ok(response),
        }
    }
}

fn mark_activity(session: &AudioSession) {
    let mut last_activity = session
        .last_activity
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *last_activity = Instant::now();
}

// Discards the chunk if no client is connected; stdout must still drain.
async fn send_to_current_client(session: &Arc<AudioSession>, chunk: Bytes) {
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
    session: Arc<AudioSession>,
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
    session: Arc<AudioSession>,
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

fn stderr_tail_suffix(session: &AudioSession) -> String {
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

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

// Resolves once stdout has produced nothing for STDOUT_STALL_TIMEOUT while the reader wasn't blocked on the consumer; loops forever otherwise.
async fn wait_for_stdout_stall(session: &Arc<AudioSession>) {
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
    session: Arc<AudioSession>,
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

async fn finish_with_error(app: &AppHandle, session: &Arc<AudioSession>, detail: String) {
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

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/// Safe to call from within an io task: it never touches the watchdog's own handle.
async fn teardown_io(session: &Arc<AudioSession>) {
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
async fn teardown_session(session: &Arc<AudioSession>) {
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
pub fn shutdown(state: &AudioProxyState) {
    {
        let mut active = state
            .active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *active = None;
    }
    let sessions: Vec<Arc<AudioSession>> = {
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
    fn build_ffmpeg_args_matches_the_documented_pipeline() {
        let args = build_ffmpeg_args();
        assert_eq!(
            args,
            vec![
                "-hide_banner",
                "-loglevel",
                "warning",
                "-fflags",
                "nobuffer",
                "-probesize",
                "1000000",
                "-analyzeduration",
                "1000000",
                "-i",
                "pipe:0",
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
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
    fn ffmpeg_candidates_falls_back_to_bare_binary_name() {
        let candidates = ffmpeg_candidates();
        let (path, source) = candidates.last().expect("at least one candidate");
        assert_eq!(path, "ffmpeg");
        assert_eq!(*source, FfmpegSource::System);
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

    fn fake_cached_resolution(custom_path: Option<&str>) -> CachedResolution {
        CachedResolution {
            custom_path: custom_path.map(str::to_string),
            resolved: ResolvedFfmpeg {
                path: "/usr/bin/ffmpeg".to_string(),
                version: "ffmpeg version 6.0".to_string(),
                source: FfmpegSource::Custom,
            },
            custom_error: None,
        }
    }

    #[test]
    fn cached_hit_returns_none_without_a_cache_entry() {
        assert!(cached_hit(&None, &None, false).is_none());
    }

    #[test]
    fn cached_hit_returns_the_cached_result_when_the_path_matches() {
        let cached = Some(fake_cached_resolution(Some("/usr/bin/ffmpeg")));
        let hit = cached_hit(&cached, &Some("/usr/bin/ffmpeg".to_string()), false);
        assert!(hit.is_some());
    }

    #[test]
    fn cached_hit_returns_none_when_the_path_changed() {
        let cached = Some(fake_cached_resolution(Some("/usr/bin/ffmpeg")));
        let hit = cached_hit(&cached, &Some("/opt/ffmpeg/ffmpeg".to_string()), false);
        assert!(hit.is_none());
    }

    #[test]
    fn cached_hit_returns_none_when_forced_even_with_a_matching_path() {
        let cached = Some(fake_cached_resolution(Some("/usr/bin/ffmpeg")));
        let hit = cached_hit(&cached, &Some("/usr/bin/ffmpeg".to_string()), true);
        assert!(hit.is_none());
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
    fn stderr_tail_suffix_is_empty_when_no_lines_captured() {
        let session = Arc::new(AudioSession {
            session_id: "sess".to_string(),
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
        let session = Arc::new(AudioSession {
            session_id: "sess".to_string(),
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

    #[test]
    fn is_same_origin_keeps_authorization_on_a_same_origin_redirect() {
        assert!(is_same_origin(
            "https://provider.test/live/user/pass/1.ts",
            "https://provider.test/edge/live/user/pass/1.ts"
        ));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_a_different_host() {
        assert!(!is_same_origin(
            "https://provider.test/live/1.ts",
            "https://attacker.test/live/1.ts"
        ));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_a_different_port() {
        assert!(!is_same_origin(
            "http://provider.test:8080/live/1.ts",
            "http://provider.test:8081/live/1.ts"
        ));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_a_different_scheme() {
        assert!(!is_same_origin(
            "https://provider.test/live/1.ts",
            "http://provider.test/live/1.ts"
        ));
    }

    // Scheme upgrades count as cross-origin, so the credential is dropped on http -> https too.
    #[test]
    fn is_same_origin_drops_authorization_when_http_upgrades_to_https_on_the_same_host() {
        assert!(!is_same_origin(
            "http://provider.test/live/1.ts",
            "https://provider.test/live/1.ts"
        ));
    }

    #[test]
    fn is_same_origin_normalizes_explicit_default_ports() {
        assert!(is_same_origin(
            "https://provider.test/live/1.ts",
            "https://provider.test:443/live/1.ts"
        ));
        assert!(is_same_origin(
            "http://provider.test:80/live/1.ts",
            "http://provider.test/live/1.ts"
        ));
    }

    #[test]
    fn is_same_origin_drops_authorization_for_an_unparseable_url() {
        assert!(!is_same_origin("https://provider.test/live/1.ts", "not a url"));
    }

    fn test_audio_session_with_id(session_id: &str) -> Arc<AudioSession> {
        Arc::new(AudioSession {
            session_id: session_id.to_string(),
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

    fn test_audio_session() -> Arc<AudioSession> {
        test_audio_session_with_id("sess")
    }

    // Register's critical section without ffmpeg: the sleep stands in for the spawn.
    async fn register_under_lock(state: &AudioProxyState, session_id: &str, spawn_delay: Duration) {
        let _register_guard = state.register_lock.lock().await;
        teardown_active_session(state).await;
        tokio::time::sleep(spawn_delay).await;
        activate_session(state, test_audio_session_with_id(session_id));
    }

    #[tokio::test]
    async fn concurrent_registrations_leave_exactly_one_live_session() {
        let state = Arc::new(AudioProxyState::default());

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

    // Regression test: teardown_io blocking while the watchdog owned the child.
    #[tokio::test]
    async fn teardown_io_wakes_a_task_parked_on_kill_notify_without_blocking() {
        let session = test_audio_session();

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
