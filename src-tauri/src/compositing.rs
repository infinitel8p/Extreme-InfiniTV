// Linux WebKitGTK DMA-BUF rendering safe mode: per-hardware workaround; see initialize().

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

const SETTING_FILE_NAME: &str = "compositing.json";
const DISABLE_DMABUF_RENDERER_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const FORCE_SHM_VAR: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";
const NV_EXPLICIT_SYNC_VAR: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const VM_MARKERS: [&str; 7] = ["qemu", "kvm", "vmware", "virtualbox", "innotek", "bochs", "parallels"];

/// WebKitGTK's runtime version, via `webkit_get_{major,minor,micro}_version()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebKitVersion {
    major: u32,
    minor: u32,
    micro: u32,
}

impl WebKitVersion {
    fn at_least(self, major: u32, minor: u32) -> bool {
        (self.major, self.minor) >= (major, minor)
    }

    fn as_string(self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.micro)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskyHardware {
    RaspberryPi,
    Nvidia,
    Vm,
    AppImage,
}

impl RiskyHardware {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskyHardware::RaspberryPi => "raspberry-pi",
            RiskyHardware::Nvidia => "nvidia",
            RiskyHardware::Vm => "vm",
            RiskyHardware::AppImage => "appimage",
        }
    }
}

// WEBKIT_DISABLE_DMABUF_RENDERER=1 segfaults on navigation on Raspberry Pi /
// WebKitGTK 2.52 (AcceleratedBackingStore::update); FORCE_SHM is the proven fix there.
// 2.44 dropped the legacy renderers, so DisableDmabuf nulls the backing store from there on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SafeModeVar {
    ForceShm,
    DisableDmabuf,
}

impl SafeModeVar {
    fn env_name(self) -> &'static str {
        match self {
            SafeModeVar::ForceShm => FORCE_SHM_VAR,
            SafeModeVar::DisableDmabuf => DISABLE_DMABUF_RENDERER_VAR,
        }
    }
}

fn safe_mode_var_for(detection: Option<RiskyHardware>, webkit_version: Option<WebKitVersion>) -> SafeModeVar {
    // Unknown version is treated as modern: every build we ship links >= 2.44.
    let pre_2_44 = webkit_version.is_some_and(|version| !version.at_least(2, 44));
    if pre_2_44 {
        match detection {
            Some(RiskyHardware::Nvidia) | Some(RiskyHardware::Vm) => SafeModeVar::DisableDmabuf,
            _ => SafeModeVar::ForceShm,
        }
    } else {
        SafeModeVar::ForceShm
    }
}

// Below 2.54 a null backing store crashes on the first view transition (WebKit bug 321683).
fn should_disable_view_transitions(webkit_version: Option<WebKitVersion>) -> bool {
    !webkit_version.is_some_and(|version| version.at_least(2, 54))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StartupState {
    detection: Option<RiskyHardware>,
    active: &'static str,
    env_override: bool,
    trial_active: bool,
    webkit_version: Option<WebKitVersion>,
    view_transitions_disabled: bool,
}

/// Result of `compute_startup_decision`: the state to report, the setting to
/// persist (if any), and which WebKit variable (if any) this session must set.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StartupDecision {
    state: StartupState,
    persist: Option<&'static str>,
    env_var_to_set: Option<SafeModeVar>,
    extra_env: Vec<(&'static str, &'static str)>,
}

static STARTUP_STATE: OnceLock<StartupState> = OnceLock::new();

// ---------------------------------------------------------------------------
// Hardware detection (pure classifier, unit-tested)
// ---------------------------------------------------------------------------

fn contains_vm_marker(value: &str) -> bool {
    let lowered = value.to_lowercase();
    VM_MARKERS.iter().any(|marker| lowered.contains(marker)) || lowered.contains("virtual machine")
}

