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

export type StartFailureKind = "hevc" | "codec" | "audio" | "unknown"

export interface StartFailureVerdict {
  kind: StartFailureKind
  /** Actual codec string when the engine reported one; null when inferred. */
  codec: string | null
}

// Chromium/WebView2 MSE never ships AC-3, E-AC-3, MP2, or DTS audio decoders
// (licensing), so these fail the same way regardless of the video codec.
function classifyAudioCodec(
  codec: string | null | undefined
): "ac3" | "eac3" | "mp2" | "dts" | null {
  const normalized = codec?.trim().toLowerCase()
  if (!normalized) return null
  if (/^(?:ec-3|eac3|mp4a\.a6)$/.test(normalized)) return "eac3"
  if (/^(?:ac-3|ac3|mp4a\.a5)$/.test(normalized)) return "ac3"
  // mp4a.69/mp4a.6b are RFC 6381 MP3 object types, natively decodable - not mp2.
  if (/^(?:mp2|mp2a)$/.test(normalized)) return "mp2"
  if (/^dts$/.test(normalized)) return "dts"
  return null
}

export function isUnsupportedAudioCodec(codec: string | null | undefined): boolean {
  return classifyAudioCodec(codec) !== null
}

export function describeAudioCodec(codec: string | null | undefined): string {
  switch (classifyAudioCodec(codec)) {
    case "ac3":
      return "Dolby Digital (AC-3)"
    case "eac3":
      return "Dolby Digital Plus (E-AC-3)"
    case "mp2":
      return "MPEG audio (MP2)"
    case "dts":
      return "DTS"
    default:
      return codec?.trim() || "?"
  }
}

// Proves a video codec is actually decodable rather than inferring it from
// the HEVC name check; used to avoid blaming a fine video codec for an
// unrelated (usually audio) decode failure.
export function videoCodecDecodable(codec: string | null | undefined): boolean {
  const trimmed = codec?.trim()
  if (!trimmed) return false
  try {
    const mediaSource = (globalThis as any).MediaSource || (globalThis as any).ManagedMediaSource
    if (!mediaSource?.isTypeSupported) return false
    return mediaSource.isTypeSupported(`video/mp4; codecs="${trimmed}"`) === true
  } catch {
    return false
  }
}

// Covers hls.js/mpegts.js codec errors, the dead-video watchdog signal, and shaka MEDIA/DRM failures.
const CODEC_ERROR_DETAIL_RX =
  /codec|decode|format.?unsupported|incompatible|drm|decrypt|eme|clearkey|license/i

// Chromium/WebView2 reports a rejected second addSourceBuffer() as a "limit of SourceBuffer objects" error, not a codec error.
const AUDIO_BUFFER_ERROR_RX = /addsourcebuffer|limit of sourcebuffer/i

// Our mpegts path adds the video buffer first, so this message always convicts the audio track.
const AUDIO_BUFFER_LIMIT_RX = /limit of sourcebuffer/i

export function classifyStartFailure(input: {
  videoCodec?: string | null
  audioCodec?: string | null
  errorDetail?: string | null
  nameHint?: boolean
  deviceHevc: boolean
}): StartFailureVerdict {
  const videoCodec = input.videoCodec?.trim() || null
  const errorDetail = input.errorDetail || ""
  const codecError = CODEC_ERROR_DETAIL_RX.test(errorDetail)
  const audioBufferError = AUDIO_BUFFER_ERROR_RX.test(errorDetail)
  const audioUnsupported = isUnsupportedAudioCodec(input.audioCodec)
  const videoIsHevc = !!videoCodec && isHevcCodecString(videoCodec)

  // A known-decodable video track shifts blame to the audio track instead.
  const videoPlayable = videoIsHevc ? input.deviceHevc : videoCodecDecodable(videoCodec)
  if (videoPlayable && (audioUnsupported || audioBufferError)) {
    return { kind: "audio", codec: input.audioCodec ?? null }
  }

  if (videoIsHevc) {
    if (!input.deviceHevc || codecError) return { kind: "hevc", codec: videoCodec }
    return { kind: "unknown", codec: videoCodec }
  }

  const nameSaysHevc = input.nameHint && !input.deviceHevc && !videoCodec

  if (codecError || audioBufferError) {
    if (AUDIO_BUFFER_LIMIT_RX.test(errorDetail)) return { kind: "audio", codec: input.audioCodec ?? null }
    if (nameSaysHevc) return { kind: "hevc", codec: null }
    if (audioUnsupported) return { kind: "audio", codec: input.audioCodec ?? null }
    if (videoCodec && videoCodecDecodable(videoCodec)) return { kind: "unknown", codec: videoCodec }
    return { kind: "codec", codec: videoCodec }
  }
  if (nameSaysHevc) return { kind: "hevc", codec: null }
  if (audioUnsupported) return { kind: "audio", codec: input.audioCodec ?? null }
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
