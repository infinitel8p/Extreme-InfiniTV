/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { TmdbTitleEnrichment } from "@/scripts/lib/tmdb-enrich.ts"

const cacheStore = new Map<string, { data: unknown; stale: boolean }>()
const setCachedMock = vi.fn((entryId: string, kind: string, data: unknown, _ttlMs: number) => {
  cacheStore.set(`${entryId}:${kind}`, { data, stale: false })
})
const getCachedMock = vi.fn((entryId: string, kind: string) => {
  const hit = cacheStore.get(`${entryId}:${kind}`)
  return hit ? { data: hit.data, stale: hit.stale } : null
})
const hydrateMock = vi.fn(async (_entryId: string, _kind: string) => {})
vi.mock("@/scripts/lib/cache.js", () => ({
  setCached: (...args: [string, string, unknown, number]) => setCachedMock(...args),
  getCached: (...args: [string, string]) => getCachedMock(...args),
  hydrate: (...args: [string, string]) => hydrateMock(...args),
}))

vi.mock("@/scripts/lib/i18n.js", () => ({ getActiveLocale: () => "en" }))

let tvdbEnabled = true
vi.mock("@/scripts/lib/app-settings.js", () => ({
  getTvdbEnabled: () => tvdbEnabled,
}))

vi.mock("@/scripts/lib/tmdb.ts", () => ({ tmdbLanguageFor: () => "en-US" }))

const fetchMovieEnrichmentMock = vi.fn()
const fetchSeriesEnrichmentMock = vi.fn()
const resolveTmdbIdMock = vi.fn()
vi.mock("@/scripts/lib/tmdb-enrich.ts", () => ({
  fetchMovieEnrichment: (...args: unknown[]) => fetchMovieEnrichmentMock(...args),
  fetchSeriesEnrichment: (...args: unknown[]) => fetchSeriesEnrichmentMock(...args),
  resolveTmdbId: (...args: unknown[]) => resolveTmdbIdMock(...args),
}))

const tvdbEnrichmentMock = vi.fn()
const mergeTitleEnrichmentMock = vi.fn(
  (primary: TmdbTitleEnrichment | null, fallback: TmdbTitleEnrichment | null) => {
    if (!primary) return fallback
    if (!fallback) return primary
    return {
      ...primary,
      posterUrl: primary.posterUrl || fallback.posterUrl,
      logoUrl: primary.logoUrl || fallback.logoUrl,
      director: primary.director || fallback.director,
    }
  }
)
vi.mock("@/scripts/lib/tvdb-proxy.ts", () => ({
  tvdbEnrichment: (...args: unknown[]) => tvdbEnrichmentMock(...args),
  mergeTitleEnrichment: (...args: [TmdbTitleEnrichment | null, TmdbTitleEnrichment | null]) =>
    mergeTitleEnrichmentMock(...args),
}))

import {
  resolveTitleEnrichment,
  resolveTitleEnrichmentDetailed,
  peekTitleEnrichment,
  peekTitleEnrichmentDetailed,
  peekEarlyTitleEnrichment,
  withTvdbConcurrencyLimit,
} from "@/scripts/lib/enrichment"

function makeEnrichment(overrides: Partial<TmdbTitleEnrichment> = {}): TmdbTitleEnrichment {
  return {
    tmdbId: 0,
    title: "Title",
    overview: "Overview",
    posterUrl: null,
    backdropUrl: null,
    logoUrl: null,
    bannerUrl: null,
    director: null,
    directorPersonId: null,
    cast: [],
    trailerYoutubeKey: null,
    recommendations: [],
    voteAverage: 0,
    genres: [],
    tagline: null,
    year: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheStore.clear()
  tvdbEnabled = true
})

