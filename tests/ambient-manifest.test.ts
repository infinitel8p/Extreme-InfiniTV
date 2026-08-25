import { describe, it, expect, beforeEach, vi } from "vitest"

function candidate(overrides: Partial<AmbientCandidate> = {}): AmbientCandidate {
  return {
    kind: "vod",
    id: "1",
    title: "Some Movie",
    posterUrl: "poster.jpg",
    backdropUrl: null,
    logoUrl: null,
    ...overrides,
  }
}

const noShuffle = () => 0

describe("assembleAmbientEntries", () => {
  it("orders tiers watching > recent > recommended > catalog", () => {
    const result = assembleAmbientEntries({
      watching: [candidate({ id: "1", title: "Watching" })],
      recent: [candidate({ id: "2", title: "Recent" })],
      recommended: [candidate({ id: "3", title: "Recommended" })],
      catalog: [candidate({ id: "4", title: "Catalog" })],
      limit: 50,
      random: noShuffle,
    })
    expect(result.map((entry) => entry.tier)).toEqual(["watching", "recent", "recommended", "catalog"])
    expect(result.map((entry) => entry.title)).toEqual(["Watching", "Recent", "Recommended", "Catalog"])
  })

  it("dedupes by kind+id, keeping the highest tier's data", () => {
    const result = assembleAmbientEntries({
      watching: [candidate({ id: "1", title: "Same Movie", posterUrl: "watching-poster.jpg" })],
      recent: [],
      recommended: [],
      catalog: [candidate({ id: "1", title: "Same Movie", posterUrl: "catalog-poster.jpg" })],
      limit: 50,
      random: noShuffle,
    })
    expect(result).toHaveLength(1)
    expect(result[0].tier).toBe("watching")
    expect(result[0].posterUrl).toBe("watching-poster.jpg")
  })

  it("drops entries with no artwork at all", () => {
    const result = assembleAmbientEntries({
      watching: [],
      recent: [],
      recommended: [],
      catalog: [
        candidate({ id: "1", posterUrl: null, backdropUrl: null, logoUrl: null }),
        candidate({ id: "2", posterUrl: "poster.jpg" }),
      ],
      limit: 50,
      random: noShuffle,
    })
    expect(result.map((entry) => entry.id)).toEqual(["2"])
  })

  it("drops entries with an empty title", () => {
    const result = assembleAmbientEntries({
      watching: [],
      recent: [],
      recommended: [],
      catalog: [candidate({ id: "1", title: "  " }), candidate({ id: "2", title: "Real Title" })],
      limit: 50,
      random: noShuffle,
    })
    expect(result.map((entry) => entry.id)).toEqual(["2"])
  })

  it("caps the result at limit", () => {
    const catalog = Array.from({ length: 10 }, (_, index) =>
      candidate({ id: String(index), title: `Title ${index}` })
    )
    const result = assembleAmbientEntries({
      watching: [],
      recent: [],
      recommended: [],
      catalog,
      limit: 3,
      random: noShuffle,
    })
    expect(result).toHaveLength(3)
  })

  it("shuffles recent/recommended/catalog deterministically with an injected random", () => {
    const catalog = [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })]
    const result = assembleAmbientEntries({
      watching: [],
      recent: [],
      recommended: [],
      catalog,
      limit: 50,
      random: () => 0,
    })
    expect(result.map((entry) => entry.id)).toEqual(["b", "c", "a"])
  })

  it("keeps watching in input order (no shuffle applied)", () => {
    const watching = [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })]
    const result = assembleAmbientEntries({
      watching,
      recent: [],
      recommended: [],
      catalog: [],
      limit: 50,
      random: () => 0.99,
    })
    expect(result.map((entry) => entry.id)).toEqual(["a", "b", "c"])
  })
})

// ---------------------------------------------------------------------------
// buildAmbientManifest: cache-only collector wiring.
// ---------------------------------------------------------------------------

