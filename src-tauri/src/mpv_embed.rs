// Embedded mpv player: persistent JSON-IPC session over a named pipe, Windows-only for now.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
#[cfg(target_os = "windows")]
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::process::Stdio;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "windows")]
use std::time::Instant;

#[cfg(target_os = "windows")]
use tokio::io::{split, AsyncBufReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
#[cfg(target_os = "windows")]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
#[cfg(target_os = "windows")]
use tokio::process::{Child, Command as TokioCommand};
#[cfg(target_os = "windows")]
use tokio::sync::{oneshot, Notify};

#[cfg(target_os = "windows")]
use crate::external_player;

#[cfg(target_os = "windows")]
use windows::core::{BOOL, PCWSTR};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{ERROR_PIPE_BUSY, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    CreateRoundRectRgn, DeleteObject, GetMonitorInfoW, MonitorFromWindow, SetWindowRgn, MONITORINFO,
    MONITOR_DEFAULTTONEAREST,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, EnumChildWindows, GetWindowLongPtrW,
    GetWindowThreadProcessId, IsWindow, RegisterClassExW, SetParent, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, CS_HREDRAW, CS_VREDRAW, GWL_STYLE, HWND_BOTTOM, SW_HIDE, SW_SHOWNA, SWP_NOACTIVATE,
    WNDCLASSEXW, WS_CLIPCHILDREN, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    WS_VISIBLE,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const IPC_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const MPV_IPC_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const CHILD_WINDOW_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(target_os = "windows")]
const CHILD_WINDOW_POLL_BUDGET: Duration = Duration::from_secs(30);

const TIME_POS_MIN_INTERVAL: Duration = Duration::from_millis(250);

const OBSERVED_PROPERTIES: &[&str] = &[
    "pause",
    "time-pos",
    "duration",
    "core-idle",
    "paused-for-cache",
    "seeking",
    "eof-reached",
    "idle-active",
    "demuxer-cache-duration",
    "video-bitrate",
    "hwdec-current",
    "frame-drop-count",
    "estimated-vf-fps",
    "width",
    "height",
    "video-codec",
    "audio-codec-name",
    "track-list",
    "media-title",
    "sub-delay",
    "aid",
    "sid",
];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOptions {
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub start_seconds: Option<f64>,
    pub is_live: bool,
    pub network_timeout_seconds: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    #[serde(default)]
    pub radius: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvEmbedAvailability {
    pub supported: bool,
    pub reason: Option<String>,
    pub binary: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvEmbedSession {
    pub session_id: String,
    pub pid: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvEmbedStatus {
    pub running: bool,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub pip_active: bool,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[derive(Default)]
pub struct MpvEmbedState {
    session: Mutex<Option<Arc<MpvSession>>>,
}

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
pub struct MpvEmbedState;

#[cfg(target_os = "windows")]
struct MpvSession {
    session_id: String,
    pid: u32,
    parent_hwnd: isize,
    child_hwnd: Mutex<Option<isize>>,
    desired: DesiredState,
    watcher_active: AtomicBool,
    ipc: Arc<MpvIpcClient>,
    child: tokio::sync::Mutex<Option<Child>>,
    kill_notify: Notify,
    torn_down: AtomicBool,
    reader_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pip: Mutex<Option<isize>>,
    applied_bounds: Mutex<Option<Bounds>>,
}

/// Bounds/visibility requested by the frontend, applied once the surface window exists.
#[cfg(target_os = "windows")]
struct DesiredState {
    bounds: Mutex<Option<Bounds>>,
    visible: AtomicBool,
}

#[cfg(target_os = "windows")]
impl DesiredState {
    fn new(initial_bounds: Bounds, initial_visible: bool) -> Self {
        Self { bounds: Mutex::new(Some(initial_bounds)), visible: AtomicBool::new(initial_visible) }
    }

    fn set_bounds(&self, bounds: Bounds) {
        let mut guard = self.bounds.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(bounds);
    }

    fn bounds(&self) -> Option<Bounds> {
        *self.bounds.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    fn set_visible(&self, visible: bool) {
        self.visible.store(visible, Ordering::SeqCst);
    }

    fn visible(&self) -> bool {
        self.visible.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// Persistent JSON-IPC client
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
struct MpvIpcClient {
    writer: tokio::sync::Mutex<WriteHalf<NamedPipeClient>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_request_id: AtomicU64,
    closed: AtomicBool,
}

#[cfg(target_os = "windows")]
impl MpvIpcClient {
    fn next_request_id(&self) -> u64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn send_request(&self, mut payload: Value, timeout: Duration) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("IPC:mpv connection closed".to_string());
        }
        let request_id = self.next_request_id();
        payload["request_id"] = json!(request_id);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|poison| poison.into_inner());
            pending.insert(request_id, sender);
        }
        let mut line = serde_json::to_vec(&payload).map_err(|error| format!("OTHER:{error}"))?;
        line.push(b'\n');
        {
            let mut writer = self.writer.lock().await;
            if let Err(error) = writer.write_all(&line).await {
                self.drop_pending(request_id);
                return Err(format!("IPC:{error}"));
            }
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(reply)) => parse_mpv_reply(reply),
            Ok(Err(_)) => Err("IPC:mpv connection closed".to_string()),
            Err(_) => {
                self.drop_pending(request_id);
                Err("TIMEOUT:mpv did not reply".to_string())
            }
        }
    }

    fn drop_pending(&self, request_id: u64) {
        let mut pending = self.pending.lock().unwrap_or_else(|poison| poison.into_inner());
        pending.remove(&request_id);
    }

    fn fail_all_pending(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let mut pending = self.pending.lock().unwrap_or_else(|poison| poison.into_inner());
        for (_, sender) in pending.drain() {
            let _ = sender.send(Value::Null);
        }
    }
}

fn parse_mpv_reply(reply: Value) -> Result<Value, String> {
    let error = reply.get("error").and_then(Value::as_str).unwrap_or("");
    if error.is_empty() || error == "success" {
        Ok(reply.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(format!("IPC:mpv replied {error}"))
    }
}

enum MpvIpcFrame {
    Reply { request_id: u64, value: Value },
    Event(Value),
    Unknown,
}

fn classify_ipc_frame(line: &str) -> MpvIpcFrame {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return MpvIpcFrame::Unknown;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
        return MpvIpcFrame::Unknown;
    };
    if let Some(request_id) = parsed.get("request_id").and_then(Value::as_u64) {
        MpvIpcFrame::Reply { request_id, value: parsed }
    } else if parsed.get("event").is_some() {
        MpvIpcFrame::Event(parsed)
    } else {
        MpvIpcFrame::Unknown
    }
}

#[cfg(target_os = "windows")]
async fn connect_ipc_with_retry(pipe_name: &str, budget: Duration) -> std::io::Result<NamedPipeClient> {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(error) if is_retryable_pipe_error(&error) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(target_os = "windows")]
fn is_retryable_pipe_error(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(ERROR_PIPE_BUSY.0 as i32)
}

#[cfg(target_os = "windows")]
async fn run_reader(
    app: AppHandle,
    session_id: String,
    mut reader: BufReader<ReadHalf<NamedPipeClient>>,
    ipc: Arc<MpvIpcClient>,
    emit_state: Arc<PropertyEmitState>,
) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => match classify_ipc_frame(&line) {
                MpvIpcFrame::Reply { request_id, value } => {
                    let sender = {
                        let mut pending = ipc.pending.lock().unwrap_or_else(|poison| poison.into_inner());
                        pending.remove(&request_id)
                    };
                    if let Some(sender) = sender {
                        let _ = sender.send(value);
                    }
                }
                MpvIpcFrame::Event(value) => handle_mpv_event(&app, &session_id, &emit_state, &value),
                MpvIpcFrame::Unknown => {}
            },
        }
    }
    ipc.fail_all_pending();
}

