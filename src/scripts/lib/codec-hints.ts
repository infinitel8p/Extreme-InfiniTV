// Name-based codec detection. Providers commonly tag HEVC channels in the
// channel name ("HEVC", "H.265", "x265", and the occasional "HVEC" typo).
// The embedded player decodes via MSE, which only supports HEVC when the
// platform ships a licensed decoder - so these channels usually need MPV/VLC.
const HEVC_NAME_RX = /(?:\bhevc\b|\bhvec\b|\bh\.?\s?265\b|\bx\.?265\b)/i

export function hasHevcNameHint(name: string | null | undefined): boolean {
  if (!name) return false
  return HEVC_NAME_RX.test(name)
}

const HEVC_TEST_CODECS = [
  'video/mp4; codecs="hvc1.1.6.L123.B0"',
  'video/mp4; codecs="hev1.1.6.L123.B0"',
]

let cachedHevcSupport: boolean | null = null

// MSE first (mpegts.js / hls.js remux HEVC into fMP4), then native canPlayType
// for WebViews that play HLS natively (macOS WKWebView).
export function deviceSupportsHevc(): boolean {
  if (cachedHevcSupport !== null) return cachedHevcSupport
  let supported = false
  try {
    const mediaSource =
      (globalThis as any).MediaSource || (globalThis as any).ManagedMediaSource
    supported = HEVC_TEST_CODECS.some(
      (codec) => mediaSource?.isTypeSupported?.(codec) === true
    )
    if (!supported && typeof document !== "undefined") {
      const probe = document.createElement("video")
      supported = HEVC_TEST_CODECS.some((codec) => probe.canPlayType(codec) !== "")
    }
  } catch {
    supported = false
  }
  cachedHevcSupport = supported
  return supported
}
