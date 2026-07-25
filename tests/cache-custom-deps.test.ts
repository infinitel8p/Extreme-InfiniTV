/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

let storedEntries: any[] = []
const docs = new Map<string, any>()
const unreadableDocs = new Set<string>()

vi.mock("@/scripts/lib/creds.js", () => ({
  getEntries: async () => storedEntries,
}))

vi.mock("@/scripts/lib/custom-playlist.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scripts/lib/custom-playlist")>()
  return {
    ...actual,
    loadCustomDoc: async (entryId: string) => {
      if (unreadableDocs.has(entryId)) throw new Error("storage read failed")
      return docs.get(entryId) ?? actual.emptyCustomDoc()
    },
  }
})

vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
  redactUrl: (value: string) => value,
}))

import {
  setCached,
  getCached,
  invalidateEntry,
  invalidateCustomDependents,
  CACHE_REVALIDATED_EVENT,
} from "@/scripts/lib/cache.js"
import { addChannel, emptyCustomDoc } from "@/scripts/lib/custom-playlist.ts"

function customDoc(sourceEntryIds: string[]) {
  let doc = emptyCustomDoc()
  for (const [index, entryId] of sourceEntryIds.entries()) {
    doc = addChannel(doc, { kind: "xtream", entryId, streamId: index + 1 }, { group: "News" }).doc
  }
  return doc
}

function customEntry(id: string, sourceEntryIds: string[]) {
  docs.set(id, customDoc(sourceEntryIds))
  return { _id: id, type: "custom" }
}

beforeEach(() => {
  docs.clear()
  unreadableDocs.clear()
  storedEntries = []
})

describe("invalidateCustomDependents", () => {
  it("drops the resolved catalog of a custom playlist referencing the source", async () => {
    storedEntries = [{ _id: "src-1", type: "xtream" }, customEntry("cust-1", ["src-1"])]
    setCached("cust-1", "m3u", [{ id: 1 }], 1000)

    const dependents = await invalidateCustomDependents("src-1")

    expect(dependents).toEqual(["cust-1"])
    expect(getCached("cust-1", "m3u")).toBeNull()
  })

  it("dispatches xt:cache-revalidated for each invalidated custom playlist", async () => {
    storedEntries = [{ _id: "src-1", type: "xtream" }, customEntry("cust-1", ["src-1"])]
    const seen: any[] = []
    const onRevalidated = (ev: Event) => seen.push((ev as CustomEvent).detail)
    document.addEventListener(CACHE_REVALIDATED_EVENT, onRevalidated)

    await invalidateCustomDependents("src-1")
    document.removeEventListener(CACHE_REVALIDATED_EVENT, onRevalidated)

    expect(seen).toEqual([{ entryId: "cust-1", kind: "m3u" }])
  })

  it("leaves custom playlists that don't reference the source alone", async () => {
    storedEntries = [
      { _id: "src-1", type: "xtream" },
      customEntry("cust-1", ["src-2"]),
    ]
    setCached("cust-1", "m3u", [{ id: 1 }], 1000)

    expect(await invalidateCustomDependents("src-1")).toEqual([])
    expect(getCached("cust-1", "m3u")?.data).toEqual([{ id: 1 }])
  })

  it("keeps going when one custom doc cannot be read", async () => {
    storedEntries = [
      { _id: "src-1", type: "xtream" },
      customEntry("cust-broken", ["src-1"]),
      customEntry("cust-1", ["src-1"]),
    ]
    unreadableDocs.add("cust-broken")
    setCached("cust-1", "m3u", [{ id: 1 }], 1000)

    const dependents = await invalidateCustomDependents("src-1")

    expect(dependents).toEqual(["cust-1"])
    expect(getCached("cust-1", "m3u")).toBeNull()
  })

  it("never returns the source itself, even when a custom playlist references itself", async () => {
    storedEntries = [customEntry("cust-1", ["cust-1", "src-1"])]
    setCached("cust-1", "m3u", [{ id: 1 }], 1000)

    expect(await invalidateCustomDependents("cust-1")).toEqual([])
    expect(getCached("cust-1", "m3u")?.data).toEqual([{ id: 1 }])
  })

  it("walks a chain of custom playlists without looping on a cycle", async () => {
    storedEntries = [
      { _id: "src-1", type: "xtream" },
      customEntry("cust-1", ["src-1", "cust-2"]),
      customEntry("cust-2", ["cust-1"]),
    ]
    setCached("cust-1", "m3u", [{ id: 1 }], 1000)
    setCached("cust-2", "m3u", [{ id: 2 }], 1000)

    const dependents = await invalidateCustomDependents("src-1")

    expect(dependents.sort()).toEqual(["cust-1", "cust-2"])
    expect(getCached("cust-1", "m3u")).toBeNull()
    expect(getCached("cust-2", "m3u")).toBeNull()
  })

  it("is a no-op without a source id", async () => {
    expect(await invalidateCustomDependents("")).toEqual([])
  })
})

describe("invalidateEntry", () => {
  it("also drops the dependent custom playlists' resolved catalogs", async () => {
    storedEntries = [{ _id: "src-1", type: "xtream" }, customEntry("cust-1", ["src-1"])]
    setCached("src-1", "live", [{ id: 1 }], 1000)
    setCached("cust-1", "m3u", [{ id: 1 }], 1000)

    invalidateEntry("src-1")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getCached("src-1", "live")).toBeNull()
    expect(getCached("cust-1", "m3u")).toBeNull()
  })
})
