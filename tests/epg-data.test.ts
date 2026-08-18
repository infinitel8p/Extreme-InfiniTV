/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest"
import {
  buildEpgUrlsFromEntry,
  mergeProgrammeMaps,
  mergeChannelNameMaps,
  detectGzip,
  resolveTvgId,
  findBestEpgChannelByName,
  buildChannelNameIndex,
  findInChannelNameIndex,
  normaliseChannelName,
  parseXmlTv,
  inferTimezoneOffsetMin,
  resolveAutoOffsetMin,
  shiftChannelProgrammes,
  getNowNextForChannel,
} from "../src/scripts/lib/epg-data.js"
import { parseXmlTv as parseXmlTvWorker } from "../src/scripts/lib/epg-worker.ts"

const xtreamCreds = {
  host: "iptv.example.com",
  port: "8080",
  user: "alice",
  pass: "secret",
}

const m3uCreds = {
  host: "https://m3u.example.com/list.m3u8",
  port: "",
  user: "",
  pass: "",
}

describe("buildEpgUrlsFromEntry: Xtream playlist", () => {
  it("returns the provider xmltv.php URL when no override is set", () => {
    const sources = buildEpgUrlsFromEntry({}, xtreamCreds, "")
    expect(sources).toHaveLength(1)
    expect(sources[0]).toEqual({
      url: "http://iptv.example.com:8080/xmltv.php?username=alice&password=secret",
      source: "xtream-default",
      kind: "primary",
    })
  })

  it("uses the user-supplied epgUrl as the primary when set", () => {
    const sources = buildEpgUrlsFromEntry(
      { epgUrl: "https://custom.example/guide.xml.gz" },
      xtreamCreds,
      ""
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].url).toBe("https://custom.example/guide.xml.gz")
    expect(sources[0].source).toBe("override")
    expect(sources[0].kind).toBe("primary")
  })

  it("appends additionalEpgUrls in order after the primary", () => {
    const sources = buildEpgUrlsFromEntry(
      {
        epgUrl: "https://primary.example/p.xml",
        additionalEpgUrls: [
          "https://extra1.example/a.xml",
          "https://extra2.example/b.xml",
        ],
      },
      xtreamCreds,
      ""
    )
    expect(sources.map((source) => source.url)).toEqual([
      "https://primary.example/p.xml",
      "https://extra1.example/a.xml",
      "https://extra2.example/b.xml",
    ])
    expect(sources[0].kind).toBe("primary")
    expect(sources[1].kind).toBe("additional")
    expect(sources[2].kind).toBe("additional")
  })

  it("dedupes URLs that appear in both primary and additional positions", () => {
    const sources = buildEpgUrlsFromEntry(
      {
        epgUrl: "https://same.example/guide.xml",
        additionalEpgUrls: [
          "https://same.example/guide.xml",
          "https://other.example/guide.xml",
        ],
      },
      xtreamCreds,
      ""
    )
    expect(sources).toHaveLength(2)
    expect(sources[0].url).toBe("https://same.example/guide.xml")
    expect(sources[1].url).toBe("https://other.example/guide.xml")
  })

  it("trims whitespace and skips blank additional URLs", () => {
    const sources = buildEpgUrlsFromEntry(
      {
        epgUrl: "",
        additionalEpgUrls: [
          "  https://valid.example/a.xml  ",
          "",
          "   ",
          "https://valid.example/b.xml",
        ],
      },
      xtreamCreds,
      ""
    )
    expect(sources.map((source) => source.url)).toEqual([
      "http://iptv.example.com:8080/xmltv.php?username=alice&password=secret",
      "https://valid.example/a.xml",
      "https://valid.example/b.xml",
    ])
  })
})

