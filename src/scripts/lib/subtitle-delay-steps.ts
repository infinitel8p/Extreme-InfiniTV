export const SUBTITLE_DELAY_STEPS_MS = [-500, -250, -100, 100, 250, 500]

type Translate = (key: string, params?: Record<string, string | number>) => string

function signedMs(milliseconds: number): string {
  return `${milliseconds >= 0 ? "+" : ""}${milliseconds}`
}

export function formatDelayStepLabel(deltaMs: number, t: Translate): string {
  return t("player.mpv.subtitleDelay.value", { ms: signedMs(deltaMs) })
}

export function formatDelayValue(seconds: number, t: Translate): string {
  return t("player.mpv.subtitleDelay.value", { ms: signedMs(Math.round(seconds * 1000)) })
}
