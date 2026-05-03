// Tauri auto-updater. Runs once per browser session on Tauri desktop builds
// where the updater plugin can actually replace the binary: Windows (NSIS)
// and Linux (AppImage). On Linux the plugin gates internally on the
// `APPIMAGE` env var, so a deb / rpm install will throw a clear error and
// the catch below logs it without disrupting the page. macOS is excluded
// until signing + notarization are set up.
import { log } from "@/scripts/lib/log.js"

const SESSION_FLAG = "xt_updater_checked"

let isTauri = false
try {
    isTauri = !!window.__TAURI_INTERNALS__ || !!window.__TAURI__
} catch {}

function shouldAttemptUpdate() {
    if (!isTauri) return false
    const ua = navigator.userAgent || ""
    if (ua.includes("Windows")) return true
    // The Android WebView UA also contains "Linux" + "X11" markers, so gate
    // Linux on the absence of "Android" to keep the mobile build out.
    if (ua.includes("Linux") && !ua.includes("Android")) return true
    return false
}

async function maybeRunAutoUpdate() {
    if (!shouldAttemptUpdate()) return
    try {
        if (sessionStorage.getItem(SESSION_FLAG)) return
        sessionStorage.setItem(SESSION_FLAG, "1")
    } catch {}

    try {
        const { check } = await import("@tauri-apps/plugin-updater")
        const { relaunch } = await import("@tauri-apps/plugin-process")
        const update = await check()
        if (update !== null) {
            await update.downloadAndInstall()
            await relaunch()
        }
    } catch (err) {
        log.error("Updater error:", err)
    }
}

maybeRunAutoUpdate()
