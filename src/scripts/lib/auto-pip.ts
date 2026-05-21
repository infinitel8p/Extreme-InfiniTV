// Auto-enter Picture-in-Picture when the user backgrounds the app while a
// video is playing. Android-only - the bridge is provided by MainActivity.kt
// (PipBridge.setAutoEnter). On desktop / web / iOS this is a no-op.
//
// Used by /livetv, /movies/detail, and /series/detail. Each player binds the
// VjsLikeHandle (returned by mountPlayer) once it resolves. We listen at the
// player level because video.js reset()/loadTs() destroys and recreates the
// underlying <video> element on every channel switch, so any listener
// attached directly to the raw element goes dead. The handle's on()
// re-proxies events from whatever <video> tech is current.
//
// Cleanup is automatic on pagehide so the activity doesn't keep auto-PiP
// enabled after the user navigates away from a playback page.

import type { VjsLikeHandle } from "@/scripts/lib/player-runtime"

let activeCleanup: (() => void) | null = null
let activeHandle: VjsLikeHandle | null = null

function setBridge(enabled: boolean): void {
  try {
    window.AndroidPip?.setAutoEnter?.(enabled)
  } catch {}
}

function currentVideoEl(): HTMLVideoElement | null {
  const host = activeHandle?.el?.()
  if (!host) return null
  const video = host.querySelector("video")
  return video instanceof HTMLVideoElement ? video : null
}

// Called from MainActivity.onPictureInPictureModeChanged. PiP captures the
// whole Activity window, so without intervention the user sees the page
// chrome shrunk into the PiP rectangle. We can't use video.requestFullscreen()
// here - the Fullscreen API requires user activation, which a system-driven
// auto-PiP transition doesn't carry. CSS-promoting the <video> to cover the
// viewport has the same end result and works without activation.
let pipResizeHandler: (() => void) | null = null
let pipResizeRaf = 0
let lastAppliedPipWidth = 0
let lastAppliedPipHeight = 0

// CSS `width: 100vw / 100vh` on replaced elements (`<video>`) in Android
// WebView occasionally caches the value from when the class was first
// applied and doesn't re-evaluate on Activity window resize during a PiP
// drag. Pinning the box with explicit inline pixel dimensions sidesteps
// that path entirely - the resize event itself fires reliably, and reading
// window.innerWidth/innerHeight inside the handler gives the live size.
function applyPipBoxSize(video: HTMLVideoElement): void {
  const width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 0)
  const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 0)
  if (width === lastAppliedPipWidth && height === lastAppliedPipHeight) return
  lastAppliedPipWidth = width
  lastAppliedPipHeight = height
  video.style.setProperty("width", `${width}px`, "important")
  video.style.setProperty("height", `${height}px`, "important")
}

function clearPipBoxSize(video: HTMLVideoElement | null): void {
  lastAppliedPipWidth = 0
  lastAppliedPipHeight = 0
  if (!video) return
  video.style.removeProperty("width")
  video.style.removeProperty("height")
}

if (typeof window !== "undefined") {
  window.__xtPipFullscreen = () => {
    const video = currentVideoEl()
    if (!video) return
    video.setAttribute("data-xt-pip-fill", "")
    document.documentElement.classList.add("xt-pip-active")
    applyPipBoxSize(video)
    pipResizeHandler = () => {
      if (pipResizeRaf) return
      pipResizeRaf = requestAnimationFrame(() => {
        pipResizeRaf = 0
        if (!document.documentElement.classList.contains("xt-pip-active")) return
        const live = currentVideoEl()
        if (live) applyPipBoxSize(live)
      })
    }
    window.addEventListener("resize", pipResizeHandler)
  }
  window.__xtPipExitFullscreen = () => {
    document.documentElement.classList.remove("xt-pip-active")
    const filled = document.querySelector("[data-xt-pip-fill]")
    if (filled instanceof HTMLVideoElement) {
      clearPipBoxSize(filled)
      filled.removeAttribute("data-xt-pip-fill")
    } else {
      clearPipBoxSize(null)
    }
    if (pipResizeRaf) {
      cancelAnimationFrame(pipResizeRaf)
      pipResizeRaf = 0
    }
    if (pipResizeHandler) {
      window.removeEventListener("resize", pipResizeHandler)
      pipResizeHandler = null
    }
  }
}

/**
 * Bind auto-PiP to a player handle. Returns a cleanup function; the helper
 * also calls cleanup automatically on the next pagehide. Calling bindAutoPip
 * a second time tears down the previous binding first.
 *
 * No-op when window.AndroidPip.setAutoEnter is missing (older app version,
 * desktop, web, iOS).
 */
export function bindAutoPip(handle: VjsLikeHandle): () => void {
  if (typeof window === "undefined") return () => {}
  if (!window.AndroidPip?.setAutoEnter) return () => {}

  if (activeCleanup) {
    activeCleanup()
    activeCleanup = null
  }
  activeHandle = handle

  let enabled = false
  const set = (next: boolean) => {
    if (next === enabled) return
    setBridge(next)
    enabled = next
  }

  const onPlaying = () => set(true)
  const onPause = () => set(false)
  const onEnded = () => set(false)
  const onEmptied = () => set(false)

  handle.on("play", onPlaying)
  handle.on("playing", onPlaying)
  handle.on("pause", onPause)
  handle.on("ended", onEnded)
  handle.on("emptied", onEmptied)

  // Sync once for the case where bindAutoPip is called after the video has
  // already started (e.g. resume from saved position).
  if (handle.paused && !handle.paused()) set(true)

  const cleanup = () => {
    set(false)
    handle.off?.("play", onPlaying)
    handle.off?.("playing", onPlaying)
    handle.off?.("pause", onPause)
    handle.off?.("ended", onEnded)
    handle.off?.("emptied", onEmptied)
    window.removeEventListener("pagehide", cleanup)
    if (activeHandle === handle) activeHandle = null
    if (activeCleanup === cleanup) activeCleanup = null
  }
  window.addEventListener("pagehide", cleanup)
  activeCleanup = cleanup
  return cleanup
}
