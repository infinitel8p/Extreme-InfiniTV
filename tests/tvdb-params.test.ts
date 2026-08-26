import { describe, it, expect } from "vitest"
import {
  cacheKeyFor,
  hashName,
  normalizeSearchName,
  parseFindRequest,
  searchQueryFor,
  cacheUrlFor,
  parseSeasonRequest,
  parseTitleRequest,
  tvdbLanguageFor,
} from "@/scripts/lib/tvdb-params"

function query(search: string): URLSearchParams {
  return new URLSearchParams(search)
}

describe("parseTitleRequest", () => {
  it("accepts a well-formed request and defaults kind and language", () => {
    expect(parseTitleRequest(query("tmdb=65942"))).toEqual({
      route: "title",
      kind: "series",
      tmdbId: 65942,
      language: "eng",
    })
  })

  it("accepts an explicit kind and whitelisted language", () => {
    expect(parseTitleRequest(query("tmdb=550&kind=movie&lang=deu"))).toEqual({
      route: "title",
      kind: "movie",
      tmdbId: 550,
      language: "deu",
    })
  })

  it.each([
    ["missing id", "kind=series"],
    ["non-numeric id", "tmdb=abc"],
    ["negative id", "tmdb=-5"],
    ["zero id", "tmdb=0"],
    ["absurd id", "tmdb=999999999"],
    ["unknown kind", "tmdb=1&kind=person"],
    ["unknown language", "tmdb=1&lang=klingon"],
    ["injection attempt", "tmdb=1&lang=../../etc/passwd"],
  ])("rejects %s", (_label, search) => {
    expect(parseTitleRequest(query(search))).toBeNull()
  })
})

describe("parseSeasonRequest", () => {
  it("accepts a well-formed request and defaults the order to official", () => {
    expect(parseSeasonRequest(query("tmdb=65942&season=2"))).toEqual({
      route: "season",
      kind: "series",
      tmdbId: 65942,
      tvdbId: null,
      language: "eng",
      seasonNumber: 2,
      order: "official",
    })
  })

  it("allows season zero for specials", () => {
    expect(parseSeasonRequest(query("tmdb=1&season=0"))?.seasonNumber).toBe(0)
  })

  it.each([
    ["missing season", "tmdb=1"],
    ["negative season", "tmdb=1&season=-1"],
    ["out-of-range season", "tmdb=1&season=500"],
    ["unknown order", "tmdb=1&season=1&order=chronological"],
  ])("rejects %s", (_label, search) => {
    expect(parseSeasonRequest(query(search))).toBeNull()
  })
})

describe("tvdbLanguageFor", () => {
  it.each([
    ["de", "deu"],
    ["pt-BR", "por"],
    ["zh", "zho"],
    ["ur", "urd"],
  ])("maps %s to %s", (locale, expected) => {
    expect(tvdbLanguageFor(locale)).toBe(expected)
  })

  it("falls back to the base subtag, then to English", () => {
    expect(tvdbLanguageFor("de-AT")).toBe("deu")
    expect(tvdbLanguageFor("xx-YY")).toBe("eng")
    expect(tvdbLanguageFor(null)).toBe("eng")
  })

  it("only ever produces whitelisted codes", () => {
    for (const locale of ["en", "es", "de", "fr", "pt-BR", "it", "ru", "zh", "ja", "tr", "ar", "ur", "nl", "hi", "id", "pl"]) {
      expect(parseTitleRequest(query(`tmdb=1&lang=${tvdbLanguageFor(locale)}`))).not.toBeNull()
    }
  })
})

describe("cacheKeyFor", () => {
  it("distinguishes every dimension that changes the response", () => {
    const base = parseSeasonRequest(query("tmdb=65942&season=2&lang=deu&order=official"))!
    const keys = new Set([
      cacheKeyFor(base),
      cacheKeyFor({ ...base, seasonNumber: 3 }),
      cacheKeyFor({ ...base, language: "eng" }),
      cacheKeyFor({ ...base, order: "absolute" }),
      cacheKeyFor({ ...base, tmdbId: 65943 }),
    ])
    expect(keys.size).toBe(5)
  })

  it("separates title and season routes for the same id", () => {
    const title = cacheKeyFor(parseTitleRequest(query("tmdb=65942"))!)
    const season = cacheKeyFor(parseSeasonRequest(query("tmdb=65942&season=1"))!)
    expect(title).not.toBe(season)
  })

  it("is stable for equivalent requests", () => {
    const first = parseTitleRequest(query("tmdb=65942&kind=series&lang=eng"))!
    const second = parseTitleRequest(query("lang=eng&tmdb=65942"))!
    expect(cacheKeyFor(first)).toBe(cacheKeyFor(second))
  })

  it("builds an absolute cache URL", () => {
    const url = cacheUrlFor(parseTitleRequest(query("tmdb=65942"))!)
    expect(() => new URL(url)).not.toThrow()
    expect(url).toContain("v3:title:series:65942:eng")
  })
})

