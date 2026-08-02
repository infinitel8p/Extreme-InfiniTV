// External-player launch + detect bridge.
//
// The frontend invokes `launch_external_player` with a binary path and an
// argv vector to either spawn the player detached (mode = "launch") or
// probe a candidate binary's `--version` output (mode = "detect"). Errors
// are returned with a stable prefix so the frontend can map them to
// localized toasts without parsing OS-specific messages:
//
//   "NOT_FOUND:..."   - the binary at `path` does not exist
//   "PERMISSION:..."  - the OS refused execution (executable bit, ACL)
//   "TIMEOUT:..."     - detect mode hit the 2s budget without exiting
//   "OTHER:..."       - anything else

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const DETECT_TIMEOUT_MS: u64 = 2000;
const DETECT_POLL_INTERVAL_MS: u64 = 25;
#[cfg(unix)]
const IPC_WRITE_TIMEOUT_MS: u64 = 1500;
#[cfg(windows)]
const IPC_REPLY_TIMEOUT_MS: u64 = 500;
const EXTERNAL_PLAYER_EXITED_EVENT: &str = "xt:external-player-exited";
const EXIT_WATCH_POLL_INTERVAL: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// Reuse-slot state
// ---------------------------------------------------------------------------
#[derive(Clone, Debug)]
struct Slot {
    pid: u32,
    /// For MPV: socket path (Unix) or pipe name (Windows, e.g. `\\.\pipe\xt-mpv-N`).
    /// For VLC: `host:port` literal string.
    endpoint: String,
}

#[derive(Default)]
pub struct ExternalPlayerState {
    inner: Mutex<HashMap<String, Slot>>,
    /// One async mutex per launch kind ("mpv" / "vlc"). Held across the
    /// "check existing slot -> IPC send OR spawn new -> persist new slot"
    /// critical section so two concurrent launches for the same kind can't
    /// race and orphan a spawned player.
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Bumping a kind's generation supersedes its older exit-watchers.
    watch_generations: Mutex<HashMap<String, u64>>,
    watched_pids: Mutex<HashMap<String, u32>>,
}

#[derive(Debug, Deserialize, Default)]
pub struct ReuseConfig {
    pub kind: String,
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
}

impl ExternalPlayerState {
    fn get(&self, kind: &str) -> Option<Slot> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.get(kind).cloned()
    }

    fn set(&self, kind: &str, slot: Slot) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.insert(kind.to_string(), slot);
    }

    fn drop_slot(&self, kind: &str) -> Option<Slot> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.remove(kind)
    }

    fn launch_lock(&self, kind: &str) -> Arc<AsyncMutex<()>> {
        let mut guard = self
            .locks
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard
            .entry(kind.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn bump_watch_generation(&self, kind: &str) -> u64 {
        let mut guard = self
            .watch_generations
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let generation = guard.entry(kind.to_string()).or_insert(0);
        *generation += 1;
        *generation
    }

    fn watch_generation_is_current(&self, kind: &str, generation: u64) -> bool {
        let guard = self
            .watch_generations
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.get(kind).copied() == Some(generation)
    }

    /// False when `pid` is already the watched pid for `kind`.
    fn mark_watched_pid(&self, kind: &str, pid: u32) -> bool {
        let mut guard = self
            .watched_pids
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.get(kind).copied() == Some(pid) {
            false
        } else {
            guard.insert(kind.to_string(), pid);
            true
        }
    }

    /// Equality-guarded so a stale watcher can't clear a newer watcher's pid.
    fn clear_watched_pid(&self, kind: &str, pid: u32) {
        let mut guard = self
            .watched_pids
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.get(kind).copied() == Some(pid) {
            guard.remove(kind);
        }
    }
}

// ---------------------------------------------------------------------------
// Sandbox detection
// ---------------------------------------------------------------------------
// Snap/Flatpak confinement blocks exec of host binaries like MPV/VLC.

// SNAP_NAME leaks into launcher children; verify exe sits in the mount.
#[allow(dead_code)]
fn snap_confined(exe_path: Option<&Path>, snap_dir: Option<&str>, snap_name: Option<&str>) -> bool {
    match (snap_dir, snap_name) {
        (Some(snap_dir), Some(_)) if !snap_dir.is_empty() => {
            exe_path.is_some_and(|exe| exe.starts_with(snap_dir))
        }
        _ => false,
    }
}

#[allow(dead_code)]
fn classify_sandbox_runtime(
    exe_path: Option<&Path>,
    snap_dir: Option<&str>,
    snap_name: Option<&str>,
    flatpak_id: Option<&str>,
    flatpak_info_exists: bool,
) -> Option<&'static str> {
    if snap_confined(exe_path, snap_dir, snap_name) {
        return Some("snap");
    }
    if flatpak_id.is_some() || flatpak_info_exists {
        return Some("flatpak");
    }
    None
}

#[cfg(target_os = "linux")]
fn sandbox_runtime_kind() -> Option<String> {
    classify_sandbox_runtime(
        std::env::current_exe().ok().as_deref(),
        std::env::var("SNAP").ok().as_deref(),
        std::env::var("SNAP_NAME").ok().as_deref(),
        std::env::var("FLATPAK_ID").ok().as_deref(),
        Path::new("/.flatpak-info").exists(),
    )
    .map(str::to_string)
}

