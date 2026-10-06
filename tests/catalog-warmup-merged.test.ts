import { describe, it, expect, vi } from "vitest"

const state = vi.hoisted(() => ({
  entries: [{ _id: "a" }, { _id: "b" }, { _id: "c" }],
  activeId: "b",
  lookups: [] as string[],
  failOn: "",
}))

vi.mock("@/scripts/lib/creds.js", () => ({
  getMergedEntries: async () => state.entries,
  getActiveEntry: async () => ({ _id: state.activeId }),
  getEntryById: vi.fn(async (playlistId: string) => {
    state.lookups.push(playlistId)
    if (playlistId === state.failOn) throw new Error("boom")
    return null
  }),
  getEntries: vi.fn(),
  entryToCreds: vi.fn(),
  isLikelyM3USource: vi.fn(),
  isLocalM3UHost: vi.fn(),
  isCustomHost: vi.fn(),
  readLocalM3UContent: vi.fn(),
  isTauri: false,
  getEntryDnsOverride: vi.fn(),
}))
vi.mock("@/scripts/lib/cache.js", () => ({
  cachedFetch: vi.fn(),
  getCached: vi.fn(),
  hydrate: vi.fn(),
  invalidateCustomDependents: vi.fn(),
}))

import { warmupMerged } from "@/scripts/lib/catalog.js"

describe("warmupMerged", () => {
  it("warms every merged entry with the active one first", async () => {
    state.lookups = []
    const result = await warmupMerged()
    expect(state.lookups).toEqual(["b", "a", "c"])
    expect([...result.keys()]).toEqual(["b", "a", "c"])
  })

  it("swallows a rejection and keeps going", async () => {
    state.lookups = []
    state.failOn = "b"
    const result = await warmupMerged()
    expect(state.lookups).toEqual(["b", "a", "c"])
    expect(result).toBeInstanceOf(Map)
  })
})
