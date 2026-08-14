import { describe, it, expect } from "vitest"
import {
  cleanProviderTitle,
  pickTmdbMatch,
  matchRecommendationsToCatalog,
  matchAllTitlesToCatalog,
  extractLangPrefix,
  type TmdbMatchCandidate,
} from "../src/scripts/lib/tmdb-match"
import {
  tmdbLanguageFor,
  tmdbImageUrl,
  extractTrailerYoutubeKey,
  extractDirector,
  extractCast,
  TMDB_POSTER_SIZE,
} from "../src/scripts/lib/tmdb"

describe("cleanProviderTitle", () => {
  it("strips a bracketed year and quality tags, extracting the year", () => {
    const { variants, year } = cleanProviderTitle("EN - 4K Inception (2010) HEVC")
    expect(year).toBe(2010)
    expect(variants).toContain("Inception")
  })

  it("strips a pipe-separated language prefix and bracketed resolution tag", () => {
    const { variants, year } = cleanProviderTitle("DE | Der Untergang [1080p]")
    expect(year).toBeNull()
    expect(variants).toContain("Der Untergang")
  })

  it("leaves an English title with a leading The untouched", () => {
    const { variants, year } = cleanProviderTitle("The Matrix")
    expect(year).toBeNull()
    expect(variants).toEqual(["The Matrix"])
  })

  it("strips a full-word MULTI tag alongside a resolution and HDR marker", () => {
    const { variants, year } = cleanProviderTitle("MULTI Avatar 2160p HDR")
    expect(year).toBeNull()
    expect(variants).toContain("Avatar")
  })

  it("extracts a bare trailing year", () => {
    const { variants, year } = cleanProviderTitle("The Great Escape 1963")
    expect(year).toBe(1963)
    expect(variants).toContain("The Great Escape")
  })

  it("extracts a bracketed year", () => {
    const { variants, year } = cleanProviderTitle("Der Untergang (2004)")
    expect(year).toBe(2004)
    expect(variants).toContain("Der Untergang")
  })

  it("orders variants fully-cleaned, no-prefix-strip, then raw", () => {
    const { variants } = cleanProviderTitle("EN - 4K Inception (2010) HEVC")
    expect(variants[0]).toBe("Inception")
    expect(variants[variants.length - 1]).toBe("EN - 4K Inception (2010) HEVC")
  })

  it("drops duplicate and empty variants", () => {
    const { variants } = cleanProviderTitle("The Matrix")
    expect(variants).toHaveLength(1)
  })

  it("truncates at the first junk token when junk trails the title", () => {
    const { variants, year } = cleanProviderTitle("Inception 2010 1080p BluRay x264 AAC")
    expect(year).toBe(2010)
    expect(variants).toContain("Inception")
  })

  it("strips a leading release-group bracket before extracting the year", () => {
    const { variants, year } = cleanProviderTitle("[VIP] Dune (2021)")
    expect(year).toBe(2021)
    expect(variants).toContain("Dune")
  })

  it("does not treat a date-like sequence as a year", () => {
    const { year } = cleanProviderTitle("News 2024.01.15")
    expect(year).toBeNull()
  })

  it("extracts a title-trailing digit run as the year (Blade Runner 2049), with raw preserving the exact title", () => {
    const { variants, year } = cleanProviderTitle("Blade Runner 2049")
    expect(year).toBe(2049)
    expect(variants).toContain("Blade Runner")
    expect(variants).toContain("Blade Runner 2049")
  })

  it("keeps a raw fallback so a junk-listed word inside the real title still matches exactly", () => {
    const { variants } = cleanProviderTitle("The Limited Series")
    expect(variants).toContain("The Limited Series")
    const results: TmdbMatchCandidate[] = [
      { id: 9, title: "The Limited Series", release_date: "2020-01-01" },
    ]
    const match = pickTmdbMatch(results, { variants, year: null, mediaType: "movie" })
    expect(match?.id).toBe(9)
  })

  it("strips a language prefix and bracketed year, then matches the real TMDB entry (The Batman)", () => {
    const { variants, year } = cleanProviderTitle("TR - The Batman (2022)")
    expect(year).toBe(2022)
    expect(variants).toContain("The Batman")
    const results: TmdbMatchCandidate[] = [
      { id: 414906, title: "The Batman", original_title: "The Batman", release_date: "2022-03-01", vote_count: 9000, popularity: 200 },
    ]
    const match = pickTmdbMatch(results, { variants, year, mediaType: "movie" })
    expect(match?.id).toBe(414906)
  })
})