#[cfg(not(target_os = "linux"))]
fn sandbox_runtime_kind() -> Option<String> {
    None
}

// Injects window.__XT_SANDBOX__ before page scripts run (no async race).
pub fn sandbox_bootstrap_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let sandbox_value = match sandbox_runtime_kind() {
        Some(kind) => format!("\"{kind}\""),
        None => "null".to_string(),
    };
    tauri::plugin::Builder::new("xt-sandbox-bootstrap")
        .js_init_script(format!("window.__XT_SANDBOX__ = {sandbox_value};"))
        .build()
}

// ---------------------------------------------------------------------------
// Spawn helpers (unchanged surface)
// ---------------------------------------------------------------------------
fn classify_io_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("NOT_FOUND:{err}"),
        std::io::ErrorKind::PermissionDenied => format!("PERMISSION:{err}"),
        _ => format!("OTHER:{err}"),
    }
}

#[cfg(target_os = "macos")]
fn resolve_app_bundle(path: &str) -> String {
    let p = Path::new(path);
    if p.extension().and_then(|s| s.to_str()) != Some("app") {
        return path.to_string();
    }
    let macos_dir = p.join("Contents/MacOS");
    if let Ok(entries) = std::fs::read_dir(&macos_dir) {
        let files: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .collect();
        if files.len() == 1 {
            return files[0].path().to_string_lossy().into_owned();
        }
    }
    let info_plist = p.join("Contents/Info.plist");
    if let Ok(contents) = std::fs::read_to_string(&info_plist) {
        if let Some(name) = parse_cf_bundle_executable(&contents) {
            let bin = macos_dir.join(&name);
            if bin.exists() {
                return bin.to_string_lossy().into_owned();
            }
        }
    }
    path.to_string()
}

#[cfg(not(target_os = "macos"))]
fn resolve_app_bundle(path: &str) -> String {
    path.to_string()
}

#[cfg(target_os = "macos")]
fn is_macos_app_running(bundle_path: &str) -> bool {
    let needle = format!("{}/Contents/MacOS/", bundle_path);
    let output = Command::new("/usr/bin/pgrep")
        .arg("-f")
        .arg(&needle)
        .output();
    match output {
        Ok(out) => !out.stdout.is_empty(),
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn parse_cf_bundle_executable(xml: &str) -> Option<String> {
    let mut iter = xml.split("<key>CFBundleExecutable</key>");
    iter.next()?;
    let rest = iter.next()?;
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")?;
    Some(rest[start..start + end].trim().to_string())
}

fn build_command(path: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Reject paths/args containing characters that have no business in a binary
/// path or command-line argument. The Rust child-process API itself is
/// shell-free, but a NUL terminates strings at the OS layer and a newline in
/// a log line can forge fake structured-log entries. Belt-and-braces only;
/// callers also enforce the picker UI on the frontend.
pub(crate) fn validate_arg(value: &str, label: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("OTHER:{label} contains NUL byte"));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err(format!("OTHER:{label} contains newline"));
    }
    Ok(())
}

fn validate_invocation(path: &str, args: &[String]) -> Result<(), String> {
    validate_arg(path, "path")?;
    for arg in args {
        validate_arg(arg, "arg")?;
    }
    Ok(())
}

/// Returned bool is false for the macOS `open -a` handoff, whose pid is not the player's.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn spawn_launch_inner(path: &str, args: &[String], direct_exec: bool) -> Result<(u32, bool), String> {
    if path.is_empty() {
        return Err("NOT_FOUND:player path is empty".to_string());
    }
    validate_invocation(path, args)?;
    if !Path::new(path).exists() {
        return Err(format!("NOT_FOUND:no file at {path}"));
    }
    #[cfg(target_os = "macos")]
    {
        if !direct_exec && Path::new(path).extension().and_then(|s| s.to_str()) == Some("app") {
            let mut cmd = Command::new("/usr/bin/open");
            if is_macos_app_running(path) {
                // A running instance only accepts open-document events: URL only, no option args.
                cmd.arg("-a").arg(path);
                if let Some(url) = args.last() {
                    cmd.arg(url);
                }
            } else {
                cmd.arg("-a").arg(path).arg("--args").args(args);
            }
            cmd.stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            return match cmd.spawn() {
                Ok(child) => Ok((child.id(), false)),
                Err(e) => Err(classify_io_error(&e)),
            };
        }
    }
    let resolved = resolve_app_bundle(path);
    let mut cmd = build_command(&resolved, args);
    match cmd.spawn() {
        Ok(child) => Ok((child.id(), true)),
        Err(e) => Err(classify_io_error(&e)),
    }
}

