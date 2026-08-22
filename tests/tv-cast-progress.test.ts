import { describe, it, expect, beforeEach, vi } from "vitest"
import type { CastSession, CastState } from "@/scripts/lib/tv-cast"

const setProgressMock = vi.fn()
const markCompletedMock = vi.fn()
vi.mock("@/scripts/lib/preferences.js", () => ({
  ensureLoaded: async () => {},
  setProgress: (...args: unknown[]) => setProgressMock(...args),
  markCompleted: (...args: unknown[]) => markCompletedMock(...args),
}))

const requestSeriesInfoMock = vi.fn()
vi.mock("@/scripts/lib/series-seasons.js", () => ({
  requestSeriesInfo: (...args: unknown[]) => requestSeriesInfoMock(...args),
}))

import {
  isTrackableCastSession,
  hasSanePlaybackPosition,
  shouldThrottleWrite,
  isTerminalCastStateValue,
  castProgressTargetKey,
  createCastProgressRecorder,
  CAST_PROGRESS_WRITE_THROTTLE_MS,
} from "@/scripts/lib/tv-cast-progress"

const BASE_SESSION: CastSession = {
  deviceId: "device-1",
  deviceName: "Living Room TV",
  host: "192.168.1.50",
  port: 8765,
  key: "secret-key",
  title: "The Movie",
  isLive: false,
  startedAt: 1000,
}

function vodSession(overrides: Partial<CastSession> = {}): CastSession {
  return {
    ...BASE_SESSION,
    vodContext: { playlistId: "playlist-1", vodId: "123" },
    ...overrides,
  }
}

function seriesSession(overrides: Partial<CastSession> = {}): CastSession {
  return {
    ...BASE_SESSION,
    seriesContext: { playlistId: "playlist-1", seriesId: "9", season: 1, episodeNum: 2 },
    ...overrides,
  }
}

function stateAt(positionSeconds: number, overrides: Partial<CastState> = {}): CastState {
  return { state: "playing", positionSeconds, durationSeconds: 1200, ...overrides }
}

describe("isTrackableCastSession", () => {
  it("is false for a null session", () => {
    expect(isTrackableCastSession(null)).toBe(false)
  })

  it("is false for a live session with no vod/series context", () => {
    expect(isTrackableCastSession({ ...BASE_SESSION, isLive: true })).toBe(false)
  })

  it("is false for a connected-only session even if it somehow carries a vodContext", () => {
    expect(isTrackableCastSession(vodSession({ connectedOnly: true }))).toBe(false)
  })

  it("is true for a vod session", () => {
    expect(isTrackableCastSession(vodSession())).toBe(true)
  })

  it("is true for a series session", () => {
    expect(isTrackableCastSession(seriesSession())).toBe(true)
  })
})

describe("hasSanePlaybackPosition", () => {
  it("is false with no durationSeconds", () => {
    expect(hasSanePlaybackPosition({ positionSeconds: 10 })).toBe(false)
  })

  it("is false with a zero or negative duration", () => {
    expect(hasSanePlaybackPosition({ positionSeconds: 10, durationSeconds: 0 })).toBe(false)
    expect(hasSanePlaybackPosition({ positionSeconds: 10, durationSeconds: -5 })).toBe(false)
  })

  it("is false with a negative or non-finite position", () => {
    expect(hasSanePlaybackPosition({ positionSeconds: -1, durationSeconds: 100 })).toBe(false)
    expect(hasSanePlaybackPosition({ positionSeconds: Infinity, durationSeconds: 100 })).toBe(false)
  })

  it("is true for a sane position within a known duration", () => {
    expect(hasSanePlaybackPosition({ positionSeconds: 30, durationSeconds: 100 })).toBe(true)
  })
})

describe("shouldThrottleWrite", () => {
  it("throttles a write inside the interval", () => {
    expect(shouldThrottleWrite(1000, 0)).toBe(true)
  })

  it("allows a write once the interval elapsed", () => {
    expect(shouldThrottleWrite(CAST_PROGRESS_WRITE_THROTTLE_MS, 0)).toBe(false)
  })

  it("honors a custom interval", () => {
    expect(shouldThrottleWrite(500, 0, 1000)).toBe(true)
    expect(shouldThrottleWrite(1000, 0, 1000)).toBe(false)
  })
})

describe("isTerminalCastStateValue", () => {
  it("is true for paused and ended", () => {
    expect(isTerminalCastStateValue("paused")).toBe(true)
    expect(isTerminalCastStateValue("ended")).toBe(true)
  })

  it("is false for playing, idle, loading, buffering, error", () => {
    for (const stateValue of ["playing", "idle", "loading", "buffering", "error"]) {
      expect(isTerminalCastStateValue(stateValue)).toBe(false)
    }
  })
})