describe("resolveTitleEnrichment", () => {
  it("puts TVDB first and lets TMDb gap-fill only what TVDB is missing", async () => {
    tvdbEnrichmentMock.mockResolvedValue({
      enrichment: makeEnrichment({ posterUrl: "https://tvdb/p", logoUrl: null, director: null }),
      tvdbId: 42,
    })
    resolveTmdbIdMock.mockResolvedValue(65942)
    fetchMovieEnrichmentMock.mockResolvedValue(
      makeEnrichment({ tmdbId: 65942, posterUrl: "https://tmdb/p", logoUrl: "https://tmdb/logo", director: "Someone" })
    )

    const result = await resolveTitleEnrichment({
      kind: "movie",
      playlistId: "p1",
      itemId: "i1",
      name: "X",
      year: 2020,
    })

    expect(result?.posterUrl).toBe("https://tvdb/p")
    expect(result?.logoUrl).toBe("https://tmdb/logo")
    expect(result?.director).toBe("Someone")
    expect(setCachedMock).toHaveBeenCalledWith(
      "tmdb",
      "enriched_movie_65942:en-US:v1",
      expect.anything(),
      expect.any(Number)
    )
    expect(setCachedMock).toHaveBeenCalledWith(
      "tmdb",
      "tmdb_match_vod_p1_i1:en-US",
      { tmdbId: 65942 },
      expect.any(Number)
    )
    // TVDB is the base (first arg); TMDb is the gap-fill fallback (second arg).
    const [primaryArg, fallbackArg] = mergeTitleEnrichmentMock.mock.calls[0]
    expect(primaryArg?.posterUrl).toBe("https://tvdb/p")
    expect(fallbackArg?.tmdbId).toBe(65942)
  })

  it("behaves like today's TMDb-only path when TVDB is disabled", async () => {
    tvdbEnabled = false
    resolveTmdbIdMock.mockResolvedValue(111)
    const tmdbOnly = makeEnrichment({ tmdbId: 111, title: "TMDb only" })
    fetchMovieEnrichmentMock.mockResolvedValue(tmdbOnly)

    const result = await resolveTitleEnrichment({
      kind: "movie",
      playlistId: "p1",
      itemId: "i2",
      name: "Y",
    })

    expect(tvdbEnrichmentMock).not.toHaveBeenCalled()
    expect(result).toBe(tmdbOnly)
  })

  it("falls back to the TVDB-only cache namespace when no TMDb id ever resolves", async () => {
    const tvdbOnly = makeEnrichment({ title: "TVDB only" })
    tvdbEnrichmentMock.mockResolvedValue({ enrichment: tvdbOnly, tvdbId: 77 })
    resolveTmdbIdMock.mockResolvedValue(null)

    const result = await resolveTitleEnrichment({
      kind: "series",
      playlistId: "p1",
      itemId: "i3",
      name: "Z",
    })

    expect(result).toBe(tvdbOnly)
    expect(setCachedMock).toHaveBeenCalledWith(
      "tmdb",
      "tvdb_series_77:en-US:v1",
      tvdbOnly,
      expect.any(Number)
    )
    expect(setCachedMock).toHaveBeenCalledWith(
      "tmdb",
      "tvdb_match_series_p1_i3:en-US",
      { tvdbId: 77 },
      expect.any(Number)
    )
    expect(setCachedMock).not.toHaveBeenCalledWith("tmdb", expect.stringMatching(/^tmdb_series_/), expect.anything(), expect.anything())
  })

  it("returns null when neither source resolves anything", async () => {
    tvdbEnrichmentMock.mockResolvedValue(null)
    resolveTmdbIdMock.mockResolvedValue(null)

    const result = await resolveTitleEnrichment({
      kind: "movie",
      playlistId: "p1",
      itemId: "i4",
      name: "Nothing",
    })

    expect(result).toBeNull()
    expect(setCachedMock).not.toHaveBeenCalled()
  })
})

describe("peekTitleEnrichment", () => {
  it("delegates to the merged enriched cache first, via the tmdb match cache", async () => {
    const cached = makeEnrichment({ title: "Cached" })
    cacheStore.set("tmdb:tmdb_match_vod_p1_i1:en-US", { data: { tmdbId: 65942 }, stale: false })
    cacheStore.set("tmdb:enriched_movie_65942:en-US:v1", { data: cached, stale: false })

    const result = await peekTitleEnrichment("movie", "p1", "i1")

    expect(result).toEqual(cached)
  })

  it("falls back to the tvdb-only namespace via its own match cache", async () => {
    const tvdbOnly = makeEnrichment({ title: "TVDB only" })
    cacheStore.set("tmdb:tvdb_match_movie_p1_i1:en-US", { data: { tvdbId: 99 }, stale: false })
    cacheStore.set("tmdb:tvdb_movie_99:en-US:v1", { data: tvdbOnly, stale: false })

    const result = await peekTitleEnrichment("movie", "p1", "i1")

    expect(result).toEqual(tvdbOnly)
  })

  it("returns null when neither namespace has anything cached", async () => {
    expect(await peekTitleEnrichment("movie", "p1", "i1")).toBeNull()
  })
})

describe("peekTitleEnrichmentDetailed", () => {
  it("surfaces the tmdbId alongside the enriched cache hit", async () => {
    const cached = makeEnrichment({ title: "Cached" })
    cacheStore.set("tmdb:tmdb_match_vod_p1_i1:en-US", { data: { tmdbId: 65942 }, stale: false })
    cacheStore.set("tmdb:enriched_movie_65942:en-US:v1", { data: cached, stale: false })

    const result = await peekTitleEnrichmentDetailed("movie", "p1", "i1")

    expect(result).toEqual({ enrichment: cached, tmdbId: 65942, tvdbId: null })
  })

  it("surfaces the tvdbId when only the tvdb-only namespace has a hit", async () => {
    const tvdbOnly = makeEnrichment({ title: "TVDB only" })
    cacheStore.set("tmdb:tvdb_match_movie_p1_i1:en-US", { data: { tvdbId: 99 }, stale: false })
    cacheStore.set("tmdb:tvdb_movie_99:en-US:v1", { data: tvdbOnly, stale: false })

    const result = await peekTitleEnrichmentDetailed("movie", "p1", "i1")

    expect(result).toEqual({ enrichment: tvdbOnly, tmdbId: null, tvdbId: 99 })
  })
})

