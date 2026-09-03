// Embedded mpv player: persistent JSON-IPC session over a named pipe, Windows-only for now.
// mpv is a direct --wid child of the main window (a grandchild's swapchain gets DWM-clipped
// by the WebView2 sibling); we never resize it under the main window, only place the picture
// via video-zoom/pan. A single SurfaceState (Hidden/Embedded/Fullscreen/Pip), derived purely
// from the frontend's desired visible/bounds/fullscreen/pip record, is applied by the one
// `apply_surface` function (parent, size, z-order, pointer mode, placement, visibility, in
// that order) so every command funnels through the same code path instead of scattered
// per-command Win32 calls.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
#[cfg(target_os = "windows")]
use tauri::Emitter;

#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::process::Stdio;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex, OnceLock, Weak};
#[cfg(target_os = "windows")]
use std::time::Instant;

#[cfg(target_os = "windows")]
use tokio::io::{split, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
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
use windows::Win32::Foundation::{ERROR_PIPE_BUSY, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, EnumChildWindows, GetClientRect, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsWindow, IsZoomed, RegisterClassExW, SendMessageW, SetParent,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, CS_HREDRAW, CS_VREDRAW, GWL_EXSTYLE, GWL_STYLE, HTBOTTOM,
    HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCAPTION, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT, HWND_BOTTOM,
    SC_MAXIMIZE, SC_RESTORE, SW_HIDE, SW_SHOWNA, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, WM_CLOSE, WM_KEYDOWN, WM_MOVE, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_SIZE, WM_SIZING,
    WM_SYSCOMMAND, WMSZ_BOTTOM,
    WMSZ_BOTTOMLEFT, WMSZ_LEFT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    WNDCLASSEXW, WS_CAPTION, WS_CLIPCHILDREN, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_EX_STATICEDGE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_WINDOWEDGE, WS_POPUP, WS_THICKFRAME, WS_VISIBLE,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const IPC_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const MPV_IPC_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const MPV_WINDOW_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(target_os = "windows")]
const MPV_WINDOW_POLL_BUDGET: Duration = Duration::from_secs(30);
#[cfg(target_os = "windows")]
const MAIN_THREAD_CALL_TIMEOUT: Duration = Duration::from_secs(5);

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
    "dwidth",
    "dheight",
    "panscan",
    "speed",
    "volume",
    "mute",
    "container-fps",
    "decoder-frame-drop-count",
    "demuxer-cache-time",
    "video-format",
    "audio-params/format",
    "audio-params/channel-count",
    "video-params/pixelformat",
    "file-format",
    "seekable",
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

/// PiP popup rect in screen px; also `mpv_embed_status.pipRect` and the `xt:mpv-surface` payload.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipGeometry {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The single owner of mpv's native surface: where it's parented and whether it's shown.
/// Precedence when deriving from frontend intent: PiP wins, then fullscreen, then embedded.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SurfaceState {
    Hidden,
    Embedded,
    Fullscreen,
    Pip,
}

fn derive_surface_state(visible: bool, fullscreen: bool, pip_active: bool) -> SurfaceState {
    if pip_active {
        SurfaceState::Pip
    } else if fullscreen {
        SurfaceState::Fullscreen
    } else if visible {
        SurfaceState::Embedded
    } else {
        SurfaceState::Hidden
    }
}

fn surface_state_name(state: SurfaceState) -> &'static str {
    match state {
        SurfaceState::Hidden => "hidden",
        SurfaceState::Embedded => "embedded",
        SurfaceState::Fullscreen => "fullscreen",
        SurfaceState::Pip => "pip",
    }
}

/// mpv's `video-zoom` (log2 scale) and `video-pan-x/y` (fraction of the scaled size).
#[derive(Debug, Clone, Copy, PartialEq)]
struct VideoPlacement {
    zoom: f64,
    pan_x: f64,
    pan_y: f64,
}

impl VideoPlacement {
    const CENTERED: VideoPlacement = VideoPlacement { zoom: 0.0, pan_x: 0.0, pan_y: 0.0 };
}

// mpv's contain-fit of (src_w, src_h) into (box_w, box_h), blended toward cover by `panscan`.
// Mirrors mpv's aspect_calc_panscan (video/out/aspect.c) for a square-pixel monitor, no `unscaled`.
fn panscan_fit(src_w: f64, src_h: f64, box_w: f64, box_h: f64, panscan: f64) -> (f64, f64) {
    if src_w <= 0.0 || src_h <= 0.0 || box_w <= 0.0 || box_h <= 0.0 {
        return (box_w.max(0.0), box_h.max(0.0));
    }
    let mut fit_w = box_w;
    let mut fit_h = box_w / src_w * src_h;
    if fit_h > box_h {
        fit_h = box_h;
        fit_w = box_h / src_h * src_w;
    }
    let mut panscan_area = box_h - fit_h;
    let (mut factor_w, mut factor_h) = (fit_w / fit_h.max(1.0), 1.0);
    if panscan_area == 0.0 {
        panscan_area = box_w - fit_w;
        factor_w = 1.0;
        factor_h = fit_h / fit_w.max(1.0);
    }
    (fit_w + panscan_area * panscan * factor_w, fit_h + panscan_area * panscan * factor_h)
}

