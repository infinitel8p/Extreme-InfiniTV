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
  getRecentSearches,
  pushRecentSearch,
  removeRecentSearch,
  clearRecentSearches,
  clearForPlaylist,
  EVT_SEARCH_RECENT_CHANGED,
} from "@/scripts/lib/preferences.js"

describe("recent searches", () => {
  afterEach(() => {
    clearForPlaylist("playlist-a")
    clearForPlaylist("playlist-b")
  })

  it("returns an empty list for a playlist with no history", () => {
    expect(getRecentSearches("playlist-a")).toEqual([])
  })

  it("pushes a committed query and reads it back newest-first", () => {
    pushRecentSearch("playlist-a", "star trek")
    pushRecentSearch("playlist-a", "the office")

    const recent = getRecentSearches("playlist-a")
    expect(recent.map((entry) => entry.text)).toEqual(["the office", "star trek"])
  })

  it("ignores empty or whitespace-only queries", () => {
    pushRecentSearch("playlist-a", "")
    pushRecentSearch("playlist-a", "   ")
    expect(getRecentSearches("playlist-a")).toEqual([])
  })

  it("ignores queries shorter than 2 characters", () => {
    pushRecentSearch("playlist-a", "a")
    expect(getRecentSearches("playlist-a")).toEqual([])
  })

  it("trims surrounding whitespace before storing", () => {
    pushRecentSearch("playlist-a", "  news  ")
    expect(getRecentSearches("playlist-a")[0].text).toBe("news")
  })

  it("dedupes case-insensitively, moving the existing entry to the top", () => {
    pushRecentSearch("playlist-a", "News")
    pushRecentSearch("playlist-a", "sports")
    pushRecentSearch("playlist-a", "news")

    const recent = getRecentSearches("playlist-a")
    expect(recent.map((entry) => entry.text)).toEqual(["news", "sports"])
    expect(recent.length).toBe(2)
  })

  it("caps the list at 10 entries, dropping the oldest", () => {
    for (let i = 0; i < 12; i++) pushRecentSearch("playlist-a", `query ${i}`)

    const recent = getRecentSearches("playlist-a")
    expect(recent.length).toBe(10)
    expect(recent[0].text).toBe("query 11")
    expect(recent.map((entry) => entry.text)).not.toContain("query 0")
    expect(recent.map((entry) => entry.text)).not.toContain("query 1")
  })

  it("removes one entry case-insensitively without touching the rest", () => {
    pushRecentSearch("playlist-a", "one")
    pushRecentSearch("playlist-a", "two")
    pushRecentSearch("playlist-a", "three")

    removeRecentSearch("playlist-a", "TWO")

    const recent = getRecentSearches("playlist-a")
    expect(recent.map((entry) => entry.text)).toEqual(["three", "one"])
  })

  it("no-ops when removing a query that isn't in the list", () => {
    pushRecentSearch("playlist-a", "one")
    removeRecentSearch("playlist-a", "missing")
    expect(getRecentSearches("playlist-a").length).toBe(1)
  })

  it("clears every entry for a playlist", () => {
    pushRecentSearch("playlist-a", "one")
    pushRecentSearch("playlist-a", "two")

    clearRecentSearches("playlist-a")

    expect(getRecentSearches("playlist-a")).toEqual([])
  })

  it("keeps recent searches isolated per playlist", () => {
    pushRecentSearch("playlist-a", "movies")
    pushRecentSearch("playlist-b", "series")

    expect(getRecentSearches("playlist-a").map((entry) => entry.text)).toEqual(["movies"])
    expect(getRecentSearches("playlist-b").map((entry) => entry.text)).toEqual(["series"])
  })

  it("dispatches EVT_SEARCH_RECENT_CHANGED with the playlist id on push, remove, and clear", () => {
    const handler = vi.fn()
    document.addEventListener(EVT_SEARCH_RECENT_CHANGED, handler)

    pushRecentSearch("playlist-a", "one")
    removeRecentSearch("playlist-a", "one")
    clearRecentSearches("playlist-a")

    document.removeEventListener(EVT_SEARCH_RECENT_CHANGED, handler)

    expect(handler).toHaveBeenCalledTimes(2)
    for (const call of handler.mock.calls) {
      expect(call[0].detail).toEqual({ playlistId: "playlist-a" })
    }
  })
})