fn spawn_detect(path: String, mut args: Vec<String>) -> Result<String, String> {
    if path.is_empty() {
        return Err("NOT_FOUND:player path is empty".to_string());
    }
    validate_invocation(&path, &args)?;
    if !args.iter().any(|a| a == "--version") {
        args.push("--version".to_string());
    }
    let resolved = resolve_app_bundle(&path);
    let mut cmd = Command::new(&resolved);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(classify_io_error(&e)),
    };

    let started = Instant::now();
    let budget = Duration::from_millis(DETECT_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let output = child.wait_with_output().map_err(|e| format!("OTHER:{e}"))?;
                let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
                if text.trim().is_empty() {
                    text = String::from_utf8_lossy(&output.stderr).into_owned();
                }
                let first_line = text
                    .lines()
                    .next()
                    .map(|line| line.trim().to_string())
                    .unwrap_or_default();
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

// ---------------------------------------------------------------------------
// Endpoint generation
// ---------------------------------------------------------------------------
static ENDPOINT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let counter = ENDPOINT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", std::process::id(), nanos, counter)
}

fn pick_mpv_endpoint() -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\xt-mpv-{}", unique_suffix())
    }
    #[cfg(not(windows))]
    {
        let mut dir = std::env::temp_dir();
        dir.push(format!("xt-mpv-{}.sock", unique_suffix()));
        dir.to_string_lossy().into_owned()
    }
}

#[cfg(unix)]
fn unlink_unix_socket(endpoint: &str) {
    if endpoint.is_empty() {
        return;
    }
    let _ = std::fs::remove_file(endpoint);
}

/// Sweep stale xt-mpv-*.sock files left behind by previously-crashed mpv
/// instances. Called once at startup so /tmp doesn't accumulate dead sockets
/// across sessions. Only entries older than ~1h are touched.
#[cfg(unix)]
pub fn sweep_orphan_mpv_sockets() {
    let temp = std::env::temp_dir();
    let entries = match std::fs::read_dir(&temp) {
        Ok(it) => it,
        Err(_) => return,
    };
    let now = std::time::SystemTime::now();
    let stale_after = Duration::from_secs(3600);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("xt-mpv-") || !name.ends_with(".sock") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok();
        let stale = modified
            .and_then(|time| now.duration_since(time).ok())
            .map(|elapsed| elapsed > stale_after)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(not(unix))]
pub fn sweep_orphan_mpv_sockets() {}

// ---------------------------------------------------------------------------
// Argv augmentation when reuse is freshly spawned
// ---------------------------------------------------------------------------
fn augment_mpv_args(mut args: Vec<String>, endpoint: &str) -> Vec<String> {
    args.retain(|arg| {
        !(arg.starts_with("--input-ipc-server=")
            || arg.starts_with("--input-ipc-server-path=")
            || arg == "--idle"
            || arg.starts_with("--idle="))
    });
    let src = args.pop();
    args.push(format!("--input-ipc-server={endpoint}"));
    args.push("--idle=yes".to_string());
    args.push("--force-window=immediate".to_string());
    if let Some(src) = src {
        args.push(src);
    }
    args
}

fn augment_vlc_args(args: Vec<String>) -> Vec<String> {
    augment_vlc_args_inner(args, cfg!(target_os = "macos"))
}

// macOS VLC has no --one-instance (Qt/Win32-only) and exits on unknown options.
fn augment_vlc_args_inner(mut args: Vec<String>, is_macos: bool) -> Vec<String> {
    args.retain(|arg| arg != "--play-and-exit");
    if is_macos {
        return args;
    }
    let src = args.pop();
    args.push("--one-instance".to_string());
    args.push("--no-playlist-enqueue".to_string());
    if let Some(src) = src {
        args.push(src);
    }
    args
}

// ---------------------------------------------------------------------------
// Pid liveness
// ---------------------------------------------------------------------------
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    if pid == 0 {
        return false;
    }
    unsafe { kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> Handle;
        fn GetExitCodeProcess(hProcess: Handle, lpExitCode: *mut u32) -> i32;
        fn CloseHandle(hObject: Handle) -> i32;
    }
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

// ---------------------------------------------------------------------------
// Exit watcher
// ---------------------------------------------------------------------------
/// Polls `pid` and emits `xt:external-player-exited` when the player dies.
fn watch_for_exit(app: AppHandle, state: &ExternalPlayerState, kind: &str, pid: u32) {
    if pid == 0 || (kind != "mpv" && kind != "vlc") {
        return;
    }
    if !state.mark_watched_pid(kind, pid) {
        return;
    }
    let generation = state.bump_watch_generation(kind);
    let kind = kind.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(EXIT_WATCH_POLL_INTERVAL).await;
            let state = app.state::<ExternalPlayerState>();
            if !state.watch_generation_is_current(&kind, generation) {
                return;
            }
            if pid_alive(pid) {
                continue;
            }
            // A newer launch may have superseded us since the alive-check.
            if !state.watch_generation_is_current(&kind, generation)
                || state.get(&kind).is_some_and(|slot| slot.pid != pid)
            {
                return;
            }
            if let Some(dropped) = state.drop_slot(&kind) {
                #[cfg(unix)]
                unlink_unix_socket(&dropped.endpoint);
                #[cfg(not(unix))]
                let _ = dropped;
            }
            state.clear_watched_pid(&kind, pid);
            let _ = app.emit(EXTERNAL_PLAYER_EXITED_EVENT, json!({ "kind": kind }));
            return;
        }
    });
}

