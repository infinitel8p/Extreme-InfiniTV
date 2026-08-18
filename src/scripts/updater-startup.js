// Tauri auto-updater. Runs once per browser session on Tauri desktop builds
// where the updater plugin can actually replace the binary: Windows (NSIS)
// and Linux (AppImage). On Linux the plugin gates internally on the
// `APPIMAGE` env var, so a deb / rpm install will throw a clear error and
// the catch below logs it without disrupting the page. MS Store builds are
// excluded too - an NSIS installer must not be applied over an MSIX install.
// macOS is excluded until signing + notarization are set up.
//
// Everywhere else (web, Android, macOS, MS Store), a GitHub-release check
// runs instead and surfaces a one-toast-per-version notification pointing
// people at Settings > About. Snap/Flatpak skip this file entirely: their
// store owns updates, and Flathub flags a reachable self-update path.
import { log } from "@/scripts/lib/log.js"
import {
    checkForUpdate,
    isStoreBuild,
    resolveUpdateFeedUrl,
    withUpdaterRetry,
} from "@/scripts/lib/update-check.js"
import { sandboxRuntime } from "@/scripts/lib/sandbox.ts"
import { getUpdateChannel, getAutoUpdateEnabled } from "@/scripts/lib/app-settings.js"
import { toast } from "@/scripts/lib/toast.js"
import { t } from "@/scripts/lib/i18n.js"

const SESSION_FLAG = "xt_updater_checked"
const NOTIFIED_VERSION_KEY = "xt_update_notified"

let isTauri = false
try {
    isTauri = !!window.__TAURI_INTERNALS__ || !!window.__TAURI__
} catch {}

function isAutoUpdatePlatform() {
    if (!isTauri) return false
    const ua = navigator.userAgent || ""
    if (ua.includes("Windows")) return true
    // The Android WebView UA also contains "Linux" + "X11" markers, so gate
    // Linux on the absence of "Android" to keep the mobile build out.
    if (ua.includes("Linux") && !ua.includes("Android")) return true
    return false
}

function markSessionChecked() {
    try {
        if (sessionStorage.getItem(SESSION_FLAG)) return false
        sessionStorage.setItem(SESSION_FLAG, "1")
        return true
    } catch {
        return true
    }
}

function readNotifiedVersion() {
    try {
        return localStorage.getItem(NOTIFIED_VERSION_KEY)
    } catch {
        return null
    }
}

function writeNotifiedVersion(version) {
    try {
        localStorage.setItem(NOTIFIED_VERSION_KEY, version)
    } catch {}
}

async function runBetaAutoUpdate() {
    const { invoke } = await import("@tauri-apps/api/core")
    const { relaunch } = await import("@tauri-apps/plugin-process")
    const url = await resolveUpdateFeedUrl()
    const update = await withUpdaterRetry(() => invoke("updater_check_from", { url }))
    if (update === null) return
    await invoke("updater_install")
    // Windows exits the process mid-install (NSIS restarts it); relaunch() only matters on Linux AppImage.
    await relaunch()
}

async function runAutoUpdate() {
    if (getUpdateChannel() === "beta") {
        try {
            await runBetaAutoUpdate()
            return
        } catch (err) {
            log.error("Beta updater error, falling back to stable auto-update:", err)
        }
    }

    const { check } = await import("@tauri-apps/plugin-updater")
    const { relaunch } = await import("@tauri-apps/plugin-process")
    const update = await withUpdaterRetry(() => check())
    if (update !== null) {
        await update.downloadAndInstall()
        await relaunch()
    }
}

async function notifyIfUpdateAvailable() {
    const status = await checkForUpdate()
    if (!status?.updateAvailable) return
    if (readNotifiedVersion() === status.latest) return
    writeNotifiedVersion(status.latest)
    toast({
        title: t("settings.about.updateAvailable", { version: status.latestTag }),
        description: t("update.openAboutHint"),
        duration: 8000,
    })
}

async function maybeRunAutoUpdate() {
    if (!markSessionChecked()) return
    if (await sandboxRuntime()) return

    if (isAutoUpdatePlatform() && !(await isStoreBuild())) {
        if (!getAutoUpdateEnabled()) return
        try {
            await runAutoUpdate()
            return
        } catch (err) {
            log.error("Updater error, falling back to notify check:", err)
        }
    }

    try {
        await notifyIfUpdateAvailable()
    } catch (err) {
        log.error("Update notify check failed:", err)
    }
}

maybeRunAutoUpdate()
