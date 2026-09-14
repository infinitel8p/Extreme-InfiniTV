// Pure mapping from a receiver error code/sentence to user-facing copy, shared by the pill and remote.

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

const KNOWN_ERROR_KEYS: Record<string, string> = {
  "app-not-foreground": "cast.toast.wakeFailed",
  "bad-descriptor": "receiver.error.rejected",
  "play-failed": "receiver.error.rejected",
  "player-unavailable": "receiver.error.notReady",
}

function mappedCastErrorText(error: string, deviceName: string, t: TranslateFn): string | null {
  const key = KNOWN_ERROR_KEYS[error]
  if (!key) return null
  return key === "cast.toast.wakeFailed" ? t(key, { device: deviceName }) : t(key)
}

/** Remote's inline error line: known codes translate, anything else is already a human sentence from the receiver. */
export function castErrorInlineText(error: string | null | undefined, deviceName: string, t: TranslateFn): string {
  if (!error) return t("cast.remote.errorGeneric")
  return mappedCastErrorText(error, deviceName, t) ?? t("cast.remote.errorDetail", { detail: error })
}

/** Pill's toast title: same known-code mapping, an unknown sentence renders through the playback-error toast. */
export function castErrorToastTitle(error: string | null | undefined, deviceName: string, t: TranslateFn): string {
  if (!error) return t("cast.toast.failed", { device: deviceName })
  return mappedCastErrorText(error, deviceName, t) ?? t("cast.toast.playbackError", { device: deviceName, error })
}
