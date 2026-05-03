import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { parseM3U } from "../src/scripts/lib/m3u-parser"

const here = dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return readFileSync(resolve(here, "fixtures/m3u", name), "utf8")
}

describe("parseM3U: standard fixture", () => {
  const result = parseM3U(fixture("standard.m3u"))

  it("extracts the EPG URL from the #EXTM3U header", () => {
    expect(result.epgUrl).toBe("https://example.com/epg.xml.gz")
  })

  it("returns one entry per channel", () => {
    expect(result.entries).toHaveLength(3)
  })

  it("extracts name, tvg-id, tvg-logo, group-title", () => {
    const [first] = result.entries
    expect(first.name).toBe("BBC One HD")
    expect(first.tvgId).toBe("bbcone.uk")
    expect(first.logo).toBe("https://example.com/bbc1.png")
    expect(first.category).toBe("UK News")
  })

  it("captures the URL line that follows EXTINF", () => {
    expect(result.entries[0].url).toBe("http://example.com/live/u/p/1.m3u8")
  })

  it("leaves missing fields as null (not empty string)", () => {
    const cnn = result.entries[2]
    expect(cnn.logo).toBeNull()
    expect(cnn.tvgName).toBeNull()
    expect(cnn.userAgent).toBeNull()
    expect(cnn.referer).toBeNull()
    expect(cnn.chno).toBeNull()
    expect(cnn.catchup).toBeNull()
  })
})

describe("parseM3U: BOM and CRLF", () => {
  it("strips a leading UTF-8 BOM", () => {
    const text =
      "﻿#EXTM3U\n" +
      "#EXTINF:-1 tvg-id=\"x\" group-title=\"G\",Has BOM\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe("Has BOM")
    expect(result.entries[0].tvgId).toBe("x")
  })

  it("handles Windows CRLF line endings", () => {
    const text =
      "#EXTM3U\r\n" +
      "#EXTINF:-1 tvg-id=\"x\" group-title=\"G\",CRLF Channel\r\n" +
      "http://example.com/x.m3u8\r\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe("CRLF Channel")
  })
})

describe("parseM3U: EXTINF format variants", () => {
  it("handles attrs-after-comma alt order", () => {
    const result = parseM3U(fixture("alt-order.m3u"))
    expect(result.entries).toHaveLength(2)
    const [alt, std] = result.entries
    expect(alt.tvgId).toBe("alt.one")
    expect(alt.logo).toBe("https://example.com/a.png")
    expect(alt.name).toBe("Alt Order Channel")
    expect(std.tvgId).toBe("alt.two")
    expect(std.category).toBe("Mixed")
  })

  it("falls back to tvg-name when the comma-tail name is empty", () => {
    const text =
      "#EXTM3U\n" +
      "#EXTINF:-1 tvg-id=\"x\" tvg-name=\"From tvg-name\",\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].name).toBe("From tvg-name")
    expect(result.entries[0].tvgName).toBe("From tvg-name")
  })

  it("strips remaining attribute pairs from the name field", () => {
    const text =
      "#EXTM3U\n" +
      "#EXTINF:-1 tvg-id=\"x\",Real Name tvg-extra=\"junk\"\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].name).toBe("Real Name")
  })
})

describe("parseM3U: attribute parsing edge cases", () => {
  it("respects escaped quotes inside quoted values", () => {
    const text =
      "#EXTM3U\n" +
      "#EXTINF:-1 tvg-id=\"x\" tvg-name=\"Inner \\\"quote\\\" here\" group-title=\"G\",Escaped\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgName).toBe('Inner "quote" here')
  })

  it("supports unquoted attribute values", () => {
    const text =
      "#EXTM3U\n" +
      "#EXTINF:-1 tvg-id=bare-id group-title=Bare,Bare attrs\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgId).toBe("bare-id")
    expect(result.entries[0].category).toBe("Bare")
  })

  it("does not match attribute fragments that share a suffix", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 my-tvg-id="not-a-real-tvg-id" tvg-id="real-id",Suffix Trap\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgId).toBe("real-id")
  })

  it("does not crash on a malformed unterminated quote", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="never-closes group-title="G",Malformed\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].url).toBe("http://example.com/x.m3u8")
  })
})

