import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { parseM3U, isHlsStreamManifest } from "../src/scripts/lib/m3u-parser"

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
    expect(cnn.catchupSource).toBeNull()
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

describe("parseM3U: bare-URL pointer files (no #EXTINF)", () => {
  it("treats a single bare URL as one channel named after the host", () => {
    const result = parseM3U("http://icecast.ndr.de/ndr/ndr1niedersachsen/hannover/mp3/128/stream.mp3\n")
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].url).toBe("http://icecast.ndr.de/ndr/ndr1niedersachsen/hannover/mp3/128/stream.mp3")
    expect(result.entries[0].name).toBe("icecast.ndr.de")
  })

  it("treats multiple bare URLs as multiple channels", () => {
    const text =
      "http://stream.radioaktual.si/Aktual\n" +
      "https://icecast.vrtcdn.be/klara-high.mp3\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].url).toBe("http://stream.radioaktual.si/Aktual")
    expect(result.entries[1].url).toBe("https://icecast.vrtcdn.be/klara-high.mp3")
  })

  it("ignores non-URL stray lines but keeps bare URLs", () => {
    const text = "#EXTM3U\nsome junk line\nhttp://example.com/stream\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].url).toBe("http://example.com/stream")
  })

  it("still parses EXTINF entries normally when both are present", () => {
    const text =
      "#EXTM3U\n" +
      "#EXTINF:-1,Named\nhttp://example.com/a\n" +
      "http://example.com/b\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].name).toBe("Named")
    expect(result.entries[1].name).toBe("example.com")
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

  it("does not truncate a quoted attribute value at an embedded comma", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" group-title="News, Sports",Full Name\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].category).toBe("News, Sports")
    expect(result.entries[0].name).toBe("Full Name")
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

  it("splits a comma-joined header value into epgUrls, keeping epgUrl as the first", () => {
    const text =
      '#EXTM3U x-tvg-url="https://a.example/1.xml, https://b.example/2.xml"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrls).toEqual([
      "https://a.example/1.xml",
      "https://b.example/2.xml",
    ])
    expect(result.epgUrl).toBe("https://a.example/1.xml")
  })

  it("dedupes and drops empty segments in a comma-joined header value", () => {
    const text =
      '#EXTM3U x-tvg-url="https://a.example/1.xml,,https://a.example/1.xml, https://b.example/2.xml"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrls).toEqual([
      "https://a.example/1.xml",
      "https://b.example/2.xml",
    ])
  })

  it("returns a single-element epgUrls for a plain single-URL header", () => {
    const result = parseM3U(fixture("standard.m3u"))
    expect(result.epgUrls).toEqual(["https://example.com/epg.xml.gz"])
  })

  it("keeps a comma inside a single URL's query string intact instead of splitting on it", () => {
    const text =
      '#EXTM3U url-tvg="http://epg.example.com/guide.xml?ids=1,2"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrls).toEqual(["http://epg.example.com/guide.xml?ids=1,2"])
    expect(result.epgUrl).toBe("http://epg.example.com/guide.xml?ids=1,2")
  })

  it("splits a query-string URL followed by a second real header source", () => {
    const text =
      '#EXTM3U url-tvg="http://epg.example.com/guide.xml?ids=1,2,https://b.example/2.xml"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrls).toEqual([
      "http://epg.example.com/guide.xml?ids=1,2",
      "https://b.example/2.xml",
    ])
  })

  it("keeps a protocol-relative header value as a single URL", () => {
    const text =
      '#EXTM3U x-tvg-url="//epg.example.com/epg.xml"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrls).toEqual(["//epg.example.com/epg.xml"])
    expect(result.epgUrl).toBe("//epg.example.com/epg.xml")
  })

  it("splits a query-string URL followed by a protocol-relative second source", () => {
    const text =
      '#EXTM3U url-tvg="http://epg.example.com/guide.xml?ids=1,2,//b.example/2.xml"\n' +
      '#EXTINF:-1 tvg-id="x",Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.epgUrls).toEqual([
      "http://epg.example.com/guide.xml?ids=1,2",
      "//b.example/2.xml",
    ])
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
    expect(result.entries[0].categories).toEqual(["Sports"])
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

describe("parseM3U: multi-group group-title", () => {
  it("splits a semicolon-separated group-title into categories, keeping category as the raw string", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" group-title="News;Sports",Multi Group\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].categories).toEqual(["News", "Sports"])
    expect(result.entries[0].category).toBe("News;Sports")
  })

  it("keeps a group-title with a semicolon meant as one category name intact", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" group-title="Kids; Cartoons",One Category\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].category).toBe("Kids; Cartoons")
    expect(result.entries[0].categories).toEqual(["Kids", "Cartoons"])
  })

  it("trims whitespace around each group and drops empty segments", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" group-title=" News ; ;Sports ",Spaced\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].categories).toEqual(["News", "Sports"])
  })

  it("dedupes repeated groups", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" group-title="News;Sports;News",Dupe\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].categories).toEqual(["News", "Sports"])
  })

  it("keeps a single group as a one-element categories array", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" group-title="News",Single\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].categories).toEqual(["News"])
    expect(result.entries[0].category).toBe("News")
  })

  it("returns an empty categories array and null category when no group is set", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x",No Group\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].categories).toEqual([])
    expect(result.entries[0].category).toBeNull()
  })

  it("splits the #EXTGRP fallback into multiple groups too", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x",Fallback Groups\n' +
      "#EXTGRP:News;Sports\n" +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].categories).toEqual(["News", "Sports"])
    expect(result.entries[0].category).toBe("News;Sports")
  })
})

