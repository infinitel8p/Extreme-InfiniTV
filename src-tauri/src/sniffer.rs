// "Add from website" stream sniffer (desktop only).
//
// Loads an arbitrary page in a hidden webview window, injects a script that
// watches fetch/XHR/PerformanceObserver traffic and periodically nudges
// play buttons + <video> elements, and reports anything that looks like an
// HLS/DASH manifest back to the main window as `xt:sniff-candidate` events.
// Mirrors the Android `SnifferBridge` in MainActivity.kt so both platforms
// feed the same facade in stream-sniffer.ts.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "sniffer";
const CANDIDATE_EVENT: &str = "xt:sniff-candidate";
const DONE_EVENT: &str = "xt:sniff-done";
const DRM_EVENT: &str = "xt:sniff-drm";

const INJECT_JS: &str = r#"
(function () {
  try {
    if (window.__xtSnifferInstalled) return;
    window.__xtSnifferInstalled = true;

    var reported = new Set();
    var userAgent = navigator.userAgent;
    var faviconReported = false;

    function reportFavicon() {
      if (faviconReported) return;
      try {
        var link = document.querySelector("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
        var iconHref = (link && link.href) || (location.origin + "/favicon.ico");
        faviconReported = true;
        window.__TAURI_INTERNALS__.invoke("sniff_report", { candidatesJson: "[]", favicon: iconHref });
      } catch (_) {}
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", reportFavicon);
    } else {
      reportFavicon();
    }

    function looksLikeManifest(url) {
      return /\.(m3u8|mpd)(?:[?#]|$)/i.test(url) || /mpegurl|dash/i.test(url);
    }

    function report(url) {
      if (!url || reported.has(url) || !looksLikeManifest(url)) return;
      reported.add(url);
      try {
        window.__TAURI_INTERNALS__.invoke("sniff_report", {
          candidatesJson: JSON.stringify([{ url: url, userAgent: userAgent, referer: location.href }]),
        });
      } catch (_) {}
    }

    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function (input, init) {
        try {
          report(typeof input === "string" ? input : input && input.url);
        } catch (_) {}
        return originalFetch.apply(this, arguments);
      };
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        report(url);
      } catch (_) {}
      return originalOpen.apply(this, arguments);
    };

    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            report(entry.name);
          });
        }).observe({ type: "resource", buffered: true });
      } catch (_) {}
    }

    var originalRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess;
    if (originalRequestMediaKeySystemAccess) {
      navigator.requestMediaKeySystemAccess = function () {
        try {
          window.__TAURI_INTERNALS__.invoke("sniff_report_drm", {});
        } catch (_) {}
        return originalRequestMediaKeySystemAccess.apply(navigator, arguments);
      };
    }

    function nudge() {
      try {
        [
          'button[class*="play" i]',
          '[class*="play-button" i]',
          '[aria-label*="play" i]',
          ".vjs-big-play-button",
          ".jw-icon-playback",
        ].forEach(function (selector) {
          document.querySelectorAll(selector).forEach(function (el) {
            try {
              el.click();
            } catch (_) {}
          });
        });
      } catch (_) {}
      try {
        document.querySelectorAll("video").forEach(function (v) {
          try {
            v.play();
          } catch (_) {}
        });
      } catch (_) {}
    }

    var nudgeCount = 0;
    var nudgeTimer = setInterval(function () {
      nudge();
      reportFavicon();
      nudgeCount += 1;
      if (nudgeCount >= 5) clearInterval(nudgeTimer);
    }, 1000);
  } catch (_) {}
})();
"#;

#[derive(Default)]
pub struct SnifferState {
    generation: Mutex<u64>,
    favicon: Mutex<Option<String>>,
}

impl SnifferState {
    fn next_generation(&self) -> u64 {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *generation += 1;
        *generation
    }

    fn current_generation(&self) -> u64 {
        *self
            .generation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn set_favicon(&self, value: Option<String>) {
        *self
            .favicon
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = value;
    }

    fn take_favicon(&self) -> Option<String> {
        self.favicon
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}

fn close_sniffer_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

#[tauri::command]
pub async fn sniff_page(
    app: AppHandle,
    state: tauri::State<'_, SnifferState>,
    url: String,
    timeout_ms: u64,
) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("OTHER:{e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("OTHER:url must be http or https".to_string());
    }

    // Silent teardown: this call already owns the sniff, no need to emit sniff-done.
    close_sniffer_window(&app);
    let generation = state.next_generation();
    state.set_favicon(None);

    WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(parsed))
        .visible(false)
        .inner_size(1.0, 1.0)
        .initialization_script(INJECT_JS)
        .build()
        .map_err(|e| format!("OTHER:{e}"))?;

    let timeout_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(timeout_ms.max(1000)));
        let sniffer_state = timeout_app.state::<SnifferState>();
        if sniffer_state.current_generation() != generation {
            return;
        }
        close_sniffer_window(&timeout_app);
        let favicon = sniffer_state.take_favicon();
        let _ = timeout_app.emit(DONE_EVENT, json!({ "favicon": favicon }));
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_sniff(app: AppHandle, state: tauri::State<'_, SnifferState>) -> Result<(), String> {
    state.next_generation();
    close_sniffer_window(&app);
    let favicon = state.take_favicon();
    let _ = app.emit(DONE_EVENT, json!({ "favicon": favicon }));
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SniffedCandidate {
    url: String,
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    referer: Option<String>,
}

#[tauri::command]
pub fn sniff_report(
    app: AppHandle,
    state: tauri::State<'_, SnifferState>,
    candidates_json: String,
    favicon: Option<String>,
) -> Result<(), String> {
    if let Some(value) = favicon {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            state.set_favicon(Some(trimmed.to_string()));
        }
    }
    let candidates: Vec<SniffedCandidate> =
        serde_json::from_str(&candidates_json).map_err(|e| format!("OTHER:{e}"))?;
    for candidate in candidates {
        if candidate.url.trim().is_empty() {
            continue;
        }
        let _ = app.emit(
            CANDIDATE_EVENT,
            json!({
                "url": candidate.url,
                "userAgent": candidate.user_agent,
                "referer": candidate.referer,
            }),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn sniff_report_drm(app: AppHandle) -> Result<(), String> {
    let _ = app.emit(DRM_EVENT, ());
    Ok(())
}
