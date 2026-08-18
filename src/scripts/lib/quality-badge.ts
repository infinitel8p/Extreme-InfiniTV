// Live playback quality chip: an auto-hiding overlay pill on the player edge
// that announces the current stream's rendition ("1080p", "720p", ...) for a
// few seconds whenever it changes. Reads the mounted <video> element's decoded
// dimensions directly - no probing, no network cost - and stays quiet whenever
// dimensions aren't known yet (external players, audio-only/radio channels,
// pre-metadata) or haven't changed since the last time it was shown.

// Checked high to low; effective height >= threshold wins.
const QUALITY_THRESHOLDS: [number, string][] = [
  [2100, "2160p"],
  [1380, "1440p"],
  [1000, "1080p"],
  [690, "720p"],
  [540, "576p"],
  [440, "480p"],
  [330, "360p"],
  [200, "240p"],
]

export function qualityLabel(
  videoWidth: number | null | undefined,
  videoHeight: number | null | undefined
): string | null {
  if (typeof videoWidth !== "number" || typeof videoHeight !== "number") return null
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight)) return null
  if (videoWidth <= 0 || videoHeight <= 0) return null

  // Letterboxed/anamorphic sources (e.g. 1920x800 cinemascope) report a
  // short height relative to their width - classify by the 16:9-equivalent
  // height instead so those still land in the bucket their width implies.
  // Orient by long/short side, not width/height, so portrait feeds (e.g. 608x1080) aren't inflated.
  const longSide = Math.max(videoWidth, videoHeight)
  const shortSide = Math.min(videoWidth, videoHeight)
  const effectiveHeight = Math.max(shortSide, Math.round((longSide * 9) / 16))

  for (const [threshold, label] of QUALITY_THRESHOLDS) {
    if (effectiveHeight >= threshold) return label
  }
  return null
}

export interface QualityBadgeHandle {
  getMediaElement?: () => HTMLVideoElement | null
}

const DEFAULT_VISIBLE_MS = 3000
const LEAVE_MS = 200

/**
 * Wires an auto-hiding `.quality-chip` overlay (top-right corner of
 * `playerWrap`) to the live rendition of the mounted <video>. The chip is
 * built and torn down entirely inside this function - no dependency on the
 * caller having created a badge element up front, which is what let the old
 * `.quality-badge` row pill go missing on reused players (its DOM node was
 * built inside an async `document.startViewTransition()` callback that could
 * still be pending when attach ran). Returns a detach function.
 */
export function attachQualityChip(
  playerWrap: HTMLElement,
  handle: QualityBadgeHandle,
  options?: { visibleMs?: number }
): () => void {
  const videoEl = handle.getMediaElement?.() ?? null
  if (!videoEl) return () => {}

  const visibleMs = options?.visibleMs ?? DEFAULT_VISIBLE_MS
  let lastShownLabel: string | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let removeTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimers(): void {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (removeTimer) {
      clearTimeout(removeTimer)
      removeTimer = null
    }
  }

  function removeChip(): void {
    playerWrap.querySelector("[data-quality-chip]")?.remove()
  }

  // The stats overlay node is built eagerly by `attachPlayerInsights` and stays
  // in the DOM for the whole session, hidden via the `hidden` attribute - so
  // presence alone says nothing. Only a *visible* overlay occupies this corner.
  function statsOverlayVisible(): boolean {
    const overlay = playerWrap.querySelector<HTMLElement>(".stats-overlay")
    if (!overlay) return false
    return !overlay.hidden && overlay.style.display !== "none"
  }

  function showChip(label: string): void {
    // A visible stats overlay already occupies this corner - don't stack two pills there.
    if (statsOverlayVisible()) return

    let chipEl = playerWrap.querySelector<HTMLElement>("[data-quality-chip]")
    if (!chipEl) {
      chipEl = document.createElement("div")
      chipEl.dataset.qualityChip = ""
      chipEl.className = "quality-chip"
      chipEl.setAttribute("role", "status")
      chipEl.setAttribute("aria-live", "polite")
      playerWrap.appendChild(chipEl)
    }
    chipEl.classList.remove("is-leaving")
    chipEl.textContent = label

    clearTimers()
    hideTimer = setTimeout(() => {
      chipEl.classList.add("is-leaving")
      hideTimer = null
      removeTimer = setTimeout(() => {
        chipEl.remove()
        removeTimer = null
      }, LEAVE_MS)
    }, visibleMs)
  }

  function update(): void {
    const label = qualityLabel(videoEl!.videoWidth, videoEl!.videoHeight)
    if (label && label !== lastShownLabel) {
      lastShownLabel = label
      showChip(label)
    }
  }

  function reset(): void {
    clearTimers()
    removeChip()
    lastShownLabel = null
  }

  videoEl.addEventListener("resize", update)
  videoEl.addEventListener("loadedmetadata", update)
  videoEl.addEventListener("emptied", reset)
  update()

  return () => {
    videoEl.removeEventListener("resize", update)
    videoEl.removeEventListener("loadedmetadata", update)
    videoEl.removeEventListener("emptied", reset)
    clearTimers()
    removeChip()
  }
}
