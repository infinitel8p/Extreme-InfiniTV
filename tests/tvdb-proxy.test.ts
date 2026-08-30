/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

const cachedFetchMock = vi.fn()
vi.mock("@/scripts/lib/cache.js", () => ({
  cachedFetch: (...args: unknown[]) => cachedFetchMock(...args),
}))

vi.mock("@/scripts/lib/i18n.js", () => ({ getActiveLocale: () => "de" }))

import {
  enrichmentNeedsFill,
  fetchTvdbSeason,
  fetchTvdbTitle,
  findTvdbTitle,
  mergeTitleEnrichment,
  parseProviderTmdbId,
  resetTvdbProxyRateLimitForTests,
  tvdbEnrichment,
  tvdbTitleToEnrichment,
} from "@/scripts/lib/tvdb-proxy"

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTvdbProxyRateLimitForTests()
  cachedFetchMock.mockImplementation(async (_id, _kind, _ttl, fetcher) => ({
    data: await fetcher(),
    stale: false,
  }))
})

describe("parseProviderTmdbId", () => {
  it.each([
    [{ tmdb: 65942 }, 65942],
    [{ tmdb: "65942" }, 65942],
    [{ tmdb_id: "65942" }, 65942],
    [{ tmdb: " 65942 " }, 65942],
  ])("reads %s", (record, expected) => {
    expect(parseProviderTmdbId(record)).toBe(expected)
  })

  it.each([
    [{ tmdb: "0" }],
    [{ tmdb: "" }],
    [{ tmdb: null }],
    [{ tmdb: "abc" }],
    [{ tmdb: -5 }],
    [{ tmdb: 1.5 }],
    [{}],
    [null],
    ["nope"],
  ])("rejects %s", (record) => {
    expect(parseProviderTmdbId(record)).toBeNull()
  })
})

describe("fetchTvdbTitle", () => {
  it("requests the title route with the active locale mapped to a TheTVDB code", async () => {
    providerFetchMock.mockResolvedValue(
      jsonResponse({ v: 1, source: "thetvdb", ageSeconds: 0, data: { tvdbId: 305089, title: "Re:ZERO" } })
    )
    const title = await fetchTvdbTitle(65942, "series")
    expect(title?.tvdbId).toBe(305089)
    const [url, init] = providerFetchMock.mock.calls[0]
    expect(url).toContain("/v1/title?tmdb=65942&kind=series&lang=deu")
    expect(init.logKind).toBe("api")
  })

  it("returns null for a null payload without throwing", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, source: "thetvdb", ageSeconds: 0, data: null }))
    expect(await fetchTvdbTitle(1, "series")).toBeNull()
  })

  it("returns null on a non-ok response", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({}, false, 502))
    expect(await fetchTvdbTitle(1, "series")).toBeNull()
  })

  it("returns null when the contract version does not match", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 99, data: { tvdbId: 1 } }))
    expect(await fetchTvdbTitle(1, "series")).toBeNull()
  })

  it("returns null when the request throws", async () => {
    providerFetchMock.mockRejectedValue(new Error("network down"))
    expect(await fetchTvdbTitle(1, "series")).toBeNull()
  })
})

function rateLimited(retryAfter: string) {
  return { ok: false, status: 429, headers: { get: () => retryAfter }, json: async () => ({}) }
}

