// Discord Rich Presence bridge.
//
// Frontends call `discord_set_activity` after the user starts watching
// something; we lazily open a Discord IPC connection on first call and
// reuse it. Wrapped in a Mutex because the frontend can fire the command
// from multiple async tasks. Errors are converted to strings so they
// surface as JS exceptions through invoke().
//
// Desktop only - Discord IPC isn't supported on Android/iOS, and the
// `discord-rich-presence` crate only compiles for desktop targets.

use std::sync::Mutex;

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct ButtonInput {
    pub label: String,
    pub url: String,
}

#[derive(Default)]
pub struct RpcState {
    pub client: Mutex<Option<DiscordIpcClient>>,
    pub current_id: Mutex<Option<String>>,
}

fn ensure_client(state: &State<RpcState>, app_id: &str) -> Result<(), String> {
    let mut current = state
        .current_id
        .lock()
        .map_err(|e| format!("rpc current_id lock poisoned: {e}"))?;
    let mut client_opt = state
        .client
        .lock()
        .map_err(|e| format!("rpc client lock poisoned: {e}"))?;
    if current.as_deref() == Some(app_id) && client_opt.is_some() {
        return Ok(());
    }
    if let Some(mut existing) = client_opt.take() {
        let _ = existing.close();
    }
    let mut new_client =
        DiscordIpcClient::new(app_id).map_err(|e| format!("DiscordIpcClient::new: {e}"))?;
    new_client
        .connect()
        .map_err(|e| format!("Discord IPC connect failed: {e}"))?;
    *client_opt = Some(new_client);
    *current = Some(app_id.to_string());
    Ok(())
}

#[tauri::command]
pub fn discord_set_activity(
    state: State<'_, RpcState>,
    client_id: String,
    details: Option<String>,
    state_text: Option<String>,
    large_image: Option<String>,
    large_text: Option<String>,
    small_image: Option<String>,
    small_text: Option<String>,
    start_timestamp: Option<i64>,
    buttons: Option<Vec<ButtonInput>>,
) -> Result<(), String> {
    if client_id.trim().is_empty() {
        return Err("discord client_id is empty".into());
    }
    ensure_client(&state, &client_id)?;
    let mut client_opt = state
        .client
        .lock()
        .map_err(|e| format!("rpc client lock poisoned: {e}"))?;
    let client = client_opt
        .as_mut()
        .ok_or_else(|| "Discord client not initialised".to_string())?;

    let mut activity = activity::Activity::new();
    if let Some(d) = details.as_deref() {
        if !d.is_empty() {
            activity = activity.details(d);
        }
    }
    if let Some(s) = state_text.as_deref() {
        if !s.is_empty() {
            activity = activity.state(s);
        }
    }

    let mut assets = activity::Assets::new();
    let mut have_assets = false;
    if let Some(image) = large_image.as_deref() {
        if !image.is_empty() {
            assets = assets.large_image(image);
            have_assets = true;
        }
    }
    if let Some(text) = large_text.as_deref() {
        if !text.is_empty() {
            assets = assets.large_text(text);
            have_assets = true;
        }
    }
    if let Some(image) = small_image.as_deref() {
        if !image.is_empty() {
            assets = assets.small_image(image);
            have_assets = true;
        }
    }
    if let Some(text) = small_text.as_deref() {
        if !text.is_empty() {
            assets = assets.small_text(text);
            have_assets = true;
        }
    }
    if have_assets {
        activity = activity.assets(assets);
    }

    if let Some(ts) = start_timestamp {
        activity = activity.timestamps(activity::Timestamps::new().start(ts));
    }

    if let Some(button_inputs) = buttons.as_ref() {
        let collected: Vec<activity::Button> = button_inputs
            .iter()
            .filter(|b| !b.label.trim().is_empty() && !b.url.trim().is_empty())
            .take(2)
            .map(|b| activity::Button::new(b.label.as_str(), b.url.as_str()))
            .collect();
        if !collected.is_empty() {
            activity = activity.buttons(collected);
        }
    }

    client
        .set_activity(activity)
        .map_err(|e| format!("Discord set_activity failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn discord_clear(state: State<'_, RpcState>) -> Result<(), String> {
    let mut client_opt = state
        .client
        .lock()
        .map_err(|e| format!("rpc client lock poisoned: {e}"))?;
    if let Some(client) = client_opt.as_mut() {
        client
            .clear_activity()
            .map_err(|e| format!("Discord clear_activity failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn discord_disconnect(state: State<'_, RpcState>) -> Result<(), String> {
    let mut client_opt = state
        .client
        .lock()
        .map_err(|e| format!("rpc client lock poisoned: {e}"))?;
    let mut current = state
        .current_id
        .lock()
        .map_err(|e| format!("rpc current_id lock poisoned: {e}"))?;
    if let Some(mut client) = client_opt.take() {
        let _ = client.close();
    }
    *current = None;
    Ok(())
}
