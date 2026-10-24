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

const invalidateEntry = vi.hoisted(() => vi.fn())
vi.mock("@/scripts/lib/cache.js", () => ({ invalidateEntry }))

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
  invalidateEntry.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import {
  addEntry,
  updateEntry,
  getEntries,
  restoreState,
  selectMergedEntries,
  getMergedEntries,
  getMergedPlaylistIds,
  isMergedMode,
  getMergedEntriesSync,
  isMergedModeSync,
  getMergedPlaylistIdsSync,
  setEntryMergedVisible,
  EVT_MERGED_CHANGED,
  MERGED_CHANGED_EVENT,
} from "@/scripts/lib/creds.js"

describe("selectMergedEntries", () => {
  const entries: Array<{ _id: string; mergedVisible?: boolean }> = [
    { _id: "a" },
    { _id: "b", mergedVisible: true },
    { _id: "c" },
    { _id: "d", mergedVisible: true },
  ]

  it("keeps stored order and includes the active entry", () => {
    expect(selectMergedEntries(entries, "c").map((entry: { _id: string }) => entry._id)).toEqual(["b", "c", "d"])
  })

  it("does not duplicate a flagged active entry", () => {
    expect(selectMergedEntries(entries, "b").map((entry: { _id: string }) => entry._id)).toEqual(["b", "d"])
  })
})

describe("merged flag on entries", () => {
  beforeEach(async () => {
    await restoreState({ entries: [], selectedId: "" })
  })

  it("addEntry sanitises the flag", async () => {
    const flagged = await addEntry({ type: "m3u", url: "http://a/x.m3u", mergedVisible: 1 })
    const unflagged = await addEntry({ type: "m3u", url: "http://b/x.m3u", mergedVisible: 0 })
    expect(flagged.mergedVisible).toBe(true)
    expect("mergedVisible" in unflagged).toBe(false)
  })

  it("updateEntry sanitises the flag", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://a/x.m3u" })
    await updateEntry(entry._id, { mergedVisible: "yes" })
    expect((await getEntries())[0].mergedVisible).toBe(true)
    await updateEntry(entry._id, { mergedVisible: false })
    expect("mergedVisible" in (await getEntries())[0]).toBe(false)
  })

  it("setEntryMergedVisible writes the flag without invalidating the cache", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://a/x.m3u" })
    invalidateEntry.mockClear()
    await setEntryMergedVisible(entry._id, true)
    expect((await getEntries())[0].mergedVisible).toBe(true)
    await setEntryMergedVisible(entry._id, false)
    expect("mergedVisible" in (await getEntries())[0]).toBe(false)
    expect(invalidateEntry).not.toHaveBeenCalled()
  })

  it("updateEntry still invalidates the cache", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://a/x.m3u" })
    invalidateEntry.mockClear()
    await updateEntry(entry._id, { title: "Renamed" })
    expect(invalidateEntry).toHaveBeenCalledWith(entry._id)
  })

  it("setEntryMergedVisible is a no-op for unknown ids", async () => {
    await addEntry({ type: "m3u", url: "http://a/x.m3u" })
    const listener = vi.fn()
    document.addEventListener(EVT_MERGED_CHANGED, listener)
    await setEntryMergedVisible("missing", true)
    document.removeEventListener(EVT_MERGED_CHANGED, listener)
    expect(listener).not.toHaveBeenCalled()
  })

  it("dispatches xt:merged-changed with detail", async () => {
    expect(MERGED_CHANGED_EVENT).toBe("xt:merged-changed")
    const entry = await addEntry({ type: "m3u", url: "http://a/x.m3u" })
    const details: unknown[] = []
    const listener = (event: Event) => details.push((event as CustomEvent).detail)
    document.addEventListener("xt:merged-changed", listener)
    await setEntryMergedVisible(entry._id, true)
    document.removeEventListener("xt:merged-changed", listener)
    expect(details).toEqual([{ entryId: entry._id, mergedVisible: true }])
  })

  it("merged mode needs at least two entries", async () => {
    const first = await addEntry({ type: "m3u", url: "http://a/x.m3u" })
    expect(await isMergedMode()).toBe(false)
    const second = await addEntry({ type: "m3u", url: "http://b/x.m3u" })
    expect(await isMergedMode()).toBe(false)
    await setEntryMergedVisible(first._id, true)
    expect(await isMergedMode()).toBe(true)
    expect(await getMergedPlaylistIds()).toEqual([first._id, second._id])
    expect((await getMergedEntries()).length).toBe(2)
    expect(getMergedEntriesSync().length).toBe(2)
    expect(isMergedModeSync()).toBe(true)
    expect(getMergedPlaylistIdsSync()).toEqual([first._id, second._id])
  })
})
