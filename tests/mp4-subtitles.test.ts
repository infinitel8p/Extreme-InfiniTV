import { describe, it, expect, beforeEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

const logWarnMock = vi.fn()
vi.mock("@/scripts/lib/log.js", () => ({
  log: { error: vi.fn(), warn: (...args: unknown[]) => logWarnMock(...args), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
  redactUrl: (input: unknown) => String(input),
}))

import {
  parseBoxHeader,
  decodeTx3gSample,
  coalesceSampleRanges,
  orderRangesFromTime,
  buildTrackLabels,
  isMp4SubtitleCapableUrl,
  openMp4SubtitleSession,
  listMp4AudioTracks,
} from "../src/scripts/lib/mp4-subtitles"
import type { SubtitleCue } from "../src/scripts/lib/mp4-subtitles"
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

// ---- synthetic MP4 fixtures ----

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    merged.set(chunk, cursor)
    cursor += chunk.length
  }
  return merged
}

function uint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff])
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value)
  return bytes
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
  return bytes
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function zeros(count: number): Uint8Array {
  return new Uint8Array(count)
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concatBytes(payload)
  return concatBytes([uint32(body.length + 8), ascii(type), body])
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, uint8(version), uint8(flags >> 16), uint8(flags >> 8), uint8(flags), ...payload)
}

const IDENTITY_MATRIX = concatBytes([
  uint32(0x00010000),
  uint32(0),
  uint32(0),
  uint32(0),
  uint32(0x00010000),
  uint32(0),
  uint32(0),
  uint32(0),
  uint32(0x40000000),
])

/** ISO-639-2 code packed as three 5-bit values, as mdhd stores it. */
function packLanguage(code: string): number {
  const padded = `${code}und`.slice(0, 3)
  return (
    (((padded.charCodeAt(0) - 0x60) & 31) << 10) |
    (((padded.charCodeAt(1) - 0x60) & 31) << 5) |
    ((padded.charCodeAt(2) - 0x60) & 31)
  )
}

interface TrackFixture {
  trackId: number
  mediaType: "text" | "audio"
  language: string
  codecFourcc?: string
  handlerName?: string
  timescale?: number
  sampleDurationTicks?: number
  /** Samples are contiguous inside a cluster; clusters are separated by clusterGapBytes. */
  sampleClusters: Uint8Array[][]
  clusterGapBytes?: number
}

const DEFAULT_TIMESCALE = 1000
const DEFAULT_SAMPLE_DURATION_TICKS = 1000
const DEFAULT_CLUSTER_GAP_BYTES = 300_000

function tx3gCluster(texts: string[]): Uint8Array[] {
  return texts.map((text) => tx3gSample(text))
}

/** 6 reserved bytes + data_reference_index, then displayFlags, justifications, colour, box and style records. */
function tx3gSampleEntry(fourcc: string): Uint8Array {
  return box(
    fourcc,
    zeros(6),
    uint16(1),
    uint32(0),
    uint8(1),
    uint8(0xff),
    zeros(4),
    zeros(8),
    zeros(12),
  )
}

/** 6 reserved bytes + data_reference_index, then version, channel count, sample size and 16.16 sample rate. */
function audioSampleEntry(fourcc: string): Uint8Array {
  return box(
    fourcc,
    zeros(6),
    uint16(1),
    uint16(0),
    uint16(0),
    uint32(0),
    uint16(2),
    uint16(16),
    uint16(0),
    uint16(0),
    uint32(48000 * 65536),
  )
}

function sampleTableBox(track: TrackFixture, sampleOffsets: number[]): Uint8Array {
  const samples = track.sampleClusters.flat()
  const sampleEntry =
    track.mediaType === "text"
      ? tx3gSampleEntry(track.codecFourcc ?? "tx3g")
      : audioSampleEntry(track.codecFourcc ?? "mp4a")
  return box(
    "stbl",
    fullBox("stsd", 0, 0, uint32(1), sampleEntry),
    fullBox("stts", 0, 0, uint32(1), uint32(samples.length), uint32(track.sampleDurationTicks ?? DEFAULT_SAMPLE_DURATION_TICKS)),
    fullBox("stsc", 0, 0, uint32(1), uint32(1), uint32(1), uint32(1)),
    fullBox("stsz", 0, 0, uint32(0), uint32(samples.length), ...samples.map((sample) => uint32(sample.length))),
    fullBox("stco", 0, 0, uint32(sampleOffsets.length), ...sampleOffsets.map((offset) => uint32(offset))),
  )
}

