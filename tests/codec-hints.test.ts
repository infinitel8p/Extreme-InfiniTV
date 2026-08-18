import { describe, expect, it } from "vitest"
import {
  hasHevcNameHint,
  isHevcCodecString,
  findHevcInCodecList,
  classifyStartFailure,
  clearKeyAvailable,
  isUnsupportedAudioCodec,
  describeAudioCodec,
  isMpegAudioCodecString,
  isMseAudioClockWedge,
  isDroppingEveryFrame,
  chooseBlackFrameRecovery,
  NATIVE_RELATCH_MAX_ATTEMPTS,
  chromiumMajorFromUserAgent,
} from "../src/scripts/lib/codec-hints"

describe("hasHevcNameHint", () => {
  it("matches common HEVC tags in channel names", () => {
    expect(hasHevcNameHint("Sky Documentaries -HD (Local) ''hevc h.265''")).toBe(true)
    expect(hasHevcNameHint("BBC One FHD HEVC")).toBe(true)
    expect(hasHevcNameHint("Canal+ Sport H.265")).toBe(true)
    expect(hasHevcNameHint("Discovery H265")).toBe(true)
    expect(hasHevcNameHint("TLC [x265]")).toBe(true)
    expect(hasHevcNameHint("RTL h 265")).toBe(true)
    expect(hasHevcNameHint("ZDF HVEC")).toBe(true)
    expect(hasHevcNameHint("arte (HEVC)")).toBe(true)
  })

  it("ignores names without an HEVC tag", () => {
    expect(hasHevcNameHint("BBC One FHD")).toBe(false)
    expect(hasHevcNameHint("Channel 265")).toBe(false)
    expect(hasHevcNameHint("US (MLS 046)")).toBe(false)
    expect(hasHevcNameHint("Hever Castle TV")).toBe(false)
    expect(hasHevcNameHint("")).toBe(false)
    expect(hasHevcNameHint(null)).toBe(false)
    expect(hasHevcNameHint(undefined)).toBe(false)
  })
})

describe("isHevcCodecString", () => {
  it("matches RFC 6381 HEVC codec strings", () => {
    expect(isHevcCodecString("hvc1.1.6.L120.B0")).toBe(true)
    expect(isHevcCodecString("hev1.2.4.L153.B0")).toBe(true)
    expect(isHevcCodecString("hvc1")).toBe(true)
    expect(isHevcCodecString("hevc")).toBe(true)
    expect(isHevcCodecString("h265")).toBe(true)
    expect(isHevcCodecString(" hvc1.1.6.L93.B0 ")).toBe(true)
  })

  it("ignores non-HEVC codec strings", () => {
    expect(isHevcCodecString("avc1.640028")).toBe(false)
    expect(isHevcCodecString("av01.0.08M.08")).toBe(false)
    expect(isHevcCodecString("mp4a.40.2")).toBe(false)
    expect(isHevcCodecString("")).toBe(false)
    expect(isHevcCodecString(null)).toBe(false)
    expect(isHevcCodecString(undefined)).toBe(false)
  })
})

describe("findHevcInCodecList", () => {
  it("picks the HEVC entry out of a CODECS attribute list", () => {
    expect(findHevcInCodecList("hvc1.1.6.L120.B0,mp4a.40.2")).toBe("hvc1.1.6.L120.B0")
    expect(findHevcInCodecList("mp4a.40.2, hev1.2.4.L153.B0")).toBe("hev1.2.4.L153.B0")
  })

  it("returns null when no HEVC entry exists", () => {
    expect(findHevcInCodecList("avc1.640028,mp4a.40.2")).toBe(null)
    expect(findHevcInCodecList("")).toBe(null)
    expect(findHevcInCodecList(null)).toBe(null)
  })
})

