import { describe, it, expect } from "vitest"
import {
  buildCatchupCastDescriptor,
  buildLiveCastDescriptor,
  buildVodCastDescriptor,
  deriveSessionIsLive,
  isCastableSrc,
  isRtspSrc,
  validateCastDescriptor,
} from "@/scripts/lib/tv-cast-descriptor"

describe("buildLiveCastDescriptor", () => {
  it("builds a live descriptor with the fixed HLS mime", () => {
    const descriptor = buildLiveCastDescriptor({
      src: "https://provider.example/live/user/pass/1.m3u8",
      title: "Channel One",
    })
    expect(descriptor).toEqual({
      v: 1,
      src: "https://provider.example/live/user/pass/1.m3u8",
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
    })
  })

  it("includes optional fields only when provided", () => {
    const descriptor = buildLiveCastDescriptor({
      src: "https://provider.example/live/1.m3u8",
      title: "Channel One",
      logo: "https://provider.example/logo.png",
      drm: { manifestType: "mpd" },
      headers: { userAgent: "custom-ua" },
      preferNativeHls: true,
    })
    expect(descriptor.logo).toBe("https://provider.example/logo.png")
    expect(descriptor.drm).toEqual({ manifestType: "mpd" })
    expect(descriptor.headers).toEqual({ userAgent: "custom-ua" })
    expect(descriptor.preferNativeHls).toBe(true)
  })

  it("passes dns through when provided, and omits it otherwise", () => {
    const withDns = buildLiveCastDescriptor({
      src: "https://provider.example/live/1.m3u8",
      title: "Channel One",
      dns: "1.1.1.1",
    })
    expect(withDns.dns).toBe("1.1.1.1")
    const withoutDns = buildLiveCastDescriptor({
      src: "https://provider.example/live/1.m3u8",
      title: "Channel One",
    })
    expect(withoutDns.dns).toBeUndefined()
    const withNullDns = buildLiveCastDescriptor({
      src: "https://provider.example/live/1.m3u8",
      title: "Channel One",
      dns: null,
    })
    expect(withNullDns.dns).toBeNull()
  })
})

describe("buildVodCastDescriptor", () => {
  it.each([
    ["https://provider.example/movie.mp4", "video/mp4"],
    ["https://provider.example/movie.mkv", "video/x-matroska"],
    ["https://provider.example/movie.unknownext", "video/mp4"],
  ])("resolves mime for %s via chooseMime", (src, expectedMime) => {
    const descriptor = buildVodCastDescriptor({ src, title: "Movie" })
    expect(descriptor.mime).toBe(expectedMime)
    expect(descriptor.isLive).toBe(false)
  })

  it.each([
    ["negative resume", -5, undefined],
    ["NaN resume", Number.NaN, undefined],
    ["Infinity resume", Number.POSITIVE_INFINITY, undefined],
    ["valid resume", 42, 42],
  ])("clamps resumeSeconds: %s", (_label, input, expected) => {
    const descriptor = buildVodCastDescriptor({
      src: "https://provider.example/movie.mp4",
      title: "Movie",
      resumeSeconds: input,
    })
    expect(descriptor.resumeSeconds).toBe(expected)
  })

  it.each([
    ["negative duration", -1, undefined],
    ["NaN duration", Number.NaN, undefined],
    ["Infinity duration", Number.POSITIVE_INFINITY, undefined],
    ["valid duration", 3600, 3600],
  ])("clamps durationSeconds: %s", (_label, input, expected) => {
    const descriptor = buildVodCastDescriptor({
      src: "https://provider.example/movie.mp4",
      title: "Movie",
      durationSeconds: input,
    })
    expect(descriptor.durationSeconds).toBe(expected)
  })

  it("passes dns through when provided, and omits it otherwise", () => {
    const withDns = buildVodCastDescriptor({ src: "https://provider.example/movie.mp4", title: "Movie", dns: "1.1.1.1" })
    expect(withDns.dns).toBe("1.1.1.1")
    const withoutDns = buildVodCastDescriptor({ src: "https://provider.example/movie.mp4", title: "Movie" })
    expect(withoutDns.dns).toBeUndefined()
  })
})