/// Keeps the video at the size it would render at (dw, dh) inside `bounds`, centered on that
/// box, and lets the window clip it instead of shrinking it to fit (unlike margin ratios, which
/// can only describe a box inside the window and so shrink the picture once `bounds` scrolls off).
fn placement_for_bounds(
    bounds: Bounds,
    client_width: i32,
    client_height: i32,
    video_dw: Option<f64>,
    video_dh: Option<f64>,
    panscan: f64,
) -> VideoPlacement {
    if client_width <= 0 || client_height <= 0 || bounds.width <= 0 || bounds.height <= 0 {
        return VideoPlacement::CENTERED;
    }
    let client_w = client_width as f64;
    let client_h = client_height as f64;
    let box_w = bounds.width as f64;
    let box_h = bounds.height as f64;
    // No video loaded yet: assume the box's own aspect so the black surface still lands in it.
    let (src_w, src_h) = match (video_dw, video_dh) {
        (Some(dw), Some(dh)) if dw > 0.0 && dh > 0.0 => (dw, dh),
        _ => (box_w, box_h),
    };

    let (scaled_w, scaled_h) = panscan_fit(src_w, src_h, box_w, box_h, panscan);
    let (base_w, base_h) = panscan_fit(src_w, src_h, client_w, client_h, panscan);
    if scaled_w <= 0.0 || scaled_h <= 0.0 || base_w <= 0.0 || base_h <= 0.0 {
        return VideoPlacement::CENTERED;
    }

    // Aspect is preserved by panscan_fit, so scaled_h/base_h gives the same ratio; either works.
    let zoom = (scaled_w / base_w).log2();
    let center_x = bounds.x as f64 + box_w / 2.0;
    let center_y = bounds.y as f64 + box_h / 2.0;
    let pan_x = (center_x - client_w / 2.0) / scaled_w;
    let pan_y = (center_y - client_h / 2.0) / scaled_h;

    VideoPlacement { zoom: zoom.clamp(-20.0, 20.0), pan_x: pan_x.clamp(-3.0, 3.0), pan_y: pan_y.clamp(-3.0, 3.0) }
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
    pub surface: String,
    pub pip_rect: Option<PipGeometry>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[derive(Default)]
pub struct MpvEmbedState {
    session: Mutex<Option<Arc<MpvSession>>>,
    fullscreen: Mutex<Option<SavedWindowState>>,
    // Reused (clamped to the work area) on the next PiP enter; process lifetime only.
    last_pip_rect: Mutex<Option<PipGeometry>>,
}

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
pub struct MpvEmbedState;

/// Window state saved on entering native fullscreen, restored on exit.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
struct SavedWindowState {
    style: isize,
    ex_style: isize,
    rect: RECT,
    maximized: bool,
}

#[cfg(target_os = "windows")]
struct MpvSession {
    session_id: String,
    pid: u32,
    parent_hwnd: isize,
    mpv_hwnd: Mutex<Option<isize>>,
    target: SurfaceTarget,
    video_metrics: Mutex<VideoMetrics>,
    placement_tx: tokio::sync::watch::Sender<()>,
    ipc: Arc<MpvIpcClient>,
    child: tokio::sync::Mutex<Option<Child>>,
    kill_notify: Notify,
    torn_down: AtomicBool,
    reader_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    // The popup HWND once created; distinct from `target.pip`, which is its desired geometry.
    pip_hwnd: Mutex<Option<isize>>,
}

#[cfg(target_os = "windows")]
impl MpvSession {
    fn video_metrics(&self) -> VideoMetrics {
        *self.video_metrics.lock().unwrap_or_else(|poison| poison.into_inner())
    }
}

/// Latest `dwidth`/`dheight`/`panscan` observed from mpv; feeds `placement_for_bounds`.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, Default)]
struct VideoMetrics {
    dwidth: Option<f64>,
    dheight: Option<f64>,
    panscan: f64,
}

/// The frontend's desired surface state; `derive_surface_state` turns this into a `SurfaceState`.
#[cfg(target_os = "windows")]
struct SurfaceTarget {
    visible: AtomicBool,
    bounds: Mutex<Option<Bounds>>,
    fullscreen: AtomicBool,
    pip: Mutex<Option<PipGeometry>>,
}

#[cfg(target_os = "windows")]
impl SurfaceTarget {
    fn new(initial_bounds: Bounds, initial_visible: bool) -> Self {
        Self {
            visible: AtomicBool::new(initial_visible),
            bounds: Mutex::new(Some(initial_bounds)),
            fullscreen: AtomicBool::new(false),
            pip: Mutex::new(None),
        }
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

    fn set_fullscreen(&self, fullscreen: bool) {
        self.fullscreen.store(fullscreen, Ordering::SeqCst);
    }

    fn fullscreen(&self) -> bool {
        self.fullscreen.load(Ordering::SeqCst)
    }

    fn set_pip(&self, pip: Option<PipGeometry>) {
        let mut guard = self.pip.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = pip;
    }

    fn pip(&self) -> Option<PipGeometry> {
        *self.pip.lock().unwrap_or_else(|poison| poison.into_inner())
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
    session: Arc<MpvSession>,
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
                MpvIpcFrame::Event(value) => handle_mpv_event(&app, &session, &emit_state, &value),
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
        "container-fps" => "containerFps",
        "decoder-frame-drop-count" => "decoderFrameDropCount",
        "demuxer-cache-time" => "demuxerCacheTime",
        "video-format" => "videoFormat",
        "audio-params/format" => "audioFormat",
        "audio-params/channel-count" => "audioChannelCount",
        "video-params/pixelformat" => "pixelFormat",
        "file-format" => "fileFormat",
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

// Updates the metrics apply_surface reads and wakes the surface task to recompute placement.
#[cfg(target_os = "windows")]
fn update_video_metrics(session: &Arc<MpvSession>, name: &str, value: &Value) {
    {
        let mut metrics = session.video_metrics.lock().unwrap_or_else(|poison| poison.into_inner());
        match name {
            "dwidth" => metrics.dwidth = value.as_f64(),
            "dheight" => metrics.dheight = value.as_f64(),
            "panscan" => metrics.panscan = value.as_f64().unwrap_or(0.0),
            _ => {}
        }
    }
    let _ = session.placement_tx.send(());
}

#[cfg(target_os = "windows")]
fn handle_mpv_event(app: &AppHandle, session: &Arc<MpvSession>, emit_state: &PropertyEmitState, parsed: &Value) {
    let event_name = parsed.get("event").and_then(Value::as_str).unwrap_or("");
    if event_name == "property-change" {
        let Some(name) = parsed.get("name").and_then(Value::as_str) else { return };
        let value = parsed.get("data").cloned().unwrap_or(Value::Null);
        if matches!(name, "dwidth" | "dheight" | "panscan") {
            update_video_metrics(session, name, &value);
        }
        record_property_change(app, &session.session_id, emit_state, name, value);
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
        json!({ "sessionId": session.session_id, "kind": kind, "reason": reason, "detail": detail }),
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
        "--osc=yes".to_string(),
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
        "--hwdec=auto-safe".to_string(),
        "--audio-client-name=Extreme InfiniTV".to_string(),
        "--screenshot-format=png".to_string(),
        "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5".to_string(),
        "--cache=yes".to_string(),
        "--demuxer-max-bytes=150MiB".to_string(),
        "--demuxer-readahead-secs=20".to_string(),
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

// Collapses whitespace/newlines into a single line so a log line stays readable.
fn trim_stderr_head(raw: &str, max_chars: usize) -> String {
    let collapsed = raw.trim().split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max_chars).collect()
}

/// Explains an IPC-connect failure with the binary path, the child's exit state, and its stderr.
fn format_ipc_start_failure(
    binary: &str,
    exit_code: Option<i32>,
    os_error: &str,
    stderr_head: Option<&str>,
) -> String {
    let exit_label = exit_code.map(|code| code.to_string()).unwrap_or_else(|| "still running".to_string());
    let mut message = format!("IPC:failed to connect to mpv at {binary} (exit: {exit_label}): {os_error}");
    if let Some(head) = stderr_head.map(|head| trim_stderr_head(head, 300)).filter(|head| !head.is_empty()) {
        message.push_str(&format!(" - stderr: {head}"));
    }
    message
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

// A freshly created child defaults to the top of the z-order, which would hide the webview UI.
#[cfg(target_os = "windows")]
fn send_to_bottom(hwnd_value: isize) {
    let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

// mpv creates its embedded output window asynchronously after launch, not before.
#[cfg(target_os = "windows")]
fn resolve_mpv_window(session: &MpvSession) -> Option<isize> {
    {
        let mut cached = session.mpv_hwnd.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(value) = *cached {
            let hwnd = HWND(value as *mut core::ffi::c_void);
            if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                return Some(value);
            }
            *cached = None;
        }
    }
    let found = find_mpv_child_window(session.parent_hwnd, session.pid)?;
    send_to_bottom(found);
    let mut cached = session.mpv_hwnd.lock().unwrap_or_else(|poison| poison.into_inner());
    *cached = Some(found);
    Some(found)
}

fn should_keep_polling(torn_down: bool, elapsed: Duration, budget: Duration) -> bool {
    !torn_down && elapsed < budget
}

// mpv creates its window ~300ms after spawn; until then it would sit atop the webview UI.
#[cfg(target_os = "windows")]
async fn watch_for_mpv_window(session: Arc<MpvSession>) {
    let start = Instant::now();
    while should_keep_polling(session.torn_down.load(Ordering::SeqCst), start.elapsed(), MPV_WINDOW_POLL_BUDGET) {
        if resolve_mpv_window(&session).is_some() {
            let _ = session.placement_tx.send(());
            return;
        }
        tokio::time::sleep(MPV_WINDOW_POLL_INTERVAL).await;
    }
    if !session.torn_down.load(Ordering::SeqCst) {
        log::warn!("[mpv-embed] mpv window for session {} did not appear in time", session.session_id);
    }
}

#[cfg(target_os = "windows")]
fn set_window_visibility(hwnd_value: isize, visible: bool) {
    let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
    unsafe {
        let _ = ShowWindow(hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
    }
}

#[cfg(target_os = "windows")]
fn client_size(hwnd: HWND) -> Option<(i32, i32)> {
    let mut rect = RECT::default();
    unsafe { GetClientRect(hwnd, &mut rect) }.ok()?;
    Some((rect.right - rect.left, rect.bottom - rect.top))
}

#[cfg(target_os = "windows")]
fn position_surface(hwnd_value: isize, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
    unsafe { SetWindowPos(hwnd, None, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE) }
        .map_err(|error| format!("OTHER:{error}"))
}

/// The Win32 half of `apply_surface`: reparent, fill the parent's client rect, z-order,
/// visibility. Runs on the main thread; mpv's own window ops otherwise hang from a worker thread.
#[cfg(target_os = "windows")]
fn apply_surface_win32(
    main_hwnd_value: isize,
    surface_value: isize,
    state: SurfaceState,
    pip_hwnd_value: Option<isize>,
) -> Result<(), String> {
    match state {
        SurfaceState::Pip => {
            let pip_hwnd_value =
                pip_hwnd_value.ok_or_else(|| "OTHER:pip surface state with no popup window".to_string())?;
            let pip_hwnd = HWND(pip_hwnd_value as *mut core::ffi::c_void);
            reparent_child(surface_value, pip_hwnd)?;
            if let Some((client_width, client_height)) = client_size(pip_hwnd) {
                let inset = PIP_RESIZE_BORDER;
                let width = (client_width - inset * 2).max(1);
                let height = (client_height - inset * 2).max(1);
                position_surface(surface_value, inset, inset, width, height)?;
            }
            set_window_visibility(surface_value, true);
        }
        SurfaceState::Hidden | SurfaceState::Embedded | SurfaceState::Fullscreen => {
            let main_hwnd = HWND(main_hwnd_value as *mut core::ffi::c_void);
            reparent_child(surface_value, main_hwnd)?;
            if let Some((client_width, client_height)) = client_size(main_hwnd) {
                position_surface(surface_value, 0, 0, client_width, client_height)?;
            }
            send_to_bottom(surface_value);
            set_window_visibility(surface_value, !matches!(state, SurfaceState::Hidden));
        }
    }
    Ok(())
}

// mpv's own OSC needs the mouse in PiP; everywhere else the page draws its own controls.
#[cfg(target_os = "windows")]
async fn apply_pointer_mode(ipc: &MpvIpcClient, in_pip: bool) -> Result<(), String> {
    let cursor = if in_pip { "yes" } else { "no" };
    ipc.send_request(json!({ "command": ["set_property", "input-cursor", cursor] }), MPV_IPC_TIMEOUT).await?;
    let osc_visibility = if in_pip { "auto" } else { "never" };
    ipc.send_request(json!({ "command": ["script-message", "osc-visibility", osc_visibility] }), MPV_IPC_TIMEOUT)
        .await?;
    Ok(())
}

// Zeroed once at session start: placement uses video-zoom/video-pan-* exclusively from then on.
#[cfg(target_os = "windows")]
async fn initialize_video_placement(ipc: &MpvIpcClient) -> Result<(), String> {
    let (margin_left, margin_right, margin_top, margin_bottom, align_x, align_y) = tokio::join!(
        ipc.send_request(json!({ "command": ["set_property", "video-margin-ratio-left", 0.0] }), MPV_IPC_TIMEOUT),
        ipc.send_request(json!({ "command": ["set_property", "video-margin-ratio-right", 0.0] }), MPV_IPC_TIMEOUT),
        ipc.send_request(json!({ "command": ["set_property", "video-margin-ratio-top", 0.0] }), MPV_IPC_TIMEOUT),
        ipc.send_request(json!({ "command": ["set_property", "video-margin-ratio-bottom", 0.0] }), MPV_IPC_TIMEOUT),
        ipc.send_request(json!({ "command": ["set_property", "video-align-x", 0.0] }), MPV_IPC_TIMEOUT),
        ipc.send_request(json!({ "command": ["set_property", "video-align-y", 0.0] }), MPV_IPC_TIMEOUT),
    );
    margin_left?;
    margin_right?;
    margin_top?;
    margin_bottom?;
    align_x?;
    align_y?;
    Ok(())
}

#[cfg(target_os = "windows")]
// send_request releases the writer lock right after its own write, before awaiting the reply,
// so joining three calls costs one write burst plus the slowest reply instead of three round trips.
async fn apply_placement(ipc: &MpvIpcClient, placement: VideoPlacement) -> Result<(), String> {
    let (zoom, pan_x, pan_y) = tokio::join!(
        ipc.send_request(json!({ "command": ["set_property", "video-zoom", placement.zoom] }), MPV_IPC_TIMEOUT),
        ipc.send_request(json!({ "command": ["set_property", "video-pan-x", placement.pan_x] }), MPV_IPC_TIMEOUT),
        ipc.send_request(json!({ "command": ["set_property", "video-pan-y", placement.pan_y] }), MPV_IPC_TIMEOUT),
    );
    zoom?;
    pan_x?;
    pan_y?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn emit_surface_event(app: &AppHandle, session: &MpvSession, state: SurfaceState) {
    let bounds = session
        .target
        .bounds()
        .map(|bounds| json!({ "x": bounds.x, "y": bounds.y, "width": bounds.width, "height": bounds.height }));
    let pip = session.target.pip().map(|pip| json!(pip));
    let _ = app.emit(
        "xt:mpv-surface",
        json!({ "sessionId": session.session_id, "state": surface_state_name(state), "bounds": bounds, "pip": pip }),
    );
    // Kept alongside xt:mpv-surface for frontend code that only listens for the PiP toggle.
    let _ = app.emit(
        "xt:mpv-pip-changed",
        json!({ "sessionId": session.session_id, "active": matches!(state, SurfaceState::Pip) }),
    );
}

/// The single place that computes and applies mpv's surface: parent, size, z-order, pointer
/// mode, zoom/pan placement, visibility, in that order (pointer mode and placement are IPC and
/// run after the Win32 part, on whichever thread called this). No-ops until mpv's window exists;
/// `watch_for_mpv_window` wakes `placement_tx` once it is found, which reaches this too.
#[cfg(target_os = "windows")]
async fn apply_surface(app: &AppHandle, session: &Arc<MpvSession>) -> Result<(), String> {
    let Some(surface_value) = resolve_mpv_window(session) else {
        return Ok(());
    };
    let pip_hwnd_value = *session.pip_hwnd.lock().unwrap_or_else(|poison| poison.into_inner());
    let state = derive_surface_state(session.target.visible(), session.target.fullscreen(), pip_hwnd_value.is_some());
    let main_hwnd_value = session.parent_hwnd;

    run_on_main_thread_and_wait(app, move || {
        apply_surface_win32(main_hwnd_value, surface_value, state, pip_hwnd_value)
    })
    .await??;

    let ipc_for_pointer_mode = session.ipc.clone();
    let session_id_for_log = session.session_id.clone();
    let in_pip = matches!(state, SurfaceState::Pip);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = apply_pointer_mode(&ipc_for_pointer_mode, in_pip).await {
            log::warn!("[mpv-embed] session {session_id_for_log} failed to apply pointer mode: {error}");
        }
    });

    let placement = if in_pip {
        VideoPlacement::CENTERED
    } else {
        let main_hwnd = HWND(main_hwnd_value as *mut core::ffi::c_void);
        match (session.target.bounds(), client_size(main_hwnd)) {
            (Some(bounds), Some((client_width, client_height))) => {
                let metrics = session.video_metrics();
                placement_for_bounds(bounds, client_width, client_height, metrics.dwidth, metrics.dheight, metrics.panscan)
            }
            _ => VideoPlacement::CENTERED,
        }
    };
    if let Err(error) = apply_placement(&session.ipc, placement).await {
        log::warn!("[mpv-embed] session {} failed to apply video placement: {error}", session.session_id);
    }

    emit_surface_event(app, session, state);
    Ok(())
}

/// One task per session, woken by bounds/visibility/fullscreen/PiP/resize/video-metric changes.
/// Holds a `Weak` ref so it can't keep the session alive by itself: once the session drops,
/// `placement_tx` closes, `changed()` errors, and the loop ends on its own.
#[cfg(target_os = "windows")]
async fn run_surface_updates(app: AppHandle, session: Weak<MpvSession>, mut trigger_rx: tokio::sync::watch::Receiver<()>) {
    while trigger_rx.changed().await.is_ok() {
        let Some(session) = session.upgrade() else { return };
        if let Err(error) = apply_surface(&app, &session).await {
            log::warn!("[mpv-embed] session {} failed to apply surface: {error}", session.session_id);
        }
    }
}

// ---------------------------------------------------------------------------
// Picture-in-picture
// ---------------------------------------------------------------------------

const PIP_DEFAULT_WIDTH: i32 = 360;
const PIP_MIN_WIDTH: i32 = 200;
const PIP_MARGIN: i32 = 24;
const PIP_DEFAULT_ASPECT: (f64, f64) = (16.0, 9.0);
// Also mpv's inset from the popup edges, so the border strip (not covered by mpv) can be
// hit-tested for resize; see apply_surface_win32's Pip branch.
const PIP_RESIZE_BORDER: i32 = 8;
#[cfg(target_os = "windows")]
const PIP_CLASS_NAME: &str = "XtreamMpvPip";

// The wndproc has no AppHandle of its own; set once, from the main thread, in start_session.
#[cfg(target_os = "windows")]
static APP_HANDLE_FOR_PIP: OnceLock<AppHandle> = OnceLock::new();

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
fn pip_default_geometry(aspect: Option<(f64, f64)>, work_area: WorkArea) -> PipGeometry {
    let (aspect_width, aspect_height) =
        aspect.filter(|(width, height)| *width > 0.0 && *height > 0.0).unwrap_or(PIP_DEFAULT_ASPECT);
    let max_width = (work_area.width - PIP_MARGIN * 2).max(PIP_MIN_WIDTH);
    let width = PIP_DEFAULT_WIDTH.min(max_width);
    let height = ((width as f64) * aspect_height / aspect_width).round() as i32;
    PipGeometry {
        x: work_area.x + work_area.width - width - PIP_MARGIN,
        y: work_area.y + work_area.height - height - PIP_MARGIN,
        width,
        height,
    }
}

// Reused (not recomputed from scratch) so the popup reopens where the user last left it.
fn clamp_pip_geometry(rect: PipGeometry, work_area: WorkArea) -> PipGeometry {
    let width = rect.width.max(PIP_MIN_WIDTH).min(work_area.width.max(PIP_MIN_WIDTH));
    let height = rect.height.max(1).min(work_area.height.max(1));
    let max_x = (work_area.x + work_area.width - width).max(work_area.x);
    let max_y = (work_area.y + work_area.height - height).max(work_area.y);
    PipGeometry { x: rect.x.clamp(work_area.x, max_x), y: rect.y.clamp(work_area.y, max_y), width, height }
}

fn should_enter_pip(currently_active: bool) -> bool {
    !currently_active
}

fn should_exit_pip(currently_active: bool) -> bool {
    currently_active
}

#[cfg(target_os = "windows")]
fn pip_active(session: &MpvSession) -> bool {
    session.pip_hwnd.lock().unwrap_or_else(|poison| poison.into_inner()).is_some()
}

#[cfg(target_os = "windows")]
fn wide_null(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

// mpv's own window covers everything but an 8px border strip (see PIP_RESIZE_BORDER), so this
// only ever runs for points in that strip: classify by proximity to each edge for resize, and
// fall back to HTCAPTION (drag-move) for the top-left corner leftover once inset from an edge.
#[cfg(target_os = "windows")]
fn pip_hit_test(hwnd: HWND, lparam: LPARAM) -> LRESULT {
    let x = (lparam.0 & 0xFFFF) as i16 as i32;
    let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return LRESULT(HTCAPTION as isize);
    }
    let border = PIP_RESIZE_BORDER;
    let left = x < rect.left + border;
    let right = x >= rect.right - border;
    let top = y < rect.top + border;
    let bottom = y >= rect.bottom - border;
    let code = if left && top {
        HTTOPLEFT
    } else if right && top {
        HTTOPRIGHT
    } else if left && bottom {
        HTBOTTOMLEFT
    } else if right && bottom {
        HTBOTTOMRIGHT
    } else if left {
        HTLEFT
    } else if right {
        HTRIGHT
    } else if top {
        HTTOP
    } else if bottom {
        HTBOTTOM
    } else {
        HTCAPTION
    };
    LRESULT(code as isize)
}

// Only one session/popup exists at a time, so the current video's aspect can be read straight
// off the global session lookup instead of threading per-window state through the wndproc.
#[cfg(target_os = "windows")]
fn current_pip_aspect() -> (f64, f64) {
    let Some(app) = APP_HANDLE_FOR_PIP.get() else { return PIP_DEFAULT_ASPECT };
    let embed_state = app.state::<MpvEmbedState>();
    let session = {
        let guard = embed_state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.as_ref().cloned()
    };
    let Some(session) = session else { return PIP_DEFAULT_ASPECT };
    let metrics = session.video_metrics();
    aspect_from_dimensions(metrics.dwidth, metrics.dheight).unwrap_or(PIP_DEFAULT_ASPECT)
}

// WM_SIZING's lParam points at the proposed window rect (screen coordinates); mutating it here
// is how Win32 expects the aspect lock to be applied before the resize actually takes effect.
#[cfg(target_os = "windows")]
fn pip_apply_aspect_lock(wparam: WPARAM, lparam: LPARAM) {
    let Some(rect) = (unsafe { (lparam.0 as *mut RECT).as_mut() }) else { return };
    let (aspect_w, aspect_h) = current_pip_aspect();
    let edge = wparam.0 as u32;
    let mut width = (rect.right - rect.left).max(PIP_MIN_WIDTH);
    let height;
    if matches!(edge, WMSZ_TOP | WMSZ_BOTTOM) {
        height = (rect.bottom - rect.top).max((PIP_MIN_WIDTH as f64 * aspect_h / aspect_w).round() as i32);
        width = (height as f64 * aspect_w / aspect_h).round() as i32;
    } else {
        height = (width as f64 * aspect_h / aspect_w).round() as i32;
    }
    if matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
        rect.left = rect.right - width;
    } else {
        rect.right = rect.left + width;
    }
    if matches!(edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
        rect.top = rect.bottom - height;
    } else {
        rect.bottom = rect.top + height;
    }
}

// Resizes/moves mpv's child to match, updates the desired PiP geometry, and re-emits the surface
// event, all directly (already on the main thread inside the wndproc; no need to hop again).
#[cfg(target_os = "windows")]
fn pip_on_resized(hwnd: HWND) {
    let Some(app) = APP_HANDLE_FOR_PIP.get() else { return };
    let embed_state = app.state::<MpvEmbedState>();
    let session = {
        let guard = embed_state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.as_ref().cloned()
    };
    let Some(session) = session else { return };
    if !pip_active(&session) {
        return;
    }
    let mut client_rect = RECT::default();
    let mut window_rect = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut client_rect) }.is_err()
        || unsafe { GetWindowRect(hwnd, &mut window_rect) }.is_err()
    {
        return;
    }
    if let Some(surface_value) = resolve_mpv_window(&session) {
        let inset = PIP_RESIZE_BORDER;
        let width = (client_rect.right - client_rect.left - inset * 2).max(1);
        let height = (client_rect.bottom - client_rect.top - inset * 2).max(1);
        let _ = position_surface(surface_value, inset, inset, width, height);
    }
    let geometry = PipGeometry {
        x: window_rect.left,
        y: window_rect.top,
        width: window_rect.right - window_rect.left,
        height: window_rect.bottom - window_rect.top,
    };
    session.target.set_pip(Some(geometry));
    {
        let mut last = embed_state.last_pip_rect.lock().unwrap_or_else(|poison| poison.into_inner());
        *last = Some(geometry);
    }
    emit_surface_event(app, &session, SurfaceState::Pip);
}

// Resize handles on the border, drag-move (HTCAPTION) on whatever the border leaves over,
// aspect-locked resizing, live child resize on WM_SIZE/WM_MOVE, and every exit affordance
// (Escape, double-click, close, Alt+F4) funneled through the one exit request.
#[cfg(target_os = "windows")]
unsafe extern "system" fn pip_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => pip_hit_test(hwnd, lparam),
        WM_SIZING => {
            pip_apply_aspect_lock(wparam, lparam);
            LRESULT(1)
        }
        WM_SIZE | WM_MOVE => {
            pip_on_resized(hwnd);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 as u32 == VK_ESCAPE.0 as u32 => {
            request_pip_exit_from_wndproc();
            LRESULT(0)
        }
        WM_NCLBUTTONDBLCLK | WM_CLOSE => {
            request_pip_exit_from_wndproc();
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

// Fire-and-forget: the wndproc runs on the main thread and must not block it awaiting pip_exit.
#[cfg(target_os = "windows")]
fn request_pip_exit_from_wndproc() {
    let Some(app) = APP_HANDLE_FOR_PIP.get().cloned() else { return };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<MpvEmbedState>();
        let session_id = {
            let guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
            guard.as_ref().map(|session| session.session_id.clone())
        };
        let Some(session_id) = session_id else { return };
        let _ = pip_exit(app.clone(), state, session_id).await;
    });
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

// Resizable, so no WS_THICKFRAME (would need WM_NCCALCSIZE to hide its frame); hit-testing is
// manual instead (see pip_hit_test). No WS_EX_NOACTIVATE: the popup must take focus for Escape.
#[cfg(target_os = "windows")]
fn create_pip_window(owner: HWND, geometry: &PipGeometry) -> Result<isize, String> {
    ensure_pip_class_registered();
    let class_name = wide_null(PIP_CLASS_NAME);
    let instance = unsafe { GetModuleHandleW(None) }.map(HINSTANCE::from).unwrap_or(HINSTANCE(std::ptr::null_mut()));
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN,
            geometry.x,
            geometry.y,
            geometry.width,
            geometry.height,
            Some(owner),
            None,
            Some(instance),
            None,
        )
    }
    .map_err(|error| format!("OTHER:{error}"))?;
    Ok(hwnd.0 as isize)
}

#[cfg(target_os = "windows")]
fn destroy_pip_window(hwnd_value: isize) {
    let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
    if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        let _ = unsafe { DestroyWindow(hwnd) };
    }
}

#[cfg(target_os = "windows")]
fn reparent_child(hwnd_value: isize, new_parent: HWND) -> Result<(), String> {
    let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
    let original_style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    unsafe { SetParent(hwnd, Some(new_parent)) }.map_err(|error| format!("OTHER:{error}"))?;
    // SetParent can drop style bits across the reparent on some Windows builds; reassert them.
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, original_style) };
    Ok(())
}

