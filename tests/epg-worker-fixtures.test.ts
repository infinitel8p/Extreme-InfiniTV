/**
 * @vitest-environment jsdom
 *
 * Exercises epg-worker.ts's scanner against on-disk XMLTV fixtures (unlike
 * epg-worker-parity.test.ts's inline snippets), asserting exact values and DOM parity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { parseXmlTv as parseDom } from "../src/scripts/lib/epg-data.js"
import { parseXmlTv as parseScanner } from "../src/scripts/lib/epg-worker.ts"

const here = dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return readFileSync(resolve(here, "fixtures/xmltv", name), "utf8")
}

// Fixtures are authored around this instant; pinned so the scanner's
// [now-7d, now+36h] window filter doesn't drift against the real clock.
const PINNED_NOW = "2026-01-15T12:00:00Z"

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(PINNED_NOW))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Compares the fields both parsers are contracted to agree on. */
function expectParity(xml: string) {
  const dom = parseDom(xml)
  const scanner = parseScanner(xml)
  expect(Array.from(scanner.channelNames.entries())).toEqual(
    Array.from(dom.channelNames.entries())
  )
  expect(Array.from(scanner.programmes.keys())).toEqual(Array.from(dom.programmes.keys()))
  for (const channelId of dom.programmes.keys()) {
    expect(scanner.programmes.get(channelId)).toEqual(dom.programmes.get(channelId))
  }
  expect(scanner.hasExplicitTimezones).toBe(dom.hasExplicitTimezones)
  return scanner
}

describe("epg worker parser: standard.xml fixture", () => {
  const xml = fixture("standard.xml")
  let result: ReturnType<typeof parseScanner>

  beforeEach(() => {
    result = expectParity(xml)
  })

  it("collects a display-name and icon-bearing channel per feed entry", () => {
    expect(Array.from(result.channelNames.entries())).toEqual([
      ["news-one", "News One"],
      ["sports-one", "Sports One"],
      ["movie-central", "Movie Central"],
      ["kids-fun", "Kids Fun"],
      ["docu-world", "Docu World"],
    ])
  })

  it("parses a full multi-programme schedule for news-one, lowercasing the mixed-case reference", () => {
    const newsOne = result.programmes.get("news-one")
    expect(newsOne?.map((entry) => entry.title)).toEqual([
      "Morning Report",
      "Midday Briefing",
      "World Watch",
      "Afternoon Edition",
    ])
    expect(newsOne?.[0]).toEqual({
      start: Date.UTC(2026, 0, 15, 10, 0, 0),
      stop: Date.UTC(2026, 0, 15, 11, 0, 0),
      title: "Morning Report",
      desc: "A live rundown of the day's top stories from the newsroom.",
      catchupId: undefined,
    })
    expect(newsOne?.[3]).toEqual({
      start: Date.UTC(2026, 0, 15, 13, 0, 0),
      stop: Date.UTC(2026, 0, 15, 14, 0, 0),
      title: "Afternoon Edition",
      desc: "A closer look at the stories developing since midday.",
      catchupId: undefined,
    })
  })

  it("captures the non-standard catchup-id attribute", () => {
    const worldWatch = result.programmes.get("news-one")?.[2]
    expect(worldWatch?.title).toBe("World Watch")
    expect(worldWatch?.catchupId).toBe("nw-1200")
  })

  it("parses every other channel's schedule with exact counts and boundary times", () => {
    expect(result.programmes.get("sports-one")).toHaveLength(3)
    expect(result.programmes.get("movie-central")).toHaveLength(2)
    expect(result.programmes.get("kids-fun")).toHaveLength(3)
    expect(result.programmes.get("docu-world")).toHaveLength(4)

    const kidsFun = result.programmes.get("kids-fun")
    expect(kidsFun?.[0]).toEqual({
      start: Date.UTC(2026, 0, 15, 7, 0, 0),
      stop: Date.UTC(2026, 0, 15, 8, 0, 0),
      title: "Morning Cartoons",
      desc: "A cheerful block of animated shorts to start the day.",
      catchupId: undefined,
    })

    const docuWorld = result.programmes.get("docu-world")
    expect(docuWorld?.[2]).toEqual({
      start: Date.UTC(2026, 0, 15, 23, 0, 0),
      stop: Date.UTC(2026, 0, 16, 0, 0, 0),
      title: "Space Odyssey",
      desc: "A history of crewed spaceflight, from Gagarin to the present.",
      catchupId: undefined,
    })
    expect(docuWorld?.[3]).toEqual({
      start: Date.UTC(2026, 0, 16, 0, 0, 0),
      stop: Date.UTC(2026, 0, 16, 1, 0, 0),
      title: "History Uncovered",
      desc: "Archivists piece together a forgotten chapter of local history.",
      catchupId: undefined,
    })
  })

  it("agrees the feed carries explicit timezones", () => {
    expect(result.hasExplicitTimezones).toBe(true)
  })
})