function trackBox(track: TrackFixture, sampleOffsets: number[]): Uint8Array {
  const samples = track.sampleClusters.flat()
  const timescale = track.timescale ?? DEFAULT_TIMESCALE
  const mediaDuration = samples.length * (track.sampleDurationTicks ?? DEFAULT_SAMPLE_DURATION_TICKS)
  const mediaHeader = track.mediaType === "text" ? fullBox("nmhd", 0, 0) : fullBox("smhd", 0, 0, uint16(0), uint16(0))
  return box(
    "trak",
    fullBox(
      "tkhd",
      0,
      3,
      uint32(0),
      uint32(0),
      uint32(track.trackId),
      uint32(0),
      uint32(mediaDuration),
      zeros(8),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      IDENTITY_MATRIX,
      uint32(0),
      uint32(0),
    ),
    box(
      "mdia",
      fullBox("mdhd", 0, 0, uint32(0), uint32(0), uint32(timescale), uint32(mediaDuration), uint16(packLanguage(track.language)), uint16(0)),
      fullBox("hdlr", 0, 0, uint32(0), ascii(track.mediaType === "text" ? "text" : "soun"), zeros(12), ascii(`${track.handlerName ?? ""}\0`)),
      box("minf", mediaHeader, sampleTableBox(track, sampleOffsets)),
    ),
  )
}

function movieBox(tracks: TrackFixture[], sampleOffsetsPerTrack: number[][]): Uint8Array {
  const longestDuration = Math.max(
    ...tracks.map((track) => track.sampleClusters.flat().length * (track.sampleDurationTicks ?? DEFAULT_SAMPLE_DURATION_TICKS)),
  )
  const maxTrackId = Math.max(...tracks.map((track) => track.trackId))
  return box(
    "moov",
    fullBox(
      "mvhd",
      0,
      0,
      uint32(0),
      uint32(0),
      uint32(DEFAULT_TIMESCALE),
      uint32(longestDuration),
      uint32(0x00010000),
      uint16(0x0100),
      uint16(0),
      zeros(8),
      IDENTITY_MATRIX,
      zeros(24),
      uint32(maxTrackId + 1),
    ),
    ...tracks.map((track, index) => trackBox(track, sampleOffsetsPerTrack[index])),
  )
}

interface Mp4Fixture {
  tracks: TrackFixture[]
  moovPosition?: "before-mdat" | "after-mdat"
  /** Filler ahead of the first sample, used to push a trailing moov past the head-probe window. */
  mdatLeadingPadding?: number
  use64BitMdatHeader?: boolean
  boxesBeforeMoov?: Uint8Array[]
  boxesAfterMoov?: Uint8Array[]
}

interface BuiltMp4 {
  bytes: Uint8Array
  moovOffset: number
  moovSize: number
  mdatOffset: number
  mdatSize: number
  sampleOffsetsPerTrack: number[][]
}

function layoutMdatContent(fixture: Mp4Fixture, mdatDataStart: number): { content: Uint8Array; sampleOffsetsPerTrack: number[][] } {
  const pieces: Uint8Array[] = []
  const sampleOffsetsPerTrack: number[][] = []
  let cursor = 0
  if (fixture.mdatLeadingPadding) {
    pieces.push(zeros(fixture.mdatLeadingPadding))
    cursor += fixture.mdatLeadingPadding
  }
  for (const track of fixture.tracks) {
    const trackSampleOffsets: number[] = []
    track.sampleClusters.forEach((cluster, clusterIndex) => {
      if (clusterIndex > 0) {
        const gap = track.clusterGapBytes ?? DEFAULT_CLUSTER_GAP_BYTES
        pieces.push(zeros(gap))
        cursor += gap
      }
      for (const sample of cluster) {
        trackSampleOffsets.push(mdatDataStart + cursor)
        pieces.push(sample)
        cursor += sample.length
      }
    })
    sampleOffsetsPerTrack.push(trackSampleOffsets)
  }
  return { content: concatBytes(pieces), sampleOffsetsPerTrack }
}

