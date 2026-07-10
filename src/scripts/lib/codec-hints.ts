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

// RFC 6381 codec strings as reported by hls.js (BUFFER_CODECS), mpegts.js
// (MEDIA_INFO) or an HLS manifest CODECS attribute: "hvc1.1.6.L120.B0",
// "hev1.2.4.L153", occasionally a bare "hevc"/"h265" label.
const HEVC_CODEC_STRING_RX = /^(?:hev1|hvc1|hevc|h265)\b|^(?:hev1|hvc1)\./i

export function isHevcCodecString(codec: string | null | undefined): boolean {
  if (!codec) return false
  return HEVC_CODEC_STRING_RX.test(codec.trim())
}

/** Pick the first HEVC entry out of a CODECS attribute list ("hvc1...,mp4a..."). */
export function findHevcInCodecList(codecs: string | null | undefined): string | null {
  if (!codecs) return null
  for (const part of codecs.split(",")) {
    const codec = part.trim()
    if (isHevcCodecString(codec)) return codec
  }
  return null
}

export type StartFailureKind = "hevc" | "codec" | "unknown"

export interface StartFailureVerdict {
  kind: StartFailureKind
  /** Actual codec string when the engine reported one; null when inferred. */
  codec: string | null
}

// Engine error details that point at a codec/format problem rather than a
// network one: hls.js bufferAddCodecError / bufferIncompatibleCodecsError,
// mpegts.js CodecUnsupported / FormatUnsupported, the synthetic
// "videoDecodeFailure" from the dead-video watchdog (track present, audio
// playing, zero frames ever decoded), and shaka.util.Error MEDIA/DRM category
// failures (decode, ClearKey/EME license errors) for MPEG-DASH.
const CODEC_ERROR_DETAIL_RX =
  /codec|decode|format.?unsupported|incompatible|drm|decrypt|eme|clearkey|license/i

export function classifyStartFailure(input: {
  videoCodec?: string | null
  errorDetail?: string | null
  nameHint?: boolean
  deviceHevc: boolean
}): StartFailureVerdict {
  const videoCodec = input.videoCodec?.trim() || null
  const codecError = CODEC_ERROR_DETAIL_RX.test(input.errorDetail || "")

  if (videoCodec && isHevcCodecString(videoCodec)) {
    if (!input.deviceHevc || codecError) return { kind: "hevc", codec: videoCodec }
    return { kind: "unknown", codec: videoCodec }
  }

  const nameSaysHevc = input.nameHint && !input.deviceHevc && !videoCodec
  if (codecError) {
    if (nameSaysHevc) return { kind: "hevc", codec: null }
    return { kind: "codec", codec: videoCodec }
  }
  if (nameSaysHevc) return { kind: "hevc", codec: null }
  return { kind: "unknown", codec: videoCodec }
}

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

let cachedClearKey: Promise<boolean> | null = null

// EME ClearKey (org.w3.clearkey) is present in Chromium WebViews (Android /
// WebView2 / WKWebView) but absent in WebKitGTK, where DASH+ClearKey can't
// play in-app and must fall back to an external player.
export function clearKeyAvailable(): Promise<boolean> {
  if (cachedClearKey) return cachedClearKey
  cachedClearKey = (async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.requestMediaKeySystemAccess) {
        return false
      }
      await navigator.requestMediaKeySystemAccess("org.w3.clearkey", [
        {
          initDataTypes: ["cenc"],
          videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
        },
      ])
      return true
    } catch {
      return false
    }
  })()
  return cachedClearKey
}