describe("resolveTitleEnrichmentDetailed", () => {
  it("surfaces both resolved ids next to the merged enrichment", async () => {
    tvdbEnrichmentMock.mockResolvedValue({
      enrichment: makeEnrichment({ posterUrl: "https://tvdb/p" }),
      tvdbId: 42,
    })
    resolveTmdbIdMock.mockResolvedValue(65942)
    fetchMovieEnrichmentMock.mockResolvedValue(makeEnrichment({ tmdbId: 65942 }))

    const result = await resolveTitleEnrichmentDetailed({
      kind: "movie",
      playlistId: "p1",
      itemId: "i1",
      name: "X",
    })

    expect(result?.tmdbId).toBe(65942)
    expect(result?.tvdbId).toBe(42)
    expect(result?.enrichment.posterUrl).toBe("https://tvdb/p")
  })

  it("returns null when neither source resolves anything", async () => {
    tvdbEnrichmentMock.mockResolvedValue(null)
    resolveTmdbIdMock.mockResolvedValue(null)

    const result = await resolveTitleEnrichmentDetailed({
      kind: "movie",
      playlistId: "p1",
      itemId: "i1",
      name: "Nothing",
    })

    expect(result).toBeNull()
  })

  it("prefers TMDb's localized genres even when TMDb has no billed cast", async () => {
    tvdbEnrichmentMock.mockResolvedValue({
      enrichment: makeEnrichment({ genres: ["Drama"] }),
      tvdbId: 42,
    })
    resolveTmdbIdMock.mockResolvedValue(65942)
    fetchMovieEnrichmentMock.mockResolvedValue(
      makeEnrichment({ tmdbId: 65942, genres: ["Action"], cast: [] })
    )

    const result = await resolveTitleEnrichmentDetailed({
      kind: "movie",
      playlistId: "p1",
      itemId: "i1",
      name: "X",
    })

    expect(result?.enrichment.genres).toEqual(["Action"])
  })
})

describe("peekEarlyTitleEnrichment", () => {
  it("combines the cached enrichment with the provider info probe", async () => {
    const tvdbOnly = makeEnrichment({ title: "TVDB only" })
    cacheStore.set("tmdb:tvdb_match_movie_p1_i1:en-US", { data: { tvdbId: 99 }, stale: false })
    cacheStore.set("tmdb:tvdb_movie_99:en-US:v1", { data: tvdbOnly, stale: false })
    cacheStore.set("p1:vod_info_i1", { data: { name: "Provider Name" }, stale: false })

    const result = await peekEarlyTitleEnrichment("movie", "p1", "i1", "p1", "vod_info_i1")

    expect(result.enrichment).toEqual(tvdbOnly)
    expect(result.tvdbId).toBe(99)
    expect(result.tmdbId).toBeNull()
    expect(result.providerInfo).toEqual({ data: { name: "Provider Name" }, stale: false })
  })

  it("returns nulls when nothing is cached", async () => {
    const result = await peekEarlyTitleEnrichment("movie", "p1", "i1", "p1", "vod_info_i1")

    expect(result).toEqual({ enrichment: null, tmdbId: null, tvdbId: null, providerInfo: null })
  })
})

describe("withTvdbConcurrencyLimit", () => {
  function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  it("runs at most 3 tasks concurrently, backfilling from the queue as slots free up", async () => {
    let active = 0
    let maxActive = 0
    let started = 0
    const releases: Array<() => void> = []
    function makeTask() {
      return withTvdbConcurrencyLimit(
        () =>
          new Promise<void>((resolve) => {
            started++
            active++
            maxActive = Math.max(maxActive, active)
            releases.push(() => {
              active--
              resolve()
            })
          })
      )
    }

    const tasks = [makeTask(), makeTask(), makeTask(), makeTask(), makeTask(), makeTask()]
    await tick()
    await tick()

    expect(maxActive).toBeLessThanOrEqual(3)
    expect(started).toBe(3)

    releases.shift()!()
    await tick()
    await tick()
    expect(started).toBe(4)
    expect(maxActive).toBeLessThanOrEqual(3)

    // Draining releases a batch at a time; each batch needs a tick before the
    // backfilled task actually pushes its own release onto the array.
    for (let round = 0; round < 10; round++) {
      while (releases.length) releases.shift()!()
      if (started >= 6 && releases.length === 0) break
      await tick()
    }
    await Promise.all(tasks)
    expect(started).toBe(6)
    expect(maxActive).toBeLessThanOrEqual(3)
  })
})