function buildMp4(fixture: Mp4Fixture): BuiltMp4 {
  const ftyp = box("ftyp", ascii("isom"), uint32(0x200), ascii("isom"), ascii("mp41"))
  const placeholderOffsets = fixture.tracks.map((track) => track.sampleClusters.flat().map(() => 0))
  const moovProbe = movieBox(fixture.tracks, placeholderOffsets)
  const boxesBefore = fixture.boxesBeforeMoov ?? []
  const boxesAfter = fixture.boxesAfterMoov ?? []
  const mdatHeaderSize = fixture.use64BitMdatHeader ? 16 : 8
  const moovAfterMdat = fixture.moovPosition === "after-mdat"
  const mdatOffset = moovAfterMdat ? ftyp.length : ftyp.length + moovProbe.length
  const { content, sampleOffsetsPerTrack } = layoutMdatContent(fixture, mdatOffset + mdatHeaderSize)
  const mdat = fixture.use64BitMdatHeader
    ? concatBytes([uint32(1), ascii("mdat"), uint64(content.length + 16), content])
    : box("mdat", content)
  const moov = movieBox(fixture.tracks, sampleOffsetsPerTrack)
  if (moov.length !== moovProbe.length) throw new Error("fixture moov size changed between passes")
  const moovOffset = moovAfterMdat
    ? mdatOffset + mdat.length + boxesBefore.reduce((sum, extraBox) => sum + extraBox.length, 0)
    : ftyp.length
  const ordered = moovAfterMdat ? [ftyp, mdat, ...boxesBefore, moov, ...boxesAfter] : [ftyp, moov, mdat, ...boxesAfter]
  return {
    bytes: concatBytes(ordered),
    moovOffset,
    moovSize: moov.length,
    mdatOffset,
    mdatSize: mdat.length,
    sampleOffsetsPerTrack,
  }
}

// ---- fake ranged HTTP server ----

interface FakeServerOptions {
  /** Answer every request with 200 and the whole body, as range-blind panels do. */
  ignoreRange?: boolean
  /** Content-Range hidden by CORS, so the walk never learns the file size. */
  hideContentRange?: boolean
  /** Stop serving bytes past this offset while still advertising the full size. */
  bodyEndsAt?: number
  /** Serve bytes from a different offset than requested. */
  shiftResponseBy?: number
  alwaysStatus416?: boolean
}

function serve(fileBytes: Uint8Array, options: FakeServerOptions = {}) {
  const requestedRanges: string[] = []
  const responses: Response[] = []
  const handler = async (_url: string, init: RequestInit): Promise<Response> => {
    const rangeHeader = String((init.headers as Record<string, string>).Range ?? "")
    requestedRanges.push(rangeHeader)
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)
    const requestStart = match ? Number(match[1]) : 0
    const requestEnd = match && match[2] ? Number(match[2]) : fileBytes.length - 1
    const servedLength = options.bodyEndsAt ?? fileBytes.length
    const shift = options.shiftResponseBy ?? 0
    let response: Response
    if (options.alwaysStatus416) {
      response = new Response(null, { status: 416 })
    } else if (options.ignoreRange) {
      response = new Response(fileBytes.slice(), { status: 200 })
    } else if (requestStart >= servedLength) {
      response = new Response(null, { status: 416 })
    } else {
      const start = requestStart + shift
      const end = Math.min(requestEnd + 1 + shift, servedLength)
      const headers: Record<string, string> = { "Accept-Ranges": "bytes" }
      if (!options.hideContentRange) headers["Content-Range"] = `bytes ${start}-${end - 1}/${fileBytes.length}`
      response = new Response(fileBytes.slice(start, end), { status: 206, headers })
    }
    responses.push(response)
    return response
  }
  providerFetchMock.mockImplementation(handler)
  return { requestedRanges, responses }
}