describe("429 rate limiting", () => {
  it("retries once after a short Retry-After and returns the fresh answer", async () => {
    vi.useFakeTimers()
    try {
      providerFetchMock
        .mockResolvedValueOnce(rateLimited("1"))
        .mockResolvedValueOnce(jsonResponse({ v: 1, data: { tvdbId: 1, title: "X" } }))
      const pending = fetchTvdbTitle(1, "series")
      await vi.advanceTimersByTimeAsync(1000)
      expect((await pending)?.title).toBe("X")
      expect(providerFetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up without retrying when Retry-After exceeds the bounded wait", async () => {
    providerFetchMock.mockResolvedValue(rateLimited("30"))
    expect(await fetchTvdbTitle(1, "series")).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })

  it("backs off every further call once a 429 sets the cooldown", async () => {
    providerFetchMock.mockResolvedValue(rateLimited("30"))
    expect(await fetchTvdbTitle(1, "series")).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)

    // A different id/kind would normally be a distinct request; the cooldown blocks it too.
    expect(await fetchTvdbTitle(2, "movie")).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })

  it("memoizes a failed path briefly so a repeat call doesn't re-hit it", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({}, false, 502))
    expect(await fetchTvdbTitle(1, "series")).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)

    expect(await fetchTvdbTitle(1, "series")).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("fetchTvdbSeason", () => {
  it("defaults to the official ordering", async () => {
    providerFetchMock.mockResolvedValue(
      jsonResponse({ v: 1, source: "thetvdb", ageSeconds: 0, data: { seasonNumber: 2, order: "official", episodes: [] } })
    )
    await fetchTvdbSeason({ tmdbId: 65942 }, 2)
    expect(providerFetchMock.mock.calls[0][0]).toContain("season=2&order=official&lang=deu")
  })

  it("passes an explicit ordering through", async () => {
    providerFetchMock.mockResolvedValue(
      jsonResponse({ v: 1, source: "thetvdb", ageSeconds: 0, data: { seasonNumber: 1, order: "absolute", episodes: [] } })
    )
    await fetchTvdbSeason({ tmdbId: 65942 }, 1, "absolute")
    expect(providerFetchMock.mock.calls[0][0]).toContain("order=absolute")
  })

  it("keys the cache per id, season, order and language", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, data: null }))
    await fetchTvdbSeason({ tmdbId: 65942 }, 2, "official")
    await fetchTvdbSeason({ tmdbId: 65942 }, 3, "official")
    await fetchTvdbSeason({ tmdbId: 65942 }, 2, "absolute")
    const kinds = cachedFetchMock.mock.calls.map((call) => call[1])
    expect(new Set(kinds).size).toBe(3)
    expect(kinds[0]).toBe("tvdb_season_tmdb=65942_2_official:deu")
  })
})

describe("tvdbTitleToEnrichment", () => {
  const title = {
    tvdbId: 305089,
    title: "Re:ZERO",
    overview: "Plot",
    posterUrl: "https://artworks.thetvdb.com/p.jpg",
    backdropUrl: "https://artworks.thetvdb.com/b.jpg",
    logoUrl: null,
    bannerUrl: null,
    cast: [{ name: "Yusuke Kobayashi", character: "Subaru", profileUrl: "https://artworks.thetvdb.com/a.jpg" }],
    genres: ["Animation"],
    year: 2016,
    status: "continuing" as const,
    trailerYoutubeKey: "dQw4w9WgXcQ",
  }

  it("produces the shape the detail pages already render", () => {
    const enrichment = tvdbTitleToEnrichment(title, 65942)
    expect(enrichment.tmdbId).toBe(65942)
    expect(enrichment.posterUrl).toBe("https://artworks.thetvdb.com/p.jpg")
    expect(enrichment.genres).toEqual(["Animation"])
    expect(enrichment.recommendations).toEqual([])
    expect(enrichment.director).toBeNull()
    expect(enrichment.logoUrl).toBeNull()
    // TheTVDB score is popularity; passing it through showed a fabricated 10.0.
    expect(enrichment.voteAverage).toBe(0)
  })

  it("maps cast so the card renders non-interactive without a TMDb person id", () => {
    const member = tvdbTitleToEnrichment(title, 1).cast[0]
    expect(member.profilePath).toBe("https://artworks.thetvdb.com/a.jpg")
    expect(member.tmdbPersonId).toBeFalsy()
  })

  it("carries a resolved logo artwork through", () => {
    const enrichment = tvdbTitleToEnrichment({ ...title, logoUrl: "https://artworks.thetvdb.com/logo.png" }, 1)
    expect(enrichment.logoUrl).toBe("https://artworks.thetvdb.com/logo.png")
  })

  it("carries a resolved banner artwork through", () => {
    const enrichment = tvdbTitleToEnrichment({ ...title, bannerUrl: "https://artworks.thetvdb.com/banner.png" }, 1)
    expect(enrichment.bannerUrl).toBe("https://artworks.thetvdb.com/banner.png")
  })

  it("defaults bannerUrl to null for an envelope from before it existed", () => {
    const enrichment = tvdbTitleToEnrichment(title, 1)
    expect(enrichment.bannerUrl).toBeNull()
  })
})

