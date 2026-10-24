// Global subtitle size model shared by every player backend.

export type SubtitleScale = "small" | "normal" | "large" | "xlarge"

export const SUBTITLE_SCALE_SIZES: readonly SubtitleScale[] = ["small", "normal", "large", "xlarge"]

export const DEFAULT_SUBTITLE_SCALE: SubtitleScale = "normal"

const FACTOR_BY_SCALE: Record<SubtitleScale, number> = { small: 0.8, normal: 1, large: 1.25, xlarge: 1.5 }

const STYLE_ELEMENT_ID = "xt-subtitle-scale-style"

export function subtitleScaleFactor(size: SubtitleScale): number {
  return FACTOR_BY_SCALE[size] ?? FACTOR_BY_SCALE[DEFAULT_SUBTITLE_SCALE]
}

export function normalizeSubtitleScale(raw: unknown): SubtitleScale {
  return (SUBTITLE_SCALE_SIZES as readonly unknown[]).includes(raw) ? (raw as SubtitleScale) : DEFAULT_SUBTITLE_SCALE
}

export function subtitleCueStyleCss(size: SubtitleScale): string {
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

export function applySubtitleScaleStyle(size: SubtitleScale): void {
  if (typeof document === "undefined") return
  let style = document.getElementById(STYLE_ELEMENT_ID)
  if (!style) {
    style = document.createElement("style")
    style.id = STYLE_ELEMENT_ID
    document.head.appendChild(style)
  }
  style.textContent = subtitleCueStyleCss(size)
}

// video.js has no 0.8 option and parses "1.00" to null, so drive the select directly.
const VIDEOJS_FONT_PERCENT_OPTION: Record<SubtitleScale, string> = {
  small: "0.75",
  normal: "1.00",
  large: "1.25",
  xlarge: "1.50",
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
