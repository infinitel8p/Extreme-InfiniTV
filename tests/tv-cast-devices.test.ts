/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  listTvDevices,
  saveTvDevice,
  removeTvDevice,
  touchTvDevice,
  validateDeviceInput,
  getCastSession,
  setCastSession,
  updateCastSession,
  clearCastSession,
  cacheReceiverLogSnapshot,
  getReceiverLogSnapshots,
  TV_DEVICES_EVENT,
  CAST_SESSION_EVENT,
  type TvDevice,
  type CastSession,
} from "@/scripts/lib/tv-cast"

// Node 24+ ships an experimental native `localStorage`/`sessionStorage` that shadows
// jsdom's; stub both with one in-memory Storage implementation (same pattern as
// tests/net-log.test.ts) so writes and reads land in a single consistent store.
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

function makeDevice(overrides: Partial<TvDevice> = {}): TvDevice {
  return {
    id: "device-1",
    name: "Living Room TV",
    host: "192.168.1.50",
    port: 8765,
    key: "secret-key",
    createdAt: 1000,
    lastSeenAt: 1000,
    ...overrides,
  }
}

describe("tv device store", () => {
  it("round-trips a saved device", () => {
    saveTvDevice(makeDevice())
    expect(listTvDevices()).toEqual([makeDevice()])
  })

  it("upserts by id instead of duplicating", () => {
    saveTvDevice(makeDevice())
    saveTvDevice(makeDevice({ name: "Bedroom TV", lastSeenAt: 2000 }))
    const devices = listTvDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0].name).toBe("Bedroom TV")
  })

  it("keeps distinct ids as separate entries", () => {
    saveTvDevice(makeDevice({ id: "device-1" }))
    saveTvDevice(makeDevice({ id: "device-2", name: "Kitchen TV" }))
    expect(listTvDevices()).toHaveLength(2)
  })

  it("removes a device by id", () => {
    saveTvDevice(makeDevice({ id: "device-1" }))
    saveTvDevice(makeDevice({ id: "device-2", name: "Kitchen TV" }))
    removeTvDevice("device-1")
    const devices = listTvDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0].id).toBe("device-2")
  })

  it("bumps lastSeenAt on touch", () => {
    saveTvDevice(makeDevice({ lastSeenAt: 1000 }))
    const before = Date.now()
    touchTvDevice("device-1")
    const devices = listTvDevices()
    expect(devices[0].lastSeenAt).toBeGreaterThanOrEqual(before)
  })

  it("no-ops touch for an unknown id", () => {
    saveTvDevice(makeDevice())
    touchTvDevice("does-not-exist")
    expect(listTvDevices()).toEqual([makeDevice()])
  })

  it("dispatches TV_DEVICES_EVENT on save, remove, and touch", () => {
    const listener = vi.fn()
    document.addEventListener(TV_DEVICES_EVENT, listener)
    saveTvDevice(makeDevice())
    touchTvDevice("device-1")
    removeTvDevice("device-1")
    document.removeEventListener(TV_DEVICES_EVENT, listener)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("tolerantly drops corrupt entries and recovers from invalid JSON", () => {
    localStorage.setItem("xt_tv_devices", "{not json")
    expect(listTvDevices()).toEqual([])

    localStorage.setItem(
      "xt_tv_devices",
      JSON.stringify([makeDevice(), { id: "bad", name: "missing fields" }, "not an object", null])
    )
    expect(listTvDevices()).toEqual([makeDevice()])
  })

  it("returns an empty list when storage holds a non-array value", () => {
    localStorage.setItem("xt_tv_devices", JSON.stringify({ not: "an array" }))
    expect(listTvDevices()).toEqual([])
  })
})