/// Reparents mpv's window back to the main window (idempotent teardown hook), destroys the
/// popup if any, and marks the session hidden; scheduled on the main thread so it is safe to
/// call from contexts that cannot await (navigation, teardown, app exit).
#[cfg(target_os = "windows")]
fn schedule_surface_teardown(app: &AppHandle, session: &MpvSession) {
    session.target.set_visible(false);
    session.target.set_pip(None);
    let pip_hwnd_value = session.pip_hwnd.lock().unwrap_or_else(|poison| poison.into_inner()).take();
    if let Some(surface_value) = resolve_mpv_window(session) {
        let main_hwnd_value = session.parent_hwnd;
        if let Err(error) = app.run_on_main_thread(move || {
            let _ = apply_surface_win32(main_hwnd_value, surface_value, SurfaceState::Hidden, None);
            if let Some(pip_hwnd_value) = pip_hwnd_value {
                destroy_pip_window(pip_hwnd_value);
            }
        }) {
            log::warn!("[mpv-embed] failed to schedule surface teardown: {error}");
        }
    } else if let Some(pip_hwnd_value) = pip_hwnd_value {
        let app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || destroy_pip_window(pip_hwnd_value)) {
            log::warn!("[mpv-embed] failed to schedule PiP teardown: {error}");
        }
    }
    emit_surface_event(app, session, SurfaceState::Hidden);
}