describe("pickTmdbMatch", () => {
  function movie(id: number, title: string, releaseDate: string, voteCount = 0, popularity = 0): TmdbMatchCandidate {
    return { id, title, release_date: releaseDate, vote_count: voteCount, popularity }
  }

  it("accepts an exact title match within the year window", () => {
    const results = [movie(1, "Inception", "2010-07-16")]
    const match = pickTmdbMatch(results, { variants: ["Inception"], year: 2010, mediaType: "movie" })
    expect(match).toEqual({ id: 1, title: "Inception", year: 2010 })
  })

  it("rejects a near-but-not-exact title", () => {
    const results = [movie(1, "Inception Part II", "2010-07-16")]
    const match = pickTmdbMatch(results, { variants: ["Inception"], year: 2010, mediaType: "movie" })
    expect(match).toBeNull()
  })

  it("accepts a result exactly one year off (boundary)", () => {
    const results = [movie(1, "Inception", "2011-01-01")]
    const match = pickTmdbMatch(results, { variants: ["Inception"], year: 2010, mediaType: "movie" })
    expect(match?.id).toBe(1)
  })

  it("rejects a result two years off", () => {
    const results = [movie(1, "Inception", "2012-01-01")]
    const match = pickTmdbMatch(results, { variants: ["Inception"], year: 2010, mediaType: "movie" })
    expect(match).toBeNull()
  })

  it("accepts a tv result that premiered earlier than the queried year", () => {
    const results: TmdbMatchCandidate[] = [
      { id: 5, name: "Breaking Bad", first_air_date: "2008-01-20" },
    ]
    const match = pickTmdbMatch(results, { variants: ["Breaking Bad"], year: 2013, mediaType: "tv" })
    expect(match?.id).toBe(5)
  })

  it("rejects a tv result that premiered later than the queried year", () => {
    const results: TmdbMatchCandidate[] = [
      { id: 5, name: "Breaking Bad", first_air_date: "2015-01-20" },
    ]
    const match = pickTmdbMatch(results, { variants: ["Breaking Bad"], year: 2013, mediaType: "tv" })
    expect(match).toBeNull()
  })

  it("requires exactly one passing result when no year is supplied", () => {
    const results = [movie(1, "Elysium", "2013-08-09"), movie(2, "Elysium", "1999-01-01")]
    expect(pickTmdbMatch(results, { variants: ["Elysium"], year: null, mediaType: "movie" })).toBeNull()
  })

  it("returns the unique passing result when no year is supplied", () => {
    const results = [movie(1, "Elysium", "2013-08-09")]
    const match = pickTmdbMatch(results, { variants: ["Elysium"], year: null, mediaType: "movie" })
    expect(match?.id).toBe(1)
  })

  it("breaks ties by vote count then popularity", () => {
    const results = [
      movie(1, "Dune", "2010-01-01", 10, 999),
      movie(2, "Dune", "2011-01-01", 50, 10),
    ]
    const match = pickTmdbMatch(results, { variants: ["Dune"], year: 2010, mediaType: "movie" })
    expect(match?.id).toBe(2)
  })

  it("breaks a vote-count tie by popularity", () => {
    const results = [
      movie(1, "Dune", "2010-01-01", 50, 5),
      movie(2, "Dune", "2011-01-01", 50, 99),
    ]
    const match = pickTmdbMatch(results, { variants: ["Dune"], year: 2010, mediaType: "movie" })
    expect(match?.id).toBe(2)
  })

  it("returns null for an empty result list", () => {
    expect(pickTmdbMatch([], { variants: ["Dune"], year: 2010, mediaType: "movie" })).toBeNull()
  })

  it("prefers a same-title tv reboot near the requested year over a high-vote-count original from decades earlier", () => {
    const results: TmdbMatchCandidate[] = [
      { id: 1, name: "Doctor Who", first_air_date: "1998-01-01", vote_count: 5000, popularity: 50 },
      { id: 2, name: "Doctor Who", first_air_date: "2023-01-01", vote_count: 10, popularity: 5 },
    ]
    const match = pickTmdbMatch(results, { variants: ["Doctor Who"], year: 2023, mediaType: "tv" })
    expect(match?.id).toBe(2)
  })
})

