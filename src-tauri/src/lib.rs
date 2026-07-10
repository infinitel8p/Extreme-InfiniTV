#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod discord;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod external_player;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod hevc_extension;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod tray;

// The Stdout target also covers Android release builds; tauri-plugin-log routes it to logcat there, not just the debug-only terminal.
#[cfg(not(target_os = "ios"))]
fn build_log_plugin() -> tauri_plugin_log::Builder {
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut log_builder = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .max_file_size(50_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some(format!("app-{day}")),
            },
        ));
    if cfg!(debug_assertions) || cfg!(target_os = "android") {
        log_builder = log_builder.target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ));
    }
    log_builder
}

fn install_panic_hook() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let payload = panic_info.payload();
        let message = if let Some(text) = payload.downcast_ref::<&str>() {
            text.to_string()
        } else if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else {
            "non-string panic payload".to_string()
        };
        let location = panic_info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        log::error!("[panic] {message} at {location}");
        previous_hook(panic_info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(target_os = "ios"))]
    let builder = builder.plugin(build_log_plugin().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(discord::RpcState::default())
        .manage(external_player::ExternalPlayerState::default())
        .invoke_handler(tauri::generate_handler![
            discord::discord_set_activity,
            discord::discord_clear,
            discord::discord_disconnect,
            external_player::launch_external_player,
            hevc_extension::install_appx_package,
            hevc_extension::is_store_build,
            tray::set_close_to_tray,
        ]);

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());

    builder
        .setup(|_app| {
            install_panic_hook();
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            external_player::sweep_orphan_mpv_sockets();
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            tray::install(_app)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri::Manager;
                if let Some(main_window) = _app.get_webview_window("main") {
                    if let Err(error) = main_window.set_decorations(false) {
                        log::warn!("[window] set_decorations(false) failed: {error}");
                    }
                    if let Err(error) = main_window.set_shadow(true) {
                        log::warn!("[window] set_shadow(true) failed: {error}");
                    }
                    if let Err(error) = main_window.show() {
                        log::warn!("[window] show() failed: {error}");
                    }
                    let _ = main_window.set_focus();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
