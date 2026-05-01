// Tauri auto-updater. Only runs once per browser session, on Windows desktop.
import { log } from "@/scripts/lib/log.js"

const SESSION_FLAG = "xt_updater_checked"

let isTauri = false
try {
    isTauri = !!window.__TAURI_INTERNALS__ || !!window.__TAURI__
} catch {}

async function maybeRunWindowsAutoUpdate() {
    if (!isTauri) return
    if (!navigator.userAgent.includes("Windows")) return
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

maybeRunWindowsAutoUpdate()
