/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearForPlaylist("pl-a")
  clearForPlaylist("pl-b")
})

import {
  setProgress,
  markCompleted,
  toggleFavorite,
  setFavoritesOrder,
  pushRecent,
  clearForPlaylist,
  getMergedContinueWatching,
  getMergedFavoritesOrdered,
  getMergedRecents,
  getMergedWatchedSignals,
} from "@/scripts/lib/preferences.js"

const PLAYLISTS = ["pl-a", "pl-b"]

describe("getMergedContinueWatching", () => {
  it("unions playlists newest first, stamps playlistId, and caps", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    setProgress("pl-a", "vod", 1, 30, 600)
    vi.setSystemTime(3000)
    setProgress("pl-b", "vod", 1, 30, 600)
    vi.setSystemTime(2000)
    setProgress("pl-a", "episode", 9, 30, 600, { seriesId: 4 })

    const out = getMergedContinueWatching(PLAYLISTS, 10)
    expect(out.map((row) => [row.playlistId, row.kind, row.id])).toEqual([
      ["pl-b", "vod", "1"],
      ["pl-a", "episode", "9"],
      ["pl-a", "vod", "1"],
    ])
    expect(getMergedContinueWatching(PLAYLISTS, 2)).toHaveLength(2)
  })

  it("skips completed entries", () => {
    markCompleted("pl-a", "vod", 5)
    expect(getMergedContinueWatching(PLAYLISTS)).toEqual([])
  })
})

describe("getMergedFavoritesOrdered", () => {
  it("returns playlist order then favorites order", () => {
    toggleFavorite("pl-a", "vod", 1)
    toggleFavorite("pl-a", "vod", 2)
    setFavoritesOrder("pl-a", "vod", [2, 1])
    toggleFavorite("pl-b", "vod", 1)
    expect(getMergedFavoritesOrdered(PLAYLISTS, "vod")).toEqual([
      { playlistId: "pl-a", id: 2 },
      { playlistId: "pl-a", id: 1 },
      { playlistId: "pl-b", id: 1 },
    ])
  })
})

describe("getMergedRecents", () => {
  it("merges by recency and stamps playlistId", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    pushRecent("pl-a", "live", 1, "One")
    vi.setSystemTime(2000)
    pushRecent("pl-b", "live", 1, "Uno")
    vi.setSystemTime(3000)
    pushRecent("pl-a", "live", 2, "Two")
    const out = getMergedRecents(PLAYLISTS, "live")
    expect(out.map((row) => [row.playlistId, row.id])).toEqual([
      ["pl-a", 2],
      ["pl-b", 1],
      ["pl-a", 1],
    ])
  })
})

describe("getMergedWatchedSignals", () => {
  it("unions, sorts by recency, stamps playlistId and caps", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    markCompleted("pl-a", "vod", 1, { name: "Old" })
    vi.setSystemTime(5000)
    markCompleted("pl-b", "vod", 2, { name: "New" })
    const out = getMergedWatchedSignals(PLAYLISTS)
    expect(out.map((row) => [row.playlistId, row.id])).toEqual([
      ["pl-b", "2"],
      ["pl-a", "1"],
    ])
    expect(getMergedWatchedSignals(PLAYLISTS, 1)).toHaveLength(1)
  })
})