describe("buildEpgUrlsFromEntry: M3U playlist", () => {
  it("uses the x-tvg-url header when no override is set", () => {
    const sources = buildEpgUrlsFromEntry(
      {},
      m3uCreds,
      "https://example.com/auto.xml.gz"
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]).toEqual({
      url: "https://example.com/auto.xml.gz",
      source: "m3u-header",
      kind: "primary",
    })
  })

  it("returns an empty list when neither override nor header is set", () => {
    const sources = buildEpgUrlsFromEntry({}, m3uCreds, "")
    expect(sources).toEqual([])
  })

  it("user override wins over the M3U header", () => {
    const sources = buildEpgUrlsFromEntry(
      { epgUrl: "https://manual.example/g.xml" },
      m3uCreds,
      "https://header.example/g.xml"
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].source).toBe("override")
    expect(sources[0].url).toBe("https://manual.example/g.xml")
  })

  it("additional URLs still appear when there is no primary", () => {
    const sources = buildEpgUrlsFromEntry(
      { additionalEpgUrls: ["https://fallback.example/g.xml"] },
      m3uCreds,
      ""
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].source).toBe("additional")
  })

  it("splits a comma-joined header value: first is primary, the rest are additional m3u-header sources", () => {
    const sources = buildEpgUrlsFromEntry(
      {},
      m3uCreds,
      "https://a.example/1.xml,https://b.example/2.xml,https://c.example/3.xml"
    )
    expect(sources).toEqual([
      { url: "https://a.example/1.xml", source: "m3u-header", kind: "primary" },
      { url: "https://b.example/2.xml", source: "m3u-header", kind: "additional" },
      { url: "https://c.example/3.xml", source: "m3u-header", kind: "additional" },
    ])
  })

  it("trims whitespace and dedupes a comma-joined header value", () => {
    const sources = buildEpgUrlsFromEntry(
      {},
      m3uCreds,
      " https://a.example/1.xml , https://a.example/1.xml,https://b.example/2.xml "
    )
    expect(sources.map((source) => source.url)).toEqual([
      "https://a.example/1.xml",
      "https://b.example/2.xml",
    ])
  })

  it("dedupes a header URL that also appears in additionalEpgUrls", () => {
    const sources = buildEpgUrlsFromEntry(
      { additionalEpgUrls: ["https://a.example/1.xml", "https://c.example/3.xml"] },
      m3uCreds,
      "https://a.example/1.xml,https://b.example/2.xml"
    )
    expect(sources.map((source) => source.url)).toEqual([
      "https://a.example/1.xml",
      "https://b.example/2.xml",
      "https://c.example/3.xml",
    ])
    expect(sources.map((source) => source.kind)).toEqual([
      "primary",
      "additional",
      "additional",
    ])
  })

  it("keeps a comma inside a single URL's query string intact instead of splitting on it", () => {
    const sources = buildEpgUrlsFromEntry(
      {},
      m3uCreds,
      "http://epg.example.com/guide.xml?ids=1,2"
    )
    expect(sources).toEqual([
      {
        url: "http://epg.example.com/guide.xml?ids=1,2",
        source: "m3u-header",
        kind: "primary",
      },
    ])
  })

  it("keeps a protocol-relative header value as a single URL", () => {
    const sources = buildEpgUrlsFromEntry({}, m3uCreds, "//epg.example.com/epg.xml")
    expect(sources).toEqual([
      { url: "//epg.example.com/epg.xml", source: "m3u-header", kind: "primary" },
    ])
  })

  it("splits a query-string URL followed by a protocol-relative second source", () => {
    const sources = buildEpgUrlsFromEntry(
      {},
      m3uCreds,
      "http://epg.example.com/guide.xml?ids=1,2,//b.example/2.xml"
    )
    expect(sources.map((source) => source.url)).toEqual([
      "http://epg.example.com/guide.xml?ids=1,2",
      "//b.example/2.xml",
    ])
  })

  it("splits a query-string URL followed by a second real header source", () => {
    const sources = buildEpgUrlsFromEntry(
      {},
      m3uCreds,
      "http://epg.example.com/guide.xml?ids=1,2,https://b.example/2.xml"
    )
    expect(sources.map((source) => source.url)).toEqual([
      "http://epg.example.com/guide.xml?ids=1,2",
      "https://b.example/2.xml",
    ])
  })

  it("user override still beats a multi-url header entirely", () => {
    const sources = buildEpgUrlsFromEntry(
      { epgUrl: "https://manual.example/g.xml" },
      m3uCreds,
      "https://a.example/1.xml,https://b.example/2.xml"
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].source).toBe("override")
  })
})

describe("buildEpgUrlsFromEntry: custom playlist", () => {
  it("unions the resolved source EPG URLs as the primary source", () => {
    const sources = buildEpgUrlsFromEntry(
      { type: "custom" },
      xtreamCreds,
      "",
      ["https://source-a.example/xmltv.php", "https://source-b.example/xmltv.php"]
    )
    expect(sources).toHaveLength(2)
    expect(sources.map((source) => source.url)).toEqual([
      "https://source-a.example/xmltv.php",
      "https://source-b.example/xmltv.php",
    ])
    expect(sources.every((source) => source.source === "custom-sources" && source.kind === "primary")).toBe(true)
  })

  it("dedupes duplicate source EPG URLs", () => {
    const sources = buildEpgUrlsFromEntry(
      { type: "custom" },
      xtreamCreds,
      "",
      ["https://same.example/xmltv.php", "https://same.example/xmltv.php"]
    )
    expect(sources).toHaveLength(1)
  })

  it("user-supplied epgUrl overrides the union of source EPG URLs", () => {
    const sources = buildEpgUrlsFromEntry(
      { type: "custom", epgUrl: "https://manual.example/g.xml" },
      xtreamCreds,
      "",
      ["https://source-a.example/xmltv.php"]
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]).toEqual({
      url: "https://manual.example/g.xml",
      source: "override",
      kind: "primary",
    })
  })

  it("disableProviderEpg suppresses the source-union but keeps additional URLs", () => {
    const sources = buildEpgUrlsFromEntry(
      {
        type: "custom",
        disableProviderEpg: true,
        additionalEpgUrls: ["https://extra.example/a.xml"],
      },
      xtreamCreds,
      "",
      ["https://source-a.example/xmltv.php"]
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].source).toBe("additional")
  })

  it("appends additionalEpgUrls after the source union, deduping overlaps", () => {
    const sources = buildEpgUrlsFromEntry(
      {
        type: "custom",
        additionalEpgUrls: ["https://source-a.example/xmltv.php", "https://extra.example/a.xml"],
      },
      xtreamCreds,
      "",
      ["https://source-a.example/xmltv.php"]
    )
    expect(sources.map((source) => source.url)).toEqual([
      "https://source-a.example/xmltv.php",
      "https://extra.example/a.xml",
    ])
    expect(sources[0].source).toBe("custom-sources")
    expect(sources[1].source).toBe("additional")
  })

  it("returns an empty list when there are no source URLs and no overrides", () => {
    const sources = buildEpgUrlsFromEntry({ type: "custom" }, xtreamCreds, "", [])
    expect(sources).toEqual([])
  })
})

