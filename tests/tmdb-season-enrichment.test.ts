/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const tmdbTvSeasonMock = vi.fn()
const tmdbTvEpisodeGroupsMock = vi.fn()
const tmdbEpisodeGroupMock = vi.fn()

vi.mock("@/scripts/lib/tmdb.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/tmdb")>()
  return {
    ...actual,
    tmdbTvSeason: (...args: unknown[]) => tmdbTvSeasonMock(...args),
    tmdbTvEpisodeGroups: (...args: unknown[]) => tmdbTvEpisodeGroupsMock(...args),
    tmdbEpisodeGroup: (...args: unknown[]) => tmdbEpisodeGroupMock(...args),
  }
})

vi.mock("@/scripts/lib/cache.js", () => ({
  cachedFetch: async (_entryId: string, _kind: string, _ttl: number, fetcher: () => Promise<unknown>) => ({
    data: await fetcher(),
    stale: false,
  }),
  hydrate: async () => {},
  getCached: () => null,
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getTmdbApiKey: () => "test-key",
  isTmdbActive: () => true,
  getUserAgent: () => "",
  getNetworkTimeoutSeconds: () => 15,
  getGlobalDns: () => null,
  DNS_EVENT: "xt:dns-changed",
}))

vi.mock("@/scripts/lib/i18n.js", () => ({
  getActiveLocale: () => "de",
}))

import { TmdbHttpError } from "@/scripts/lib/tmdb"
import { fetchSeasonEnrichment } from "@/scripts/lib/tmdb-enrich"

// TMDb 65942: the whole run filed under season 1, 85 episodes.
function flatSeasonOne() {
  return {
    episodes: Array.from({ length: 85 }, (_, index) => ({
      episode_number: index + 1,
      name: `Flat ${index + 1}`,
      overview: `Plot ${index + 1}`,
      still_path: `/still${index + 1}.jpg`,
    })),
  }
}

function groupPart(from: number, count: number, name: string, order: number) {
  return {
    name,
    order,
    episodes: Array.from({ length: count }, (_, index) => ({
      season_number: 1,
      episode_number: from + index,
      order: from + index,
    })),
  }
}

const seasonsGroup = {
  id: "641eb9d6b234b9007ac67063",
  groups: [
    { name: "Specials", order: 0, episodes: [{ season_number: 0, episode_number: 1 }] },
    groupPart(1, 25, "Season 1", 1),
    groupPart(26, 25, "Season 2", 2),
    groupPart(51, 16, "Season 3", 3),
    groupPart(67, 19, "Season 4", 4),
  ],
}

const REZERO_PROVIDER_SEASONS = [
  { season: 1, episodeNumbers: Array.from({ length: 25 }, (_, index) => index + 1) },
  { season: 2, episodeNumbers: Array.from({ length: 25 }, (_, index) => index + 1) },
  { season: 3, episodeNumbers: Array.from({ length: 16 }, (_, index) => index + 1) },
  { season: 4, episodeNumbers: Array.from({ length: 11 }, (_, index) => index + 1) },
]

beforeEach(() => {
  vi.clearAllMocks()
  tmdbTvSeasonMock.mockImplementation(async (_key: string, _id: number, seasonNumber: number) => {
    if (seasonNumber !== 1) throw new TmdbHttpError(404, "Not found on TMDb")
    return flatSeasonOne()
  })
  tmdbTvEpisodeGroupsMock.mockResolvedValue({
    results: [
      { id: "unmatched", name: "Story Arc", group_count: 5, episode_count: 66 },
      { id: seasonsGroup.id, name: "Seasons (Produktion)", group_count: 5, episode_count: 162 },
    ],
  })
  tmdbEpisodeGroupMock.mockImplementation(async (_key: string, groupId: string) => {
    if (groupId === seasonsGroup.id) return seasonsGroup
    return { groups: [groupPart(1, 7, "Arc 1", 1)] }
  })
})

describe("fetchSeasonEnrichment season mapping", () => {
  it("serves a season TMDb has natively without touching episode groups", async () => {
    const result = await fetchSeasonEnrichment(65942, 1, { providerSeasons: REZERO_PROVIDER_SEASONS })
    expect(result?.episodes).toHaveLength(85)
    expect(result?.episodes[0]).toEqual({
      episodeNumber: 1,
      name: "Flat 1",
      overview: "Plot 1",
      stillUrl: expect.stringContaining("/still1.jpg"),
    })
    expect(tmdbTvEpisodeGroupsMock).not.toHaveBeenCalled()
  })

  it("maps a 404 season through the group and renumbers into provider space", async () => {
    const result = await fetchSeasonEnrichment(65942, 2, { providerSeasons: REZERO_PROVIDER_SEASONS })
    expect(result?.episodes).toHaveLength(25)
    // Provider S02E01 is TMDb S01E26.
    expect(result?.episodes[0]).toEqual({
      episodeNumber: 1,
      name: "Flat 26",
      overview: "Plot 26",
      stillUrl: expect.stringContaining("/still26.jpg"),
    })
    expect(result?.episodes.at(-1)).toMatchObject({ episodeNumber: 25, name: "Flat 50" })
  })

  it("maps a partially published last season without overrunning", async () => {
    const result = await fetchSeasonEnrichment(65942, 4, { providerSeasons: REZERO_PROVIDER_SEASONS })
    expect(result?.episodes).toHaveLength(11)
    expect(result?.episodes[0]).toMatchObject({ episodeNumber: 1, name: "Flat 67" })
    expect(result?.episodes.at(-1)).toMatchObject({ episodeNumber: 11, name: "Flat 77" })
  })

  it("returns empty rather than a wrong mapping when a provider season is incomplete", async () => {
    const result = await fetchSeasonEnrichment(65942, 2, {
      providerSeasons: [
        { season: 1, episodeNumbers: Array.from({ length: 13 }, (_, index) => index + 1) },
        { season: 2, episodeNumbers: Array.from({ length: 25 }, (_, index) => index + 1) },
        { season: 3, episodeNumbers: Array.from({ length: 16 }, (_, index) => index + 1) },
        { season: 4, episodeNumbers: Array.from({ length: 13 }, (_, index) => index + 1) },
      ],
    })
    expect(result?.episodes).toEqual([])
  })

  it("returns empty when no provider season shape is supplied", async () => {
    const result = await fetchSeasonEnrichment(65942, 2)
    expect(result?.episodes).toEqual([])
    expect(tmdbTvEpisodeGroupsMock).not.toHaveBeenCalled()
  })

  it("fetches the underlying TMDb season once for a mapped season", async () => {
    await fetchSeasonEnrichment(65942, 3, { providerSeasons: REZERO_PROVIDER_SEASONS })
    const seasonOneCalls = tmdbTvSeasonMock.mock.calls.filter((call) => call[2] === 1)
    expect(seasonOneCalls).toHaveLength(1)
  })

  it("keeps a non-404 failure uncached and reported as null", async () => {
    tmdbTvSeasonMock.mockRejectedValue(new TmdbHttpError(500, "TMDb is down"))
    const result = await fetchSeasonEnrichment(65942, 2, { providerSeasons: REZERO_PROVIDER_SEASONS })
    expect(result).toBeNull()
    expect(tmdbTvEpisodeGroupsMock).not.toHaveBeenCalled()
  })
})
