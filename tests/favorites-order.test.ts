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
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadPrefs() {
  return await import("@/scripts/lib/preferences.js")
}

describe("favorite id normalization (issue #177)", () => {
  it("hydrates a numeric-string favorite so it matches the numeric order array", async () => {
    localStorageStore.set(
      "xt_prefs",
      JSON.stringify({
        "playlist-a": {
          favLive: ["12", 34],
          favOrderLive: [34, 12],
        },
      })
    )
    const prefs = await loadPrefs()
    await prefs.ensureLoaded()

    expect(prefs.getFavoritesOrdered("playlist-a", "live")).toEqual([34, 12])
  })

  it("toggleFavorite removes an existing numeric-string favorite instead of adding a duplicate", async () => {
    const prefs = await loadPrefs()
    await prefs.ensureLoaded()

    prefs.toggleFavorite("playlist-b", "live", 12)
    expect(prefs.getFavorites("playlist-b", "live").size).toBe(1)

    const stillFavorite = prefs.toggleFavorite("playlist-b", "live", "12")

    expect(stillFavorite).toBe(false)
    expect(prefs.getFavorites("playlist-b", "live").size).toBe(0)
  })

  it("isFavorite matches a numeric-string id against a numeric favorite", async () => {
    const prefs = await loadPrefs()
    await prefs.ensureLoaded()

    prefs.toggleFavorite("playlist-c", "live", 34)

    expect(prefs.isFavorite("playlist-c", "live", "34")).toBe(true)
  })
})
