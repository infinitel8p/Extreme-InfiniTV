import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { serializeM3U } from "../src/scripts/lib/m3u-serializer"
import { parseM3U, type M3UEntry } from "../src/scripts/lib/m3u-parser"

const here = dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return readFileSync(resolve(here, "fixtures/m3u", name), "utf8")
}

const minimalEntry: M3UEntry = {
  name: "Minimal",
  url: "http://example.com/min.m3u8",
  logo: null,
  category: null,
  categories: [],
  tvgId: null,
  tvgName: null,
  chno: null,
  catchup: null,
  catchupDays: null,
  catchupSource: null,
  catchupCorrection: null,
  tvgShift: null,
  userAgent: null,
  referer: null,
  tvgType: null,
  isRadio: false,
  manifestType: null,
  drmScheme: null,
  licenseKey: null,
}

const fullEntry: M3UEntry = {
  name: "Full Entry",
  url: "http://example.com/full.m3u8",
  logo: "https://example.com/logo.png",
  category: "News",
  categories: ["News"],
  tvgId: "full.id",
  tvgName: "Full Name",
  chno: 7,
  catchup: "append",
  catchupDays: 5,
  catchupSource: "?utc={utc}&lutc={lutc}",
  catchupCorrection: -1.5,
  tvgShift: 1.5,
  userAgent: "VLC/3.0.18 LibVLC/3.0.18",
  referer: "https://ref.example.com/",
  tvgType: "tv",
  isRadio: false,
  manifestType: "mpd",
  drmScheme: "clearkey",
  licenseKey: "0958b9c657622c465a6205eb2252b8ed:2d2fd7b1661b1e28de38268872b48480",
}

describe("serializeM3U: field emission", () => {
  it("serializes every attribute in the documented order for a fully populated entry", () => {
    const result = serializeM3U([fullEntry])
    expect(result).toBe(
      "#EXTM3U\n" +
        '#EXTINF:-1 tvg-id="full.id" tvg-name="Full Name" tvg-logo="https://example.com/logo.png" tvg-chno="7" group-title="News" catchup="append" catchup-days="5" catchup-source="?utc={utc}&lutc={lutc}" catchup-correction="-1.5" tvg-shift="1.5" tvg-type="tv",Full Entry\n' +
        "#EXTVLCOPT:http-user-agent=VLC/3.0.18 LibVLC/3.0.18\n" +
        "#EXTVLCOPT:http-referrer=https://ref.example.com/\n" +
        "#KODIPROP:inputstream.adaptive.manifest_type=mpd\n" +
        "#KODIPROP:inputstream.adaptive.license_type=clearkey\n" +
        "#KODIPROP:inputstream.adaptive.license_key=0958b9c657622c465a6205eb2252b8ed:2d2fd7b1661b1e28de38268872b48480\n" +
        "http://example.com/full.m3u8\n",
    )
  })

  it("joins a multi-group categories array with semicolons instead of the single category", () => {
    const entry: M3UEntry = { ...minimalEntry, category: "News", categories: ["News", "Sports"] }
    const result = serializeM3U([entry])
    expect(result).toContain('group-title="News;Sports"')
  })
})

describe("serializeM3U: null omission", () => {
  it("emits just #EXTINF:-1,<name> and the url for a minimal entry", () => {
    const result = serializeM3U([minimalEntry])
    expect(result).toBe("#EXTM3U\n#EXTINF:-1,Minimal\nhttp://example.com/min.m3u8\n")
  })

  it("emits no #EXTVLCOPT or #KODIPROP lines when those fields are null", () => {
    const result = serializeM3U([minimalEntry])
    expect(result).not.toContain("#EXTVLCOPT")
    expect(result).not.toContain("#KODIPROP")
  })
})

describe("serializeM3U: quote escaping", () => {
  it("escapes embedded quotes in attribute values", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      tvgId: "x",
      tvgName: 'Inner "quote" here',
    }
    const result = serializeM3U([entry])
    expect(result).toBe(
      "#EXTM3U\n" +
        '#EXTINF:-1 tvg-id="x" tvg-name="Inner \\"quote\\" here",Minimal\n' +
        "http://example.com/min.m3u8\n",
    )
  })

  it("round-trips a quote-escaped value through parseM3U", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      tvgId: "x",
      tvgName: 'Inner "quote" here',
    }
    const serialized = serializeM3U([entry])
    const reparsed = parseM3U(serialized)
    expect(reparsed.entries[0].tvgName).toBe('Inner "quote" here')
  })

  it("round-trips backslashes without letting a trailing one escape the attribute", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      tvgId: "x",
      tvgName: 'ends with backslash\\',
      category: 'a\\b "c"',
    }
    const reparsed = parseM3U(serializeM3U([entry]))
    expect(reparsed.entries[0].tvgName).toBe('ends with backslash\\')
    expect(reparsed.entries[0].category).toBe('a\\b "c"')
    expect(reparsed.entries[0].name).toBe("Minimal")
  })
})

