// TV receiver mode: LAN HTTP+WebSocket server other app instances pair with and send play/transport commands to.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, watch};

use crate::receiver_store::{self, PairedDevice};

const RECEIVER_PORT: u16 = 47815;
const PORT_ATTEMPTS: u16 = 5;
const PROTOCOL_VERSION: u32 = 1;

const PAIR_CODE_TTL: Duration = Duration::from_secs(120);
const PAIR_MAX_FAILURES: u8 = 5;
const PAIR_LOCKOUT: Duration = Duration::from_secs(60);
const PAIR_MIN_INTERVAL: Duration = Duration::from_millis(750);

const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_URL_LEN: usize = 8 * 1024;
const MAX_TITLE_LEN: usize = 512;
const MAX_MIME_LEN: usize = 256;
const MAX_DRM_JSON_BYTES: usize = 16 * 1024;
const MAX_LOG_TAIL_BYTES: usize = 64 * 1024;

const PLAY_EVENT: &str = "xt:receiver-play";
const CONTROL_EVENT: &str = "xt:receiver-control";
const STATUS_EVENT: &str = "xt:receiver-status";
const PAIRED_EVENT: &str = "xt:receiver-paired";
const AMBIENT_EVENT: &str = "xt:receiver-ambient";

const MAX_AMBIENT_ENTRIES: usize = 50;
const MAX_AMBIENT_ID_LEN: usize = 256;
const ALLOWED_AMBIENT_KINDS: [&str; 2] = ["vod", "series"];
const ALLOWED_AMBIENT_TIERS: [&str; 4] = ["watching", "recent", "recommended", "catalog"];

const ALLOWED_PLAYBACK_STATES: [&str; 7] =
    ["idle", "loading", "buffering", "playing", "paused", "ended", "error"];

const AUTH_HEADER: &str = "x-xt-key";

// ---------------------------------------------------------------------------
// Event emitter abstraction (testable without a Tauri AppHandle)
// ---------------------------------------------------------------------------

pub trait ReceiverEvents: Send + Sync + 'static {
    fn play(&self, payload: Value);
    fn control(&self, payload: Value);
    fn status(&self, payload: Value);
    fn paired(&self, payload: Value);
    fn ambient(&self, payload: Value);
}