describe("normalizeSearchName", () => {
  it.each([
    ["DE - Re:ZERO -Starting Life in Another World- (2016) (JP)", "de re zero starting life in another world 2016 jp"],
    ["  Breaking   Bad  ", "breaking bad"],
    ["Amélie", "amelie"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeSearchName(raw)).toBe(expected)
  })

  it.each([[null], [""], ["a"], ["!!!"], ["   "]])("rejects %s", (raw) => {
    expect(normalizeSearchName(raw)).toBeNull()
  })

  it("caps length so one request cannot mint an unbounded key", () => {
    expect(normalizeSearchName("a".repeat(500))!.length).toBe(120)
  })
})

describe("hashName", () => {
  it("is stable and stays short regardless of input length", () => {
    expect(hashName("breaking bad")).toBe(hashName("breaking bad"))
    expect(hashName("x".repeat(120)).length).toBeLessThanOrEqual(12)
  })

  // 32 bits alone collide often enough to serve one title under another.
  it("separates same-length names and different-length names alike", () => {
    expect(hashName("abc")).not.toBe(hashName("abcd"))
    const seen = new Set()
    for (let index = 0; index < 5000; index++) seen.add(hashName("title number " + index))
    expect(seen.size).toBe(5000)
  })

  it("separates different names", () => {
    expect(hashName("breaking bad")).not.toBe(hashName("better call saul"))
  })
})

describe("parseFindRequest", () => {
  it("accepts a name and optional year", () => {
    expect(parseFindRequest(query("name=Breaking%20Bad&year=2008"))).toEqual({
      route: "find",
      kind: "series",
      query: "Breaking Bad",
      name: "breaking bad",
      year: 2008,
      language: "eng",
    })
  })

  it("treats a missing year as unconstrained", () => {
    expect(parseFindRequest(query("name=Breaking%20Bad"))?.year).toBeNull()
  })

  it.each([
    ["missing name", "year=2008"],
    ["too-short name", "name=a"],
    ["punctuation-only name", "name=%21%21%21"],
    ["bad year", "name=Breaking%20Bad&year=abc"],
    ["out-of-range year", "name=Breaking%20Bad&year=3000"],
    ["unknown kind", "name=Breaking%20Bad&kind=person"],
  ])("rejects %s", (_label, search) => {
    expect(parseFindRequest(query(search))).toBeNull()
  })

  it("keys the cache by hashed name, so raw text never lands in a key", () => {
    const request = parseFindRequest(query("name=Breaking%20Bad&year=2008"))!
    const key = cacheKeyFor(request)
    expect(key).not.toContain("breaking")
    expect(key).toContain("v3:find:series:")
    expect(key).toContain(":2008:eng")
  })

  it("gives differing names differing keys, and equal names the same key", () => {
    const first = cacheKeyFor(parseFindRequest(query("name=Breaking%20Bad"))!)
    const second = cacheKeyFor(parseFindRequest(query("name=breaking   bad"))!)
    const third = cacheKeyFor(parseFindRequest(query("name=Better%20Call%20Saul"))!)
    expect(first).toBe(second)
    expect(first).not.toBe(third)
  })
})

describe("searchQueryFor", () => {
  it("keeps accents and case, since upstream search matches better with them", () => {
    expect(searchQueryFor("Amélie")).toBe("Amélie")
    expect(searchQueryFor("Pokémon")).toBe("Pokémon")
  })

  it("keeps separators that belong to titles", () => {
    expect(searchQueryFor("Marvel's Daredevil")).toBe("Marvel's Daredevil")
    expect(searchQueryFor("Tom - Jerry")).toBe("Tom - Jerry")
    expect(searchQueryFor("Tom & Jerry")).toBe("Tom & Jerry")
  })

  it("splits on a colon, which sinks the right result in upstream ranking", () => {
    expect(searchQueryFor("Re:ZERO")).toBe("Re ZERO")
  })

  it("strips other punctuation and collapses whitespace", () => {
    expect(searchQueryFor("  Breaking   Bad!!!  ")).toBe("Breaking Bad")
  })

  it.each([[null], [""], ["a"], ["!!!"]])("rejects %s", (raw) => {
    expect(searchQueryFor(raw)).toBeNull()
  })

  it("caps length like the key normalizer", () => {
    expect(searchQueryFor("a".repeat(500))!.length).toBe(120)
  })

  it("differs from the key form, which strips accents", () => {
    expect(searchQueryFor("Amélie")).not.toBe(normalizeSearchName("Amélie"))
    expect(normalizeSearchName("Amélie")).toBe("amelie")
  })
})

describe("parseSeasonRequest id exclusivity", () => {
  it("accepts a tvdb id, which is all a name-matched title has", () => {
    const request = parseSeasonRequest(query("tvdb=305089&season=2"))
    expect(request?.tvdbId).toBe(305089)
    expect(request?.tmdbId).toBeNull()
  })

  it.each([
    ["neither id", "season=2"],
    ["both ids", "tmdb=65942&tvdb=305089&season=2"],
  ])("rejects %s", (_label, search) => {
    expect(parseSeasonRequest(query(search))).toBeNull()
  })

  it("keys the two id kinds apart so they cannot collide", () => {
    const byTmdb = cacheKeyFor(parseSeasonRequest(query("tmdb=305089&season=1"))!)
    const byTvdb = cacheKeyFor(parseSeasonRequest(query("tvdb=305089&season=1"))!)
    expect(byTmdb).not.toBe(byTvdb)
  })
})
