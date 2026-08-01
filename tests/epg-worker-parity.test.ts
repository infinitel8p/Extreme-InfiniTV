/**
 * @vitest-environment jsdom
 *
 * Pins the worker's scanner parser against the DOM implementation in epg-data.js
 * on the constructs a hand-rolled scanner is most likely to get wrong.
 */
import { describe, it, expect } from "vitest"
import { parseXmlTv as parseDom } from "../src/scripts/lib/epg-data.js"
import { parseXmlTv as parseScanner } from "../src/scripts/lib/epg-worker.ts"

function formatXmlTvDate(ms: number, suffix = " +0000"): string {
  const date = new Date(ms)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${suffix}`
  )
}

const START = Date.now() - 60 * 60 * 1000
const STOP = Date.now() + 60 * 60 * 1000

function wrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><tv>${inner}</tv>`
}

function programme(attrs: string, children: string): string {
  return (
    `<programme start="${formatXmlTvDate(START)}" stop="${formatXmlTvDate(STOP)}" ` +
    `channel="ch1" ${attrs}>${children}</programme>`
  )
}

/** Compares the fields both parsers are contracted to agree on. */
function expectParity(xml: string) {
  const dom = parseDom(xml)
  const scanner = parseScanner(xml)
  expect(Array.from(scanner.channelNames.entries())).toEqual(
    Array.from(dom.channelNames.entries())
  )
  expect(Array.from(scanner.programmes.keys())).toEqual(Array.from(dom.programmes.keys()))
  for (const key of dom.programmes.keys()) {
    expect(scanner.programmes.get(key)).toEqual(dom.programmes.get(key))
  }
  expect(scanner.hasExplicitTimezones).toBe(dom.hasExplicitTimezones)
  return scanner
}