#[cfg(target_os = "windows")]
async fn pip_enter(app: AppHandle, state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    if !should_enter_pip(pip_active(&session)) {
        return Ok(());
    }
    resolve_mpv_window(&session).ok_or_else(|| "NOT_FOUND:mpv surface window not ready".to_string())?;
    let main_window = app.get_webview_window("main").ok_or_else(|| "OTHER:main window unavailable".to_string())?;
    // HWND is not Send, so only its raw value may stay alive across the awaits below.
    let main_hwnd_value = main_window.hwnd().map_err(|error| format!("OTHER:{error}"))?.0 as isize;
    let main_hwnd = HWND(main_hwnd_value as *mut core::ffi::c_void);
    let work_area = work_area_for_window(main_hwnd);

    let last_rect = *state.last_pip_rect.lock().unwrap_or_else(|poison| poison.into_inner());
    let geometry = match last_rect {
        Some(rect) => clamp_pip_geometry(rect, work_area),
        None => {
            let metrics = session.video_metrics();
            pip_default_geometry(aspect_from_dimensions(metrics.dwidth, metrics.dheight), work_area)
        }
    };

    let pip_hwnd_value = run_on_main_thread_and_wait(&app, move || {
        create_pip_window(HWND(main_hwnd_value as *mut core::ffi::c_void), &geometry)
    })
    .await??;

    {
        let mut guard = session.pip_hwnd.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(pip_hwnd_value);
    }
    session.target.set_pip(Some(geometry));
    {
        let mut last = state.last_pip_rect.lock().unwrap_or_else(|poison| poison.into_inner());
        *last = Some(geometry);
    }

    apply_surface(&app, &session).await
}