// ---------------------------------------------------------------------------
// Property-change emission (throttled time-pos, immediate otherwise)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
struct PropertyEmitState {
    pending: Mutex<HashMap<String, Value>>,
    last_time_pos_emit: Mutex<Instant>,
}

#[cfg(target_os = "windows")]
impl PropertyEmitState {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            last_time_pos_emit: Mutex::new(Instant::now() - TIME_POS_MIN_INTERVAL),
        }
    }
}

fn camel_prop_name(mpv_name: &str) -> &str {
    match mpv_name {
        "time-pos" => "timePos",
        "core-idle" => "coreIdle",
        "paused-for-cache" => "pausedForCache",
        "eof-reached" => "eofReached",
        "idle-active" => "idleActive",
        "demuxer-cache-duration" => "demuxerCacheDuration",
        "video-bitrate" => "videoBitrate",
        "hwdec-current" => "hwdecCurrent",
        "frame-drop-count" => "frameDropCount",
        "estimated-vf-fps" => "estimatedVfFps",
        "video-codec" => "videoCodec",
        "audio-codec-name" => "audioCodecName",
        "track-list" => "trackList",
        "media-title" => "mediaTitle",
        "sub-delay" => "subDelay",
        other => other,
    }
}

fn should_flush_time_pos(elapsed_since_last: Duration) -> bool {
    elapsed_since_last >= TIME_POS_MIN_INTERVAL
}

#[cfg(target_os = "windows")]
fn record_property_change(
    app: &AppHandle,
    session_id: &str,
    emit_state: &PropertyEmitState,
    mpv_name: &str,
    value: Value,
) {
    let camel = camel_prop_name(mpv_name).to_string();
    let mut pending = emit_state.pending.lock().unwrap_or_else(|poison| poison.into_inner());
    pending.insert(camel, value);

    let should_flush = if mpv_name == "time-pos" {
        let mut last = emit_state
            .last_time_pos_emit
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if should_flush_time_pos(last.elapsed()) {
            *last = Instant::now();
            true
        } else {
            false
        }
    } else {
        true
    };

    if should_flush {
        let props: HashMap<String, Value> = std::mem::take(&mut *pending);
        drop(pending);
        let _ = app.emit("xt:mpv-state", json!({ "sessionId": session_id, "props": props }));
    }
}

#[cfg(target_os = "windows")]
fn handle_mpv_event(app: &AppHandle, session_id: &str, emit_state: &PropertyEmitState, parsed: &Value) {
    let event_name = parsed.get("event").and_then(Value::as_str).unwrap_or("");
    if event_name == "property-change" {
        let Some(name) = parsed.get("name").and_then(Value::as_str) else { return };
        let value = parsed.get("data").cloned().unwrap_or(Value::Null);
        record_property_change(app, session_id, emit_state, name, value);
        return;
    }
    let kind = match event_name {
        "file-loaded" | "end-file" | "playback-restart" | "start-file" => event_name,
        "log-message" => "log",
        _ => return,
    };
    let reason = parsed.get("reason").and_then(Value::as_str).map(str::to_string);
    let detail = parsed
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| parsed.get("file_error").and_then(Value::as_str))
        .map(str::to_string);
    let _ = app.emit(
        "xt:mpv-event",
        json!({ "sessionId": session_id, "kind": kind, "reason": reason, "detail": detail }),
    );
}

#[cfg(target_os = "windows")]
async fn register_observed_properties(session: &Arc<MpvSession>) {
    for (index, name) in OBSERVED_PROPERTIES.iter().enumerate() {
        let observe_id = (index + 1) as u64;
        let request = json!({ "command": ["observe_property", observe_id, name] });
        if let Err(error) = session.ipc.send_request(request, MPV_IPC_TIMEOUT).await {
            log::warn!("[mpv-embed] observe_property {name} failed: {error}");
        }
    }
}

// ---------------------------------------------------------------------------
// mpv argv / loadfile options (pure)
// ---------------------------------------------------------------------------

fn build_mpv_embed_args(wid: isize, pipe_name: &str, log_file: &str) -> Vec<String> {
    vec![
        format!("--wid={wid}"),
        format!("--input-ipc-server={pipe_name}"),
        "--idle=yes".to_string(),
        "--force-window=immediate".to_string(),
        "--keep-open=yes".to_string(),
        "--no-osc".to_string(),
        "--osd-level=0".to_string(),
        "--no-input-default-bindings".to_string(),
        "--input-vo-keyboard=no".to_string(),
        "--no-input-cursor".to_string(),
        "--cursor-autohide=no".to_string(),
        "--no-window-dragging".to_string(),
        "--focus-on=never".to_string(),
        "--msg-level=all=warn".to_string(),
        format!("--log-file={log_file}"),
        "--no-config".to_string(),
    ]
}

fn percent_encode_value(value: &str) -> String {
    format!("%{}%{}", value.len(), value)
}

fn build_loadfile_options(options: &LoadOptions) -> Option<String> {
    let mut entries: Vec<String> = Vec::new();
    if let Some(user_agent) = options.user_agent.as_deref().filter(|value| !value.is_empty()) {
        entries.push(format!("user-agent={}", percent_encode_value(user_agent)));
    }
    if let Some(referer) = options.referer.as_deref().filter(|value| !value.is_empty()) {
        entries.push(format!("referrer={}", percent_encode_value(referer)));
    }
    if !options.is_live {
        if let Some(start_seconds) = options.start_seconds.filter(|value| *value > 0.0) {
            entries.push(format!("start={}", percent_encode_value(&start_seconds.to_string())));
        }
    }
    if let Some(timeout) = options.network_timeout_seconds.filter(|value| *value > 0.0) {
        entries.push(format!("network-timeout={}", percent_encode_value(&timeout.to_string())));
    }
    if entries.is_empty() {
        None
    } else {
        Some(entries.join(","))
    }
}

// mpv 0.38 moved loadfile options behind a new index arg
fn build_loadfile_command(url: &str, options: &LoadOptions, use_index_form: bool) -> Value {
    match build_loadfile_options(options) {
        Some(opts) if use_index_form => json!({ "command": ["loadfile", url, "replace", -1, opts] }),
        Some(opts) => json!({ "command": ["loadfile", url, "replace", opts] }),
        None => json!({ "command": ["loadfile", url, "replace"] }),
    }
}

fn is_invalid_parameter_reply(error: &str) -> bool {
    error.ends_with("invalid parameter")
}

// mpv issue 10189: an invalid wid makes mpv spawn a detached window instead of embedding.
fn validate_hwnd(value: isize) -> Result<(), String> {
    if value <= 0 {
        return Err(format!("OTHER:invalid parent window handle ({value})"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

// Only the first shared discovery hit ranks below our own tiers.
fn build_mpv_candidates(
    sidecar_env: Option<String>,
    bundled_dir: Option<PathBuf>,
    configured_env: Option<String>,
    discovered: Vec<String>,
) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(value) = sidecar_env {
        candidates.push(value);
    }
    if let Some(dir) = bundled_dir {
        candidates.push(dir.join("infinitv-mpv.exe").to_string_lossy().into_owned());
    }
    if let Some(value) = configured_env {
        candidates.push(value);
    }
    if let Some(first) = discovered.into_iter().next() {
        candidates.push(first);
    }
    candidates
}

#[cfg(target_os = "windows")]
fn normalize_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "windows")]
fn mpv_binary_candidates() -> Vec<String> {
    build_mpv_candidates(
        normalize_env("XT_MPV_SIDECAR_PATH"),
        std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf)),
        normalize_env("XT_MPV_PATH"),
        external_player::discover_mpv_candidates(),
    )
}

