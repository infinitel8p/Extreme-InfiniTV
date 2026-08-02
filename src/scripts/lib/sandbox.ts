// Snap/Flatpak sandbox probe, shared by player-runtime.ts and the updater.

export type SandboxRuntime = "snap" | "flatpak"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const isAndroid = (() => {
  if (typeof navigator === "undefined") return false
  return /Android/i.test(navigator.userAgent || "")
})()

const desktopPlatform = isTauri && !isAndroid

/** Reads `window.__XT_SANDBOX__`, set by a webview init script pre-paint. */
export function sandboxRuntimeSync(): SandboxRuntime | null {
  if (!desktopPlatform) return null
  const value = (window as any).__XT_SANDBOX__
  return value === "snap" || value === "flatpak" ? value : null
}

/** Thin async wrapper kept for call sites that prefer a promise. */
export function sandboxRuntime(): Promise<SandboxRuntime | null> {
  return Promise.resolve(sandboxRuntimeSync())
}