describe("buildEpgUrlsFromEntry: edge cases", () => {
  it("returns an empty list when creds and entry are both empty", () => {
    const sources = buildEpgUrlsFromEntry(
      {},
      { host: "", port: "", user: "", pass: "" },
      ""
    )
    expect(sources).toEqual([])
  })

  it("tolerates a null entry", () => {
    const sources = buildEpgUrlsFromEntry(null, xtreamCreds, "")
    expect(sources).toHaveLength(1)
    expect(sources[0].source).toBe("xtream-default")
  })
})

describe("mergeProgrammeMaps: waterfall semantics", () => {
  const mk = (...pairs: Array<[string, string]>) => {
    const map = new Map<string, Array<{ start: number; stop: number; title: string; desc: string }>>()
    for (const [tvgId, title] of pairs) {
      map.set(tvgId, [{ start: 0, stop: 1, title, desc: "" }])
    }
    return map
  }

  it("returns an empty map when there are no inputs", () => {
    expect(mergeProgrammeMaps([])).toEqual(new Map())
  })

  it("includes every key from a single source", () => {
    const merged = mergeProgrammeMaps([mk(["a", "alpha"], ["b", "beta"])])
    expect(merged.size).toBe(2)
    expect(merged.get("a")?.[0].title).toBe("alpha")
  })

  it("primary wins on conflict; additional never overwrites", () => {
    const primary = mk(["a", "primary-a"], ["b", "primary-b"])
    const additional = mk(["a", "additional-a"], ["c", "additional-c"])
    const merged = mergeProgrammeMaps([primary, additional])
    expect(merged.get("a")?.[0].title).toBe("primary-a")
    expect(merged.get("b")?.[0].title).toBe("primary-b")
    expect(merged.get("c")?.[0].title).toBe("additional-c")
  })

  it("waterfall: each subsequent source only fills keys missing from earlier ones", () => {
    const primary = mk(["a", "P"])
    const second = mk(["a", "S-a"], ["b", "S-b"])
    const third = mk(["a", "T-a"], ["b", "T-b"], ["c", "T-c"])
    const merged = mergeProgrammeMaps([primary, second, third])
    expect(merged.get("a")?.[0].title).toBe("P")
    expect(merged.get("b")?.[0].title).toBe("S-b")
    expect(merged.get("c")?.[0].title).toBe("T-c")
  })

  it("ignores null entries in the list", () => {
    const merged = mergeProgrammeMaps([
      null as never,
      mk(["a", "alpha"]),
      undefined as never,
    ])
    expect(merged.size).toBe(1)
  })
})

describe("detectGzip: magic-byte + header sniffing", () => {
  it("detects via magic bytes regardless of headers", () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00])
    expect(detectGzip("https://example.com/plain.xml", bytes, {})).toBe(true)
  })

  it("detects via .gz URL suffix", () => {
    const bytes = new Uint8Array([0x3c, 0x3f]) // "<?" (XML start)
    expect(
      detectGzip("https://example.com/guide.xml.gz", bytes, {})
    ).toBe(true)
  })

  it("detects via Content-Type", () => {
    const bytes = new Uint8Array([0x3c, 0x3f])
    expect(
      detectGzip("https://example.com/x", bytes, {
        contentType: "application/x-gzip",
      })
    ).toBe(true)
  })

  it("detects via Content-Disposition filename", () => {
    const bytes = new Uint8Array([0x3c, 0x3f])
    expect(
      detectGzip("https://example.com/x", bytes, {
        contentDisposition: 'attachment; filename="guide.xml.gz"',
      })
    ).toBe(true)
  })

  it("returns false when nothing matches", () => {
    const bytes = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c])
    expect(
      detectGzip("https://example.com/guide.xml", bytes, {
        contentType: "text/xml",
      })
    ).toBe(false)
  })

  it("tolerates short / empty byte arrays", () => {
    expect(detectGzip("https://example.com/x.xml", new Uint8Array(), {})).toBe(false)
    expect(detectGzip("https://example.com/x.xml", new Uint8Array([0x1f]), {})).toBe(false)
  })

  it("ignores URL query strings when checking extension", () => {
    const bytes = new Uint8Array([0x3c, 0x3f])
    expect(
      detectGzip("https://example.com/guide.xml.gz?token=abc", bytes, {})
    ).toBe(true)
    expect(
      detectGzip("https://example.com/guide.xml?token=abc.gz", bytes, {})
    ).toBe(false)
  })
})