describe("matchRecommendationsToCatalog", () => {
  it("matches by title and rejects an incompatible year", () => {
    const recommendations = [{ title: "Interstellar", year: 2014 }]
    const catalog = [
      { id: "a", name: "Interstellar", year: 2014 },
      { id: "b", name: "Interstellar", year: 1999 },
    ]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, { mediaType: "movie" })
    expect(matched.map((entry) => entry.id)).toEqual(["a"])
  })

  it("dedupes by catalog id", () => {
    const recommendations = [{ title: "Dune", year: 2021 }, { title: "Dune", year: 2021 }]
    const catalog = [{ id: "a", name: "Dune", year: 2021 }]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, { mediaType: "movie" })
    expect(matched).toHaveLength(1)
  })

  it("caps the result at limit", () => {
    const recommendations = Array.from({ length: 20 }, (_, index) => ({
      title: `Title ${index}`,
      year: 2000,
    }))
    const catalog = Array.from({ length: 20 }, (_, index) => ({
      id: index,
      name: `Title ${index}`,
      year: 2000,
    }))
    const matched = matchRecommendationsToCatalog(recommendations, catalog, { mediaType: "movie", limit: 3 })
    expect(matched).toHaveLength(3)
  })

  it("matches on title alone when neither side has a year", () => {
    const recommendations = [{ title: "Amelie" }]
    const catalog = [{ id: "a", name: "Amelie" }]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, { mediaType: "movie" })
    expect(matched.map((entry) => entry.id)).toEqual(["a"])
  })

  it("matches tv recommendations by name", () => {
    const recommendations = [{ name: "The Wire", year: 2002 }]
    const catalog = [{ id: "x", name: "The Wire", year: 2002 }]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, { mediaType: "tv" })
    expect(matched.map((entry) => entry.id)).toEqual(["x"])
  })

  it("returns nothing when the catalog is empty", () => {
    expect(matchRecommendationsToCatalog([{ title: "Dune" }], [], { mediaType: "movie" })).toEqual([])
  })

  it("returns nothing when there are no recommendations", () => {
    expect(
      matchRecommendationsToCatalog([], [{ id: "a", name: "Dune" }], { mediaType: "movie" })
    ).toEqual([])
  })

  it("picks the candidate matching sourcePrefix over one in another language", () => {
    const recommendations = [{ title: "Not Another Teen Movie", year: 2001 }]
    const catalog = [
      { id: "de", name: "DE - Not Another Teen Movie (2001)", year: 2001 },
      { id: "al", name: "AL - Not Another Teen Movie (2001)", year: 2001 },
    ]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, {
      mediaType: "movie",
      sourcePrefix: "AL",
    })
    expect(matched.map((entry) => entry.id)).toEqual(["al"])
  })

  it("falls back to a cross-language candidate when no same-prefix or preferred match exists (never drops a recommendation)", () => {
    const recommendations = [{ title: "Project X", year: 2012 }]
    const catalog = [{ id: "de", name: "DE - Project X (2012)", year: 2012 }]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, {
      mediaType: "movie",
      sourcePrefix: "AL",
    })
    expect(matched.map((entry) => entry.id)).toEqual(["de"])
  })

  it("prefers a preferredTags match over a cross-language fallback", () => {
    const recommendations = [{ title: "Project X", year: 2012 }]
    const catalog = [
      { id: "de", name: "DE - Project X (2012)", year: 2012 },
      { id: "fr", name: "FR - Project X (2012)", year: 2012 },
    ]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, {
      mediaType: "movie",
      sourcePrefix: "AL",
      preferredTags: ["FR"],
    })
    expect(matched.map((entry) => entry.id)).toEqual(["fr"])
  })

  it("tries each preferredTags entry in order", () => {
    const recommendations = [{ title: "Project X", year: 2012 }]
    const catalog = [
      { id: "de", name: "DE - Project X (2012)", year: 2012 },
      { id: "fr", name: "FR - Project X (2012)", year: 2012 },
    ]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, {
      mediaType: "movie",
      preferredTags: ["EN", "FR"],
    })
    expect(matched.map((entry) => entry.id)).toEqual(["fr"])
  })

  it("dedupes matches by group key instead of catalog id, keeping only the first-picked variant per group", () => {
    const recommendations = [
      { title: "Alpha", year: 2020 },
      { title: "Beta", year: 2020 },
    ]
    const catalog = [
      { id: "a", name: "Alpha", year: 2020 },
      { id: "b", name: "Beta", year: 2020 },
    ]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, {
      mediaType: "movie",
      groupKeyForEntry: () => "same-group",
    })
    expect(matched.map((entry) => entry.id)).toEqual(["a"])
  })

  it("falls back to a no-prefix candidate when sourcePrefix has no same-language match", () => {
    const recommendations = [{ title: "Project X", year: 2012 }]
    const catalog = [{ id: "neutral", name: "Project X (2012)", year: 2012 }]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, {
      mediaType: "movie",
      sourcePrefix: "AL",
    })
    expect(matched.map((entry) => entry.id)).toEqual(["neutral"])
  })

  it("keeps old preference behavior when sourcePrefix is null: no-prefix candidate first", () => {
    const recommendations = [{ title: "Dune", year: 2021 }]
    const catalog = [
      { id: "prefixed", name: "DE - Dune (2021)", year: 2021 },
      { id: "neutral", name: "Dune (2021)", year: 2021 },
    ]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, { mediaType: "movie" })
    expect(matched.map((entry) => entry.id)).toEqual(["neutral"])
  })

  it("keeps old single-candidate fallback when sourcePrefix is null and only one match exists", () => {
    const recommendations = [{ title: "Dune", year: 2021 }]
    const catalog = [{ id: "prefixed", name: "DE - Dune (2021)", year: 2021 }]
    const matched = matchRecommendationsToCatalog(recommendations, catalog, { mediaType: "movie" })
    expect(matched.map((entry) => entry.id)).toEqual(["prefixed"])
  })
})

