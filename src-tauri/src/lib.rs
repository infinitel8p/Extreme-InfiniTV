#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod audio_proxy;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod compositing;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod discord;

mod dns_proxy;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod external_player;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod firewall;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod hevc_extension;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod http_range;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod matroska;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod mpv_embed;

mod receiver;

mod receiver_store;

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

#[cfg(not(target_os = "ios"))]
fn log_line_prefix(
    stamp: &chrono::DateTime<chrono::FixedOffset>,
    target: &str,
    level: log::Level,
) -> String {
    format!(
        "[{}][{}][{}][{}] ",
        stamp.format("%Y-%m-%d"),
        stamp.format("%H:%M:%S%.3f%:z"),
        target,
        level
    )
}

// The Stdout target also covers Android release builds; tauri-plugin-log routes it to logcat there, not just the debug-only terminal.
#[cfg(not(target_os = "ios"))]
fn build_log_plugin() -> tauri_plugin_log::Builder {
    let now = chrono::Local::now();
    let day = now.format("%Y-%m-%d").to_string();
    // The plugin's own default format drops the date and level on mobile, so state it here:
    // an Android log with no timestamps can't be correlated with anything a reporter says.
    // Offset resolved once - a per-record local lookup would hit the tz database on every line.
    let offset = *now.offset();
    // clear_targets() drops the plugin's own default LogDir target so records aren't double-written.
    let mut log_builder = tauri_plugin_log::Builder::new()
        .format(move |out, message, record| {
            let prefix =
                log_line_prefix(&chrono::Utc::now().with_timezone(&offset), record.target(), record.level());
            out.finish(format_args!("{prefix}{message}"))
        })
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

    let mut kept = 0usize;
    let mut removed = 0usize;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        // Every log in our own log dir: day-stamped, plugin-log's size-rotation names, and
        // the pre-day-stamp "<app name>.log" that the prefix check used to leave behind.
        let is_app_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".log") || name.ends_with(".log.bak"));
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
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) => {
                    log::warn!("[log-prune] remove_file failed for {}: {error}", path.display())
                }
            }
        } else {
            kept += 1;
        }
    }
    log::info!("[log-prune] kept {kept} log file(s), removed {removed} older than {LOG_RETENTION_DAYS} days");
}

// Marks a session boundary in a log file that can span days and app restarts.
fn log_session_banner(app: &tauri::App) {
    use tauri::Manager;

    let package = app.package_info();
    let log_dir = app
        .path()
        .app_log_dir()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|_| "unavailable".to_string());
    log::info!(
        "[session] {} {} start on {} {} ({} build), logs at {log_dir}",
        package.name,
        package.version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        if cfg!(debug_assertions) { "debug" } else { "release" },
    );
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
        .manage(warmup::WarmupState::default())
        .manage(receiver::ReceiverState::default())
        .manage(dns_proxy::DnsProxyState::default());

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
        .manage(mpv_embed::MpvEmbedState::default())
        .manage(updater::PendingUpdateState::default())
        .manage(sniffer::SnifferState::default())
        .manage(vod_audio_proxy::VodAudioProxyState::default())
        .manage(vod_proxy::VodProxyState::default())
        .on_page_load(|webview, payload| {
            // The frontend's unload-time teardown invoke() dies with the discarded document.
            if payload.event() == tauri::webview::PageLoadEvent::Started && webview.label() == "main" {
                use tauri::Manager;
                mpv_embed::on_main_page_navigation(webview.app_handle());
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                use tauri::Manager;
                mpv_embed::on_main_window_resized(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            audio_proxy::audio_transcode_available,
            audio_proxy::register_audio_transcode,
            audio_proxy::unregister_audio_transcode,
            compositing::compositing_state,
            compositing::compositing_set,
            discord::discord_set_activity,
            discord::discord_clear,
            discord::discord_disconnect,
            dns_proxy::dns_proxy_register,
            dns_proxy::dns_proxy_unregister,
            dns_proxy::dns_resolve_test,
            external_player::launch_external_player,
            external_player::stop_external_player,
            external_player::sandbox_runtime,
            external_player::discover_external_players,
            firewall::receiver_firewall_status,
            firewall::receiver_firewall_allow,
            hevc_extension::install_appx_package,
            hevc_extension::is_store_build,
            mpv_embed::mpv_embed_available,
            mpv_embed::mpv_embed_start,
            mpv_embed::mpv_embed_load,
            mpv_embed::mpv_embed_command,
            mpv_embed::mpv_embed_set_property,
            mpv_embed::mpv_embed_get_property,
            mpv_embed::mpv_embed_set_bounds,
            mpv_embed::mpv_embed_set_visible,
            mpv_embed::mpv_embed_stop,
            mpv_embed::mpv_embed_shutdown,
            mpv_embed::mpv_embed_status,
            mpv_embed::mpv_embed_pip_enter,
            mpv_embed::mpv_embed_pip_exit,
            mpv_embed::mpv_embed_window_fullscreen,
            mpv_embed::mpv_embed_screenshot,
            receiver::receiver_start,
            receiver::receiver_stop,
            receiver::receiver_status,
            receiver::receiver_regenerate_code,
            receiver::receiver_set_name,
            receiver::receiver_revoke_device,
            receiver::receiver_report_state,
            receiver::receiver_log_lines,
            receiver::receiver_discover,
            receiver::device_hostname,
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
        dns_proxy::dns_proxy_register,
        dns_proxy::dns_proxy_unregister,
        dns_proxy::dns_resolve_test,
        receiver::receiver_start,
        receiver::receiver_stop,
        receiver::receiver_status,
        receiver::receiver_regenerate_code,
        receiver::receiver_set_name,
        receiver::receiver_revoke_device,
        receiver::receiver_report_state,
        receiver::receiver_log_lines,
        receiver::receiver_discover,
        receiver::device_hostname,
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
            log_session_banner(app);
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
            mpv_embed::shutdown(_app_handle, &_app_handle.state::<mpv_embed::MpvEmbedState>());
        }
        if let tauri::RunEvent::Exit = _event {
            use tauri::Manager;
            receiver::shutdown(&_app_handle.state::<receiver::ReceiverState>());
        }
    });
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::log_line_prefix;

    fn stamp(text: &str) -> chrono::DateTime<chrono::FixedOffset> {
        chrono::DateTime::parse_from_rfc3339(text).unwrap()
    }

    #[test]
    fn log_line_prefix_carries_date_time_offset_target_and_level() {
        let prefix = log_line_prefix(&stamp("2026-08-25T11:27:23.456+02:00"), "webview:app", log::Level::Warn);
        assert_eq!(prefix, "[2026-08-25][11:27:23.456+02:00][webview:app][WARN] ");
    }

    #[test]
    fn log_line_prefix_keeps_a_utc_offset_explicit() {
        let prefix = log_line_prefix(&stamp("2026-01-02T03:04:05.006Z"), "app_lib::receiver", log::Level::Info);
        assert_eq!(prefix, "[2026-01-02][03:04:05.006+00:00][app_lib::receiver][INFO] ");
    }

    #[test]
    fn log_line_prefix_keeps_a_negative_offset() {
        let prefix = log_line_prefix(&stamp("2026-08-25T20:15:00.000-07:00"), "app_lib", log::Level::Error);
        assert_eq!(prefix, "[2026-08-25][20:15:00.000-07:00][app_lib][ERROR] ");
    }
}
