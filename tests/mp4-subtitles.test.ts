import { describe, it, expect } from "vitest"
import {
  parseBoxHeader,
  decodeTx3gSample,
  coalesceSampleRanges,
  orderRangesFromTime,
  buildTrackLabels,
  isMp4SubtitleCapableUrl,
} from "../src/scripts/lib/mp4-subtitles"
import { isMkvProxyCandidate } from "../src/scripts/lib/vod-proxy"

function makeBoxHeaderBuffer(type: string, size32: number, largesize?: bigint): DataView {
  const buffer = new ArrayBuffer(largesize != null ? 16 : 8)
  const view = new DataView(buffer)
  view.setUint32(0, size32)
  for (let i = 0; i < 4; i++) view.setUint8(4 + i, type.charCodeAt(i))
  if (largesize != null) view.setBigUint64(8, largesize)
  return view
}

describe("parseBoxHeader", () => {
  it("parses a normal 32-bit box header", () => {
    const view = makeBoxHeaderBuffer("moov", 1234)
    expect(parseBoxHeader(view, 0)).toEqual({ type: "moov", size: 1234, headerSize: 8 })
  })

  it("parses a largesize (size === 1) 64-bit box header", () => {
    const view = makeBoxHeaderBuffer("mdat", 1, 5_000_000_000n)
    expect(parseBoxHeader(view, 0)).toEqual({ type: "mdat", size: 5_000_000_000, headerSize: 16 })
  })

  it("returns null for a truncated buffer (fewer than 8 bytes remain)", () => {
    const buffer = new ArrayBuffer(4)
    const view = new DataView(buffer)
    expect(parseBoxHeader(view, 0)).toBeNull()
  })

  it("returns null when a largesize header is truncated before the 64-bit size", () => {
    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    view.setUint32(0, 1)
    expect(parseBoxHeader(view, 0)).toBeNull()
  })

  it("returns null for an invalid (too small, non-zero, non-largesize) box size", () => {
    const view = makeBoxHeaderBuffer("free", 4)
    expect(parseBoxHeader(view, 0)).toBeNull()
  })

  it("accepts size === 0 as a valid header (extends-to-EOF sentinel, resolved by the caller)", () => {
    const view = makeBoxHeaderBuffer("mdat", 0)
    expect(parseBoxHeader(view, 0)).toEqual({ type: "mdat", size: 0, headerSize: 8 })
  })
})

function tx3gSample(text: string, extraBytes: number[] = []): Uint8Array {
  const encoded = new TextEncoder().encode(text)
  const bytes = new Uint8Array(2 + encoded.length + extraBytes.length)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, encoded.length)
  bytes.set(encoded, 2)
  bytes.set(extraBytes, 2 + encoded.length)
  return bytes
}

describe("decodeTx3gSample", () => {
  it("decodes plain ASCII text", () => {
    expect(decodeTx3gSample(tx3gSample("Hello there"))).toBe("Hello there")
  })

  it("decodes multibyte UTF-8 text", () => {
    expect(decodeTx3gSample(tx3gSample("cafe au lé"))).toBe("cafe au lé")
  })

  it("returns null for an empty sample (declared length 0)", () => {
    const bytes = new Uint8Array(2)
    expect(decodeTx3gSample(bytes)).toBeNull()
  })

  it("ignores trailing style-box bytes after the declared text length", () => {
    const sample = tx3gSample("styled", [0, 0, 0, 12, 115, 116, 121, 108, 1, 0, 0, 0])
    expect(decodeTx3gSample(sample)).toBe("styled")
  })

  it("decodes a UTF-16BE sample with a BOM", () => {
    const text = "Hi"
    const codeUnits = Array.from(text).map((char) => char.charCodeAt(0))
    const textBytes = new Uint8Array(2 + codeUnits.length * 2)
    textBytes[0] = 0xfe
    textBytes[1] = 0xff
    codeUnits.forEach((codeUnit, index) => {
      textBytes[2 + index * 2] = (codeUnit >> 8) & 0xff
      textBytes[3 + index * 2] = codeUnit & 0xff
    })
    const bytes = new Uint8Array(2 + textBytes.length)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, textBytes.length)
    bytes.set(textBytes, 2)
    expect(decodeTx3gSample(bytes)).toBe("Hi")
  })

  it("normalizes CRLF and lone CR to LF", () => {
    expect(decodeTx3gSample(tx3gSample("line one\r\nline two\rline three"))).toBe(
      "line one\nline two\nline three",
    )
  })

  it("clamps a declared length longer than the available buffer instead of throwing", () => {
    const encoded = new TextEncoder().encode("short")
    const bytes = new Uint8Array(2 + encoded.length)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 9999)
    bytes.set(encoded, 2)
    expect(() => decodeTx3gSample(bytes)).not.toThrow()
    expect(decodeTx3gSample(bytes)).toBe("short")
  })
})