// ---------------------------------------------------------------------------
// IPC senders
// ---------------------------------------------------------------------------
#[cfg(unix)]
fn open_mpv_socket(endpoint: &str) -> std::io::Result<std::os::unix::net::UnixStream> {
    use std::os::unix::net::UnixStream;
    let stream = UnixStream::connect(endpoint)?;
    stream.set_write_timeout(Some(Duration::from_millis(IPC_WRITE_TIMEOUT_MS)))?;
    stream.set_read_timeout(Some(Duration::from_millis(IPC_WRITE_TIMEOUT_MS)))?;
    Ok(stream)
}

#[cfg(windows)]
const PIPE_WAIT_TIMEOUT_MS: u32 = 500;

#[cfg(windows)]
fn wait_named_pipe(name: &str, timeout_ms: u32) -> std::io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn WaitNamedPipeW(lpNamedPipeName: *const u16, nTimeOut: u32) -> i32;
    }
    let wide: Vec<u16> = OsStr::new(name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe { WaitNamedPipeW(wide.as_ptr(), timeout_ms) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn open_mpv_pipe(endpoint: &str) -> std::io::Result<std::fs::File> {
    use std::fs::OpenOptions;
    // Bound the wait so a stale endpoint (mpv was killed without dropping the
    // slot) can't block the IPC thread forever. WaitNamedPipeW returns quickly
    // with ERROR_FILE_NOT_FOUND when no server exists at all.
    wait_named_pipe(endpoint, PIPE_WAIT_TIMEOUT_MS)?;
    OpenOptions::new().read(true).write(true).open(endpoint)
}

/// Inspect bytes read back from mpv's JSON-IPC socket
#[cfg(any(unix, windows, test))]
fn first_mpv_error(buf: &[u8]) -> Option<String> {
    for line in buf.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        // Event frames have an "event" field and no "error" - skip them.
        let error = match parsed.get("error").and_then(|value| value.as_str()) {
            Some(error) => error,
            None => continue,
        };
        if error != "success" {
            return Some(error.to_string());
        }
    }
    None
}

// mpv 0.38 moved loadfile options behind a new index arg
fn build_mpv_loadfile(url: &str, ua: Option<&str>, referer: Option<&str>, use_index_form: bool) -> Vec<u8> {
    let mut opts: Vec<String> = Vec::new();
    if let Some(ua) = ua.filter(|s| !s.is_empty()) {
        opts.push(format!("user-agent=%{}%{}", ua.len(), ua));
    }
    if let Some(referer) = referer.filter(|s| !s.is_empty()) {
        opts.push(format!("referrer=%{}%{}", referer.len(), referer));
    }
    let cmd = if opts.is_empty() {
        json!({ "command": ["loadfile", url, "replace"] })
    } else if use_index_form {
        json!({ "command": ["loadfile", url, "replace", -1, opts.join(",")] })
    } else {
        json!({ "command": ["loadfile", url, "replace", opts.join(",")] })
    };
    let mut bytes = serde_json::to_vec(&cmd).unwrap_or_else(|_| Vec::new());
    bytes.push(b'\n');
    bytes
}

fn build_mpv_unpause() -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&json!({ "command": ["set_property", "pause", false] }))
        .unwrap_or_else(|_| Vec::new());
    bytes.push(b'\n');
    bytes
}

#[cfg(unix)]
fn write_and_read_reply(
    stream: &mut std::os::unix::net::UnixStream,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    stream.write_all(payload).map_err(|e| format!("IPC:{e}"))?;
    let mut sink = [0u8; 1024];
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let read = stream.read(&mut sink).unwrap_or(0);
    Ok(sink[..read].to_vec())
}

#[cfg(windows)]
fn write_and_read_reply(pipe: &mut std::fs::File, payload: &[u8]) -> Result<Vec<u8>, String> {
    pipe.write_all(payload).map_err(|e| format!("IPC:{e}"))?;
    // File has no read timeout on Windows; a leaked reader unblocks on pipe close
    let mut reader = pipe.try_clone().map_err(|e| format!("IPC:{e}"))?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut sink = [0u8; 1024];
        let read = reader.read(&mut sink).unwrap_or(0);
        let _ = tx.send(sink[..read].to_vec());
    });
    match rx.recv_timeout(Duration::from_millis(IPC_REPLY_TIMEOUT_MS)) {
        Ok(bytes) if bytes.is_empty() => Err("IPC:empty reply from mpv".to_string()),
        Ok(bytes) => Ok(bytes),
        Err(_) => Err("IPC:no reply from mpv".to_string()),
    }
}

