// Shared TV-device check: the pre-paint `data-tv` flag first, live bridge as fallback.

export function isTvDevice(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.tv === "1") return true
  try {
    return window.AndroidDeviceInfo?.isTv?.() === true
  } catch {
    return false
  }
}