describe("classifyStartFailure", () => {
  it("confirms HEVC when the engine reported an HEVC codec the device can't decode", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.1.6.L120.B0",
        errorDetail: null,
        nameHint: false,
        deviceHevc: false,
      })
    ).toEqual({ kind: "hevc", codec: "hvc1.1.6.L120.B0" })
  })

  it("confirms HEVC when MSE rejected the codec even if the device probe claimed support", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hev1.2.4.L153.B0",
        errorDetail: "bufferIncompatibleCodecsError",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "hevc", codec: "hev1.2.4.L153.B0" })
  })

  it("does not blame HEVC when the device decodes it and nothing pointed at the codec", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.1.6.L120.B0",
        errorDetail: "manifestLoadError",
        nameHint: true,
        deviceHevc: true,
      })
    ).toEqual({ kind: "unknown", codec: "hvc1.1.6.L120.B0" })
  })

  it("reports a generic codec failure for non-HEVC codec rejections", () => {
    expect(
      classifyStartFailure({
        videoCodec: "ac-3",
        errorDetail: "bufferAddCodecError",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "codec", codec: "ac-3" })
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: "MediaMSEError: CodecUnsupported",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "codec", codec: null })
  })

  it("reports a parse failure when the demuxer choked on a decodable stream", () => {
    expect(
      classifyStartFailure({
        videoCodec: "avc1.64002a",
        audioCodec: null,
        errorDetail: "fragParsingError",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "parse", codec: "avc1.64002a" })
  })

  it("reports a parse failure for HEVC the device can decode", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.1.6.L120.B0",
        errorDetail: "fragParsingError",
        nameHint: true,
        deviceHevc: true,
      })
    ).toEqual({ kind: "parse", codec: "hvc1.1.6.L120.B0" })
  })

  it("keeps codec and audio verdicts ahead of a parse failure", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.1.6.L120.B0",
        errorDetail: "fragParsingError",
        nameHint: false,
        deviceHevc: false,
      })
    ).toEqual({ kind: "hevc", codec: "hvc1.1.6.L120.B0" })
    expect(
      classifyStartFailure({
        videoCodec: "avc1.64002a",
        audioCodec: "ac-3",
        errorDetail: "fragParsingError",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: "ac-3" })
  })

  it("falls back to the name hint only when the device lacks HEVC", () => {
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: null,
        nameHint: true,
        deviceHevc: false,
      })
    ).toEqual({ kind: "hevc", codec: null })
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: null,
        nameHint: true,
        deviceHevc: true,
      })
    ).toEqual({ kind: "unknown", codec: null })
  })

  it("ignores the name hint when the engine reported a non-HEVC codec", () => {
    expect(
      classifyStartFailure({
        videoCodec: "avc1.640028",
        errorDetail: null,
        nameHint: true,
        deviceHevc: false,
      })
    ).toEqual({ kind: "unknown", codec: "avc1.640028" })
    expect(
      classifyStartFailure({
        videoCodec: "avc1.640028",
        errorDetail: "bufferAddCodecError",
        nameHint: true,
        deviceHevc: false,
      })
    ).toEqual({ kind: "codec", codec: "avc1.640028" })
  })

  it("treats the dead-video watchdog detail as codec evidence", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.1.6.L120.B0",
        errorDetail: "videoDecodeFailure",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "hevc", codec: "hvc1.1.6.L120.B0" })
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: "videoDecodeFailure",
        nameHint: true,
        deviceHevc: false,
      })
    ).toEqual({ kind: "hevc", codec: null })
  })

  it("returns unknown for network-shaped failures", () => {
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: "manifestLoadTimeOut",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "unknown", codec: null })
  })

  it("reports codec for shaka DRM/EME/ClearKey error details on MPEG-DASH", () => {
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: "shaka:drm:6001 requested key system is not supported",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "codec", codec: null })
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: "shaka:drm ClearKey (EME org.w3.clearkey) unsupported in this WebView",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "codec", codec: null })
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: "shaka:codec browser unsupported (no MediaSource/EME)",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "codec", codec: null })
  })

  it("returns unknown for a shaka network error detail on MPEG-DASH", () => {
    expect(
      classifyStartFailure({
        videoCodec: null,
        errorDetail: "shaka:network:1002 HTTP error",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "unknown", codec: null })
  })

  it("blames unsupported AC-3/E-AC-3 audio instead of a decodable video codec", () => {
    expect(
      classifyStartFailure({
        videoCodec: "avc1.640028",
        audioCodec: "ac-3",
        errorDetail: "PIPELINE_ERROR_DECODE",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: "ac-3" })
    expect(
      classifyStartFailure({
        videoCodec: "avc1.640028",
        audioCodec: "mp4a.a5",
        errorDetail: "PIPELINE_ERROR_DECODE",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: "mp4a.a5" })
    expect(
      classifyStartFailure({
        videoCodec: "avc1.640028",
        audioCodec: "ec-3",
        errorDetail: "PIPELINE_ERROR_DECODE",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: "ec-3" })
  })

  it("still reports hevc when the video codec is HEVC, even with an unsupported audio codec present", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.1.6.L120.B0",
        audioCodec: "ac-3",
        errorDetail: "PIPELINE_ERROR_DECODE",
        nameHint: false,
        deviceHevc: false,
      })
    ).toEqual({ kind: "hevc", codec: "hvc1.1.6.L120.B0" })
  })

  it("blames unsupported audio (not the video) when the device decodes the HEVC video track", () => {
    // rtp2httpd MPEG-TS: HEVC video accepted, E-AC-3 audio SourceBuffer rejected.
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.2.1.L180.B0",
        audioCodec: "ec-3",
        errorDetail:
          "MediaMSEError: Failed to execute 'addSourceBuffer' on 'MediaSource': This MediaSource has reached the limit of SourceBuffer objects it can handle.",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: "ec-3" })
    // Same, but no engine error string reached classification (only media info survived).
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.2.1.L180.B0",
        audioCodec: "ec-3",
        errorDetail: null,
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: "ec-3" })
  })

  it("treats an audio SourceBuffer rejection as audio even without an audio codec string, when the video decodes", () => {
    expect(
      classifyStartFailure({
        videoCodec: "hvc1.2.1.L180.B0",
        audioCodec: null,
        errorDetail:
          "MediaMSEError: Failed to execute 'addSourceBuffer' on 'MediaSource': This MediaSource has reached the limit of SourceBuffer objects it can handle.",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: null })
  })

  it("treats the SourceBuffer-limit error as audio even when recovery remounts wiped both codec strings", () => {
    // Observed at give-up time: teardown churn cleared codecInfo, only the error string survived.
    // The limit message only fires for the second buffer and the mpegts path adds video first.
    expect(
      classifyStartFailure({
        videoCodec: null,
        audioCodec: null,
        errorDetail:
          "Failed to execute 'addSourceBuffer' on 'MediaSource': This MediaSource has reached the limit of SourceBuffer objects it can handle. No additional SourceBuffer objects may be added.",
        nameHint: false,
        deviceHevc: true,
      })
    ).toEqual({ kind: "audio", codec: null })
    // Even a name-based HEVC hint must not override it: the accepted first (video) buffer proves video decodes.
    expect(
      classifyStartFailure({
        videoCodec: null,
        audioCodec: null,
        errorDetail:
          "Failed to execute 'addSourceBuffer' on 'MediaSource': This MediaSource has reached the limit of SourceBuffer objects it can handle.",
        nameHint: true,
        deviceHevc: false,
      })
    ).toEqual({ kind: "audio", codec: null })
  })

  it("blames the audio track for a Chromium 151 audio/mpeg clock wedge when the video decodes", () => {
    const originalMediaSource = (globalThis as any).MediaSource
    ;(globalThis as any).MediaSource = { isTypeSupported: () => true }
    try {
      expect(
        classifyStartFailure({
          videoCodec: "avc1.640029",
          audioCodec: "mp3",
          errorDetail: null,
          nameHint: false,
          deviceHevc: true,
          audioClockWedge: true,
        })
      ).toEqual({ kind: "audio", codec: "mp3" })
    } finally {
      (globalThis as any).MediaSource = originalMediaSource
    }
  })
})