describe("serializeM3U: radio flag, chno, tvg-type", () => {
  it("emits tvg-chno, tvg-type and radio=\"true\" together", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      chno: 101,
      tvgType: "radio",
      isRadio: true,
    }
    const result = serializeM3U([entry])
    expect(result).toBe(
      "#EXTM3U\n" +
        '#EXTINF:-1 tvg-chno="101" tvg-type="radio" radio="true",Minimal\n' +
        "http://example.com/min.m3u8\n",
    )
  })

  it("omits radio=\"true\" when isRadio is false", () => {
    const result = serializeM3U([minimalEntry])
    expect(result).not.toContain("radio=")
  })
})

describe("serializeM3U: header options", () => {
  it("emits every header attribute when all options are set", () => {
    const result = serializeM3U([], {
      epgUrl: "https://example.com/epg.xml.gz",
      catchup: "append",
      catchupDays: 7,
      catchupSource: "/timeshift",
      catchupCorrection: 1.5,
      tvgShift: 2,
    })
    expect(result).toBe(
      '#EXTM3U x-tvg-url="https://example.com/epg.xml.gz" catchup="append" catchup-days="7" catchup-source="/timeshift" catchup-correction="1.5" tvg-shift="2"\n',
    )
  })

  it("omits header attributes that are absent", () => {
    expect(serializeM3U([])).toBe("#EXTM3U\n")
  })

  it("omits header attributes that are explicitly null", () => {
    const result = serializeM3U([], {
      epgUrl: null,
      catchup: null,
      catchupDays: null,
      catchupSource: null,
      catchupCorrection: null,
      tvgShift: null,
    })
    expect(result).toBe("#EXTM3U\n")
  })
})

describe("serializeM3U: round-trip through parseM3U", () => {
  const sourceEntries: M3UEntry[] = [
    {
      name: "BBC One HD",
      url: "http://example.com/live/u/p/1.m3u8",
      logo: "https://example.com/bbc1.png",
      category: "UK News",
      categories: ["UK News"],
      tvgId: "bbcone.uk",
      tvgName: "BBC One",
      chno: 1,
      catchup: "append",
      catchupDays: 7,
      catchupSource: "?utc={utc}&lutc={lutc}",
      catchupCorrection: -2.5,
      tvgShift: 2,
      userAgent: "VLC/3.0.18 LibVLC/3.0.18",
      referer: "https://picky.example.com/",
      tvgType: "tv",
      isRadio: false,
      manifestType: null,
      drmScheme: null,
      licenseKey: null,
    },
    {
      name: "翡翠台",
      url: "https://example.com/myTV/genyg5?token=abc",
      logo: null,
      category: "DASH",
      categories: ["DASH"],
      tvgId: "jade",
      tvgName: null,
      chno: null,
      catchup: null,
      catchupDays: null,
      catchupSource: null,
      catchupCorrection: null,
      tvgShift: -1.5,
      userAgent: null,
      referer: null,
      tvgType: null,
      isRadio: false,
      manifestType: "mpd",
      drmScheme: "clearkey",
      licenseKey: "0958b9c657622c465a6205eb2252b8ed:2d2fd7b1661b1e28de38268872b48480",
    },
    {
      name: "Radio Bremen",
      url: "http://example.com/rb.m3u8",
      logo: "https://example.com/rb.png",
      category: "Radio",
      categories: ["Radio"],
      tvgId: "rb",
      tvgName: null,
      chno: null,
      catchup: "shift",
      catchupDays: 3,
      catchupSource: null,
      catchupCorrection: null,
      tvgShift: null,
      userAgent: null,
      referer: null,
      tvgType: "radio",
      isRadio: true,
      manifestType: null,
      drmScheme: null,
      licenseKey: null,
    },
  ]

  const serialized = serializeM3U(sourceEntries, {
    epgUrl: "https://example.com/epg.xml.gz",
  })
  const reparsed = parseM3U(serialized)

  it("parses back to the same entries", () => {
    expect(reparsed.entries).toEqual(sourceEntries)
  })

  it("parses back the same header epgUrl", () => {
    expect(reparsed.epgUrl).toBe("https://example.com/epg.xml.gz")
  })
})

