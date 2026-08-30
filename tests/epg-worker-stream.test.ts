/**
 * @vitest-environment jsdom
 *
 * Streaming now-next scan: begin/chunk/end message contract, gzip + plain
 * bytes, chunk boundaries split mid-tag / mid-attribute / mid-multibyte
 * character, the carry-buffer overflow guard, and the streamed
 * `programmesFor` replay path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { gzipSync } from "node:zlib"
import {
  handleWorkerRequest,
  parseXmlTvNowNext,
  extractChannelProgrammes,
} from "../src/scripts/lib/epg-worker.ts"

const PINNED_NOW = new Date("2026-01-15T12:00:00Z").getTime()
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(PINNED_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

function xmltvStamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  )
}

function programmeXml(channel: string, title: string, startOffsetHours: number, catchupId?: string): string {
  const start = PINNED_NOW + startOffsetHours * HOUR
  const stop = start + HOUR
  const attr = catchupId ? ` catchup-id="${catchupId}"` : ""
  return (
    `<programme start="${xmltvStamp(start)}" stop="${xmltvStamp(stop)}" channel="${channel}"${attr}>` +
    `<title>${title}</title><desc>Description for ${title} 🎬</desc></programme>`
  )
}

function buildXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="stream test">` +
    `<channel id="news-one"><display-name>News Café 🎬</display-name></channel>` +
    `<channel id="sports-one"><display-name>Sports One</display-name></channel>` +
    programmeXml("news-one", "Currently Airing", -1) +
    programmeXml("news-one", "Up Next", 1) +
    programmeXml("news-one", "Later Still", 3) +
    programmeXml("sports-one", "Kickoff Soon", 2, "sp-42") +
    `</tv>`
  )
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const sorted = [...new Set(offsets)].filter((offset) => offset > 0 && offset < bytes.length).sort((a, b) => a - b)
  const chunks: Uint8Array[] = []
  let cursor = 0
  for (const offset of sorted) {
    chunks.push(bytes.slice(cursor, offset))
    cursor = offset
  }
  chunks.push(bytes.slice(cursor))
  return chunks.filter((chunk) => chunk.length > 0)
}

interface StreamReply {
  programmes?: Array<[string, unknown]>
  channelNames?: Array<[string, string]>
  hasExplicitTimezones?: boolean
  error?: string
  noFeed?: boolean
}

async function driveStream(
  chunks: Uint8Array[],
  opts: { gzip: boolean; feedId: string; id: number }
): Promise<StreamReply> {
  handleWorkerRequest({
    id: opts.id,
    type: "begin",
    mode: "now-next",
    feedId: opts.feedId,
    nowMs: PINNED_NOW,
    gzip: opts.gzip,
  })
  for (const chunk of chunks) {
    handleWorkerRequest({ id: opts.id, type: "chunk", feedId: opts.feedId, bytes: toArrayBuffer(chunk) })
  }
  return (await handleWorkerRequest({ id: opts.id, type: "end", feedId: opts.feedId })) as StreamReply
}

describe("streaming now-next scan: plain bytes, awkward chunk boundaries", () => {
  const xml = buildXml()
  const expected = parseXmlTvNowNext(xml, PINNED_NOW)

  it("matches the whole-string parse when split mid-tag, mid-attribute, and mid-multibyte-character", async () => {
    const bytes = new TextEncoder().encode(xml)
    const encoder = new TextEncoder()
    // Deliberately awkward cut points: inside an open tag's attribute run,
    // inside an attribute value, and inside the UTF-8 encoding of "🎬" (a
    // 4-byte codepoint) within "News Café 🎬".
    const emojiByteIndex = encoder.encode(xml.slice(0, xml.indexOf("🎬"))).length
    const cafeByteIndex = encoder.encode(xml.slice(0, xml.indexOf("Café"))).length
    const midAttrIndex = xml.indexOf('channel="news-one"') + 5
    const midTagIndex = xml.indexOf("<programme") + 5

    const offsets = [
      midTagIndex,
      midAttrIndex,
      cafeByteIndex + 2,
      emojiByteIndex + 2, // lands inside the emoji's 4-byte UTF-8 sequence
      Math.floor(bytes.length / 2),
      bytes.length - 10,
    ]

    const reply = await driveStream(splitAt(bytes, offsets), { gzip: false, feedId: "stream-plain", id: 1 })

    expect(reply.error).toBeUndefined()
    expect(reply.programmes).toEqual(Array.from(expected.programmes.entries()))
    expect(reply.channelNames).toEqual(Array.from(expected.channelNames.entries()))
    expect(reply.hasExplicitTimezones).toBe(expected.hasExplicitTimezones)
  })

  it("matches the whole-string parse when every chunk is a single byte", async () => {
    const bytes = new TextEncoder().encode(xml)
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))
    const reply = await driveStream(chunks, { gzip: false, feedId: "stream-single-byte", id: 2 })
    expect(reply.error).toBeUndefined()
    expect(reply.programmes).toEqual(Array.from(expected.programmes.entries()))
  })
})

describe("streaming now-next scan: gzip bytes", () => {
  const xml = buildXml()
  const expected = parseXmlTvNowNext(xml, PINNED_NOW)

  it("decompresses incrementally and matches the whole-string parse when chunked", async () => {
    const compressed = new Uint8Array(gzipSync(Buffer.from(xml, "utf8")))
    const offsets = [10, Math.floor(compressed.length / 3), Math.floor((compressed.length * 2) / 3)]
    const reply = await driveStream(splitAt(compressed, offsets), { gzip: true, feedId: "stream-gzip", id: 3 })

    expect(reply.error).toBeUndefined()
    expect(reply.programmes).toEqual(Array.from(expected.programmes.entries()))
    expect(reply.channelNames).toEqual(Array.from(expected.channelNames.entries()))
  })
})

describe("streaming programmesFor: replays the retained (compressed) chunks", () => {
  it("matches the full parse's per-channel array after a plain stream", async () => {
    const xml = buildXml()
    const bytes = new TextEncoder().encode(xml)
    const chunks = splitAt(bytes, [Math.floor(bytes.length / 4), Math.floor(bytes.length / 2)])
    await driveStream(chunks, { gzip: false, feedId: "stream-programmes-for", id: 4 })

    const reply = (await handleWorkerRequest({
      id: 5,
      type: "programmesFor",
      feedId: "stream-programmes-for",
      tvgId: "news-one",
    })) as StreamReply

    expect(reply.programmes).toEqual(extractChannelProgrammes(xml, "news-one"))
  })

  it("matches the full parse's per-channel array after a gzip stream", async () => {
    const xml = buildXml()
    const compressed = new Uint8Array(gzipSync(Buffer.from(xml, "utf8")))
    const chunks = splitAt(compressed, [Math.floor(compressed.length / 2)])
    await driveStream(chunks, { gzip: true, feedId: "stream-programmes-for-gzip", id: 6 })

    const reply = (await handleWorkerRequest({
      id: 7,
      type: "programmesFor",
      feedId: "stream-programmes-for-gzip",
      tvgId: "sports-one",
    })) as StreamReply

    expect(reply.programmes).toEqual(extractChannelProgrammes(xml, "sports-one"))
  })

  it("reports no-feed for a feedId that was never streamed", async () => {
    const reply = (await handleWorkerRequest({
      id: 8,
      type: "programmesFor",
      feedId: "never-streamed",
      tvgId: "news-one",
    })) as StreamReply
    expect(reply.noFeed).toBe(true)
  })
})

describe("streaming now-next scan: carry-buffer overflow guard", () => {
  it("degrades without throwing when an element never closes within the carry cap, then recovers on the next element", async () => {
    const start = PINNED_NOW - HOUR
    const stop = PINNED_NOW + HOUR
    // No closing tag ever appears for this one - simulates a corrupt/runaway element.
    const unclosed = `<programme start="${xmltvStamp(start)}" stop="${xmltvStamp(stop)}" channel="ch1">`
    // No "<" anywhere in here, and well past the 512KB carry cap on its own.
    const filler = "no closing tag anywhere near here ".repeat(30000)
    const real = programmeXml("ch1", "Survives", 1)
    const prefix = `<?xml version="1.0"?><tv><channel id="ch1"><display-name>Ch1</display-name></channel>`

    // First chunk alone (prefix + the unclosed open tag + more than half of the
    // filler) already exceeds the cap, forcing a mid-chunk recovery before
    // "real" is ever appended to the carry.
    const chunk1 = new TextEncoder().encode(prefix + unclosed + filler.slice(0, filler.length * 0.6))
    const chunk2 = new TextEncoder().encode(filler.slice(filler.length * 0.6))
    const chunk3 = new TextEncoder().encode(real + `</tv>`)

    const reply = await driveStream([chunk1, chunk2, chunk3], {
      gzip: false,
      feedId: "stream-overflow",
      id: 9,
    })

    expect(reply.error).toBeUndefined()
    // The runaway element's own current-window programme was dropped by the
    // overflow guard; only the later, well-formed element survives.
    expect(reply.programmes).toEqual([
      [
        "ch1",
        [
          {
            start: PINNED_NOW + HOUR,
            stop: PINNED_NOW + 2 * HOUR,
            title: "Survives",
            desc: "Description for Survives 🎬",
            catchupId: undefined,
          },
        ],
      ],
    ])
  })
})