fn send_mpv_loadfile(
    endpoint: &str,
    url: &str,
    ua: Option<&str>,
    referer: Option<&str>,
) -> Result<(), String> {
    let has_options = ua.filter(|s| !s.is_empty()).is_some() || referer.filter(|s| !s.is_empty()).is_some();
    let new_form_payload = build_mpv_loadfile(url, ua, referer, true);
    let unpause = build_mpv_unpause();

    #[cfg(unix)]
    {
        let mut stream = open_mpv_socket(endpoint).map_err(|e| format!("IPC:{e}"))?;
        let reply = write_and_read_reply(&mut stream, &new_form_payload)?;
        if let Some(err) = first_mpv_error(&reply) {
            if has_options && err == "invalid parameter" {
                let old_form_payload = build_mpv_loadfile(url, ua, referer, false);
                let retry_reply = write_and_read_reply(&mut stream, &old_form_payload)?;
                if let Some(retry_err) = first_mpv_error(&retry_reply) {
                    return Err(format!("IPC:mpv replied {retry_err}"));
                }
            } else {
                return Err(format!("IPC:mpv replied {err}"));
            }
        }
        stream.write_all(&unpause).map_err(|e| format!("IPC:{e}"))?;
        Ok(())
    }

    #[cfg(windows)]
    {
        let mut pipe = open_mpv_pipe(endpoint).map_err(|e| format!("IPC:{e}"))?;
        let reply = write_and_read_reply(&mut pipe, &new_form_payload)?;
        if let Some(err) = first_mpv_error(&reply) {
            if has_options && err == "invalid parameter" {
                let old_form_payload = build_mpv_loadfile(url, ua, referer, false);
                let retry_reply = write_and_read_reply(&mut pipe, &old_form_payload)?;
                if let Some(retry_err) = first_mpv_error(&retry_reply) {
                    return Err(format!("IPC:mpv replied {retry_err}"));
                }
            } else {
                return Err(format!("IPC:mpv replied {err}"));
            }
        }
        pipe.write_all(&unpause).map_err(|e| format!("IPC:{e}"))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------
/// `"snap"` / `"flatpak"` when the app is sandboxed, `None` elsewhere.
#[tauri::command]
pub fn sandbox_runtime() -> Option<String> {
    sandbox_runtime_kind()
}

#[tauri::command]
pub async fn launch_external_player(
    app: AppHandle,
    state: State<'_, ExternalPlayerState>,
    path: String,
    args: Vec<String>,
    mode: String,
    reuse: Option<ReuseConfig>,
) -> Result<Value, String> {
    match mode.as_str() {
        "detect" => {
            let version = tauri::async_runtime::spawn_blocking(move || spawn_detect(path, args))
                .await
                .map_err(|e| format!("OTHER:join: {e}"))??;
            Ok(json!({ "version": version }))
        }
        "exists" => check_path_exists(&path),
        "launch" => launch_mode(app, state, path, args, reuse).await,
        other => Err(format!("OTHER:unknown mode '{other}'")),
    }
}

async fn launch_mode(
    app: AppHandle,
    state: State<'_, ExternalPlayerState>,
    path: String,
    args: Vec<String>,
    reuse: Option<ReuseConfig>,
) -> Result<Value, String> {
    let reuse = reuse.unwrap_or_default();
    let kind = reuse.kind.clone();
    let reuse_active = reuse.enabled && !reuse.url.is_empty() && (kind == "mpv" || kind == "vlc");

    // Serialize concurrent launches per kind. Without this the
    // "check slot -> spawn -> persist" sequence can interleave between
    // callers and orphan one of the spawned players.
    let lock_arc = if reuse_active {
        Some(state.launch_lock(&kind))
    } else {
        None
    };
    let _guard = if let Some(lock) = &lock_arc {
        Some(lock.lock().await)
    } else {
        None
    };

    if reuse.enabled && kind == "mpv" && !reuse.url.is_empty() {
        // MPV: drive the existing window via JSON-IPC over its socket / pipe.
        if let Some(slot) = state.get(&kind) {
            let endpoint_alive = pid_alive(slot.pid);
            if !endpoint_alive {
                // Pre-emptive cleanup: avoid writing into a stale pipe whose
                // server has already exited (Windows has no read timeout on
                // std::fs::File so we'd silently no-op otherwise).
                if let Some(dropped) = state.drop_slot(&kind) {
                    #[cfg(unix)]
                    unlink_unix_socket(&dropped.endpoint);
                    #[cfg(not(unix))]
                    let _ = dropped;
                }
            } else {
                let ua = extract_arg(&args, "--user-agent=");
                let referer = extract_arg(&args, "--referrer=");
                match send_mpv_loadfile(
                    &slot.endpoint,
                    &reuse.url,
                    ua.as_deref(),
                    referer.as_deref(),
                ) {
                    Ok(()) => {
                        watch_for_exit(app.clone(), &state, &kind, slot.pid);
                        return Ok(json!({ "pid": slot.pid, "reused": true }));
                    }
                    Err(err) => {
                        log::warn!("[external-player] mpv reuse send failed: {err}");
                        if let Some(dropped) = state.drop_slot(&kind) {
                            #[cfg(unix)]
                            unlink_unix_socket(&dropped.endpoint);
                            #[cfg(not(unix))]
                            let _ = dropped;
                        }
                    }
                }
            }
        }

        let endpoint = pick_mpv_endpoint();
        let augmented = augment_mpv_args(args.clone(), &endpoint);
        let path_for_spawn = path.clone();
        let (pid, is_real_process) = tauri::async_runtime::spawn_blocking(move || {
            spawn_launch_inner(&path_for_spawn, &augmented, true)
        })
        .await
        .map_err(|e| format!("OTHER:join: {e}"))??;
        state.set(&kind, Slot { pid, endpoint });
        if is_real_process {
            watch_for_exit(app.clone(), &state, &kind, pid);
        }
        return Ok(json!({ "pid": pid, "reused": false }));
    }

    if reuse.enabled && kind == "vlc" && !reuse.url.is_empty() {
        // Probe the cached pid so a manually-killed VLC doesn't get reported
        // as reused. The slot is otherwise opaque (endpoint stays empty) and
        // would otherwise live until the app restarts.
        let prior_slot_pid = match state.get(&kind) {
            Some(slot) if pid_alive(slot.pid) => Some(slot.pid),
            Some(_) => {
                state.drop_slot(&kind);
                None
            }
            None => None,
        };
        let augmented = augment_vlc_args(args.clone());
        let path_for_spawn = path.clone();
        // macOS reuse rides `open -a`: the pid is `open`'s, so the slot dies and
        // `reused` reports false there. Raw binary paths get a fresh instance per launch.
        // `open` reuse also forwards only the URL, so custom headers apply on first launch only.
        let direct_exec = cfg!(not(target_os = "macos"));
        let (spawned_pid, is_real_process) = tauri::async_runtime::spawn_blocking(move || {
            spawn_launch_inner(&path_for_spawn, &augmented, direct_exec)
        })
        .await
        .map_err(|e| format!("OTHER:join: {e}"))??;

        // --one-instance: the fresh spawn just forwards to the existing instance and exits.
        if let Some(existing_pid) = prior_slot_pid {
            watch_for_exit(app.clone(), &state, &kind, existing_pid);
            return Ok(json!({ "pid": existing_pid, "reused": true }));
        }

        state.set(
            &kind,
            Slot {
                pid: spawned_pid,
                endpoint: String::new(),
            },
        );
        if is_real_process {
            watch_for_exit(app.clone(), &state, &kind, spawned_pid);
        }
        return Ok(json!({ "pid": spawned_pid, "reused": false }));
    }

    let (pid, is_real_process) =
        tauri::async_runtime::spawn_blocking(move || spawn_launch_inner(&path, &args, false))
            .await
            .map_err(|e| format!("OTHER:join: {e}"))??;
    if is_real_process {
        watch_for_exit(app.clone(), &state, &kind, pid);
    }
    Ok(json!({ "pid": pid, "reused": false }))
}

fn check_path_exists(path: &str) -> Result<Value, String> {
    if path.is_empty() {
        return Err("NOT_FOUND:player path is empty".to_string());
    }
    validate_arg(path, "path")?;
    if Path::new(path).exists() {
        Ok(json!({ "version": "(path verified)" }))
    } else {
        Err(format!("NOT_FOUND:no file at {path}"))
    }
}

fn extract_arg(args: &[String], prefix: &str) -> Option<String> {
    for arg in args {
        if let Some(rest) = arg.strip_prefix(prefix) {
            return Some(rest.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn augment_mpv_strips_existing_ipc_server() {
        let args = vec![
            "--force-window=immediate".to_string(),
            "--input-ipc-server=/old/path".to_string(),
            "--idle=no".to_string(),
            "https://example.com/stream.m3u8".to_string(),
        ];
        let out = augment_mpv_args(args, "/new/path");
        assert!(!out.iter().any(|arg| arg == "--idle=no"));
        assert!(!out
            .iter()
            .any(|arg| arg.starts_with("--input-ipc-server=/old")));
        assert!(out.contains(&"--input-ipc-server=/new/path".to_string()));
        assert!(out.contains(&"--idle=yes".to_string()));
        assert_eq!(out.last().unwrap(), "https://example.com/stream.m3u8");
    }

    #[test]
    fn augment_vlc_drops_play_and_exit_and_adds_one_instance() {
        let args = vec![
            "--no-qt-error-dialogs".to_string(),
            "--play-and-exit".to_string(),
            "https://example.com/stream.m3u8".to_string(),
        ];
        let out = augment_vlc_args_inner(args, false);
        assert!(!out.iter().any(|arg| arg == "--play-and-exit"));
        assert!(out.contains(&"--no-qt-error-dialogs".to_string()));
        assert!(out.contains(&"--one-instance".to_string()));
        assert!(out.contains(&"--no-playlist-enqueue".to_string()));
        assert_eq!(out.last().unwrap(), "https://example.com/stream.m3u8");
    }

    #[test]
    fn augment_vlc_on_macos_never_adds_one_instance_flags() {
        let args = vec![
            "--no-fullscreen".to_string(),
            "--play-and-exit".to_string(),
            "https://example.com/stream.m3u8".to_string(),
        ];
        let out = augment_vlc_args_inner(args, true);
        assert!(!out.iter().any(|arg| arg == "--play-and-exit"));
        assert!(!out.iter().any(|arg| arg == "--one-instance"));
        assert!(!out.iter().any(|arg| arg == "--no-playlist-enqueue"));
        assert!(out.contains(&"--no-fullscreen".to_string()));
        assert_eq!(out.last().unwrap(), "https://example.com/stream.m3u8");
    }

    #[test]
    fn build_mpv_loadfile_includes_url_and_options() {
        let bytes = build_mpv_loadfile(
            "https://e.test/x.m3u8",
            Some("AgentX"),
            Some("https://r.test/"),
            true,
        );
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("loadfile"));
        assert!(s.contains("https://e.test/x.m3u8"));
        assert!(s.contains("user-agent="));
        assert!(s.contains("AgentX"));
        assert!(s.ends_with('\n'));
    }

    #[test]
    fn build_mpv_loadfile_preserves_comma_in_user_agent() {
        let ua = "Mozilla/5.0 (X11; Linux x86_64), Gecko/2010";
        let referer = "https://r.test/, with comma";
        let bytes = build_mpv_loadfile("https://e.test/x.m3u8", Some(ua), Some(referer), false);
        let line = String::from_utf8(bytes).unwrap();

        let parsed: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        let cmd = parsed["command"]
            .as_array()
            .expect("command must be an array");
        assert_eq!(cmd[0], "loadfile");
        assert_eq!(cmd[1], "https://e.test/x.m3u8");
        assert_eq!(cmd[2], "replace");

        let opts = cmd[3].as_str().expect("opts must be a string");
        assert!(
            opts.contains(&format!("user-agent=%{}%{}", ua.len(), ua)),
            "opts string must percent-length-encode the UA so commas in the value don't terminate it; got {opts:?}"
        );
        assert!(opts.contains(&format!("referrer=%{}%{}", referer.len(), referer)));
    }

    #[test]
    fn build_mpv_loadfile_uses_index_form_when_requested() {
        let bytes = build_mpv_loadfile("https://e.test/x.m3u8", Some("AgentX"), None, true);
        let parsed: serde_json::Value =
            serde_json::from_str(String::from_utf8(bytes).unwrap().trim()).unwrap();
        let cmd = parsed["command"].as_array().unwrap();
        assert_eq!(cmd.len(), 5);
        assert_eq!(cmd[3], -1);
        assert!(cmd[4].as_str().unwrap().contains("user-agent="));
    }

    #[test]
    fn build_mpv_loadfile_uses_legacy_form_when_not_requested() {
        let bytes = build_mpv_loadfile("https://e.test/x.m3u8", Some("AgentX"), None, false);
        let parsed: serde_json::Value =
            serde_json::from_str(String::from_utf8(bytes).unwrap().trim()).unwrap();
        let cmd = parsed["command"].as_array().unwrap();
        assert_eq!(cmd.len(), 4);
        assert!(cmd[3].as_str().unwrap().contains("user-agent="));
    }

    #[test]
    fn first_mpv_error_returns_none_for_all_success() {
        let buf = br#"{"request_id":0,"error":"success"}
{"request_id":0,"error":"success"}
"#;
        assert!(first_mpv_error(buf).is_none());
    }

    #[test]
    fn first_mpv_error_skips_event_frames_without_error_field() {
        let buf = br#"{"event":"property-change","name":"pause"}
{"request_id":0,"error":"success"}
"#;
        assert!(first_mpv_error(buf).is_none());
    }

    #[test]
    fn first_mpv_error_surfaces_non_success() {
        let buf = br#"{"event":"start-file"}
{"request_id":0,"error":"loading failed"}
{"request_id":0,"error":"success"}
"#;
        assert_eq!(first_mpv_error(buf).as_deref(), Some("loading failed"));
    }

    #[test]
    fn first_mpv_error_tolerates_partial_garbage() {
        let buf = b"not json\n{\"request_id\":0,\"error\":\"success\"}\n";
        assert!(first_mpv_error(buf).is_none());
    }

    #[test]
    fn check_path_exists_rejects_empty_path() {
        let err = check_path_exists("").unwrap_err();
        assert!(err.starts_with("NOT_FOUND:"), "got {err}");
    }

    #[test]
    fn check_path_exists_reports_hit_for_existing_file() {
        let result = check_path_exists(file!()).unwrap();
        assert_eq!(result["version"], "(path verified)");
    }

    #[test]
    fn check_path_exists_reports_miss_for_nonexistent_file() {
        let bogus = format!("{}-definitely-not-here.xyz", file!());
        let err = check_path_exists(&bogus).unwrap_err();
        assert!(err.starts_with("NOT_FOUND:"), "got {err}");
    }

    #[test]
    fn unique_suffix_is_distinct_within_same_nanosecond_bucket() {
        let a = unique_suffix();
        let b = unique_suffix();
        assert_ne!(a, b, "back-to-back unique_suffix calls must differ");
    }

    #[test]
    fn build_mpv_loadfile_uses_three_arg_form_when_no_options() {
        let bytes = build_mpv_loadfile("https://e.test/x.m3u8", None, None, true);
        let parsed: serde_json::Value =
            serde_json::from_str(String::from_utf8(bytes).unwrap().trim()).unwrap();
        let cmd = parsed["command"].as_array().unwrap();
        assert_eq!(cmd.len(), 3);
        assert_eq!(cmd[2], "replace");
    }

    #[test]
    fn validate_arg_rejects_null_byte() {
        let err = validate_arg("/usr/bin/mpv\0junk", "path").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
        assert!(err.contains("NUL"), "got {err}");
    }

    #[test]
    fn validate_arg_rejects_newline() {
        let err = validate_arg("foo\nbar", "arg").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
        assert!(err.contains("newline"), "got {err}");
    }

    #[test]
    fn validate_arg_rejects_carriage_return() {
        let err = validate_arg("foo\rbar", "arg").unwrap_err();
        assert!(err.contains("newline"), "got {err}");
    }

    #[test]
    fn validate_arg_accepts_normal_paths() {
        validate_arg("/usr/bin/mpv", "path").unwrap();
        validate_arg("C:\\Program Files\\mpv\\mpv.exe", "path").unwrap();
        validate_arg("--user-agent=Mozilla/5.0", "arg").unwrap();
    }

    #[test]
    fn spawn_launch_inner_rejects_path_with_null_byte() {
        let err = spawn_launch_inner("/bin/sh\0evil", &[], false).unwrap_err();
        assert!(
            err.starts_with("OTHER:") || err.starts_with("NOT_FOUND:"),
            "got {err}"
        );
    }

    #[test]
    fn spawn_launch_inner_rejects_arg_with_newline() {
        // file!() is a real file path, so we get past the NotFound guard
        // and exercise the validation path on a non-empty argv.
        let err =
            spawn_launch_inner(file!(), &["safe".to_string(), "with\nnewline".to_string()], false)
                .unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
    }

    #[test]
    fn external_player_state_launch_lock_is_per_kind() {
        let state = ExternalPlayerState::default();
        let mpv_lock = state.launch_lock("mpv");
        let mpv_lock_again = state.launch_lock("mpv");
        let vlc_lock = state.launch_lock("vlc");
        assert!(Arc::ptr_eq(&mpv_lock, &mpv_lock_again));
        assert!(!Arc::ptr_eq(&mpv_lock, &vlc_lock));
    }

    #[test]
    fn external_player_state_drop_slot_returns_old_value() {
        let state = ExternalPlayerState::default();
        state.set(
            "mpv",
            Slot {
                pid: 1234,
                endpoint: "/tmp/x.sock".to_string(),
            },
        );
        let dropped = state.drop_slot("mpv").expect("slot must exist");
        assert_eq!(dropped.pid, 1234);
        assert_eq!(dropped.endpoint, "/tmp/x.sock");
        assert!(state.get("mpv").is_none());
    }

    #[test]
    fn pid_alive_returns_false_for_pid_zero() {
        assert!(!pid_alive(0));
    }

    #[test]
    fn classify_sandbox_runtime_detects_snap_when_exe_is_inside_mount() {
        let exe = Path::new("/snap/xtream/123/usr/bin/xtream");
        let result = classify_sandbox_runtime(
            Some(exe),
            Some("/snap/xtream/123"),
            Some("xtream"),
            None,
            false,
        );
        assert_eq!(result, Some("snap"));
    }

    #[test]
    fn classify_sandbox_runtime_ignores_inherited_snap_env_outside_mount() {
        let exe = Path::new("/home/user/.local/bin/xtream");
        let result = classify_sandbox_runtime(
            Some(exe),
            Some("/snap/some-terminal/45"),
            Some("some-terminal"),
            None,
            false,
        );
        assert_eq!(result, None);
    }

    #[test]
    fn classify_sandbox_runtime_detects_flatpak() {
        let exe = Path::new("/app/bin/xtream");
        let result = classify_sandbox_runtime(Some(exe), None, None, Some("com.example.App"), false);
        assert_eq!(result, Some("flatpak"));
    }

    #[test]
    fn classify_sandbox_runtime_returns_none_outside_any_sandbox() {
        let exe = Path::new("/usr/bin/xtream");
        let result = classify_sandbox_runtime(Some(exe), None, None, None, false);
        assert_eq!(result, None);
    }

    #[test]
    fn bump_watch_generation_increments_and_invalidates_old_generation() {
        let state = ExternalPlayerState::default();
        let first = state.bump_watch_generation("mpv");
        assert!(state.watch_generation_is_current("mpv", first));
        let second = state.bump_watch_generation("mpv");
        assert_ne!(first, second);
        assert!(!state.watch_generation_is_current("mpv", first));
        assert!(state.watch_generation_is_current("mpv", second));
    }

    #[test]
    fn watch_generation_is_current_is_per_kind() {
        let state = ExternalPlayerState::default();
        state.bump_watch_generation("mpv");
        let mpv_generation = state.bump_watch_generation("mpv");
        let vlc_generation = state.bump_watch_generation("vlc");
        assert!(state.watch_generation_is_current("mpv", mpv_generation));
        assert!(state.watch_generation_is_current("vlc", vlc_generation));
        assert!(!state.watch_generation_is_current("mpv", vlc_generation));
    }

    #[test]
    fn mark_watched_pid_skips_unchanged_pid_but_allows_new_one() {
        let state = ExternalPlayerState::default();
        assert!(state.mark_watched_pid("mpv", 111));
        assert!(!state.mark_watched_pid("mpv", 111));
        assert!(state.mark_watched_pid("mpv", 222));
    }

    #[test]
    fn clear_watched_pid_allows_the_same_pid_to_be_rewatched() {
        let state = ExternalPlayerState::default();
        assert!(state.mark_watched_pid("mpv", 111));
        state.clear_watched_pid("mpv", 111);
        assert!(state.mark_watched_pid("mpv", 111));
    }

    #[test]
    fn clear_watched_pid_leaves_entry_intact_for_non_matching_pid() {
        let state = ExternalPlayerState::default();
        assert!(state.mark_watched_pid("mpv", 111));
        state.clear_watched_pid("mpv", 222);
        assert!(!state.mark_watched_pid("mpv", 111));
    }
}
