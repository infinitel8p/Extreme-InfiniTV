import { describe, expect, it } from "vitest"
import {
  classifySniffedUrl,
  rankSniffCandidates,
  type SniffCandidate,
} from "../src/scripts/lib/sniff-classify"

describe("classifySniffedUrl", () => {
  it("matches a plain .m3u8 URL", () => {
    expect(classifySniffedUrl("https://host.example/stream.m3u8")).toEqual({
      kind: "hls",
      isMaster: false,
    })
  })

  it("matches .m3u8 case-insensitively", () => {
    expect(classifySniffedUrl("https://host.example/stream.M3U8")).toEqual({
      kind: "hls",
      isMaster: false,
    })
  })

  it("matches .m3u8 with a query string and fragment", () => {
    expect(
      classifySniffedUrl("https://host.example/stream.m3u8?token=abc#frag"),
    ).toEqual({ kind: "hls", isMaster: false })
  })

  it("flags master.m3u8 as a master playlist", () => {
    expect(classifySniffedUrl("https://host.example/master.m3u8")).toEqual({
      kind: "hls",
      isMaster: true,
    })
  })

  it("does not flag chunklist.m3u8 as a master playlist", () => {
    expect(classifySniffedUrl("https://host.example/chunklist.m3u8")).toEqual({
      kind: "hls",
      isMaster: false,
    })
  })

  it("matches a plain .mpd URL and never marks it as master", () => {
    expect(classifySniffedUrl("https://host.example/manifest.mpd")).toEqual({
      kind: "dash",
      isMaster: false,
    })
  })

  it("detects HLS via content type on an extensionless URL", () => {
    expect(
      classifySniffedUrl("https://host.example/stream", "application/x-mpegurl"),
    ).toEqual({ kind: "hls", isMaster: false })
  })

  it("detects HLS via content type on a .php URL, mixed case, with a parameter", () => {
    expect(
      classifySniffedUrl(
        "https://host.example/get.php?id=1",
        "APPLICATION/X-MPEGURL; charset=utf-8",
      ),
    ).toEqual({ kind: "hls", isMaster: false })
  })

  it("accepts all HLS MIME variants", () => {
    const hlsMimeTypes = [
      "application/x-mpegurl",
      "application/vnd.apple.mpegurl",
      "audio/mpegurl",
      "audio/x-mpegurl",
    ]
    for (const mimeType of hlsMimeTypes) {
      expect(classifySniffedUrl("https://host.example/get.php", mimeType)).toEqual({
        kind: "hls",
        isMaster: false,
      })
    }
  })

  it("detects DASH via content type on an extensionless URL", () => {
    expect(
      classifySniffedUrl("https://host.example/get.php", "application/dash+xml; charset=utf-8"),
    ).toEqual({ kind: "dash", isMaster: false })
  })

  it("matches the real-world boc-live master.m3u8 vector", () => {
    expect(
      classifySniffedUrl(
        "https://boc-live.fantv.media/boc_live/smil:boc.smil/master.m3u8?failaction=true",
        "application/x-mpegURL",
      ),
    ).toEqual({ kind: "hls", isMaster: true })
  })

  it("rejects segment/asset extensions even with streaming-ish query strings", () => {
    const segmentUrls = [
      "https://host.example/seg-1.ts?m3u8=1",
      "https://host.example/seg-1.m4s?mpd=1",
      "https://host.example/video.mp4?playlist=master.m3u8",
      "https://host.example/audio.aac",
      "https://host.example/subs.vtt",
      "https://host.example/stream.key",
    ]
    for (const segmentUrl of segmentUrls) {
      expect(classifySniffedUrl(segmentUrl)).toBe(null)
    }
  })

  it("rejects non-http(s) schemes", () => {
    expect(classifySniffedUrl("blob:https://host.example/1234-5678")).toBe(null)
    expect(classifySniffedUrl("data:application/octet-stream;base64,abcd")).toBe(null)
    expect(classifySniffedUrl("ws://host.example/socket")).toBe(null)
  })

  it("resolves relative URLs and classifies by pathname", () => {
    expect(classifySniffedUrl("chunklist.m3u8")).toEqual({ kind: "hls", isMaster: false })
    expect(classifySniffedUrl("/live/master.m3u8")).toEqual({ kind: "hls", isMaster: true })
    expect(classifySniffedUrl("../dash/manifest.mpd")).toEqual({ kind: "dash", isMaster: false })
  })

  it("returns null for URLs matching neither rule", () => {
    expect(classifySniffedUrl("https://host.example/index.html")).toBe(null)
    expect(classifySniffedUrl("https://host.example/api/data.json")).toBe(null)
  })
})

describe("rankSniffCandidates", () => {
  function candidate(overrides: Partial<SniffCandidate> & Pick<SniffCandidate, "url" | "kind" | "isMaster">): SniffCandidate {
    return { userAgent: null, referer: null, ...overrides }
  }

  it("dedupes by URL keeping the first hit", () => {
    const first = candidate({ url: "https://host.example/a.m3u8", kind: "hls", isMaster: false, userAgent: "first" })
    const second = candidate({ url: "https://host.example/a.m3u8", kind: "hls", isMaster: false, userAgent: "second" })
    expect(rankSniffCandidates([first, second])).toEqual([first])
  })

  it("ranks master HLS before HLS before DASH", () => {
    const dash = candidate({ url: "https://host.example/d.mpd", kind: "dash", isMaster: false })
    const hls = candidate({ url: "https://host.example/h.m3u8", kind: "hls", isMaster: false })
    const masterHls = candidate({ url: "https://host.example/master.m3u8", kind: "hls", isMaster: true })
    expect(rankSniffCandidates([dash, hls, masterHls])).toEqual([masterHls, hls, dash])
  })

  it("is stable within the same rank", () => {
    const first = candidate({ url: "https://host.example/1.m3u8", kind: "hls", isMaster: false })
    const second = candidate({ url: "https://host.example/2.m3u8", kind: "hls", isMaster: false })
    const third = candidate({ url: "https://host.example/3.m3u8", kind: "hls", isMaster: false })
    expect(rankSniffCandidates([first, second, third])).toEqual([first, second, third])
  })
})