#[cfg(target_os = "windows")]
async fn pip_exit(app: AppHandle, state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    if !should_exit_pip(pip_active(&session)) {
        return Ok(());
    }
    session.target.set_pip(None);
    apply_surface(&app, &session).await?;

    let pip_hwnd_value = session.pip_hwnd.lock().unwrap_or_else(|poison| poison.into_inner()).take();
    if let Some(pip_hwnd_value) = pip_hwnd_value {
        run_on_main_thread_and_wait(&app, move || destroy_pip_window(pip_hwnd_value)).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Native fullscreen (tao's set_fullscreen leaves a maximized window at its restored size)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
async fn run_on_main_thread_and_wait<T, F>(app: &AppHandle, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(task());
    })
    .map_err(|error| format!("OTHER:{error}"))?;
    tokio::time::timeout(MAIN_THREAD_CALL_TIMEOUT, receiver)
        .await
        .map_err(|_| "TIMEOUT:main-thread call did not complete".to_string())?
        .map_err(|_| "OTHER:main-thread call dropped".to_string())
}

// Chromium's HWNDMessageHandler::SetFullscreen mask: drop the frame, keep client-area chrome.
#[cfg(target_os = "windows")]
fn fullscreen_style_bits(style: isize) -> isize {
    style & !((WS_CAPTION.0 as isize) | (WS_THICKFRAME.0 as isize))
}

#[cfg(target_os = "windows")]
fn fullscreen_ex_style_bits(ex_style: isize) -> isize {
    ex_style
        & !((WS_EX_DLGMODALFRAME.0 as isize)
            | (WS_EX_WINDOWEDGE.0 as isize)
            | (WS_EX_CLIENTEDGE.0 as isize)
            | (WS_EX_STATICEDGE.0 as isize))
}

/// Idempotent: a second enter (state already saved) is a no-op.
#[cfg(target_os = "windows")]
fn enter_window_fullscreen(hwnd: HWND, state: &MpvEmbedState) -> Result<(), String> {
    let mut guard = state.fullscreen.lock().unwrap_or_else(|poison| poison.into_inner());
    if guard.is_some() {
        return Ok(());
    }
    let maximized = unsafe { IsZoomed(hwnd) }.as_bool();
    if maximized {
        unsafe { SendMessageW(hwnd, WM_SYSCOMMAND, Some(WPARAM(SC_RESTORE as usize)), Some(LPARAM(0))) };
    }
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|error| format!("OTHER:{error}"))?;

    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, fullscreen_style_bits(style)) };
    unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, fullscreen_ex_style_bits(ex_style)) };

    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut monitor_info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !unsafe { GetMonitorInfoW(monitor, &mut monitor_info) }.as_bool() {
        return Err("OTHER:failed to read monitor info".to_string());
    }
    let monitor_rect = monitor_info.rcMonitor;
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            monitor_rect.left,
            monitor_rect.top,
            monitor_rect.right - monitor_rect.left,
            monitor_rect.bottom - monitor_rect.top,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
    }
    .map_err(|error| format!("OTHER:{error}"))?;

    *guard = Some(SavedWindowState { style, ex_style, rect, maximized });
    Ok(())
}

