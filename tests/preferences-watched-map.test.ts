/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Node 24+ ships an experimental native `localStorage` (undefined without
// --localstorage-file) that shadows jsdom's; stub it with a real in-memory Storage.
const localStorageStore = new Map<string, string>()
const localStorageMock: Storage = {
  getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
  setItem: (key, value) => {
    localStorageStore.set(key, String(value))
  },
  removeItem: (key) => {
    localStorageStore.delete(key)
  },
  clear: () => {
    localStorageStore.clear()
  },
  key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
  get length() {
    return localStorageStore.size
  },
}

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import {
  setProgress,
  markCompleted,
  clearProgress,
  setSeriesWatchedOverride,
  getSeriesWatchedMap,
  getProgressRevision,
  setChannelOverride,
  setChannelOverrides,
  clearChannelOverride,
  clearAllChannelOverrides,
  getChannelOverridesRevision,
  clearForPlaylist,
} from "@/scripts/lib/preferences.js"

describe("getSeriesWatchedMap", () => {
  afterEach(() => {
    clearForPlaylist("playlist-a")
  })

  it("returns an empty map for a playlist with no history", () => {
    expect(getSeriesWatchedMap("playlist-a").size).toBe(0)
  })

  it("marks a series watched once every recorded episode is completed", () => {
    markCompleted("playlist-a", "episode", 1, { seriesId: 100 })
    markCompleted("playlist-a", "episode", 2, { seriesId: 100 })
    expect(getSeriesWatchedMap("playlist-a").get(100)).toBe(true)
  })

  it("does not mark a series watched while any recorded episode is incomplete", () => {
    markCompleted("playlist-a", "episode", 1, { seriesId: 100 })
    setProgress("playlist-a", "episode", 2, 30, 1200, { seriesId: 100 })
    expect(getSeriesWatchedMap("playlist-a").has(100)).toBe(false)
  })

  it("marks a series watched via the manual override with no episode progress", () => {
    setSeriesWatchedOverride("playlist-a", 200, true)
    expect(getSeriesWatchedMap("playlist-a").get(200)).toBe(true)
  })

  it("unmarks a series once its override is cleared and progress removed", () => {
    setSeriesWatchedOverride("playlist-a", 200, true)
    setSeriesWatchedOverride("playlist-a", 200, false)
    expect(getSeriesWatchedMap("playlist-a").has(200)).toBe(false)
  })

  it("returns the same map reference when nothing changed since the last read", () => {
    markCompleted("playlist-a", "episode", 1, { seriesId: 100 })
    const first = getSeriesWatchedMap("playlist-a")
    const second = getSeriesWatchedMap("playlist-a")
    expect(second).toBe(first)
  })

  it("recomputes once a progress write bumps the revision", () => {
    markCompleted("playlist-a", "episode", 1, { seriesId: 100 })
    const first = getSeriesWatchedMap("playlist-a")
    markCompleted("playlist-a", "episode", 2, { seriesId: 101 })
    const second = getSeriesWatchedMap("playlist-a")
    expect(second).not.toBe(first)
    expect(second.get(101)).toBe(true)
  })
})

describe("getProgressRevision", () => {
  afterEach(() => {
    clearForPlaylist("playlist-a")
  })

  it("advances on setProgress, markCompleted, clearProgress and a series override", () => {
    const start = getProgressRevision()
    setProgress("playlist-a", "vod", 1, 30, 1200)
    expect(getProgressRevision()).toBeGreaterThan(start)

    const afterSet = getProgressRevision()
    markCompleted("playlist-a", "vod", 2)
    expect(getProgressRevision()).toBeGreaterThan(afterSet)

    const afterComplete = getProgressRevision()
    clearProgress("playlist-a", "vod", 2)
    expect(getProgressRevision()).toBeGreaterThan(afterComplete)

    const afterClear = getProgressRevision()
    setSeriesWatchedOverride("playlist-a", 300, true)
    expect(getProgressRevision()).toBeGreaterThan(afterClear)
  })
})

describe("getChannelOverridesRevision", () => {
  afterEach(() => {
    clearForPlaylist("playlist-a")
  })

  it("advances on every channelOv writer", () => {
    const start = getChannelOverridesRevision()
    setChannelOverride("playlist-a", "x:1", { name: "News HD" })
    expect(getChannelOverridesRevision()).toBeGreaterThan(start)

    const afterSet = getChannelOverridesRevision()
    setChannelOverrides("playlist-a", [{ key: "x:2", patch: { name: "Sports HD" } }])
    expect(getChannelOverridesRevision()).toBeGreaterThan(afterSet)

    const afterBulk = getChannelOverridesRevision()
    clearChannelOverride("playlist-a", "x:1")
    expect(getChannelOverridesRevision()).toBeGreaterThan(afterBulk)

    const afterClearOne = getChannelOverridesRevision()
    clearAllChannelOverrides("playlist-a")
    expect(getChannelOverridesRevision()).toBeGreaterThan(afterClearOne)
  })
})