describe("buildEpgUrlsFromEntry: disableProviderEpg", () => {
  it("suppresses the xtream-default source when set", () => {
    const sources = buildEpgUrlsFromEntry(
      { disableProviderEpg: true },
      xtreamCreds,
      ""
    )
    expect(sources).toEqual([])
  })

  it("suppresses the m3u-header source when set", () => {
    const sources = buildEpgUrlsFromEntry(
      { disableProviderEpg: true },
      m3uCreds,
      "https://example.com/auto.xml.gz"
    )
    expect(sources).toEqual([])
  })

  it("keeps the user-supplied primary regardless of the flag", () => {
    const sources = buildEpgUrlsFromEntry(
      {
        epgUrl: "https://manual.example/g.xml",
        disableProviderEpg: true,
      },
      xtreamCreds,
      ""
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].source).toBe("override")
  })

  it("keeps additional sources but drops the provider default", () => {
    const sources = buildEpgUrlsFromEntry(
      {
        additionalEpgUrls: ["https://extra.example/a.xml"],
        disableProviderEpg: true,
      },
      xtreamCreds,
      ""
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].source).toBe("additional")
    expect(sources[0].url).toBe("https://extra.example/a.xml")
  })
})

describe("mergeChannelNameMaps: waterfall semantics", () => {
  it("first source's name wins on conflict", () => {
    const primary = new Map([
      ["bbc1.uk", "BBC One"],
      ["bbc2.uk", "BBC Two"],
    ])
    const additional = new Map([
      ["bbc1.uk", "Beeb 1"],
      ["itv.uk", "ITV"],
    ])
    const merged = mergeChannelNameMaps([primary, additional])
    expect(merged.get("bbc1.uk")).toBe("BBC One")
    expect(merged.get("bbc2.uk")).toBe("BBC Two")
    expect(merged.get("itv.uk")).toBe("ITV")
  })

  it("ignores null entries and empty names", () => {
    const merged = mergeChannelNameMaps([
      null as never,
      new Map([["a", ""], ["b", "Beta"]]),
    ])
    expect(merged.size).toBe(1)
    expect(merged.get("b")).toBe("Beta")
  })
})

describe("resolveTvgId: per-channel override resolution", () => {
  it("returns the channel's tvgId when no override exists", () => {
    const channel = { id: 42, tvgId: "BBC1.uk" }
    expect(resolveTvgId(channel, {})).toBe("bbc1.uk")
  })

  it("returns the override when present", () => {
    const channel = { id: 42, tvgId: "wrong.id" }
    const overrides = { "42": "Correct.ID" }
    expect(resolveTvgId(channel, overrides)).toBe("correct.id")
  })

  it("override wins even when channel has no tvgId", () => {
    const channel = { id: 7, tvgId: "" }
    expect(resolveTvgId(channel, { "7": "mapped.tv" })).toBe("mapped.tv")
  })

  it("returns empty string when neither override nor tvgId", () => {
    expect(resolveTvgId({ id: 1, tvgId: "" }, {})).toBe("")
    expect(resolveTvgId({ id: 1 }, {})).toBe("")
  })

  it("tolerates null channel", () => {
    expect(resolveTvgId(null as never, {})).toBe("")
  })

  it("tolerates missing/null override map", () => {
    const channel = { id: 1, tvgId: "abc" }
    expect(resolveTvgId(channel, null as never)).toBe("abc")
    expect(resolveTvgId(channel, undefined as never)).toBe("abc")
  })

  it("prefers raw tvgId when it exists in the programmes map", () => {
    const channel = { id: 1, name: "BBC One", tvgId: "bbc1.uk" }
    const programmes = new Map([["bbc1.uk", [{ start: 0, stop: 1, title: "X", desc: "" }]]])
    const channelNames = new Map([["bbc1.uk", "BBC One"]])
    expect(resolveTvgId(channel, {}, programmes, channelNames)).toBe("bbc1.uk")
  })

  it("falls through to name match when tvgId isn't in programmes", () => {
    const channel = { id: 1, name: "MDR Sachsen HD", tvgId: "mdr.sx.hd.de" }
    const programmes = new Map([["mdr.sachsen.de", []]])
    const channelNames = new Map([["mdr.sachsen.de", "MDR Sachsen"]])
    expect(resolveTvgId(channel, {}, programmes, channelNames)).toBe("mdr.sachsen.de")
  })

  it("falls through to name match when channel has no tvgId at all", () => {
    const channel = { id: 1, name: "BBC One HD" }
    const programmes = new Map([["bbc1.uk", []]])
    const channelNames = new Map([["bbc1.uk", "BBC One"]])
    expect(resolveTvgId(channel, {}, programmes, channelNames)).toBe("bbc1.uk")
  })
})