describe("serializeM3U: fixture round-trip", () => {
  const fixtureNames = ["standard.m3u", "catchup.m3u", "extvlcopt-headers.m3u"]

  for (const fixtureName of fixtureNames) {
    it(`re-parses to the same entries for ${fixtureName}`, () => {
      const firstPass = parseM3U(fixture(fixtureName))
      const serialized = serializeM3U(firstPass.entries, {
        epgUrl: firstPass.epgUrl || null,
      })
      const secondPass = parseM3U(serialized)
      expect(secondPass.entries).toEqual(firstPass.entries)
    })
  }
})

describe("serializeM3U: multi-group and tvg-shift round-trip", () => {
  it("round-trips a multi-group categories array through parseM3U", () => {
    const entry: M3UEntry = { ...minimalEntry, category: "News", categories: ["News", "Sports"] }
    const reparsed = parseM3U(serializeM3U([entry]))
    expect(reparsed.entries[0].categories).toEqual(["News", "Sports"])
    expect(reparsed.entries[0].category).toBe("News;Sports")
  })

  it("round-trips a single group unchanged", () => {
    const entry: M3UEntry = { ...minimalEntry, category: "News", categories: ["News"] }
    const reparsed = parseM3U(serializeM3U([entry]))
    expect(reparsed.entries[0].categories).toEqual(["News"])
    expect(reparsed.entries[0].category).toBe("News")
  })

  it("round-trips a fractional negative tvg-shift", () => {
    const entry: M3UEntry = { ...minimalEntry, tvgShift: -2.5 }
    const reparsed = parseM3U(serializeM3U([entry]))
    expect(reparsed.entries[0].tvgShift).toBe(-2.5)
  })

  it("round-trips a header-level tvg-shift default", () => {
    const serialized = serializeM3U([minimalEntry], { tvgShift: 1 })
    const reparsed = parseM3U(serialized)
    expect(reparsed.entries[0].tvgShift).toBe(1)
  })
})

describe("serializeM3U: embedded commas round-trip", () => {
  it("round-trips a category value containing a literal comma", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      category: "News, Sports",
    }
    const reparsed = parseM3U(serializeM3U([entry]))
    expect(reparsed.entries[0].category).toBe("News, Sports")
  })

  it("round-trips a display name containing a literal comma", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      tvgId: "x",
      name: "Breaking News, Live Update",
    }
    const reparsed = parseM3U(serializeM3U([entry]))
    expect(reparsed.entries[0].name).toBe("Breaking News, Live Update")
    expect(reparsed.entries[0].tvgId).toBe("x")
  })
})

describe("serializeM3U: control-char injection", () => {
  it("strips embedded newlines from an attribute value instead of fabricating a new entry", () => {
    const malicious: M3UEntry = {
      ...minimalEntry,
      tvgName: 'Injected\n#EXTINF:-1,Fake Channel\nhttp://evil.example.com/fake.m3u8',
    }
    const normal: M3UEntry = { ...minimalEntry, name: "Trailing Channel" }
    const reparsed = parseM3U(serializeM3U([malicious, normal]))
    expect(reparsed.entries).toHaveLength(2)
    expect(reparsed.entries[0].tvgName).not.toContain("\n")
    expect(reparsed.entries[0].tvgName).toBe("Injected#EXTINF:-1,Fake Channelhttp://evil.example.com/fake.m3u8")
    expect(reparsed.entries[0].url).toBe(minimalEntry.url)
    expect(reparsed.entries[1].name).toBe("Trailing Channel")
    expect(reparsed.entries[1].url).toBe(minimalEntry.url)
  })

  it("strips carriage returns and other control chars from the display name", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      name: "Bad\r\nName\x07Here",
    }
    const reparsed = parseM3U(serializeM3U([entry]))
    expect(reparsed.entries).toHaveLength(1)
    expect(reparsed.entries[0].name).toBe("BadNameHere")
  })

  it("strips control chars from the URL line so it cannot inject a new entry", () => {
    const entry: M3UEntry = {
      ...minimalEntry,
      url: "http://example.com/min.m3u8\n#EXTINF:-1,Injected\nhttp://evil.example.com/x.m3u8",
    }
    const normal: M3UEntry = { ...minimalEntry, name: "Trailing Channel" }
    const reparsed = parseM3U(serializeM3U([entry, normal]))
    expect(reparsed.entries).toHaveLength(2)
    expect(reparsed.entries[0].url).not.toContain("\n")
    expect(reparsed.entries[1].name).toBe("Trailing Channel")
  })
})
