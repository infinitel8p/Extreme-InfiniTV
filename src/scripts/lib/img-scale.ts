// Pure sizing/URL helpers for the downscale-and-cache image pipeline.

export type ImgKind = "logo" | "poster"

export const IMG_KIND_MAX_DIM: Record<ImgKind, number> = { logo: 128, poster: 576 }

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
