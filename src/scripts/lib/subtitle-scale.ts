// Global subtitle size model shared by every player backend.

export type SubtitleScale = "small" | "normal" | "large" | "xlarge" | "huge"

export const SUBTITLE_SCALE_SIZES: readonly SubtitleScale[] = ["small", "normal", "large", "xlarge", "huge"]

export const SUBTITLE_SCALE_LABEL_KEYS: Record<SubtitleScale, string> = {
  small: "player.mpv.subtitleStyle.sizeSmall",
  normal: "player.mpv.subtitleStyle.sizeNormal",
  large: "player.mpv.subtitleStyle.sizeLarge",
  xlarge: "player.mpv.subtitleStyle.sizeXLarge",
  huge: "player.mpv.subtitleStyle.sizeHuge",
}

export const DEFAULT_SUBTITLE_SCALE: SubtitleScale = "normal"

const FACTOR_BY_SCALE: Record<SubtitleScale, number> = { small: 0.8, normal: 1, large: 1.3, xlarge: 1.6, huge: 2 }

export const SUBTITLE_CUE_HEIGHT_RATIO = 0.05
const MIN_CUE_PX = 14
const MAX_CUE_PX = 200

// Mirrors SUBTITLE_SCALE_EVENT in app-settings.js (which imports this module).
const SCALE_CHANGED_EVENT = "xt:subtitle-scale-changed"
const STYLE_ELEMENT_ID = "xt-subtitle-scale-style"

export function subtitleScaleFactor(size: SubtitleScale): number {
  return FACTOR_BY_SCALE[size] ?? FACTOR_BY_SCALE[DEFAULT_SUBTITLE_SCALE]
}

export function normalizeSubtitleScale(raw: unknown): SubtitleScale {
  return (SUBTITLE_SCALE_SIZES as readonly unknown[]).includes(raw) ? (raw as SubtitleScale) : DEFAULT_SUBTITLE_SCALE
}

export function subtitleCuePx(size: SubtitleScale, videoHeightPx: number): number {
  const raw = subtitleScaleFactor(size) * videoHeightPx * SUBTITLE_CUE_HEIGHT_RATIO
  return Math.round(Math.min(MAX_CUE_PX, Math.max(MIN_CUE_PX, raw)))
}

export function subtitleCueStyleCss(size: SubtitleScale, videoHeightPx?: number): string {
  if (videoHeightPx && videoHeightPx > 0) return `video::cue { font-size: ${subtitleCuePx(size, videoHeightPx)}px; }`
  return `video::cue { font-size: ${Math.round(subtitleScaleFactor(size) * 100)}%; }`
}

export function migrateSubtitleScale(rawScale: string | null, rawMpvStyle: string | null): SubtitleScale {
  if (rawScale && (SUBTITLE_SCALE_SIZES as readonly string[]).includes(rawScale)) return rawScale as SubtitleScale
  if (!rawMpvStyle) return DEFAULT_SUBTITLE_SCALE
  try {
    return normalizeSubtitleScale(JSON.parse(rawMpvStyle)?.size)
  } catch {
    return DEFAULT_SUBTITLE_SCALE
  }
}

export function applySubtitleScaleStyle(size: SubtitleScale, videoHeightPx?: number): void {
  if (typeof document === "undefined") return
  let style = document.getElementById(STYLE_ELEMENT_ID)
  if (!style) {
    style = document.createElement("style")
    style.id = STYLE_ELEMENT_ID
    document.head.appendChild(style)
  }
  style.textContent = subtitleCueStyleCss(size, videoHeightPx)
}

function readVideoHeight(video: HTMLVideoElement): number {
  return video.getBoundingClientRect().height || video.clientHeight || 0
}

export function observeSubtitleScale(video: HTMLVideoElement, getSize: () => SubtitleScale): () => void {
  if (typeof document === "undefined") return () => {}
  const apply = () => applySubtitleScaleStyle(getSize(), readVideoHeight(video))
  apply()
  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(apply)
    resizeObserver.observe(video)
  } else if (typeof window !== "undefined") {
    window.addEventListener("resize", apply)
  }
  document.addEventListener("fullscreenchange", apply)
  document.addEventListener("webkitfullscreenchange", apply)
  document.addEventListener(SCALE_CHANGED_EVENT, apply)
  return () => {
    resizeObserver?.disconnect()
    if (!resizeObserver && typeof window !== "undefined") window.removeEventListener("resize", apply)
    document.removeEventListener("fullscreenchange", apply)
    document.removeEventListener("webkitfullscreenchange", apply)
    document.removeEventListener(SCALE_CHANGED_EVENT, apply)
  }
}

// video.js has no 0.8 option and parses "1.00" to null, so drive the select directly.
const VIDEOJS_FONT_PERCENT_OPTION: Record<SubtitleScale, string> = {
  small: "0.75",
  normal: "1.00",
  large: "1.25",
  xlarge: "1.50",
  huge: "2.00",
}

export function applyVideoJsSubtitleScale(player: any, size: SubtitleScale): void {
  try {
    const settings = player?.textTrackSettings
    if (!settings) return
    const select: HTMLSelectElement | null =
      settings.$?.(".vjs-font-percent > select") ?? settings.el?.()?.querySelector?.(".vjs-font-percent > select") ?? null
    if (!select) return
    select.value = VIDEOJS_FONT_PERCENT_OPTION[size] ?? VIDEOJS_FONT_PERCENT_OPTION[DEFAULT_SUBTITLE_SCALE]
    select.dispatchEvent(new Event("change"))
    settings.updateDisplay?.()
  } catch {
    // settings component absent
  }
}
