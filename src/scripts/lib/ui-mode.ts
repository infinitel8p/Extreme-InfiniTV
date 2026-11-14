// Device-local choice between the TV and classic UI on non-TV devices.

export const UI_MODE_KEY = "xt_ui_mode"

export type UiMode = "auto" | "tv" | "desktop"

export function parseUiMode(raw: string | null | undefined): UiMode {
  return raw === "tv" || raw === "desktop" ? raw : "auto"
}

interface ResolveUiModeInput {
  stored: string | null | undefined
  realTv: boolean
  detectedTv: boolean
  appMode?: string
}

/** Callers must short-circuit kiosk (`appMode === "receiver"`) before this; it always resolves "tv" there. */
export function resolveUiMode(input: ResolveUiModeInput): "tv" | "classic" {
  if (input.appMode === "receiver") return "tv"
  if (input.realTv) return "tv"
  const mode = parseUiMode(input.stored)
  if (mode === "tv") return "tv"
  if (mode === "desktop") return "classic"
  return input.detectedTv ? "tv" : "classic"
}

export function getUiMode(): UiMode {
  try {
    return parseUiMode(localStorage.getItem(UI_MODE_KEY))
  } catch {
    return "auto"
  }
}

export function setUiMode(mode: UiMode): void {
  try {
    localStorage.setItem(UI_MODE_KEY, mode)
  } catch {
    return
  }
}
