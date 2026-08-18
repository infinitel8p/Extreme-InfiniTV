// UI sound effects: launch chime + keyboard/D-pad nav ticks. Mouse and touch
// stay silent. Assets in public/sounds/ (provenance in its README.md).

import { getUiSoundsEnabled } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"
import { getSharedAudioContext } from "@/scripts/lib/audio-context.ts"

export type UiSoundKind = "nav" | "select" | "confirm" | "launch"

const SOUND_FILES: Record<UiSoundKind, string> = {
  nav: "ui-nav.wav",
  select: "ui-select.wav",
  confirm: "ui-confirm.wav",
  launch: "ui-launch.wav",
}

const NAV_THROTTLE_MS = 45
const KEY_MODALITY_WINDOW_MS = 200
const SELECT_DEFER_MS = 20
const LAUNCH_CHIME_FLAG = "xt_ui_launch_chimed"

const bufferCache = new Map<UiSoundKind, Promise<AudioBuffer | null>>()
let lastNavPlayAt = 0
let lastNavKeyAt = 0
let lastActivateKeyAt = 0
let lastPointerDownAt = 0
let pendingSelectTimer: ReturnType<typeof setTimeout> | null = null

function getContext(): AudioContext | null {
  return getSharedAudioContext()
}

function loadBuffer(kind: UiSoundKind): Promise<AudioBuffer | null> {
  let pending = bufferCache.get(kind)
  if (!pending) {
    pending = (async () => {
      const ctx = getContext()
      if (!ctx) return null
      try {
        const url = `${import.meta.env.BASE_URL}sounds/${SOUND_FILES[kind]}`
        const bytes = await (await fetch(url)).arrayBuffer()
        return await ctx.decodeAudioData(bytes)
      } catch (err) {
        log.warn("[xt:ui-sounds] failed to load", kind, err)
        bufferCache.delete(kind)
        return null
      }
    })()
    bufferCache.set(kind, pending)
  }
  return pending
}

/** Resolves true only when playback actually started. */
export async function playUiSound(kind: UiSoundKind): Promise<boolean> {
  if (typeof window === "undefined" || !getUiSoundsEnabled()) return false
  // Ticks would layer over playback audio during D-pad channel surfing.
  if ((kind === "nav" || kind === "select") && isVideoPlaying()) return false
  // A more specific sound firing synchronously supersedes a still-pending select tick.
  if (kind !== "select" && pendingSelectTimer !== null) {
    clearTimeout(pendingSelectTimer)
    pendingSelectTimer = null
  }
  if (kind === "nav") {
    const now = performance.now()
    if (now - lastNavPlayAt < NAV_THROTTLE_MS) return false
    lastNavPlayAt = now
  }
  const ctx = getContext()
  if (!ctx) return false
  if (ctx.state === "suspended") {
    try {
      await ctx.resume()
    } catch {
      return false
    }
    // Autoplay-blocked (web without a user gesture yet): skip, never queue.
    if ((ctx.state as string) === "suspended") return false
  }
  const buffer = await loadBuffer(kind)
  if (!buffer) return false
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
  return true
}

function isVideoPlaying(): boolean {
  const videoElements = document.querySelectorAll("video")
  for (const videoElement of videoElements) {
    if (!videoElement.paused && !videoElement.ended && videoElement.readyState >= 2) return true
  }
  return false
}

function isNavKey(key: string): boolean {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "PageUp" ||
    key === "PageDown" ||
    key === "Home" ||
    key === "End"
  )
}

export function initUiSounds(): void {
  if (typeof window === "undefined") return

  document.addEventListener(
    "keydown",
    (ev) => {
      if (isNavKey(ev.key)) lastNavKeyAt = performance.now()
      else if (ev.key === "Enter" || ev.key === " ") lastActivateKeyAt = performance.now()
    },
    { capture: true, passive: true },
  )

  // Buttons activate Space on keyup.
  document.addEventListener(
    "keyup",
    (ev) => {
      if (ev.key === " ") lastActivateKeyAt = performance.now()
    },
    { capture: true, passive: true },
  )

  // Focus landing right after a nav key = spatial-nav / D-pad movement.
  document.addEventListener("focusin", () => {
    if (performance.now() - lastNavKeyAt < KEY_MODALITY_WINDOW_MS) {
      void playUiSound("nav")
    }
  })

  // Real pointer activity, to silence custom events with no MouseEvent to inspect.
  document.addEventListener(
    "pointerdown",
    (ev) => {
      if (ev.isTrusted) lastPointerDownAt = performance.now()
    },
    { capture: true, passive: true },
  )

  document.addEventListener(
    "click",
    (ev) => {
      // detail is 0 for keyboard-synthesized clicks (Enter/Space); real pointer clicks never sound.
      if (ev.detail >= 1) return
      if (performance.now() - lastActivateKeyAt >= KEY_MODALITY_WINDOW_MS) return
      const target = ev.target as Element | null
      if (!target?.closest("button, a, [role='button'], [role='menuitem'], [tabindex]")) return
      if (pendingSelectTimer !== null) clearTimeout(pendingSelectTimer)
      // Deferred so a synchronous confirm (e.g. favorites-changed) from this same click can cancel it.
      pendingSelectTimer = setTimeout(() => {
        pendingSelectTimer = null
        void playUiSound("select")
      }, SELECT_DEFER_MS)
    },
    { capture: true },
  )

  document.addEventListener("xt:favorites-changed", (ev) => {
    const detail = (ev as CustomEvent).detail
    if (!detail?.isFav) return
    if (lastPointerDownAt > lastActivateKeyAt) return
    if (performance.now() - lastActivateKeyAt < KEY_MODALITY_WINDOW_MS) {
      void playUiSound("confirm")
    }
  })

  document.addEventListener("xt:watchlist-changed", (ev) => {
    const detail = (ev as CustomEvent).detail
    if (!detail?.onWatchlist) return
    if (lastPointerDownAt > lastActivateKeyAt) return
    if (performance.now() - lastActivateKeyAt < KEY_MODALITY_WINDOW_MS) {
      void playUiSound("confirm")
    }
  })

  if (getUiSoundsEnabled()) {
    // Warm the tick so the first focus move isn't late.
    const warm = () => void loadBuffer("nav")
    if ("requestIdleCallback" in window) requestIdleCallback(warm)
    else setTimeout(warm, 300)

    try {
      if (!sessionStorage.getItem(LAUNCH_CHIME_FLAG)) {
        // Flag only after real playback; autoplay-blocked loads retry next page.
        void playUiSound("launch").then((played) => {
          if (!played) return
          try {
            sessionStorage.setItem(LAUNCH_CHIME_FLAG, "1")
          } catch {
            /* ignore */
          }
        })
      }
    } catch {
      /* no sessionStorage: skip rather than re-chime per page */
    }
  }
}