pub fn classify_hardware(
    device_tree_model: Option<&str>,
    nvidia_proprietary_present: bool,
    dmi_sys_vendor: Option<&str>,
    dmi_product_name: Option<&str>,
    appimage_present: bool,
) -> Option<RiskyHardware> {
    if device_tree_model.is_some_and(|model| model.contains("Raspberry Pi")) {
        return Some(RiskyHardware::RaspberryPi);
    }
    if nvidia_proprietary_present {
        return Some(RiskyHardware::Nvidia);
    }
    if dmi_sys_vendor.is_some_and(contains_vm_marker) || dmi_product_name.is_some_and(contains_vm_marker) {
        return Some(RiskyHardware::Vm);
    }
    if appimage_present {
        return Some(RiskyHardware::AppImage);
    }
    None
}

#[cfg(target_os = "linux")]
fn read_device_tree_model() -> Option<String> {
    let bytes = std::fs::read("/proc/device-tree/model").ok()?;
    Some(String::from_utf8_lossy(&bytes).trim_end_matches('\0').to_string())
}

#[cfg(target_os = "linux")]
fn detect_hardware() -> Option<RiskyHardware> {
    let device_tree_model = read_device_tree_model();
    let nvidia_present = Path::new("/proc/driver/nvidia/version").exists();
    let sys_vendor = std::fs::read_to_string("/sys/class/dmi/id/sys_vendor").ok();
    let product_name = std::fs::read_to_string("/sys/class/dmi/id/product_name").ok();
    let appimage_present = std::env::var_os("APPIMAGE").is_some();
    classify_hardware(
        device_tree_model.as_deref(),
        nvidia_present,
        sys_vendor.as_deref().map(str::trim),
        product_name.as_deref().map(str::trim),
        appimage_present,
    )
}

// webkit2gtk-sys has no cargo feature gate on these; always present.
#[cfg(target_os = "linux")]
fn read_webkit_version() -> WebKitVersion {
    unsafe {
        WebKitVersion {
            major: webkit2gtk::ffi::webkit_get_major_version(),
            minor: webkit2gtk::ffi::webkit_get_minor_version(),
            micro: webkit2gtk::ffi::webkit_get_micro_version(),
        }
    }
}

// ---------------------------------------------------------------------------
// Setting file (pure parse/validate, unit-tested)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct CompositingFile {
    setting: String,
}

fn is_valid_setting(value: &str) -> bool {
    matches!(value, "auto" | "fast" | "safe" | "fast-trial")
}

fn settings_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTING_FILE_NAME)
}

fn parse_setting_file(contents: &str) -> String {
    match serde_json::from_str::<CompositingFile>(contents) {
        Ok(file) if is_valid_setting(&file.setting) => file.setting,
        _ => "auto".to_string(),
    }
}

fn read_setting(config_dir: &Path) -> String {
    match std::fs::read_to_string(settings_file_path(config_dir)) {
        Ok(contents) => parse_setting_file(&contents),
        Err(_) => "auto".to_string(),
    }
}

fn write_setting(config_dir: &Path, setting: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let contents = serde_json::to_string(&CompositingFile { setting: setting.to_string() })
        .unwrap_or_else(|_| format!(r#"{{"setting":"{setting}"}}"#));
    std::fs::write(settings_file_path(config_dir), contents)
}

// Mirrors dirs::config_dir() (tauri's app_config_dir) since no AppHandle exists yet.
#[cfg(target_os = "linux")]
fn startup_config_dir(identifier: &str) -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let base = xdg.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join(identifier))
}

// ---------------------------------------------------------------------------
// Startup resolution
// ---------------------------------------------------------------------------

fn env_var_active_mode(value: &str) -> &'static str {
    let normalized = value.trim();
    if normalized.is_empty() || normalized == "0" || normalized.eq_ignore_ascii_case("false") {
        "fast"
    } else {
        "safe"
    }
}

// DISABLE_DMABUF takes precedence when both are set; either alone still decides.
fn env_override_active_mode(disable_dmabuf: Option<&str>, force_shm: Option<&str>) -> &'static str {
    if let Some(value) = disable_dmabuf {
        return env_var_active_mode(value);
    }
    if let Some(value) = force_shm {
        return env_var_active_mode(value);
    }
    "fast"
}

