// Linux WebKitGTK DMA-BUF rendering safe-mode workaround; see initialize().

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

const SETTING_FILE_NAME: &str = "compositing.json";
const ENV_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const VM_MARKERS: [&str; 7] = ["qemu", "kvm", "vmware", "virtualbox", "innotek", "bochs", "parallels"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskyHardware {
    RaspberryPi,
    Nvidia,
    Vm,
}

impl RiskyHardware {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskyHardware::RaspberryPi => "raspberry-pi",
            RiskyHardware::Nvidia => "nvidia",
            RiskyHardware::Vm => "vm",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StartupState {
    detection: Option<RiskyHardware>,
    active: &'static str,
    env_override: bool,
    trial_active: bool,
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
    classify_hardware(
        device_tree_model.as_deref(),
        nvidia_present,
        sys_vendor.as_deref().map(str::trim),
        product_name.as_deref().map(str::trim),
    )
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

/// Pure startup state machine. `raw_file_contents` is the on-disk setting
/// file's text (`None` when missing/unreadable). Returns the resolved state
/// plus an optional new setting the caller should persist (e.g. the
/// `--safe-rendering` flag, or a consumed `fast-trial` reverting to `auto`).
fn compute_startup_decision(
    raw_file_contents: Option<&str>,
    cli_safe_flag: bool,
    env_value: Option<&str>,
    detection: Option<RiskyHardware>,
) -> (StartupState, Option<&'static str>) {
    let persist = if cli_safe_flag { Some("safe") } else { None };

    if let Some(value) = env_value {
        return (
            StartupState {
                detection,
                active: env_var_active_mode(value),
                env_override: true,
                trial_active: false,
            },
            persist,
        );
    }

    let file_setting = if cli_safe_flag {
        "safe".to_string()
    } else {
        raw_file_contents.map(parse_setting_file).unwrap_or_else(|| "auto".to_string())
    };

    match file_setting.as_str() {
        "safe" => (StartupState { detection, active: "safe", env_override: false, trial_active: false }, persist),
        "fast" => (StartupState { detection, active: "fast", env_override: false, trial_active: false }, persist),
        // Self-healing revert: only a later explicit "fast" write makes this permanent.
        "fast-trial" => (
            StartupState { detection, active: "fast", env_override: false, trial_active: true },
            Some("auto"),
        ),
        _ => {
            let active = if detection.is_some() { "safe" } else { "fast" };
            (StartupState { detection, active, env_override: false, trial_active: false }, persist)
        }
    }
}

#[cfg(target_os = "linux")]
fn compute_startup_state(identifier: &str) -> StartupState {
    let config_dir = startup_config_dir(identifier);
    let cli_safe_flag = std::env::args().any(|arg| arg == "--safe-rendering");
    let env_value = std::env::var(ENV_VAR).ok();
    let detection = detect_hardware();
    let raw_file_contents = config_dir
        .as_deref()
        .and_then(|dir| std::fs::read_to_string(settings_file_path(dir)).ok());

    let (state, persist) = compute_startup_decision(
        raw_file_contents.as_deref(),
        cli_safe_flag,
        env_value.as_deref(),
        detection,
    );

    // No resolvable config dir means no setting file to write either.
    if let (Some(setting), Some(dir)) = (persist, config_dir.as_deref()) {
        let _ = write_setting(dir, setting);
    }

    state
}

#[cfg(not(target_os = "linux"))]
fn compute_startup_state(_identifier: &str) -> StartupState {
    StartupState { detection: None, active: "fast", env_override: false, trial_active: false }
}

fn apply_env_for_active(state: &StartupState) {
    if state.env_override || state.active != "safe" {
        return;
    }
    std::env::set_var(ENV_VAR, "1");
}

/// Must run before `tauri::Builder`: the main window predates `setup()`.
pub fn initialize(identifier: &str) {
    let state = compute_startup_state(identifier);
    apply_env_for_active(&state);
    let _ = STARTUP_STATE.set(state);
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
        let result = classify_hardware(Some("Raspberry Pi 4 Model B Rev 1.4"), false, None, None);
        assert_eq!(result, Some(RiskyHardware::RaspberryPi));
    }

    #[test]
    fn classify_hardware_detects_nvidia_proprietary() {
        let result = classify_hardware(None, true, None, None);
        assert_eq!(result, Some(RiskyHardware::Nvidia));
    }

    #[test]
    fn classify_hardware_detects_vm_from_sys_vendor() {
        let result = classify_hardware(None, false, Some("QEMU"), None);
        assert_eq!(result, Some(RiskyHardware::Vm));
    }

    #[test]
    fn classify_hardware_detects_vm_from_product_name_case_insensitively() {
        let result = classify_hardware(None, false, None, Some("virtualbox"));
        assert_eq!(result, Some(RiskyHardware::Vm));
    }

    #[test]
    fn classify_hardware_detects_hyper_v_virtual_machine_phrase() {
        let result = classify_hardware(None, false, Some("Microsoft Corporation"), Some("Virtual Machine"));
        assert_eq!(result, Some(RiskyHardware::Vm));
    }

    #[test]
    fn classify_hardware_prioritizes_raspberry_pi_over_other_signals() {
        let result = classify_hardware(Some("Raspberry Pi 3"), true, Some("QEMU"), None);
        assert_eq!(result, Some(RiskyHardware::RaspberryPi));
    }

    #[test]
    fn classify_hardware_returns_none_for_ordinary_hardware() {
        let result = classify_hardware(None, false, Some("Dell Inc."), Some("XPS 13"));
        assert_eq!(result, None);
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
        StartupState { detection, active, env_override, trial_active }
    }

    #[test]
    fn decision_env_override_truthy_value_forces_safe() {
        let (result, persist) = compute_startup_decision(None, false, Some("1"), None);
        assert_eq!(result, state("safe", true, false));
        assert_eq!(persist, None);
    }

    #[test]
    fn decision_env_override_falsy_value_forces_fast() {
        let (result, persist) = compute_startup_decision(None, false, Some("0"), None);
        assert_eq!(result, state("fast", true, false));
        assert_eq!(persist, None);
    }

    #[test]
    fn decision_env_override_wins_over_cli_flag_but_the_write_still_persists() {
        let (result, persist) = compute_startup_decision(None, true, Some("0"), None);
        assert_eq!(result, state("fast", true, false));
        assert_eq!(persist, Some("safe"));
    }

    #[test]
    fn decision_cli_flag_forces_safe_and_persists_it() {
        let (result, persist) = compute_startup_decision(None, true, None, None);
        assert_eq!(result, state("safe", false, false));
        assert_eq!(persist, Some("safe"));
    }

    #[test]
    fn decision_setting_safe_is_active_safe() {
        let (result, persist) = compute_startup_decision(Some(r#"{"setting":"safe"}"#), false, None, None);
        assert_eq!(result, state("safe", false, false));
        assert_eq!(persist, None);
    }

    #[test]
    fn decision_setting_fast_is_active_fast_even_with_detection() {
        let (result, persist) = compute_startup_decision(
            Some(r#"{"setting":"fast"}"#),
            false,
            None,
            Some(RiskyHardware::RaspberryPi),
        );
        assert_eq!(result.active, "fast");
        assert!(!result.trial_active);
        assert_eq!(persist, None);
    }

    #[test]
    fn decision_setting_fast_trial_runs_fast_and_persists_auto() {
        let (result, persist) = compute_startup_decision(Some(r#"{"setting":"fast-trial"}"#), false, None, None);
        assert_eq!(result, state("fast", false, true));
        assert_eq!(persist, Some("auto"));
    }

    #[test]
    fn decision_corrupt_file_behaves_like_auto_with_detection() {
        let (result, persist) =
            compute_startup_decision(Some("not json"), false, None, Some(RiskyHardware::Nvidia));
        assert_eq!(result, state_with_detection(Some(RiskyHardware::Nvidia), "safe", false, false));
        assert_eq!(persist, None);
    }

    #[test]
    fn decision_missing_file_with_risky_detection_defaults_to_safe() {
        let (result, persist) = compute_startup_decision(None, false, None, Some(RiskyHardware::Vm));
        assert_eq!(result, state_with_detection(Some(RiskyHardware::Vm), "safe", false, false));
        assert_eq!(persist, None);
    }

    #[test]
    fn decision_missing_file_without_detection_defaults_to_fast() {
        let (result, persist) = compute_startup_decision(None, false, None, None);
        assert_eq!(result, state("fast", false, false));
        assert_eq!(persist, None);
    }
}
