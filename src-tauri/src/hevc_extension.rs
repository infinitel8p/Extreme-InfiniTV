// HEVC Video Extension install bridge (Windows desktop).
//
// `install_appx_package` runs `Add-AppxPackage` on a downloaded appxbundle so
// WebView2 can decode HEVC via Media Foundation. Errors use the same stable
// prefixes as external_player.rs plus a `MISSING_DEP:` marker for the common
// VCLibs-missing case. `is_store_build` lets the frontend skip auto-install on
// the MSIX/Store build (sandboxed; can't Add-AppxPackage).

use serde_json::Value;

#[cfg(windows)]
use serde_json::json;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::time::{Duration, Instant};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
const INSTALL_TIMEOUT_MS: u64 = 180_000;
#[cfg(windows)]
const POLL_INTERVAL_MS: u64 = 100;

#[cfg(windows)]
fn validate_path(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("NOT_FOUND:appx path is empty".to_string());
    }
    if value.contains(['\0', '\n', '\r', '$', '`', '"']) {
        return Err("OTHER:appx path contains illegal characters".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn is_store_build() -> bool {
    std::env::current_exe()
        .ok()
        .map(|path| {
            path.components().any(|component| {
                component.as_os_str().to_string_lossy().eq_ignore_ascii_case("WindowsApps")
            })
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn install_appx_package(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(path))
        .await
        .map_err(|err| format!("OTHER:join: {err}"))?
}

#[cfg(windows)]
fn install_blocking(path: String) -> Result<Value, String> {
    validate_path(&path)?;
    if !Path::new(&path).exists() {
        return Err(format!("NOT_FOUND:no file at {path}"));
    }
    // The path travels via an env var, not string interpolation into the script,
    // so a value like `foo$(Start-Process calc)` can't get re-parsed as code.
    const SCRIPT: &str = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-AppxPackage -Path $env:XT_APPX_PATH";
    let mut command = Command::new("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("XT_APPX_PATH", &path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => format!("NOT_FOUND:powershell: {err}"),
        std::io::ErrorKind::PermissionDenied => format!("PERMISSION:powershell: {err}"),
        _ => format!("OTHER:{err}"),
    })?;

    let started = Instant::now();
    let budget = Duration::from_millis(INSTALL_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= budget {
                    let _ = child.kill();
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Err(format!("TIMEOUT:install exceeded {INSTALL_TIMEOUT_MS}ms"));
                }
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
            Err(err) => return Err(format!("OTHER:{err}")),
        }
    }

    let output = child.wait_with_output().map_err(|err| format!("OTHER:{err}"))?;
    if output.status.success() {
        return Ok(json!({ "ok": true }));
    }
    // Match on locale-independent HRESULT codes (error text is localized).
    // The whole output is compacted into `detail` so the code is always visible.
    let combined = format!(
        "{} {}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    log::warn!("[hevc] Add-AppxPackage failed: {}", combined.trim());
    let detail: String = combined
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect();
    let detail = if detail.is_empty() {
        format!("exit {}", output.status)
    } else {
        detail
    };
    if detail.contains("0x80073CF3") {
        return Err(format!("MISSING_DEP:{detail}"));
    }
    if detail.contains("0x80073D06") || detail.contains("0x80073CFB") {
        return Ok(json!({ "ok": true, "alreadyInstalled": true }));
    }
    if detail.contains("0x80070005") {
        return Err(format!("PERMISSION:{detail}"));
    }
    Err(format!("OTHER:{detail}"))
}

#[cfg(not(windows))]
fn install_blocking(_path: String) -> Result<Value, String> {
    Err("OTHER:HEVC extension install is Windows-only".to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn validate_path_rejects_empty() {
        let err = validate_path("").unwrap_err();
        assert!(err.starts_with("NOT_FOUND:"), "got {err}");
    }

    #[test]
    fn validate_path_rejects_null_byte() {
        let err = validate_path("C:\\appx\0junk.AppxBundle").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
    }

    #[test]
    fn validate_path_rejects_newline() {
        let err = validate_path("C:\\appx\nbundle.AppxBundle").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
    }

    #[test]
    fn validate_path_rejects_carriage_return() {
        let err = validate_path("C:\\appx\rbundle.AppxBundle").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
    }

    #[test]
    fn validate_path_rejects_command_substitution() {
        let err = validate_path("C:\\appx$(Start-Process calc).AppxBundle").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
    }

    #[test]
    fn validate_path_rejects_backtick() {
        let err = validate_path("C:\\appx`nbundle.AppxBundle").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
    }

    #[test]
    fn validate_path_rejects_double_quote() {
        let err = validate_path("C:\\appx\"bundle.AppxBundle").unwrap_err();
        assert!(err.starts_with("OTHER:"), "got {err}");
    }

    #[test]
    fn validate_path_accepts_normal_windows_path() {
        validate_path("C:\\Users\\test\\Downloads\\Microsoft.HEVCVideoExtension.AppxBundle")
            .unwrap();
    }
}
