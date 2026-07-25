import { describe, expect, it } from "vitest"
import {
  classifySniffedUrl,
  describeHlsQuality,
  rankSniffCandidates,
  summarizeHlsMaster,
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

  it("does not flag mastermind.m3u8 as a master playlist", () => {
    expect(classifySniffedUrl("https://host.example/mastermind.m3u8")).toEqual({
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

  it("classifies a .mpd-suffixed URL as HLS when the reported content type is an HLS MIME", () => {
    expect(
      classifySniffedUrl("https://host.example/manifest.mpd", "application/vnd.apple.mpegurl"),
    ).toEqual({ kind: "hls", isMaster: false })
  })

  it("classifies a .m3u8 URL as DASH when the reported content type is application/dash+xml", () => {
    expect(
      classifySniffedUrl("https://host.example/master.m3u8", "application/dash+xml"),
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

describe("summarizeHlsMaster", () => {
  it("parses a master playlist with several variants", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\"",
      "1080p/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720",
      "720p/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "360p/index.m3u8",
    ].join("\n")
    expect(summarizeHlsMaster(text)).toEqual({
      isMaster: true,
      variants: [
        { width: 1920, height: 1080, bandwidth: 5200000, uri: "1080p/index.m3u8" },
        { width: 1280, height: 720, bandwidth: 2800000, uri: "720p/index.m3u8" },
        { width: 640, height: 360, bandwidth: 800000, uri: "360p/index.m3u8" },
      ],
      media: [],
    })
  })

  it("reports isMaster false for a plain media playlist", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.0,",
      "segment0.ts",
      "#EXTINF:6.0,",
      "segment1.ts",
    ].join("\n")
    expect(summarizeHlsMaster(text)).toEqual({ isMaster: false, variants: [], media: [] })
  })

  it("flags an audio-only master (no RESOLUTION on any variant)", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"main\",DEFAULT=YES,URI=\"audio/index.m3u8\"",
      "#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS=\"mp4a.40.2\",AUDIO=\"aud\"",
      "audio/index.m3u8",
    ].join("\n")
    expect(summarizeHlsMaster(text)).toEqual({
      isMaster: true,
      variants: [{ width: null, height: null, bandwidth: 128000, uri: "audio/index.m3u8" }],
      media: [{ type: "AUDIO", uri: "audio/index.m3u8", language: null, name: "main" }],
    })
  })

  it("returns an empty, non-master summary for malformed or empty input", () => {
    expect(summarizeHlsMaster("")).toEqual({ isMaster: false, variants: [], media: [] })
    expect(summarizeHlsMaster("not an m3u8 at all\njust some garbage text")).toEqual({
      isMaster: false,
      variants: [],
      media: [],
    })
    expect(summarizeHlsMaster(null as unknown as string)).toEqual({ isMaster: false, variants: [], media: [] })
    expect(summarizeHlsMaster(undefined as unknown as string)).toEqual({ isMaster: false, variants: [], media: [] })
  })

  it("captures relative and absolute variant URIs", () => {
    const text = [
      "#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080",
      "1080p/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "https://cdn.example.com/abc123/360p/index.m3u8?token=xyz",
    ].join("\n")
    const summary = summarizeHlsMaster(text)
    expect(summary.variants[0].uri).toBe("1080p/index.m3u8")
    expect(summary.variants[1].uri).toBe("https://cdn.example.com/abc123/360p/index.m3u8?token=xyz")
  })

  it("captures an EXT-X-MEDIA audio rendition with language", () => {
    const text = [
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",URI=\"audio_en/index.m3u8\"",
      "#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080",
      "1080p/index.m3u8",
    ].join("\n")
    const summary = summarizeHlsMaster(text)
    expect(summary.media).toEqual([
      { type: "AUDIO", uri: "audio_en/index.m3u8", language: "en", name: "English" },
    ])
  })

  it("prefers BANDWIDTH over AVERAGE-BANDWIDTH when both are present", () => {
    const text = [
      "#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=800000,BANDWIDTH=1000000,RESOLUTION=1920x1080",
      "1080p/index.m3u8",
    ].join("\n")
    const summary = summarizeHlsMaster(text)
    expect(summary.variants[0].bandwidth).toBe(1000000)
  })

  it("captures an EXT-X-MEDIA entry without a URI (muxed audio) without crashing", () => {
    const text = [
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"main\",DEFAULT=YES",
      "#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,AUDIO=\"aud\"",
      "1080p/index.m3u8",
    ].join("\n")
    expect(() => summarizeHlsMaster(text)).not.toThrow()
    const summary = summarizeHlsMaster(text)
    expect(summary.media).toEqual([{ type: "AUDIO", uri: null, language: null, name: "main" }])
  })
})

describe("describeHlsQuality", () => {
  it("picks the highest-resolution variant with bandwidth", () => {
    const summary = summarizeHlsMaster(
      [
        "#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080",
        "1080p/index.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
        "360p/index.m3u8",
      ].join("\n")
    )
    expect(describeHlsQuality(summary, "audio")).toBe("1080p · 5.2 Mbps")
  })

  it("omits the bitrate when bandwidth is missing", () => {
    const summary: ReturnType<typeof summarizeHlsMaster> = {
      isMaster: true,
      variants: [{ width: 1280, height: 720, bandwidth: null, uri: null }],
      media: [],
    }
    expect(describeHlsQuality(summary, "audio")).toBe("720p")
  })

  it("returns the audio label when no variant has a resolution", () => {
    const summary = summarizeHlsMaster(
      "#EXT-X-STREAM-INF:BANDWIDTH=128000\naudio/index.m3u8"
    )
    expect(describeHlsQuality(summary, "audio")).toBe("audio")
  })

  it("returns null when there are no variants at all", () => {
    expect(describeHlsQuality({ isMaster: false, variants: [], media: [] }, "audio")).toBe(null)
  })
})
