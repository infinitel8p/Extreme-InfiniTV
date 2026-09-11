// Pure sizing/URL helpers for the downscale-and-cache image pipeline.

// "backdrop-hero" is the TV home hero band's own real-backdrop cache class: the band
// never renders taller than ~40vh, so a full 1280px "backdrop" decode is wasted memory.
export type ImgKind = "logo" | "poster" | "backdrop" | "backdrop-hero"

export const IMG_KIND_MAX_DIM: Record<ImgKind, number> = {
  logo: 128,
  poster: 576,
  backdrop: 1280,
  "backdrop-hero": 720,
}

const LITE_POSTER_MAX_DIM = 320

/** Tier-aware max dimension: the lite tier keeps posters smaller to bound decode memory. */
export function imgKindMaxDim(kind: ImgKind, isLite: boolean): number {
  if (isLite && kind === "poster") return LITE_POSTER_MAX_DIM
  return IMG_KIND_MAX_DIM[kind]
}

export function scaleToFit(
  width: number,
  height: number,
  maxDim: number
): { width: number; height: number } | null {
  if (
    !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(maxDim) ||
    width <= 0 || height <= 0 || maxDim <= 0
  ) {
    return null
  }
  if (width <= maxDim && height <= maxDim) return null
  const scale = maxDim / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function imgCacheKey(kind: ImgKind, url: string): string {
  return `${kind}:${url}`
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"])

export function isCacheableImageUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const hostname = parsed.hostname.toLowerCase()
  if (LOCAL_HOSTS.has(hostname)) return false
  if (hostname === "asset.localhost" || hostname.endsWith(".localhost")) return false
  return true
}