describe("epg worker parser: quirks.xml fixture", () => {
  const xml = fixture("quirks.xml")
  let result: ReturnType<typeof parseScanner>

  beforeEach(() => {
    result = expectParity(xml)
  })

  it("decodes named and numeric entities in a display-name, taking the first of two", () => {
    expect(result.channelNames.get("quirk-one")).toBe("Quirk & Play Café 🎬")
  })

  it("reads CDATA content literally, without decoding the entity or the markup inside it", () => {
    const first = result.programmes.get("quirk-one")?.[0]
    expect(first?.title).toBe("<b>Bold</b> Show")
    expect(first?.desc).toBe("Line with & <tag> inside")
  })

  it("decodes an entity inside the non-standard catchup-id attribute", () => {
    const first = result.programmes.get("quirk-one")?.[0]
    expect(first?.catchupId).toBe("cu&99")
  })

  it("tolerates a fully self-closing programme with no title or desc at all", () => {
    const second = result.programmes.get("quirk-one")?.[1]
    expect(second?.title).toBe("Untitled")
    expect(second?.desc).toBe("")
    expect(second?.catchupId).toBeUndefined()
  })

  it("takes the first title even when it's a self-closing empty element, ignoring the real one after it", () => {
    const third = result.programmes.get("quirk-one")?.[2]
    expect(third?.title).toBe("Untitled")
    expect(third?.desc).toBe("Padded whitespace desc")
  })

  it("ignores tag-like text inside comments and never scans the decoy channel or title", () => {
    expect(result.channelNames.has("fake")).toBe(false)
    expect(result.programmes.get("quirk-one")).toHaveLength(3)
  })

  it("accepts a plain DOCTYPE line with no ENTITY declaration", () => {
    expect(() => parseScanner(xml)).not.toThrow()
  })
})

describe("epg worker parser: offsets.xml fixture", () => {
  const xml = fixture("offsets.xml")
  let result: ReturnType<typeof parseScanner>

  beforeEach(() => {
    result = expectParity(xml)
  })

  it("converts a positive explicit offset to UTC", () => {
    const continental = result.programmes.get("tz-one")?.[0]
    expect(continental?.title).toBe("Continental Broadcast")
    expect(continental).toEqual({
      start: Date.UTC(2026, 0, 15, 11, 0, 0),
      stop: Date.UTC(2026, 0, 15, 12, 0, 0),
      title: "Continental Broadcast",
      desc: "A broadcast timestamped in a Central European offset.",
      catchupId: undefined,
    })
  })

  it("converts a negative explicit offset to UTC, rolling over into the next day", () => {
    const overseas = result.programmes.get("tz-one")?.[2]
    expect(overseas?.title).toBe("Overseas Feed")
    expect(overseas).toEqual({
      start: Date.UTC(2026, 0, 15, 23, 30, 0),
      stop: Date.UTC(2026, 0, 16, 0, 30, 0),
      title: "Overseas Feed",
      desc: "A relay timestamped in a South Asian offset.",
      catchupId: undefined,
    })
  })

  it("treats a floating (no-suffix) timestamp as already UTC", () => {
    const floating = result.programmes.get("tz-one")?.[1]
    expect(floating?.title).toBe("Floating Slot")
    expect(floating).toEqual({
      start: Date.UTC(2026, 0, 15, 20, 0, 0),
      stop: Date.UTC(2026, 0, 15, 21, 0, 0),
      title: "Floating Slot",
      desc: "A programme with no explicit offset on its timestamps.",
      catchupId: undefined,
    })
  })

  it("sorts the merged schedule by converted UTC start time", () => {
    expect(result.programmes.get("tz-one")?.map((entry) => entry.title)).toEqual([
      "Continental Broadcast",
      "Floating Slot",
      "Overseas Feed",
    ])
  })

  it("reports explicit timezones since a majority of timestamps carry an offset", () => {
    expect(result.hasExplicitTimezones).toBe(true)
  })
})