describe("coalesceSampleRanges", () => {
  it("merges samples within the max gap", () => {
    const samples = [
      { offset: 0, size: 100 },
      { offset: 150, size: 50 },
    ]
    expect(coalesceSampleRanges(samples, 100)).toEqual([{ start: 0, end: 200 }])
  })

  it("splits samples separated beyond the max gap", () => {
    const samples = [
      { offset: 0, size: 100 },
      { offset: 1000, size: 50 },
    ]
    expect(coalesceSampleRanges(samples, 100)).toEqual([
      { start: 0, end: 100 },
      { start: 1000, end: 1050 },
    ])
  })

  it("sorts unsorted input before coalescing", () => {
    const samples = [
      { offset: 1000, size: 50 },
      { offset: 0, size: 100 },
      { offset: 150, size: 20 },
    ]
    expect(coalesceSampleRanges(samples, 100)).toEqual([
      { start: 0, end: 170 },
      { start: 1000, end: 1050 },
    ])
  })

  it("returns a single range for a single sample", () => {
    expect(coalesceSampleRanges([{ offset: 42, size: 8 }], 256)).toEqual([{ start: 42, end: 50 }])
  })

  it("returns an empty array for no samples", () => {
    expect(coalesceSampleRanges([], 256)).toEqual([])
  })
})

describe("orderRangesFromTime", () => {
  const ranges: import("../src/scripts/lib/mp4-subtitles").ByteRange[] = [
    { start: 0, end: 100 },
    { start: 1000, end: 1100 },
    { start: 2000, end: 2100 },
  ]
  const samples = [
    { offset: 10, cts: 0, duration: 10, timescale: 1 },
    { offset: 1010, cts: 50, duration: 10, timescale: 1 },
    { offset: 2010, cts: 100, duration: 10, timescale: 1 },
  ]

  it("keeps natural order when startAtSeconds is 0", () => {
    expect(orderRangesFromTime(ranges, samples, 0)).toEqual(ranges)
  })

  it("starts at the range covering startAtSeconds and wraps to the beginning", () => {
    const result = orderRangesFromTime(ranges, samples, 55)
    expect(result).toEqual([
      { start: 1000, end: 1100 },
      { start: 2000, end: 2100 },
      { start: 0, end: 100 },
    ])
  })

  it("wraps to the start when startAtSeconds is beyond the last sample", () => {
    const result = orderRangesFromTime(ranges, samples, 500)
    expect(result).toEqual(ranges)
  })
})

describe("isMp4SubtitleCapableUrl", () => {
  it("matches mp4/m4v/mov extensions", () => {
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.mp4")).toBe(true)
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.m4v")).toBe(true)
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.mov")).toBe(true)
  })

  it("ignores other extensions", () => {
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.mkv")).toBe(false)
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.ts")).toBe(false)
    expect(isMp4SubtitleCapableUrl("https://host.example/movie")).toBe(false)
  })

  it("strips the query string and fragment before matching the extension", () => {
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.mp4?token=abc")).toBe(true)
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.mp4#t=10")).toBe(true)
    expect(isMp4SubtitleCapableUrl("https://host.example/movie.mkv?ext=mp4")).toBe(false)
  })

  it("matches on MIME type regardless of extension", () => {
    expect(isMp4SubtitleCapableUrl("https://host.example/get.php", "video/mp4")).toBe(true)
    expect(isMp4SubtitleCapableUrl("https://host.example/get.php", "video/quicktime")).toBe(true)
    expect(isMp4SubtitleCapableUrl("https://host.example/get.php", "VIDEO/MP4")).toBe(true)
    expect(isMp4SubtitleCapableUrl("https://host.example/get.php", "video/x-matroska")).toBe(false)
  })
})