#[cfg(target_os = "windows")]
fn resolve_mpv_binary() -> Option<String> {
    mpv_binary_candidates().into_iter().find(|candidate| Path::new(candidate).exists())
}

// ---------------------------------------------------------------------------
// Win32 surface handling
// ---------------------------------------------------------------------------

// tao never sets WS_CLIPCHILDREN on the main window; without it the parent repaints over the video.
#[cfg(target_os = "windows")]
fn apply_clip_children(hwnd: HWND) {
    unsafe {
        let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let updated_style = current_style | (WS_CLIPCHILDREN.0 as isize);
        if updated_style != current_style {
            SetWindowLongPtrW(hwnd, GWL_STYLE, updated_style);
        }
    }
}

#[cfg(target_os = "windows")]
struct EnumChildData {
    target_pid: u32,
    found: Option<isize>,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_child_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let data = unsafe { &mut *(lparam.0 as *mut EnumChildData) };
    let mut process_id: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    if process_id == data.target_pid {
        data.found = Some(hwnd.0 as isize);
        BOOL(0)
    } else {
        BOOL(1)
    }
}

#[cfg(target_os = "windows")]
fn find_mpv_child_window(parent_value: isize, target_pid: u32) -> Option<isize> {
    let parent = HWND(parent_value as *mut core::ffi::c_void);
    let mut data = EnumChildData { target_pid, found: None };
    unsafe {
        let _ = EnumChildWindows(
            Some(parent),
            Some(enum_child_window_proc),
            LPARAM(&mut data as *mut EnumChildData as isize),
        );
    }
    data.found
}

// mpv creates its embedded output window asynchronously after launch, not before.
#[cfg(target_os = "windows")]
fn resolve_child_window(session: &MpvSession) -> Option<isize> {
    {
        let mut cached = session.child_hwnd.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(value) = *cached {
            let hwnd = HWND(value as *mut core::ffi::c_void);
            if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                return Some(value);
            }
            *cached = None;
        }
    }
    let found = find_mpv_child_window(session.parent_hwnd, session.pid)?;
    let mut cached = session.child_hwnd.lock().unwrap_or_else(|poison| poison.into_inner());
    *cached = Some(found);
    Some(found)
}

fn clamp_corner_radius(radius: i32, width: i32, height: i32) -> i32 {
    if radius <= 0 || width <= 0 || height <= 0 {
        return 0;
    }
    radius.min(width.min(height) / 2)
}

#[cfg(target_os = "windows")]
fn apply_child_region(child_value: isize, bounds: &Bounds) {
    let child = HWND(child_value as *mut core::ffi::c_void);
    let radius = clamp_corner_radius(bounds.radius, bounds.width, bounds.height);
    if radius == 0 {
        unsafe { SetWindowRgn(child, None, true) };
        return;
    }
    let diameter = radius * 2;
    let region = unsafe { CreateRoundRectRgn(0, 0, bounds.width, bounds.height, diameter, diameter) };
    if region.is_invalid() {
        return;
    }
    // SetWindowRgn owns the region on success; only delete it ourselves if the call fails.
    if unsafe { SetWindowRgn(child, Some(region), true) } == 0 {
        let _ = unsafe { DeleteObject(region.into()) };
    }
}