/// Pure startup decision: state to report, setting to persist, and which WebKit var (if any) to force.
fn compute_startup_decision(
    raw_file_contents: Option<&str>,
    cli_safe_flag: bool,
    disable_dmabuf_env: Option<&str>,
    force_shm_env: Option<&str>,
    detection: Option<RiskyHardware>,
    webkit_version: Option<WebKitVersion>,
    nv_explicit_sync_already_set: bool,
) -> StartupDecision {
    let persist = if cli_safe_flag { Some("safe") } else { None };
    let view_transitions_disabled = should_disable_view_transitions(webkit_version);
    let mut extra_env = Vec::new();
    if detection == Some(RiskyHardware::Nvidia) && !nv_explicit_sync_already_set {
        extra_env.push((NV_EXPLICIT_SYNC_VAR, "1"));
    }

    if disable_dmabuf_env.is_some() || force_shm_env.is_some() {
        let active = env_override_active_mode(disable_dmabuf_env, force_shm_env);
        return StartupDecision {
            state: StartupState {
                detection,
                active,
                env_override: true,
                trial_active: false,
                webkit_version,
                view_transitions_disabled,
            },
            persist,
            env_var_to_set: None,
            extra_env,
        };
    }

    let file_setting = if cli_safe_flag {
        "safe".to_string()
    } else {
        raw_file_contents.map(parse_setting_file).unwrap_or_else(|| "auto".to_string())
    };

    let (state, persist) = match file_setting.as_str() {
        "safe" => (
            StartupState {
                detection,
                active: "safe",
                env_override: false,
                trial_active: false,
                webkit_version,
                view_transitions_disabled,
            },
            persist,
        ),
        "fast" => (
            StartupState {
                detection,
                active: "fast",
                env_override: false,
                trial_active: false,
                webkit_version,
                view_transitions_disabled,
            },
            persist,
        ),
        // Self-healing revert: only a later explicit "fast" write makes this permanent.
        "fast-trial" => (
            StartupState {
                detection,
                active: "fast",
                env_override: false,
                trial_active: true,
                webkit_version,
                view_transitions_disabled,
            },
            Some("auto"),
        ),
        _ => {
            let active = if detection.is_some() { "safe" } else { "fast" };
            (
                StartupState { detection, active, env_override: false, trial_active: false, webkit_version, view_transitions_disabled },
                persist,
            )
        }
    };

    let env_var_to_set =
        if state.active == "safe" { Some(safe_mode_var_for(detection, webkit_version)) } else { None };

    StartupDecision { state, persist, env_var_to_set, extra_env }
}

#[cfg(target_os = "linux")]
fn compute_startup_state(identifier: &str) -> StartupState {
    let config_dir = startup_config_dir(identifier);
    let cli_safe_flag = std::env::args().any(|arg| arg == "--safe-rendering");
    let disable_dmabuf_env = std::env::var(DISABLE_DMABUF_RENDERER_VAR).ok();
    let force_shm_env = std::env::var(FORCE_SHM_VAR).ok();
    let detection = detect_hardware();
    let webkit_version = Some(read_webkit_version());
    let nv_explicit_sync_already_set = std::env::var_os(NV_EXPLICIT_SYNC_VAR).is_some();
    let raw_file_contents = config_dir
        .as_deref()
        .and_then(|dir| std::fs::read_to_string(settings_file_path(dir)).ok());

    let decision = compute_startup_decision(
        raw_file_contents.as_deref(),
        cli_safe_flag,
        disable_dmabuf_env.as_deref(),
        force_shm_env.as_deref(),
        detection,
        webkit_version,
        nv_explicit_sync_already_set,
    );

    // No resolvable config dir means no setting file to write either.
    if let (Some(setting), Some(dir)) = (decision.persist, config_dir.as_deref()) {
        let _ = write_setting(dir, setting);
    }
    if let Some(var) = decision.env_var_to_set {
        std::env::set_var(var.env_name(), "1");
    }
    for (key, value) in &decision.extra_env {
        std::env::set_var(key, value);
    }

    decision.state
}