describe("epg worker parser: parity with the DOM parser", () => {
  it("decodes the five predefined XML entities in text and attributes", () => {
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-name>Rock &amp; Roll &lt;HD&gt;</display-name></channel>` +
          programme(`catchup-id="a&amp;b"`, `<title>Tom &apos;n&apos; Jerry &quot;Best&quot;</title>`)
      )
    )
    expect(result.channelNames.get("ch1")).toBe("Rock & Roll <HD>")
    expect(result.programmes.get("ch1")?.[0].title).toBe(`Tom 'n' Jerry "Best"`)
    expect(result.programmes.get("ch1")?.[0].catchupId).toBe("a&b")
  })

  it("decodes numeric and hex character references", () => {
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-name>Caf&#233; &#x1F600;</display-name></channel>` +
          programme("", `<title>&#65;&#x42;</title>`)
      )
    )
    expect(result.channelNames.get("ch1")).toBe("Café 😀")
    expect(result.programmes.get("ch1")?.[0].title).toBe("AB")
  })

  it("reads CDATA content literally without entity decoding", () => {
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-name><![CDATA[Sport & <Fun>]]></display-name></channel>` +
          programme("", `<title><![CDATA[Raw &amp; Uncut]]></title><desc><![CDATA[a < b]]></desc>`)
      )
    )
    expect(result.channelNames.get("ch1")).toBe("Sport & <Fun>")
    expect(result.programmes.get("ch1")?.[0].title).toBe("Raw &amp; Uncut")
    expect(result.programmes.get("ch1")?.[0].desc).toBe("a < b")
  })

  it("handles single-quoted attributes and arbitrary attribute order", () => {
    const xml = wrap(
      `<channel id='ch1'><display-name>Channel One</display-name></channel>` +
        `<programme channel='ch1' stop='${formatXmlTvDate(STOP)}' ` +
        `start='${formatXmlTvDate(START)}'><title>Ordered</title></programme>`
    )
    const result = expectParity(xml)
    expect(result.programmes.get("ch1")?.[0].title).toBe("Ordered")
  })

  it("does not confuse <programmes> or <display-names> with the real tags", () => {
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-names>Decoy</display-names>` +
          `<display-name>Real Name</display-name></channel>` +
          `<programmes>decoy</programmes>` +
          programme("", `<title>Real Show</title>`)
      )
    )
    expect(result.channelNames.get("ch1")).toBe("Real Name")
    expect(result.programmes.get("ch1")).toHaveLength(1)
  })

  it("tolerates self-closing programme and empty-element title", () => {
    const xml = wrap(
      `<channel id="ch1"><display-name>Channel One</display-name></channel>` +
        `<programme start="${formatXmlTvDate(START)}" stop="${formatXmlTvDate(STOP)}" channel="ch1"/>` +
        programme("", `<title/><desc>Body</desc>`)
    )
    const result = expectParity(xml)
    // A titleless programme still lands, defaulted, exactly as the DOM parser does.
    expect(result.programmes.get("ch1")?.every((entry) => entry.title === "Untitled")).toBe(true)
  })

  it("takes the first title when a programme carries several", () => {
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-name>Channel One</display-name></channel>` +
          programme("", `<title lang="en">English</title><title lang="de">Deutsch</title>`)
      )
    )
    expect(result.programmes.get("ch1")?.[0].title).toBe("English")
  })

  it("skips comments and ignores nested markup inside title text", () => {
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-name>Channel One</display-name></channel>` +
          `<!-- a comment with <programme> inside -->` +
          programme("", `<title>Part <b>One</b></title>`)
      )
    )
    expect(result.programmes.get("ch1")?.[0].title).toBe("Part One")
  })

  it("lowercases channel ids on both sides", () => {
    const result = expectParity(
      wrap(
        `<channel id="CH1.Example"><display-name>Mixed</display-name></channel>` +
          `<programme start="${formatXmlTvDate(START)}" stop="${formatXmlTvDate(STOP)}" ` +
          `channel="CH1.Example"><title>Show</title></programme>`
      )
    )
    expect(result.channelNames.has("ch1.example")).toBe(true)
    expect(result.programmes.has("ch1.example")).toBe(true)
  })

  it("agrees on the explicit-timezone verdict for floating timestamps", () => {
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-name>Channel One</display-name></channel>` +
          `<programme start="${formatXmlTvDate(START, "")}" stop="${formatXmlTvDate(STOP, "")}" ` +
          `channel="ch1"><title>Floating</title></programme>`
      )
    )
    expect(result.hasExplicitTimezones).toBe(false)
  })

  it("drops overlapping programmes identically", () => {
    const base = Date.now()
    const at = (offsetMin: number) => formatXmlTvDate(base + offsetMin * 60 * 1000)
    const result = expectParity(
      wrap(
        `<channel id="ch1"><display-name>Channel One</display-name></channel>` +
          `<programme start="${at(0)}" stop="${at(60)}" channel="ch1"><title>First</title></programme>` +
          `<programme start="${at(30)}" stop="${at(90)}" channel="ch1"><title>Overlap</title></programme>` +
          `<programme start="${at(60)}" stop="${at(120)}" channel="ch1"><title>Second</title></programme>`
      )
    )
    expect(result.programmes.get("ch1")?.map((entry) => entry.title)).toEqual(["First", "Second"])
  })
})

describe("epg worker parser: guards", () => {
  it("rejects an ENTITY declaration", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE tv [<!ENTITY lol "lol">]><tv></tv>`
    expect(() => parseScanner(xml)).toThrow(/ENTITY/)
  })

  it("rejects a provider HTML error page instead of returning empty maps", () => {
    // The DOM parser surfaces these as a parsererror; the scanner needs its own guard
    // so an auth failure is reported rather than cached as "no programmes".
    expect(() => parseScanner("<html><body>403 Forbidden</body></html>")).toThrow(/no <tv> root/)
  })

  it("accepts a tv root carrying attributes", () => {
    const xml =
      `<?xml version="1.0"?><tv generator-info-name="test">` +
      `<channel id="ch1"><display-name>Channel One</display-name></channel></tv>`
    expect(parseScanner(xml).channelNames.get("ch1")).toBe("Channel One")
  })
})