/// Idempotent: a second exit (nothing saved) is a no-op.
#[cfg(target_os = "windows")]
fn exit_window_fullscreen(hwnd: HWND, state: &MpvEmbedState) -> Result<(), String> {
    let mut guard = state.fullscreen.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(saved) = guard.take() else { return Ok(()) };
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, saved.style) };
    unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, saved.ex_style) };
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            saved.rect.left,
            saved.rect.top,
            saved.rect.right - saved.rect.left,
            saved.rect.bottom - saved.rect.top,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
    }
    .map_err(|error| format!("OTHER:{error}"))?;
    if saved.maximized {
        unsafe { SendMessageW(hwnd, WM_SYSCOMMAND, Some(WPARAM(SC_MAXIMIZE as usize)), Some(LPARAM(0))) };
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_window_fullscreen(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let main_window = app.get_webview_window("main").ok_or_else(|| "OTHER:main window unavailable".to_string())?;
    let hwnd = main_window.hwnd().map_err(|error| format!("OTHER:{error}"))?;
    let state = app.state::<MpvEmbedState>();
    if enabled {
        enter_window_fullscreen(hwnd, &state)
    } else {
        exit_window_fullscreen(hwnd, &state)
    }
}

#[cfg(target_os = "windows")]
async fn set_window_fullscreen(app: AppHandle, enabled: bool) -> Result<(), String> {
    let app_for_main_thread = app.clone();
    run_on_main_thread_and_wait(&app, move || apply_window_fullscreen(&app_for_main_thread, enabled)).await??;
    let state = app.state::<MpvEmbedState>();
    let session = {
        let guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.as_ref().cloned()
    };
    if let Some(session) = session {
        session.target.set_fullscreen(enabled);
        if let Err(error) = apply_surface(&app, &session).await {
            log::warn!(
                "[mpv-embed] session {} failed to apply surface after fullscreen toggle: {error}",
                session.session_id
            );
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn set_window_fullscreen(app: AppHandle, enabled: bool) -> Result<(), String> {
    let main_window = app.get_webview_window("main").ok_or_else(|| "OTHER:main window unavailable".to_string())?;
    main_window.set_fullscreen(enabled).map_err(|error| format!("OTHER:{error}"))
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

// mpv truncates its log file on every spawn; keep the previous run's log for bug reports.
#[cfg(target_os = "windows")]
fn mpv_embed_log_path(app: &AppHandle) -> String {
    match app.path().app_log_dir() {
        Ok(dir) => {
            let current = dir.join("mpv-embed.log");
            if current.exists() {
                let _ = std::fs::rename(&current, dir.join("mpv-embed.prev.log"));
            }
            current.to_string_lossy().into_owned()
        }
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

// Hides synchronously, all before any teardown IPC: the frontend's unload-time invoke() dies
// with the discarded document, so this cannot wait on anything past the main thread schedule.
#[cfg(target_os = "windows")]
pub fn on_main_page_navigation(app: &AppHandle) {
    let state = app.state::<MpvEmbedState>();
    let session = {
        let guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.as_ref().cloned()
    };
    let Some(session) = session else { return };
    schedule_surface_teardown(app, &session);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_handle.state::<MpvEmbedState>();
        teardown_current_session(&app_handle, &state).await;
    });
}

#[cfg(not(target_os = "windows"))]
pub fn on_main_page_navigation(_app: &AppHandle) {}

// Placement is computed against the parent client size, so a change to it with no bounds
// change still needs a recompute; send wakes run_surface_updates with no payload of its own.
#[cfg(target_os = "windows")]
fn wake_surface_task(app: &AppHandle) {
    let state = app.state::<MpvEmbedState>();
    let session = {
        let guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.as_ref().cloned()
    };
    let Some(session) = session else { return };
    let _ = session.placement_tx.send(());
}

#[cfg(target_os = "windows")]
pub fn on_main_window_resized(app: &AppHandle) {
    wake_surface_task(app);
}

#[cfg(not(target_os = "windows"))]
pub fn on_main_window_resized(_app: &AppHandle) {}

/// Kills the child, or wakes `run_exit_watch` to do it; `finish_exit` stays the only emitter.
#[cfg(target_os = "windows")]
async fn teardown_session(app: &AppHandle, session: &Arc<MpvSession>) {
    schedule_surface_teardown(app, session);
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
    schedule_surface_teardown(app, session);
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

// Best-effort: a dead child that never wrote anything, or one still writing, both yield None.
#[cfg(target_os = "windows")]
async fn read_child_stderr_head(child: &mut Child) -> Option<String> {
    let mut stderr = child.stderr.take()?;
    let mut buffer = vec![0u8; 2048];
    match tokio::time::timeout(Duration::from_millis(500), stderr.read(&mut buffer)).await {
        Ok(Ok(bytes_read)) if bytes_read > 0 => Some(String::from_utf8_lossy(&buffer[..bytes_read]).into_owned()),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
async fn start_session(app: AppHandle, state: State<'_, MpvEmbedState>, bounds: Bounds) -> Result<MpvEmbedSession, String> {
    let _ = APP_HANDLE_FOR_PIP.set(app.clone());
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
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| external_player::classify_io_error(&error))?;
    let pid = child.id().ok_or_else(|| "OTHER:mpv exited before a pid was available".to_string())?;

    let pipe_client = match connect_ipc_with_retry(&pipe_name, IPC_CONNECT_TIMEOUT).await {
        Ok(client) => client,
        Err(error) => {
            let _ = child.start_kill();
            let stderr_head = read_child_stderr_head(&mut child).await;
            let exit_code = child.wait().await.ok().and_then(|status| status.code());
            let message =
                format_ipc_start_failure(&mpv_path, exit_code, &error.to_string(), stderr_head.as_deref());
            log::warn!("[mpv-embed] {message}");
            return Err(message);
        }
    };

    // Drains stderr into the log so a chatty mpv build never blocks on a full pipe.
    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end();
                        if !trimmed.is_empty() {
                            log::debug!("[mpv-embed] session {session_id_for_log} stderr: {trimmed}");
                        }
                    }
                }
            }
        });
    }

    let (read_half, write_half) = split(pipe_client);
    let ipc = Arc::new(MpvIpcClient {
        writer: tokio::sync::Mutex::new(write_half),
        pending: Mutex::new(HashMap::new()),
        next_request_id: AtomicU64::new(1),
        closed: AtomicBool::new(false),
    });
    let emit_state = Arc::new(PropertyEmitState::new());
    let (placement_tx, placement_rx) = tokio::sync::watch::channel::<()>(());

    let session = Arc::new(MpvSession {
        session_id: session_id.clone(),
        pid,
        parent_hwnd: parent_value,
        mpv_hwnd: Mutex::new(None),
        target: SurfaceTarget::new(bounds, true),
        video_metrics: Mutex::new(VideoMetrics::default()),
        placement_tx,
        ipc: ipc.clone(),
        child: tokio::sync::Mutex::new(Some(child)),
        kill_notify: Notify::new(),
        torn_down: AtomicBool::new(false),
        reader_task: Mutex::new(None),
        pip_hwnd: Mutex::new(None),
    });

    let reader_handle = tauri::async_runtime::spawn(run_reader(
        app.clone(),
        session.clone(),
        BufReader::new(read_half),
        ipc.clone(),
        emit_state,
    ));
    {
        let mut guard = session.reader_task.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(reader_handle);
    }

    register_observed_properties(&session).await;
    if let Err(error) = initialize_video_placement(&session.ipc).await {
        log::warn!("[mpv-embed] session {session_id} failed to initialize video placement: {error}");
    }
    let osc_hide = json!({ "command": ["script-message", "osc-visibility", "never"] });
    if let Err(error) = session.ipc.send_request(osc_hide, MPV_IPC_TIMEOUT).await {
        log::warn!("[mpv-embed] session {session_id} failed to hide the OSC by default: {error}");
    }

    // Weak: this task must not keep the session alive, or placement_tx (owned by the session)
    // could never drop to close the channel and let the loop end.
    tauri::async_runtime::spawn(run_surface_updates(app.clone(), Arc::downgrade(&session), placement_rx));
    let _ = session.placement_tx.send(());

    tauri::async_runtime::spawn(watch_for_mpv_window(session.clone()));
    tauri::async_runtime::spawn(run_exit_watch(app.clone(), session.clone()));

    {
        let mut guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(session.clone());
    }

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
        Some(session) => {
            let in_pip = pip_active(session);
            let surface = derive_surface_state(session.target.visible(), session.target.fullscreen(), in_pip);
            MpvEmbedStatus {
                running: true,
                session_id: Some(session.session_id.clone()),
                pid: Some(session.pid),
                pip_active: in_pip,
                surface: surface_state_name(surface).to_string(),
                pip_rect: session.target.pip(),
            }
        }
        None => MpvEmbedStatus {
            running: false,
            session_id: None,
            pid: None,
            pip_active: false,
            surface: surface_state_name(SurfaceState::Hidden).to_string(),
            pip_rect: None,
        },
    }
}

