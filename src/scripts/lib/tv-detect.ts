// Shared TV-device check: the pre-paint `data-tv` flag first, live bridge as fallback.

export function isTvDevice(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.tv === "1") return true
  try {
    return window.AndroidDeviceInfo?.isTv?.() === true
  } catch {
    return false
  }
}

/** ActivityManager.memoryClass in MB, or null off Android / when the bridge is unavailable. */
export function getAndroidMemoryClassMb(): number | null {
  try {
    const memoryClassMb = window.AndroidDeviceInfo?.getMemoryClass?.()
    return typeof memoryClassMb === "number" && memoryClassMb > 0 ? memoryClassMb : null
  } catch {
    return null
  }
}