describe("buildCatchupCastDescriptor", () => {
  it("passes dns through when provided, and omits it otherwise", () => {
    const withDns = buildCatchupCastDescriptor({
      src: "https://provider.example/timeshift/1.m3u8",
      mime: "application/x-mpegURL",
      title: "Channel One - Yesterday",
      dns: "1.1.1.1",
    })
    expect(withDns.dns).toBe("1.1.1.1")
    const withoutDns = buildCatchupCastDescriptor({
      src: "https://provider.example/timeshift/1.m3u8",
      mime: "application/x-mpegURL",
      title: "Channel One - Yesterday",
    })
    expect(withoutDns.dns).toBeUndefined()
  })
})

describe("deriveSessionIsLive", () => {
  it("stays true for a live descriptor", () => {
    const descriptor = buildLiveCastDescriptor({
      src: "https://provider.example/live/1.m3u8",
      title: "Channel One",
    })
    expect(deriveSessionIsLive(descriptor)).toBe(true)
  })

  it("stays false for a vod descriptor", () => {
    const descriptor = buildVodCastDescriptor({
      src: "https://provider.example/movie.mp4",
      title: "Movie",
    })
    expect(deriveSessionIsLive(descriptor)).toBe(false)
  })

  it("stays false for a catchup descriptor with a duration, even with liveContext", () => {
    const descriptor = buildCatchupCastDescriptor({
      src: "https://provider.example/timeshift/1.m3u8",
      mime: "application/x-mpegURL",
      title: "Channel One - Yesterday",
      durationSeconds: 3600,
    })
    const context = { liveContext: { playlistId: "p1", channelIds: ["1"], index: 0 } }
    expect(deriveSessionIsLive(descriptor, context)).toBe(false)
  })

  it("becomes true for a bare (non-live-flagged) descriptor with liveContext and no duration", () => {
    const descriptor = buildVodCastDescriptor({
      src: "https://provider.example/live/1.m3u8",
      title: "Channel One",
    })
    const context = { liveContext: { playlistId: "p1", channelIds: ["1"], index: 0 } }
    expect(deriveSessionIsLive(descriptor, context)).toBe(true)
  })
})

describe("isCastableSrc", () => {
  it.each([
    ["https://provider.example/live/1.m3u8", true],
    ["http://provider.example/live/1.m3u8", true],
    ["http://localhost:8080/proxy.mkv", false],
    ["http://127.0.0.1:9000/proxy.mkv", false],
    ["http://tauri.localhost/downloads/movie.mp4", false],
    ["ftp://provider.example/movie.mp4", false],
    ["not a url", false],
    ["", false],
  ])("evaluates %s -> %s", (src, expected) => {
    expect(isCastableSrc(src)).toBe(expected)
  })

  it("accepts rtsp only for live sources", () => {
    const src = "rtsp://192.168.178.1:554/?avm=1&freq=546&msys=dvbc"
    expect(isCastableSrc(src, { live: true })).toBe(true)
    expect(isCastableSrc(src)).toBe(false)
    expect(isCastableSrc(src, { live: false })).toBe(false)
  })

  it("still rejects local hosts and other schemes for live sources", () => {
    expect(isCastableSrc("rtsp://localhost:554/stream", { live: true })).toBe(false)
    expect(isCastableSrc("udp://239.1.1.1:1234", { live: true })).toBe(false)
    expect(isCastableSrc("rtmp://provider.example/live", { live: true })).toBe(false)
  })
})

describe("isRtspSrc", () => {
  it.each([
    ["rtsp://192.168.178.1:554/?avm=1", true],
    ["https://provider.example/live/1.m3u8", false],
    ["not a url", false],
  ])("evaluates %s -> %s", (src, expected) => {
    expect(isRtspSrc(src)).toBe(expected)
  })
})

