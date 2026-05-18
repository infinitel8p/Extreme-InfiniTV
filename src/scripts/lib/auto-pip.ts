// Auto-enter Picture-in-Picture when the user backgrounds the app while a
// video is playing. Android-only - the bridge is provided by MainActivity.kt
// (PipBridge.setAutoEnter). On desktop / web / iOS this is a no-op.
//
// Used by /livetv, /movies/detail, and /series/detail. Each player binds its
// underlying <video> element after mountPlayer resolves; this helper listens
// for play / pause / ended / emptied and toggles the Android flag.
//
// Cleanup is automatic on pagehide so the activity doesn't keep auto-PiP
// enabled after the user navigates away from a playback page.

let activeCleanup: (() => void) | null = null

function setBridge(enabled: boolean): void {
  try {
    window.AndroidPip?.setAutoEnter?.(enabled)
  } catch {}
}

/**
 * Bind auto-PiP to a video element. Returns a cleanup function; the helper
 * also calls cleanup automatically on the next pagehide. Calling bindAutoPip
 * a second time tears down the previous binding first.
 *
 * No-op when window.AndroidPip.setAutoEnter is missing (older app version,
 * desktop, web, iOS).
 */
export function bindAutoPip(videoEl: HTMLVideoElement): () => void {
  if (typeof window === "undefined") return () => {}
  if (!window.AndroidPip?.setAutoEnter) return () => {}

  if (activeCleanup) {
    activeCleanup()
    activeCleanup = null
  }

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

  videoEl.addEventListener("play", onPlaying)
  videoEl.addEventListener("playing", onPlaying)
  videoEl.addEventListener("pause", onPause)
  videoEl.addEventListener("ended", onEnded)
  videoEl.addEventListener("emptied", onEmptied)

  // Sync once for the case where bindAutoPip is called after the video has
  // already started (e.g. resume from saved position).
  if (!videoEl.paused && !videoEl.ended) set(true)

  const cleanup = () => {
    set(false)
    videoEl.removeEventListener("play", onPlaying)
    videoEl.removeEventListener("playing", onPlaying)
    videoEl.removeEventListener("pause", onPause)
    videoEl.removeEventListener("ended", onEnded)
    videoEl.removeEventListener("emptied", onEmptied)
    window.removeEventListener("pagehide", cleanup)
    if (activeCleanup === cleanup) activeCleanup = null
  }
  window.addEventListener("pagehide", cleanup)
  activeCleanup = cleanup
  return cleanup
}
