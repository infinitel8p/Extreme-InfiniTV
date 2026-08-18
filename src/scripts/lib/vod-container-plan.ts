// Pure routing decision for MKV/AVI VOD playback: WebKit (macOS/Linux) can't demux Matroska/AVI at
// all (always remux); Windows WebView2's Chromium demuxer plays many MKVs directly but lacks HEVC
// and reliable Dolby (AC-3/E-AC-3) audio, so it only remuxes once forceRemux proves a file needs it.

export type VodContainer = "mkv" | "avi"

export type VodContainerPlan =
  | { mode: "direct" }
  | { mode: "remux" }
  | { mode: "unsupported"; container: VodContainer }

export interface VodContainerPlanEnv {
  isTauriDesktop: boolean
  isWindows: boolean
  remuxAvailable: boolean
  /** A previous direct-playback attempt for this exact file already failed to demux; retry through the remux proxy. */
  forceRemux: boolean
}

/** Extension sniff, query-safe and case-insensitive; only trusts http(s) URLs. */
export function detectVodContainer(url: string): VodContainer | null {
  if (typeof url !== "string" || !url) return null
  let pathname: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    pathname = parsed.pathname
  } catch {
    return null
  }
  const lowerPathname = pathname.toLowerCase()
  if (lowerPathname.endsWith(".mkv")) return "mkv"
  if (lowerPathname.endsWith(".avi")) return "avi"
  return null
}

/** Extension sniff for a local on-disk path rather than a URL: the asset.localhost/asset:// mount URL the player actually uses doesn't reliably parse as http(s). */
export function detectVodContainerFromLocalPath(path: string): VodContainer | null {
  if (typeof path !== "string" || !path) return null
  const lowerPath = path.toLowerCase()
  if (lowerPath.endsWith(".mkv")) return "mkv"
  if (lowerPath.endsWith(".avi")) return "avi"
  return null
}

function planFromContainer(
  container: VodContainer | null,
  env: VodContainerPlanEnv,
): VodContainerPlan {
  if (!env.isTauriDesktop) return { mode: "direct" }
  if (!container) return { mode: "direct" }
  // MPEG-4 Part 2 (the usual AVI payload) has no MSE remux path either - remuxing to TS wouldn't
  // make it decodable, so there is no forceRemux escape hatch for AVI like there is for MKV.
  if (container === "avi") return { mode: "unsupported", container: "avi" }
  if (env.isWindows && !env.forceRemux) return { mode: "direct" }
  return env.remuxAvailable ? { mode: "remux" } : { mode: "unsupported", container: "mkv" }
}

export function planVodContainerPlayback(url: string, env: VodContainerPlanEnv): VodContainerPlan {
  return planFromContainer(detectVodContainer(url), env)
}

/** Same routing decision as `planVodContainerPlayback`, sourced from a local download's on-disk path. */
export function planLocalVodContainerPlayback(
  localPath: string,
  env: VodContainerPlanEnv,
): VodContainerPlan {
  return planFromContainer(detectVodContainerFromLocalPath(localPath), env)
}

/** `detail` is ffmpeg's stderr tail forwarded from Rust; an HTTP failure means the source is the problem, not the container. */
export function isUpstreamHttpFailure(detail: string): boolean {
  if (typeof detail !== "string") return false
  return /HTTP error (4\d\d|5\d\d)/.test(detail) || /Server returned (4\d\d|5\d\d)/.test(detail)
}