describe("rtsp live descriptors", () => {
  const rtspSrc = "rtsp://192.168.178.1:554/?avm=1&freq=546&msys=dvbc"

  it("carries an rtsp mime instead of the HLS default", () => {
    expect(buildLiveCastDescriptor({ src: rtspSrc, title: "Das Erste HD" }).mime).toBe("application/x-rtsp")
  })

  it("validates on the receiver when live, and is refused when not", () => {
    const descriptor = buildLiveCastDescriptor({ src: rtspSrc, title: "Das Erste HD" })
    expect(validateCastDescriptor(descriptor)).toEqual(descriptor)
    expect(validateCastDescriptor({ ...descriptor, isLive: false })).toBeNull()
  })
})

describe("validateCastDescriptor", () => {
  const validSrc = "https://provider.example/live/1.m3u8"

  it("passes a well-formed descriptor and strips unknown top-level fields", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
      logo: "https://provider.example/logo.png",
      extraneous: "should be dropped",
    })
    expect(result).toEqual({
      v: 1,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
      logo: "https://provider.example/logo.png",
    })
  })

  it("rejects a wrong version", () => {
    const result = validateCastDescriptor({
      v: 2,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
    })
    expect(result).toBeNull()
  })

  it("rejects a missing src", () => {
    const result = validateCastDescriptor({
      v: 1,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
    })
    expect(result).toBeNull()
  })

  it("rejects a non-castable src", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: "http://127.0.0.1:8080/proxy.mkv",
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
    })
    expect(result).toBeNull()
  })

  it("accepts an empty title string", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "",
    })
    expect(result).toEqual({
      v: 1,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "",
    })
  })

  it("rejects a missing mime", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      isLive: true,
      title: "Channel One",
    })
    expect(result).toBeNull()
  })

  it("drops non-finite or negative numeric optionals", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "video/mp4",
      isLive: false,
      title: "Movie",
      resumeSeconds: -5,
      durationSeconds: Number.NaN,
      timelineOffsetSeconds: Number.POSITIVE_INFINITY,
    })
    expect(result?.resumeSeconds).toBeUndefined()
    expect(result?.durationSeconds).toBeUndefined()
    expect(result?.timelineOffsetSeconds).toBeUndefined()
  })

  it("keeps valid numeric optionals", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "video/mp4",
      isLive: false,
      title: "Movie",
      resumeSeconds: 120,
      durationSeconds: 3600,
      timelineOffsetSeconds: 0,
    })
    expect(result?.resumeSeconds).toBe(120)
    expect(result?.durationSeconds).toBe(3600)
    expect(result?.timelineOffsetSeconds).toBe(0)
  })

  it("strips unknown keys from drm and headers while keeping known ones", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "application/dash+xml",
      isLive: false,
      title: "Movie",
      drm: { manifestType: "mpd", drmScheme: "clearkey", licenseKey: null, unknownField: "drop me" },
      headers: { userAgent: "custom-ua", referer: null, otherHeader: "drop me" },
    })
    expect(result?.drm).toEqual({ manifestType: "mpd", drmScheme: "clearkey", licenseKey: null })
    expect(result?.headers).toEqual({ userAgent: "custom-ua", referer: null })
  })

  it("drops drm/headers entirely when they contain no known fields", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "video/mp4",
      isLive: false,
      title: "Movie",
      drm: { unknownField: "x" },
      headers: { otherHeader: "y" },
    })
    expect(result?.drm).toBeUndefined()
    expect(result?.headers).toBeUndefined()
  })

  it("rejects a non-object input", () => {
    expect(validateCastDescriptor(null)).toBeNull()
    expect(validateCastDescriptor("not an object")).toBeNull()
    expect(validateCastDescriptor(undefined)).toBeNull()
  })

  it("keeps a valid dns string", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
      dns: "1.1.1.1",
    })
    expect(result?.dns).toBe("1.1.1.1")
  })

  it("keeps a null dns", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
      dns: null,
    })
    expect(result?.dns).toBeNull()
  })

  it("drops a dns of the wrong type", () => {
    const result = validateCastDescriptor({
      v: 1,
      src: validSrc,
      mime: "application/x-mpegURL",
      isLive: true,
      title: "Channel One",
      dns: 12345,
    })
    expect(result?.dns).toBeUndefined()
  })
})