describe("parseM3U: tvg-shift", () => {
  it("parses a positive integer tvg-shift", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" tvg-shift="1",Shifted\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgShift).toBe(1)
  })

  it("parses a negative tvg-shift", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" tvg-shift="-2",Shifted Back\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgShift).toBe(-2)
  })

  it("parses a fractional tvg-shift", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" tvg-shift="-2.5",Fractional\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgShift).toBe(-2.5)
  })

  it("leaves tvgShift null when neither entry nor header sets it", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x",No Shift\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgShift).toBeNull()
  })

  it("falls back to a header-level tvg-shift default", () => {
    const text =
      '#EXTM3U tvg-shift="+1"\n' +
      '#EXTINF:-1 tvg-id="x",Header Default\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgShift).toBe(1)
  })

  it("lets an entry's own tvg-shift override the header default", () => {
    const text =
      '#EXTM3U tvg-shift="1"\n' +
      '#EXTINF:-1 tvg-id="x" tvg-shift="-3",Overrides Header\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].tvgShift).toBe(-3)
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

  it("captures catchup-source at the entry level", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" catchup="append" catchup-source="?utc={utc}&lutc={lutc}",Source Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchupSource).toBe("?utc={utc}&lutc={lutc}")
  })

  it("falls back to header-level catchup defaults when an entry sets none", () => {
    const text =
      '#EXTM3U catchup="xc" catchup-days="3" catchup-source="/timeshift"\n' +
      '#EXTINF:-1 tvg-id="x",No Own Catchup\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("xc")
    expect(result.entries[0].catchupDays).toBe(3)
    expect(result.entries[0].catchupSource).toBe("/timeshift")
  })

  it("lets an entry's own catchup attributes override the header defaults", () => {
    const text =
      '#EXTM3U catchup="xc" catchup-days="3" catchup-source="/timeshift"\n' +
      '#EXTINF:-1 tvg-id="x" catchup="append" catchup-days="14" catchup-source="/own",Overrides Header\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("append")
    expect(result.entries[0].catchupDays).toBe(14)
    expect(result.entries[0].catchupSource).toBe("/own")
  })

  it("captures catchup-correction at the entry level", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" catchup="append" catchup-correction="-2.5",Correction Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchupCorrection).toBe(-2.5)
  })

  it("falls back to the header catchup-correction when the entry sets none", () => {
    const text =
      '#EXTM3U catchup-correction="1.5"\n' +
      '#EXTINF:-1 tvg-id="x" catchup="append",No Own Correction\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchupCorrection).toBe(1.5)
  })

  it("leaves catchupCorrection null when neither entry nor header sets it", () => {
    const result = parseM3U(fixture("catchup.m3u"))
    expect(result.entries[0].catchupCorrection).toBeNull()
  })

  it("accepts catchup-type as an alias for catchup", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" catchup-type="shift",Type Alias\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("shift")
  })

  it("ignores catchup-type when catchup is already set", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" catchup="vod" catchup-type="shift",Explicit Wins\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("vod")
  })

  it("supports the header-level catchup-type alias too", () => {
    const text =
      '#EXTM3U catchup-type="append"\n' +
      '#EXTINF:-1 tvg-id="x",Header Alias\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("append")
  })

  it("derives catchup=shift + catchupDays from a SIPTV timeshift= attribute", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" timeshift="3",Timeshift Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("shift")
    expect(result.entries[0].catchupDays).toBe(3)
  })

  it("falls back to tvg-rec when timeshift is absent", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" tvg-rec="5",Rec Channel\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("shift")
    expect(result.entries[0].catchupDays).toBe(5)
  })

  it("ignores tvg-rec when timeshift is already positive", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" timeshift="2" tvg-rec="9",Both Set\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchupDays).toBe(2)
  })

  it("does not override an explicit catchup mode with the SIPTV timeshift hint", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" catchup="vod" timeshift="3",Explicit Catchup Wins\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("vod")
  })

  it("supports a header-level timeshift as the default SIPTV hint", () => {
    const text =
      '#EXTM3U timeshift="4"\n' +
      '#EXTINF:-1 tvg-id="x",Header Timeshift Default\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("shift")
    expect(result.entries[0].catchupDays).toBe(4)
  })

  it("keeps an explicit catchup-days over the SIPTV timeshift hint's day count", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" catchup-days="14" timeshift="2",Explicit Days Wins\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].catchup).toBe("shift")
    expect(result.entries[0].catchupDays).toBe(14)
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

describe("parseM3U: KODIPROP manifest / ClearKey DRM", () => {
  const dash =
    "#EXTM3U\n" +
    '#EXTINF:-1 tvg-id="jade",翡翠台\n' +
    "#KODIPROP:inputstream.adaptive.manifest_type=mpd\n" +
    "#KODIPROP:inputstream.adaptive.license_type=clearkey\n" +
    "#KODIPROP:inputstream.adaptive.license_key=0958b9c657622c465a6205eb2252b8ed:2d2fd7b1661b1e28de38268872b48480\n" +
    "https://example.com/myTV/genyg5?token=abc\n" +
    '#EXTINF:-1 tvg-id="plain",Plain Channel\n' +
    "https://example.com/plain.m3u8\n"
  const result = parseM3U(dash)

  it("captures manifest_type, license_type and the raw KID:KEY", () => {
    const [jade] = result.entries
    expect(jade.manifestType).toBe("mpd")
    expect(jade.drmScheme).toBe("clearkey")
    expect(jade.licenseKey).toBe(
      "0958b9c657622c465a6205eb2252b8ed:2d2fd7b1661b1e28de38268872b48480",
    )
  })

  it("does not leak DRM onto the next entry", () => {
    const plain = result.entries[1]
    expect(plain.manifestType).toBeNull()
    expect(plain.drmScheme).toBeNull()
    expect(plain.licenseKey).toBeNull()
  })

  it("ignores KODIPROP appearing before its EXTINF", () => {
    const text =
      "#EXTM3U\n" +
      "#KODIPROP:inputstream.adaptive.manifest_type=mpd\n" +
      '#EXTINF:-1 tvg-id="x",Orphan Prop\n' +
      "http://example.com/x.m3u8\n"
    const orphan = parseM3U(text).entries[0]
    expect(orphan.manifestType).toBeNull()
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

describe("parseM3U: radio detection", () => {
  it("marks tvg-type=\"radio\" entries as radio", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="rb" tvg-type="radio" tvg-logo="https://example.com/rb.png",Radio Bremen\n' +
      "http://example.com/rb.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].isRadio).toBe(true)
    expect(result.entries[0].tvgType).toBe("radio")
  })

  it("marks radio=\"true\" entries as radio", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" radio="true",FM Station\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].isRadio).toBe(true)
  })

  it("is case-insensitive on both flags", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-type="Radio",Mixed Case\n' +
      "http://example.com/a.m3u8\n" +
      '#EXTINF:-1 radio="TRUE",Caps True\n' +
      "http://example.com/b.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].isRadio).toBe(true)
    expect(result.entries[1].isRadio).toBe(true)
  })

  it("leaves regular tv entries as non-radio", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x" tvg-type="tv",Regular TV\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].isRadio).toBe(false)
    expect(result.entries[0].tvgType).toBe("tv")
  })

  it("defaults isRadio=false and tvgType=null when neither attr is set", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="x",No Hint\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries[0].isRadio).toBe(false)
    expect(result.entries[0].tvgType).toBeNull()
  })
})