describe("isMpegAudioCodecString", () => {
  it("matches MPEG audio codec strings", () => {
    expect(isMpegAudioCodecString("mp3")).toBe(true)
    expect(isMpegAudioCodecString("mp2")).toBe(true)
    expect(isMpegAudioCodecString("MP2A")).toBe(true)
  })

  it("ignores AAC and empty codec strings", () => {
    expect(isMpegAudioCodecString("mp4a.40.2")).toBe(false)
    expect(isMpegAudioCodecString("mp4a.40.34")).toBe(false)
    expect(isMpegAudioCodecString(null)).toBe(false)
    expect(isMpegAudioCodecString("")).toBe(false)
  })
})

describe("isMseAudioClockWedge", () => {
  it("flags a stuck clock with buffered MPEG audio", () => {
    expect(
      isMseAudioClockWedge({ readyState: 1, currentTime: 0, bufferedEndSeconds: 12, audioCodec: "mp3" })
    ).toBe(true)
  })

  it("ignores playback that already advanced past HAVE_METADATA", () => {
    expect(
      isMseAudioClockWedge({ readyState: 2, currentTime: 0, bufferedEndSeconds: 12, audioCodec: "mp3" })
    ).toBe(false)
  })

  it("waits for enough buffered data before judging", () => {
    expect(
      isMseAudioClockWedge({ readyState: 1, currentTime: 0, bufferedEndSeconds: 0.5, audioCodec: "mp3" })
    ).toBe(false)
  })

  it("ignores a clock that has already moved", () => {
    expect(
      isMseAudioClockWedge({ readyState: 1, currentTime: 4, bufferedEndSeconds: 12, audioCodec: "mp3" })
    ).toBe(false)
  })

  it("ignores non-MPEG audio codecs", () => {
    expect(
      isMseAudioClockWedge({ readyState: 1, currentTime: 0, bufferedEndSeconds: 12, audioCodec: "mp4a.40.2" })
    ).toBe(false)
    expect(
      isMseAudioClockWedge({ readyState: 1, currentTime: 0, bufferedEndSeconds: 12, audioCodec: null })
    ).toBe(false)
  })
})

