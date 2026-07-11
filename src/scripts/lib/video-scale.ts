// Embedded-player display mode: fit (backend default), fill, zoom, or
// a forced 16:9 / 4:3 box. All three embedded backends (videojs, artplayer,
// shaka) end up with a plain <video> inside the container `mountPlayer` hands
// back via `handle.el()`. Geometry is applied through an injected stylesheet
// rather than inline styles so backends can't clobber it (see below).

export type VideoScaleMode = "fit" | "fill" | "zoom" | "16:9" | "4:3"

export const VIDEO_SCALE_MODES: VideoScaleMode[] = ["fit", "fill", "zoom", "16:9", "4:3"]

export function normalizeVideoScale(value: unknown): VideoScaleMode {
  return (VIDEO_SCALE_MODES as string[]).includes(value as string)
    ? (value as VideoScaleMode)
    : "fit"
}

export interface ForcedRatioBox {
  width: number
  height: number
  left: number
  top: number
}

/** Largest box of the given aspect ratio (width / height) centered inside the container. */
export function computeForcedRatioBox(
  containerWidth: number,
  containerHeight: number,
  ratio: number,
): ForcedRatioBox {
  const safeWidth = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 0
  const safeHeight = Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 0
  if (!Number.isFinite(ratio) || ratio <= 0 || safeWidth <= 0 || safeHeight <= 0) {
    return { width: safeWidth, height: safeHeight, left: 0, top: 0 }
  }

  const containerRatio = safeWidth / safeHeight
  let width: number
  let height: number
  if (containerRatio > ratio) {
    height = safeHeight
    width = height * ratio
  } else {
    width = safeWidth
    height = width / ratio
  }
  return {
    width,
    height,
    left: (safeWidth - width) / 2,
    top: (safeHeight - height) / 2,
  }
}

function ratioForMode(mode: VideoScaleMode): number | null {
  if (mode === "16:9") return 16 / 9
  if (mode === "4:3") return 4 / 3
  return null
}

// Backends (artplayer especially) re-apply their own inline styles on the
// <video> at arbitrary times (fullscreen enter/exit, debounced resize), so we
// drive geometry from an injected stylesheet whose !important rules beat those
// inline styles, keyed off a data attribute + CSS variables on the container.
const SCALE_ATTR = "data-xt-video-scale"
const STYLE_ELEMENT_ID = "xt-video-scale-style"

function ensureStyleInjected(): void {
  if (typeof document === "undefined") return
  if (document.getElementById(STYLE_ELEMENT_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ELEMENT_ID
  style.textContent = `
[${SCALE_ATTR}="fill"] video { object-fit: fill !important; width: 100% !important; height: 100% !important; }
[${SCALE_ATTR}="zoom"] video { object-fit: cover !important; width: 100% !important; height: 100% !important; }
[${SCALE_ATTR}="ratio"] video {
  position: absolute !important;
  object-fit: fill !important;
  inset: auto !important;
  margin: 0 !important;
  left: var(--xt-video-scale-left, 0) !important;
  top: var(--xt-video-scale-top, 0) !important;
  width: var(--xt-video-scale-width, 100%) !important;
  height: var(--xt-video-scale-height, 100%) !important;
}
`
  document.head.appendChild(style)
}

export interface VideoScaleController {
  apply(mode: VideoScaleMode): void
  dispose(): void
}

export function createVideoScaleController(
  getContainer: () => HTMLElement | null,
): VideoScaleController {
  let resizeObserver: ResizeObserver | null = null
  let observedBlock: HTMLElement | null = null
  let fullscreenListener: (() => void) | null = null
  let pendingFrame: number | null = null

  function teardownWatchers(): void {
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame)
      pendingFrame = null
    }
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
    observedBlock = null
    if (fullscreenListener) {
      document.removeEventListener("fullscreenchange", fullscreenListener)
      window.removeEventListener("resize", fullscreenListener)
      fullscreenListener = null
    }
  }

  function clear(container: HTMLElement): void {
    teardownWatchers()
    container.removeAttribute(SCALE_ATTR)
    container.style.removeProperty("--xt-video-scale-left")
    container.style.removeProperty("--xt-video-scale-top")
    container.style.removeProperty("--xt-video-scale-width")
    container.style.removeProperty("--xt-video-scale-height")
  }

  function apply(mode: VideoScaleMode): void {
    const container = getContainer()
    if (!container) return
    ensureStyleInjected()
    clear(container)

    if (mode === "fit") return

    if (mode === "fill" || mode === "zoom") {
      container.setAttribute(SCALE_ATTR, mode)
      return
    }

    const ratio = ratioForMode(mode)
    if (!ratio) return
    container.setAttribute(SCALE_ATTR, "ratio")

    // The forced-ratio box must be measured against the video's actual
    // containing block (its offsetParent), which is the inner backend element
    // that resizes on fullscreen - not necessarily the container el() returns.
    resizeObserver = new ResizeObserver(updateBox)
    resizeObserver.observe(container)

    function updateBox(): void {
      const video = container.querySelector("video")
      if (!video) return
      const block = (video.offsetParent as HTMLElement | null) ?? container
      if (block !== container && block !== observedBlock) {
        if (observedBlock) resizeObserver?.unobserve(observedBlock)
        resizeObserver?.observe(block)
        observedBlock = block
      }
      const box = computeForcedRatioBox(block.clientWidth, block.clientHeight, ratio)
      container.style.setProperty("--xt-video-scale-left", `${box.left}px`)
      container.style.setProperty("--xt-video-scale-top", `${box.top}px`)
      container.style.setProperty("--xt-video-scale-width", `${box.width}px`)
      container.style.setProperty("--xt-video-scale-height", `${box.height}px`)
    }
    updateBox()

    fullscreenListener = () => {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null
        updateBox()
      })
    }
    document.addEventListener("fullscreenchange", fullscreenListener)
    window.addEventListener("resize", fullscreenListener)
  }

  function dispose(): void {
    const container = getContainer()
    if (container) clear(container)
    else teardownWatchers()
  }

  return { apply, dispose }
}