describe("parseM3U: malformed input resilience", () => {
  it("keeps a bare URL with no preceding #EXTINF as its own channel", () => {
    const text =
      "#EXTM3U\n" +
      "http://orphan.example.com/stream.m3u8\n" +
      '#EXTINF:-1 tvg-id="x" group-title="G",Real\n' +
      "http://example.com/x.m3u8\n"
    const result = parseM3U(text)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].name).toBe("orphan.example.com")
    expect(result.entries[0].url).toBe("http://orphan.example.com/stream.m3u8")
    expect(result.entries[1].name).toBe("Real")
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
    expect(parseM3U("")).toEqual({ entries: [], epgUrl: "", epgUrls: [] })
  })

  it("returns an empty result for whitespace-only input", () => {
    expect(parseM3U("\n\n  \n\r\n")).toEqual({ entries: [], epgUrl: "", epgUrls: [] })
  })
})

describe("isHlsStreamManifest", () => {
  it("returns true for a media playlist", () => {
    const text =
      "#EXTM3U\n" +
      "#EXT-X-TARGETDURATION:10\n" +
      "#EXT-X-MEDIA-SEQUENCE:0\n" +
      "#EXTINF:10.0,\n" +
      "chunklist_b3192000_00001.ts\n"
    expect(isHlsStreamManifest(text)).toBe(true)
  })

  it("returns true for a master playlist", () => {
    const text =
      "#EXTM3U\n" +
      '#EXT-X-STREAM-INF:BANDWIDTH=3192000,RESOLUTION=1920x1080\n' +
      "chunklist_b3192000.m3u8\n"
    expect(isHlsStreamManifest(text)).toBe(true)
  })

  it("returns false for a normal channel-list M3U", () => {
    const text =
      "#EXTM3U\n" +
      '#EXTINF:-1 tvg-id="bbcone.uk" group-title="News",BBC One HD\n' +
      "http://example.com/live/u/p/1.m3u8\n" +
      '#EXTINF:-1 tvg-id="cnn.us" group-title="News",CNN\n' +
      "http://example.com/live/u/p/2.m3u8\n"
    expect(isHlsStreamManifest(text)).toBe(false)
  })
})