describe("matchAllTitlesToCatalog", () => {
  it("matches every language version instead of skipping on ambiguity", () => {
    const titles = [{ title: "Twilight", year: 2008 }]
    const catalog = [
      { id: 1, name: "EN - Twilight (2008)", year: 2008 },
      { id: 2, name: "AL - Twilight (2008)", year: 2008 },
      { id: 3, name: "EN - Batman (2022)", year: 2022 },
    ]
    const matched = matchAllTitlesToCatalog(titles, catalog)
    expect(matched.map((entry) => entry.id).sort()).toEqual([1, 2])
  })

  it("excludes a catalog entry whose year mismatches by more than one", () => {
    const titles = [{ title: "Twilight", year: 2008 }]
    const catalog = [{ id: 1, name: "Twilight", year: 1998 }]
    expect(matchAllTitlesToCatalog(titles, catalog)).toEqual([])
  })

  it("allows a one-year drift", () => {
    const titles = [{ title: "Twilight", year: 2008 }]
    const catalog = [{ id: 1, name: "Twilight", year: 2009 }]
    expect(matchAllTitlesToCatalog(titles, catalog).map((entry) => entry.id)).toEqual([1])
  })

  it("matches any catalog year when the filmography title has no year", () => {
    const titles = [{ title: "Twilight" }]
    const catalog = [{ id: 1, name: "Twilight", year: 2008 }]
    expect(matchAllTitlesToCatalog(titles, catalog).map((entry) => entry.id)).toEqual([1])
  })

  it("matches a title with no year against a catalog entry with no year", () => {
    const titles = [{ title: "Twilight" }]
    const catalog = [{ id: 1, name: "Twilight" }]
    expect(matchAllTitlesToCatalog(titles, catalog).map((entry) => entry.id)).toEqual([1])
  })

  it("dedupes by catalog id across multiple filmography entries", () => {
    const titles = [{ title: "Dune", year: 2021 }, { title: "Dune", year: 2021 }]
    const catalog = [{ id: "a", name: "Dune", year: 2021 }]
    expect(matchAllTitlesToCatalog(titles, catalog)).toHaveLength(1)
  })

  it("returns nothing for an empty catalog or an empty filmography", () => {
    expect(matchAllTitlesToCatalog([{ title: "Dune" }], [])).toEqual([])
    expect(matchAllTitlesToCatalog([], [{ id: "a", name: "Dune" }])).toEqual([])
  })
})

