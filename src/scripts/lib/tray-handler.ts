// Frontend handler for system-tray menu actions.
//
// The Rust side (`src-tauri/src/tray.rs`) emits `xt:tray:navigate` with
// the target route string when the user picks a nav item from the tray
// menu. Astro is multi-page, so a full document navigation is correct;
// route changes via `window.location.href` give us a clean load with
// the page's own bundle.
//
// Desktop-only: imports `@tauri-apps/api/event` lazily so the web build
// and Android can skip the bundle entirely.

import { log } from "@/scripts/lib/log.js"
import { notify } from "@/scripts/lib/notify"
import { t } from "@/scripts/lib/i18n"
import { syncCloseToTrayToBackend } from "@/scripts/lib/app-settings.js"

type UnlistenFn = () => void

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const isAndroid = (() => {
  if (typeof navigator === "undefined") return false
  return /Android/i.test(navigator.userAgent || "")
})()

const KNOWN_ROUTES = new Set([
  "/",
  "/livetv",
  "/movies",
  "/series",
  "/search",
  "/epg",
  "/downloads",
  "/settings",
  "/favorites",
  "/watchlist",
  "/recently-added",
])

const TRAY_NOTICE_STORAGE_KEY = "xt_tray_notice_shown"

let installed = false

export async function initTrayHandler(): Promise<UnlistenFn | null> {
  if (installed) return null
  if (!isTauri || isAndroid) return null
  installed = true

  syncCloseToTrayToBackend()

  try {
    const { listen } = await import("@tauri-apps/api/event")
    const [unlistenNavigate, unlistenHidden] = await Promise.all([
      listen<string>("xt:tray:navigate", (event) => {
        const route = String(event.payload || "").trim()
        if (!KNOWN_ROUTES.has(route)) {
          log.warn("[xt:tray] unknown navigate route:", route)
          return
        }
        if (window.location.pathname === route) return
        window.location.href = route
      }),
      listen("xt:tray:hidden-to-tray", () => {
        let alreadyShown = false
        try {
          alreadyShown = localStorage.getItem(TRAY_NOTICE_STORAGE_KEY) === "1"
          if (!alreadyShown) localStorage.setItem(TRAY_NOTICE_STORAGE_KEY, "1")
        } catch {}
        if (alreadyShown) return
        notify({
          title: t("tray.notice.title"),
          body: t("tray.notice.body"),
        }).catch(() => {})
      }),
    ])
    return () => {
      unlistenNavigate()
      unlistenHidden()
    }
  } catch (err) {
    log.warn("[xt:tray] handler init failed:", err)
    installed = false
    return null
  }
}
