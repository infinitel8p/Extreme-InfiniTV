/**
 * @vitest-environment jsdom
 *
 * Lite-tier now-next scan + per-channel extraction + the retained-feed
 * request contract used by getProgrammesForChannel (epg-data.js).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { parseXmlTv } from "../src/scripts/lib/epg-worker.ts"

const here = dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return readFileSync(resolve(here, "fixtures/xmltv", name), "utf8")
}

// standard.xml's programmes are authored around this instant.
const PINNED_NOW = new Date("2026-01-15T12:00:00Z").getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(PINNED_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("parseXmlTvNowNext: standard.xml fixture", () => {
  it("keeps only the airing + upcoming programme per channel", async () => {
    const { parseXmlTvNowNext } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = fixture("standard.xml")
    const { programmes } = parseXmlTvNowNext(xml, PINNED_NOW)

    // Boundary: "World Watch" starts exactly at nowMs (inclusive current);
    // "Midday Briefing" stops exactly at nowMs (exclusive, already over).
    expect(programmes.get("news-one")?.map((entry) => entry.title)).toEqual([
      "World Watch",
      "Afternoon Edition",
    ])
    // No current airs on sports-one yet; next is the earliest future start.
    expect(programmes.get("sports-one")?.map((entry) => entry.title)).toEqual(["Matchday Preview"])
    expect(programmes.get("movie-central")?.map((entry) => entry.title)).toEqual([
      "Saturday Night Feature",
    ])
    expect(programmes.get("docu-world")?.map((entry) => entry.title)).toEqual(["Wild Frontiers"])
    // Every kids-fun programme has already ended - no current, no next, no entry at all.
    expect(programmes.has("kids-fun")).toBe(false)
  })

  it("agrees with the DOM channelNames and hasExplicitTimezones parity fields", async () => {
    const { parseXmlTvNowNext } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = fixture("standard.xml")
    const dom = parseXmlTv(xml)
    const nowNext = parseXmlTvNowNext(xml, PINNED_NOW)
    expect(Array.from(nowNext.channelNames.entries())).toEqual(Array.from(dom.channelNames.entries()))
    expect(nowNext.hasExplicitTimezones).toBe(dom.hasExplicitTimezones)
  })
})

describe("parseXmlTvNowNext: boundaries and tie-breaking", () => {
  function wrap(programmes: string): string {
    return `<?xml version="1.0"?><tv><channel id="ch1"><display-name>Ch1</display-name></channel>${programmes}</tv>`
  }
  function programme(title: string, startMs: number, stopMs: number): string {
    const format = (ms: number) => {
      const date = new Date(ms)
      const pad = (value: number) => String(value).padStart(2, "0")
      return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
      )
    }
    return `<programme start="${format(startMs)}" stop="${format(stopMs)}" channel="ch1"><title>${title}</title></programme>`
  }
  const hour = 60 * 60 * 1000

  it("treats a programme stopping exactly at nowMs as already over", async () => {
    const { parseXmlTvNowNext } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = wrap(programme("Just Ended", PINNED_NOW - hour, PINNED_NOW))
    const { programmes } = parseXmlTvNowNext(xml, PINNED_NOW)
    expect(programmes.has("ch1")).toBe(false)
  })

  it("treats a programme starting exactly at nowMs as current", async () => {
    const { parseXmlTvNowNext } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = wrap(programme("Just Started", PINNED_NOW, PINNED_NOW + hour))
    const { programmes } = parseXmlTvNowNext(xml, PINNED_NOW)
    expect(programmes.get("ch1")?.map((entry) => entry.title)).toEqual(["Just Started"])
  })

  it("picks the latest-starting overlapping programme as current, and earliest future start as next", async () => {
    const { parseXmlTvNowNext } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = wrap(
      programme("Earlier Overlap", PINNED_NOW - 2 * hour, PINNED_NOW + hour) +
        programme("Later Overlap", PINNED_NOW - hour, PINNED_NOW + 2 * hour) +
        programme("Far Next", PINNED_NOW + 5 * hour, PINNED_NOW + 6 * hour) +
        programme("Near Next", PINNED_NOW + 3 * hour, PINNED_NOW + 4 * hour)
    )
    const { programmes } = parseXmlTvNowNext(xml, PINNED_NOW)
    expect(programmes.get("ch1")?.map((entry) => entry.title)).toEqual(["Later Overlap", "Near Next"])
  })
})

describe("extractChannelProgrammes", () => {
  it("matches the full parse's array for a channel across the whole feed", async () => {
    const { extractChannelProgrammes } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = fixture("standard.xml")
    const full = parseXmlTv(xml).programmes.get("docu-world")
    const extracted = extractChannelProgrammes(xml, "docu-world")
    expect(extracted).toEqual(full)
  })

  it("applies the same window semantics as the full parse", async () => {
    const { extractChannelProgrammes } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = fixture("standard.xml")
    const window = { fromMs: new Date("2026-01-15T13:00:00Z").getTime(), toMs: new Date("2026-01-15T21:00:00Z").getTime() }
    const full = parseXmlTv(xml, window).programmes.get("news-one")
    const extracted = extractChannelProgrammes(xml, "news-one", window)
    expect(extracted).toEqual(full)
  })

  it("returns an empty array for a channel with no matching programmes", async () => {
    const { extractChannelProgrammes } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = fixture("standard.xml")
    expect(extractChannelProgrammes(xml, "no-such-channel")).toEqual([])
  })
})

describe("handleWorkerRequest: retained-feed contract for programmesFor", () => {
  it("retains the feed from a now-next parse, serves programmesFor by feedId, and reports no-feed on a mismatch", async () => {
    vi.resetModules()
    const { handleWorkerRequest } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = fixture("standard.xml")

    const parseReply = handleWorkerRequest({ id: 1, xml, mode: "now-next", nowMs: PINNED_NOW, feedId: "feed-a" })
    expect("error" in parseReply && parseReply.error).toBeFalsy()

    const hit = handleWorkerRequest({ id: 2, type: "programmesFor", feedId: "feed-a", tvgId: "docu-world" }) as {
      programmes?: Array<{ title: string }>
    }
    expect(hit.programmes?.map((entry) => entry.title)).toEqual([
      "Wild Frontiers",
      "Deep Ocean",
      "Space Odyssey",
      "History Uncovered",
    ])

    const miss = handleWorkerRequest({ id: 3, type: "programmesFor", feedId: "feed-b", tvgId: "docu-world" })
    expect("noFeed" in miss && miss.noFeed).toBe(true)
  })

  it("reports no-feed when nothing has ever been retained", async () => {
    vi.resetModules()
    const { handleWorkerRequest } = await import("../src/scripts/lib/epg-worker.ts")
    const reply = handleWorkerRequest({ id: 1, type: "programmesFor", feedId: "feed-a", tvgId: "ch1" })
    expect("noFeed" in reply && reply.noFeed).toBe(true)
  })

  it("full mode (no mode field) behaves exactly like parseXmlTv", async () => {
    vi.resetModules()
    const { handleWorkerRequest } = await import("../src/scripts/lib/epg-worker.ts")
    const xml = fixture("standard.xml")
    const reply = handleWorkerRequest({ id: 1, xml })
    const expected = parseXmlTv(xml)
    expect("programmes" in reply ? reply.programmes : null).toEqual(Array.from(expected.programmes.entries()))
  })
})