describe("validateDeviceInput", () => {
  it.each([
    ["192.168.1.50", 8765, "123456", true],
    ["living-room-tv.local", 8765, "654321", true],
    ["http://192.168.1.50", 8765, "123456", false],
    ["192.168.1.50/pair", 8765, "123456", false],
    ["192.168.1.50 ", 8765, "123456", true],
    ["", 8765, "123456", false],
  ])("host=%s port=%s code=%s -> ok=%s", (host, port, code, expectedOk) => {
    const result = validateDeviceInput({ host, port, code })
    expect(result.ok).toBe(expectedOk)
    if (!expectedOk) expect((result as { reason: string }).reason).toBe("host")
  })

  it.each([
    [0, false],
    [65536, false],
    [-1, false],
    [1, true],
    [65535, true],
    [8765, true],
  ])("port=%s -> ok=%s", (port, expectedOk) => {
    const result = validateDeviceInput({ host: "192.168.1.50", port, code: "123456" })
    expect(result.ok).toBe(expectedOk)
    if (!expectedOk) expect((result as { reason: string }).reason).toBe("port")
  })

  it("rejects a non-numeric port string", () => {
    const result = validateDeviceInput({ host: "192.168.1.50", port: "not-a-port", code: "123456" })
    expect(result).toEqual({ ok: false, reason: "port" })
  })

  it("accepts a numeric port passed as a string", () => {
    const result = validateDeviceInput({ host: "192.168.1.50", port: "8765", code: "123456" })
    expect(result).toEqual({ ok: true, host: "192.168.1.50", port: 8765, code: "123456" })
  })

  it.each([
    ["12345", false],
    ["1234567", false],
    ["abcdef", false],
    ["12a456", false],
    ["123456", true],
  ])("code=%s -> ok=%s", (code, expectedOk) => {
    const result = validateDeviceInput({ host: "192.168.1.50", port: 8765, code })
    expect(result.ok).toBe(expectedOk)
    if (!expectedOk) expect((result as { reason: string }).reason).toBe("code")
  })
})

describe("cast session store", () => {
  function makeSession(overrides: Partial<CastSession> = {}): CastSession {
    return {
      deviceId: "device-1",
      deviceName: "Living Room TV",
      host: "192.168.1.50",
      port: 8765,
      key: "secret-key",
      title: "Channel One",
      isLive: true,
      startedAt: 1000,
      ...overrides,
    }
  }

  it("returns null when no session is stored", () => {
    expect(getCastSession()).toBeNull()
  })

  it("round-trips a session", () => {
    setCastSession(makeSession())
    expect(getCastSession()).toEqual(makeSession())
  })

  it("patches an existing session, including the dismissed flag", () => {
    setCastSession(makeSession())
    updateCastSession({ dismissed: true })
    expect(getCastSession()).toEqual(makeSession({ dismissed: true }))
  })

  it("no-ops an update when there is no active session", () => {
    updateCastSession({ dismissed: true })
    expect(getCastSession()).toBeNull()
  })

  it("clears the session", () => {
    setCastSession(makeSession())
    clearCastSession()
    expect(getCastSession()).toBeNull()
  })

  it("dispatches CAST_SESSION_EVENT on set, update, and clear", () => {
    const listener = vi.fn()
    document.addEventListener(CAST_SESSION_EVENT, listener)
    setCastSession(makeSession())
    updateCastSession({ dismissed: true })
    clearCastSession()
    document.removeEventListener(CAST_SESSION_EVENT, listener)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("tolerantly returns null for corrupt session JSON", () => {
    sessionStorage.setItem("xt_cast_session", "{not json")
    expect(getCastSession()).toBeNull()
  })
})

describe("receiver log snapshots", () => {
  it("returns an empty object when nothing is cached", () => {
    expect(getReceiverLogSnapshots()).toEqual({})
  })

  it("caches and returns a snapshot by device name", () => {
    cacheReceiverLogSnapshot("Living Room TV", "boom at line 12\n")
    const snapshots = getReceiverLogSnapshots()
    expect(snapshots["Living Room TV"].text).toBe("boom at line 12\n")
    expect(typeof snapshots["Living Room TV"].at).toBe("string")
  })

  it("keeps snapshots for distinct devices separately", () => {
    cacheReceiverLogSnapshot("Living Room TV", "first")
    cacheReceiverLogSnapshot("Bedroom TV", "second")
    const snapshots = getReceiverLogSnapshots()
    expect(snapshots["Living Room TV"].text).toBe("first")
    expect(snapshots["Bedroom TV"].text).toBe("second")
  })

  it("overwrites a prior snapshot for the same device", () => {
    cacheReceiverLogSnapshot("Living Room TV", "first")
    cacheReceiverLogSnapshot("Living Room TV", "second")
    expect(getReceiverLogSnapshots()["Living Room TV"].text).toBe("second")
  })

  it("caps a snapshot at 64 KiB", () => {
    const oversized = "a".repeat(70 * 1024)
    cacheReceiverLogSnapshot("Living Room TV", oversized)
    const text = getReceiverLogSnapshots()["Living Room TV"].text
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(64 * 1024)
  })

  it("falls back to an in-memory cache when sessionStorage.setItem throws", () => {
    const setItemSpy = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    cacheReceiverLogSnapshot("Living Room TV", "still visible")
    setItemSpy.mockRestore()
    expect(getReceiverLogSnapshots()["Living Room TV"].text).toBe("still visible")
  })
})
