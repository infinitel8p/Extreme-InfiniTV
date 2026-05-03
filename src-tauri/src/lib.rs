#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod discord;

#[cfg(target_os = "android")]
mod android_diagnostics {
    use std::sync::Once;

    static LOGGER_INIT: Once = Once::new();

    pub fn install() {
        LOGGER_INIT.call_once(|| {
            android_logger::init_once(
                android_logger::Config::default()
                    .with_max_level(log::LevelFilter::Warn)
                    .with_tag("xtream-rs"),
            );
        });

        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let location = info
                .location()
                .map(|loc| format!(" at {}:{}:{}", loc.file(), loc.line(), loc.column()))
                .unwrap_or_default();
            log::error!("rust panic{}: {}", location, info);
            prev(info);
        }));
    }

    #[ctor::ctor]
    fn install_at_library_load() {
        install();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    android_diagnostics::install();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(discord::RpcState::default())
        .invoke_handler(tauri::generate_handler![
            discord::discord_set_activity,
            discord::discord_clear,
            discord::discord_disconnect,
        ]);

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