describe("parseM3U: EPG header variants", () => {
  it("reads tvg-url when x-tvg-url is absent", () => {
    const text =
      '#EXTM3U tvg-url="https://example.com/guide.xml"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrl).toBe("https://example.com/guide.xml")
  })

  it("reads url-tvg as a third alias", () => {
    const text =
      '#EXTM3U url-tvg="https://example.com/u.xml"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrl).toBe("https://example.com/u.xml")
  })

  it("returns empty epgUrl when no header attr is present", () => {
    const result = parseM3U(fixture("alt-order.m3u"))
    expect(result.epgUrl).toBe("")
  })
})

describe("parseM3U: EXTGRP and tvg-chno", () => {
  it("uses #EXTGRP: as group fallback when group-title is missing", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x",Group via EXTGRP\n' +
      "#EXTGRP:Sports\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].category).toBe("Sports")
  })

  it("prefers group-title over #EXTGRP: when both are present", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" group-title="Primary",Both Set\n' +
      "#EXTGRP:Secondary\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].category).toBe("Primary")
  })

  it("parses tvg-chno into a number", () => {
    const result = parseM3U(fixture("catchup.m3u"))
    expect(result.entries[0].chno).toBe(42)
    expect(result.entries[1].chno).toBeNull()
  })
})

describe("parseM3U: catchup attributes", () => {
  it("captures catchup mode and catchup-days", () => {
    const result = parseM3U(fixture("catchup.m3u"))
    const [first, second] = result.entries
    expect(first.catchup).toBe("append")
    expect(first.catchupDays).toBe(7)
    expect(second.catchup).toBe("default")
    expect(second.catchupDays).toBeNull()
  })
})

describe("parseM3U: per-channel #EXTVLCOPT headers", () => {
  const result = parseM3U(fixture("extvlcopt-headers.m3u"))

  it("captures http-user-agent into entry.userAgent", () => {
    expect(result.entries[0].userAgent).toBe("VLC/3.0.18 LibVLC/3.0.18")
  })

  it("captures http-referrer into entry.referer", () => {
    expect(result.entries[0].referer).toBe("https://picky.example.com/")
  })

  it("does not leak headers onto the next entry", () => {
    expect(result.entries[1].userAgent).toBeNull()
    expect(result.entries[1].referer).toBeNull()
  })
})

describe("parseM3U: HLS sub-playlist tags", () => {
  it("does not crash on interleaved #EXT-X-* tags", () => {
    const result = parseM3U(fixture("hls-master.m3u"))
    expect(result.entries).toHaveLength(2)
  })

  it("ignores #EXT-X-STREAM-INF as if it were a comment", () => {
    const result = parseM3U(fixture("hls-master.m3u"))
    expect(result.entries[0].name).toBe("HLS-flavored")
    expect(result.entries[0].url).toBe("http://example.com/master.m3u8")
  })
})

describe("parseM3U: malformed input resilience", () => {
  it("ignores a bare URL with no preceding #EXTINF", () => {
    const text =
      "#EXTM3U\n" +
      "http://orphan.example.com/stream.m3u8\n" +
      '#EXTINF:-1 tvg-id="x" group-title="G",Real\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe("Real")
  })

  it("skips blank lines and unrelated comments", () => {
    const text =
      "#EXTM3U\n" +
      "\n" +
      "# unrelated\n" +
      "#KODIPROP:inputstream.adaptive.manifest_type=hls\n" +
      '#EXTINF:-1 tvg-id="x",Solid\n' +
      "http://example.com/x.m3u8\n" +
      "\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe("Solid")
  })

  it("drops an EXTINF with no following URL line", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="lonely",Lonely Channel\n'
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(0)
  })

  it("returns an empty result for an empty input", () => {
    expect(parseM3U("")).toEqual({ entries: [], epgUrl: "" })
  })

  it("returns an empty result for whitespace-only input", () => {
    expect(parseM3U("\n\n  \n\r\n")).toEqual({ entries: [], epgUrl: "" })
  })
})