describe("chromiumMajorFromUserAgent", () => {
  it("extracts the Chromium major version from a Chrome/Edge user agent", () => {
    expect(
      chromiumMajorFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.4129.86"
      )
    ).toBe(151)
  })

  it("returns null for a user agent without a Chrome token", () => {
    expect(
      chromiumMajorFromUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      )
    ).toBe(null)
  })

  it("returns null for null or empty input", () => {
    expect(chromiumMajorFromUserAgent(null)).toBe(null)
    expect(chromiumMajorFromUserAgent("")).toBe(null)
  })
})

describe("isUnsupportedAudioCodec", () => {
  it("matches AC-3 / E-AC-3 / MP2 / DTS codec strings", () => {
    expect(isUnsupportedAudioCodec("ac-3")).toBe(true)
    expect(isUnsupportedAudioCodec("ac3")).toBe(true)
    expect(isUnsupportedAudioCodec("mp4a.a5")).toBe(true)
    expect(isUnsupportedAudioCodec("ec-3")).toBe(true)
    expect(isUnsupportedAudioCodec("eac3")).toBe(true)
    expect(isUnsupportedAudioCodec("mp4a.a6")).toBe(true)
    expect(isUnsupportedAudioCodec("mp2")).toBe(true)
    expect(isUnsupportedAudioCodec("mp2a")).toBe(true)
    expect(isUnsupportedAudioCodec("DTS")).toBe(true)
    expect(isUnsupportedAudioCodec(" ac-3 ")).toBe(true)
  })

  it("ignores decodable audio codecs", () => {
    expect(isUnsupportedAudioCodec("mp4a.40.2")).toBe(false)
    expect(isUnsupportedAudioCodec("mp4a.69")).toBe(false)
    expect(isUnsupportedAudioCodec("mp4a.6b")).toBe(false)
    expect(isUnsupportedAudioCodec("opus")).toBe(false)
    expect(isUnsupportedAudioCodec("")).toBe(false)
    expect(isUnsupportedAudioCodec(null)).toBe(false)
    expect(isUnsupportedAudioCodec(undefined)).toBe(false)
  })
})