describe("extractLangPrefix", () => {
  it("extracts an all-caps 2-3 letter prefix before a dash separator", () => {
    expect(extractLangPrefix("AL - Not Another Teen Movie (2001)")).toBe("AL")
  })

  it("returns null for a title with no language prefix", () => {
    expect(extractLangPrefix("The Batman")).toBeNull()
  })

  it("returns null for a 5-letter prefix like MULTI (outside the 2-3 letter range)", () => {
    expect(extractLangPrefix("MULTI Avatar")).toBeNull()
  })
})

describe("tmdbLanguageFor", () => {
  it("maps known locales to their TMDb language tag", () => {
    expect(tmdbLanguageFor("en")).toBe("en-US")
    expect(tmdbLanguageFor("de")).toBe("de-DE")
    expect(tmdbLanguageFor("pt-BR")).toBe("pt-BR")
    expect(tmdbLanguageFor("zh")).toBe("zh-CN")
  })

  it("falls back to en-US for an unknown locale", () => {
    expect(tmdbLanguageFor("xx")).toBe("en-US")
  })
})

describe("tmdbImageUrl", () => {
  it("returns null for a missing path", () => {
    expect(tmdbImageUrl(null, TMDB_POSTER_SIZE)).toBeNull()
    expect(tmdbImageUrl("", TMDB_POSTER_SIZE)).toBeNull()
  })

  it("builds the full image URL for a given size", () => {
    expect(tmdbImageUrl("/abc123.jpg", TMDB_POSTER_SIZE)).toBe(
      "https://image.tmdb.org/t/p/w500/abc123.jpg"
    )
  })
})

describe("extractTrailerYoutubeKey", () => {
  it("prefers an official YouTube trailer", () => {
    const videos = {
      results: [
        { key: "teaser1", site: "YouTube", type: "Teaser" },
        { key: "trailer1", site: "YouTube", type: "Trailer", official: false },
        { key: "trailer2", site: "YouTube", type: "Trailer", official: true },
      ],
    }
    expect(extractTrailerYoutubeKey(videos)).toBe("trailer2")
  })

  it("falls back to any trailer, then a teaser", () => {
    expect(
      extractTrailerYoutubeKey({ results: [{ key: "t1", site: "YouTube", type: "Trailer" }] })
    ).toBe("t1")
    expect(
      extractTrailerYoutubeKey({ results: [{ key: "s1", site: "YouTube", type: "Teaser" }] })
    ).toBe("s1")
  })

  it("returns null when there is nothing usable", () => {
    expect(extractTrailerYoutubeKey({ results: [] })).toBeNull()
    expect(extractTrailerYoutubeKey(null)).toBeNull()
    expect(
      extractTrailerYoutubeKey({ results: [{ key: "v1", site: "Vimeo", type: "Trailer" }] })
    ).toBeNull()
  })
})

describe("extractDirector", () => {
  it("returns the first director's name", () => {
    const credits = { crew: [{ name: "Alice", job: "Writer" }, { name: "Bob", job: "Director" }] }
    expect(extractDirector(credits)).toBe("Bob")
  })

  it("returns null with no director in the crew", () => {
    expect(extractDirector({ crew: [{ name: "Alice", job: "Writer" }] })).toBeNull()
    expect(extractDirector(null)).toBeNull()
  })
})

describe("extractCast", () => {
  it("maps the first N cast members", () => {
    const credits = {
      cast: [
        { id: 1, name: "Alice", character: "Hero", profile_path: "/a.jpg" },
        { id: 2, name: "Bob", character: "Villain", profile_path: null },
      ],
    }
    expect(extractCast(credits, 1)).toEqual([
      { name: "Alice", character: "Hero", profilePath: "/a.jpg", tmdbPersonId: 1 },
    ])
  })

  it("returns an empty array with no cast", () => {
    expect(extractCast(null)).toEqual([])
  })
})
