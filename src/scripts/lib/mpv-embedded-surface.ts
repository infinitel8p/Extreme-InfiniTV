// Pure reducer deciding the mpv-embedded hole/placeholder state from the native surface report.

export type MpvSurfaceNativeState = "hidden" | "embedded" | "fullscreen" | "pip"

export type MpvSurfacePlaceholder = "none" | "loading" | "pip"

export interface MpvSurfaceReducerInput {
  nativeState: MpvSurfaceNativeState
  revealed: boolean
  pageBounds: boolean
  loading: boolean
}

export interface MpvSurfaceReducerResult {
  holeOpen: boolean
  placeholder: MpvSurfacePlaceholder
}

export function computeMpvSurface(input: MpvSurfaceReducerInput): MpvSurfaceReducerResult {
  const holeOpen =
    (input.nativeState === "embedded" || input.nativeState === "fullscreen") &&
    input.revealed &&
    input.pageBounds
  const placeholder: MpvSurfacePlaceholder =
    input.nativeState === "pip" ? "pip" : !input.revealed && input.loading ? "loading" : "none"
  return { holeOpen, placeholder }
}