describe("castProgressTargetKey", () => {
  it("keys a vod session by playlist + vod id", () => {
    expect(castProgressTargetKey(vodSession())).toBe("vod:playlist-1:123")
  })

  it("keys a series session by playlist + series id + season + episode", () => {
    expect(castProgressTargetKey(seriesSession())).toBe("episode:playlist-1:9:1:2")
  })

  it("returns null for a session with neither context", () => {
    expect(castProgressTargetKey(BASE_SESSION)).toBeNull()
  })
})

describe("createCastProgressRecorder", () => {
  beforeEach(() => {
    setProgressMock.mockReset()
    markCompletedMock.mockReset()
    requestSeriesInfoMock.mockReset()
  })

  it("writes vod progress immediately on the first sane frame", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe(vodSession(), stateAt(30))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(1))
    expect(setProgressMock).toHaveBeenCalledWith("playlist-1", "vod", "123", 30, 1200, {
      name: "The Movie",
      logo: null,
    })
  })

  it("ignores a frame with position below the 1s floor", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe(vodSession(), stateAt(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setProgressMock).not.toHaveBeenCalled()
  })

  it("ignores live and connected-only sessions", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe({ ...BASE_SESSION, isLive: true }, stateAt(30))
    recorder.observe(vodSession({ connectedOnly: true }), stateAt(30))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setProgressMock).not.toHaveBeenCalled()
  })

  it("throttles routine ticks within the write interval", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe(vodSession(), stateAt(30))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(1))
    recorder.observe(vodSession(), stateAt(31))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setProgressMock).toHaveBeenCalledTimes(1)
  })

  it("always writes on a terminal (paused) frame, bypassing the throttle", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe(vodSession(), stateAt(30))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(1))
    recorder.observe(vodSession(), stateAt(31, { state: "paused" }))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(2))
  })

  it("marks the vod completed on an ended frame", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe(vodSession(), stateAt(1195, { state: "ended" }))
    await vi.waitFor(() => expect(markCompletedMock).toHaveBeenCalledTimes(1))
    expect(markCompletedMock).toHaveBeenCalledWith("playlist-1", "vod", "123", { duration: 1200 })
  })

  it("flushes the outgoing item before switching to a new target", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe(vodSession(), stateAt(30))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(1))

    const nextVod = vodSession({ vodContext: { playlistId: "playlist-1", vodId: "456" } })
    recorder.observe(nextVod, stateAt(5))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(3))
    expect(setProgressMock).toHaveBeenNthCalledWith(2, "playlist-1", "vod", "123", 30, 1200, {
      name: "The Movie",
      logo: null,
    })
    expect(setProgressMock).toHaveBeenNthCalledWith(3, "playlist-1", "vod", "456", 5, 1200, {
      name: "The Movie",
      logo: null,
    })
  })

  it("flush() writes the last observed frame and stops tracking", async () => {
    const recorder = createCastProgressRecorder()
    recorder.observe(vodSession(), stateAt(30))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(1))
    recorder.flush()
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(2))
    recorder.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setProgressMock).toHaveBeenCalledTimes(2)
  })

  it("resolves the episode id off the series context via requestSeriesInfo and writes episode progress", async () => {
    requestSeriesInfoMock.mockResolvedValue({
      info: { name: "The Series", cover: "https://example/series.jpg" },
      episodes: { "1": [{ id: 77, episode_num: 2, title: "Episode Two", container_extension: "mp4" }] },
    })
    const recorder = createCastProgressRecorder()
    recorder.observe(seriesSession(), stateAt(30))
    await vi.waitFor(() => expect(setProgressMock).toHaveBeenCalledTimes(1))
    expect(setProgressMock).toHaveBeenCalledWith("playlist-1", "episode", "77", 30, 1200, {
      seriesId: 9,
      season: 1,
      episodeNum: 2,
      episodeTitle: "Episode Two",
      seriesName: "The Series",
      seriesLogo: "https://example/series.jpg",
    })
  })

  it("skips the write when the episode can't be resolved from series info", async () => {
    requestSeriesInfoMock.mockResolvedValue({ info: {}, episodes: {} })
    const recorder = createCastProgressRecorder()
    // Distinct series id: the resolver caches per playlist+series+season+episode, and the
    // preceding test already populated that cache for series id "9".
    recorder.observe(
      seriesSession({ seriesContext: { playlistId: "playlist-1", seriesId: "99", season: 1, episodeNum: 2 } }),
      stateAt(30)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setProgressMock).not.toHaveBeenCalled()
  })
})