function englishSubtitleTrack(cueClusters: string[][], trackId = 1): TrackFixture {
  return {
    trackId,
    mediaType: "text",
    language: "eng",
    handlerName: "Subtitle Handler",
    sampleClusters: cueClusters.map((cluster) => tx3gCluster(cluster)),
  }
}

function stereoAudioTrack(trackId: number, language: string, codecFourcc = "mp4a"): TrackFixture {
  return {
    trackId,
    mediaType: "audio",
    language,
    codecFourcc,
    handlerName: "Audio Handler",
    sampleClusters: [[zeros(64), zeros(64)]],
  }
}

const HEAD_PROBE_RANGE = "bytes=0-65535"

beforeEach(() => {
  providerFetchMock.mockReset()
  logWarnMock.mockReset()
})

describe("openMp4SubtitleSession / listMp4AudioTracks moov location", () => {
  it("reads a faststart file whose moov sits inside the head-probe window", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["one", "two"]]), stereoAudioTrack(2, "spa")] })
    const server = serve(built.bytes)

    const session = await openMp4SubtitleSession("https://host.test/faststart.mp4")

    expect(session).not.toBeNull()
    expect(session!.tracks).toEqual([{ trackId: 1, language: "eng", label: "English", sampleCount: 2 }])
    expect(server.requestedRanges).toEqual([
      HEAD_PROBE_RANGE,
      `bytes=${built.moovOffset}-${built.moovOffset + built.moovSize - 1}`,
    ])
  })

  it("walks past a large mdat and a free box to reach a trailing moov", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["late one", "late two"]])],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 200_000,
      boxesBeforeMoov: [box("free", zeros(64))],
    })
    const server = serve(built.bytes)

    const session = await openMp4SubtitleSession("https://host.test/trailing-moov.mp4")

    expect(session!.tracks.map((track) => track.label)).toEqual(["English"])
    const freeBoxOffset = built.mdatOffset + built.mdatSize
    expect(server.requestedRanges).toEqual([
      HEAD_PROBE_RANGE,
      `bytes=${freeBoxOffset}-${freeBoxOffset + 15}`,
      `bytes=${built.moovOffset}-${built.moovOffset + 15}`,
      `bytes=${built.moovOffset}-${built.moovOffset + built.moovSize - 1}`,
    ])
  })

  it("reads a faststart-less file whose moov is the very last box", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["tail one"]]), stereoAudioTrack(2, "eng")],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 120_000,
    })
    const server = serve(built.bytes)

    const audioTracks = await listMp4AudioTracks("https://host.test/no-faststart.mp4")

    expect(audioTracks).toEqual([{ trackId: 2, index: 0, language: "eng", codec: "mp4a" }])
    expect(built.moovOffset + built.moovSize).toBe(built.bytes.length)
    expect(server.requestedRanges.at(-1)).toBe(`bytes=${built.moovOffset}-${built.moovOffset + built.moovSize - 1}`)
  })

  it("skips a 64-bit largesize mdat and still finds the trailing moov", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["largesize"]])],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 100_000,
      use64BitMdatHeader: true,
    })
    const server = serve(built.bytes)

    const session = await openMp4SubtitleSession("https://host.test/largesize-mdat.mp4")

    expect(session!.tracks).toHaveLength(1)
    expect(server.requestedRanges).toContain(`bytes=${built.moovOffset}-${built.moovOffset + 15}`)
  })

  it("finds a trailing moov even when Content-Range is hidden by CORS", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["hidden range"]]), stereoAudioTrack(2, "fra")],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 150_000,
    })
    const server = serve(built.bytes, { hideContentRange: true })

    const session = await openMp4SubtitleSession("https://host.test/cors-hidden.mp4")

    expect(session!.tracks.map((track) => track.label)).toEqual(["English"])
    expect(server.requestedRanges.length).toBeLessThanOrEqual(4)
  })

  it("gives up after one fetch when the server ignores Range and returns the whole body", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["ignored"]])] })
    const server = serve(built.bytes, { ignoreRange: true })

    const session = await openMp4SubtitleSession("https://host.test/range-blind.mp4")

    expect(session).toBeNull()
    expect(server.requestedRanges).toEqual([HEAD_PROBE_RANGE])
    expect(server.responses[0].bodyUsed).toBe(false)
    expect(logWarnMock).toHaveBeenCalled()
  })

  it("gives up after one fetch when the head probe answers 416", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["gone"]])] })
    const server = serve(built.bytes, { alwaysStatus416: true })

    expect(await openMp4SubtitleSession("https://host.test/head-416.mp4")).toBeNull()
    expect(await listMp4AudioTracks("https://host.test/audio-head-416.mp4")).toEqual([])
    expect(server.requestedRanges).toEqual([HEAD_PROBE_RANGE, HEAD_PROBE_RANGE])
  })

  it("stops when a 206 serves bytes from a different offset than requested", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["shifted"]])] })
    const server = serve(built.bytes, { shiftResponseBy: 8 })

    expect(await openMp4SubtitleSession("https://host.test/shifted-range.mp4")).toBeNull()
    expect(server.requestedRanges.length).toBeLessThanOrEqual(2)
  })

  it("returns null when the body is truncated in the middle of the moov", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["truncated"]]), stereoAudioTrack(2, "eng")] })
    const server = serve(built.bytes, { bodyEndsAt: built.moovOffset + Math.floor(built.moovSize / 2) })

    expect(await openMp4SubtitleSession("https://host.test/truncated-moov.mp4")).toBeNull()
    expect(server.requestedRanges.length).toBeLessThanOrEqual(2)
  })

  it("returns null for a file too short to hold a box header", async () => {
    const server = serve(new Uint8Array([0, 0, 0, 4]))

    expect(await openMp4SubtitleSession("https://host.test/tiny.mp4")).toBeNull()
    expect(server.requestedRanges.length).toBeLessThanOrEqual(2)
  })

  it("terminates when a box declares size 0 (extends to EOF) ahead of the moov", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["unreachable"]])],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 1024,
    })
    const patched = built.bytes.slice()
    new DataView(patched.buffer).setUint32(built.mdatOffset, 0)
    const server = serve(patched)

    expect(await openMp4SubtitleSession("https://host.test/zero-size-box.mp4")).toBeNull()
    expect(server.requestedRanges).toEqual([HEAD_PROBE_RANGE])
  })

  it("terminates when a box declares size 0 and the file size is unknown", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["unreachable"]])],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 1024,
    })
    const patched = built.bytes.slice()
    new DataView(patched.buffer).setUint32(built.mdatOffset, 0)
    const server = serve(patched, { hideContentRange: true })

    expect(await openMp4SubtitleSession("https://host.test/zero-size-box-no-total.mp4")).toBeNull()
    expect(server.requestedRanges).toEqual([HEAD_PROBE_RANGE])
  })

  it("reaches a trailing moov that sits behind a second mdat", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["second mdat"]])],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 80_000,
      boxesBeforeMoov: [box("mdat", zeros(4096))],
    })
    serve(built.bytes)

    const session = await openMp4SubtitleSession("https://host.test/two-mdats.mp4")

    expect(session!.tracks).toHaveLength(1)
  })

  it("terminates when a 64-bit largesize overruns the file and the size is unknown", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["overrun 64"]])],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 1024,
      use64BitMdatHeader: true,
    })
    const patched = built.bytes.slice()
    new DataView(patched.buffer).setBigUint64(built.mdatOffset + 8, BigInt(built.bytes.length) * 8n)
    const server = serve(patched, { hideContentRange: true })

    expect(await openMp4SubtitleSession("https://host.test/overrun-largesize.mp4")).toBeNull()
    expect(server.requestedRanges.length).toBeLessThanOrEqual(2)
  })

  it("refuses to download a moov larger than the size cap", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["huge moov"]])] })
    const patched = built.bytes.slice()
    new DataView(patched.buffer).setUint32(built.moovOffset, 65 * 1024 * 1024)
    const server = serve(patched)

    expect(await openMp4SubtitleSession("https://host.test/huge-moov.mp4")).toBeNull()
    expect(server.requestedRanges).toEqual([HEAD_PROBE_RANGE])
  })

  it("terminates when a box size overruns the end of the file", async () => {
    const built = buildMp4({
      tracks: [englishSubtitleTrack([["overrun"]])],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 1024,
    })
    const patched = built.bytes.slice()
    new DataView(patched.buffer).setUint32(built.mdatOffset, built.bytes.length * 4)
    const withTotal = serve(patched)
    expect(await openMp4SubtitleSession("https://host.test/overrun-with-total.mp4")).toBeNull()
    expect(withTotal.requestedRanges).toEqual([HEAD_PROBE_RANGE])

    const withoutTotal = serve(patched, { hideContentRange: true })
    expect(await openMp4SubtitleSession("https://host.test/overrun-without-total.mp4")).toBeNull()
    expect(withoutTotal.requestedRanges.length).toBeLessThanOrEqual(2)
  })
})

