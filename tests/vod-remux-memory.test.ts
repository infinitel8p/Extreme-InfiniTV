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
  vi.resetModules()
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("buildRemuxContentKey", () => {
  it("builds a movie content key", async () => {
    const { buildRemuxContentKey } = await import("@/scripts/lib/vod-remux-memory.ts")
    expect(buildRemuxContentKey("movie", 42)).toBe("movie:42")
  })

  it("builds an episode content key", async () => {
    const { buildRemuxContentKey } = await import("@/scripts/lib/vod-remux-memory.ts")
    expect(buildRemuxContentKey("episode", "7")).toBe("episode:7")
  })
})

describe("isRemuxPinnedContent / rememberRemuxPinnedContent", () => {
  it("is not pinned until remembered", async () => {
    const { isRemuxPinnedContent } = await import("@/scripts/lib/vod-remux-memory.ts")
    expect(isRemuxPinnedContent("playlist-1", "movie:42")).toBe(false)
  })

  it("remembers a content key for a playlist and reports it pinned afterwards", async () => {
    const { isRemuxPinnedContent, rememberRemuxPinnedContent } = await import(
      "@/scripts/lib/vod-remux-memory.ts"
    )
    rememberRemuxPinnedContent("playlist-1", "movie:42")
    expect(isRemuxPinnedContent("playlist-1", "movie:42")).toBe(true)
  })

  it("persists to localStorage under a per-playlist key", async () => {
    const { rememberRemuxPinnedContent } = await import("@/scripts/lib/vod-remux-memory.ts")
    rememberRemuxPinnedContent("playlist-1", "movie:42")
    const raw = localStorage.getItem("xt_vod_remux_fallback:playlist-1")
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual(["movie:42"])
  })

  it("keeps pinned content scoped to its own playlist", async () => {
    const { isRemuxPinnedContent, rememberRemuxPinnedContent } = await import(
      "@/scripts/lib/vod-remux-memory.ts"
    )
    rememberRemuxPinnedContent("playlist-1", "movie:42")
    expect(isRemuxPinnedContent("playlist-2", "movie:42")).toBe(false)
  })

  it("survives module state being read again for a different playlist and back", async () => {
    const { isRemuxPinnedContent, rememberRemuxPinnedContent } = await import(
      "@/scripts/lib/vod-remux-memory.ts"
    )
    rememberRemuxPinnedContent("playlist-1", "movie:42")
    // Reading a different playlist first exercises the module's per-playlist cache swap.
    expect(isRemuxPinnedContent("playlist-2", "episode:7")).toBe(false)
    expect(isRemuxPinnedContent("playlist-1", "movie:42")).toBe(true)
  })

  it("is idempotent when the same content key is remembered twice", async () => {
    const { rememberRemuxPinnedContent } = await import("@/scripts/lib/vod-remux-memory.ts")
    rememberRemuxPinnedContent("playlist-1", "movie:42")
    rememberRemuxPinnedContent("playlist-1", "movie:42")
    const raw = localStorage.getItem("xt_vod_remux_fallback:playlist-1")
    expect(JSON.parse(raw!)).toEqual(["movie:42"])
  })

  it("returns false and does not throw for an empty playlist id", async () => {
    const { isRemuxPinnedContent, rememberRemuxPinnedContent } = await import(
      "@/scripts/lib/vod-remux-memory.ts"
    )
    expect(isRemuxPinnedContent("", "movie:42")).toBe(false)
    expect(() => rememberRemuxPinnedContent("", "movie:42")).not.toThrow()
  })

  it("tolerates malformed JSON already stored for a playlist", async () => {
    localStorage.setItem("xt_vod_remux_fallback:playlist-1", "not json")
    const { isRemuxPinnedContent } = await import("@/scripts/lib/vod-remux-memory.ts")
    expect(isRemuxPinnedContent("playlist-1", "movie:42")).toBe(false)
  })
})
