#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod audio_proxy;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod compositing;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod discord;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod external_player;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod hevc_extension;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod http_range;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod matroska;

mod safe_fetch;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod sniffer;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod store_paths;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod tray;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod updater;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod vod_audio_proxy;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod vod_proxy;

mod warmup;

// The Stdout target also covers Android release builds; tauri-plugin-log routes it to logcat there, not just the debug-only terminal.
#[cfg(not(target_os = "ios"))]
fn build_log_plugin() -> tauri_plugin_log::Builder {
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    // clear_targets() drops the plugin's own default LogDir target so records aren't double-written.
    let mut log_builder = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .max_file_size(50_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .clear_targets()
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

// KeepSome only prunes the active day-stamped file's prefix, never prior days, and Android lacks desktop's manual "Open log folder" cleanup.
#[cfg(target_os = "android")]
const LOG_RETENTION_DAYS: u64 = 14;

#[cfg(target_os = "android")]
fn prune_old_android_logs(app: &tauri::App) {
    use tauri::Manager;

    let log_dir = match app.path().app_log_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("[log-prune] app_log_dir unavailable: {error}");
            return;
        }
    };
    let entries = match std::fs::read_dir(&log_dir) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("[log-prune] read_dir failed for {}: {error}", log_dir.display());
            return;
        }
    };
    let Some(cutoff) = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(LOG_RETENTION_DAYS * 24 * 60 * 60))
    else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let is_app_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("app-") && name.ends_with(".log"));
        if !is_app_log {
            continue;
        }
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(error) => {
                log::warn!("[log-prune] metadata failed for {}: {error}", path.display());
                continue;
            }
        };
        if modified < cutoff {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn!("[log-prune] remove_file failed for {}: {error}", path.display());
            }
        }
    }
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
    let context = tauri::generate_context!();
    // Must run before the builder exists: the main window is created before
    // setup(), so the WebKitGTK env var has to land before that.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    compositing::initialize(&context.config().identifier);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(warmup::WarmupState::default());

    #[cfg(not(target_os = "ios"))]
    let builder = builder.plugin(build_log_plugin().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(external_player::sandbox_bootstrap_plugin())
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
        .manage(audio_proxy::AudioProxyState::default())
        .manage(discord::RpcState::default())
        .manage(external_player::ExternalPlayerState::default())
        .manage(updater::PendingUpdateState::default())
        .manage(sniffer::SnifferState::default())
        .manage(vod_audio_proxy::VodAudioProxyState::default())
        .manage(vod_proxy::VodProxyState::default())
        .invoke_handler(tauri::generate_handler![
            audio_proxy::audio_transcode_available,
            audio_proxy::register_audio_transcode,
            audio_proxy::unregister_audio_transcode,
            compositing::compositing_state,
            compositing::compositing_set,
            discord::discord_set_activity,
            discord::discord_clear,
            discord::discord_disconnect,
            external_player::launch_external_player,
            external_player::sandbox_runtime,
            hevc_extension::install_appx_package,
            hevc_extension::is_store_build,
            safe_fetch::probe_manifest,
            sniffer::sniff_page,
            sniffer::cancel_sniff,
            sniffer::sniff_report,
            sniffer::sniff_report_drm,
            store_paths::resolve_explorer_path,
            tray::set_close_to_tray,
            updater::updater_check_from,
            updater::updater_install,
            vod_audio_proxy::vod_audio_remux_available,
            vod_audio_proxy::register_vod_audio_remux,
            vod_audio_proxy::unregister_vod_audio_remux,
            vod_proxy::register_vod_proxy,
            vod_proxy::register_vod_proxy_file,
            vod_proxy::unregister_vod_proxy,
            warmup::warmup_start,
            warmup::warmup_status,
            warmup::warmup_cancel,
            warmup::warmup_ack,
            warmup::warmup_read_staged,
        ]);

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        safe_fetch::probe_manifest,
        warmup::warmup_start,
        warmup::warmup_status,
        warmup::warmup_cancel,
        warmup::warmup_ack,
        warmup::warmup_read_staged,
    ]);

    let app = builder
        .setup(|app| {
            install_panic_hook();
            #[cfg(target_os = "android")]
            prune_old_android_logs(app);
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            external_player::sweep_orphan_mpv_sockets();
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            tray::install(app)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri::Manager;
                if let Some(main_window) = app.get_webview_window("main") {
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
            // Synchronous: runs before any IPC, so it can't race a warmup_start's staging_dir.
            warmup::sweep_stale_staging(app.handle());
            Ok(())
        })
        .build(context)
        .expect("error while running tauri application");

    app.run(|_app_handle, _event| {
        // Tauri exit paths (e.g. tray Quit) may not run Drop for state behind Arcs, so kill any active ffmpeg session here.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let tauri::RunEvent::Exit = _event {
            use tauri::Manager;
            audio_proxy::shutdown(&_app_handle.state::<audio_proxy::AudioProxyState>());
            vod_audio_proxy::shutdown(&_app_handle.state::<vod_audio_proxy::VodAudioProxyState>());
        }
    });
}
