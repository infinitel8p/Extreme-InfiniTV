import { describe, it, expect } from "vitest"
import {
  neighborChannelIndex,
  neighborEpisode,
  neighborAvailability,
  flattenSeriesEpisodes,
  shouldAutoAdvance,
  createAutoAdvanceTracker,
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

describe("shouldAutoAdvance", () => {
  const seriesSession: any = { seriesContext: { playlistId: "p1", seriesId: "s1", season: 1, episodeNum: 1 } }
  const liveSession: any = { liveContext: { playlistId: "p1", channelIds: ["a", "b"], index: 0 } }
  const seriesLiveFlagged: any = { ...seriesSession, isLive: true }

  it("is true for a series session moving to ended after playback was observed", () => {
    expect(shouldAutoAdvance(seriesSession, "ended", true)).toBe(true)
  })

  it("is false when no playback was observed yet (guards the stale-ended snapshot replay)", () => {
    expect(shouldAutoAdvance(seriesSession, "ended", false)).toBe(false)
  })

  it("is false for a non-ended state, even after playback", () => {
    expect(shouldAutoAdvance(seriesSession, "playing", true)).toBe(false)
    expect(shouldAutoAdvance(seriesSession, "paused", true)).toBe(false)
    expect(shouldAutoAdvance(seriesSession, "idle", true)).toBe(false)
  })

  it("is false for a session with no seriesContext", () => {
    expect(shouldAutoAdvance(liveSession, "ended", true)).toBe(false)
  })

  it("is false for a null session", () => {
    expect(shouldAutoAdvance(null, "ended", true)).toBe(false)
  })

  it("is false for a series session explicitly flagged live", () => {
    expect(shouldAutoAdvance(seriesLiveFlagged, "ended", true)).toBe(false)
  })
})

describe("createAutoAdvanceTracker", () => {
  const seriesSession: any = { seriesContext: { playlistId: "p1", seriesId: "s1", season: 1, episodeNum: 1 } }
  const liveSession: any = { liveContext: { playlistId: "p1", channelIds: ["a", "b"], index: 0 } }

  it("does not advance on the first frame after (re)connect, even if it's ended", () => {
    const tracker = createAutoAdvanceTracker()
    expect(tracker.observe(seriesSession, "ended")).toBe(false)
  })

  it("advances once playback was observed and the state moves to ended", () => {
    const tracker = createAutoAdvanceTracker()
    expect(tracker.observe(seriesSession, "playing")).toBe(false)
    expect(tracker.observe(seriesSession, "ended")).toBe(true)
  })

  it("advances after a paused frame too", () => {
    const tracker = createAutoAdvanceTracker()
    tracker.observe(seriesSession, "paused")
    expect(tracker.observe(seriesSession, "ended")).toBe(true)
  })

  it("dedupes repeated ended frames from WS/watchdog/poll overlap", () => {
    const tracker = createAutoAdvanceTracker()
    tracker.observe(seriesSession, "playing")
    expect(tracker.observe(seriesSession, "ended")).toBe(true)
    expect(tracker.observe(seriesSession, "ended")).toBe(false)
    expect(tracker.observe(seriesSession, "ended")).toBe(false)
  })

  it("resets the guard once a subsequent playing frame is observed (next episode started)", () => {
    const tracker = createAutoAdvanceTracker()
    tracker.observe(seriesSession, "playing")
    expect(tracker.observe(seriesSession, "ended")).toBe(true)
    tracker.observe(seriesSession, "playing")
    expect(tracker.observe(seriesSession, "ended")).toBe(true)
  })

  it("never advances a live session", () => {
    const tracker = createAutoAdvanceTracker()
    tracker.observe(liveSession, "playing")
    expect(tracker.observe(liveSession, "ended")).toBe(false)
  })

  it("never advances on an explicit stop, since that reports idle, not ended", () => {
    const tracker = createAutoAdvanceTracker()
    tracker.observe(seriesSession, "playing")
    expect(tracker.observe(seriesSession, "idle")).toBe(false)
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