describe("findTvdbTitle", () => {
  it("strips provider noise off the query and hashes the name into the cache key", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, data: { tvdbId: 1, title: "X" } }))
    await findTvdbTitle("DE - Breaking Bad (2008)", "series", 2008)
    const [url] = providerFetchMock.mock.calls[0]
    expect(url).toContain("/v1/find?name=Breaking%20Bad")
    expect(url).toContain("&year=2008")
    expect(cachedFetchMock.mock.calls[0][1]).not.toContain("Breaking")
  })

  it("takes the year out of the title when none is supplied", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, data: { tvdbId: 1, title: "X" } }))
    await findTvdbTitle("Breaking Bad (2008)", "series")
    expect(providerFetchMock.mock.calls[0][0]).toContain("&year=2008")
  })

  it("skips the request entirely for an unusable name", async () => {
    expect(await findTvdbTitle("!", "series")).toBeNull()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("tries the next cleaned variant when an earlier one comes up empty", async () => {
    providerFetchMock
      .mockResolvedValueOnce(jsonResponse({ v: 1, data: null }))
      .mockResolvedValueOnce(jsonResponse({ v: 1, data: null }))
      .mockResolvedValueOnce(jsonResponse({ v: 1, data: { tvdbId: 9, title: "Found" } }))
    const title = await findTvdbTitle("DE - Breaking Bad (2008) [Extra]", "series", 2008)
    expect(title?.title).toBe("Found")
    expect(providerFetchMock.mock.calls.length).toBeGreaterThan(1)
    expect(providerFetchMock.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it("gives up after the same 3 variants the TMDb matcher tries", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, data: null }))
    expect(await findTvdbTitle("DE - Breaking Bad (2008) [Extra]", "series", 2008)).toBeNull()
    expect(providerFetchMock.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

describe("tvdbEnrichment", () => {
  it("looks up by name when there is no tmdb id", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, data: { tvdbId: 7, title: "Found", cast: [], genres: [] } }))
    const enrichment = (await tvdbEnrichment(null, "series", { name: "Breaking Bad", year: 2008 }))?.enrichment
    expect(enrichment?.title).toBe("Found")
    expect(providerFetchMock.mock.calls[0][0]).toContain("/v1/find")
  })

  it("falls back to a name lookup when the id lookup finds nothing", async () => {
    providerFetchMock
      .mockResolvedValueOnce(jsonResponse({ v: 1, data: null }))
      .mockResolvedValueOnce(jsonResponse({ v: 1, data: { tvdbId: 7, title: "Found", cast: [], genres: [] } }))
    const enrichment = (await tvdbEnrichment(65942, "series", { name: "Breaking Bad" }))?.enrichment
    expect(enrichment?.title).toBe("Found")
    expect(providerFetchMock.mock.calls[0][0]).toContain("/v1/title")
    expect(providerFetchMock.mock.calls[1][0]).toContain("/v1/find")
  })

  it("returns null when neither path resolves", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, data: null }))
    expect(await tvdbEnrichment(65942, "series", { name: "Nothing" })).toBeNull()
  })
})

