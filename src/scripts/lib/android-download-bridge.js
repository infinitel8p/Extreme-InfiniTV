// Thin wrapper over the native `window.AndroidDownload` bridge (the
// foreground-service download engine registered in MainActivity). Every
// bridge call is synchronous JSON in/out and never throws into JS, but we
// wrap each one in try/catch anyway in case the bridge itself misbehaves.
import { log } from "@/scripts/lib/log.js"
import { isAndroidFsActive } from "@/scripts/lib/android-fs.js"
import { getUserAgent } from "@/scripts/lib/app-settings.js"
import { DEFAULT_BROWSER_UA } from "@/scripts/lib/provider-fetch.js"
import { splitUrlAuth } from "@/scripts/lib/url-auth.ts"

export function nativeDownloadBridge() {
  if (typeof window === "undefined") return null
  if (!isAndroidFsActive()) return null
  return window.AndroidDownload || null
}

export function isNativeDownloadActive() {
  return !!nativeDownloadBridge()
}

/** Credential-stripped URL + headers for the native start payload. */
export function buildNativeHeaders(rawUrl) {
  const { url, authorization } = splitUrlAuth(rawUrl)
  const headers = { "User-Agent": getUserAgent() || DEFAULT_BROWSER_UA }
  if (authorization) headers["Authorization"] = authorization
  return { url, headers }
}

export function nativeStart(payload) {
  const bridge = nativeDownloadBridge()
  if (!bridge) return false
  try {
    return !!bridge.start(JSON.stringify(payload))
  } catch (e) {
    log.error("[xt:android-download] start failed:", e)
    return false
  }
}

export function nativePause(id) {
  const bridge = nativeDownloadBridge()
  if (!bridge) return false
  try {
    return !!bridge.pause(id)
  } catch (e) {
    log.error("[xt:android-download] pause failed:", e)
    return false
  }
}

export function nativeResume(id) {
  const bridge = nativeDownloadBridge()
  if (!bridge) return false
  try {
    return !!bridge.resume(id)
  } catch (e) {
    log.error("[xt:android-download] resume failed:", e)
    return false
  }
}

export function nativeRemove(id) {
  const bridge = nativeDownloadBridge()
  if (!bridge) return false
  try {
    return !!bridge.remove(id)
  } catch (e) {
    log.error("[xt:android-download] remove failed:", e)
    return false
  }
}

export function nativeSetMaxConcurrent(n) {
  const bridge = nativeDownloadBridge()
  if (!bridge) return
  try {
    bridge.setMaxConcurrent(n)
  } catch (e) {
    log.error("[xt:android-download] setMaxConcurrent failed:", e)
  }
}

export function nativeClearAll() {
  const bridge = nativeDownloadBridge()
  if (!bridge) return false
  try {
    return !!bridge.clearAll()
  } catch (e) {
    log.error("[xt:android-download] clearAll failed:", e)
    return false
  }
}

/** @returns {Array<object>} native records, or [] when the bridge is absent/failing. */
export function nativeSnapshot() {
  const bridge = nativeDownloadBridge()
  if (!bridge) return []
  try {
    const parsed = JSON.parse(bridge.snapshot())
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    log.error("[xt:android-download] snapshot failed:", e)
    return []
  }
}
