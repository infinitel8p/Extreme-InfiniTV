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

import { addEntry, updateEntry, getEntries, restoreState } from "@/scripts/lib/creds.js"

describe("playlist entry personalization (emoji + accent override)", () => {
  beforeEach(async () => {
    await restoreState({ entries: [], selectedId: "" })
  })

  it("addEntry keeps a valid emoji and accent override", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u", emoji: "🎬", accent: "cyan" })
    expect(entry.emoji).toBe("🎬")
    expect(entry.accent).toBe("cyan")
  })

  it("addEntry strips a blank emoji and an unknown accent value", async () => {
    const entry = await addEntry({
      type: "m3u",
      url: "http://example.com/list.m3u",
      emoji: "   ",
      accent: "not-a-real-color",
    })
    expect(entry.emoji).toBeUndefined()
    expect(entry.accent).toBeUndefined()
  })

  it("addEntry trims surrounding whitespace from the emoji", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u", emoji: "  📺  " })
    expect(entry.emoji).toBe("📺")
  })

  it("addEntry caps the emoji at 8 code units so a long paste can't bloat the entry", async () => {
    const long = "🏠".repeat(6) // each surrogate pair is 2 UTF-16 code units - 12 total
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u", emoji: long })
    expect(entry.emoji.length).toBeLessThanOrEqual(8)
  })

  it("addEntry keeps a ZWJ family emoji whole instead of bisecting it into a lone surrogate", async () => {
    const familyEmoji = "👨‍👩‍👧‍👦" // one grapheme cluster, 11 UTF-16 code units - past the old 8-unit cap
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u", emoji: familyEmoji })
    expect(entry.emoji).toBe(familyEmoji)
    expect(entry.emoji.length).toBeGreaterThan(8)
  })

  it("addEntry omits emoji/accent entirely when neither is supplied", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u" })
    expect("emoji" in entry).toBe(false)
    expect("accent" in entry).toBe(false)
  })

  it("updateEntry round-trips a new emoji and accent onto an existing entry", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u" })
    await updateEntry(entry._id, { emoji: "🎬", accent: "blue" })
    const [reloaded] = await getEntries()
    expect(reloaded.emoji).toBe("🎬")
    expect(reloaded.accent).toBe("blue")
  })

  it("updateEntry clears emoji/accent when the patch blanks them out", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u", emoji: "📺", accent: "blue" })
    await updateEntry(entry._id, { emoji: "", accent: "" })
    const [reloaded] = await getEntries()
    expect(reloaded.emoji).toBeUndefined()
    expect(reloaded.accent).toBeUndefined()
  })

  it("updateEntry leaves emoji/accent untouched when the patch doesn't mention them", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u", emoji: "📺", accent: "blue" })
    await updateEntry(entry._id, { title: "Renamed" })
    const [reloaded] = await getEntries()
    expect(reloaded.title).toBe("Renamed")
    expect(reloaded.emoji).toBe("📺")
    expect(reloaded.accent).toBe("blue")
  })

  it("updateEntry rejects an invalid accent even when emoji is valid", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u" })
    await updateEntry(entry._id, { emoji: "🎥", accent: "chartreuse" })
    const [reloaded] = await getEntries()
    expect(reloaded.emoji).toBe("🎥")
    expect(reloaded.accent).toBeUndefined()
  })
})
