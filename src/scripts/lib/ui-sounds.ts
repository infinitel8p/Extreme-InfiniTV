// UI sound effects: launch chime + keyboard/D-pad nav ticks. Mouse and touch
// stay silent. Assets in public/sounds/ (provenance in its README.md).

import { getUiSoundsEnabled } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

export type UiSoundKind = "nav" | "select" | "confirm" | "launch"

const SOUND_FILES: Record<UiSoundKind, string> = {
  nav: "ui-nav.wav",
  select: "ui-select.wav",
  confirm: "ui-confirm.wav",
  launch: "ui-launch.wav",
}

const NAV_THROTTLE_MS = 45
const KEY_MODALITY_WINDOW_MS = 200
const LAUNCH_CHIME_FLAG = "xt_ui_launch_chimed"

let audioContext: AudioContext | null = null
const bufferCache = new Map<UiSoundKind, Promise<AudioBuffer | null>>()
let lastNavPlayAt = 0
let lastNavKeyAt = 0
let lastActivateKeyAt = 0

function getContext(): AudioContext | null {
  if (audioContext) return audioContext
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext
  if (!Ctor) return null
  audioContext = new Ctor()
  return audioContext
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

  document.addEventListener(
    "click",
    (ev) => {
      if (performance.now() - lastActivateKeyAt >= KEY_MODALITY_WINDOW_MS) return
      const target = ev.target as Element | null
      if (target?.closest("button, a, [role='button'], [role='menuitem'], [tabindex]")) {
        void playUiSound("select")
      }
    },
    { capture: true },
  )

  document.addEventListener("xt:favorites-changed", (ev) => {
    const detail = (ev as CustomEvent).detail
    if (!detail?.isFav) return
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
