import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  entries: [] as Array<{ _id: string; title: string }>,
  cache: new Map<string, { data: any[]; fetchedAt: number; stale: boolean }>(),
  ensureLive: vi.fn(),
}))

vi.mock("@/scripts/lib/creds.js", () => ({
  getMergedEntriesSync: () => state.entries,
  isMergedModeSync: () => state.entries.length >= 2,
  getMergedEntries: async () => state.entries,
  entryToCreds: (entry: any) => ({ host: entry._id }),
  getEntryDnsOverride: () => null,
}))
vi.mock("@/scripts/lib/cache.js", () => ({
  getCached: (playlistId: string, kind: string) => state.cache.get(`${playlistId}:${kind}`) || null,
  hydrate: vi.fn(async () => {}),
}))
vi.mock("@/scripts/lib/live-catalog.ts", () => ({
  readCachedLiveChannels: (playlistId: string) =>
    (state.cache.get(`${playlistId}:live`) || state.cache.get(`${playlistId}:m3u`))?.data ?? [],
}))
vi.mock("@/scripts/lib/catalog.js", () => ({
  ensureLive: (...args: unknown[]) => state.ensureLive(...args),
  ensureVod: vi.fn(),
  ensureSeries: vi.fn(),
}))

import {
  ensureMergedRows,
  getMergedSources,
  isMergedPlaylistId,
  isMergedView,
  readMergedRows,
} from "@/scripts/lib/merged-catalog.ts"

function put(playlistId: string, kind: string, data: any[], fetchedAt = 1, stale = false) {
  state.cache.set(`${playlistId}:${kind}`, { data, fetchedAt, stale })
}

beforeEach(() => {
  state.entries = []
  state.cache.clear()
  state.ensureLive = vi.fn()
})

describe("merged-catalog", () => {
  it("single source is not merged and rows are stamped", () => {
    state.entries = [{ _id: "a", title: "A" }]
    put("a", "vod", [{ id: 1 }])
    const result = readMergedRows("vod")
    expect(result.isMerged).toBe(false)
    expect(isMergedView()).toBe(false)
    expect(result.rows).toEqual([{ id: 1, playlistId: "a" }])
  })

  it("concatenates in playlist order and tracks freshness", () => {
    state.entries = [
      { _id: "a", title: "A" },
      { _id: "b", title: "B" },
    ]
    put("a", "vod", [{ id: 1 }], 10)
    put("b", "vod", [{ id: 1 }, { id: 2 }], 20, true)
    const result = readMergedRows("vod")
    expect(result.isMerged).toBe(true)
    expect(result.rows.map((row) => `${row.playlistId}:${row.id}`)).toEqual(["a:1", "b:1", "b:2"])
    expect(result.newestFetchedAt).toBe(20)
    expect(result.anyStale).toBe(true)
    expect(getMergedSources()).toEqual([
      { playlistId: "a", title: "A" },
      { playlistId: "b", title: "B" },
    ])
  })

  it("live falls back to m3u per playlist", () => {
    state.entries = [
      { _id: "a", title: "A" },
      { _id: "b", title: "B" },
    ]
    put("a", "live", [{ id: 1 }])
    put("b", "m3u", [{ id: 2 }])
    const result = readMergedRows("live")
    expect(result.byPlaylist.get("a")).toHaveLength(1)
    expect(result.byPlaylist.get("b")?.[0]).toMatchObject({ id: 2, playlistId: "b" })
  })

  it("keeps stamped arrays identity-stable across reads", () => {
    state.entries = [{ _id: "a", title: "A" }]
    put("a", "vod", [{ id: 1 }])
    expect(readMergedRows("vod").byPlaylist.get("a")).toBe(readMergedRows("vod").byPlaylist.get("a"))
  })

  it("ensureMergedRows keeps the good playlist when one rejects", async () => {
    state.entries = [
      { _id: "a", title: "A" },
      { _id: "b", title: "B" },
    ]
    put("a", "live", [{ id: 1 }])
    const failure = new Error("boom")
    state.ensureLive = vi.fn(async (_creds: unknown, playlistId: string) => {
      if (playlistId === "b") throw failure
      return [{ id: 1 }]
    })
    const settled: Array<[string, string]> = []
    const result = await ensureMergedRows("live", {
      onPlaylistSettled: (playlistId, status) => settled.push([playlistId, status]),
    })
    expect(result.rows).toHaveLength(1)
    expect(result.errors.get("b")).toBe(failure)
    expect(settled).toEqual(expect.arrayContaining([["a", "done"], ["b", "error"]]))
    expect(settled).toHaveLength(2)
  })

  it("isMergedPlaylistId matches sources only", () => {
    state.entries = [{ _id: "a", title: "A" }]
    expect(isMergedPlaylistId("a")).toBe(true)
    expect(isMergedPlaylistId("z")).toBe(false)
  })
})