#[cfg(target_os = "windows")]
fn position_child_window(child_value: isize, bounds: &Bounds) -> Result<(), String> {
    let child = HWND(child_value as *mut core::ffi::c_void);
    unsafe { SetWindowPos(child, Some(HWND_BOTTOM), bounds.x, bounds.y, bounds.width, bounds.height, SWP_NOACTIVATE) }
        .map_err(|error| format!("OTHER:{error}"))?;
    apply_child_region(child_value, bounds);
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_window_visibility(child_value: isize, visible: bool) {
    let child = HWND(child_value as *mut core::ffi::c_void);
    unsafe {
        let _ = ShowWindow(child, if visible { SW_SHOWNA } else { SW_HIDE });
    }
}

/// Applies bounds to the surface window and records them, so a later identical push can skip.
#[cfg(target_os = "windows")]
fn apply_bounds_and_cache(session: &MpvSession, child_value: isize, bounds: &Bounds) -> Result<(), String> {
    position_child_window(child_value, bounds)?;
    let mut cache = session.applied_bounds.lock().unwrap_or_else(|poison| poison.into_inner());
    *cache = Some(*bounds);
    Ok(())
}

/// Records the requested bounds/visibility, then applies them if the surface already exists.
#[cfg(target_os = "windows")]
fn record_and_apply_bounds(session: &Arc<MpvSession>, bounds: Bounds) -> Result<(), String> {
    session.desired.set_bounds(bounds);
    // A scroll-driven bounds push must not yank the video back into the page while PiP owns it.
    if pip_active(session) {
        return Ok(());
    }
    match resolve_child_window(session) {
        Some(child_value) => {
            let cached = *session.applied_bounds.lock().unwrap_or_else(|poison| poison.into_inner());
            if bounds_already_applied(cached, bounds) {
                return Ok(());
            }
            apply_bounds_and_cache(session, child_value, &bounds)
        }
        None => {
            ensure_watcher_running(session);
            Ok(())
        }
    }
}

fn bounds_already_applied(cached: Option<Bounds>, incoming: Bounds) -> bool {
    cached == Some(incoming)
}

#[cfg(target_os = "windows")]
fn record_and_apply_visible(session: &Arc<MpvSession>, visible: bool) {
    session.desired.set_visible(visible);
    if pip_active(session) {
        return;
    }
    match resolve_child_window(session) {
        Some(child_value) => set_window_visibility(child_value, visible),
        None => ensure_watcher_running(session),
    }
}

#[cfg(target_os = "windows")]
fn apply_desired_state(session: &MpvSession) {
    if pip_active(session) {
        return;
    }
    let Some(child_value) = resolve_child_window(session) else { return };
    if let Some(bounds) = session.desired.bounds() {
        if let Err(error) = apply_bounds_and_cache(session, child_value, &bounds) {
            log::warn!("[mpv-embed] failed to apply queued bounds for session {}: {error}", session.session_id);
        }
    }
    set_window_visibility(child_value, session.desired.visible());
}

fn should_keep_polling(torn_down: bool, elapsed: Duration, budget: Duration) -> bool {
    !torn_down && elapsed < budget
}

#[cfg(target_os = "windows")]
async fn watch_for_child_window(session: Arc<MpvSession>) {
    let start = Instant::now();
    while should_keep_polling(session.torn_down.load(Ordering::SeqCst), start.elapsed(), CHILD_WINDOW_POLL_BUDGET) {
        if resolve_child_window(&session).is_some() {
            apply_desired_state(&session);
            return;
        }
        tokio::time::sleep(CHILD_WINDOW_POLL_INTERVAL).await;
    }
    if !session.torn_down.load(Ordering::SeqCst) {
        log::warn!("[mpv-embed] surface window for session {} did not appear in time", session.session_id);
    }
}

#[cfg(target_os = "windows")]
fn ensure_watcher_running(session: &Arc<MpvSession>) {
    if session.torn_down.load(Ordering::SeqCst) {
        return;
    }
    if session.watcher_active.swap(true, Ordering::SeqCst) {
        return;
    }
    let session = session.clone();
    tauri::async_runtime::spawn(async move {
        watch_for_child_window(session.clone()).await;
        session.watcher_active.store(false, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------------------
// Picture-in-picture
// ---------------------------------------------------------------------------

const PIP_DEFAULT_WIDTH: i32 = 360;
const PIP_MIN_WIDTH: i32 = 160;
const PIP_MARGIN: i32 = 24;
const PIP_DEFAULT_ASPECT: (f64, f64) = (16.0, 9.0);
#[cfg(target_os = "windows")]
const PIP_CLASS_NAME: &str = "XtreamMpvPip";

#[derive(Debug, Clone, Copy, PartialEq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn aspect_from_dimensions(width: Option<f64>, height: Option<f64>) -> Option<(f64, f64)> {
    let width = width.filter(|value| *value > 0.0)?;
    let height = height.filter(|value| *value > 0.0)?;
    Some((width, height))
}

/// Default geometry: fixed width clamped to the work area, aspect-derived height, bottom-right corner.
fn pip_default_geometry(aspect: Option<(f64, f64)>, work_area: WorkArea) -> Bounds {
    let (aspect_width, aspect_height) =
        aspect.filter(|(width, height)| *width > 0.0 && *height > 0.0).unwrap_or(PIP_DEFAULT_ASPECT);
    let max_width = (work_area.width - PIP_MARGIN * 2).max(PIP_MIN_WIDTH);
    let width = PIP_DEFAULT_WIDTH.min(max_width);
    let height = ((width as f64) * aspect_height / aspect_width).round() as i32;
    Bounds {
        x: work_area.x + work_area.width - width - PIP_MARGIN,
        y: work_area.y + work_area.height - height - PIP_MARGIN,
        width,
        height,
        radius: 0,
    }
}

fn should_enter_pip(currently_active: bool) -> bool {
    !currently_active
}

fn should_exit_pip(currently_active: bool) -> bool {
    currently_active
}

#[cfg(target_os = "windows")]
fn pip_active(session: &MpvSession) -> bool {
    session.pip.lock().unwrap_or_else(|poison| poison.into_inner()).is_some()
}

#[cfg(target_os = "windows")]
fn wide_null(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn pip_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn ensure_pip_class_registered() {
    static REGISTERED: std::sync::Once = std::sync::Once::new();
    REGISTERED.call_once(|| unsafe {
        let class_name = wide_null(PIP_CLASS_NAME);
        let instance = GetModuleHandleW(None).map(HINSTANCE::from).unwrap_or(HINSTANCE(std::ptr::null_mut()));
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(pip_wnd_proc),
            hInstance: instance,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        if RegisterClassExW(&class) == 0 {
            log::warn!("[mpv-embed] failed to register the PiP window class");
        }
    });
}

#[cfg(target_os = "windows")]
fn work_area_for_window(hwnd: HWND) -> WorkArea {
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let rect = info.rcWork;
            WorkArea { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
        } else {
            WorkArea { x: 0, y: 0, width: 1920, height: 1080 }
        }
    }
}

#[cfg(target_os = "windows")]
fn create_pip_window(owner: HWND, bounds: &Bounds) -> Result<isize, String> {
    ensure_pip_class_registered();
    let class_name = wide_null(PIP_CLASS_NAME);
    let instance = unsafe { GetModuleHandleW(None) }.map(HINSTANCE::from).unwrap_or(HINSTANCE(std::ptr::null_mut()));
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_POPUP | WS_VISIBLE,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            Some(owner),
            None,
            Some(instance),
            None,
        )
    }
    .map_err(|error| format!("OTHER:{error}"))?;
    apply_clip_children(hwnd);
    Ok(hwnd.0 as isize)
}

#[cfg(target_os = "windows")]
fn destroy_pip_window(hwnd_value: isize) {
    let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
    if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        let _ = unsafe { DestroyWindow(hwnd) };
    }
}

/// Idempotent teardown hook: safe to call whether or not the session is in PiP.
#[cfg(target_os = "windows")]
fn destroy_pip_window_if_active(session: &MpvSession) {
    let pip_hwnd_value = session.pip.lock().unwrap_or_else(|poison| poison.into_inner()).take();
    if let Some(value) = pip_hwnd_value {
        destroy_pip_window(value);
    }
}

#[cfg(target_os = "windows")]
fn reparent_child(child_value: isize, new_parent: HWND) -> Result<(), String> {
    let child = HWND(child_value as *mut core::ffi::c_void);
    let original_style = unsafe { GetWindowLongPtrW(child, GWL_STYLE) };
    unsafe { SetParent(child, Some(new_parent)) }.map_err(|error| format!("OTHER:{error}"))?;
    // SetParent can drop style bits across the reparent on some Windows builds; reassert them.
    unsafe { SetWindowLongPtrW(child, GWL_STYLE, original_style) };
    Ok(())
}

#[cfg(target_os = "windows")]
fn fill_pip_child(child_value: isize, width: i32, height: i32) {
    let fill = Bounds { x: 0, y: 0, width, height, radius: 0 };
    if let Err(error) = position_child_window(child_value, &fill) {
        log::warn!("[mpv-embed] failed to fit the mpv surface into the PiP window: {error}");
    }
}

#[cfg(target_os = "windows")]
async fn pip_enter(app: AppHandle, state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    if !should_enter_pip(pip_active(&session)) {
        return Ok(());
    }
    let child_value =
        resolve_child_window(&session).ok_or_else(|| "NOT_FOUND:mpv surface window not ready".to_string())?;
    let main_window = app.get_webview_window("main").ok_or_else(|| "OTHER:main window unavailable".to_string())?;
    // HWND is not Send, so only its raw value may stay alive across the awaits below.
    let main_hwnd_value = main_window.hwnd().map_err(|error| format!("OTHER:{error}"))?.0 as isize;

    let width = session
        .ipc
        .send_request(json!({ "command": ["get_property", "width"] }), MPV_IPC_TIMEOUT)
        .await
        .ok()
        .and_then(|value| value.as_f64());
    let height = session
        .ipc
        .send_request(json!({ "command": ["get_property", "height"] }), MPV_IPC_TIMEOUT)
        .await
        .ok()
        .and_then(|value| value.as_f64());
    let main_hwnd = HWND(main_hwnd_value as *mut core::ffi::c_void);
    let geometry = pip_default_geometry(aspect_from_dimensions(width, height), work_area_for_window(main_hwnd));

    let pip_hwnd_value = create_pip_window(main_hwnd, &geometry)?;
    let pip_hwnd = HWND(pip_hwnd_value as *mut core::ffi::c_void);
    if let Err(error) = reparent_child(child_value, pip_hwnd) {
        destroy_pip_window(pip_hwnd_value);
        return Err(error);
    }
    fill_pip_child(child_value, geometry.width, geometry.height);
    set_window_visibility(child_value, true);

    let mut guard = session.pip.lock().unwrap_or_else(|poison| poison.into_inner());
    *guard = Some(pip_hwnd_value);
    Ok(())
}

#[cfg(target_os = "windows")]
async fn pip_exit(state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    if !should_exit_pip(pip_active(&session)) {
        return Ok(());
    }
    let pip_hwnd_value = session.pip.lock().unwrap_or_else(|poison| poison.into_inner()).take();
    let Some(pip_hwnd_value) = pip_hwnd_value else { return Ok(()) };

    let main_hwnd = HWND(session.parent_hwnd as *mut core::ffi::c_void);
    if let Some(child_value) = resolve_child_window(&session) {
        if let Err(error) = reparent_child(child_value, main_hwnd) {
            log::warn!("[mpv-embed] failed to reparent the mpv surface back to the main window: {error}");
        }
        if let Some(bounds) = session.desired.bounds() {
            if let Err(error) = apply_bounds_and_cache(&session, child_value, &bounds) {
                log::warn!("[mpv-embed] failed to restore bounds after PiP exit: {error}");
            }
        }
        set_window_visibility(child_value, session.desired.visible());
    }
    destroy_pip_window(pip_hwnd_value);
    Ok(())
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn generate_session_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(target_os = "windows")]
fn pick_embed_pipe() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(r"\\.\pipe\xt-mpv-embed-{}-{}-{}", std::process::id(), nanos, counter)
}

#[cfg(target_os = "windows")]
fn mpv_embed_log_path(app: &AppHandle) -> String {
    match app.path().app_log_dir() {
        Ok(dir) => dir.join("mpv-embed.log").to_string_lossy().into_owned(),
        Err(_) => "mpv-embed.log".to_string(),
    }
}