describe("epg worker parser: offsets-floating.xml fixture", () => {
  const xml = fixture("offsets-floating.xml")
  let result: ReturnType<typeof parseScanner>

  beforeEach(() => {
    result = expectParity(xml)
  })

  it("parses every programme regardless of the missing offsets", () => {
    expect(result.programmes.get("float-one")?.map((entry) => entry.title)).toEqual([
      "Local Slot A",
      "Local Slot B",
      "UTC Slot C",
    ])
  })

  it("reports no explicit timezones since a minority of timestamps carry an offset", () => {
    expect(result.hasExplicitTimezones).toBe(false)
  })
})

describe("epg worker parser: windowing.xml fixture", () => {
  const xml = fixture("windowing.xml")
  let result: ReturnType<typeof parseScanner>

  beforeEach(() => {
    result = expectParity(xml)
  })

  it("keeps a programme whose stop lands exactly on the seven-day past-window boundary", () => {
    const kept = result.programmes.get("win-one")?.find(
      (entry) => entry.title === "Edge Of Past Window Kept"
    )
    expect(kept).toEqual({
      start: Date.UTC(2026, 0, 8, 11, 0, 0),
      stop: Date.UTC(2026, 0, 8, 12, 0, 0),
      title: "Edge Of Past Window Kept",
      desc: "Ends right at the edge of the seven-day past window.",
      catchupId: undefined,
    })
  })

  it("drops a programme whose stop falls just short of the past-window boundary", () => {
    const dropped = result.programmes
      .get("win-one")
      ?.find((entry) => entry.title === "Outside Past Window Dropped")
    expect(dropped).toBeUndefined()
  })

  it("keeps a programme whose start lands exactly on the thirty-six-hour future-window boundary", () => {
    const kept = result.programmes.get("win-one")?.find(
      (entry) => entry.title === "Edge Of Future Window Kept"
    )
    expect(kept).toEqual({
      start: Date.UTC(2026, 0, 17, 0, 0, 0),
      stop: Date.UTC(2026, 0, 17, 1, 0, 0),
      title: "Edge Of Future Window Kept",
      desc: "Starts right at the edge of the thirty-six-hour future window.",
      catchupId: undefined,
    })
  })

  it("drops a programme whose start falls just past the future-window boundary", () => {
    const dropped = result.programmes
      .get("win-one")
      ?.find((entry) => entry.title === "Outside Future Window Dropped")
    expect(dropped).toBeUndefined()
  })

  it("drops a zero-duration programme (stop not after start) regardless of the window", () => {
    const dropped = result.programmes
      .get("win-one")
      ?.find((entry) => entry.title === "Invalid Zero Duration")
    expect(dropped).toBeUndefined()
  })

  it("drops a programme with an unparseable start timestamp", () => {
    const dropped = result.programmes
      .get("win-one")
      ?.find((entry) => entry.title === "Malformed Date Rejected")
    expect(dropped).toBeUndefined()
  })

  it("still records a programme that references a channel with no matching <channel> declaration", () => {
    expect(result.channelNames.has("ghost-channel")).toBe(false)
    expect(result.programmes.get("ghost-channel")).toEqual([
      {
        start: Date.UTC(2026, 0, 15, 9, 0, 0),
        stop: Date.UTC(2026, 0, 15, 10, 0, 0),
        title: "Programme On Undeclared Channel",
        desc: "The channel attribute references an id with no channel element.",
        catchupId: undefined,
      },
    ])
  })

  it("keeps exactly the two in-window win-one programmes and no others", () => {
    expect(result.programmes.get("win-one")).toHaveLength(2)
    expect(result.programmes.get("win-one")?.map((entry) => entry.title)).toEqual([
      "Edge Of Past Window Kept",
      "Edge Of Future Window Kept",
    ])
  })

  it("only declares win-one in channelNames", () => {
    expect(Array.from(result.channelNames.entries())).toEqual([["win-one", "Window One"]])
  })
})