describe("mp4 track discovery", () => {
  it("returns null for a file with no text tracks but still lists its audio tracks", async () => {
    const built = buildMp4({ tracks: [stereoAudioTrack(1, "eng"), stereoAudioTrack(2, "ger", "ac-3")] })
    serve(built.bytes)

    expect(await openMp4SubtitleSession("https://host.test/audio-only.mp4")).toBeNull()
    expect(await listMp4AudioTracks("https://host.test/audio-only-list.mp4")).toEqual([
      { trackId: 1, index: 0, language: "eng", codec: "mp4a" },
      { trackId: 2, index: 1, language: "ger", codec: "ac-3" },
    ])
  })

  it("labels multiple tx3g tracks and indexes multiple audio tracks from the same moov", async () => {
    const built = buildMp4({
      tracks: [
        stereoAudioTrack(1, "eng"),
        englishSubtitleTrack([["first english"]], 2),
        englishSubtitleTrack([["second english"]], 3),
        { trackId: 4, mediaType: "text", language: "spa", sampleClusters: [tx3gCluster(["hola", "adios"])] },
        stereoAudioTrack(5, "ger", "ac-3"),
      ],
      moovPosition: "after-mdat",
      mdatLeadingPadding: 90_000,
    })
    serve(built.bytes)

    const session = await openMp4SubtitleSession("https://host.test/multi-track.mp4")
    expect(session!.tracks).toEqual([
      { trackId: 2, language: "eng", label: "English", sampleCount: 1 },
      { trackId: 3, language: "eng", label: "English 2", sampleCount: 1 },
      { trackId: 4, language: "spa", label: "Spanish", sampleCount: 2 },
    ])

    const audioTracks = await listMp4AudioTracks("https://host.test/multi-track.mp4")
    expect(audioTracks).toEqual([
      { trackId: 1, index: 0, language: "eng", codec: "mp4a" },
      { trackId: 5, index: 1, language: "ger", codec: "ac-3" },
    ])
  })

  it("caches the parsed moov, so a second probe of the same url issues no new fetches", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["cached"]]), stereoAudioTrack(2, "eng")] })
    const server = serve(built.bytes)
    const url = "https://host.test/cached.mp4"

    await openMp4SubtitleSession(url)
    const fetchesAfterFirstProbe = server.requestedRanges.length
    expect(fetchesAfterFirstProbe).toBe(2)

    const audioTracks = await listMp4AudioTracks(url)
    expect(audioTracks).toHaveLength(1)
    expect(server.requestedRanges).toHaveLength(fetchesAfterFirstProbe)
  })

  it("does not cache a failed probe, so a later call retries", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["retry"]])] })
    const server = serve(built.bytes, { ignoreRange: true })
    const url = "https://host.test/retry.mp4"

    expect(await openMp4SubtitleSession(url)).toBeNull()
    expect(await openMp4SubtitleSession(url)).toBeNull()
    expect(server.requestedRanges).toEqual([HEAD_PROBE_RANGE, HEAD_PROBE_RANGE])
  })

  it("skips the network entirely for a url that cannot carry mp4 subtitles", async () => {
    serve(new Uint8Array(0))

    expect(await openMp4SubtitleSession("https://host.test/movie.mkv")).toBeNull()
    expect(await listMp4AudioTracks("https://host.test/movie.mkv")).toEqual([])
    expect(providerFetchMock).not.toHaveBeenCalled()
  })
})