describe("enrichmentNeedsFill", () => {
  const complete = {
    tmdbId: 1,
    title: "T",
    overview: "Plot",
    posterUrl: "https://p",
    backdropUrl: "https://b",
    logoUrl: null,
    bannerUrl: null,
    director: null,
    directorPersonId: null,
    cast: [{ name: "A", character: "C", profilePath: null, tmdbPersonId: 1 }],
    trailerYoutubeKey: "dQw4w9WgXcQ",
    recommendations: [],
    voteAverage: 8,
    genres: ["Drama"],
    tagline: null,
    year: 2016,
  }

  it("is false when nothing is missing", () => {
    expect(enrichmentNeedsFill(complete)).toBe(false)
  })

  it.each([
    ["null enrichment", null],
    ["no poster", { ...complete, posterUrl: null }],
    ["no overview", { ...complete, overview: "" }],
    ["untranslated overview", { ...complete, overviewIsFallback: true }],
    ["no cast", { ...complete, cast: [] }],
  ])("is true for a core gap: %s", (_label, enrichment) => {
    expect(enrichmentNeedsFill(enrichment as never)).toBe(true)
  })

  // These are commonly absent on TMDb, so triggering on them would put a network
  // round trip on nearly every detail open.
  it.each([
    ["no backdrop", { ...complete, backdropUrl: null }],
    ["no genres", { ...complete, genres: [] }],
    ["no trailer", { ...complete, trailerYoutubeKey: null }],
  ])("is false for a commonly-absent field: %s", (_label, enrichment) => {
    expect(enrichmentNeedsFill(enrichment as never)).toBe(false)
  })
})

describe("mergeTitleEnrichment", () => {
  const tmdb = {
    tmdbId: 65942,
    title: "TMDb title",
    overview: "TMDb plot",
    posterUrl: null,
    backdropUrl: "https://tmdb/b",
    logoUrl: "https://tmdb/logo",
    bannerUrl: null,
    director: "Someone",
    directorPersonId: 5,
    cast: [],
    trailerYoutubeKey: null,
    recommendations: [{ tmdbId: 2, title: "Rec", year: 2020 }],
    voteAverage: 0,
    genres: ["Drama"],
    tagline: "A tagline",
    year: null,
  }
  const tvdb = {
    ...tmdb,
    title: "TheTVDB title",
    overview: "TheTVDB plot",
    posterUrl: "https://tvdb/p",
    backdropUrl: "https://tvdb/b",
    logoUrl: null,
    bannerUrl: "https://tvdb/banner",
    director: null,
    directorPersonId: null,
    cast: [{ name: "Actor", character: "Role", profilePath: null, tmdbPersonId: 0 }],
    trailerYoutubeKey: "dQw4w9WgXcQ",
    recommendations: [],
    voteAverage: 8.4,
    genres: ["Animation"],
    tagline: null,
    year: 2016,
  }

  it("fills only the fields TMDb is missing", () => {
    const merged = mergeTitleEnrichment(tmdb, tvdb)!
    expect(merged.posterUrl).toBe("https://tvdb/p")
    expect(merged.cast).toHaveLength(1)
    expect(merged.trailerYoutubeKey).toBe("dQw4w9WgXcQ")
    expect(merged.voteAverage).toBe(8.4)
    expect(merged.year).toBe(2016)
    // TMDb never carries a banner, so TheTVDB's is the only candidate.
    expect(merged.bannerUrl).toBe("https://tvdb/banner")
  })

  it("never lets the fallback overwrite a value TMDb has", () => {
    const merged = mergeTitleEnrichment(tmdb, tvdb)!
    expect(merged.title).toBe("TMDb title")
    expect(merged.overview).toBe("TMDb plot")
    expect(merged.backdropUrl).toBe("https://tmdb/b")
    expect(merged.genres).toEqual(["Drama"])
    expect(merged.logoUrl).toBe("https://tmdb/logo")
    expect(merged.director).toBe("Someone")
    expect(merged.tagline).toBe("A tagline")
    expect(merged.recommendations).toHaveLength(1)
  })

  it("fills logoUrl, director, tagline and recommendations when the primary is missing them", () => {
    // Reversed roles: this is the shape resolveTitleEnrichment uses (TVDB
    // primary/base, TMDb fallback/gap-fill).
    const primary = { ...tvdb, logoUrl: null, director: null, directorPersonId: null, tagline: null, recommendations: [] }
    const fallback = tmdb
    const merged = mergeTitleEnrichment(primary, fallback)!
    expect(merged.logoUrl).toBe("https://tmdb/logo")
    expect(merged.director).toBe("Someone")
    expect(merged.directorPersonId).toBe(5)
    expect(merged.tagline).toBe("A tagline")
    expect(merged.recommendations).toHaveLength(1)
  })

  it("prefers a localized fallback overview over an untranslated TMDb one", () => {
    const merged = mergeTitleEnrichment({ ...tmdb, overviewIsFallback: true }, tvdb)!
    expect(merged.overview).toBe("TheTVDB plot")
    expect(merged.overviewIsFallback).toBe(false)
  })

  it.each([
    ["no primary", null, "TheTVDB title"],
    ["no fallback", "primary", "TMDb title"],
  ])("passes through with %s", (_label, mode, expected) => {
    const merged = mode === null ? mergeTitleEnrichment(null, tvdb) : mergeTitleEnrichment(tmdb, null)
    expect(merged?.title).toBe(expected)
  })

  it("returns null when neither side has anything", () => {
    expect(mergeTitleEnrichment(null, null)).toBeNull()
  })

  it("prefers the side with real TMDb cast ids for cast and genres, even as the fallback", () => {
    const tvdbPrimary = {
      ...tvdb,
      cast: [{ name: "TVDB Actor", character: "Role", profilePath: null, tmdbPersonId: 0 }],
      genres: ["Animation"],
    }
    const tmdbFallback = {
      ...tmdb,
      cast: [{ name: "TMDb Actor", character: "Role", profilePath: "https://tmdb/a", tmdbPersonId: 42 }],
      genres: ["Drama"],
    }
    const merged = mergeTitleEnrichment(tvdbPrimary, tmdbFallback)!
    expect(merged.cast).toEqual(tmdbFallback.cast)
    expect(merged.genres).toEqual(["Drama"])
  })
})

