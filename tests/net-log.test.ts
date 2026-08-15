/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeNetLogEntry,
  pushWithCapacity,
  shouldRecordKind,
  NET_LOG_CAPACITY,
  NET_LOG_EVENT,
} from "../src/scripts/lib/net-log"

// Node 24+ ships experimental native `localStorage` / `sessionStorage` globals that
// shadow jsdom's: `localStorage` is undefined without --localstorage-file, and the
// native `sessionStorage` does not inherit from jsdom's `Storage`. Stub both plus the
// `Storage` class with one in-memory implementation so the store tests below - and the
// `Storage.prototype.setItem` spies they rely on - see a single consistent Storage.
class MemoryStorage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
}

const memoryLocalStorage = new MemoryStorage()
const memorySessionStorage = new MemoryStorage()

beforeEach(() => {
  vi.stubGlobal("Storage", MemoryStorage)
  vi.stubGlobal("localStorage", memoryLocalStorage as unknown as Storage)
  vi.stubGlobal("sessionStorage", memorySessionStorage as unknown as Storage)
  memoryLocalStorage.clear()
  memorySessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("makeNetLogEntry", () => {
  it("upper-cases the method", () => {
    expect(makeNetLogEntry({ method: "get" }, 1).method).toBe("GET")
  })

  it("defaults the method to GET when missing", () => {
    expect(makeNetLogEntry({}, 1).method).toBe("GET")
  })

  it("redacts Xtream credentials from a /live/ path", () => {
    const entry = makeNetLogEntry({ url: "https://x.test/live/alice/hunter2/1.m3u8" }, 1)
    expect(entry.url).toBe("https://x.test/live/***/***/1.m3u8")
  })

  it("redacts username/password query params", () => {
    const entry = makeNetLogEntry({ url: "https://x.test/?username=alice&password=hunter2" }, 1)
    expect(entry.url).toBe("https://x.test/?username=***&password=***")
  })

  it("truncates the url to 200 characters", () => {
    const longUrl = `https://x.test/?q=${"a".repeat(300)}`
    const entry = makeNetLogEntry({ url: longUrl }, 1)
    expect(entry.url.length).toBe(200)
  })

  it("computes a rounded duration from start/end timestamps", () => {
    const entry = makeNetLogEntry({ startedAt: 1000, endedAt: 1123.6, status: 200 }, 1)
    expect(entry.durationMs).toBe(124)
  })

  it("falls back to a zero duration when a timestamp is missing", () => {
    expect(makeNetLogEntry({ status: 200 }, 1).durationMs).toBe(0)
    expect(makeNetLogEntry({ endedAt: 5000, status: 200 }, 1).durationMs).toBe(0)
    expect(makeNetLogEntry({ startedAt: 5000, status: 200 }, 1).durationMs).toBe(0)
  })

  it("derives outcome ok and ok=true for a 2xx status", () => {
    const entry = makeNetLogEntry({ status: 200 }, 1)
    expect(entry.outcome).toBe("ok")
    expect(entry.ok).toBe(true)
  })

  it("derives outcome ok but ok=false for a 404 status", () => {
    const entry = makeNetLogEntry({ status: 404 }, 1)
    expect(entry.outcome).toBe("ok")
    expect(entry.ok).toBe(false)
  })

  it("derives outcome ok but ok=false for a 500 status", () => {
    const entry = makeNetLogEntry({ status: 500 }, 1)
    expect(entry.outcome).toBe("ok")
    expect(entry.ok).toBe(false)
  })

  it("derives outcome error from a thrown error", () => {
    const entry = makeNetLogEntry({ error: new Error("boom") }, 1)
    expect(entry.outcome).toBe("error")
    expect(entry.ok).toBe(false)
    expect(entry.status).toBe(null)
  })

  it("honours an explicit aborted outcome", () => {
    const entry = makeNetLogEntry({ outcome: "aborted" }, 1)
    expect(entry.outcome).toBe("aborted")
    expect(entry.ok).toBe(false)
  })

  it("stringifies an Error via its message", () => {
    const entry = makeNetLogEntry({ error: new Error("connection refused") }, 1)
    expect(entry.error).toBe("connection refused")
  })

  it("stringifies a plain string error", () => {
    const entry = makeNetLogEntry({ error: "timed out" }, 1)
    expect(entry.error).toBe("timed out")
  })

  it("redacts and truncates the error message to 160 characters", () => {
    const entry = makeNetLogEntry(
      { error: new Error(`failed for https://x.test/?password=hunter2 ${"x".repeat(200)}`) },
      1,
    )
    expect(entry.error).not.toContain("hunter2")
    expect(entry.error!.length).toBe(160)
  })

  it("leaves status null when absent", () => {
    expect(makeNetLogEntry({}, 1).status).toBe(null)
  })

  it("does not set an error field when there is no error", () => {
    expect(makeNetLogEntry({ status: 200 }, 1).error).toBeUndefined()
  })
})

describe("pushWithCapacity", () => {
  it("does not drop while under capacity", () => {
    const entries: number[] = [1, 2]
    const dropped = pushWithCapacity(entries, 3, 5)
    expect(entries).toEqual([1, 2, 3])
    expect(dropped).toBe(0)
  })

  it("drops the oldest entry and preserves order once at capacity", () => {
    const entries: number[] = [1, 2, 3]
    const dropped = pushWithCapacity(entries, 4, 3)
    expect(entries).toEqual([2, 3, 4])
    expect(dropped).toBe(1)
  })

  it("can drop more than one entry when far over capacity", () => {
    const entries: number[] = [1, 2, 3, 4, 5]
    const dropped = pushWithCapacity(entries, 6, 2)
    expect(entries).toEqual([5, 6])
    expect(dropped).toBe(4)
  })

  it("keeps the array empty and reports the drop at capacity 0", () => {
    const entries: number[] = []
    const dropped = pushWithCapacity(entries, 1, 0)
    expect(entries).toEqual([])
    expect(dropped).toBe(1)
  })
})

describe("shouldRecordKind", () => {
  it("excludes image requests by default", () => {
    expect(shouldRecordKind("image", false)).toBe(false)
  })

  it("includes image requests when opted in", () => {
    expect(shouldRecordKind("image", true)).toBe(true)
  })

  it("always includes every other kind", () => {
    const kinds = ["api", "playlist", "epg", "media", "update", "other"] as const
    for (const kind of kinds) {
      expect(shouldRecordKind(kind, false)).toBe(true)
      expect(shouldRecordKind(kind, true)).toBe(true)
    }
  })
})

describe("network log store", () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  it("keeps the entry count at capacity and reports drops once over capacity", async () => {
    const { recordNetLog, getNetworkLog } = await import("../src/scripts/lib/net-log")
    for (let i = 0; i < NET_LOG_CAPACITY + 10; i++) {
      recordNetLog({ url: `https://x.test/${i}`, status: 200 })
    }
    const snapshot = getNetworkLog()
    expect(snapshot.entries.length).toBe(NET_LOG_CAPACITY)
    expect(snapshot.dropped).toBe(10)
    expect(snapshot.recorded).toBe(NET_LOG_CAPACITY + 10)
    expect(snapshot.entries[0].url).toBe("https://x.test/10")
  })

  it("returns a copy so mutating a returned entry does not affect a later read", async () => {
    const { recordNetLog, getNetworkLog } = await import("../src/scripts/lib/net-log")
    recordNetLog({ url: "https://x.test/1", status: 200 })
    const first = getNetworkLog()
    first.entries[0].url = "tampered"
    const second = getNetworkLog()
    expect(second.entries[0].url).toBe("https://x.test/1")
  })

  it("resets entries, dropped, and recorded counts on clear", async () => {
    const { recordNetLog, getNetworkLog, clearNetworkLog } = await import("../src/scripts/lib/net-log")
    recordNetLog({ url: "https://x.test/1", status: 200 })
    recordNetLog({ url: "https://x.test/2", status: 200 })
    clearNetworkLog()
    const snapshot = getNetworkLog()
    expect(snapshot.entries).toEqual([])
    expect(snapshot.dropped).toBe(0)
    expect(snapshot.recorded).toBe(0)
  })

  it("fires exactly one coalesced event for a burst of requests", async () => {
    vi.useFakeTimers()
    const { recordNetLog } = await import("../src/scripts/lib/net-log")
    const listener = vi.fn()
    document.addEventListener(NET_LOG_EVENT, listener)
    for (let i = 0; i < 100; i++) {
      recordNetLog({ url: `https://x.test/${i}`, status: 200 })
    }
    expect(listener).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(listener).toHaveBeenCalledTimes(1)
    document.removeEventListener(NET_LOG_EVENT, listener)
    vi.useRealTimers()
  })

  it("skips image requests by default and records them once opted in", async () => {
    const { recordNetLog, getNetworkLog, setNetLogIncludeImages, getNetLogIncludeImages } =
      await import("../src/scripts/lib/net-log")
    expect(getNetLogIncludeImages()).toBe(false)
    recordNetLog({ url: "https://x.test/logo.png", kind: "image", status: 200 })
    expect(getNetworkLog().entries.length).toBe(0)

    setNetLogIncludeImages(true)
    recordNetLog({ url: "https://x.test/logo.png", kind: "image", status: 200 })
    expect(getNetworkLog().entries.length).toBe(1)
  })

  it("persists the include-images preference across module reloads", async () => {
    const { setNetLogIncludeImages } = await import("../src/scripts/lib/net-log")
    setNetLogIncludeImages(true)
    vi.resetModules()
    const { getNetLogIncludeImages } = await import("../src/scripts/lib/net-log")
    expect(getNetLogIncludeImages()).toBe(true)
  })

  it("does not throw on a malformed input", async () => {
    const { recordNetLog, getNetworkLog } = await import("../src/scripts/lib/net-log")
    expect(() => recordNetLog(null as never)).not.toThrow()
    expect(() => recordNetLog({ url: 42 as never, method: {} as never })).not.toThrow()
    expect(getNetworkLog().entries.length).toBeGreaterThanOrEqual(0)
  })
})

describe("network log session persistence", () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  async function flushCoalescedTick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it("survives a simulated navigation via module re-import", async () => {
    const { recordNetLog } = await import("../src/scripts/lib/net-log")
    recordNetLog({ url: "https://x.test/1", status: 200 })
    recordNetLog({ url: "https://x.test/2", status: 200 })
    await flushCoalescedTick()

    vi.resetModules()
    const { getNetworkLog } = await import("../src/scripts/lib/net-log")
    const snapshot = getNetworkLog()
    expect(snapshot.entries.length).toBe(2)
    expect(snapshot.entries[0].url).toBe("https://x.test/1")
    expect(snapshot.entries[1].url).toBe("https://x.test/2")
    expect(snapshot.recorded).toBe(2)
  })

  it("clears the persisted copy so a later import sees nothing", async () => {
    const { recordNetLog, clearNetworkLog } = await import("../src/scripts/lib/net-log")
    recordNetLog({ url: "https://x.test/1", status: 200 })
    await flushCoalescedTick()
    clearNetworkLog()

    vi.resetModules()
    const { getNetworkLog } = await import("../src/scripts/lib/net-log")
    expect(getNetworkLog().entries).toEqual([])
  })

  it("ignores invalid JSON in the persisted copy and keeps recording", async () => {
    sessionStorage.setItem("xt_netlog_v1", "{not valid json")
    const { recordNetLog, getNetworkLog } = await import("../src/scripts/lib/net-log")
    expect(getNetworkLog().entries).toEqual([])
    recordNetLog({ url: "https://x.test/1", status: 200 })
    expect(getNetworkLog().entries.length).toBe(1)
  })

  it("ignores a persisted value of the wrong shape and keeps recording", async () => {
    sessionStorage.setItem("xt_netlog_v1", JSON.stringify({ entries: "not-an-array" }))
    const { recordNetLog, getNetworkLog } = await import("../src/scripts/lib/net-log")
    expect(getNetworkLog().entries).toEqual([])
    recordNetLog({ url: "https://x.test/1", status: 200 })
    expect(getNetworkLog().entries.length).toBe(1)
  })

  it("drops malformed entries from a persisted array while keeping valid ones", async () => {
    const validEntry = {
      seq: 1,
      startedAt: 1000,
      durationMs: 5,
      method: "GET",
      url: "https://x.test/1",
      kind: "other",
      transport: "native",
      status: 200,
      ok: true,
      outcome: "ok",
    }
    sessionStorage.setItem(
      "xt_netlog_v1",
      JSON.stringify({ entries: [validEntry, { garbage: true }, "nope"], recorded: 1, dropped: 0 }),
    )
    const { getNetworkLog } = await import("../src/scripts/lib/net-log")
    expect(getNetworkLog().entries).toEqual([validEntry])
  })

  it("keeps recording in memory when sessionStorage.setItem throws", async () => {
    const { recordNetLog, getNetworkLog } = await import("../src/scripts/lib/net-log")
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })

    expect(() => recordNetLog({ url: "https://x.test/1", status: 200 })).not.toThrow()
    await flushCoalescedTick()

    expect(getNetworkLog().entries.length).toBe(1)
    setItemSpy.mockRestore()
  })

  it("coalesces persistence writes to at most one setItem per tick for a burst of records", async () => {
    vi.useFakeTimers()
    const { recordNetLog } = await import("../src/scripts/lib/net-log")
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem")

    for (let i = 0; i < 100; i++) {
      recordNetLog({ url: `https://x.test/${i}`, status: 200 })
    }
    expect(setItemSpy).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    setItemSpy.mockRestore()
    vi.useRealTimers()
  })
})