describe("mp4 cue extraction", () => {
  it("coalesces one contiguous cluster into a single range fetch", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["one", "two", "three"]])] })
    const server = serve(built.bytes)
    const session = await openMp4SubtitleSession("https://host.test/one-cluster.mp4")
    server.requestedRanges.length = 0

    const cues: SubtitleCue[] = []
    await session!.extract(1, { onCues: (batch) => cues.push(...batch) })

    const sampleOffsets = built.sampleOffsetsPerTrack[0]
    const lastSampleEnd = sampleOffsets[2] + tx3gSample("three").length
    expect(server.requestedRanges).toEqual([`bytes=${sampleOffsets[0]}-${lastSampleEnd - 1}`])
    expect(cues).toEqual([
      { startSeconds: 0, endSeconds: 1, text: "one" },
      { startSeconds: 1, endSeconds: 2, text: "two" },
      { startSeconds: 2, endSeconds: 3, text: "three" },
    ])
  })

  it("issues one range fetch per cluster when samples are far apart", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["a", "b"], ["c"]])] })
    const server = serve(built.bytes)
    const session = await openMp4SubtitleSession("https://host.test/two-clusters.mp4")
    server.requestedRanges.length = 0

    const batches: SubtitleCue[][] = []
    await session!.extract(1, { onCues: (batch) => batches.push(batch) })

    const sampleOffsets = built.sampleOffsetsPerTrack[0]
    expect(server.requestedRanges).toEqual([
      `bytes=${sampleOffsets[0]}-${sampleOffsets[1] + tx3gSample("b").length - 1}`,
      `bytes=${sampleOffsets[2]}-${sampleOffsets[2] + tx3gSample("c").length - 1}`,
    ])
    expect(batches.map((batch) => batch.map((cue) => cue.text))).toEqual([["a", "b"], ["c"]])
  })

  it("starts at the cluster covering startAtSeconds and wraps around", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["a"], ["b"], ["c"]])] })
    const server = serve(built.bytes)
    const session = await openMp4SubtitleSession("https://host.test/seeked.mp4")
    server.requestedRanges.length = 0

    const cues: SubtitleCue[] = []
    await session!.extract(1, { startAtSeconds: 2.5, onCues: (batch) => cues.push(...batch) })

    const sampleOffsets = built.sampleOffsetsPerTrack[0]
    expect(server.requestedRanges[0]).toBe(`bytes=${sampleOffsets[2]}-${sampleOffsets[2] + tx3gSample("c").length - 1}`)
    expect(server.requestedRanges).toHaveLength(3)
    expect(cues.map((cue) => cue.text).sort()).toEqual(["a", "b", "c"])
  })

  it("stops extracting when the server stops honoring Range mid-extraction", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["a"], ["b"]])] })
    serve(built.bytes)
    const session = await openMp4SubtitleSession("https://host.test/extract-range-blind.mp4")
    providerFetchMock.mockImplementation(async () => new Response(built.bytes.slice(), { status: 200 }))

    const cues: SubtitleCue[] = []
    await expect(session!.extract(1, { onCues: (batch) => cues.push(...batch) })).resolves.toBeUndefined()
    expect(cues).toEqual([])
  })

  it("does nothing for an unknown track id", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["a"]])] })
    const server = serve(built.bytes)
    const session = await openMp4SubtitleSession("https://host.test/unknown-track.mp4")
    server.requestedRanges.length = 0
    const onCues = vi.fn()

    await session!.extract(99, { onCues })
    expect(server.requestedRanges).toEqual([])
    expect(onCues).not.toHaveBeenCalled()
  })

  it("skips fetching when the extraction signal is already aborted", async () => {
    const built = buildMp4({ tracks: [englishSubtitleTrack([["a"]])] })
    const server = serve(built.bytes)
    const session = await openMp4SubtitleSession("https://host.test/aborted.mp4")
    server.requestedRanges.length = 0
    const onCues = vi.fn()

    const controller = new AbortController()
    controller.abort()
    await session!.extract(1, { signal: controller.signal, onCues })
    expect(server.requestedRanges).toEqual([])
    expect(onCues).not.toHaveBeenCalled()
  })
})