#[cfg(target_os = "windows")]
fn get_session(state: &MpvEmbedState, session_id: &str) -> Result<Arc<MpvSession>, String> {
    let guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
    match guard.as_ref() {
        Some(session) if session.session_id == session_id => Ok(session.clone()),
        _ => Err(format!("NOT_FOUND:no mpv session '{session_id}'")),
    }
}

#[cfg(target_os = "windows")]
async fn teardown_current_session(app: &AppHandle, state: &MpvEmbedState) {
    let previous = {
        let mut guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.take()
    };
    if let Some(session) = previous {
        teardown_session(app, &session).await;
    }
}

/// Reparents the child out of PiP (if active) and hides it, all before any teardown IPC.
#[cfg(target_os = "windows")]
fn hide_surface_for_navigation(session: &Arc<MpvSession>) {
    let pip_hwnd_value = session.pip.lock().unwrap_or_else(|poison| poison.into_inner()).take();
    if let Some(pip_hwnd_value) = pip_hwnd_value {
        let main_hwnd = HWND(session.parent_hwnd as *mut core::ffi::c_void);
        if let Some(child_value) = resolve_child_window(session) {
            if let Err(error) = reparent_child(child_value, main_hwnd) {
                log::warn!("[mpv-embed] failed to reparent the mpv surface before navigation teardown: {error}");
            }
        }
        destroy_pip_window(pip_hwnd_value);
    }
    record_and_apply_visible(session, false);
}

// Hides synchronously: the frontend's unload-time invoke() dies with the discarded document.
#[cfg(target_os = "windows")]
pub fn on_main_page_navigation(app: &AppHandle) {
    let state = app.state::<MpvEmbedState>();
    let session = {
        let guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.as_ref().cloned()
    };
    let Some(session) = session else { return };
    hide_surface_for_navigation(&session);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_handle.state::<MpvEmbedState>();
        teardown_current_session(&app_handle, &state).await;
    });
}

#[cfg(not(target_os = "windows"))]
pub fn on_main_page_navigation(_app: &AppHandle) {}

/// Kills the child, or wakes `run_exit_watch` to do it; `finish_exit` stays the only emitter.
#[cfg(target_os = "windows")]
async fn teardown_session(app: &AppHandle, session: &Arc<MpvSession>) {
    destroy_pip_window_if_active(session);
    session.kill_notify.notify_one();
    if let Ok(mut guard) = session.child.try_lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let app = app.clone();
            let session = session.clone();
            tauri::async_runtime::spawn(async move {
                let exit_result = child.wait().await;
                let state = app.state::<MpvEmbedState>();
                finish_exit(&app, &state, &session, exit_result);
            });
        }
    }
    session.ipc.fail_all_pending();
    let reader = session
        .reader_task
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take();
    if let Some(handle) = reader {
        handle.abort();
    }
}

#[cfg(target_os = "windows")]
async fn run_exit_watch(app: AppHandle, session: Arc<MpvSession>) {
    let mut child = {
        let mut guard = session.child.lock().await;
        match guard.take() {
            Some(child) => child,
            None => return,
        }
    };
    let exit_result = tokio::select! {
        status = child.wait() => status,
        _ = session.kill_notify.notified() => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    let state = app.state::<MpvEmbedState>();
    finish_exit(&app, &state, &session, exit_result);
}

#[cfg(target_os = "windows")]
fn finish_exit(
    app: &AppHandle,
    state: &MpvEmbedState,
    session: &Arc<MpvSession>,
    exit_result: std::io::Result<std::process::ExitStatus>,
) {
    if session.torn_down.swap(true, Ordering::SeqCst) {
        return;
    }
    destroy_pip_window_if_active(session);
    session.ipc.fail_all_pending();
    {
        let mut guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        if guard.as_ref().is_some_and(|current| current.session_id == session.session_id) {
            *guard = None;
        }
    }
    let (code, detail) = match exit_result {
        Ok(status) => (status.code(), None),
        Err(error) => (None, Some(format!("wait failed: {error}"))),
    };
    let _ = app.emit(
        "xt:mpv-exited",
        json!({ "sessionId": session.session_id, "code": code, "detail": detail }),
    );
}

#[cfg(target_os = "windows")]
async fn start_session(app: AppHandle, state: State<'_, MpvEmbedState>, bounds: Bounds) -> Result<MpvEmbedSession, String> {
    let mpv_path = resolve_mpv_binary().ok_or_else(|| "NOT_FOUND:no mpv binary resolved".to_string())?;

    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "OTHER:main window unavailable".to_string())?;
    let hwnd = main_window.hwnd().map_err(|error| format!("OTHER:{error}"))?;
    let parent_value = hwnd.0 as isize;
    validate_hwnd(parent_value)?;
    apply_clip_children(hwnd);

    teardown_current_session(&app, &state).await;

    let session_id = generate_session_id();
    let pipe_name = pick_embed_pipe();
    let log_file = mpv_embed_log_path(&app);
    let args = build_mpv_embed_args(parent_value, &pipe_name, &log_file);

    let mut command = TokioCommand::new(&mpv_path);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| external_player::classify_io_error(&error))?;
    let pid = child.id().ok_or_else(|| "OTHER:mpv exited before a pid was available".to_string())?;

    let pipe_client = match connect_ipc_with_retry(&pipe_name, IPC_CONNECT_TIMEOUT).await {
        Ok(client) => client,
        Err(error) => {
            let _ = child.start_kill();
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
            return Err(format!("IPC:failed to connect to mpv: {error}"));
        }
    };

    let (read_half, write_half) = split(pipe_client);
    let ipc = Arc::new(MpvIpcClient {
        writer: tokio::sync::Mutex::new(write_half),
        pending: Mutex::new(HashMap::new()),
        next_request_id: AtomicU64::new(1),
        closed: AtomicBool::new(false),
    });
    let emit_state = Arc::new(PropertyEmitState::new());

    let session = Arc::new(MpvSession {
        session_id: session_id.clone(),
        pid,
        parent_hwnd: parent_value,
        child_hwnd: Mutex::new(None),
        desired: DesiredState::new(bounds, true),
        watcher_active: AtomicBool::new(false),
        ipc: ipc.clone(),
        child: tokio::sync::Mutex::new(Some(child)),
        kill_notify: Notify::new(),
        torn_down: AtomicBool::new(false),
        reader_task: Mutex::new(None),
        pip: Mutex::new(None),
        applied_bounds: Mutex::new(None),
    });

    let reader_handle = tauri::async_runtime::spawn(run_reader(
        app.clone(),
        session_id.clone(),
        BufReader::new(read_half),
        ipc,
        emit_state,
    ));
    {
        let mut guard = session.reader_task.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(reader_handle);
    }

    register_observed_properties(&session).await;

    tauri::async_runtime::spawn(run_exit_watch(app.clone(), session.clone()));

    {
        let mut guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(session.clone());
    }

    ensure_watcher_running(&session);

    Ok(MpvEmbedSession { session_id, pid })
}

#[cfg(not(target_os = "windows"))]
async fn start_session(_app: AppHandle, _state: State<'_, MpvEmbedState>, _bounds: Bounds) -> Result<MpvEmbedSession, String> {
    Err(platform_unsupported())
}

#[cfg(target_os = "windows")]
fn status_impl(state: &MpvEmbedState) -> MpvEmbedStatus {
    let guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
    match guard.as_ref() {
        Some(session) => MpvEmbedStatus {
            running: true,
            session_id: Some(session.session_id.clone()),
            pid: Some(session.pid),
            pip_active: pip_active(session),
        },
        None => MpvEmbedStatus { running: false, session_id: None, pid: None, pip_active: false },
    }
}