impl ReceiverEvents for AppHandle {
    fn play(&self, payload: Value) {
        let _ = self.emit(PLAY_EVENT, payload);
    }
    fn control(&self, payload: Value) {
        let _ = self.emit(CONTROL_EVENT, payload);
    }
    fn status(&self, payload: Value) {
        let _ = self.emit(STATUS_EVENT, payload);
    }
    fn paired(&self, payload: Value) {
        let _ = self.emit(PAIRED_EVENT, payload);
    }
    fn ambient(&self, payload: Value) {
        let _ = self.emit(AMBIENT_EVENT, payload);
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackReport {
    pub state: String,
    #[serde(default)]
    pub position_seconds: f64,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

impl Default for PlaybackReport {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            position_seconds: 0.0,
            duration_seconds: None,
            title: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
struct PairingState {
    code: String,
    expires_at: Instant,
    failed_attempts: u8,
    locked_until: Option<Instant>,
    last_attempt_at: Option<Instant>,
}

impl PairingState {
    fn new() -> Self {
        Self {
            code: generate_pair_code(),
            expires_at: Instant::now() + PAIR_CODE_TTL,
            failed_attempts: 0,
            locked_until: None,
            last_attempt_at: None,
        }
    }
}

struct ReceiverShared {
    pairing: Mutex<Option<PairingState>>,
    devices: Mutex<Vec<PairedDevice>>,
    playback: Mutex<PlaybackReport>,
    name: Mutex<String>,
    ips: Mutex<Vec<String>>,
    receiver_id: Mutex<String>,
    broadcast: broadcast::Sender<String>,
    ip_watcher_running: AtomicBool,
}

impl ReceiverShared {
    fn new() -> Self {
        let (broadcast, _receiver) = broadcast::channel(16);
        Self {
            pairing: Mutex::new(None),
            devices: Mutex::new(Vec::new()),
            playback: Mutex::new(PlaybackReport::default()),
            name: Mutex::new(String::new()),
            ips: Mutex::new(Vec::new()),
            receiver_id: Mutex::new(String::new()),
            broadcast,
            ip_watcher_running: AtomicBool::new(false),
        }
    }
}

struct ServerHandle {
    port: u16,
    shutdown: watch::Sender<bool>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct MdnsHandle {
    daemon: mdns_sd::ServiceDaemon,
    fullname: String,
}

pub struct ReceiverState {
    shared: Arc<ReceiverShared>,
    server: Mutex<Option<ServerHandle>>,
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    mdns: Mutex<Option<MdnsHandle>>,
}

impl Default for ReceiverState {
    fn default() -> Self {
        Self {
            shared: Arc::new(ReceiverShared::new()),
            server: Mutex::new(None),
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            mdns: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Pairing state machine (pure, unit-testable)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum PairOutcome {
    Paired,
    BadCode,
    RateLimited { retry_after_secs: u64 },
}

fn evaluate_pair_attempt(pairing: &mut PairingState, submitted: &str, now: Instant) -> PairOutcome {
    if let Some(locked_until) = pairing.locked_until {
        if now < locked_until {
            let retry_after_secs = locked_until.saturating_duration_since(now).as_secs().max(1);
            pairing.last_attempt_at = Some(now);
            return PairOutcome::RateLimited { retry_after_secs };
        }
    }

    if let Some(last_attempt_at) = pairing.last_attempt_at {
        let elapsed = now.saturating_duration_since(last_attempt_at);
        if elapsed < PAIR_MIN_INTERVAL {
            let retry_after_secs = PAIR_MIN_INTERVAL.saturating_sub(elapsed).as_secs().max(1);
            pairing.last_attempt_at = Some(now);
            return PairOutcome::RateLimited { retry_after_secs };
        }
    }

    pairing.last_attempt_at = Some(now);

    if now >= pairing.expires_at {
        pairing.code = generate_pair_code();
        pairing.expires_at = now + PAIR_CODE_TTL;
        pairing.failed_attempts = 0;
        pairing.locked_until = None;
        return PairOutcome::BadCode;
    }

    if submitted != pairing.code {
        pairing.failed_attempts += 1;
        if pairing.failed_attempts >= PAIR_MAX_FAILURES {
            pairing.code = generate_pair_code();
            pairing.expires_at = now + PAIR_CODE_TTL;
            pairing.failed_attempts = 0;
            pairing.locked_until = Some(now + PAIR_LOCKOUT);
        }
        return PairOutcome::BadCode;
    }

    // Single-use: a matched code is immediately replaced.
    pairing.code = generate_pair_code();
    pairing.expires_at = now + PAIR_CODE_TTL;
    pairing.failed_attempts = 0;
    pairing.locked_until = None;
    PairOutcome::Paired
}

fn maybe_regenerate_expired_code(pairing_slot: &mut Option<PairingState>) -> bool {
    let Some(pairing) = pairing_slot.as_mut() else {
        return false;
    };
    if Instant::now() < pairing.expires_at {
        return false;
    }
    pairing.code = generate_pair_code();
    pairing.expires_at = Instant::now() + PAIR_CODE_TTL;
    pairing.failed_attempts = 0;
    pairing.locked_until = None;
    true
}

fn generate_pair_code() -> String {
    format!("{:06}", rand::rng().random_range(0..1_000_000u32))
}

fn resolve_device_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(receiver_store::MAX_DEVICE_NAME_LEN).collect()
    }
}

/// None for blank or "localhost", which gethostname returns on containers/CI and Android.
fn usable_hostname(hostname: &str) -> Option<String> {
    let trimmed = hostname.trim().trim_end_matches('.');
    let suffix_start = trimmed.len().saturating_sub(".local".len());
    let stripped = if trimmed.is_char_boundary(suffix_start) && trimmed[suffix_start..].eq_ignore_ascii_case(".local") {
        trimmed[..suffix_start].trim()
    } else {
        trimmed
    };
    if stripped.is_empty() || stripped.eq_ignore_ascii_case("localhost") {
        None
    } else {
        Some(stripped.to_string())
    }
}

#[cfg(not(target_os = "android"))]
fn system_hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

// Android hostnames are useless (always "localhost"); the JS side supplies the real device name.
#[cfg(target_os = "android")]
fn default_receiver_name() -> String {
    "Extreme InfiniTV".to_string()
}

#[cfg(not(target_os = "android"))]
fn default_receiver_name() -> String {
    usable_hostname(&system_hostname()).unwrap_or_else(|| "Extreme InfiniTV".to_string())
}

/// Sender-side device-name lookup: the OS hostname, or "" when unusable (Android has no bridge here).
#[tauri::command]
pub fn device_hostname() -> String {
    #[cfg(target_os = "android")]
    {
        String::new()
    }
    #[cfg(not(target_os = "android"))]
    {
        usable_hostname(&system_hostname()).unwrap_or_default()
    }
}

fn generate_device_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// mDNS / DNS-SD advertising (desktop only; Android uses NsdManager instead)
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const MDNS_SERVICE_TYPE: &str = "_xtream-recv._tcp.local.";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const MDNS_LABEL_MAX_LEN: usize = 63;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn mdns_instance_name(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|ch| *ch != '.' && !ch.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Extreme InfiniTV".to_string()
    } else {
        trimmed.chars().take(MDNS_LABEL_MAX_LEN).collect()
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn mdns_host_label(instance_name: &str) -> String {
    let label: String = instance_name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let trimmed = label.trim_matches('-');
    if trimmed.is_empty() {
        "xtream-receiver".to_string()
    } else {
        trimmed.chars().take(MDNS_LABEL_MAX_LEN).collect()
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn register_mdns_service(name: &str, port: u16, receiver_id: &str) -> Option<(mdns_sd::ServiceDaemon, String)> {
    let daemon = match mdns_sd::ServiceDaemon::new() {
        Ok(daemon) => daemon,
        Err(error) => {
            log::warn!("[receiver] mdns daemon start failed: {error}");
            return None;
        }
    };

    let instance_name = mdns_instance_name(name);
    let host_name = format!("{}.local.", mdns_host_label(&instance_name));
    let advertised_ips = local_ips();
    log::info!("[receiver] advertising mdns on ips: {}", advertised_ips.join(", "));
    // addr_auto adds every interface's address on register (mdns-sd's register_service), on top
    // of the explicit list below, not instead of it - the two are additive, not a fallback pair.
    let service_info = mdns_sd::ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &instance_name,
        &host_name,
        advertised_ips.join(",").as_str(),
        port,
        &[("v", "1"), ("id", receiver_id)][..],
    )
    .map(mdns_sd::ServiceInfo::enable_addr_auto);
    let service_info = match service_info {
        Ok(info) => info,
        Err(error) => {
            log::warn!("[receiver] mdns service info build failed: {error}");
            let _ = daemon.shutdown();
            return None;
        }
    };

    let fullname = service_info.get_fullname().to_string();
    if let Err(error) = daemon.register(service_info) {
        log::warn!("[receiver] mdns register failed: {error}");
        let _ = daemon.shutdown();
        return None;
    }
    Some((daemon, fullname))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn advertise_mdns(state: &ReceiverState, name: &str, port: u16) {
    let mut mdns_guard = state.mdns.lock().unwrap_or_else(|poison| poison.into_inner());
    if mdns_guard.is_some() {
        return;
    }
    let receiver_id = state.shared.receiver_id.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    if let Some((daemon, fullname)) = register_mdns_service(name, port, &receiver_id) {
        *mdns_guard = Some(MdnsHandle { daemon, fullname });
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn advertise_mdns(_state: &ReceiverState, _name: &str, _port: u16) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn unadvertise_mdns(state: &ReceiverState) {
    let handle = state.mdns.lock().unwrap_or_else(|poison| poison.into_inner()).take();
    if let Some(handle) = handle {
        let _ = handle.daemon.unregister(&handle.fullname);
        let _ = handle.daemon.shutdown();
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn unadvertise_mdns(_state: &ReceiverState) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn readvertise_mdns(state: &ReceiverState, name: &str) {
    let port = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|handle| handle.port);
    let Some(port) = port else {
        return;
    };
    unadvertise_mdns(state);
    advertise_mdns(state, name, port);
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn readvertise_mdns(_state: &ReceiverState, _name: &str) {}

const IP_WATCH_INTERVAL: Duration = Duration::from_secs(15);

/// Wi-Fi roams, VPNs and docks change our addresses while the receiver stays up; without this the
/// advertised records and the status IPs both go stale until the user toggles receiver mode.
fn spawn_ip_watcher(app: AppHandle) {
    let shared = {
        let state = app.state::<ReceiverState>();
        if state.shared.ip_watcher_running.swap(true, Ordering::SeqCst) {
            return;
        }
        state.shared.clone()
    };

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IP_WATCH_INTERVAL).await;

            let state = app.state::<ReceiverState>();
            let port = state
                .server
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .as_ref()
                .map(|handle| handle.port);
            let Some(port) = port else {
                break;
            };

            let current = local_ips();
            let changed = {
                let mut ips = shared.ips.lock().unwrap_or_else(|poison| poison.into_inner());
                if *ips == current {
                    false
                } else {
                    *ips = current.clone();
                    true
                }
            };
            if !changed {
                continue;
            }

            let name = shared.name.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
            log::info!("[receiver] addresses changed, re-advertising on: {}", current.join(", "));
            readvertise_mdns(&state, &name);
            ReceiverEvents::status(&app, build_status_json(&shared, Some(port)));
        }
        shared.ip_watcher_running.store(false, Ordering::SeqCst);
    });
}

fn evict_oldest_if_over_capacity(devices: &mut Vec<PairedDevice>) {
    while devices.len() > receiver_store::MAX_PAIRED_DEVICES {
        let Some(oldest_index) = devices
            .iter()
            .enumerate()
            .min_by(|(_, left), (_, right)| left.created_at.cmp(&right.created_at))
            .map(|(index, _)| index)
        else {
            break;
        };
        devices.remove(oldest_index);
    }
}

async fn load_devices(config_dir: std::path::PathBuf) -> Vec<PairedDevice> {
    tauri::async_runtime::spawn_blocking(move || receiver_store::load(&config_dir))
        .await
        .unwrap_or_default()
}

async fn ensure_receiver_id(config_dir: std::path::PathBuf) -> String {
    tauri::async_runtime::spawn_blocking(move || receiver_store::ensure_id(&config_dir))
        .await
        .unwrap_or_else(|_| receiver_store::generate_receiver_id())
}

// Callers clone the device list and drop the mutex guard before awaiting this.
async fn persist_devices(
    config_dir: std::path::PathBuf,
    receiver_id: String,
    devices: Vec<PairedDevice>,
) -> std::io::Result<()> {
    tauri::async_runtime::spawn_blocking(move || receiver_store::save(&config_dir, &receiver_id, &devices))
        .await
        .unwrap_or_else(|join_error| Err(std::io::Error::other(join_error.to_string())))
}

// ---------------------------------------------------------------------------
// Status JSON shared by the Tauri commands and the axum handlers
// ---------------------------------------------------------------------------

fn build_status_json(shared: &Arc<ReceiverShared>, port: Option<u16>) -> Value {
    let name = shared.name.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    let pairing = shared.pairing.lock().unwrap_or_else(|poison| poison.into_inner());
    let (pair_code, pair_code_expires_in_seconds) = match pairing.as_ref() {
        Some(pairing) => (
            Some(pairing.code.clone()),
            Some(pairing.expires_at.saturating_duration_since(Instant::now()).as_secs()),
        ),
        None => (None, None),
    };
    drop(pairing);

    let devices = shared.devices.lock().unwrap_or_else(|poison| poison.into_inner());
    let paired_devices: Vec<Value> = devices
        .iter()
        .map(|device| {
            json!({
                "key": device.key,
                "deviceName": device.device_name,
                "createdAt": device.created_at,
            })
        })
        .collect();

    let ips = shared.ips.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    let receiver_id = shared.receiver_id.lock().unwrap_or_else(|poison| poison.into_inner()).clone();

    json!({
        "enabled": port.is_some(),
        "port": port,
        "ips": ips,
        "name": name,
        "id": receiver_id,
        "pairCode": pair_code,
        "pairCodeExpiresInSeconds": pair_code_expires_in_seconds,
        "pairedDevices": paired_devices,
    })
}

/// Std-only UDP-connect trick: no packet is sent, just resolves which local interface
/// would route toward the internet. On an active VPN this is the tunnel, not the LAN.
fn default_route_ip() -> Option<std::net::IpAddr> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

// Android/iOS have no bundled if-addrs; the default-route probe is the only signal there
// anyway since mDNS advertising goes through NsdManager instead of this Rust path.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn local_ips() -> Vec<String> {
    default_route_ip().map(|ip| vec![ip.to_string()]).unwrap_or_default()
}

/// All usable addresses across every adapter (not just the default route), so a VPN tunnel
/// doesn't hide the LAN address the mobile app actually needs to reach.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn local_ips() -> Vec<String> {
    let default_route = default_route_ip();
    let mut candidates: std::collections::HashSet<std::net::IpAddr> = if_addrs::get_if_addrs()
        .map(|interfaces| interfaces.into_iter().map(|interface| interface.ip()).collect())
        .unwrap_or_default();
    candidates.retain(is_usable_mdns_addr);

    let mut ranked: Vec<std::net::IpAddr> = candidates.into_iter().collect();
    ranked.sort_by(|left, right| {
        mdns_addr_rank(right).cmp(&mdns_addr_rank(left)).then_with(|| {
            let left_is_default_route = default_route == Some(*left);
            let right_is_default_route = default_route == Some(*right);
            right_is_default_route.cmp(&left_is_default_route)
        })
    });
    ranked.into_iter().map(|ip| ip.to_string()).collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn receiver_start(
    app: AppHandle,
    state: tauri::State<'_, ReceiverState>,
    name: Option<String>,
) -> Result<Value, String> {
    let config_dir = app.path().app_config_dir().map_err(|error| format!("OTHER:{error}"))?;
    let log_dir = app.path().app_log_dir().unwrap_or_default();

    let already_running = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .is_some();

    if !already_running {
        let devices = load_devices(config_dir.clone()).await;
        *state.shared.devices.lock().unwrap_or_else(|poison| poison.into_inner()) = devices;

        let receiver_id = ensure_receiver_id(config_dir.clone()).await;
        *state.shared.receiver_id.lock().unwrap_or_else(|poison| poison.into_inner()) = receiver_id;

        let trimmed_name = name.unwrap_or_default();
        let resolved_name = if trimmed_name.trim().is_empty() {
            default_receiver_name()
        } else {
            trimmed_name.trim().to_string()
        };
        *state.shared.name.lock().unwrap_or_else(|poison| poison.into_inner()) = resolved_name.clone();

        *state.shared.pairing.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(PairingState::new());
        *state.shared.ips.lock().unwrap_or_else(|poison| poison.into_inner()) = local_ips();

        let events: Arc<dyn ReceiverEvents> = Arc::new(app.clone());
        ensure_server_started(&state, events, config_dir, log_dir).await?;

        let port = state
            .server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_ref()
            .map(|handle| handle.port);
        if let Some(port) = port {
            advertise_mdns(&state, &resolved_name, port);
            spawn_ip_watcher(app.clone());
        }
    }

    let port = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|handle| handle.port);
    Ok(build_status_json(&state.shared, port))
}

#[tauri::command]
pub async fn receiver_stop(app: AppHandle, state: tauri::State<'_, ReceiverState>) -> Result<(), String> {
    let handle = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take();
    if let Some(handle) = handle {
        let _ = handle.shutdown.send(true);
    }
    unadvertise_mdns(&state);
    *state.shared.pairing.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
    *state.shared.playback.lock().unwrap_or_else(|poison| poison.into_inner()) = PlaybackReport::default();
    state.shared.ips.lock().unwrap_or_else(|poison| poison.into_inner()).clear();

    let status = build_status_json(&state.shared, None);
    let events: Arc<dyn ReceiverEvents> = Arc::new(app);
    events.status(status);
    Ok(())
}

#[tauri::command]
pub fn receiver_status(app: AppHandle, state: tauri::State<'_, ReceiverState>) -> Value {
    let port = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|handle| handle.port);

    let regenerated = if port.is_some() {
        let mut pairing = state.shared.pairing.lock().unwrap_or_else(|poison| poison.into_inner());
        maybe_regenerate_expired_code(&mut pairing)
    } else {
        false
    };

    let status = build_status_json(&state.shared, port);
    if regenerated {
        let events: Arc<dyn ReceiverEvents> = Arc::new(app);
        events.status(status.clone());
    }
    status
}

#[tauri::command]
pub fn receiver_regenerate_code(app: AppHandle, state: tauri::State<'_, ReceiverState>) -> Value {
    *state.shared.pairing.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(PairingState::new());

    let port = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|handle| handle.port);
    let status = build_status_json(&state.shared, port);
    let events: Arc<dyn ReceiverEvents> = Arc::new(app);
    events.status(status.clone());
    status
}

#[tauri::command]
pub fn receiver_set_name(app: AppHandle, state: tauri::State<'_, ReceiverState>, name: String) -> Value {
    let resolved_name = resolve_device_name(&name, &default_receiver_name());
    *state.shared.name.lock().unwrap_or_else(|poison| poison.into_inner()) = resolved_name.clone();
    readvertise_mdns(&state, &resolved_name);

    let port = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|handle| handle.port);
    let status = build_status_json(&state.shared, port);
    let events: Arc<dyn ReceiverEvents> = Arc::new(app);
    events.status(status.clone());
    status
}

#[tauri::command]
pub async fn receiver_revoke_device(
    app: AppHandle,
    state: tauri::State<'_, ReceiverState>,
    key: String,
) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|error| format!("OTHER:{error}"))?;
    let receiver_id = state.shared.receiver_id.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    let devices_snapshot = {
        let mut devices = state.shared.devices.lock().unwrap_or_else(|poison| poison.into_inner());
        devices.retain(|device| device.key != key);
        devices.clone()
    };
    persist_devices(config_dir, receiver_id, devices_snapshot).await.map_err(|error| format!("OTHER:{error}"))?;

    let port = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|handle| handle.port);
    let status = build_status_json(&state.shared, port);
    let events: Arc<dyn ReceiverEvents> = Arc::new(app);
    events.status(status);
    Ok(())
}

#[tauri::command]
pub fn receiver_report_state(state: tauri::State<'_, ReceiverState>, payload: PlaybackReport) -> Result<(), String> {
    if !ALLOWED_PLAYBACK_STATES.contains(&payload.state.as_str()) {
        return Err(format!("OTHER:invalid playback state '{}'", payload.state));
    }
    let bounded = PlaybackReport {
        state: payload.state,
        position_seconds: payload.position_seconds,
        duration_seconds: payload.duration_seconds,
        title: payload.title.map(|title| title.chars().take(MAX_TITLE_LEN).collect()),
        error: payload.error.map(|error| error.chars().take(MAX_TITLE_LEN).collect()),
    };
    let serialized = serde_json::to_string(&bounded).map_err(|error| format!("OTHER:{error}"))?;
    *state.shared.playback.lock().unwrap_or_else(|poison| poison.into_inner()) = bounded;
    let _ = state.shared.broadcast.send(serialized);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredReceiver {
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub hosts: Vec<String>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const DISCOVER_DEFAULT_TIMEOUT_MS: u64 = 3000;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const DISCOVER_MIN_TIMEOUT_MS: u64 = 500;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const DISCOVER_MAX_TIMEOUT_MS: u64 = 10_000;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn strip_mdns_service_suffix(fullname: &str) -> String {
    let suffix = format!(".{MDNS_SERVICE_TYPE}");
    fullname.strip_suffix(suffix.as_str()).unwrap_or(fullname).to_string()
}

// Rejects loopback/unspecified/link-local candidates from other interfaces on the same host.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_usable_mdns_addr(ip: &std::net::IpAddr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return false;
    }
    match ip {
        std::net::IpAddr::V4(v4) => !v4.is_link_local(),
        std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn mdns_addr_rank(ip: &std::net::IpAddr) -> u8 {
    match ip {
        std::net::IpAddr::V4(v4) if v4.is_private() => 2,
        std::net::IpAddr::V4(_) => 1,
        std::net::IpAddr::V6(_) => 0,
    }
}

/// Picks the best address for a resolved service: private IPv4 first, then any IPv4, then IPv6.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[allow(dead_code)] // superseded by rank_discovered_hosts in receiver_discover; kept + tested for the subnet-unaware fallback shape
fn best_mdns_addr(candidates: &[std::net::IpAddr]) -> Option<std::net::IpAddr> {
    candidates.iter().copied().filter(is_usable_mdns_addr).max_by_key(mdns_addr_rank)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn same_subnet_v4(local: std::net::Ipv4Addr, candidate: std::net::Ipv4Addr, prefixlen: u8) -> bool {
    if prefixlen == 0 || prefixlen > 32 {
        return false;
    }
    let mask = u32::MAX << (32 - u32::from(prefixlen));
    (u32::from(local) & mask) == (u32::from(candidate) & mask)
}

// if-addrs has no reliable cross-platform IPv6 prefix length; same-/64 is the closest cheap proxy.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn same_subnet_v6(local: std::net::Ipv6Addr, candidate: std::net::Ipv6Addr) -> bool {
    local.segments()[..4] == candidate.segments()[..4]
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn shares_subnet_with_any_interface(candidate: &std::net::IpAddr, interfaces: &[if_addrs::Interface]) -> bool {
    interfaces.iter().any(|interface| match (&interface.addr, candidate) {
        (if_addrs::IfAddr::V4(local), std::net::IpAddr::V4(candidate_v4)) => {
            same_subnet_v4(local.ip, *candidate_v4, local.prefixlen)
        }
        (if_addrs::IfAddr::V6(local), std::net::IpAddr::V6(candidate_v6)) => {
            same_subnet_v6(local.ip, *candidate_v6)
        }
        _ => false,
    })
}

/// (same-subnet bonus, address-family rank): a subnet match outranks private-v4 > public-v4 > v6.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn discovery_addr_rank(ip: &std::net::IpAddr, interfaces: &[if_addrs::Interface]) -> (u8, u8) {
    (u8::from(shares_subnet_with_any_interface(ip, interfaces)), mdns_addr_rank(ip))
}

/// Ranks a resolved service's usable addresses, best first.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn rank_discovered_hosts(
    addresses: impl IntoIterator<Item = std::net::IpAddr>,
    interfaces: &[if_addrs::Interface],
) -> Vec<std::net::IpAddr> {
    let mut ranked: Vec<std::net::IpAddr> = addresses.into_iter().filter(is_usable_mdns_addr).collect();
    ranked.sort_by(|left, right| discovery_addr_rank(right, interfaces).cmp(&discovery_addr_rank(left, interfaces)));
    ranked
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn discovery_identity_key(name: &str, port: u16, id: Option<&str>) -> String {
    match id {
        Some(id) if !id.is_empty() => format!("id:{id}"),
        _ => format!("np:{name}:{port}"),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct ResolvedEvent {
    name: String,
    port: u16,
    id: Option<String>,
    addresses: Vec<std::net::IpAddr>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct DiscoveryEntry {
    name: String,
    port: u16,
    id: Option<String>,
    addresses: std::collections::HashSet<std::net::IpAddr>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn join_ips(ips: &[std::net::IpAddr]) -> String {
    ips.iter().map(|ip| ip.to_string()).collect::<Vec<_>>().join(", ")
}

/// Merges resolved-service events into one entry per identity (mDNS id when present, else
/// name+port), unioning addresses across repeat events for the same identity.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn merge_resolved_events(
    events: Vec<ResolvedEvent>,
    interfaces: &[if_addrs::Interface],
) -> Vec<DiscoveredReceiver> {
    let mut entries: std::collections::HashMap<String, DiscoveryEntry> = std::collections::HashMap::new();
    for event in events {
        let usable: Vec<std::net::IpAddr> = event.addresses.iter().copied().filter(is_usable_mdns_addr).collect();
        if usable.is_empty() {
            log::warn!(
                "[receiver] discover dropped {} port={}: no usable address in [{}]",
                event.name,
                event.port,
                join_ips(&event.addresses)
            );
            continue;
        }
        let key = discovery_identity_key(&event.name, event.port, event.id.as_deref());
        let entry = entries.entry(key).or_insert_with(|| DiscoveryEntry {
            name: event.name.clone(),
            port: event.port,
            id: None,
            addresses: std::collections::HashSet::new(),
        });
        entry.name = event.name;
        entry.port = event.port;
        if entry.id.is_none() {
            entry.id = event.id;
        }
        entry.addresses.extend(usable);
    }

    entries
        .into_values()
        .map(|entry| {
            let hosts: Vec<String> =
                rank_discovered_hosts(entry.addresses, interfaces).into_iter().map(|ip| ip.to_string()).collect();
            let host = hosts.first().cloned().unwrap_or_default();
            DiscoveredReceiver { name: entry.name, host, port: entry.port, id: entry.id, hosts }
        })
        .collect()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn receiver_discover(timeout_ms: Option<u64>) -> Result<Vec<DiscoveredReceiver>, String> {
    let clamped_timeout = timeout_ms
        .unwrap_or(DISCOVER_DEFAULT_TIMEOUT_MS)
        .clamp(DISCOVER_MIN_TIMEOUT_MS, DISCOVER_MAX_TIMEOUT_MS);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(clamped_timeout);

    log::info!("[receiver] discover browsing {MDNS_SERVICE_TYPE}, timeout={clamped_timeout}ms");

    let daemon = mdns_sd::ServiceDaemon::new().map_err(|error| format!("OTHER:mdns daemon start failed: {error}"))?;
    let events = daemon
        .browse(MDNS_SERVICE_TYPE)
        .map_err(|error| format!("OTHER:mdns browse failed: {error}"))?;

    let mut resolved_events = Vec::new();

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Ok(Ok(event)) = tokio::time::timeout(remaining, events.recv_async()).await else {
            break;
        };
        let mdns_sd::ServiceEvent::ServiceResolved(resolved) = event else {
            continue;
        };
        let addresses: Vec<std::net::IpAddr> =
            resolved.get_addresses().iter().map(mdns_sd::ScopedIp::to_ip_addr).collect();
        let id = resolved.get_property_val_str("id").map(str::to_string).filter(|id| !id.is_empty());
        let event = ResolvedEvent {
            name: strip_mdns_service_suffix(resolved.get_fullname()),
            port: resolved.get_port(),
            id,
            addresses,
        };
        log::info!(
            "[receiver] discover resolved {} port={} host={} addrs=[{}]",
            event.name,
            event.port,
            resolved.get_hostname(),
            join_ips(&event.addresses)
        );
        resolved_events.push(event);
    }

    let _ = daemon.stop_browse(MDNS_SERVICE_TYPE);
    let _ = daemon.shutdown();

    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    let discovered = merge_resolved_events(resolved_events, &interfaces);
    for entry in &discovered {
        log::info!(
            "[receiver] discover kept {} at {}:{} hosts=[{}]",
            entry.name,
            entry.host,
            entry.port,
            entry.hosts.join(", ")
        );
    }
    log::info!("[receiver] discover complete, found={}", discovered.len());
    Ok(discovered)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn receiver_discover(_timeout_ms: Option<u64>) -> Result<Vec<DiscoveredReceiver>, String> {
    Ok(Vec::new())
}

/// Best-effort teardown for app-exit paths; the async graceful-shutdown drives itself off the watch signal.
pub fn shutdown(state: &ReceiverState) {
    let handle = state
        .server
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take();
    if let Some(handle) = handle {
        let _ = handle.shutdown.send(true);
    }
    unadvertise_mdns(state);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

struct ServerCtx {
    shared: Arc<ReceiverShared>,
    events: Arc<dyn ReceiverEvents>,
    port: u16,
    config_dir: std::path::PathBuf,
    log_dir: std::path::PathBuf,
    shutdown_rx: watch::Receiver<bool>,
}

async fn ensure_server_started(
    state: &ReceiverState,
    events: Arc<dyn ReceiverEvents>,
    config_dir: std::path::PathBuf,
    log_dir: std::path::PathBuf,
) -> Result<(), String> {
    {
        let guard = state.server.lock().unwrap_or_else(|poison| poison.into_inner());
        if guard.is_some() {
            return Ok(());
        }
    }

    let (port, shutdown) = start_server(
        "0.0.0.0",
        RECEIVER_PORT,
        PORT_ATTEMPTS,
        state.shared.clone(),
        events,
        config_dir,
        log_dir,
    )
    .await
    .map_err(|error| format!("OTHER:failed to start receiver server: {error}"))?;

    let mut guard = state.server.lock().unwrap_or_else(|poison| poison.into_inner());
    if guard.is_some() {
        // Lost a startup race against a concurrent receiver_start call; drop the spare listener.
        let _ = shutdown.send(true);
        return Ok(());
    }
    *guard = Some(ServerHandle { port, shutdown });
    Ok(())
}

async fn start_server(
    bind_addr: &str,
    base_port: u16,
    port_attempts: u16,
    shared: Arc<ReceiverShared>,
    events: Arc<dyn ReceiverEvents>,
    config_dir: std::path::PathBuf,
    log_dir: std::path::PathBuf,
) -> std::io::Result<(u16, watch::Sender<bool>)> {
    let mut last_error = None;
    for offset in 0..port_attempts.max(1) {
        match tokio::net::TcpListener::bind((bind_addr, base_port.wrapping_add(offset))).await {
            Ok(listener) => return spawn_server(listener, shared, events, config_dir, log_dir).await,
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrInUse, "unable to bind receiver server")))
}

async fn spawn_server(
    listener: tokio::net::TcpListener,
    shared: Arc<ReceiverShared>,
    events: Arc<dyn ReceiverEvents>,
    config_dir: std::path::PathBuf,
    log_dir: std::path::PathBuf,
) -> std::io::Result<(u16, watch::Sender<bool>)> {
    let port = listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let ctx = Arc::new(ServerCtx { shared, events, port, config_dir, log_dir, shutdown_rx: shutdown_rx.clone() });
    let router = build_router(ctx);

    let mut graceful_shutdown_rx = shutdown_rx;
    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = graceful_shutdown_rx.changed().await;
        });
        if let Err(error) = serve.await {
            log::warn!("[receiver] server exited: {error}");
        }
    });

    Ok((port, shutdown_tx))
}

fn build_router(ctx: Arc<ServerCtx>) -> axum::Router {
    axum::Router::new()
        .route("/info", get(handle_info))
        .route("/pair", post(handle_pair))
        .route("/play", post(handle_play))
        .route("/ambient", post(handle_ambient))
        .route("/pause", post(handle_pause))
        .route("/resume", post(handle_resume))
        .route("/stop", post(handle_stop))
        .route("/seek", post(handle_seek))
        .route("/state", get(handle_state))
        .route("/logs", get(handle_logs))
        .route("/events", get(handle_events))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(ctx)
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (byte_left, byte_right) in left.iter().zip(right.iter()) {
        diff |= byte_left ^ byte_right;
    }
    diff == 0
}

fn find_device_by_key(ctx: &ServerCtx, key: &str) -> Option<String> {
    let devices = ctx.shared.devices.lock().unwrap_or_else(|poison| poison.into_inner());
    devices
        .iter()
        .find(|device| constant_time_eq(device.key.as_bytes(), key.as_bytes()))
        .map(|device| device.device_name.clone())
}

fn authenticate(ctx: &ServerCtx, headers: &HeaderMap) -> Option<String> {
    let key = headers.get(AUTH_HEADER)?.to_str().ok()?;
    find_device_by_key(ctx, key)
}

fn unauthorized_response() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response()
}

fn bad_request_response(reason: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error": reason}))).into_response()
}

fn is_http_url(value: &str) -> bool {
    tauri::Url::parse(value).is_ok_and(|url| url.scheme() == "http" || url.scheme() == "https")
}

fn broadcast_playback(ctx: &ServerCtx) {
    let playback = ctx.shared.playback.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    if let Ok(serialized) = serde_json::to_string(&playback) {
        let _ = ctx.shared.broadcast.send(serialized);
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn handle_info(State(ctx): State<Arc<ServerCtx>>) -> Response {
    let name = ctx.shared.name.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    Json(json!({"v": PROTOCOL_VERSION, "app": "extreme-infinitv", "name": name})).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    v: u32,
    code: String,
    #[serde(default)]
    device_name: Option<String>,
}

async fn handle_pair(State(ctx): State<Arc<ServerCtx>>, Json(body): Json<PairRequest>) -> Response {
    if body.v != PROTOCOL_VERSION {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "unsupportedVersion", "supported": PROTOCOL_VERSION})),
        )
            .into_response();
    }

