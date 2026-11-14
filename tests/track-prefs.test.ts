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
  getTrackPrefs,
  setTrackPrefs,
  clearTrackPrefs,
  clearForPlaylist,
  TRACK_PREFS_EVENT,
} from "@/scripts/lib/preferences.js"

describe("per-title track prefs", () => {
  afterEach(() => {
    clearForPlaylist("playlist-a")
    clearForPlaylist("playlist-b")
  })

  it("returns null when nothing is stored", () => {
    expect(getTrackPrefs("playlist-a", "vod", 1)).toBeNull()
  })

  it("fills defaults on first write", () => {
    setTrackPrefs("playlist-a", "vod", 1, { audioLang: "en" })
    const record = getTrackPrefs("playlist-a", "vod", 1)
    expect(record).toMatchObject({
      audioLang: "en",
      audioId: null,
      audioTitle: null,
      subLang: null,
      subId: null,
      subTitle: null,
      subOff: false,
    })
    expect(typeof record?.updatedAt).toBe("number")
  })

  it("merges a patch over the existing record, keeping untouched fields", () => {
    setTrackPrefs("playlist-a", "vod", 1, { audioLang: "en", audioId: 2 })
    setTrackPrefs("playlist-a", "vod", 1, { subLang: "de", subId: 5 })

    expect(getTrackPrefs("playlist-a", "vod", 1)).toMatchObject({
      audioLang: "en",
      audioId: 2,
      subLang: "de",
      subId: 5,
    })
  })

  it("keys records by kind + id so vod and episode don't collide", () => {
    setTrackPrefs("playlist-a", "vod", 1, { audioLang: "en" })
    setTrackPrefs("playlist-a", "episode", 1, { audioLang: "de" })

    expect(getTrackPrefs("playlist-a", "vod", 1)?.audioLang).toBe("en")
    expect(getTrackPrefs("playlist-a", "episode", 1)?.audioLang).toBe("de")
  })

  it("clears a record", () => {
    setTrackPrefs("playlist-a", "vod", 1, { audioLang: "en" })
    clearTrackPrefs("playlist-a", "vod", 1)
    expect(getTrackPrefs("playlist-a", "vod", 1)).toBeNull()
  })

  it("no-ops clearing a record that doesn't exist", () => {
    expect(() => clearTrackPrefs("playlist-a", "vod", 999)).not.toThrow()
  })

  it("dispatches TRACK_PREFS_EVENT with playlistId/kind/id on a real change", () => {
    const handler = vi.fn()
    document.addEventListener(TRACK_PREFS_EVENT, handler)

    setTrackPrefs("playlist-a", "vod", 1, { audioLang: "en" })
    clearTrackPrefs("playlist-a", "vod", 1)

    document.removeEventListener(TRACK_PREFS_EVENT, handler)

    expect(handler).toHaveBeenCalledTimes(2)
    for (const call of handler.mock.calls) {
      expect(call[0].detail).toEqual({ playlistId: "playlist-a", kind: "vod", id: 1 })
    }
  })

  it("does not dispatch when the patch doesn't change anything", () => {
    setTrackPrefs("playlist-a", "vod", 1, { audioLang: "en" })

    const handler = vi.fn()
    document.addEventListener(TRACK_PREFS_EVENT, handler)
    setTrackPrefs("playlist-a", "vod", 1, { audioLang: "en" })
    document.removeEventListener(TRACK_PREFS_EVENT, handler)

    expect(handler).not.toHaveBeenCalled()
  })

  it("ignores a falsy playlistId or id", () => {
    setTrackPrefs("", "vod", 1, { audioLang: "en" })
    setTrackPrefs("playlist-a", "vod", null as unknown as number, { audioLang: "en" })
    expect(getTrackPrefs("playlist-a", "vod", 1)).toBeNull()
  })

  it("caps the bucket at 200 records, dropping the oldest by updatedAt", () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    for (let i = 0; i < 201; i++) {
      setTrackPrefs("playlist-b", "vod", i, { audioLang: "en" })
      vi.advanceTimersByTime(1)
    }
    vi.useRealTimers()
    expect(getTrackPrefs("playlist-b", "vod", 0)).toBeNull()
    expect(getTrackPrefs("playlist-b", "vod", 200)).not.toBeNull()
  })
})