describe("isMkvProxyCandidate", () => {
  it("matches .mkv and .webm URLs", () => {
    expect(isMkvProxyCandidate("https://host.example/movie.mkv")).toBe(true)
    expect(isMkvProxyCandidate("https://host.example/movie.webm")).toBe(true)
    expect(isMkvProxyCandidate("https://host.example/movie.MKV")).toBe(true)
  })

  it("ignores non-mkv/webm extensions", () => {
    expect(isMkvProxyCandidate("https://host.example/movie.mp4")).toBe(false)
    expect(isMkvProxyCandidate("https://host.example/movie")).toBe(false)
  })

  it("rejects non-http(s) schemes", () => {
    expect(isMkvProxyCandidate("file:///movie.mkv")).toBe(false)
    expect(isMkvProxyCandidate("blob:https://host.example/1234")).toBe(false)
  })

  it("returns false for a malformed URL instead of throwing", () => {
    expect(() => isMkvProxyCandidate("not a url")).not.toThrow()
    expect(isMkvProxyCandidate("not a url")).toBe(false)
  })
})

describe("buildTrackLabels", () => {
  it("gives unique languages a display name", () => {
    const labels = buildTrackLabels(
      [
        { trackId: 1, language: "eng", sampleCount: 10 },
        { trackId: 2, language: "spa", sampleCount: 12 },
      ],
      "en",
    )
    expect(labels[0]).toEqual({ trackId: 1, language: "eng", label: "English", sampleCount: 10 })
    expect(labels[1]).toEqual({ trackId: 2, language: "spa", label: "Spanish", sampleCount: 12 })
  })

  it("suffixes a duplicate language with an incrementing number", () => {
    const labels = buildTrackLabels(
      [
        { trackId: 1, language: "eng", sampleCount: 10 },
        { trackId: 2, language: "eng", sampleCount: 8 },
        { trackId: 3, language: "eng", sampleCount: 5 },
      ],
      "en",
    )
    expect(labels.map((track) => track.label)).toEqual(["English", "English 2", "English 3"])
  })

  it("labels 'und' and empty language codes as Unknown", () => {
    const labels = buildTrackLabels(
      [
        { trackId: 1, language: "und", sampleCount: 3 },
        { trackId: 2, language: "", sampleCount: 4 },
      ],
      "en",
    )
    expect(labels.map((track) => track.label)).toEqual(["Unknown", "Unknown 2"])
  })

  it("falls back to the raw code for a bogus language without throwing", () => {
    expect(() => buildTrackLabels([{ trackId: 1, language: "zzzzz not a code", sampleCount: 1 }], "en")).not.toThrow()
    const labels = buildTrackLabels([{ trackId: 1, language: "zzzzz not a code", sampleCount: 1 }], "en")
    expect(labels[0].label).toBe("zzzzz not a code")
  })

  it("appends the track name in parentheses, keeping it distinct from a plain same-language track", () => {
    const labels = buildTrackLabels(
      [
        { trackId: 1, language: "eng", sampleCount: 10, name: "SDH" },
        { trackId: 2, language: "eng", sampleCount: 8 },
      ],
      "en",
    )
    expect(labels.map((track) => track.label)).toEqual(["English (SDH)", "English"])
  })

  it("suffixes a duplicate language+name pair with an incrementing number", () => {
    const labels = buildTrackLabels(
      [
        { trackId: 1, language: "eng", sampleCount: 10, name: "SDH" },
        { trackId: 2, language: "eng", sampleCount: 8, name: "SDH" },
      ],
      "en",
    )
    expect(labels.map((track) => track.label)).toEqual(["English (SDH)", "English (SDH) 2"])
  })

  it("uses the name alone when it is a superset of the language display name", () => {
    const labels = buildTrackLabels(
      [{ trackId: 1, language: "eng", sampleCount: 10, name: "English SDH" }],
      "en",
    )
    expect(labels[0].label).toBe("English SDH")
  })

  it("uses the language display name alone when the name is identical", () => {
    const labels = buildTrackLabels(
      [{ trackId: 1, language: "eng", sampleCount: 10, name: "English" }],
      "en",
    )
    expect(labels[0].label).toBe("English")
  })

  it("uses the name alone when the language is unresolvable ('und') but a name is present", () => {
    const labels = buildTrackLabels(
      [{ trackId: 1, language: "und", sampleCount: 10, name: "Commentary" }],
      "en",
    )
    expect(labels[0].label).toBe("Commentary")
  })

  it("distinguishes same-name tracks by language instead of an incrementing suffix", () => {
    const labels = buildTrackLabels(
      [
        { trackId: 1, language: "hin", sampleCount: 10, name: "Surround" },
        { trackId: 2, language: "eng", sampleCount: 8, name: "Surround" },
      ],
      "en",
    )
    expect(labels.map((track) => track.label)).toEqual(["Hindi (Surround)", "English (Surround)"])
  })
})