describe("failure is not a no-match", () => {
  it("does not fall through to a name search when the id lookup errors", async () => {
    providerFetchMock.mockRejectedValue(new Error("network blip"))
    expect(await tvdbEnrichment(65942, "series", { name: "Breaking Bad" })).toBeNull()
    // One attempt only: a blip must not stamp another work's artwork on this id.
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })

  it("still falls through when the id lookup definitively has no match", async () => {
    providerFetchMock
      .mockResolvedValueOnce(jsonResponse({ v: 1, data: null }))
      .mockResolvedValueOnce(jsonResponse({ v: 1, data: { tvdbId: 7, title: "Found", cast: [], genres: [] } }))
    const result = await tvdbEnrichment(65942, "series", { name: "Breaking Bad" })
    expect(result?.enrichment.title).toBe("Found")
    expect(result?.tvdbId).toBe(7)
  })
})

describe("fetchTvdbSeason id selection", () => {
  it("prefers a tvdb id, which is all a name match resolves", async () => {
    providerFetchMock.mockResolvedValue(jsonResponse({ v: 1, data: { seasonNumber: 1, order: "official", episodes: [] } }))
    await fetchTvdbSeason({ tvdbId: 305089, tmdbId: 65942 }, 1)
    expect(providerFetchMock.mock.calls[0][0]).toContain("tvdb=305089")
    expect(providerFetchMock.mock.calls[0][0]).not.toContain("tmdb=")
  })

  it("makes no request when neither id is present", async () => {
    expect(await fetchTvdbSeason({}, 1)).toBeNull()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })
})
