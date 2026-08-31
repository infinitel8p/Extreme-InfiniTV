import { describe, it, expect } from "vitest"
import {
  alignEpisodeGroup,
  providerSeasonFingerprint,
  providerSeasonsFromEpisodeMap,
  refsForSeason,
  usableProviderSeasons,
  type EpisodeGroupPart,
  type ProviderSeason,
} from "@/scripts/lib/tmdb-season-map"

function part(seasonNumber: number, from: number, count: number, name?: string): EpisodeGroupPart {
  return {
    name,
    episodes: Array.from({ length: count }, (_, index) => ({
      seasonNumber,
      episodeNumber: from + index,
    })),
  }
}

function providerSeason(season: number, count: number, startAt = 1): ProviderSeason {
  return { season, episodeNumbers: Array.from({ length: count }, (_, index) => startAt + index) }
}

// TMDb 65942 files Re:Zero's whole run as season 1; the "Seasons (Produktion)"
// group carries the broadcast split.
const REZERO_GROUP: EpisodeGroupPart[] = [
  part(0, 1, 77, "Specials"),
  part(1, 1, 25, "Season 1"),
  part(1, 26, 25, "Season 2"),
  part(1, 51, 16, "Season 3"),
  part(1, 67, 19, "Season 4"),
]

describe("alignEpisodeGroup", () => {
  it("maps a provider split that matches the group, last season still airing", () => {
    // Provider 47679: 25 / 25 / 16 / 11, season 4 partially published.
    const mapped = alignEpisodeGroup(REZERO_GROUP, [
      providerSeason(1, 25),
      providerSeason(2, 25),
      providerSeason(3, 16),
      providerSeason(4, 11),
    ])
    expect(mapped).not.toBeNull()
    expect(mapped!.map((entry) => entry.season)).toEqual([1, 2, 3, 4])
    expect(refsForSeason(mapped!, 2)[0]).toEqual({
      seasonNumber: 1,
      episodeNumber: 26,
      providerEpisodeNumber: 1,
    })
    expect(refsForSeason(mapped!, 3)[0].episodeNumber).toBe(51)
    expect(refsForSeason(mapped!, 4)).toHaveLength(11)
    expect(refsForSeason(mapped!, 4).at(-1)).toEqual({
      seasonNumber: 1,
      episodeNumber: 77,
      providerEpisodeNumber: 11,
    })
  })

  it("refuses a provider split whose earlier season is incomplete", () => {
    // Provider 20317: same show and TMDb id, but season 1 holds 13 of 25.
    expect(
      alignEpisodeGroup(REZERO_GROUP, [
        providerSeason(1, 13),
        providerSeason(2, 25),
        providerSeason(3, 16),
        providerSeason(4, 13),
      ])
    ).toBeNull()
  })

  it("skips specials parts when aligning", () => {
    const mapped = alignEpisodeGroup(REZERO_GROUP, [providerSeason(1, 25)])
    expect(refsForSeason(mapped!, 1)[0]).toEqual({
      seasonNumber: 1,
      episodeNumber: 1,
      providerEpisodeNumber: 1,
    })
  })

  it("allows fewer provider seasons than group parts", () => {
    const mapped = alignEpisodeGroup(REZERO_GROUP, [providerSeason(1, 25), providerSeason(2, 25)])
    expect(mapped).toHaveLength(2)
  })

  it("refuses when the provider has more seasons than the group has parts", () => {
    expect(
      alignEpisodeGroup([part(1, 1, 25), part(1, 26, 25)], [
        providerSeason(1, 25),
        providerSeason(2, 25),
        providerSeason(3, 16),
      ])
    ).toBeNull()
  })

  it("refuses when the last provider season overruns its part", () => {
    expect(alignEpisodeGroup([part(1, 1, 25), part(1, 26, 25)], [providerSeason(1, 25), providerSeason(2, 26)])).toBeNull()
  })

  it("respects part order over array order", () => {
    const shuffled: EpisodeGroupPart[] = [
      { ...part(1, 26, 25), order: 2 },
      { ...part(1, 1, 25), order: 1 },
    ]
    const mapped = alignEpisodeGroup(shuffled, [providerSeason(1, 25), providerSeason(2, 25)])
    expect(refsForSeason(mapped!, 1)[0].episodeNumber).toBe(1)
    expect(refsForSeason(mapped!, 2)[0].episodeNumber).toBe(26)
  })

  it("keeps the provider's own episode numbering", () => {
    const mapped = alignEpisodeGroup([part(1, 1, 25), part(1, 26, 3)], [
      providerSeason(1, 25),
      { season: 2, episodeNumbers: [26, 27, 28] },
    ])
    expect(refsForSeason(mapped!, 2)).toEqual([
      { seasonNumber: 1, episodeNumber: 26, providerEpisodeNumber: 26 },
      { seasonNumber: 1, episodeNumber: 27, providerEpisodeNumber: 27 },
      { seasonNumber: 1, episodeNumber: 28, providerEpisodeNumber: 28 },
    ])
  })

  it.each([
    ["no provider seasons", [] as ProviderSeason[]],
    ["specials only", [{ season: 0, episodeNumbers: [1, 2] }]],
    ["empty season", [{ season: 1, episodeNumbers: [] }]],
  ])("returns null for %s", (_label, seasons) => {
    expect(alignEpisodeGroup(REZERO_GROUP, seasons)).toBeNull()
  })

  it("returns null when the group has no usable parts", () => {
    expect(alignEpisodeGroup([part(0, 1, 12)], [providerSeason(1, 12)])).toBeNull()
  })
})

describe("usableProviderSeasons", () => {
  it("drops specials and empties, and sorts numerically", () => {
    const seasons = usableProviderSeasons([
      providerSeason(10, 2),
      { season: 0, episodeNumbers: [1] },
      { season: 2, episodeNumbers: [] },
      providerSeason(1, 3),
    ])
    expect(seasons.map((entry) => entry.season)).toEqual([1, 10])
  })
})

describe("providerSeasonsFromEpisodeMap", () => {
  it("reads season keys and episode numbers off an Xtream episode map", () => {
    const seasons = providerSeasonsFromEpisodeMap({
      "1": [{ episode_num: 1 }, { episode_num: 2 }],
      "2": [{ episode_num: 1 }],
    })
    expect(seasons).toEqual([
      { season: 1, episodeNumbers: [1, 2] },
      { season: 2, episodeNumbers: [1] },
    ])
  })

  it("falls back to position when episode_num is missing or unusable", () => {
    const seasons = providerSeasonsFromEpisodeMap({ "1": [{}, { episode_num: "x" }, null] })
    expect(seasons[0].episodeNumbers).toEqual([1, 2, 3])
  })

  it.each([[null], [undefined], ["nope"], [{ "1": "not an array" }]])(
    "returns an empty list for %s",
    (input) => {
      expect(providerSeasonsFromEpisodeMap(input)).toEqual([])
    }
  )
})

describe("providerSeasonFingerprint", () => {
  it("encodes season numbers and counts, ignoring specials", () => {
    expect(
      providerSeasonFingerprint([
        providerSeason(1, 25),
        providerSeason(2, 25),
        { season: 0, episodeNumbers: [1, 2] },
      ])
    ).toBe("1x25-2x25")
  })

  it("separates the two Re:Zero splits", () => {
    const first = providerSeasonFingerprint([providerSeason(1, 25), providerSeason(2, 25)])
    const second = providerSeasonFingerprint([providerSeason(1, 13), providerSeason(2, 25)])
    expect(first).not.toBe(second)
  })
})
