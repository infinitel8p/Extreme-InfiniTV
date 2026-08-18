// Channel-specific update check/install bridge (desktop only).
//
// The JS `@tauri-apps/plugin-updater` API always hits the endpoint baked
// into `tauri.conf.json`; it has no way to point at a different release
// channel at runtime. These commands rebuild an `Updater` per-call against
// a caller-supplied endpoint, restricted to our own GitHub releases host.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_updater::{Update, UpdaterExt};

const ALLOWED_HOST: &str = "github.com";
const ALLOWED_PATH_PREFIX: &str = "/infinitel8p/Extreme-InfiniTV/releases/download/";

// Builder timeout covers the manifest fetch only - `check()` hands the Update a fresh `timeout: None`.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

pub const PROGRESS_EVENT: &str = "xt:updater-progress";

#[derive(Default)]
pub struct PendingUpdateState {
    pending: Mutex<Option<Update>>,
}

#[tauri::command]
pub async fn updater_check_from(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingUpdateState>,
    url: String,
) -> Result<Option<Value>, String> {
    let endpoint = tauri::Url::parse(&url).map_err(|e| format!("OTHER:{e}"))?;
    let is_allowed = endpoint.scheme() == "https"
        && endpoint.host_str() == Some(ALLOWED_HOST)
        && endpoint.path().starts_with(ALLOWED_PATH_PREFIX);
    if !is_allowed {
        return Err(format!("OTHER:endpoint not allowed: {url}"));
    }
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("OTHER:{e}"))?
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("OTHER:{e}"))?
        .check()
        .await
        .map_err(|e| format!("OTHER:{e}"))?;

    let payload = update.as_ref().map(|update| {
        json!({
            "version": update.version,
            "notes": update.body,
            "pubDate": update.raw_json.get("pub_date").cloned().unwrap_or(Value::Null),
        })
    });

    let mut pending = state.pending.lock().unwrap_or_else(|poison| poison.into_inner());
    *pending = update;

    Ok(payload)
}

#[tauri::command]
pub async fn updater_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingUpdateState>,
) -> Result<(), String> {
    let update = {
        let pending = state.pending.lock().unwrap_or_else(|poison| poison.into_inner());
        pending.clone()
    };
    let Some(update) = update else {
        return Err("OTHER:no pending update; call updater_check_from first".to_string());
    };

    let mut started = false;
    let mut pending_bytes: usize = 0;
    const EMIT_THRESHOLD: usize = 256 * 1024;
    let progress_app = app.clone();
    let finish_app = app.clone();
    update
        .download_and_install(
            // Per-chunk emits flood the WebView eval queue; batch to ~4 events per MB.
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress_app.emit(
                        PROGRESS_EVENT,
                        json!({ "event": "Started", "data": { "contentLength": content_length } }),
                    );
                }
                pending_bytes += chunk_length;
                if pending_bytes < EMIT_THRESHOLD {
                    return;
                }
                let _ = progress_app.emit(
                    PROGRESS_EVENT,
                    json!({ "event": "Progress", "data": { "chunkLength": pending_bytes } }),
                );
                pending_bytes = 0;
            },
            move || {
                // Only chance to emit on Windows - the installer path exits the process next.
                let _ = finish_app.emit(PROGRESS_EVENT, json!({ "event": "Finished" }));
            },
        )
        .await
        .map_err(|e| format!("OTHER:{e}"))?;

    let mut pending = state.pending.lock().unwrap_or_else(|poison| poison.into_inner());
    *pending = None;
    Ok(())
}