describe("normaliseChannelName: quality-suffix stripping + separator-insensitive", () => {
  it("strips trailing HD and drops separators", () => {
    expect(normaliseChannelName("MDR Sachsen HD")).toBe("mdrsachsen")
  })

  it("strips quality suffixes in any position", () => {
    expect(normaliseChannelName("BBC One FHD")).toBe("bbcone")
    expect(normaliseChannelName("ESPN-UHD")).toBe("espn")
    expect(normaliseChannelName("Sky_Sports_4K")).toBe("skysports")
    expect(normaliseChannelName("RAI 1 SD")).toBe("rai1")
  })

  it("matches across spacing differences (the user's reported case)", () => {
    expect(normaliseChannelName("Channel 21 HD")).toBe(
      normaliseChannelName("Channel21")
    )
    expect(normaliseChannelName("zdf_neo HD")).toBe(
      normaliseChannelName("ZDFneo")
    )
  })

  it("lowercases and removes diacritics", () => {
    expect(normaliseChannelName("Télé Québec")).toBe("telequebec")
  })

  it("drops all whitespace and punctuation", () => {
    expect(normaliseChannelName("  Channel   4   ")).toBe("channel4")
    expect(normaliseChannelName("M6 - HD")).toBe("m6")
    expect(normaliseChannelName("Sat.1 GOLD")).toBe("sat1gold")
  })

  it("keeps + (timeshift / plus channels)", () => {
    expect(normaliseChannelName("Sky+1 HD")).toBe("sky+1")
    expect(normaliseChannelName("Sky+ HD")).toBe("sky+")
  })

  it("doesn't strip non-quality tokens that happen to be 2-3 chars", () => {
    expect(normaliseChannelName("Eurosport DE")).toBe("eurosportde")
    expect(normaliseChannelName("ZDF info")).toBe("zdfinfo")
  })

  it("returns empty string for falsy / empty input", () => {
    expect(normaliseChannelName("")).toBe("")
    expect(normaliseChannelName(null as never)).toBe("")
    expect(normaliseChannelName(undefined as never)).toBe("")
  })
})

describe("findBestEpgChannelByName: fuzzy display-name match", () => {
  const channelNames = new Map([
    ["mdr.sachsen.de", "MDR Sachsen"],
    ["mdr.thueringen.de", "MDR Thüringen"],
    ["bbc1.uk", "BBC One"],
    ["bbc2.uk", "BBC Two"],
    ["rai1.it", "Rai 1"],
  ])

  it("matches the canonical user case: HD suffix on M3U side, clean name on EPG side", () => {
    expect(findBestEpgChannelByName("MDR Sachsen HD", channelNames)).toBe(
      "mdr.sachsen.de"
    )
  })

  it("matches via diacritic normalisation when both sides use the umlaut", () => {
    expect(findBestEpgChannelByName("MDR Thüringen HD", channelNames)).toBe(
      "mdr.thueringen.de"
    )
  })

  it("matches across spacing differences: M3U \"Channel 21 HD\" -> EPG \"Channel21\"", () => {
    const names = new Map([["channel21.de", "Channel21"]])
    expect(findBestEpgChannelByName("Channel 21 HD", names)).toBe("channel21.de")
  })

  it("matches across separator differences: M3U \"zdf_neo HD\" -> EPG \"ZDFneo\"", () => {
    const names = new Map([["zdfneo.de", "ZDFneo"]])
    expect(findBestEpgChannelByName("zdf_neo HD", names)).toBe("zdfneo.de")
  })

  it("returns empty when no candidate matches", () => {
    expect(findBestEpgChannelByName("Nonexistent Channel", channelNames)).toBe("")
  })

  it("returns empty on ambiguous match (refuses to silently pick)", () => {
    const ambiguous = new Map([
      ["a.tv", "Sky"],
      ["b.tv", "Sky HD"],
    ])
    expect(findBestEpgChannelByName("Sky", ambiguous)).toBe("")
  })

  it("matches when both sides have the same suffix", () => {
    const names = new Map([["a.tv", "Channel HD"]])
    expect(findBestEpgChannelByName("Channel HD", names)).toBe("a.tv")
  })

  it("tolerates empty / falsy inputs", () => {
    expect(findBestEpgChannelByName("", channelNames)).toBe("")
    expect(findBestEpgChannelByName("BBC One", null as never)).toBe("")
    expect(findBestEpgChannelByName("BBC One", new Map())).toBe("")
  })
})

