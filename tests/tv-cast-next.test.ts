import { describe, it, expect } from "vitest"
import {
  neighborChannelIndex,
  neighborEpisode,
  neighborAvailability,
  flattenSeriesEpisodes,
} from "@/scripts/lib/tv-cast-next"

describe("neighborChannelIndex", () => {
  it("wraps forward from the last channel back to the first", () => {
    expect(neighborChannelIndex({ channelIds: ["a", "b", "c"], index: 2 }, 1)).toBe(0)
  })

  it("wraps backward from the first channel to the last", () => {
    expect(neighborChannelIndex({ channelIds: ["a", "b", "c"], index: 0 }, -1)).toBe(2)
  })

  it("steps forward within the list without wrapping", () => {
    expect(neighborChannelIndex({ channelIds: ["a", "b", "c"], index: 0 }, 1)).toBe(1)
  })

  it("returns null for a single-channel context", () => {
    expect(neighborChannelIndex({ channelIds: ["a"], index: 0 }, 1)).toBeNull()
  })

  it("returns null for an empty channel list", () => {
    expect(neighborChannelIndex({ channelIds: [], index: 0 }, 1)).toBeNull()
  })
})

describe("neighborEpisode", () => {
  const episodes = [
    { season: 1, episodeNum: 1 },
    { season: 1, episodeNum: 2 },
    { season: 2, episodeNum: 1 },
    { season: 2, episodeNum: 2 },
  ]

  it("steps to the next episode within the same season", () => {
    expect(neighborEpisode(episodes, { season: 1, episodeNum: 1 }, 1)).toEqual({ season: 1, episodeNum: 2 })
  })

  it("crosses into the next season once the current season is exhausted", () => {
    expect(neighborEpisode(episodes, { season: 1, episodeNum: 2 }, 1)).toEqual({ season: 2, episodeNum: 1 })
  })

  it("crosses back into the previous season's last episode", () => {
    expect(neighborEpisode(episodes, { season: 2, episodeNum: 1 }, -1)).toEqual({ season: 1, episodeNum: 2 })
  })

  it("returns null past the series finale, without wrapping", () => {
    expect(neighborEpisode(episodes, { season: 2, episodeNum: 2 }, 1)).toBeNull()
  })

  it("returns null before the series premiere, without wrapping", () => {
    expect(neighborEpisode(episodes, { season: 1, episodeNum: 1 }, -1)).toBeNull()
  })

  it("returns null when the current episode isn't in the list", () => {
    expect(neighborEpisode(episodes, { season: 9, episodeNum: 9 }, 1)).toBeNull()
  })
})

describe("neighborAvailability", () => {
  it("is unavailable in both directions with no session", () => {
    expect(neighborAvailability(null)).toEqual({ previous: false, next: false })
  })

  it("is unavailable for a live context with only one channel", () => {
    const session: any = { liveContext: { playlistId: "p1", channelIds: ["a"], index: 0 } }
    expect(neighborAvailability(session)).toEqual({ previous: false, next: false })
  })

  it("is available for a live context with multiple channels", () => {
    const session: any = { liveContext: { playlistId: "p1", channelIds: ["a", "b"], index: 0 } }
    expect(neighborAvailability(session)).toEqual({ previous: true, next: true })
  })

  it("is optimistically available for a series context", () => {
    const session: any = { seriesContext: { playlistId: "p1", seriesId: "s1", season: 1, episodeNum: 1 } }
    expect(neighborAvailability(session)).toEqual({ previous: true, next: true })
  })

  it("is unavailable for a session with neither context", () => {
    const session: any = {}
    expect(neighborAvailability(session)).toEqual({ previous: false, next: false })
  })
})

describe("flattenSeriesEpisodes", () => {
  it("flattens a season-keyed episodes object", () => {
    const info = {
      episodes: {
        "1": [{ id: 10, episode_num: 1, container_extension: "mp4", title: "Pilot" }],
        "2": [{ id: 20, episode_num: 1, container_extension: "mkv", title: "S2E1" }],
      },
    }
    expect(flattenSeriesEpisodes(info)).toEqual([
      { season: 1, episodeNum: 1, id: 10, containerExt: "mp4", title: "Pilot" },
      { season: 2, episodeNum: 1, id: 20, containerExt: "mkv", title: "S2E1" },
    ])
  })

  it("flattens a flat episodes array, defaulting season 1 when unset", () => {
    const info = { episodes: [{ id: 5, episode_num: 3, container_extension: "mp4", title: "Ep 3" }] }
    expect(flattenSeriesEpisodes(info)).toEqual([{ season: 1, episodeNum: 3, id: 5, containerExt: "mp4", title: "Ep 3" }])
  })

  it("returns an empty list for missing or malformed episodes", () => {
    expect(flattenSeriesEpisodes(null)).toEqual([])
    expect(flattenSeriesEpisodes({})).toEqual([])
    expect(flattenSeriesEpisodes({ episodes: "nope" })).toEqual([])
  })
})
