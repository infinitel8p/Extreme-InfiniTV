import { describe, expect, it } from "vitest"
import {
  hasHevcNameHint,
  isHevcCodecString,
  findHevcInCodecList,
  classifyStartFailure,
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
})
