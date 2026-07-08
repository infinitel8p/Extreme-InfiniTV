// Cross-platform native notifications.
//
// Tauri build (Win/Mac/Linux/Android/iOS): routes through
// `@tauri-apps/plugin-notification`, which delivers via the OS
// notification surface (Toast / Notification Center / `NotificationManager`
// / `UNUserNotificationCenter`). Survives app-backgrounding and, on
// Android, can be scheduled to fire even when the app is killed.
//
// Web build: falls back to the browser `Notification` API. Same
// permission-grant flow; less reliable on mobile browsers.
//
// Both paths gate on the user having granted permission. The first
// `notify(...)` call after install will request it; subsequent calls
// just use the cached grant. Calls before the user has interacted with
// the app may be silently dropped by the OS on Android 13+ (POST
// NOTIFICATIONS permission requires a user gesture to request on most
// vendor skins).

import { log } from "@/scripts/lib/log.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

export interface NotifyOptions {
  title: string
  body?: string
  id?: number
  icon?: string
}

let permissionState: "default" | "granted" | "denied" | null = null

async function ensurePermission(): Promise<boolean> {
  if (permissionState === "granted") return true
  if (permissionState === "denied") return false

  if (isTauri) {
    try {
      const mod = await import("@tauri-apps/plugin-notification")
      const granted = await mod.isPermissionGranted()
      if (granted) {
        permissionState = "granted"
        return true
      }
      const result = await mod.requestPermission()
      permissionState = result === "granted" ? "granted" : "denied"
      return permissionState === "granted"
    } catch (err) {
      log.warn("[xt:notify] tauri permission check failed:", err)
      return false
    }
  }

  if (typeof Notification === "undefined") return false
  if (Notification.permission === "granted") {
    permissionState = "granted"
    return true
  }
  if (Notification.permission === "denied") {
    permissionState = "denied"
    return false
  }
  try {
    const result = await Notification.requestPermission()
    permissionState = result === "granted" ? "granted" : "denied"
    return permissionState === "granted"
  } catch (err) {
    log.warn("[xt:notify] web permission request failed:", err)
    return false
  }
}

export async function notify(options: NotifyOptions): Promise<void> {
  const granted = await ensurePermission()
  if (!granted) return

  if (isTauri) {
    try {
      const mod = await import("@tauri-apps/plugin-notification")
      mod.sendNotification({
        title: options.title,
        body: options.body,
        ...(options.icon ? { icon: options.icon } : {}),
        ...(options.id !== undefined ? { id: options.id } : {}),
      })
      return
    } catch (err) {
      log.warn("[xt:notify] tauri send failed:", err)
    }
  }

  if (typeof Notification !== "undefined") {
    try {
      new Notification(options.title, {
        body: options.body,
        icon: options.icon,
      })
    } catch (err) {
      log.warn("[xt:notify] web Notification failed:", err)
    }
  }
}

export function resetPermissionCache(): void {
  permissionState = null
}
