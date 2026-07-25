// "Add from website" stream sniffer (desktop only): hidden webview window with an injected hook.
// The sniffed remote page can only reach `sniff_report`(+drm), never any other app command.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "sniffer";
const CANDIDATE_EVENT: &str = "xt:sniff-candidate";
const DONE_EVENT: &str = "xt:sniff-done";
const DRM_EVENT: &str = "xt:sniff-drm";

// The sniffed page is hostile by assumption - bound how much of its self-reported traffic we accept per call.
const MAX_CANDIDATES_JSON_BYTES: usize = 256 * 1024;
const MAX_CANDIDATES_PER_REPORT: usize = 100;
const MAX_FIELD_LEN: usize = 8 * 1024;

const INJECT_JS: &str = r#"
(function () {
  try {
    if (window.__xtSnifferInstalled) return;
    window.__xtSnifferInstalled = true;

    var sniffGeneration = %%GENERATION%%;
    var reported = new Set();
    var userAgent = navigator.userAgent;
    var faviconReported = false;

    function reportFavicon() {
      if (faviconReported) return;
      try {
        var link = document.querySelector("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
        var iconHref = (link && link.href) || (location.origin + "/favicon.ico");
        faviconReported = true;
        window.__TAURI_INTERNALS__.invoke("sniff_report", { candidatesJson: "[]", favicon: iconHref, generation: sniffGeneration });
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
          generation: sniffGeneration,
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
          window.__TAURI_INTERNALS__.invoke("sniff_report_drm", { generation: sniffGeneration });
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
    // Serializes the close-existing/build-new window sequence across concurrent sniff_page/cancel_sniff calls.
    lifecycle: tokio::sync::Mutex<()>,
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

    let lifecycle_guard = state.lifecycle.lock().await;

    // Silent teardown: this call already owns the sniff, no need to emit sniff-done.
    close_sniffer_window(&app);
    let generation = state.next_generation();
    state.set_favicon(None);

    // Bakes the generation into the injected script so a straggling report from a torn-down window is identifiable.
    let init_script = INJECT_JS.replace("%%GENERATION%%", &generation.to_string());
    WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(parsed))
        .visible(false)
        .inner_size(1.0, 1.0)
        .initialization_script(&init_script)
        .build()
        .map_err(|e| format!("OTHER:{e}"))?;

    drop(lifecycle_guard);

    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(timeout_ms.max(1000))).await;
        let sniffer_state = timeout_app.state::<SnifferState>();
        let _lifecycle_guard = sniffer_state.lifecycle.lock().await;
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
pub async fn cancel_sniff(
    app: AppHandle,
    state: tauri::State<'_, SnifferState>,
) -> Result<(), String> {
    let _lifecycle_guard = state.lifecycle.lock().await;
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
    generation: u64,
) -> Result<(), String> {
    if generation != state.current_generation() {
        return Ok(());
    }
    if candidates_json.len() > MAX_CANDIDATES_JSON_BYTES {
        return Err("OTHER:candidates payload too large".to_string());
    }
    if let Some(value) = favicon {
        let trimmed = value.trim();
        if !trimmed.is_empty() && trimmed.len() <= MAX_FIELD_LEN {
            state.set_favicon(Some(trimmed.to_string()));
        }
    }
    let candidates: Vec<SniffedCandidate> =
        serde_json::from_str(&candidates_json).map_err(|e| format!("OTHER:{e}"))?;
    for candidate in candidates.into_iter().take(MAX_CANDIDATES_PER_REPORT) {
        if candidate.url.trim().is_empty() || candidate.url.len() > MAX_FIELD_LEN {
            continue;
        }
        if candidate
            .user_agent
            .as_deref()
            .is_some_and(|value| value.len() > MAX_FIELD_LEN)
        {
            continue;
        }
        if candidate
            .referer
            .as_deref()
            .is_some_and(|value| value.len() > MAX_FIELD_LEN)
        {
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
pub fn sniff_report_drm(
    app: AppHandle,
    state: tauri::State<'_, SnifferState>,
    generation: u64,
) -> Result<(), String> {
    if generation != state.current_generation() {
        return Ok(());
    }
    let _ = app.emit(DRM_EVENT, ());
    Ok(())
}