    let bounded_name = resolve_device_name(&body.device_name.unwrap_or_default(), "Unknown device");

    let now = Instant::now();
    let (outcome, code_regenerated) = {
        let mut pairing_guard = ctx.shared.pairing.lock().unwrap_or_else(|poison| poison.into_inner());
        let pairing = pairing_guard.get_or_insert_with(PairingState::new);
        let code_before = pairing.code.clone();
        let outcome = evaluate_pair_attempt(pairing, body.code.trim(), now);
        (outcome, pairing.code != code_before)
    };

    match outcome {
        PairOutcome::Paired => {
            let key = generate_device_key();
            let device = PairedDevice {
                key: key.clone(),
                device_name: bounded_name.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            let receiver_id = ctx.shared.receiver_id.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
            let devices_snapshot = {
                let mut devices = ctx.shared.devices.lock().unwrap_or_else(|poison| poison.into_inner());
                devices.push(device);
                evict_oldest_if_over_capacity(&mut devices);
                devices.clone()
            };
            if let Err(error) = persist_devices(ctx.config_dir.clone(), receiver_id, devices_snapshot).await {
                log::warn!("[receiver] failed to persist paired device: {error}");
            }
            ctx.events.paired(json!({"deviceName": bounded_name}));
            ctx.events.status(build_status_json(&ctx.shared, Some(ctx.port)));
            let receiver_name = ctx.shared.name.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
            (StatusCode::OK, Json(json!({"key": key, "name": receiver_name}))).into_response()
        }
        PairOutcome::BadCode => {
            if code_regenerated {
                ctx.events.status(build_status_json(&ctx.shared, Some(ctx.port)));
            }
            (StatusCode::FORBIDDEN, Json(json!({"error": "badCode"}))).into_response()
        }
        PairOutcome::RateLimited { retry_after_secs } => {
            if code_regenerated {
                ctx.events.status(build_status_json(&ctx.shared, Some(ctx.port)));
            }
            let mut response =
                (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error": "rateLimited"}))).into_response();
            if let Ok(value) = HeaderValue::from_str(&retry_after_secs.to_string()) {
                response.headers_mut().insert(axum::http::header::RETRY_AFTER, value);
            }
            response
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PlayHeaders {
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    referer: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayRequest {
    v: u32,
    src: String,
    #[serde(default)]
    mime: Option<String>,
    is_live: bool,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    logo: Option<String>,
    #[serde(default)]
    drm: Option<Value>,
    #[serde(default)]
    headers: Option<PlayHeaders>,
    #[serde(default)]
    resume_seconds: Option<f64>,
    #[serde(default)]
    duration_seconds: Option<f64>,
    #[serde(default)]
    timeline_offset_seconds: Option<f64>,
    #[serde(default)]
    prefer_native_hls: Option<bool>,
}

async fn handle_play(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap, raw_body: Bytes) -> Response {
    let Some(device_name) = authenticate(&ctx, &headers) else {
        return unauthorized_response();
    };
    let Ok(mut body) = serde_json::from_slice::<PlayRequest>(&raw_body) else {
        return bad_request_response("badRequest");
    };
    if body.v != PROTOCOL_VERSION {
        return bad_request_response("unsupportedVersion");
    }
    if body.src.len() > MAX_URL_LEN {
        return bad_request_response("srcTooLong");
    }
    let Ok(parsed_src) = tauri::Url::parse(&body.src) else {
        return bad_request_response("invalidSrc");
    };
    if parsed_src.scheme() != "http" && parsed_src.scheme() != "https" {
        return bad_request_response("invalidSrc");
    }
    if body.mime.as_deref().unwrap_or("").is_empty() {
        return bad_request_response("missingMime");
    }
    if body.mime.as_deref().is_some_and(|mime| mime.len() > MAX_MIME_LEN) {
        return bad_request_response("mimeTooLong");
    }
    if body.title.as_deref().is_some_and(|title| title.len() > MAX_TITLE_LEN) {
        return bad_request_response("titleTooLong");
    }
    if body.logo.as_deref().is_some_and(|logo| logo.len() > MAX_URL_LEN) {
        return bad_request_response("logoTooLong");
    }
    if let Some(play_headers) = &body.headers {
        if play_headers.user_agent.as_deref().is_some_and(|value| value.len() > MAX_TITLE_LEN)
            || play_headers.referer.as_deref().is_some_and(|value| value.len() > MAX_URL_LEN)
        {
            return bad_request_response("headerTooLong");
        }
    }
    if let Some(drm) = &body.drm {
        let serialized_len = serde_json::to_string(drm).map(|value| value.len()).unwrap_or(0);
        if serialized_len > MAX_DRM_JSON_BYTES {
            return bad_request_response("drmTooLarge");
        }
    }

    // Advisory fields: drop rather than reject on bad values.
    if body.resume_seconds.is_some_and(|value| !value.is_finite() || value < 0.0) {
        body.resume_seconds = None;
    }
    if body.duration_seconds.is_some_and(|value| !value.is_finite() || value < 0.0) {
        body.duration_seconds = None;
    }
    if body.timeline_offset_seconds.is_some_and(|value| !value.is_finite() || value < 0.0) {
        body.timeline_offset_seconds = None;
    }
    if let Some(logo) = body.logo.as_deref() {
        if !is_http_url(logo) {
            body.logo = None;
        }
    }

    {
        let mut playback = ctx.shared.playback.lock().unwrap_or_else(|poison| poison.into_inner());
        *playback = PlaybackReport {
            state: "loading".to_string(),
            position_seconds: 0.0,
            duration_seconds: body.duration_seconds,
            title: body.title.clone(),
            error: None,
        };
    }
    broadcast_playback(&ctx);

    let descriptor = serde_json::to_value(&body).unwrap_or_else(|_| json!({}));
    ctx.events.play(json!({"descriptor": descriptor, "deviceName": device_name}));

    (StatusCode::OK, Json(json!({"ok": true}))).into_response()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmbientPushEntry {
    kind: String,
    id: String,
    title: String,
    #[serde(default)]
    poster_url: Option<String>,
    #[serde(default)]
    backdrop_url: Option<String>,
    #[serde(default)]
    logo_url: Option<String>,
    tier: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmbientPushRequest {
    v: u32,
    entries: Vec<AmbientPushEntry>,
}

fn sanitize_ambient_url(value: Option<String>) -> Option<String> {
    let value = value?;
    if value.len() > MAX_URL_LEN || !is_http_url(&value) {
        return None;
    }
    Some(value)
}

/// Drops an entry outright on a bad kind/title/id or when no artwork url survives sanitization;
/// an unknown tier falls back to "catalog" rather than dropping the entry.
fn sanitize_ambient_entry(entry: AmbientPushEntry) -> Option<AmbientPushEntry> {
    if !ALLOWED_AMBIENT_KINDS.contains(&entry.kind.as_str()) {
        return None;
    }
    let id = entry.id.trim();
    if id.is_empty() || id.chars().count() > MAX_AMBIENT_ID_LEN {
        return None;
    }
    let title = entry.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_LEN {
        return None;
    }
    let poster_url = sanitize_ambient_url(entry.poster_url);
    let backdrop_url = sanitize_ambient_url(entry.backdrop_url);
    let logo_url = sanitize_ambient_url(entry.logo_url);
    if poster_url.is_none() && backdrop_url.is_none() && logo_url.is_none() {
        return None;
    }
    let tier = if ALLOWED_AMBIENT_TIERS.contains(&entry.tier.as_str()) {
        entry.tier
    } else {
        "catalog".to_string()
    };
    Some(AmbientPushEntry { kind: entry.kind, id: id.to_string(), title: title.to_string(), poster_url, backdrop_url, logo_url, tier })
}

async fn handle_ambient(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap, raw_body: Bytes) -> Response {
    let Some(device_name) = authenticate(&ctx, &headers) else {
        return unauthorized_response();
    };
    let Ok(mut body) = serde_json::from_slice::<AmbientPushRequest>(&raw_body) else {
        return bad_request_response("badRequest");
    };
    if body.v != PROTOCOL_VERSION {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "unsupportedVersion", "supported": PROTOCOL_VERSION})),
        )
            .into_response();
    }
    body.entries.truncate(MAX_AMBIENT_ENTRIES);
    let sanitized: Vec<AmbientPushEntry> = body.entries.into_iter().filter_map(sanitize_ambient_entry).collect();

    let entries = serde_json::to_value(&sanitized).unwrap_or_else(|_| json!([]));
    ctx.events.ambient(json!({"entries": entries, "deviceName": device_name}));

    (StatusCode::OK, Json(json!({"ok": true, "accepted": sanitized.len()}))).into_response()
}

async fn handle_transport(ctx: Arc<ServerCtx>, headers: HeaderMap, action: &'static str) -> Response {
    let Some(device_name) = authenticate(&ctx, &headers) else {
        return unauthorized_response();
    };
    ctx.events.control(json!({"action": action, "deviceName": device_name}));
    if action == "stop" {
        *ctx.shared.playback.lock().unwrap_or_else(|poison| poison.into_inner()) = PlaybackReport::default();
        broadcast_playback(&ctx);
    }
    (StatusCode::OK, Json(json!({"ok": true}))).into_response()
}

async fn handle_pause(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap) -> Response {
    handle_transport(ctx, headers, "pause").await
}

async fn handle_resume(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap) -> Response {
    handle_transport(ctx, headers, "resume").await
}

async fn handle_stop(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap) -> Response {
    handle_transport(ctx, headers, "stop").await
}

#[derive(Debug, Deserialize)]
struct SeekRequest {
    // Option, not f64: NaN/Infinity round-trip through JSON as `null`, which must still be rejected.
    seconds: Option<f64>,
}

async fn handle_seek(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap, raw_body: Bytes) -> Response {
    let Some(device_name) = authenticate(&ctx, &headers) else {
        return unauthorized_response();
    };
    let Ok(body) = serde_json::from_slice::<SeekRequest>(&raw_body) else {
        return bad_request_response("badRequest");
    };
    let Some(seconds) = body.seconds else {
        return bad_request_response("invalidSeconds");
    };
    if !seconds.is_finite() || seconds < 0.0 {
        return bad_request_response("invalidSeconds");
    }
    ctx.events.control(json!({"action": "seek", "seconds": seconds, "deviceName": device_name}));
    (StatusCode::OK, Json(json!({"ok": true}))).into_response()
}

async fn handle_state(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap) -> Response {
    if authenticate(&ctx, &headers).is_none() {
        return unauthorized_response();
    }
    let playback = ctx.shared.playback.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    Json(playback).into_response()
}

async fn handle_logs(State(ctx): State<Arc<ServerCtx>>, headers: HeaderMap) -> Response {
    if authenticate(&ctx, &headers).is_none() {
        return unauthorized_response();
    }
    let log_dir = ctx.log_dir.clone();
    let text = tauri::async_runtime::spawn_blocking(move || newest_log_tail(&log_dir)).await.unwrap_or_default();
    (StatusCode::OK, [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response()
}

fn newest_log_tail(log_dir: &std::path::Path) -> String {
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return String::new();
    };
    let newest_log = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("log"))
        .filter_map(|entry| entry.metadata().and_then(|metadata| metadata.modified()).ok().map(|modified| (modified, entry.path())))
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path);
    let Some(newest_log) = newest_log else {
        return String::new();
    };
    let Ok(bytes) = std::fs::read(&newest_log) else {
        return String::new();
    };
    tail_as_utf8(&bytes, MAX_LOG_TAIL_BYTES)
}

fn tail_as_utf8(bytes: &[u8], max_bytes: usize) -> String {
    let tail_start = bytes.len().saturating_sub(max_bytes);
    let tail = String::from_utf8_lossy(&bytes[tail_start..]);
    if tail_start == 0 {
        return tail.into_owned();
    }
    match tail.find('\n') {
        Some(index) => tail[index + 1..].to_string(),
        None => String::new(),
    }
}

async fn handle_events(
    State(ctx): State<Arc<ServerCtx>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let key = query.get("key").map(String::as_str).unwrap_or_default();
    if find_device_by_key(&ctx, key).is_none() {
        return unauthorized_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

async fn handle_socket(mut socket: WebSocket, ctx: Arc<ServerCtx>) {
    let mut broadcast_rx = ctx.shared.broadcast.subscribe();
    let mut shutdown_rx = ctx.shutdown_rx.clone();

    let initial_state = {
        let playback = ctx.shared.playback.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
        serde_json::to_string(&playback).unwrap_or_default()
    };
    if socket.send(Message::Text(initial_state.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            received = broadcast_rx.recv() => {
                match received {
                    Ok(state_json) => {
                        if socket.send(Message::Text(state_json.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            changed = shutdown_rx.changed() => {
                if changed.is_ok() {
                    let _ = socket.send(Message::Close(None)).await;
                }
                break;
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(_)) => continue,
                    _ => break,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // ---------------------------------------------------------------------
    // Pairing state machine
    // ---------------------------------------------------------------------

    #[test]
    fn evaluate_pair_attempt_pairs_on_the_correct_code() {
        let mut pairing = PairingState::new();
        let code = pairing.code.clone();
        let outcome = evaluate_pair_attempt(&mut pairing, &code, Instant::now());
        assert_eq!(outcome, PairOutcome::Paired);
    }

    #[test]
    fn evaluate_pair_attempt_codes_are_single_use() {
        let mut pairing = PairingState::new();
        let code = pairing.code.clone();
        let now = Instant::now();
        assert_eq!(evaluate_pair_attempt(&mut pairing, &code, now), PairOutcome::Paired);
        let later = now + PAIR_MIN_INTERVAL + Duration::from_millis(1);
        assert_eq!(evaluate_pair_attempt(&mut pairing, &code, later), PairOutcome::BadCode);
    }

    #[test]
    fn evaluate_pair_attempt_wrong_code_increments_failures() {
        let mut pairing = PairingState::new();
        let now = Instant::now();
        assert_eq!(evaluate_pair_attempt(&mut pairing, "000000", now), PairOutcome::BadCode);
        assert_eq!(pairing.failed_attempts, 1);
    }

    #[test]
    fn evaluate_pair_attempt_locks_out_after_max_failures() {
        let mut pairing = PairingState::new();
        let mut now = Instant::now();
        for _ in 0..PAIR_MAX_FAILURES {
            evaluate_pair_attempt(&mut pairing, "wrong-code", now);
            now += PAIR_MIN_INTERVAL + Duration::from_millis(1);
        }
        assert!(pairing.locked_until.is_some());
        match evaluate_pair_attempt(&mut pairing, "wrong-code", now) {
            PairOutcome::RateLimited { retry_after_secs } => assert!(retry_after_secs > 0),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn evaluate_pair_attempt_lockout_expiry_allows_another_attempt() {
        let mut pairing = PairingState::new();
        let mut now = Instant::now();
        for _ in 0..PAIR_MAX_FAILURES {
            evaluate_pair_attempt(&mut pairing, "wrong-code", now);
            now += PAIR_MIN_INTERVAL + Duration::from_millis(1);
        }
        assert!(pairing.locked_until.is_some());
        let after_lockout = now + PAIR_LOCKOUT + Duration::from_millis(1);
        let code = pairing.code.clone();
        assert_eq!(evaluate_pair_attempt(&mut pairing, &code, after_lockout), PairOutcome::Paired);
    }

    #[test]
    fn evaluate_pair_attempt_ttl_expiry_regenerates_the_code() {
        let mut pairing = PairingState::new();
        let stale_code = pairing.code.clone();
        let after_ttl = Instant::now() + PAIR_CODE_TTL + Duration::from_millis(1);
        let outcome = evaluate_pair_attempt(&mut pairing, &stale_code, after_ttl);
        assert_eq!(outcome, PairOutcome::BadCode);
        assert_ne!(pairing.code, stale_code);
    }

    #[test]
    fn evaluate_pair_attempt_min_interval_floor_rate_limits_rapid_attempts() {
        let mut pairing = PairingState::new();
        let now = Instant::now();
        evaluate_pair_attempt(&mut pairing, "wrong-code", now);
        let outcome = evaluate_pair_attempt(&mut pairing, "wrong-code", now + Duration::from_millis(1));
        match outcome {
            PairOutcome::RateLimited { retry_after_secs } => assert!(retry_after_secs >= 1),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn resolve_device_name_falls_back_when_blank() {
        assert_eq!(resolve_device_name("   ", "Extreme InfiniTV"), "Extreme InfiniTV");
        assert_eq!(resolve_device_name("", "Extreme InfiniTV"), "Extreme InfiniTV");
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn default_receiver_name_is_never_blank() {
        let name = default_receiver_name();
        assert!(!name.is_empty());
        assert!(!name.to_ascii_lowercase().ends_with(".local"), "unexpected mDNS suffix in {name}");
    }

    #[test]
    fn usable_mdns_addr_rejects_link_local_v6() {
        let link_local: std::net::IpAddr = "fe80::75b5:1a9f:336:d8b5".parse().unwrap();
        let global_v6: std::net::IpAddr = "2001:db8::1".parse().unwrap();
        let private_v4: std::net::IpAddr = "192.168.178.27".parse().unwrap();
        assert!(!is_usable_mdns_addr(&link_local));
        assert!(is_usable_mdns_addr(&global_v6));
        assert!(is_usable_mdns_addr(&private_v4));
    }

    #[test]
    fn usable_hostname_rejects_blank_and_localhost() {
        assert_eq!(usable_hostname(""), None);
        assert_eq!(usable_hostname("   "), None);
        assert_eq!(usable_hostname("localhost"), None);
        assert_eq!(usable_hostname("LOCALHOST"), None);
    }

    #[test]
    fn usable_hostname_trims_and_keeps_a_real_name() {
        assert_eq!(usable_hostname("  living-room-pc  "), Some("living-room-pc".to_string()));
    }

    #[test]
    fn usable_hostname_strips_the_macos_mdns_suffix() {
        assert_eq!(usable_hostname("MacBook-Pro-von-Ludo.local"), Some("MacBook-Pro-von-Ludo".to_string()));
        assert_eq!(usable_hostname("MacBook-Pro-von-Ludo.local."), Some("MacBook-Pro-von-Ludo".to_string()));
        assert_eq!(usable_hostname("Mac.LOCAL"), Some("Mac".to_string()));
        assert_eq!(usable_hostname("localhost.local"), None);
        assert_eq!(usable_hostname(".local"), None);
    }

    #[test]
    fn usable_hostname_keeps_names_that_merely_contain_local() {
        assert_eq!(usable_hostname("local-tv"), Some("local-tv".to_string()));
        assert_eq!(usable_hostname("DESKTOP-ANRA73S"), Some("DESKTOP-ANRA73S".to_string()));
        assert_eq!(usable_hostname("wohnzimmer-übertragung"), Some("wohnzimmer-übertragung".to_string()));
    }

    #[test]
    fn resolve_device_name_trims_and_bounds_to_char_count() {
        assert_eq!(resolve_device_name("  Living Room TV  ", "Extreme InfiniTV"), "Living Room TV");
        let oversized = "\u{00fc}".repeat(receiver_store::MAX_DEVICE_NAME_LEN + 10);
        let resolved = resolve_device_name(&oversized, "Extreme InfiniTV");
        assert_eq!(resolved.chars().count(), receiver_store::MAX_DEVICE_NAME_LEN);
    }

    // ---------------------------------------------------------------------
    // mDNS advertising (desktop only)
    // ---------------------------------------------------------------------

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn mdns_instance_name_strips_dots_and_control_chars() {
        assert_eq!(mdns_instance_name("  Living Room TV  "), "Living Room TV");
        assert_eq!(mdns_instance_name("a.b.c"), "abc");
        assert_eq!(mdns_instance_name("bad\u{0007}name"), "badname");
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn mdns_instance_name_falls_back_when_blank() {
        assert_eq!(mdns_instance_name(""), "Extreme InfiniTV");
        assert_eq!(mdns_instance_name("   "), "Extreme InfiniTV");
        assert_eq!(mdns_instance_name("..."), "Extreme InfiniTV");
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn mdns_instance_name_bounds_to_max_label_length() {
        let oversized = "a".repeat(MDNS_LABEL_MAX_LEN + 20);
        assert_eq!(mdns_instance_name(&oversized).chars().count(), MDNS_LABEL_MAX_LEN);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn mdns_host_label_falls_back_when_no_alphanumeric_chars() {
        assert_eq!(mdns_host_label("!!!"), "xtream-receiver");
        assert_eq!(mdns_host_label("Living Room TV"), "Living-Room-TV");
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn best_mdns_addr_prefers_private_ipv4_over_public_ipv4_and_ipv6() {
        let candidates: Vec<std::net::IpAddr> = vec![
            "203.0.113.5".parse().unwrap(),
            "192.168.1.20".parse().unwrap(),
            "2001:db8::1".parse().unwrap(),
        ];
        assert_eq!(best_mdns_addr(&candidates), Some("192.168.1.20".parse().unwrap()));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn best_mdns_addr_falls_back_to_public_ipv4_then_ipv6() {
        let public_ipv4: Vec<std::net::IpAddr> =
            vec!["203.0.113.5".parse().unwrap(), "2001:db8::1".parse().unwrap()];
        assert_eq!(best_mdns_addr(&public_ipv4), Some("203.0.113.5".parse().unwrap()));

        let ipv6_only: Vec<std::net::IpAddr> = vec!["2001:db8::1".parse().unwrap()];
        assert_eq!(best_mdns_addr(&ipv6_only), Some("2001:db8::1".parse().unwrap()));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn best_mdns_addr_filters_loopback_unspecified_and_link_local() {
        let candidates: Vec<std::net::IpAddr> = vec![
            "127.0.0.1".parse().unwrap(),
            "0.0.0.0".parse().unwrap(),
            "169.254.1.5".parse().unwrap(),
            "::1".parse().unwrap(),
        ];
        assert_eq!(best_mdns_addr(&candidates), None);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn test_interface_v4(ip: &str, prefixlen: u8) -> if_addrs::Interface {
        if_addrs::Interface {
            name: "test0".to_string(),
            addr: if_addrs::IfAddr::V4(if_addrs::Ifv4Addr {
                ip: ip.parse().unwrap(),
                netmask: std::net::Ipv4Addr::new(255, 255, 255, 0),
                prefixlen,
                broadcast: None,
            }),
            index: None,
            oper_status: if_addrs::IfOperStatus::Up,
            is_p2p: false,
            #[cfg(windows)]
            adapter_name: String::new(),
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn test_interface_v6(ip: &str, prefixlen: u8) -> if_addrs::Interface {
        if_addrs::Interface {
            name: "test0".to_string(),
            addr: if_addrs::IfAddr::V6(if_addrs::Ifv6Addr {
                ip: ip.parse().unwrap(),
                netmask: std::net::Ipv6Addr::UNSPECIFIED,
                prefixlen,
                broadcast: None,
            }),
            index: None,
            oper_status: if_addrs::IfOperStatus::Up,
            is_p2p: false,
            #[cfg(windows)]
            adapter_name: String::new(),
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn same_subnet_v4_matches_within_the_masked_prefix() {
        let local: std::net::Ipv4Addr = "192.168.1.5".parse().unwrap();
        assert!(same_subnet_v4(local, "192.168.1.20".parse().unwrap(), 24));
        assert!(!same_subnet_v4(local, "192.168.2.20".parse().unwrap(), 24));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn same_subnet_v4_rejects_zero_and_oversized_prefixlen() {
        let local: std::net::Ipv4Addr = "192.168.1.5".parse().unwrap();
        let candidate: std::net::Ipv4Addr = "192.168.1.20".parse().unwrap();
        assert!(!same_subnet_v4(local, candidate, 0));
        assert!(!same_subnet_v4(local, candidate, 33));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn same_subnet_v6_compares_the_top_64_bits_only() {
        let local: std::net::Ipv6Addr = "2001:db8:1::1".parse().unwrap();
        assert!(same_subnet_v6(local, "2001:db8:1::9999".parse().unwrap()));
        assert!(!same_subnet_v6(local, "2001:db8:2::1".parse().unwrap()));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn rank_discovered_hosts_prefers_a_same_subnet_address_over_any_other() {
        let interfaces = vec![test_interface_v4("192.168.1.5", 24)];
        let addresses: Vec<std::net::IpAddr> = vec![
            "203.0.113.5".parse().unwrap(),
            "192.168.1.20".parse().unwrap(),
            "10.0.0.5".parse().unwrap(),
        ];
        let ranked = rank_discovered_hosts(addresses, &interfaces);
        assert_eq!(ranked[0], "192.168.1.20".parse::<std::net::IpAddr>().unwrap());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn rank_discovered_hosts_falls_back_to_private_then_public_then_v6_without_a_subnet_match() {
        let interfaces = vec![test_interface_v4("192.168.1.5", 24)];
        let addresses: Vec<std::net::IpAddr> = vec![
            "2001:db8::1".parse().unwrap(),
            "203.0.113.5".parse().unwrap(),
            "10.0.0.5".parse().unwrap(),
        ];
        let ranked = rank_discovered_hosts(addresses, &interfaces);
        assert_eq!(
            ranked,
            vec![
                "10.0.0.5".parse::<std::net::IpAddr>().unwrap(),
                "203.0.113.5".parse().unwrap(),
                "2001:db8::1".parse().unwrap(),
            ]
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn rank_discovered_hosts_prefers_a_v6_subnet_match_too() {
        let interfaces = vec![test_interface_v6("2001:db8:1::5", 64)];
        let addresses: Vec<std::net::IpAddr> =
            vec!["192.168.1.20".parse().unwrap(), "2001:db8:1::9999".parse().unwrap()];
        let ranked = rank_discovered_hosts(addresses, &interfaces);
        assert_eq!(ranked[0], "2001:db8:1::9999".parse::<std::net::IpAddr>().unwrap());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn discovery_identity_key_prefers_id_over_name_and_port() {
        assert_eq!(discovery_identity_key("Living Room", 47815, Some("abc123")), "id:abc123");
        assert_eq!(discovery_identity_key("Living Room", 47815, None), "np:Living Room:47815");
        assert_eq!(discovery_identity_key("Living Room", 47815, Some("")), "np:Living Room:47815");
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn merge_resolved_events_dedupes_by_id_and_unions_addresses_across_events() {
        let events = vec![
            ResolvedEvent {
                name: "Living Room".to_string(),
                port: 47815,
                id: Some("abc123".to_string()),
                addresses: vec!["192.168.1.20".parse().unwrap()],
            },
            ResolvedEvent {
                name: "Living Room".to_string(),
                port: 47815,
                id: Some("abc123".to_string()),
                addresses: vec!["10.0.0.20".parse().unwrap()],
            },
        ];
        let discovered = merge_resolved_events(events, &[]);
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id.as_deref(), Some("abc123"));
        assert_eq!(discovered[0].hosts.len(), 2);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn merge_resolved_events_dedupes_by_name_and_port_when_id_is_missing() {
        let events = vec![
            ResolvedEvent {
                name: "Old Firmware TV".to_string(),
                port: 47815,
                id: None,
                addresses: vec!["192.168.1.20".parse().unwrap()],
            },
            ResolvedEvent {
                name: "Old Firmware TV".to_string(),
                port: 47815,
                id: None,
                addresses: vec!["192.168.1.20".parse().unwrap()],
            },
        ];
        let discovered = merge_resolved_events(events, &[]);
        assert_eq!(discovered.len(), 1);
        assert!(discovered[0].id.is_none());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn merge_resolved_events_keeps_distinct_identities_separate() {
        let events = vec![
            ResolvedEvent {
                name: "Living Room".to_string(),
                port: 47815,
                id: Some("abc123".to_string()),
                addresses: vec!["192.168.1.20".parse().unwrap()],
            },
            ResolvedEvent {
                name: "Bedroom".to_string(),
                port: 47815,
                id: Some("def456".to_string()),
                addresses: vec!["192.168.1.21".parse().unwrap()],
            },
        ];
        let discovered = merge_resolved_events(events, &[]);
        assert_eq!(discovered.len(), 2);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn merge_resolved_events_drops_events_with_no_usable_address() {
        let events = vec![ResolvedEvent {
            name: "Living Room".to_string(),
            port: 47815,
            id: None,
            addresses: vec!["127.0.0.1".parse().unwrap()],
        }];
        assert!(merge_resolved_events(events, &[]).is_empty());
    }

    // Must advertise a real interface address: mdns-sd only puts an address record on an
    // interface whose subnet contains it, so a TEST-NET IP is announced on no interface at all.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[tokio::test]
    async fn mdns_self_discovery_finds_the_advertised_receiver() {
        let Some(advertised_ip) = local_ips().into_iter().next() else {
            return;
        };
        let port = 47_900;
        let name = format!("Test Receiver {}", generate_device_key());
        let instance_name = mdns_instance_name(&name);
        let host_name = format!("{}.local.", mdns_host_label(&instance_name));

        let daemon = mdns_sd::ServiceDaemon::new().expect("mdns daemon must start");
        let service_info = mdns_sd::ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            &instance_name,
            &host_name,
            advertised_ip.as_str(),
            port,
            &[("v", "1"), ("id", "self-discovery-test-id")][..],
        )
        .expect("service info must build");
        let fullname = service_info.get_fullname().to_string();
        daemon.register(service_info).expect("mdns register must succeed");

        let discovered = receiver_discover(Some(4000)).await.expect("discover must succeed");

        let _ = daemon.unregister(&fullname);
        let _ = daemon.shutdown();

        let matches: Vec<_> = discovered.iter().filter(|receiver| receiver.port == port).collect();
        assert_eq!(matches.len(), 1, "expected exactly one entry for the advertised receiver");
        assert_eq!(matches[0].id.as_deref(), Some("self-discovery-test-id"));
        assert!(matches[0].hosts.contains(&advertised_ip), "hosts {:?} must include {advertised_ip}", matches[0].hosts);
        assert_eq!(matches[0].host, matches[0].hosts[0]);
        assert_eq!(matches[0].name, instance_name);
    }

    #[test]
    fn maybe_regenerate_expired_code_leaves_a_fresh_code_untouched() {
        let mut slot = Some(PairingState::new());
        assert!(!maybe_regenerate_expired_code(&mut slot));
    }

    #[test]
    fn playback_report_deserializes_with_only_state_and_position() {
        let report: PlaybackReport =
            serde_json::from_value(json!({"state": "playing", "positionSeconds": 12.5})).unwrap();
        assert_eq!(report.state, "playing");
        assert_eq!(report.position_seconds, 12.5);
        assert!(report.duration_seconds.is_none());
        assert!(report.title.is_none());
        assert!(report.error.is_none());
    }

    #[test]
    fn playback_report_deserializes_with_only_state() {
        let report: PlaybackReport = serde_json::from_value(json!({"state": "idle"})).unwrap();
        assert_eq!(report.state, "idle");
        assert_eq!(report.position_seconds, 0.0);
    }

    // ---------------------------------------------------------------------
    // End-to-end HTTP + WS server
    // ---------------------------------------------------------------------

    struct CollectorEvents {
        play: StdMutex<Vec<Value>>,
        control: StdMutex<Vec<Value>>,
        status: StdMutex<Vec<Value>>,
        paired: StdMutex<Vec<Value>>,
        ambient: StdMutex<Vec<Value>>,
    }

    impl CollectorEvents {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                play: StdMutex::new(Vec::new()),
                control: StdMutex::new(Vec::new()),
                status: StdMutex::new(Vec::new()),
                paired: StdMutex::new(Vec::new()),
                ambient: StdMutex::new(Vec::new()),
            })
        }
    }

    impl ReceiverEvents for CollectorEvents {
        fn play(&self, payload: Value) {
            self.play.lock().unwrap().push(payload);
        }
        fn control(&self, payload: Value) {
            self.control.lock().unwrap().push(payload);
        }
        fn status(&self, payload: Value) {
            self.status.lock().unwrap().push(payload);
        }
        fn paired(&self, payload: Value) {
            self.paired.lock().unwrap().push(payload);
        }
        fn ambient(&self, payload: Value) {
            self.ambient.lock().unwrap().push(payload);
        }
    }

    struct TestServer {
        base_url: String,
        collector: Arc<CollectorEvents>,
        shared: Arc<ReceiverShared>,
        client: reqwest::Client,
        config_dir: std::path::PathBuf,
        log_dir: std::path::PathBuf,
        _shutdown: watch::Sender<bool>,
    }

    impl TestServer {
        async fn pair(&self, code: &str, device_name: &str) -> reqwest::Response {
            self.client
                .post(format!("{}/pair", self.base_url))
                .json(&json!({"v": PROTOCOL_VERSION, "code": code, "deviceName": device_name}))
                .send()
                .await
                .expect("pair request must succeed")
        }
    }

    async fn start_test_server() -> TestServer {
        start_test_server_with_log_dir(std::env::temp_dir().join(format!("xt-receiver-test-logs-{}", generate_device_key())))
            .await
    }

    async fn start_test_server_with_log_dir(log_dir: std::path::PathBuf) -> TestServer {
        let shared = Arc::new(ReceiverShared::new());
        let collector = CollectorEvents::new();
        let events: Arc<dyn ReceiverEvents> = collector.clone();
        let config_dir = std::env::temp_dir().join(format!("xt-receiver-test-{}", generate_device_key()));

        *shared.pairing.lock().unwrap() = Some(PairingState::new());
        *shared.name.lock().unwrap() = "Test Receiver".to_string();

        let (port, shutdown) =
            start_server("127.0.0.1", 0, 1, shared.clone(), events, config_dir.clone(), log_dir.clone())
                .await
                .expect("test server must bind");

        TestServer {
            base_url: format!("http://127.0.0.1:{port}"),
            collector,
            shared,
            client: reqwest::Client::new(),
            config_dir,
            log_dir,
            _shutdown: shutdown,
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            let _ = self._shutdown.send(true);
            let _ = std::fs::remove_dir_all(&self.config_dir);
            let _ = std::fs::remove_dir_all(&self.log_dir);
        }
    }

    #[tokio::test]
    async fn receiver_http_end_to_end() {
        let server = start_test_server().await;

        let info: Value = server
            .client
            .get(format!("{}/info", server.base_url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(info["v"], PROTOCOL_VERSION);
        assert_eq!(info["app"], "extreme-infinitv");

        let failed_pair = server.pair("000000", "Test device").await;
        assert_eq!(failed_pair.status(), StatusCode::FORBIDDEN);

        // Clears the per-attempt debounce floor so the next call isn't itself rate-limited.
        tokio::time::sleep(PAIR_MIN_INTERVAL + Duration::from_millis(50)).await;

        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let paired_response = server.pair(&code, "Test device").await;
        assert_eq!(paired_response.status(), StatusCode::OK);
        let paired_body: Value = paired_response.json().await.unwrap();
        let key = paired_body["key"].as_str().unwrap().to_string();
        // /pair must return the receiver's own name, not the submitted device name.
        assert_eq!(paired_body["name"], "Test Receiver");
        assert_eq!(server.collector.paired.lock().unwrap().len(), 1);

        let play_response = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({
                "v": PROTOCOL_VERSION,
                "src": "https://example.test/stream.m3u8",
                "mime": "application/vnd.apple.mpegurl",
                "isLive": true,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(play_response.status(), StatusCode::OK);
        assert_eq!(server.collector.play.lock().unwrap().len(), 1);

        let state_response = server
            .client
            .get(format!("{}/state", server.base_url))
            .header("X-XT-Key", &key)
            .send()
            .await
            .unwrap();
        assert_eq!(state_response.status(), StatusCode::OK);
        let state_body: PlaybackReport = state_response.json().await.unwrap();
        assert_eq!(state_body.state, "loading");

        let unauthorized_state = server
            .client
            .get(format!("{}/state", server.base_url))
            .header("X-XT-Key", "not-a-real-key")
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized_state.status(), StatusCode::UNAUTHORIZED);

        let seek_response = server
            .client
            .post(format!("{}/seek", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"seconds": 30.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(seek_response.status(), StatusCode::OK);
        assert_eq!(server.collector.control.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn receiver_http_pair_emits_status_when_code_regenerates_on_lockout() {
        let server = start_test_server().await;
        let stale_code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();

        for _ in 0..PAIR_MAX_FAILURES {
            let response = server.pair("000000", "Test device").await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            tokio::time::sleep(PAIR_MIN_INTERVAL + Duration::from_millis(50)).await;
        }

        let regenerated_code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        assert_ne!(regenerated_code, stale_code);
        assert!(!server.collector.status.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn receiver_http_rejects_invalid_play_requests() {
        let server = start_test_server().await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let bad_scheme = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"v": PROTOCOL_VERSION, "src": "ftp://example.test/stream.m3u8", "isLive": true}))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_scheme.status(), StatusCode::BAD_REQUEST);

        let oversized_src = "https://example.test/".to_string() + &"a".repeat(MAX_URL_LEN);
        let too_long = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"v": PROTOCOL_VERSION, "src": oversized_src, "isLive": true}))
            .send()
            .await
            .unwrap();
        assert_eq!(too_long.status(), StatusCode::BAD_REQUEST);

        let oversized_title = "a".repeat(MAX_TITLE_LEN + 1);
        let bad_title = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({
                "v": PROTOCOL_VERSION,
                "src": "https://example.test/stream.m3u8",
                "mime": "application/vnd.apple.mpegurl",
                "isLive": true,
                "title": oversized_title,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_title.status(), StatusCode::BAD_REQUEST);

        let missing_mime = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"v": PROTOCOL_VERSION, "src": "https://example.test/stream.m3u8", "isLive": true}))
            .send()
            .await
            .unwrap();
        assert_eq!(missing_mime.status(), StatusCode::BAD_REQUEST);

        let empty_mime = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({
                "v": PROTOCOL_VERSION,
                "src": "https://example.test/stream.m3u8",
                "isLive": true,
                "mime": "",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(empty_mime.status(), StatusCode::BAD_REQUEST);

        let wrong_version = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"v": 2, "src": "https://example.test/stream.m3u8", "isLive": true}))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_version.status(), StatusCode::BAD_REQUEST);

        let oversized_mime = "a".repeat(MAX_MIME_LEN + 1);
        let bad_mime = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({
                "v": PROTOCOL_VERSION,
                "src": "https://example.test/stream.m3u8",
                "isLive": true,
                "mime": oversized_mime,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(bad_mime.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn receiver_http_play_drops_bad_advisory_fields_instead_of_rejecting() {
        let server = start_test_server().await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let response = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({
                "v": PROTOCOL_VERSION,
                "src": "https://example.test/stream.m3u8",
                "mime": "application/vnd.apple.mpegurl",
                "isLive": true,
                "resumeSeconds": -5.0,
                "logo": "not-a-url",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let play_events = server.collector.play.lock().unwrap();
        let descriptor = &play_events.last().unwrap()["descriptor"];
        assert!(descriptor["resumeSeconds"].is_null());
        assert!(descriptor["logo"].is_null());
    }

    #[tokio::test]
    async fn receiver_http_play_authenticates_before_parsing_the_body() {
        let server = start_test_server().await;

        let response = server
            .client
            .post(format!("{}/play", server.base_url))
            .header("X-XT-Key", "not-a-real-key")
            .body("not json")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // ---------------------------------------------------------------------
    // Ambient manifest push
    // ---------------------------------------------------------------------

    fn ambient_entry(overrides: impl FnOnce(&mut AmbientPushEntry)) -> AmbientPushEntry {
        let mut entry = AmbientPushEntry {
            kind: "vod".to_string(),
            id: "1".to_string(),
            title: "Some Movie".to_string(),
            poster_url: Some("https://example.test/poster.jpg".to_string()),
            backdrop_url: None,
            logo_url: None,
            tier: "catalog".to_string(),
        };
        overrides(&mut entry);
        entry
    }

    #[test]
    fn sanitize_ambient_entry_keeps_a_valid_entry() {
        let sanitized = sanitize_ambient_entry(ambient_entry(|_| {}));
        assert!(sanitized.is_some());
    }

    #[test]
    fn sanitize_ambient_entry_drops_an_unknown_kind() {
        assert!(sanitize_ambient_entry(ambient_entry(|entry| entry.kind = "channel".to_string())).is_none());
    }

    #[test]
    fn sanitize_ambient_entry_drops_a_blank_title() {
        assert!(sanitize_ambient_entry(ambient_entry(|entry| entry.title = "   ".to_string())).is_none());
    }

    #[test]
    fn sanitize_ambient_entry_drops_a_blank_id() {
        assert!(sanitize_ambient_entry(ambient_entry(|entry| entry.id = "".to_string())).is_none());
    }

    #[test]
    fn sanitize_ambient_entry_nulls_a_non_http_url_but_keeps_the_entry_alive_with_another() {
        let sanitized = sanitize_ambient_entry(ambient_entry(|entry| {
            entry.poster_url = Some("javascript:alert(1)".to_string());
            entry.backdrop_url = Some("https://example.test/backdrop.jpg".to_string());
        }))
        .unwrap();
        assert!(sanitized.poster_url.is_none());
        assert_eq!(sanitized.backdrop_url, Some("https://example.test/backdrop.jpg".to_string()));
    }

    #[test]
    fn sanitize_ambient_entry_drops_when_every_url_fails_sanitization() {
        let dropped = sanitize_ambient_entry(ambient_entry(|entry| entry.poster_url = Some("not-a-url".to_string())));
        assert!(dropped.is_none());
    }

    #[test]
    fn sanitize_ambient_entry_drops_an_oversized_url() {
        let oversized = format!("https://example.test/{}", "a".repeat(MAX_URL_LEN));
        let dropped = sanitize_ambient_entry(ambient_entry(|entry| entry.poster_url = Some(oversized)));
        assert!(dropped.is_none());
    }

    #[test]
    fn sanitize_ambient_entry_falls_back_to_catalog_tier_for_an_unknown_tier() {
        let sanitized = sanitize_ambient_entry(ambient_entry(|entry| entry.tier = "trending".to_string())).unwrap();
        assert_eq!(sanitized.tier, "catalog");
    }

    #[test]
    fn sanitize_ambient_entry_keeps_every_known_tier() {
        for tier in ALLOWED_AMBIENT_TIERS {
            let sanitized = sanitize_ambient_entry(ambient_entry(|entry| entry.tier = tier.to_string())).unwrap();
            assert_eq!(sanitized.tier, tier);
        }
    }

    #[tokio::test]
    async fn receiver_http_ambient_requires_auth() {
        let server = start_test_server().await;
        let response = server
            .client
            .post(format!("{}/ambient", server.base_url))
            .json(&json!({"v": PROTOCOL_VERSION, "entries": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn receiver_http_ambient_rejects_the_wrong_protocol_version() {
        let server = start_test_server().await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let response = server
            .client
            .post(format!("{}/ambient", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"v": 2, "entries": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body, json!({"error": "unsupportedVersion", "supported": PROTOCOL_VERSION}));
    }

    #[tokio::test]
    async fn receiver_http_ambient_accepts_a_manifest_and_emits_the_sanitized_entries() {
        let server = start_test_server().await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let response = server
            .client
            .post(format!("{}/ambient", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({
                "v": PROTOCOL_VERSION,
                "entries": [
                    {
                        "kind": "vod",
                        "id": "1",
                        "title": "Some Movie",
                        "posterUrl": "https://example.test/poster.jpg",
                        "tier": "recent",
                    },
                    {
                        "kind": "unknown-kind",
                        "id": "2",
                        "title": "Dropped",
                        "posterUrl": "https://example.test/poster2.jpg",
                        "tier": "recent",
                    },
                ],
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["accepted"], 1);

        let ambient_events = server.collector.ambient.lock().unwrap();
        let entries = ambient_events.last().unwrap()["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["id"], "1");
    }

    #[tokio::test]
    async fn receiver_http_ambient_truncates_a_manifest_over_the_entry_cap() {
        let server = start_test_server().await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let entries: Vec<Value> = (0..(MAX_AMBIENT_ENTRIES + 10))
            .map(|index| {
                json!({
                    "kind": "vod",
                    "id": index.to_string(),
                    "title": format!("Movie {index}"),
                    "posterUrl": "https://example.test/poster.jpg",
                    "tier": "catalog",
                })
            })
            .collect();

        let response = server
            .client
            .post(format!("{}/ambient", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"v": PROTOCOL_VERSION, "entries": entries}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["accepted"], MAX_AMBIENT_ENTRIES);
    }

    #[tokio::test]
    async fn receiver_http_rejects_invalid_seek_requests() {
        let server = start_test_server().await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let nan_seek = server
            .client
            .post(format!("{}/seek", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"seconds": f64::NAN}))
            .send()
            .await
            .unwrap();
        assert_eq!(nan_seek.status(), StatusCode::BAD_REQUEST);

        let negative_seek = server
            .client
            .post(format!("{}/seek", server.base_url))
            .header("X-XT-Key", &key)
            .json(&json!({"seconds": -1.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(negative_seek.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn receiver_http_logs_requires_auth() {
        let server = start_test_server().await;
        let response = server.client.get(format!("{}/logs", server.base_url)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn receiver_http_logs_returns_empty_body_when_log_dir_is_missing() {
        let server = start_test_server().await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let response = server.client.get(format!("{}/logs", server.base_url)).header("X-XT-Key", &key).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "");
    }

    #[tokio::test]
    async fn receiver_http_logs_returns_the_newest_log_file_tail() {
        let log_dir = std::env::temp_dir().join(format!("xt-receiver-test-logs-{}", generate_device_key()));
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("app-2026-01-01.log"), "stale entry\n").unwrap();
        std::fs::write(log_dir.join("not-a-log.txt"), "should never appear\n").unwrap();
        // Newest-file selection is by mtime; the sleep keeps write order unambiguous on any filesystem clock.
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(log_dir.join("app-2026-01-02.log"), "line one\nline two\n").unwrap();

        let server = start_test_server_with_log_dir(log_dir).await;
        let code = server.shared.pairing.lock().unwrap().as_ref().unwrap().code.clone();
        let key = server.pair(&code, "Test device").await.json::<Value>().await.unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();

        let response = server.client.get(format!("{}/logs", server.base_url)).header("X-XT-Key", &key).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "line one\nline two\n");
    }

    #[test]
    fn tail_as_utf8_returns_the_whole_input_when_under_the_cap() {
        assert_eq!(tail_as_utf8(b"hello world", 1024), "hello world");
    }

    #[test]
    fn tail_as_utf8_caps_and_starts_on_a_whole_line() {
        let bytes = b"AAAAAAAAAA\nBBBBBBBBBB\nCCCCCCCCCC\n";
        assert_eq!(tail_as_utf8(bytes, 15), "CCCCCCCCCC\n");
    }

    #[test]
    fn evict_oldest_if_over_capacity_keeps_at_most_max_devices() {
        let mut devices: Vec<PairedDevice> = Vec::new();
        let total = receiver_store::MAX_PAIRED_DEVICES + 3;
        for index in 0..total {
            devices.push(PairedDevice {
                key: format!("{index:032x}"),
                device_name: format!("device-{index}"),
                created_at: format!("2026-01-01T00:{index:02}:00+00:00"),
            });
            evict_oldest_if_over_capacity(&mut devices);
        }
        assert_eq!(devices.len(), receiver_store::MAX_PAIRED_DEVICES);
        assert!(!devices.iter().any(|device| device.device_name == "device-0"));
    }
}

