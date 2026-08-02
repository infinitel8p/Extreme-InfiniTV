// System-tray icon + menu (desktop only).
//
// Left-click toggles the main window's visibility. Right-click shows a
// menu with: Show/Hide, quick navigation to the main routes, and Quit.
// The tray icon keeps the app alive after the user closes the main
// window, which is the prerequisite for programme-start reminders,
// global media keys, and other background-while-minimized features.
//
// Close-to-tray: clicking the window's X (or sending it `WM_CLOSE`,
// or `Cmd+W`-equivalent) hides the window rather than exiting. Quit is
// reached only via the tray's `Quit` item or its `Ctrl+Q` / `Cmd+Q`
// accelerator. This is Skype-classic / Discord / Slack behaviour and
// is the only sensible default once the tray is on the screen.
//
// Menu actions that route the webview emit a Tauri event
// (`xt:tray:navigate` with a route string) so the frontend handler in
// `src/scripts/lib/tray-handler.ts` can take over - keeps URL routing
// logic on the JS side where the rest of the app lives.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

// Shared flag toggled from the frontend via `set_close_to_tray`
#[derive(Default)]
pub struct CloseToTrayState(pub Arc<AtomicBool>);

#[tauri::command]
pub fn set_close_to_tray(enabled: bool, state: tauri::State<'_, CloseToTrayState>) {
    state.0.store(enabled, Ordering::Relaxed);
}

pub fn install(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let close_to_tray_flag = Arc::new(AtomicBool::new(true));
    app.manage(CloseToTrayState(close_to_tray_flag.clone()));

    let show_hide = MenuItem::with_id(app, "show_hide", "Show / Hide window", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let open_livetv = MenuItem::with_id(app, "nav:/livetv", "Live TV", true, None::<&str>)?;
    let open_movies = MenuItem::with_id(app, "nav:/movies", "Movies", true, None::<&str>)?;
    let open_series = MenuItem::with_id(app, "nav:/series", "Series", true, None::<&str>)?;
    let open_search = MenuItem::with_id(app, "nav:/search", "Search", true, None::<&str>)?;
    let open_epg = MenuItem::with_id(app, "nav:/epg", "Guide", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let open_downloads = MenuItem::with_id(app, "nav:/downloads", "Downloads", true, None::<&str>)?;
    let open_settings = MenuItem::with_id(app, "nav:/settings", "Settings", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &sep1,
            &open_livetv,
            &open_movies,
            &open_series,
            &open_search,
            &open_epg,
            &sep2,
            &open_downloads,
            &open_settings,
            &sep3,
            &quit,
        ],
    )?;

    // Transparent glyph on every platform, unlike the bundle icons.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let tray_result = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Extreme InfiniTV")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| {
            let id = event.id.as_ref();
            if let Some(route) = id.strip_prefix("nav:") {
                navigate(app_handle, route);
                return;
            }
            match id {
                "show_hide" => toggle_main_window(app_handle),
                "quit" => app_handle.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app);

    // Only intercept close-to-tray when the tray icon actually installed
    let tray_installed = match tray_result {
        Ok(_) => true,
        Err(error) => {
            log::warn!("[tray] tray icon unavailable, close-to-tray disabled: {error}");
            false
        }
    };

    if tray_installed {
        if let Some(main_window) = app.get_webview_window("main") {
            let window_for_hide = main_window.clone();
            main_window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if !close_to_tray_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    api.prevent_close();
                    let _ = window_for_hide.hide();
                    let _ = window_for_hide.emit("xt:tray:hidden-to-tray", ());
                }
            });
        }
    }

    Ok(())
}

fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if visible && !minimized {
        let _ = window.hide();
    } else {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn navigate(app: &AppHandle, route: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("xt:tray:navigate", route.to_string());
}
