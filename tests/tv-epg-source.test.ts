/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const memoryConservativeMock = vi.hoisted(() => vi.fn(() => false))
vi.mock("@/scripts/tv/motion", () => ({
  memoryConservative: memoryConservativeMock,
}))

const xtreamApiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/scripts/lib/xtream-api.js", () => ({
  xtreamApiFetch: xtreamApiFetchMock,
}))

import { tvEpgSource, toXtreamCreds } from "../src/scripts/tv/epg-source"
import type { XtreamCreds } from "../src/scripts/lib/short-epg.ts"

const xtreamCreds: XtreamCreds = { host: "iptv.example.com", port: "8080", user: "alice", pass: "secret" }
const m3uCreds: XtreamCreds = { host: "https://m3u.example.com/list.m3u8", port: "", user: "", pass: "" }

// Node 24+ ships an experimental native `localStorage` that shadows jsdom's; stub a
// real in-memory Storage so the dead-marker tests below see one consistent store.
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
  vi.resetModules()
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
  memoryConservativeMock.mockReturnValue(false)
  xtreamApiFetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("tvEpgSource", () => {
  it("stays on full XMLTV when the device isn't memory-conservative, regardless of creds", () => {
    expect(tvEpgSource(xtreamCreds)).toBe("xmltv-full")
    expect(tvEpgSource(m3uCreds)).toBe("xmltv-full")
    expect(tvEpgSource(null)).toBe("xmltv-full")
  })

  it("picks short-epg on memory-conservative devices with usable Xtream creds", () => {
    memoryConservativeMock.mockReturnValue(true)
    expect(tvEpgSource(xtreamCreds)).toBe("short-epg")
  })

  it("falls back to XMLTV now-next on memory-conservative devices without Xtream creds", () => {
    memoryConservativeMock.mockReturnValue(true)
    expect(tvEpgSource(m3uCreds)).toBe("xmltv-now-next")
    expect(tvEpgSource(null)).toBe("xmltv-now-next")
    expect(tvEpgSource(undefined)).toBe("xmltv-now-next")
  })
})

describe("toXtreamCreds", () => {
  it("carries the playlist id through as entryId", () => {
    expect(toXtreamCreds("playlist-1", { host: "iptv.example.com", port: "8080", user: "alice", pass: "secret" })).toEqual({
      host: "iptv.example.com",
      port: "8080",
      user: "alice",
      pass: "secret",
      entryId: "playlist-1",
    })
  })
})

