import { describe, it, expect } from "vitest"
import {
  buildSubtitleSearchParams,
  canonicalQueryString,
  toOpenSubtitlesLanguage,
  rankSubtitleResults,
  dedupeByFile,
  subtitleResultLabel,
  normalizeSearchResponse,
  type OpenSubtitlesResult,
} from "../src/scripts/lib/opensubtitles-params"

function result(overrides: Partial<OpenSubtitlesResult> = {}): OpenSubtitlesResult {
  return {
    id: "1",
    fileId: 1,
    language: "en",
    release: "Some.Release",
    hearingImpaired: false,
    fromTrusted: false,
    machineTranslated: false,
    aiTranslated: false,
    downloadCount: 0,
    fps: null,
    featureTitle: null,
    featureYear: null,
    ...overrides,
  }
}

describe("buildSubtitleSearchParams", () => {
  it("uses tmdb_id alone for a movie with an id", () => {
    expect(
      buildSubtitleSearchParams({ kind: "movie", title: "Heat", year: 1995, tmdbId: 949 }, ["fr", "en"])
    ).toEqual({ type: "movie", tmdb_id: "949", languages: "en,fr" })
  })

  it("uses query and year for a movie without ids", () => {
    expect(
      buildSubtitleSearchParams({ kind: "movie", title: "  The   Big  Lebowski ", year: 1998 }, ["EN"])
    ).toEqual({ type: "movie", query: "the big lebowski", year: "1998", languages: "en" })
  })

  it("uses the parent id plus season and episode for an episode", () => {
    expect(
      buildSubtitleSearchParams(
        { kind: "episode", title: "Pilot", parentTmdbId: 1396, season: 1, episode: 2 },
        ["en"]
      )
    ).toEqual({
      type: "episode",
      parent_tmdb_id: "1396",
      season_number: "1",
      episode_number: "2",
      languages: "en",
    })
  })

  it("falls back to query with season and episode for an episode without ids", () => {
    expect(
      buildSubtitleSearchParams({ kind: "episode", title: "Breaking Bad", season: 3, episode: 4 }, ["en"])
    ).toEqual({
      type: "episode",
      query: "breaking bad",
      season_number: "3",
      episode_number: "4",
      languages: "en",
    })
  })

  it("omits page 1, sends later pages and non-default hearing_impaired", () => {
    const base = { kind: "movie" as const, title: "x", tmdbId: 1 }
    expect(buildSubtitleSearchParams(base, [], { page: 1, hearingImpaired: "include" })).toEqual({
      type: "movie",
      tmdb_id: "1",
    })
    expect(buildSubtitleSearchParams(base, [], { page: 3, hearingImpaired: "exclude" })).toMatchObject({
      page: "3",
      hearing_impaired: "exclude",
    })
  })
})

describe("canonicalQueryString", () => {
  it("sorts keys, lowercases values and encodes spaces as plus", () => {
    expect(canonicalQueryString({ query: "The Matrix", languages: "EN,fr", type: "movie" })).toBe(
      "languages=en%2Cfr&query=the+matrix&type=movie"
    )
  })
})

describe("toOpenSubtitlesLanguage", () => {
  it("maps app locales", () => {
    expect(toOpenSubtitlesLanguage("pt-BR")).toBe("pt-br")
    expect(toOpenSubtitlesLanguage("zh")).toBe("zh-cn")
    expect(toOpenSubtitlesLanguage("zh-TW")).toBe("zh-tw")
    expect(toOpenSubtitlesLanguage("en-US")).toBe("en")
    expect(toOpenSubtitlesLanguage("de")).toBe("de")
    expect(toOpenSubtitlesLanguage("")).toBe("")
  })
})

describe("rankSubtitleResults", () => {
  it("orders by language tier, trust, hearing impaired, then downloads", () => {
    const ranked = rankSubtitleResults(
      [
        result({ fileId: 1, language: "ja", downloadCount: 999 }),
        result({ fileId: 2, language: "fr", downloadCount: 5 }),
        result({ fileId: 3, language: "en", downloadCount: 50 }),
        result({ fileId: 4, language: "fr", downloadCount: 10, hearingImpaired: true }),
        result({ fileId: 5, language: "fr", downloadCount: 1, fromTrusted: true }),
        result({ fileId: 6, language: "fr", downloadCount: 100 }),
      ],
      { defaultLang: "fr", backupLang: "en" }
    )
    expect(ranked.map((entry) => entry.fileId)).toEqual([5, 6, 2, 4, 3, 1])
  })

  it("drops machine translated results", () => {
    const ranked = rankSubtitleResults(
      [result({ fileId: 1, machineTranslated: true }), result({ fileId: 2 })],
      { defaultLang: "en" }
    )
    expect(ranked.map((entry) => entry.fileId)).toEqual([2])
  })

  it("keeps input order for ties", () => {
    const ranked = rankSubtitleResults(
      [result({ fileId: 1 }), result({ fileId: 2 }), result({ fileId: 3 })],
      { defaultLang: "en" }
    )
    expect(ranked.map((entry) => entry.fileId)).toEqual([1, 2, 3])
  })
})

describe("dedupeByFile", () => {
  it("keeps the first entry per file id", () => {
    const unique = dedupeByFile([
      result({ id: "a", fileId: 7 }),
      result({ id: "b", fileId: 7 }),
      result({ fileId: 8 }),
    ])
    expect(unique.map((entry) => entry.id)).toEqual(["a", "1"])
  })
})

describe("subtitleResultLabel", () => {
  it("formats language and release", () => {
    expect(subtitleResultLabel(result({ release: "Movie.2020.1080p" }))).toBe("EN · Movie.2020.1080p")
  })

  it("appends HI, truncates and uses the translator", () => {
    const label = subtitleResultLabel(
      result({ hearingImpaired: true, release: "x".repeat(100) }),
      () => "English"
    )
    expect(label.startsWith("English · ")).toBe(true)
    expect(label.endsWith(" (HI)")).toBe(true)
    expect(label.length).toBeLessThan(90)
  })
})

describe("normalizeSearchResponse", () => {
  it("maps entries and skips ones without a file id", () => {
    const parsed = normalizeSearchResponse({
      page: 2,
      total_pages: 5,
      data: [
        {
          id: "10",
          attributes: {
            language: "EN",
            release: "R",
            hearing_impaired: true,
            from_trusted: true,
            download_count: 42,
            fps: 23.976,
            feature_details: { title: "Heat", year: 1995 },
            files: [{ file_id: 555 }],
          },
        },
        { id: "11", attributes: { language: "en", files: [] } },
        { id: "12", attributes: { files: [{ file_id: 1 }] } },
        null,
        "junk",
      ],
    })
    expect(parsed.page).toBe(2)
    expect(parsed.totalPages).toBe(5)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0]).toMatchObject({
      id: "10",
      fileId: 555,
      language: "en",
      hearingImpaired: true,
      fromTrusted: true,
      downloadCount: 42,
      fps: 23.976,
      featureTitle: "Heat",
      featureYear: 1995,
    })
  })

  it("tolerates garbage", () => {
    expect(normalizeSearchResponse(null)).toEqual({ results: [], page: 1, totalPages: 1 })
  })
})