describe("parseXmlTv: non-standard catchup-id attribute", () => {
  function formatXmlTvDate(ms: number): string {
    const date = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, "0")
    return (
      `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
      `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    )
  }

  it("captures catchup-id onto the programme when present", () => {
    const start = Date.now() - 60 * 60 * 1000
    const stop = Date.now() + 60 * 60 * 1000
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="channel-x"><display-name>Channel X</display-name></channel>` +
      `<programme start="${formatXmlTvDate(start)}" stop="${formatXmlTvDate(stop)}" channel="channel-x" catchup-id="plugin://vod/episode1">` +
      `<title>My Show</title></programme>` +
      `</tv>`
    const { programmes } = parseXmlTv(xml)
    expect(programmes.get("channel-x")?.[0].catchupId).toBe("plugin://vod/episode1")
  })

  it("leaves catchupId undefined when the attribute is absent", () => {
    const start = Date.now() - 60 * 60 * 1000
    const stop = Date.now() + 60 * 60 * 1000
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="channel-x"><display-name>Channel X</display-name></channel>` +
      `<programme start="${formatXmlTvDate(start)}" stop="${formatXmlTvDate(stop)}" channel="channel-x">` +
      `<title>My Show</title></programme>` +
      `</tv>`
    const { programmes } = parseXmlTv(xml)
    expect(programmes.get("channel-x")?.[0].catchupId).toBeUndefined()
  })
})

describe("parseXmlTv: DOCTYPE handling", () => {
  const body =
    `<tv>` +
    `<channel id="channel-x"><display-name>Channel X</display-name></channel>` +
    `</tv>`

  it("parses XMLTV that opens with a plain DOCTYPE", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<!DOCTYPE tv SYSTEM "xmltv.dtd">` +
      body
    const { channelNames } = parseXmlTv(xml)
    expect(channelNames.get("channel-x")).toBe("Channel X")
  })

  it("worker parser parses XMLTV that opens with a plain DOCTYPE", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<!DOCTYPE tv SYSTEM "xmltv.dtd">` +
      body
    const { channelNames } = parseXmlTvWorker(xml)
    expect(channelNames.get("channel-x")).toBe("Channel X")
  })

  it("still rejects an ENTITY declaration (billion-laughs guard)", () => {
    const xml =
      `<?xml version="1.0"?>` +
      `<!DOCTYPE tv [<!ENTITY lol "lol">]>` +
      body
    expect(() => parseXmlTv(xml)).toThrow(/ENTITY/)
    expect(() => parseXmlTvWorker(xml)).toThrow(/ENTITY/)
  })
})

describe("buildChannelNameIndex + findInChannelNameIndex: O(1) lookup", () => {
  const channelNames = new Map([
    ["bbc1.uk", "BBC One"],
    ["bbc2.uk", "BBC Two"],
    ["channel21.de", "Channel21"],
  ])

  it("builds an index keyed by normalised name", () => {
    const index = buildChannelNameIndex(channelNames)
    expect(index.size).toBeGreaterThanOrEqual(3)
    expect(findInChannelNameIndex("BBC One", index)).toBe("bbc1.uk")
    expect(findInChannelNameIndex("Channel 21 HD", index)).toBe("channel21.de")
  })

  it("returns empty for collisions (matches the unique-only semantics)", () => {
    const ambiguous = new Map([
      ["a.tv", "Sky"],
      ["b.tv", "Sky HD"],
    ])
    const index = buildChannelNameIndex(ambiguous)
    expect(findInChannelNameIndex("Sky", index)).toBe("")
  })

  it("tolerates empty / null inputs", () => {
    expect(buildChannelNameIndex(null as never).size).toBe(0)
    expect(findInChannelNameIndex("x", null as never)).toBe("")
    expect(findInChannelNameIndex("x", new Map())).toBe("")
  })

  it("agrees with the pure findBestEpgChannelByName helper", () => {
    const index = buildChannelNameIndex(channelNames)
    for (const candidate of ["BBC One", "Channel 21 HD", "Nonexistent"]) {
      expect(findInChannelNameIndex(candidate, index)).toBe(
        findBestEpgChannelByName(candidate, channelNames)
      )
    }
  })
})