describe("short-EPG dead-marker state machine", () => {
  it("marks a playlist dead once 8 distinct stream ids all resolve empty and dispatches the change event once", async () => {
    const { recordShortEpgOutcome, shortEpgIsDead, TV_EPG_SOURCE_CHANGED_EVENT } = await import(
      "../src/scripts/tv/epg-source"
    )
    const onChanged = vi.fn()
    document.addEventListener(TV_EPG_SOURCE_CHANGED_EVENT, onChanged)

    for (let streamId = 1; streamId <= 7; streamId++) {
      recordShortEpgOutcome("p1", streamId, "empty")
    }
    expect(shortEpgIsDead("p1")).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()

    recordShortEpgOutcome("p1", 8, "empty")
    expect(shortEpgIsDead("p1")).toBe(true)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect((onChanged.mock.calls[0][0] as CustomEvent).detail).toEqual({
      playlistId: "p1",
      source: "xmltv-now-next",
    })

    recordShortEpgOutcome("p1", 9, "empty")
    expect(onChanged).toHaveBeenCalledTimes(1)

    document.removeEventListener(TV_EPG_SOURCE_CHANGED_EVENT, onChanged)
  })

  it("the same stream id repeating empty never counts as distinct", async () => {
    const { recordShortEpgOutcome, shortEpgIsDead } = await import("../src/scripts/tv/epg-source")
    for (let attempt = 0; attempt < 8; attempt++) {
      recordShortEpgOutcome("p1", 1, "empty")
    }
    expect(shortEpgIsDead("p1")).toBe(false)
  })

  it("a non-empty result lowers the ratio instead of wiping the sample outright", async () => {
    const { recordShortEpgOutcome, shortEpgIsDead } = await import("../src/scripts/tv/epg-source")
    for (let streamId = 1; streamId <= 7; streamId++) {
      recordShortEpgOutcome("p1", streamId, "empty")
    }
    recordShortEpgOutcome("p1", 8, "nonEmpty")
    // 7 empty / 8 sampled = 87.5%, below the 90% threshold.
    expect(shortEpgIsDead("p1")).toBe(false)

    recordShortEpgOutcome("p1", 9, "empty")
    // 8 empty / 9 sampled = 88.9%, still below.
    expect(shortEpgIsDead("p1")).toBe(false)

    recordShortEpgOutcome("p1", 10, "empty")
    // 9 empty / 10 sampled = 90%, meets the threshold.
    expect(shortEpgIsDead("p1")).toBe(true)
  })

  it("a later non-empty result clears an existing dead marker", async () => {
    const { recordShortEpgOutcome, shortEpgIsDead } = await import("../src/scripts/tv/epg-source")
    for (let streamId = 1; streamId <= 8; streamId++) {
      recordShortEpgOutcome("p1", streamId, "empty")
    }
    expect(shortEpgIsDead("p1")).toBe(true)

    recordShortEpgOutcome("p1", 9, "nonEmpty")
    expect(shortEpgIsDead("p1")).toBe(false)
  })

  it("tracks each playlist independently", async () => {
    const { recordShortEpgOutcome, shortEpgIsDead } = await import("../src/scripts/tv/epg-source")
    for (let streamId = 1; streamId <= 8; streamId++) {
      recordShortEpgOutcome("p1", streamId, "empty")
    }
    expect(shortEpgIsDead("p1")).toBe(true)
    expect(shortEpgIsDead("p2")).toBe(false)
  })

  it("the dead marker expires after 7 days", async () => {
    const { shortEpgIsDead } = await import("../src/scripts/tv/epg-source")
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    localStorage.setItem("xt_short_epg_dead:p1", String(eightDaysAgo))
    expect(shortEpgIsDead("p1")).toBe(false)
    expect(localStorage.getItem("xt_short_epg_dead:p1")).toBeNull()
  })

  it("tvEpgSource falls back to xmltv-now-next while the marker is fresh, even with usable Xtream creds", async () => {
    const freshModule = await import("../src/scripts/tv/epg-source")
    memoryConservativeMock.mockReturnValue(true)
    const creds = freshModule.toXtreamCreds("p1", {
      host: "iptv.example.com",
      port: "8080",
      user: "alice",
      pass: "secret",
    })
    expect(freshModule.tvEpgSource(creds)).toBe("short-epg")

    for (let streamId = 1; streamId <= 8; streamId++) {
      freshModule.recordShortEpgOutcome("p1", streamId, "empty")
    }
    expect(freshModule.tvEpgSource(creds)).toBe("xmltv-now-next")
  })
})

describe("tvShortEpgCache empirical-emptiness wiring", () => {
  it("counts an empty-but-successful now/next result, not a failure, toward the dead marker", async () => {
    const { tvShortEpgCache, shortEpgIsDead } = await import("../src/scripts/tv/epg-source")
    const creds: XtreamCreds = { ...xtreamCreds, entryId: "p1" }
    const cache = tvShortEpgCache()

    xtreamApiFetchMock.mockRejectedValueOnce(new Error("network down"))
    xtreamApiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ epg_listings: [] }) })

    await cache.getNowNext(creds, 1) // failure - never counted
    expect(shortEpgIsDead("p1")).toBe(false)

    for (let streamId = 2; streamId <= 8; streamId++) {
      await cache.getNowNext(creds, streamId)
    }
    expect(shortEpgIsDead("p1")).toBe(false)

    await cache.getNowNext(creds, 9)
    expect(shortEpgIsDead("p1")).toBe(true)
  })
})