#[cfg(not(target_os = "linux"))]
fn compute_startup_state(_identifier: &str) -> StartupState {
    StartupState {
        detection: None,
        active: "fast",
        env_override: false,
        trial_active: false,
        webkit_version: None,
        view_transitions_disabled: false,
    }
}

/// Must run before `tauri::Builder`: the main window predates `setup()`.
pub fn initialize(identifier: &str) {
    let state = compute_startup_state(identifier);
    let _ = STARTUP_STATE.set(state);
}

pub fn view_transitions_disabled() -> bool {
    STARTUP_STATE.get().map(|state| state.view_transitions_disabled).unwrap_or(true)
}

// ---------------------------------------------------------------------------
// WebKit feature toggling (Linux)
// ---------------------------------------------------------------------------

// Hand-declared: webkit2gtk 2.0.2 has no bindings for the 2.42+ Feature API.
#[cfg(target_os = "linux")]
mod webkit_feature_ffi {
    use std::os::raw::c_char;
    use webkit2gtk::ffi::WebKitSettings;

    #[repr(C)]
    pub struct WebKitFeatureList {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct WebKitFeature {
        _private: [u8; 0],
    }

    extern "C" {
        pub fn webkit_settings_get_all_features() -> *mut WebKitFeatureList;
        pub fn webkit_feature_list_get_length(list: *mut WebKitFeatureList) -> usize;
        pub fn webkit_feature_list_get(list: *mut WebKitFeatureList, index: usize) -> *mut WebKitFeature;
        pub fn webkit_feature_list_unref(list: *mut WebKitFeatureList);
        pub fn webkit_feature_get_identifier(feature: *mut WebKitFeature) -> *const c_char;
        pub fn webkit_settings_set_feature_enabled(
            settings: *mut WebKitSettings,
            feature: *mut WebKitFeature,
            enabled: i32,
        );
    }
}

// Only called when webkit_version >= 2.42, the release that introduced this API.
#[cfg(target_os = "linux")]
pub fn apply_webview_features(webview: &webkit2gtk::WebView) {
    use webkit2gtk::glib::translate::ToGlibPtr;
    use webkit2gtk::WebViewExt;

    if !view_transitions_disabled() {
        return;
    }
    let webkit_version = STARTUP_STATE.get().and_then(|state| state.webkit_version);
    if !webkit_version.is_some_and(|version| version.at_least(2, 42)) {
        return;
    }
    let version_label = webkit_version.map(WebKitVersion::as_string).unwrap_or_else(|| "unknown".to_string());

    let Some(settings) = webview.settings() else {
        log::warn!("[compositing] WebKitGTK {version_label}: webview has no WebKitSettings");
        return;
    };

    let mut disabled_ids = Vec::new();
    unsafe {
        let settings_ptr = settings.to_glib_none().0;
        let feature_list = webkit_feature_ffi::webkit_settings_get_all_features();
        if feature_list.is_null() {
            log::warn!("[compositing] WebKitGTK {version_label}: webkit_settings_get_all_features returned null");
            return;
        }
        let length = webkit_feature_ffi::webkit_feature_list_get_length(feature_list);
        for index in 0..length {
            let feature = webkit_feature_ffi::webkit_feature_list_get(feature_list, index);
            if feature.is_null() {
                continue;
            }
            let identifier_ptr = webkit_feature_ffi::webkit_feature_get_identifier(feature);
            if identifier_ptr.is_null() {
                continue;
            }
            let identifier = std::ffi::CStr::from_ptr(identifier_ptr).to_string_lossy();
            if identifier == "ViewTransitions" || identifier == "CrossDocumentViewTransitions" {
                webkit_feature_ffi::webkit_settings_set_feature_enabled(settings_ptr, feature, 0);
                disabled_ids.push(identifier.into_owned());
            }
        }
        webkit_feature_ffi::webkit_feature_list_unref(feature_list);
    }

    if disabled_ids.is_empty() {
        log::warn!("[compositing] WebKitGTK {version_label}: no view-transition feature identifiers found");
    } else {
        log::info!(
            "[compositing] WebKitGTK {version_label}: view transitions disabled ({})",
            disabled_ids.join(", ")
        );
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn compositing_state(app: tauri::AppHandle) -> Value {
    #[cfg(target_os = "linux")]
    {
        let stashed = STARTUP_STATE.get();
        let setting = app
            .path()
            .app_config_dir()
            .map(|config_dir| read_setting(&config_dir))
            .unwrap_or_else(|_| "auto".to_string());
        return json!({
            "platformSupported": true,
            "detection": stashed.and_then(|state| state.detection).map(RiskyHardware::as_str),
            "setting": setting,
            "active": stashed.map(|state| state.active).unwrap_or("fast"),
            "envOverride": stashed.map(|state| state.env_override).unwrap_or(false),
            "trialActive": stashed.map(|state| state.trial_active).unwrap_or(false),
            "webkitVersion": stashed.and_then(|state| state.webkit_version).map(WebKitVersion::as_string),
            "viewTransitionsDisabled": stashed.map(|state| state.view_transitions_disabled).unwrap_or(true),
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        json!({
            "platformSupported": false,
            "detection": Value::Null,
            "setting": "auto",
            "active": "fast",
            "envOverride": false,
            "trialActive": false,
            "webkitVersion": Value::Null,
            "viewTransitionsDisabled": false,
        })
    }
}

#[tauri::command]
pub fn compositing_set(app: tauri::AppHandle, setting: String) -> Result<(), String> {
    if !is_valid_setting(&setting) {
        return Err(format!("OTHER:invalid compositing setting '{setting}'"));
    }
    let config_dir = app.path().app_config_dir().map_err(|error| format!("OTHER:{error}"))?;
    write_setting(&config_dir, &setting).map_err(|error| format!("OTHER:{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_hardware_detects_raspberry_pi_from_device_tree_model() {
        let result = classify_hardware(Some("Raspberry Pi 4 Model B Rev 1.4"), false, None, None, false);
        assert_eq!(result, Some(RiskyHardware::RaspberryPi));
    }

    #[test]
    fn classify_hardware_detects_nvidia_proprietary() {
        let result = classify_hardware(None, true, None, None, false);
        assert_eq!(result, Some(RiskyHardware::Nvidia));
    }

    #[test]
    fn classify_hardware_detects_vm_from_sys_vendor() {
        let result = classify_hardware(None, false, Some("QEMU"), None, false);
        assert_eq!(result, Some(RiskyHardware::Vm));
    }

    #[test]
    fn classify_hardware_detects_vm_from_product_name_case_insensitively() {
        let result = classify_hardware(None, false, None, Some("virtualbox"), false);
        assert_eq!(result, Some(RiskyHardware::Vm));
    }

    #[test]
    fn classify_hardware_detects_hyper_v_virtual_machine_phrase() {
        let result = classify_hardware(None, false, Some("Microsoft Corporation"), Some("Virtual Machine"), false);
        assert_eq!(result, Some(RiskyHardware::Vm));
    }

    #[test]
    fn classify_hardware_prioritizes_raspberry_pi_over_other_signals() {
        let result = classify_hardware(Some("Raspberry Pi 3"), true, Some("QEMU"), None, true);
        assert_eq!(result, Some(RiskyHardware::RaspberryPi));
    }

    #[test]
    fn classify_hardware_returns_none_for_ordinary_hardware() {
        let result = classify_hardware(None, false, Some("Dell Inc."), Some("XPS 13"), false);
        assert_eq!(result, None);
    }

    #[test]
    fn classify_hardware_detects_appimage_only_without_other_signals() {
        let result = classify_hardware(None, false, None, None, true);
        assert_eq!(result, Some(RiskyHardware::AppImage));
    }

    #[test]
    fn classify_hardware_prioritizes_nvidia_and_vm_over_appimage() {
        assert_eq!(classify_hardware(None, true, None, None, true), Some(RiskyHardware::Nvidia));
        assert_eq!(classify_hardware(None, false, Some("QEMU"), None, true), Some(RiskyHardware::Vm));
    }

    #[test]
    fn env_var_active_mode_treats_zero_and_empty_as_fast() {
        assert_eq!(env_var_active_mode(""), "fast");
        assert_eq!(env_var_active_mode("0"), "fast");
        assert_eq!(env_var_active_mode("false"), "fast");
        assert_eq!(env_var_active_mode("FALSE"), "fast");
    }

    #[test]
    fn env_var_active_mode_treats_any_other_value_as_safe() {
        assert_eq!(env_var_active_mode("1"), "safe");
        assert_eq!(env_var_active_mode("true"), "safe");
        assert_eq!(env_var_active_mode("yes"), "safe");
    }

    #[test]
    fn env_override_active_mode_prefers_disable_dmabuf_when_both_are_set() {
        assert_eq!(env_override_active_mode(Some("0"), Some("1")), "fast");
        assert_eq!(env_override_active_mode(Some("1"), Some("0")), "safe");
    }

    #[test]
    fn env_override_active_mode_falls_back_to_force_shm_alone() {
        assert_eq!(env_override_active_mode(None, Some("1")), "safe");
        assert_eq!(env_override_active_mode(None, Some("0")), "fast");
    }

    #[test]
    fn env_override_active_mode_is_fast_when_neither_is_set() {
        assert_eq!(env_override_active_mode(None, None), "fast");
    }

    fn wk(major: u32, minor: u32, micro: u32) -> WebKitVersion {
        WebKitVersion { major, minor, micro }
    }

    #[test]
    fn webkit_version_at_least_compares_major_then_minor() {
        assert!(wk(2, 52, 6).at_least(2, 44));
        assert!(wk(3, 0, 0).at_least(2, 54));
        assert!(!wk(2, 40, 0).at_least(2, 44));
    }

    #[test]
    fn webkit_version_as_string_formats_dotted() {
        assert_eq!(wk(2, 52, 6).as_string(), "2.52.6");
    }

    #[test]
    fn should_disable_view_transitions_gates_on_2_54() {
        assert!(should_disable_view_transitions(Some(wk(2, 52, 6))));
        assert!(!should_disable_view_transitions(Some(wk(2, 54, 0))));
        assert!(should_disable_view_transitions(Some(wk(2, 53, 92))));
        assert!(should_disable_view_transitions(None));
        assert!(!should_disable_view_transitions(Some(wk(3, 0, 0))));
    }

    #[test]
    fn safe_mode_var_for_raspberry_pi_is_force_shm() {
        assert_eq!(safe_mode_var_for(Some(RiskyHardware::RaspberryPi), None), SafeModeVar::ForceShm);
    }

    #[test]
    fn safe_mode_var_for_nvidia_and_vm_is_disable_dmabuf_below_2_44() {
        let pre_2_44 = Some(wk(2, 40, 0));
        assert_eq!(safe_mode_var_for(Some(RiskyHardware::Nvidia), pre_2_44), SafeModeVar::DisableDmabuf);
        assert_eq!(safe_mode_var_for(Some(RiskyHardware::Vm), pre_2_44), SafeModeVar::DisableDmabuf);
    }

    #[test]
    fn safe_mode_var_for_nvidia_and_vm_is_force_shm_at_2_44_and_above() {
        let modern = Some(wk(2, 44, 0));
        assert_eq!(safe_mode_var_for(Some(RiskyHardware::Nvidia), modern), SafeModeVar::ForceShm);
        assert_eq!(safe_mode_var_for(Some(RiskyHardware::Vm), modern), SafeModeVar::ForceShm);
    }

    #[test]
    fn safe_mode_var_for_unknown_version_is_force_shm_for_nvidia() {
        assert_eq!(safe_mode_var_for(Some(RiskyHardware::Nvidia), None), SafeModeVar::ForceShm);
    }

    #[test]
    fn safe_mode_var_for_no_detection_is_force_shm() {
        assert_eq!(safe_mode_var_for(None, None), SafeModeVar::ForceShm);
    }

    #[test]
    fn is_valid_setting_accepts_known_values_only() {
        assert!(is_valid_setting("auto"));
        assert!(is_valid_setting("fast"));
        assert!(is_valid_setting("safe"));
        assert!(is_valid_setting("fast-trial"));
        assert!(!is_valid_setting("off"));
        assert!(!is_valid_setting(""));
    }

    #[test]
    fn parse_setting_file_reads_a_valid_setting() {
        assert_eq!(parse_setting_file(r#"{"setting":"safe"}"#), "safe");
    }

    #[test]
    fn parse_setting_file_falls_back_to_auto_for_unknown_value() {
        assert_eq!(parse_setting_file(r#"{"setting":"nonsense"}"#), "auto");
    }

    #[test]
    fn parse_setting_file_falls_back_to_auto_for_corrupt_json() {
        assert_eq!(parse_setting_file("not json"), "auto");
        assert_eq!(parse_setting_file(""), "auto");
    }

    fn state(active: &'static str, env_override: bool, trial_active: bool) -> StartupState {
        state_with_detection(None, active, env_override, trial_active)
    }

    fn state_with_detection(
        detection: Option<RiskyHardware>,
        active: &'static str,
        env_override: bool,
        trial_active: bool,
    ) -> StartupState {
        StartupState { detection, active, env_override, trial_active, webkit_version: None, view_transitions_disabled: true }
    }

    #[test]
    fn decision_env_override_truthy_disable_dmabuf_forces_safe() {
        let decision = compute_startup_decision(None, false, Some("1"), None, None, None, false);
        assert_eq!(decision.state, state("safe", true, false));
        assert_eq!(decision.persist, None);
        assert_eq!(decision.env_var_to_set, None);
    }

    #[test]
    fn decision_env_override_falsy_disable_dmabuf_forces_fast() {
        let decision = compute_startup_decision(None, false, Some("0"), None, None, None, false);
        assert_eq!(decision.state, state("fast", true, false));
        assert_eq!(decision.persist, None);
    }

    #[test]
    fn decision_env_override_truthy_force_shm_forces_safe() {
        let decision = compute_startup_decision(None, false, None, Some("1"), None, None, false);
        assert_eq!(decision.state, state("safe", true, false));
        assert_eq!(decision.env_var_to_set, None);
    }

    #[test]
    fn decision_env_override_wins_over_cli_flag_but_the_write_still_persists() {
        let decision = compute_startup_decision(None, true, Some("0"), None, None, None, false);
        assert_eq!(decision.state, state("fast", true, false));
        assert_eq!(decision.persist, Some("safe"));
    }

    #[test]
    fn decision_cli_flag_forces_safe_and_persists_it_with_force_shm() {
        let decision = compute_startup_decision(None, true, None, None, None, None, false);
        assert_eq!(decision.state, state("safe", false, false));
        assert_eq!(decision.persist, Some("safe"));
        assert_eq!(decision.env_var_to_set, Some(SafeModeVar::ForceShm));
    }

    #[test]
    fn decision_setting_safe_without_detection_uses_force_shm() {
        let decision = compute_startup_decision(Some(r#"{"setting":"safe"}"#), false, None, None, None, None, false);
        assert_eq!(decision.state, state("safe", false, false));
        assert_eq!(decision.env_var_to_set, Some(SafeModeVar::ForceShm));
    }

    #[test]
    fn decision_setting_fast_is_active_fast_even_with_detection() {
        let decision = compute_startup_decision(
            Some(r#"{"setting":"fast"}"#),
            false,
            None,
            None,
            Some(RiskyHardware::RaspberryPi),
            None,
            false,
        );
        assert_eq!(decision.state.active, "fast");
        assert!(!decision.state.trial_active);
        assert_eq!(decision.persist, None);
        assert_eq!(decision.env_var_to_set, None);
    }

    #[test]
    fn decision_setting_fast_trial_runs_fast_and_persists_auto() {
        let decision = compute_startup_decision(Some(r#"{"setting":"fast-trial"}"#), false, None, None, None, None, false);
        assert_eq!(decision.state, state("fast", false, true));
        assert_eq!(decision.persist, Some("auto"));
        assert_eq!(decision.env_var_to_set, None);
    }

    #[test]
    fn decision_corrupt_file_behaves_like_auto_with_nvidia_detection_below_2_44() {
        let pre_2_44 = Some(wk(2, 40, 0));
        let decision = compute_startup_decision(
            Some("not json"),
            false,
            None,
            None,
            Some(RiskyHardware::Nvidia),
            pre_2_44,
            true,
        );
        assert_eq!(
            decision.state,
            StartupState {
                detection: Some(RiskyHardware::Nvidia),
                active: "safe",
                env_override: false,
                trial_active: false,
                webkit_version: pre_2_44,
                view_transitions_disabled: true,
            }
        );
        assert_eq!(decision.persist, None);
        assert_eq!(decision.env_var_to_set, Some(SafeModeVar::DisableDmabuf));
    }

    #[test]
    fn decision_missing_file_with_raspberry_pi_detection_uses_force_shm() {
        let decision =
            compute_startup_decision(None, false, None, None, Some(RiskyHardware::RaspberryPi), None, false);
        assert_eq!(
            decision.state,
            state_with_detection(Some(RiskyHardware::RaspberryPi), "safe", false, false)
        );
        assert_eq!(decision.env_var_to_set, Some(SafeModeVar::ForceShm));
    }

    #[test]
    fn decision_missing_file_with_vm_detection_uses_disable_dmabuf_below_2_44() {
        let pre_2_44 = Some(wk(2, 40, 0));
        let decision =
            compute_startup_decision(None, false, None, None, Some(RiskyHardware::Vm), pre_2_44, true);
        assert_eq!(
            decision.state,
            StartupState {
                detection: Some(RiskyHardware::Vm),
                active: "safe",
                env_override: false,
                trial_active: false,
                webkit_version: pre_2_44,
                view_transitions_disabled: true,
            }
        );
        assert_eq!(decision.env_var_to_set, Some(SafeModeVar::DisableDmabuf));
    }

    #[test]
    fn decision_missing_file_with_nvidia_and_vm_detection_uses_force_shm_at_2_44_and_above() {
        let modern = Some(wk(2, 44, 0));
        let nvidia = compute_startup_decision(None, false, None, None, Some(RiskyHardware::Nvidia), modern, true);
        assert_eq!(nvidia.env_var_to_set, Some(SafeModeVar::ForceShm));
        let vm = compute_startup_decision(None, false, None, None, Some(RiskyHardware::Vm), modern, true);
        assert_eq!(vm.env_var_to_set, Some(SafeModeVar::ForceShm));
    }

    #[test]
    fn decision_missing_file_without_detection_defaults_to_fast() {
        let decision = compute_startup_decision(None, false, None, None, None, None, false);
        assert_eq!(decision.state, state("fast", false, false));
        assert_eq!(decision.persist, None);
        assert_eq!(decision.env_var_to_set, None);
    }

    #[test]
    fn decision_nvidia_adds_explicit_sync_env_when_not_already_set() {
        let decision = compute_startup_decision(None, false, None, None, Some(RiskyHardware::Nvidia), None, false);
        assert_eq!(decision.extra_env, vec![(NV_EXPLICIT_SYNC_VAR, "1")]);
    }

    #[test]
    fn decision_nvidia_skips_explicit_sync_env_when_already_set() {
        let decision = compute_startup_decision(None, false, None, None, Some(RiskyHardware::Nvidia), None, true);
        assert!(decision.extra_env.is_empty());
    }

    #[test]
    fn decision_non_nvidia_never_adds_explicit_sync_env() {
        let decision = compute_startup_decision(None, false, None, None, Some(RiskyHardware::Vm), None, false);
        assert!(decision.extra_env.is_empty());
    }
}