let continueWatchingRows: any[] = []
let recentsByKind: Record<string, any[]> = { vod: [], series: [] }
let watchlistByKind: Record<string, Record<string, any>> = { vod: {}, series: {} }
let watchedSignals: any[] = []

vi.mock("@/scripts/lib/preferences.js", () => ({
  ensureLoaded: async () => {},
  getContinueWatching: (_playlistId: string, _limit: number) => continueWatchingRows,
  getRecents: (_playlistId: string, kind: string) => recentsByKind[kind] || [],
  getWatchlist: (_playlistId: string, kind: string) => watchlistByKind[kind] || {},
  getWatchedSignals: (_playlistId: string, _limit: number) => watchedSignals,
}))

let cachedByKind: Record<string, any[]> = {}
vi.mock("@/scripts/lib/cache.js", () => ({
  hydrate: async () => {},
  getCached: (_playlistId: string, kind: string) =>
    cachedByKind[kind] ? { data: cachedByKind[kind] } : null,
  getCachedByKindPrefix: async () => [],
}))

let tmdbActive = false
let resolvedTmdbId: number | null = 7
let fetchedBackdrop: string | null = "http://img/backdrop.jpg"
let inFlightFetches = 0
let peakInFlightFetches = 0
const resolveCalls: Array<{ kind: string; name: string; providerTmdbId: unknown; year: unknown }> = []

vi.mock("@/scripts/lib/app-settings.js", () => ({
  isTmdbActive: () => tmdbActive,
  ACCENT_PRESETS: ["fuchsia"],
}))

vi.mock("@/scripts/lib/tmdb-enrich.ts", () => ({
  getCachedTitleEnrichment: async () => null,
  resolveTmdbId: async (_playlistId: string, kind: string, providerEntry: any) => {
    resolveCalls.push({
      kind,
      name: providerEntry.name,
      providerTmdbId: providerEntry.providerTmdbId,
      year: providerEntry.year,
    })
    return resolvedTmdbId
  },
  fetchMovieEnrichment: async () => {
    inFlightFetches++
    peakInFlightFetches = Math.max(peakInFlightFetches, inFlightFetches)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlightFetches--
    return { backdropUrl: fetchedBackdrop }
  },
  fetchSeriesEnrichment: async () => ({ backdropUrl: fetchedBackdrop }),
}))

import {
  assembleAmbientEntries,
  buildAmbientManifest,
  type AmbientCandidate,
} from "@/scripts/lib/ambient-manifest.ts"

beforeEach(() => {
  continueWatchingRows = []
  recentsByKind = { vod: [], series: [] }
  watchlistByKind = { vod: {}, series: {} }
  watchedSignals = []
  cachedByKind = { vod: [], series: [] }
  tmdbActive = false
  resolvedTmdbId = 7
  fetchedBackdrop = "http://img/backdrop.jpg"
  inFlightFetches = 0
  peakInFlightFetches = 0
  resolveCalls.length = 0
})