#[cfg(not(target_os = "windows"))]
fn status_impl(_state: &MpvEmbedState) -> MpvEmbedStatus {
    MpvEmbedStatus { running: false, session_id: None, pid: None, pip_active: false }
}

#[cfg(not(target_os = "windows"))]
fn platform_unsupported() -> String {
    "OTHER:mpv embed unsupported on this platform".to_string()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mpv_embed_available() -> MpvEmbedAvailability {
    #[cfg(target_os = "windows")]
    {
        match resolve_mpv_binary() {
            Some(binary) => MpvEmbedAvailability { supported: true, reason: None, binary: Some(binary) },
            None => MpvEmbedAvailability { supported: false, reason: Some("not-found".to_string()), binary: None },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        MpvEmbedAvailability { supported: false, reason: Some("platform".to_string()), binary: None }
    }
}

#[tauri::command]
pub async fn mpv_embed_start(app: AppHandle, state: State<'_, MpvEmbedState>, bounds: Bounds) -> Result<MpvEmbedSession, String> {
    start_session(app, state, bounds).await
}

#[tauri::command]
pub async fn mpv_embed_load(
    state: State<'_, MpvEmbedState>,
    session_id: String,
    url: String,
    options: LoadOptions,
) -> Result<(), String> {
    load_into_session(state, session_id, url, options).await
}

#[cfg(target_os = "windows")]
async fn load_into_session(
    state: State<'_, MpvEmbedState>,
    session_id: String,
    url: String,
    options: LoadOptions,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    external_player::validate_arg(&url, "url")?;
    let has_options = build_loadfile_options(&options).is_some();
    let command = build_loadfile_command(&url, &options, true);
    match session.ipc.send_request(command, MPV_IPC_TIMEOUT).await {
        Ok(_) => {}
        Err(error) if has_options && is_invalid_parameter_reply(&error) => {
            let legacy_command = build_loadfile_command(&url, &options, false);
            session.ipc.send_request(legacy_command, MPV_IPC_TIMEOUT).await?;
        }
        Err(error) => return Err(error),
    }
    session
        .ipc
        .send_request(json!({ "command": ["set_property", "pause", false] }), MPV_IPC_TIMEOUT)
        .await?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn load_into_session(
    _state: State<'_, MpvEmbedState>,
    _session_id: String,
    _url: String,
    _options: LoadOptions,
) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_command(
    state: State<'_, MpvEmbedState>,
    session_id: String,
    args: Vec<String>,
) -> Result<Option<Value>, String> {
    run_mpv_command(state, session_id, args).await
}

#[cfg(target_os = "windows")]
async fn run_mpv_command(
    state: State<'_, MpvEmbedState>,
    session_id: String,
    args: Vec<String>,
) -> Result<Option<Value>, String> {
    let session = get_session(&state, &session_id)?;
    for arg in &args {
        external_player::validate_arg(arg, "mpv command arg")?;
    }
    let command_array: Vec<Value> = args.into_iter().map(Value::String).collect();
    let reply = session.ipc.send_request(json!({ "command": command_array }), MPV_IPC_TIMEOUT).await?;
    Ok(if reply.is_null() { None } else { Some(reply) })
}

#[cfg(not(target_os = "windows"))]
async fn run_mpv_command(
    _state: State<'_, MpvEmbedState>,
    _session_id: String,
    _args: Vec<String>,
) -> Result<Option<Value>, String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_set_property(
    state: State<'_, MpvEmbedState>,
    session_id: String,
    name: String,
    value: Value,
) -> Result<(), String> {
    set_mpv_property(state, session_id, name, value).await
}

#[cfg(target_os = "windows")]
async fn set_mpv_property(
    state: State<'_, MpvEmbedState>,
    session_id: String,
    name: String,
    value: Value,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    external_player::validate_arg(&name, "property name")?;
    session
        .ipc
        .send_request(json!({ "command": ["set_property", name, value] }), MPV_IPC_TIMEOUT)
        .await?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn set_mpv_property(
    _state: State<'_, MpvEmbedState>,
    _session_id: String,
    _name: String,
    _value: Value,
) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_get_property(state: State<'_, MpvEmbedState>, session_id: String, name: String) -> Result<Value, String> {
    get_mpv_property(state, session_id, name).await
}

#[cfg(target_os = "windows")]
async fn get_mpv_property(state: State<'_, MpvEmbedState>, session_id: String, name: String) -> Result<Value, String> {
    let session = get_session(&state, &session_id)?;
    external_player::validate_arg(&name, "property name")?;
    session.ipc.send_request(json!({ "command": ["get_property", name] }), MPV_IPC_TIMEOUT).await
}

#[cfg(not(target_os = "windows"))]
async fn get_mpv_property(_state: State<'_, MpvEmbedState>, _session_id: String, _name: String) -> Result<Value, String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub fn mpv_embed_set_bounds(state: State<'_, MpvEmbedState>, session_id: String, bounds: Bounds) -> Result<(), String> {
    set_bounds_impl(state, session_id, bounds)
}

#[cfg(target_os = "windows")]
fn set_bounds_impl(state: State<'_, MpvEmbedState>, session_id: String, bounds: Bounds) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    record_and_apply_bounds(&session, bounds)
}

#[cfg(not(target_os = "windows"))]
fn set_bounds_impl(_state: State<'_, MpvEmbedState>, _session_id: String, _bounds: Bounds) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub fn mpv_embed_set_visible(state: State<'_, MpvEmbedState>, session_id: String, visible: bool) -> Result<(), String> {
    set_visible_impl(state, session_id, visible)
}

#[cfg(target_os = "windows")]
fn set_visible_impl(state: State<'_, MpvEmbedState>, session_id: String, visible: bool) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    record_and_apply_visible(&session, visible);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_visible_impl(_state: State<'_, MpvEmbedState>, _session_id: String, _visible: bool) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_pip_enter(app: AppHandle, state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    pip_enter(app, state, session_id).await
}

#[cfg(not(target_os = "windows"))]
async fn pip_enter(_app: AppHandle, _state: State<'_, MpvEmbedState>, _session_id: String) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_pip_exit(state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    pip_exit(state, session_id).await
}

#[cfg(not(target_os = "windows"))]
async fn pip_exit(_state: State<'_, MpvEmbedState>, _session_id: String) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_stop(state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    stop_session(state, session_id).await
}

#[cfg(target_os = "windows")]
async fn stop_session(state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    session.ipc.send_request(json!({ "command": ["stop"] }), MPV_IPC_TIMEOUT).await?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn stop_session(_state: State<'_, MpvEmbedState>, _session_id: String) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_shutdown(app: AppHandle, state: State<'_, MpvEmbedState>) -> Result<(), String> {
    shutdown_session(app, state).await
}

#[cfg(target_os = "windows")]
async fn shutdown_session(app: AppHandle, state: State<'_, MpvEmbedState>) -> Result<(), String> {
    let session = {
        let mut guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.take()
    };
    if let Some(session) = session {
        teardown_session(&app, &session).await;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn shutdown_session(_app: AppHandle, _state: State<'_, MpvEmbedState>) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub fn mpv_embed_status(state: State<'_, MpvEmbedState>) -> MpvEmbedStatus {
    status_impl(&state)
}

/// Best-effort teardown for app-exit paths that can't await; uses `try_lock`.
#[cfg(target_os = "windows")]
pub fn shutdown(state: &MpvEmbedState) {
    let session = {
        let mut guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.take()
    };
    let Some(session) = session else { return };
    destroy_pip_window_if_active(&session);
    session.torn_down.store(true, Ordering::SeqCst);
    session.kill_notify.notify_one();
    if let Ok(mut guard) = session.child.try_lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
        }
    }
    let reader = session
        .reader_task
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take();
    if let Some(handle) = reader {
        handle.abort();
    }
}

#[cfg(not(target_os = "windows"))]
pub fn shutdown(_state: &MpvEmbedState) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_mpv_embed_args_matches_the_documented_pipeline() {
        let args = build_mpv_embed_args(12345, r"\\.\pipe\xt-mpv-embed-1", r"C:\logs\mpv-embed.log");
        assert_eq!(
            args,
            vec![
                "--wid=12345".to_string(),
                r"--input-ipc-server=\\.\pipe\xt-mpv-embed-1".to_string(),
                "--idle=yes".to_string(),
                "--force-window=immediate".to_string(),
                "--keep-open=yes".to_string(),
                "--no-osc".to_string(),
                "--osd-level=0".to_string(),
                "--no-input-default-bindings".to_string(),
                "--input-vo-keyboard=no".to_string(),
                "--no-input-cursor".to_string(),
                "--cursor-autohide=no".to_string(),
                "--no-window-dragging".to_string(),
                "--focus-on=never".to_string(),
                "--msg-level=all=warn".to_string(),
                r"--log-file=C:\logs\mpv-embed.log".to_string(),
                "--no-config".to_string(),
            ]
        );
    }

    fn empty_options() -> LoadOptions {
        LoadOptions { user_agent: None, referer: None, start_seconds: None, is_live: false, network_timeout_seconds: None }
    }

    #[test]
    fn build_loadfile_command_without_options_is_the_plain_form_either_way() {
        for use_index_form in [true, false] {
            let command = build_loadfile_command("https://e.test/x.m3u8", &empty_options(), use_index_form);
            let array = command["command"].as_array().expect("command array");
            assert_eq!(array.len(), 3);
            assert_eq!(array[0], "loadfile");
            assert_eq!(array[1], "https://e.test/x.m3u8");
            assert_eq!(array[2], "replace");
        }
    }

    #[test]
    fn build_loadfile_command_with_options_uses_the_index_form_when_requested() {
        let options = LoadOptions { user_agent: Some("Mozilla/5.0".to_string()), ..empty_options() };
        let opts = build_loadfile_options(&options).expect("options string");
        let command = build_loadfile_command("https://e.test/x.m3u8", &options, true);
        let array = command["command"].as_array().expect("command array");
        assert_eq!(array.len(), 5);
        assert_eq!(array[0], "loadfile");
        assert_eq!(array[1], "https://e.test/x.m3u8");
        assert_eq!(array[2], "replace");
        assert_eq!(array[3], -1);
        assert_eq!(array[4], opts);
    }

    #[test]
    fn build_loadfile_command_with_options_uses_the_legacy_form_when_requested() {
        let options = LoadOptions { user_agent: Some("Mozilla/5.0".to_string()), ..empty_options() };
        let opts = build_loadfile_options(&options).expect("options string");
        let command = build_loadfile_command("https://e.test/x.m3u8", &options, false);
        let array = command["command"].as_array().expect("command array");
        assert_eq!(array.len(), 4);
        assert_eq!(array[0], "loadfile");
        assert_eq!(array[1], "https://e.test/x.m3u8");
        assert_eq!(array[2], "replace");
        assert_eq!(array[3], opts);
    }

    #[test]
    fn is_invalid_parameter_reply_matches_the_wrapped_mpv_error() {
        assert!(is_invalid_parameter_reply("IPC:mpv replied invalid parameter"));
        assert!(!is_invalid_parameter_reply("IPC:mpv replied property not found"));
    }

    #[test]
    fn build_loadfile_options_percent_encodes_user_agent_and_referer() {
        let options = LoadOptions {
            user_agent: Some("Mozilla/5.0, extra".to_string()),
            referer: Some("https://r.test/, path".to_string()),
            ..empty_options()
        };
        let opts = build_loadfile_options(&options).expect("options string");
        assert!(opts.contains(&format!("user-agent=%{}%Mozilla/5.0, extra", "Mozilla/5.0, extra".len())));
        assert!(opts.contains(&format!("referrer=%{}%https://r.test/, path", "https://r.test/, path".len())));
    }

    #[test]
    fn build_loadfile_options_ignores_start_seconds_when_live() {
        let options = LoadOptions { start_seconds: Some(42.0), is_live: true, ..empty_options() };
        assert_eq!(build_loadfile_options(&options), None);
    }

    #[test]
    fn build_loadfile_options_includes_start_seconds_when_not_live() {
        let options = LoadOptions { start_seconds: Some(42.5), is_live: false, ..empty_options() };
        let opts = build_loadfile_options(&options).expect("options string");
        assert!(opts.contains(&format!("start=%{}%42.5", "42.5".len())));
    }

    #[test]
    fn build_loadfile_options_ignores_a_zero_or_negative_start() {
        let options = LoadOptions { start_seconds: Some(0.0), is_live: false, ..empty_options() };
        assert_eq!(build_loadfile_options(&options), None);
    }

    #[test]
    fn build_loadfile_options_includes_network_timeout_when_positive() {
        let options = LoadOptions { network_timeout_seconds: Some(45.0), ..empty_options() };
        let opts = build_loadfile_options(&options).expect("options string");
        assert!(opts.contains(&format!("network-timeout=%{}%45", "45".len())));
    }

    #[test]
    fn build_loadfile_options_ignores_a_zero_or_negative_network_timeout() {
        let options = LoadOptions { network_timeout_seconds: Some(0.0), ..empty_options() };
        assert_eq!(build_loadfile_options(&options), None);
    }

    #[test]
    fn classify_ipc_frame_recognizes_a_reply_with_request_id() {
        let frame = classify_ipc_frame(r#"{"error":"success","request_id":7}"#);
        match frame {
            MpvIpcFrame::Reply { request_id, .. } => assert_eq!(request_id, 7),
            _ => panic!("expected a reply frame"),
        }
    }

    #[test]
    fn classify_ipc_frame_recognizes_an_event() {
        let frame = classify_ipc_frame(r#"{"event":"file-loaded"}"#);
        match frame {
            MpvIpcFrame::Event(value) => assert_eq!(value["event"], "file-loaded"),
            _ => panic!("expected an event frame"),
        }
    }

    #[test]
    fn classify_ipc_frame_treats_garbage_and_blank_lines_as_unknown() {
        assert!(matches!(classify_ipc_frame(""), MpvIpcFrame::Unknown));
        assert!(matches!(classify_ipc_frame("not json"), MpvIpcFrame::Unknown));
        assert!(matches!(classify_ipc_frame(r#"{"foo":"bar"}"#), MpvIpcFrame::Unknown));
    }

    #[test]
    fn parse_mpv_reply_extracts_data_on_success() {
        let reply = json!({ "error": "success", "data": 12.5, "request_id": 1 });
        assert_eq!(parse_mpv_reply(reply).unwrap(), json!(12.5));
    }

    #[test]
    fn parse_mpv_reply_reports_a_non_success_error() {
        let reply = json!({ "error": "property not found", "request_id": 1 });
        let error = parse_mpv_reply(reply).unwrap_err();
        assert!(error.starts_with("IPC:"));
        assert!(error.contains("property not found"));
    }

    #[test]
    fn validate_hwnd_rejects_null_and_negative_values() {
        assert!(validate_hwnd(0).is_err());
        assert!(validate_hwnd(-1).is_err());
        assert!(validate_hwnd(12345).is_ok());
    }

    #[test]
    fn should_flush_time_pos_honors_the_throttle_window() {
        assert!(!should_flush_time_pos(Duration::from_millis(100)));
        assert!(should_flush_time_pos(Duration::from_millis(250)));
        assert!(should_flush_time_pos(Duration::from_millis(500)));
    }

    #[test]
    fn camel_prop_name_covers_every_observed_property() {
        let expected: &[(&str, &str)] = &[
            ("pause", "pause"),
            ("time-pos", "timePos"),
            ("duration", "duration"),
            ("core-idle", "coreIdle"),
            ("paused-for-cache", "pausedForCache"),
            ("seeking", "seeking"),
            ("eof-reached", "eofReached"),
            ("idle-active", "idleActive"),
            ("demuxer-cache-duration", "demuxerCacheDuration"),
            ("video-bitrate", "videoBitrate"),
            ("hwdec-current", "hwdecCurrent"),
            ("frame-drop-count", "frameDropCount"),
            ("estimated-vf-fps", "estimatedVfFps"),
            ("width", "width"),
            ("height", "height"),
            ("video-codec", "videoCodec"),
            ("audio-codec-name", "audioCodecName"),
            ("track-list", "trackList"),
            ("media-title", "mediaTitle"),
            ("sub-delay", "subDelay"),
            ("aid", "aid"),
            ("sid", "sid"),
        ];
        assert_eq!(expected.len(), OBSERVED_PROPERTIES.len());
        for (mpv_name, camel_name) in expected {
            assert_eq!(camel_prop_name(mpv_name), *camel_name);
        }
    }

    #[test]
    fn build_mpv_candidates_orders_env_bundled_configured_then_discovered() {
        let candidates = build_mpv_candidates(
            Some(r"C:\sidecar\mpv.exe".to_string()),
            Some(PathBuf::from(r"C:\app")),
            Some(r"C:\configured\mpv.exe".to_string()),
            vec![r"C:\path\one\mpv.exe".to_string(), r"C:\path\two\mpv.exe".to_string()],
        );
        assert_eq!(
            candidates,
            vec![
                r"C:\sidecar\mpv.exe".to_string(),
                r"C:\app\infinitv-mpv.exe".to_string(),
                r"C:\configured\mpv.exe".to_string(),
                r"C:\path\one\mpv.exe".to_string(),
            ]
        );
    }

    #[test]
    fn build_mpv_candidates_skips_absent_tiers() {
        let candidates = build_mpv_candidates(None, None, None, vec![]);
        assert!(candidates.is_empty());
    }

    #[test]
    fn should_keep_polling_stops_once_torn_down() {
        assert!(!should_keep_polling(true, Duration::from_millis(0), Duration::from_secs(30)));
    }

    #[test]
    fn should_keep_polling_stops_once_the_budget_elapses() {
        assert!(!should_keep_polling(false, Duration::from_secs(31), Duration::from_secs(30)));
    }

    #[test]
    fn should_keep_polling_continues_within_budget() {
        assert!(should_keep_polling(false, Duration::from_millis(100), Duration::from_secs(30)));
    }

    #[test]
    fn clamp_corner_radius_rejects_a_negative_radius() {
        assert_eq!(clamp_corner_radius(-5, 100, 100), 0);
    }

    #[test]
    fn clamp_corner_radius_passes_through_zero() {
        assert_eq!(clamp_corner_radius(0, 100, 100), 0);
    }

    #[test]
    fn clamp_corner_radius_caps_at_half_the_smaller_dimension() {
        assert_eq!(clamp_corner_radius(80, 100, 60), 30);
    }

    #[test]
    fn clamp_corner_radius_keeps_a_normal_radius_unchanged() {
        assert_eq!(clamp_corner_radius(12, 200, 150), 12);
    }

    #[test]
    fn bounds_already_applied_matches_identical_bounds() {
        let bounds = Bounds { x: 10, y: 20, width: 640, height: 360, radius: 8 };
        assert!(bounds_already_applied(Some(bounds), bounds));
    }

    #[test]
    fn bounds_already_applied_rejects_a_changed_field() {
        let cached = Bounds { x: 10, y: 20, width: 640, height: 360, radius: 8 };
        let incoming = Bounds { x: 11, y: 20, width: 640, height: 360, radius: 8 };
        assert!(!bounds_already_applied(Some(cached), incoming));
    }

    #[test]
    fn bounds_already_applied_rejects_no_cache() {
        let incoming = Bounds { x: 10, y: 20, width: 640, height: 360, radius: 8 };
        assert!(!bounds_already_applied(None, incoming));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn desired_state_round_trips_bounds_and_visibility() {
        let initial = Bounds { x: 0, y: 0, width: 100, height: 100, radius: 0 };
        let state = DesiredState::new(initial, true);
        assert_eq!(state.bounds(), Some(initial));
        assert!(state.visible());

        let updated = Bounds { x: 10, y: 20, width: 640, height: 360, radius: 12 };
        state.set_bounds(updated);
        state.set_visible(false);
        assert_eq!(state.bounds(), Some(updated));
        assert!(!state.visible());
    }

    #[test]
    fn aspect_from_dimensions_accepts_positive_values() {
        assert_eq!(aspect_from_dimensions(Some(1920.0), Some(1080.0)), Some((1920.0, 1080.0)));
    }

    #[test]
    fn aspect_from_dimensions_rejects_non_positive_or_missing_values() {
        assert_eq!(aspect_from_dimensions(Some(0.0), Some(1080.0)), None);
        assert_eq!(aspect_from_dimensions(Some(1920.0), None), None);
        assert_eq!(aspect_from_dimensions(None, None), None);
    }

    #[test]
    fn pip_default_geometry_uses_the_default_aspect_when_none_observed() {
        let work_area = WorkArea { x: 0, y: 0, width: 1920, height: 1080 };
        let bounds = pip_default_geometry(None, work_area);
        assert_eq!(bounds.width, PIP_DEFAULT_WIDTH);
        assert_eq!(bounds.height, (PIP_DEFAULT_WIDTH as f64 * 9.0 / 16.0).round() as i32);
        assert_eq!(bounds.x, 1920 - PIP_DEFAULT_WIDTH - PIP_MARGIN);
        assert_eq!(bounds.y, 1080 - bounds.height - PIP_MARGIN);
    }

    #[test]
    fn pip_default_geometry_follows_the_observed_video_aspect_ratio() {
        let work_area = WorkArea { x: 0, y: 0, width: 1920, height: 1080 };
        let bounds = pip_default_geometry(Some((4.0, 3.0)), work_area);
        assert_eq!(bounds.width, PIP_DEFAULT_WIDTH);
        assert_eq!(bounds.height, (PIP_DEFAULT_WIDTH as f64 * 3.0 / 4.0).round() as i32);
    }

    #[test]
    fn pip_default_geometry_shrinks_to_fit_a_narrow_work_area() {
        let work_area = WorkArea { x: 0, y: 0, width: 300, height: 800 };
        let bounds = pip_default_geometry(None, work_area);
        assert!(bounds.width <= 300 - PIP_MARGIN * 2);
        assert!(bounds.width >= PIP_MIN_WIDTH.min(300 - PIP_MARGIN * 2));
    }

    #[test]
    fn pip_default_geometry_offsets_by_the_work_area_origin() {
        let work_area = WorkArea { x: 100, y: 50, width: 1920, height: 1080 };
        let bounds = pip_default_geometry(None, work_area);
        assert_eq!(bounds.x, 100 + 1920 - PIP_DEFAULT_WIDTH - PIP_MARGIN);
        assert_eq!(bounds.y, 50 + 1080 - bounds.height - PIP_MARGIN);
    }

    #[test]
    fn should_enter_pip_is_false_when_already_active() {
        assert!(!should_enter_pip(true));
    }

    #[test]
    fn should_enter_pip_is_true_when_inactive() {
        assert!(should_enter_pip(false));
    }

    #[test]
    fn should_exit_pip_is_false_when_not_active() {
        assert!(!should_exit_pip(false));
    }

    #[test]
    fn should_exit_pip_is_true_when_active() {
        assert!(should_exit_pip(true));
    }
}