describe("parseXmlTv: hasExplicitTimezones detection", () => {
  function formatXmlTvDate(ms: number, withOffset: boolean): string {
    const date = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, "0")
    const base =
      `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
      `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    return withOffset ? `${base} +0000` : base
  }

  function buildXml(programmeCount: number, withOffsetCount: number): string {
    let body = `<?xml version="1.0"?><tv><channel id="ch"><display-name>Ch</display-name></channel>`
    for (let i = 0; i < programmeCount; i++) {
      const start = Date.now() - (i + 1) * 60 * 60 * 1000
      const stop = start + 30 * 60 * 1000
      const withOffset = i < withOffsetCount
      body +=
        `<programme start="${formatXmlTvDate(start, withOffset)}" stop="${formatXmlTvDate(stop, withOffset)}" channel="ch">` +
        `<title>Show ${i}</title></programme>`
    }
    return body + `</tv>`
  }

  it("reports true when every timestamp carries an explicit offset", () => {
    expect(parseXmlTv(buildXml(4, 4)).hasExplicitTimezones).toBe(true)
  })

  it("reports false when no timestamp carries an explicit offset (floating local time)", () => {
    expect(parseXmlTv(buildXml(4, 0)).hasExplicitTimezones).toBe(false)
  })

  it("reports true when a majority of timestamps carry an explicit offset", () => {
    expect(parseXmlTv(buildXml(4, 3)).hasExplicitTimezones).toBe(true)
  })

  it("reports false when only a minority of timestamps carry an explicit offset", () => {
    expect(parseXmlTv(buildXml(4, 1)).hasExplicitTimezones).toBe(false)
  })

  it("reports false for a feed with no programmes at all", () => {
    expect(parseXmlTv(`<?xml version="1.0"?><tv></tv>`).hasExplicitTimezones).toBe(false)
  })
})

describe("parseXmlTv vs epg-worker parseXmlTv: parser parity", () => {
  function formatXmlTvDate(ms: number): string {
    const date = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, "0")
    return (
      `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
      `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0200`
    )
  }

  it("agrees on programmes, channel names, and hasExplicitTimezones", () => {
    const start1 = Date.now() - 60 * 60 * 1000
    const stop1 = start1 + 30 * 60 * 1000
    const start2 = Date.now() - 30 * 60 * 1000
    const stop2 = start2 + 30 * 60 * 1000
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="ch1"><display-name>Channel One</display-name></channel>` +
      `<programme start="${formatXmlTvDate(start1)}" stop="${formatXmlTvDate(stop1)}" channel="ch1"><title>A</title></programme>` +
      `<programme start="${formatXmlTvDate(start2)}" stop="${formatXmlTvDate(stop2)}" channel="ch1"><title>B</title></programme>` +
      `</tv>`

    const main = parseXmlTv(xml)
    const worker = parseXmlTvWorker(xml)

    expect(worker.hasExplicitTimezones).toBe(main.hasExplicitTimezones)
    expect(Array.from(worker.programmes.entries())).toEqual(
      Array.from(main.programmes.entries())
    )
    expect(Array.from(worker.channelNames.entries())).toEqual(
      Array.from(main.channelNames.entries())
    )
  })
})

describe("inferTimezoneOffsetMin: sticky preferred offset (hysteresis)", () => {
  // Each channel airs live for exactly one second under exactly one candidate
  // offset, so the score for an offset equals the number of channels tuned to it.
  function programmeLiveAtOffset(offsetMin: number) {
    const shiftMs = offsetMin * 60 * 1000
    const start = Date.now() - shiftMs
    return { start, stop: start + 1000, title: "x", desc: "" }
  }

  function buildProgrammesForOffsetCounts(counts: Array<[number, number]>) {
    const programmes = new Map<string, Array<ReturnType<typeof programmeLiveAtOffset>>>()
    let index = 0
    for (const [offsetMin, count] of counts) {
      for (let i = 0; i < count; i++) {
        programmes.set(`ch${index++}`, [programmeLiveAtOffset(offsetMin)])
      }
    }
    return programmes
  }

  it("prefers the sticky offset on a score tie, even over a smaller-magnitude challenger", () => {
    const programmes = buildProgrammesForOffsetCounts([
      [60, 3],
      [90, 3],
    ])
    expect(inferTimezoneOffsetMin(programmes, 90)).toBe(90)
  })

  it("keeps the sticky offset when a challenger leads by less than the switch margin", () => {
    const programmes = buildProgrammesForOffsetCounts([
      [60, 4],
      [90, 3],
    ])
    expect(inferTimezoneOffsetMin(programmes, 90)).toBe(90)
  })

  it("switches away from the sticky offset when a challenger leads by the switch margin", () => {
    const programmes = buildProgrammesForOffsetCounts([
      [60, 5],
      [90, 3],
    ])
    expect(inferTimezoneOffsetMin(programmes, 90)).toBe(60)
  })

  it("falls back to the smallest-absolute-value tie-break with no preferred offset", () => {
    const programmes = buildProgrammesForOffsetCounts([
      [60, 3],
      [90, 3],
      [-30, 3],
    ])
    expect(inferTimezoneOffsetMin(programmes)).toBe(-30)
  })

  it("returns 0 for an empty programmes map", () => {
    expect(inferTimezoneOffsetMin(new Map())).toBe(0)
  })
})

