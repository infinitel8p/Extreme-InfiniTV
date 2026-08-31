// LAN TV receiver firewall helper (Windows only). The receiver binds axum on
// 0.0.0.0, so the first LAN sender connection triggers Windows Defender
// Firewall's own "allow this app" prompt. That prompt is the primary consent
// flow: accepting it lets Windows create the rule it wants, declining it
// leaves a persistent Windows-named block rule behind (which beats any allow
// rule, ours included). This module lets Settings read that state back and,
// if the user declined or dismissed the prompt, offers an in-app recovery
// button that clears the block and re-adds our own allow rules (TCP and UDP)
// via a single UAC-elevated `netsh` chain.

#[cfg(target_os = "windows")]
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Legacy single rule name from before TCP/UDP were split out; kept only so the elevated
// recovery chain and the NSIS uninstall hook still clean it up on upgrade.
#[cfg(target_os = "windows")]
pub const RECEIVER_FIREWALL_RULE_NAME: &str = "Extreme InfiniTV Receiver";

// Must stay identical to the rule names baked into src-tauri/windows/firewall-hooks.nsh.
// netsh advfirewall needs one rule per protocol, so TCP (the receiver's own listener) and
// UDP (inbound mDNS queries on 5353 for the in-process mdns-sd responder) are separate rules.
#[cfg(target_os = "windows")]
pub const RECEIVER_FIREWALL_RULE_NAME_TCP: &str = "Extreme InfiniTV Receiver (TCP)";
#[cfg(target_os = "windows")]
pub const RECEIVER_FIREWALL_RULE_NAME_UDP: &str = "Extreme InfiniTV Receiver (UDP)";

#[tauri::command]
pub async fn receiver_firewall_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(status_blocking)
        .await
        .map_err(|error| format!("OTHER:{error}"))
}

#[tauri::command]
pub async fn receiver_firewall_allow() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(allow_blocking)
        .await
        .map_err(|error| format!("OTHER:{error}"))
}

// Doubles embedded single quotes so a path can sit inside a PowerShell
// single-quoted string literal.
#[cfg(target_os = "windows")]
fn escape_for_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

// Folds the whole state into a single stable token so the Rust side never has to parse
// localized netsh/PowerShell text. Matches purely on the exe's program-scoped rules
// (Direction/Action/Enabled), never on display name: accepting the OS prompt creates
// Windows-named allow rules, so a name-based check would never see them as "allowed".
// Any enabled inbound Allow rule counts as allowed, even alongside an enabled inbound
// Block rule (the OS prompt's own Public-profile block coexists with a private-profile
// allow), and only in the absence of an allow rule does a Block rule read as "blocked".
#[cfg(target_os = "windows")]
fn status_blocking() -> String {
    let Ok(exe_path) = std::env::current_exe() else {
        return "unknown".to_string();
    };
    let escaped_path = escape_for_powershell_single_quoted(&exe_path.to_string_lossy());
    let script = format!(
        "$inboundRules = @(Get-NetFirewallApplicationFilter -Program '{path}' -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }}); \
$allowRules = @($inboundRules | Where-Object {{ $_.Action -eq 'Allow' }}); \
$blockRules = @($inboundRules | Where-Object {{ $_.Action -eq 'Block' }}); \
if ($allowRules.Count -gt 0) {{ Write-Output 'allowed' }} \
elseif ($blockRules.Count -gt 0) {{ Write-Output 'blocked' }} \
else {{ Write-Output 'missing' }}",
        path = escaped_path,
    );

    let mut command = Command::new("powershell");
    command
        .arg("-NoProfile")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-Command")
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    match command.output() {
        Ok(output) => match String::from_utf8_lossy(&output.stdout).trim() {
            "blocked" => "blocked".to_string(),
            "allowed" => "allowed".to_string(),
            "missing" => "missing".to_string(),
            _ => "unknown".to_string(),
        },
        Err(_) => "unknown".to_string(),
    }
}

#[cfg(not(target_os = "windows"))]
fn status_blocking() -> String {
    "unsupported".to_string()
}

// Runs the whole recovery chain through one elevated `cmd.exe` so a single UAC
// prompt covers it: first delete every inbound rule netsh knows about for our
// exe (clears the Windows-named block rule from a declined prompt as well as
// any stale allow rule under a different name; its exit code is ignored since
// it fails when there is nothing to delete), then delete our own named rules
// (including the pre-split legacy single rule, for upgrades) for good measure,
// then add TCP and UDP rules back separately - netsh advfirewall has no
// protocol=any, and UDP is needed for the in-process mdns-sd responder to
// answer discovery queries on port 5353 - scoped to private and domain
// networks only, never public, unlike the OS prompt's own "allow" default.
// A declined UAC prompt leaves the state unchanged rather than surfacing as
// an error - the caller just re-checks status.
#[cfg(target_os = "windows")]
fn allow_blocking() -> String {
    let Ok(exe_path) = std::env::current_exe() else {
        return "unknown".to_string();
    };
    let escaped_path = escape_for_powershell_single_quoted(&exe_path.to_string_lossy());
    let script = format!(
        "Start-Process -FilePath cmd.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '/c netsh advfirewall firewall delete rule name=all dir=in program=\"{path}\" & netsh advfirewall firewall delete rule name=\"{legacy_rule}\" & netsh advfirewall firewall delete rule name=\"{tcp_rule}\" & netsh advfirewall firewall delete rule name=\"{udp_rule}\" & netsh advfirewall firewall add rule name=\"{tcp_rule}\" dir=in action=allow program=\"{path}\" protocol=TCP enable=yes profile=private,domain & netsh advfirewall firewall add rule name=\"{udp_rule}\" dir=in action=allow program=\"{path}\" protocol=UDP enable=yes profile=private,domain'",
        legacy_rule = RECEIVER_FIREWALL_RULE_NAME,
        tcp_rule = RECEIVER_FIREWALL_RULE_NAME_TCP,
        udp_rule = RECEIVER_FIREWALL_RULE_NAME_UDP,
        path = escaped_path,
    );

    let mut command = Command::new("powershell");
    command
        .arg("-NoProfile")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-Command")
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    let _ = command.status();
    status_blocking()
}

#[cfg(not(target_os = "windows"))]
fn allow_blocking() -> String {
    "unsupported".to_string()
}