#[cfg(not(target_os = "windows"))]
fn status_impl(_state: &MpvEmbedState) -> MpvEmbedStatus {
    MpvEmbedStatus {
        running: false,
        session_id: None,
        pid: None,
        pip_active: false,
        surface: surface_state_name(SurfaceState::Hidden).to_string(),
        pip_rect: None,
    }
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
    session.target.set_bounds(bounds);
    let _ = session.placement_tx.send(());
    Ok(())
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
    session.target.set_visible(visible);
    let _ = session.placement_tx.send(());
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
pub async fn mpv_embed_pip_exit(app: AppHandle, state: State<'_, MpvEmbedState>, session_id: String) -> Result<(), String> {
    pip_exit(app, state, session_id).await
}

#[cfg(not(target_os = "windows"))]
async fn pip_exit(_app: AppHandle, _state: State<'_, MpvEmbedState>, _session_id: String) -> Result<(), String> {
    Err(platform_unsupported())
}

#[tauri::command]
pub async fn mpv_embed_window_fullscreen(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_window_fullscreen(app, enabled).await
}

#[tauri::command]
pub async fn mpv_embed_screenshot(app: AppHandle, state: State<'_, MpvEmbedState>, session_id: String) -> Result<String, String> {
    take_screenshot(app, state, session_id).await
}

#[cfg(target_os = "windows")]
async fn take_screenshot(app: AppHandle, state: State<'_, MpvEmbedState>, session_id: String) -> Result<String, String> {
    let session = get_session(&state, &session_id)?;
    let picture_dir = app.path().picture_dir().map_err(|error| format!("OTHER:{error}"))?;
    let target_dir = picture_dir.join("Extreme InfiniTV");
    std::fs::create_dir_all(&target_dir).map_err(|error| format!("OTHER:{error}"))?;
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let path_string = target_dir.join(format!("Screenshot {stamp}.png")).to_string_lossy().into_owned();
    external_player::validate_arg(&path_string, "screenshot path")?;
    session
        .ipc
        .send_request(json!({ "command": ["screenshot-to-file", path_string, "video"] }), MPV_IPC_TIMEOUT)
        .await?;
    Ok(path_string)
}

#[cfg(not(target_os = "windows"))]
async fn take_screenshot(_app: AppHandle, _state: State<'_, MpvEmbedState>, _session_id: String) -> Result<String, String> {
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
pub fn shutdown(app: &AppHandle, state: &MpvEmbedState) {
    let session = {
        let mut guard = state.session.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.take()
    };
    let Some(session) = session else { return };
    schedule_surface_teardown(app, &session);
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
pub fn shutdown(_app: &AppHandle, _state: &MpvEmbedState) {}

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
                "--osc=yes".to_string(),
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
                "--hwdec=auto-safe".to_string(),
                "--audio-client-name=Extreme InfiniTV".to_string(),
                "--screenshot-format=png".to_string(),
                "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5".to_string(),
                "--cache=yes".to_string(),
                "--demuxer-max-bytes=150MiB".to_string(),
                "--demuxer-readahead-secs=20".to_string(),
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
    fn format_ipc_start_failure_reports_the_binary_exit_and_os_error() {
        let message = format_ipc_start_failure(r"C:\app\infinitv-mpv.exe", Some(1), "the pipe did not open", None);
        assert_eq!(
            message,
            r"IPC:failed to connect to mpv at C:\app\infinitv-mpv.exe (exit: 1): the pipe did not open"
        );
    }

    #[test]
    fn format_ipc_start_failure_labels_a_still_running_child() {
        let message = format_ipc_start_failure("mpv.exe", None, "timed out", None);
        assert!(message.contains("(exit: still running)"));
    }

    #[test]
    fn format_ipc_start_failure_appends_a_trimmed_stderr_head() {
        let message =
            format_ipc_start_failure("mpv.exe", Some(2), "timed out", Some("unknown option --wid=abc\nmore"));
        assert!(message.ends_with("- stderr: unknown option --wid=abc more"));
    }

    #[test]
    fn format_ipc_start_failure_omits_the_stderr_suffix_when_empty() {
        let message = format_ipc_start_failure("mpv.exe", Some(0), "timed out", Some("   "));
        assert!(!message.contains("stderr"));
    }

    #[test]
    fn trim_stderr_head_collapses_whitespace_and_truncates() {
        assert_eq!(trim_stderr_head("  line one\r\nline two  ", 12), "line one lin");
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
            ("dwidth", "dwidth"),
            ("dheight", "dheight"),
            ("panscan", "panscan"),
            ("speed", "speed"),
            ("volume", "volume"),
            ("mute", "mute"),
            ("container-fps", "containerFps"),
            ("decoder-frame-drop-count", "decoderFrameDropCount"),
            ("demuxer-cache-time", "demuxerCacheTime"),
            ("video-format", "videoFormat"),
            ("audio-params/format", "audioFormat"),
            ("audio-params/channel-count", "audioChannelCount"),
            ("video-params/pixelformat", "pixelFormat"),
            ("file-format", "fileFormat"),
            ("seekable", "seekable"),
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

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-6, "expected {expected}, got {actual}");
    }

    #[test]
    fn placement_for_bounds_centers_a_box_inside_the_window() {
        let bounds = Bounds { x: 400, y: 225, width: 800, height: 450, radius: 0 };
        let placement = placement_for_bounds(bounds, 1600, 900, Some(1600.0), Some(900.0), 0.0);
        assert_close(placement.zoom, -1.0);
        assert_close(placement.pan_x, 0.0);
        assert_close(placement.pan_y, 0.0);
    }

    #[test]
    fn placement_for_bounds_pans_toward_a_box_in_the_top_left_corner() {
        let bounds = Bounds { x: 0, y: 0, width: 800, height: 450, radius: 0 };
        let placement = placement_for_bounds(bounds, 1600, 900, Some(1600.0), Some(900.0), 0.0);
        assert_close(placement.zoom, -1.0);
        assert_close(placement.pan_x, -0.5);
        assert_close(placement.pan_y, -0.5);
    }

    #[test]
    fn placement_for_bounds_keeps_zoom_unchanged_when_the_box_scrolls_off_the_top() {
        let bounds = Bounds { x: 400, y: -225, width: 800, height: 450, radius: 0 };
        let placement = placement_for_bounds(bounds, 1600, 900, Some(1600.0), Some(900.0), 0.0);
        assert_close(placement.zoom, -1.0);
        assert_close(placement.pan_x, 0.0);
        assert_close(placement.pan_y, -1.0);
    }

    #[test]
    fn placement_for_bounds_covers_the_box_at_panscan_one() {
        let bounds = Bounds { x: 600, y: 250, width: 400, height: 400, radius: 0 };
        let placement = placement_for_bounds(bounds, 1600, 900, Some(1600.0), Some(900.0), 1.0);
        assert_close(placement.zoom, (4.0_f64 / 9.0).log2());
        assert_close(placement.pan_x, 0.0);
        assert_close(placement.pan_y, 0.0);
    }

    #[test]
    fn placement_for_bounds_falls_back_to_the_box_aspect_when_video_dims_are_unknown() {
        let bounds = Bounds { x: 400, y: 450, width: 200, height: 100, radius: 0 };
        let placement = placement_for_bounds(bounds, 1000, 1000, None, None, 0.0);
        assert_close(placement.zoom, 0.2_f64.log2());
        assert_close(placement.pan_x, 0.0);
        assert_close(placement.pan_y, 0.0);
    }

    #[test]
    fn placement_for_bounds_centers_on_a_degenerate_client_rect() {
        let bounds = Bounds { x: 0, y: 0, width: 100, height: 100, radius: 0 };
        assert_eq!(placement_for_bounds(bounds, 0, 700, Some(16.0), Some(9.0), 0.0), VideoPlacement::CENTERED);
    }

    #[test]
    fn derive_surface_state_pip_wins_over_everything() {
        assert_eq!(derive_surface_state(true, true, true), SurfaceState::Pip);
        assert_eq!(derive_surface_state(false, false, true), SurfaceState::Pip);
    }

    #[test]
    fn derive_surface_state_fullscreen_wins_over_embedded() {
        assert_eq!(derive_surface_state(true, true, false), SurfaceState::Fullscreen);
    }

    #[test]
    fn derive_surface_state_visible_without_fullscreen_or_pip_is_embedded() {
        assert_eq!(derive_surface_state(true, false, false), SurfaceState::Embedded);
    }

    #[test]
    fn derive_surface_state_defaults_to_hidden() {
        assert_eq!(derive_surface_state(false, false, false), SurfaceState::Hidden);
    }

    #[test]
    fn clamp_pip_geometry_leaves_a_rect_already_inside_the_work_area_alone() {
        let work_area = WorkArea { x: 0, y: 0, width: 1920, height: 1080 };
        let rect = PipGeometry { x: 100, y: 100, width: 360, height: 202 };
        assert_eq!(clamp_pip_geometry(rect, work_area), rect);
    }

    #[test]
    fn clamp_pip_geometry_pulls_an_off_screen_rect_back_into_the_work_area() {
        let work_area = WorkArea { x: 0, y: 0, width: 1920, height: 1080 };
        let rect = PipGeometry { x: -50, y: 2000, width: 360, height: 202 };
        let clamped = clamp_pip_geometry(rect, work_area);
        assert_eq!(clamped.x, 0);
        assert_eq!(clamped.y, 1080 - 202);
    }

    #[test]
    fn clamp_pip_geometry_shrinks_a_rect_wider_than_the_work_area() {
        let work_area = WorkArea { x: 0, y: 0, width: 300, height: 1080 };
        let rect = PipGeometry { x: 0, y: 0, width: 900, height: 506 };
        let clamped = clamp_pip_geometry(rect, work_area);
        assert_eq!(clamped.width, 300);
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

    #[cfg(target_os = "windows")]
    #[test]
    fn surface_target_round_trips_bounds_visible_fullscreen_and_pip() {
        let initial = Bounds { x: 0, y: 0, width: 100, height: 100, radius: 0 };
        let target = SurfaceTarget::new(initial, true);
        assert_eq!(target.bounds(), Some(initial));
        assert!(target.visible());
        assert!(!target.fullscreen());
        assert_eq!(target.pip(), None);

        let updated = Bounds { x: 10, y: 20, width: 640, height: 360, radius: 12 };
        let pip = PipGeometry { x: 5, y: 6, width: 360, height: 202 };
        target.set_bounds(updated);
        target.set_visible(false);
        target.set_fullscreen(true);
        target.set_pip(Some(pip));
        assert_eq!(target.bounds(), Some(updated));
        assert!(!target.visible());
        assert!(target.fullscreen());
        assert_eq!(target.pip(), Some(pip));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn fullscreen_style_bits_drops_the_caption_and_thick_frame() {
        let style = (WS_CAPTION.0 | WS_THICKFRAME.0 | 0x1000_0000) as isize;
        assert_eq!(fullscreen_style_bits(style), 0x1000_0000);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn fullscreen_style_bits_leaves_unrelated_bits_untouched() {
        assert_eq!(fullscreen_style_bits(0x1000_0000), 0x1000_0000);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn fullscreen_ex_style_bits_drops_the_frame_edge_bits() {
        let ex_style = (WS_EX_DLGMODALFRAME.0
            | WS_EX_WINDOWEDGE.0
            | WS_EX_CLIENTEDGE.0
            | WS_EX_STATICEDGE.0
            | 0x1000_0000) as isize;
        assert_eq!(fullscreen_ex_style_bits(ex_style), 0x1000_0000);
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