describe("buildAmbientManifest backdrop fetching", () => {
  function seedCatalog(count: number) {
    cachedByKind = {
      vod: Array.from({ length: count }, (_unused, index) => ({
        id: index + 1,
        name: `Movie ${index + 1}`,
        logo: `http://img/poster${index + 1}.jpg`,
        year: 2020,
        tmdb: 500 + index,
      })),
      series: [],
    }
  }

  it("leaves entries bare when TMDb is not active", async () => {
    tmdbActive = false
    seedCatalog(3)
    const result = await buildAmbientManifest("pl1")
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((entry) => entry.backdropUrl === null)).toBe(true)
    expect(resolveCalls).toHaveLength(0)
  })

  it("fills a backdrop for every entry the cache peek left bare", async () => {
    tmdbActive = true
    seedCatalog(3)
    const result = await buildAmbientManifest("pl1")
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((entry) => entry.backdropUrl === "http://img/backdrop.jpg")).toBe(true)
  })

  it("passes the catalog row's tmdb id and year through to the match", async () => {
    tmdbActive = true
    seedCatalog(1)
    await buildAmbientManifest("pl1")
    expect(resolveCalls[0]).toMatchObject({ kind: "vod", name: "Movie 1", providerTmdbId: 500, year: 2020 })
  })

  it("keeps the poster untouched when no backdrop comes back", async () => {
    tmdbActive = true
    fetchedBackdrop = null
    seedCatalog(2)
    const result = await buildAmbientManifest("pl1")
    expect(result.every((entry) => entry.backdropUrl === null)).toBe(true)
    expect(result.every((entry) => !!entry.posterUrl)).toBe(true)
  })

  it("skips the detail fetch when no tmdb id resolves", async () => {
    tmdbActive = true
    resolvedTmdbId = null
    seedCatalog(2)
    const result = await buildAmbientManifest("pl1")
    expect(result.every((entry) => entry.backdropUrl === null)).toBe(true)
    expect(peakInFlightFetches).toBe(0)
  })

  it("bounds concurrent detail fetches", async () => {
    tmdbActive = true
    seedCatalog(30)
    await buildAmbientManifest("pl1")
    expect(peakInFlightFetches).toBeGreaterThan(0)
    expect(peakInFlightFetches).toBeLessThanOrEqual(6)
  })
})

describe("buildAmbientManifest", () => {
  it("returns an empty list without a playlist id", async () => {
    expect(await buildAmbientManifest("")).toEqual([])
  })

  it("maps a vod continue-watching row using catalog fallback for missing fields", async () => {
    cachedByKind.vod = [{ id: 1, name: "Movie A", logo: "movie-a.jpg" }]
    continueWatchingRows = [{ kind: "vod", id: "1", position: 10, duration: 100 }]

    const result = await buildAmbientManifest("pl1")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: "vod",
      id: "1",
      title: "Movie A",
      posterUrl: "movie-a.jpg",
      tier: "watching",
    })
  })

  it("collapses an episode row to its series entry, preferring row-level fields over catalog", async () => {
    cachedByKind.series = [{ id: 5, name: "Catalog Name", logo: "catalog-logo.jpg" }]
    continueWatchingRows = [
      { kind: "episode", id: "e1", seriesId: 5, seriesName: "Show B", seriesLogo: "show-b.jpg", position: 5, duration: 50 },
    ]

    const result = await buildAmbientManifest("pl1")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: "series",
      id: "5",
      title: "Show B",
      posterUrl: "show-b.jpg",
      tier: "watching",
    })
  })

  it("collapses two episode rows of the same series into a single entry", async () => {
    continueWatchingRows = [
      { kind: "episode", id: "e1", seriesId: 5, seriesName: "Show B", seriesLogo: "show-b.jpg", position: 5, duration: 50 },
      { kind: "episode", id: "e2", seriesId: 5, seriesName: "Show B", seriesLogo: "show-b.jpg", position: 3, duration: 40 },
    ]

    const result = await buildAmbientManifest("pl1")
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("5")
  })

  it("drops a continue-watching row whose title can't be resolved from the row or the catalog", async () => {
    continueWatchingRows = [{ kind: "vod", id: "99", position: 10, duration: 100 }]

    const result = await buildAmbientManifest("pl1")
    expect(result).toEqual([])
  })

  it("falls back to the catalog row's own title/poster for a bare catalog entry", async () => {
    cachedByKind.vod = [{ id: 7, name: "Only In Catalog", logo: "only.jpg" }]

    const result = await buildAmbientManifest("pl1")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: "vod", id: "7", title: "Only In Catalog", tier: "catalog" })
  })

  it("respects the limit option", async () => {
    cachedByKind.vod = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      name: `Movie ${index + 1}`,
      logo: `movie-${index + 1}.jpg`,
    }))

    const result = await buildAmbientManifest("pl1", { limit: 4 })
    expect(result).toHaveLength(4)
  })
})
