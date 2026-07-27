// Touch counterpart to ui-sounds.ts; only fires within a short window of a real touch event.

import { getHapticsEnabled } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

export type HapticKind = "tick" | "confirm"

interface AndroidHapticsBridge {
  perform?: (kind: string) => void
}

const TOUCH_MODALITY_WINDOW_MS = 200

let lastTouchAt = 0
let initialized = false

function getAndroidHaptics(): AndroidHapticsBridge | undefined {
  return (window as any).AndroidHaptics
}

export function hapticsAvailable(): boolean {
  if (typeof window === "undefined") return false
  if (getAndroidHaptics()?.perform) return true
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return false
  const isTouchCapable =
    "ontouchstart" in window || (window.matchMedia?.("(pointer: coarse)").matches ?? false)
  return isTouchCapable
}

export function performHaptic(kind: HapticKind): void {
  if (typeof window === "undefined" || !getHapticsEnabled() || !hapticsAvailable()) return
  const bridge = getAndroidHaptics()
  if (bridge?.perform) {
    try {
      bridge.perform(kind)
      return
    } catch (err) {
      log.warn("[xt:haptics] AndroidHaptics.perform failed", err)
    }
  }
  try {
    navigator.vibrate?.(kind === "confirm" ? 20 : 10)
  } catch {
    /* vibrate can throw if blocked by browser policy */
  }
}

export function initHaptics(): void {
  if (typeof window === "undefined" || initialized) return
  initialized = true

  for (const eventName of ["pointerdown", "pointerup"]) {
    document.addEventListener(
      eventName,
      (ev) => {
        if ((ev as PointerEvent).pointerType === "touch") lastTouchAt = performance.now()
      },
      { capture: true, passive: true },
    )
  }

  document.addEventListener("xt:favorites-changed", (ev) => {
    const detail = (ev as CustomEvent).detail
    if (!detail?.isFav) return
    if (performance.now() - lastTouchAt < TOUCH_MODALITY_WINDOW_MS) performHaptic("confirm")
  })

  document.addEventListener("xt:watchlist-changed", (ev) => {
    const detail = (ev as CustomEvent).detail
    if (!detail?.onWatchlist) return
    if (performance.now() - lastTouchAt < TOUCH_MODALITY_WINDOW_MS) performHaptic("tick")
  })
}
