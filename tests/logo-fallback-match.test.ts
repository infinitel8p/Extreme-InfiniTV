import { describe, it, expect } from "vitest"
import {
  pickBestLogos,
  logoNameKey,
  buildLogoIndex,
  countryHint,
  matchLogo,
  type LogoApiRecord,
} from "../src/scripts/lib/logo-fallback-match"

function makeRecord(overrides: Partial<LogoApiRecord> = {}): LogoApiRecord {
  return {
    channel: "BBCOne.uk",
    feed: null,
    in_use: true,
    width: 512,
    height: 512,
    format: "PNG",
    url: "https://example.com/bbcone.png",
    ...overrides,
  }
}

describe("pickBestLogos", () => {
  it("prefers feed null over a feed variant", () => {
    const pairs = pickBestLogos([
      makeRecord({ feed: "HD", url: "https://example.com/hd.png" }),
      makeRecord({ feed: null, url: "https://example.com/main.png" }),
    ])
    expect(pairs).toEqual([["BBCOne.uk", "https://example.com/main.png"]])
  })

  it("prefers in_use over not in_use", () => {
    const pairs = pickBestLogos([
      makeRecord({ in_use: false, url: "https://example.com/unused.png" }),
      makeRecord({ in_use: true, url: "https://example.com/used.png" }),
    ])
    expect(pairs).toEqual([["BBCOne.uk", "https://example.com/used.png"]])
  })

  it("prefers PNG over SVG at equal flags", () => {
    const pairs = pickBestLogos([
      makeRecord({ format: "SVG", url: "https://example.com/vector.svg" }),
      makeRecord({ format: "PNG", url: "https://example.com/raster.png" }),
    ])
    expect(pairs).toEqual([["BBCOne.uk", "https://example.com/raster.png"]])
  })

  it("applies a resolution bonus so the higher-resolution variant wins at equal format", () => {
    const pairs = pickBestLogos([
      makeRecord({ format: "JPEG", width: 64, url: "https://example.com/small.jpg" }),
      makeRecord({ format: "JPEG", width: 512, url: "https://example.com/large.jpg" }),
    ])
    expect(pairs).toEqual([["BBCOne.uk", "https://example.com/large.jpg"]])
  })

  it("skips records missing a channel id or url, and non-http urls", () => {
    const pairs = pickBestLogos([
      makeRecord({ channel: "", url: "https://example.com/no-channel.png" }),
      makeRecord({ channel: "NoUrl.uk", url: "" }),
      makeRecord({ channel: "BadScheme.uk", url: "ftp://example.com/bad.png" }),
      makeRecord({ channel: "Good.uk", url: "https://example.com/good.png" }),
    ])
    expect(pairs).toEqual([["Good.uk", "https://example.com/good.png"]])
  })

  it("breaks exact ties deterministically by lexicographically smaller url", () => {
    const pairs = pickBestLogos([
      makeRecord({ url: "https://example.com/z.png" }),
      makeRecord({ url: "https://example.com/a.png" }),
    ])
    expect(pairs).toEqual([["BBCOne.uk", "https://example.com/a.png"]])
  })

  it("keeps one pair per channel id, using its original casing", () => {
    const pairs = pickBestLogos([
      makeRecord({ channel: "BBCOne.uk", url: "https://example.com/one.png" }),
      makeRecord({ channel: "CNN.us", url: "https://example.com/cnn.png" }),
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs.find(([channelId]) => channelId === "BBCOne.uk")).toBeTruthy()
    expect(pairs.find(([channelId]) => channelId === "CNN.us")).toBeTruthy()
  })
})

describe("logoNameKey", () => {
  it("strips a colon-separated country prefix", () => {
    expect(logoNameKey("DE: ZDF")).toBe("zdf")
  })

  it("strips a pipe-separated country prefix and a quality suffix", () => {
    expect(logoNameKey("UK | BBC One HD")).toBe("bbcone")
  })

  it("removes quality junk tokens as whole words", () => {
    expect(logoNameKey("ZDF FHD RAW")).toBe("zdf")
  })

  it("strips diacritics via normalize", () => {
    expect(logoNameKey("Café TV")).toBe("cafetv")
  })

  it("does not strip a 2-letter word when there is no separator", () => {
    expect(logoNameKey("La Sexta")).toBe("lasexta")
  })

  it("does not treat a bare hyphen inside a name as a separator", () => {
    expect(logoNameKey("Al-Jazeera")).toBe("aljazeera")
  })

  it("strips a hyphen separator with whitespace on both sides", () => {
    expect(logoNameKey("DE - ZDF HD")).toBe("zdf")
  })
})

describe("buildLogoIndex", () => {
  it("lowercases the byId key", () => {
    const index = buildLogoIndex([["BBCOne.uk", "https://example.com/bbcone.png"]])
    expect(index.byId.get("bbcone.uk")).toBe("https://example.com/bbcone.png")
  })

  it("builds a byName key and country from the channel id", () => {
    const index = buildLogoIndex([["BBCOne.uk", "https://example.com/bbcone.png"]])
    const bucket = index.byName.get("bbcone")
    expect(bucket).toEqual([{ country: "uk", url: "https://example.com/bbcone.png" }])
  })

  it("uses an empty country for ids without a dot", () => {
    const index = buildLogoIndex([["SomeChannel", "https://example.com/some.png"]])
    const bucket = index.byName.get("somechannel")
    expect(bucket).toEqual([{ country: "", url: "https://example.com/some.png" }])
  })

  it("rejects a non-2-letter suffix as a country", () => {
    const index = buildLogoIndex([["Channel.abc", "https://example.com/channel.png"]])
    const bucket = index.byName.get("channel")
    expect(bucket).toEqual([{ country: "", url: "https://example.com/channel.png" }])
  })
})

describe("countryHint", () => {
  it("reads the country from tvgId, stripping an @feed suffix", () => {
    expect(countryHint(undefined, "BBCOne.uk@HD")).toBe("uk")
  })

  it("reads the country from a name prefix", () => {
    expect(countryHint("DE: ZDF", undefined)).toBe("de")
  })

  it("returns null when neither source has a country", () => {
    expect(countryHint("ZDF", "SomeChannel")).toBeNull()
    expect(countryHint(undefined, undefined)).toBeNull()
  })

  it("reads the country from a hyphen-separated name prefix", () => {
    expect(countryHint("DE - ZDF", undefined)).toBe("de")
  })

  it("does not treat a bare hyphen inside a name as a country separator", () => {
    expect(countryHint("Al-Jazeera", undefined)).toBeNull()
  })

  it("resolves a 3-letter country alias in a colon-separated name prefix", () => {
    expect(countryHint("USA: Animal Planet", undefined)).toBe("us")
  })

  it("resolves a 3-letter country alias in a pipe-separated name prefix", () => {
    expect(countryHint("GER | RTL", undefined)).toBe("de")
  })

  it("resolves a 3-letter country alias from a tvgId suffix", () => {
    expect(countryHint(undefined, "SomeChannel.gbr")).toBe("uk")
  })

  it("returns null for an unaliased 3-letter name prefix", () => {
    expect(countryHint("XYZ: Channel", undefined)).toBeNull()
  })
})

describe("matchLogo", () => {
  it("matches an exact tvgId hit case-insensitively with the @feed suffix stripped", () => {
    const index = buildLogoIndex([["BBCOne.uk", "https://example.com/bbcone.png"]])
    const url = matchLogo(index, { name: "Something Else", tvgId: "bbcone.UK@HD" })
    expect(url).toBe("https://example.com/bbcone.png")
  })

  it("falls back to name matching when tvgId misses", () => {
    const index = buildLogoIndex([["BBCOne.uk", "https://example.com/bbcone.png"]])
    const url = matchLogo(index, { name: "UK | BBC One HD", tvgId: "not.in.index" })
    expect(url).toBe("https://example.com/bbcone.png")
  })

  it("disambiguates between countries using the country hint", () => {
    const index = buildLogoIndex([
      ["ZDF.de", "https://example.com/zdf-de.png"],
      ["ZDF.at", "https://example.com/zdf-at.png"],
    ])
    const url = matchLogo(index, { name: "AT: ZDF", tvgId: undefined })
    expect(url).toBe("https://example.com/zdf-at.png")
  })

  it("returns the shared url when every ambiguous candidate points to it and there is no country hint", () => {
    const index = buildLogoIndex([
      ["ZDF.de", "https://example.com/zdf.png"],
      ["ZDF.at", "https://example.com/zdf.png"],
    ])
    const url = matchLogo(index, { name: "ZDF", tvgId: undefined })
    expect(url).toBe("https://example.com/zdf.png")
  })

  it("returns null for ambiguous candidates with different urls and no country hint", () => {
    const index = buildLogoIndex([
      ["ZDF.de", "https://example.com/zdf-de.png"],
      ["ZDF.at", "https://example.com/zdf-at.png"],
    ])
    const url = matchLogo(index, { name: "ZDF", tvgId: undefined })
    expect(url).toBeNull()
  })

  it("falls back to the tvgId name part when the display name misses byName", () => {
    const index = buildLogoIndex([["BBCOne.us", "https://example.com/bbcone-us.png"]])
    const url = matchLogo(index, { name: "Some Rebranded Name", tvgId: "BBCOne.uk" })
    expect(url).toBe("https://example.com/bbcone-us.png")
  })

  it("guards short generic names even when the tvgId name part is also short", () => {
    const index = buildLogoIndex([["M6.be", "https://example.com/m6.png"]])
    const url = matchLogo(index, { name: "M6", tvgId: "M6.fr" })
    expect(url).toBeNull()
  })

  it("guards short generic names with no usable tvgId", () => {
    const index = buildLogoIndex([["TV.us", "https://example.com/tv.png"]])
    const url = matchLogo(index, { name: "TV", tvgId: undefined })
    expect(url).toBeNull()
  })

  it("returns null for an unknown channel", () => {
    const index = buildLogoIndex([["BBCOne.uk", "https://example.com/bbcone.png"]])
    const url = matchLogo(index, { name: "Totally Unknown Channel", tvgId: undefined })
    expect(url).toBeNull()
  })

  it("resolves a 3-letter country alias in the name prefix as a disambiguation hint", () => {
    const index = buildLogoIndex([
      ["AnimalPlanet.us", "https://logo.us/x.png"],
      ["AnimalPlanet.de", "https://logo.de/x.png"],
    ])
    const url = matchLogo(index, { name: "USA: Animal Planet", tvgId: undefined })
    expect(url).toBe("https://logo.us/x.png")
  })
})