describe("describeAudioCodec", () => {
  it("returns friendly labels for known unsupported codecs", () => {
    expect(describeAudioCodec("ac-3")).toBe("Dolby Digital (AC-3)")
    expect(describeAudioCodec("mp4a.a5")).toBe("Dolby Digital (AC-3)")
    expect(describeAudioCodec("ec-3")).toBe("Dolby Digital Plus (E-AC-3)")
    expect(describeAudioCodec("eac3")).toBe("Dolby Digital Plus (E-AC-3)")
    expect(describeAudioCodec("mp2")).toBe("MPEG audio (MP2)")
    expect(describeAudioCodec("dts")).toBe("DTS")
  })

  it("labels an MPEG audio (MP3) codec string", () => {
    expect(describeAudioCodec("mp3")).toBe("MPEG audio")
  })

  it("falls back to the raw codec string or a placeholder", () => {
    expect(describeAudioCodec("mp4a.40.2")).toBe("mp4a.40.2")
    expect(describeAudioCodec(null)).toBe("?")
    expect(describeAudioCodec("")).toBe("?")
  })
})

describe("clearKeyAvailable", () => {
  it("resolves false when the runtime has no EME ClearKey support", async () => {
    expect(await clearKeyAvailable()).toBe(false)
  })
})

describe("isDroppingEveryFrame", () => {
  // Values are real macOS native-HLS measurements (black picture, working audio).
  it("flags a channel that dropped every frame it decoded", () => {
    expect(isDroppingEveryFrame(1092, 1092)).toBe(true)
  })

  it("flags a channel dropping 97% of frames", () => {
    expect(isDroppingEveryFrame(233, 227)).toBe(true)
  })

  it("does not flag a healthy channel", () => {
    expect(isDroppingEveryFrame(220, 0)).toBe(false)
  })

  it("does not flag ordinary drop rates", () => {
    expect(isDroppingEveryFrame(1000, 50)).toBe(false)
    expect(isDroppingEveryFrame(1000, 899)).toBe(false)
  })

  it("waits for a large enough sample before judging", () => {
    // 3/3 dropped right after start is not yet evidence of anything.
    expect(isDroppingEveryFrame(3, 3)).toBe(false)
    expect(isDroppingEveryFrame(49, 49)).toBe(false)
    expect(isDroppingEveryFrame(50, 50)).toBe(true)
  })

  it("returns false when the metrics are unavailable", () => {
    expect(isDroppingEveryFrame(null, null)).toBe(false)
    expect(isDroppingEveryFrame(100, null)).toBe(false)
    expect(isDroppingEveryFrame(undefined, 100)).toBe(false)
    expect(isDroppingEveryFrame(NaN, NaN)).toBe(false)
  })

  it("ignores nonsensical negative counters", () => {
    expect(isDroppingEveryFrame(100, -5)).toBe(false)
  })
})

describe("chooseBlackFrameRecovery", () => {
  it("re-tunes the native mount on macOS while budget remains", () => {
    expect(
      chooseBlackFrameRecovery({ isMacOSNativeHls: true, relatchAttempts: 0, proxyUsable: true })
    ).toBe("native-retune")
    expect(
      chooseBlackFrameRecovery({ isMacOSNativeHls: true, relatchAttempts: 1, proxyUsable: false })
    ).toBe("native-retune")
  })

  it("escalates to the failure panel once the macOS retune budget is spent", () => {
    expect(
      chooseBlackFrameRecovery({
        isMacOSNativeHls: true,
        relatchAttempts: NATIVE_RELATCH_MAX_ATTEMPTS,
        proxyUsable: true,
      })
    ).toBe("panel")
  })

  it("never routes macOS native playback into the MSE proxy, even with budget spent", () => {
    // WebKit MSE cannot present this video; the proxy would just be a black MSE player.
    const verdict = chooseBlackFrameRecovery({
      isMacOSNativeHls: true,
      relatchAttempts: 99,
      proxyUsable: true,
    })
    expect(verdict).not.toBe("proxy")
  })

  it("uses the remux proxy on MSE platforms when available", () => {
    expect(
      chooseBlackFrameRecovery({ isMacOSNativeHls: false, relatchAttempts: 0, proxyUsable: true })
    ).toBe("proxy")
  })

  it("falls back to the panel on MSE platforms without a usable proxy", () => {
    expect(
      chooseBlackFrameRecovery({ isMacOSNativeHls: false, relatchAttempts: 0, proxyUsable: false })
    ).toBe("panel")
  })
})