describe("resolveAutoOffsetMin: mixed-source timezone gate", () => {
  function programmeLiveAtOffset(offsetMin: number) {
    const shiftMs = offsetMin * 60 * 1000
    const start = Date.now() - shiftMs
    return { start, stop: start + 1000, title: "x", desc: "" }
  }

  it("skips inference when any loaded source has explicit timezones, even if a floating-time source would otherwise infer a shift", () => {
    // A floating-time source whose programmes only line up as "live now" under a 90min shift.
    const programmes = new Map([["ch0", [programmeLiveAtOffset(90)]]])
    expect(resolveAutoOffsetMin(true, programmes)).toBe(0)
  })

  it("infers normally when no loaded source has explicit timezones", () => {
    const programmes = new Map([["ch0", [programmeLiveAtOffset(90)]]])
    expect(resolveAutoOffsetMin(false, programmes)).toBe(90)
  })
})

describe("shiftChannelProgrammes: tvg-shift guide-display offset", () => {
  const programmes = [
    { start: 1000, stop: 2000, title: "A", desc: "" },
    { start: 2000, stop: 3000, title: "B", desc: "" },
  ]

  it("returns the same reference when the shift is absent", () => {
    expect(shiftChannelProgrammes(programmes, null)).toBe(programmes)
    expect(shiftChannelProgrammes(programmes, undefined)).toBe(programmes)
  })

  it("returns the same reference when the shift is zero", () => {
    expect(shiftChannelProgrammes(programmes, 0)).toBe(programmes)
  })

  it("returns the same reference when the shift is non-finite", () => {
    expect(shiftChannelProgrammes(programmes, NaN)).toBe(programmes)
  })

  it("shifts start/stop by whole hours without mutating the input", () => {
    const shifted = shiftChannelProgrammes(programmes, 1)
    expect(shifted).not.toBe(programmes)
    expect(shifted[0].start).toBe(1000 + 3600_000)
    expect(shifted[0].stop).toBe(2000 + 3600_000)
    expect(programmes[0].start).toBe(1000)
    expect(programmes[0].stop).toBe(2000)
  })

  it("shifts by negative and fractional hours", () => {
    const shifted = shiftChannelProgrammes(programmes, -2.5)
    const shiftMs = -2.5 * 3600_000
    expect(shifted[0].start).toBe(1000 + shiftMs)
    expect(shifted[0].stop).toBe(2000 + shiftMs)
  })

  it("stashes rawStart/rawStop with the original unshifted times", () => {
    const shifted = shiftChannelProgrammes(programmes, 1)
    expect(shifted[0].rawStart).toBe(1000)
    expect(shifted[0].rawStop).toBe(2000)
    expect(shifted[1].rawStart).toBe(2000)
    expect(shifted[1].rawStop).toBe(3000)
  })

  it("preserves the other programme fields", () => {
    const shifted = shiftChannelProgrammes(programmes, 1)
    expect(shifted[0].title).toBe("A")
    expect(shifted[1].title).toBe("B")
  })

  it("tolerates an empty or missing programmes array", () => {
    expect(shiftChannelProgrammes([], 1)).toEqual([])
    expect(shiftChannelProgrammes(null as never, 1)).toEqual([])
    expect(shiftChannelProgrammes(undefined as never, 1)).toEqual([])
  })
})

describe("getNowNextForChannel: resolves tvg-id and applies tvg-shift", () => {
  it("returns null/null when the channel has no resolvable tvg-id", () => {
    const programmes = new Map([["bbc1.uk", [{ start: 0, stop: 10, title: "A", desc: "" }]]])
    const result = getNowNextForChannel(programmes, { id: 1 }, "playlist-1")
    expect(result).toEqual({ current: null, next: null })
  })

  it("finds current/next via the channel's raw tvg-id when no shift is set", () => {
    const now = Date.now()
    const programmes = new Map([
      [
        "bbc1.uk",
        [
          { start: now - 1000, stop: now + 1000, title: "Now", desc: "" },
          { start: now + 1000, stop: now + 2000, title: "Next", desc: "" },
        ],
      ],
    ])
    const channel = { id: 1, tvgId: "bbc1.uk", tvgShift: null }
    const result = getNowNextForChannel(programmes, channel, "playlist-1", now)
    expect(result.current?.title).toBe("Now")
    expect(result.next?.title).toBe("Next")
  })

  it("applies the channel's tvg-shift before computing current/next", () => {
    const now = Date.now()
    // Without the +1h shift this programme would be "in the future"; with it, it's live now.
    const programmes = new Map([
      ["bbc1.uk", [{ start: now + 3600_000 - 500, stop: now + 3600_000 + 500, title: "Shifted Live", desc: "" }]],
    ])
    const channel = { id: 1, tvgId: "bbc1.uk", tvgShift: -1 }
    const result = getNowNextForChannel(programmes, channel, "playlist-1", now)
    expect(result.current?.title).toBe("Shifted Live")
  })
})
