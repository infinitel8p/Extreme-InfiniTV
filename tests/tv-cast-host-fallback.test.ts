/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

import {
  saveTvDevice,
  listTvDevices,
  castPause,
  castSetVolume,
  fetchCastState,
  fetchCastStateWithFallback,
  probeTvDeviceAuthorized,
  pairTvDevice,
  parseCastStateValue,
  CastAuthError,
  type TvDevice,
} from "@/scripts/lib/tv-cast"

// Node 24+ ships an experimental native `localStorage`/`sessionStorage` that shadows
// jsdom's; stub both with one in-memory Storage implementation (same pattern as
// tests/tv-cast-devices.test.ts).
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
  vi.clearAllMocks()
  vi.stubGlobal("Storage", MemoryStorage)
  vi.stubGlobal("localStorage", memoryLocalStorage as unknown as Storage)
  vi.stubGlobal("sessionStorage", memorySessionStorage as unknown as Storage)
  memoryLocalStorage.clear()
  memorySessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const HOST_A = "192.168.1.50"
const HOST_B = "10.0.0.5"

function makeDevice(overrides: Partial<TvDevice> = {}): TvDevice {
  return {
    id: "device-1",
    name: "Living Room TV",
    host: HOST_A,
    port: 8765,
    key: "secret-key",
    createdAt: 1000,
    lastSeenAt: 1000,
    hosts: [HOST_A, HOST_B],
    pinnedHostIndex: 0,
    ...overrides,
  }
}

function networkFailure(): Promise<Response> {
  return Promise.reject(new TypeError("Failed to fetch"))
}

function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

describe("postDeviceAction host fallback (via castPause)", () => {
  it("walks to the next host on a network failure and pins the winner", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    providerFetchMock.mockImplementation((url: string) => {
      if (url.includes(HOST_A)) return networkFailure()
      return Promise.resolve(jsonResponse(200, { ok: true }))
    })

    await castPause(device)

    expect(providerFetchMock).toHaveBeenCalledTimes(2)
    expect(listTvDevices()[0].pinnedHostIndex).toBe(1)
  })

  it("does not walk on an HTTP-level failure; the host is alive but unhappy", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    providerFetchMock.mockResolvedValue(jsonResponse(500, { error: "boom" }))

    await expect(castPause(device)).rejects.toThrow()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
    expect(listTvDevices()[0].pinnedHostIndex).toBe(0)
  })

  it("does not walk on an auth failure and throws CastAuthError", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    providerFetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }))

    await expect(castPause(device)).rejects.toBeInstanceOf(CastAuthError)
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("castSetVolume", () => {
  it("posts the clamped level and muted flag to /volume", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    providerFetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await castSetVolume(device, 1.5, true)

    expect(providerFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = providerFetchMock.mock.calls[0]
    expect(url).toContain("/volume")
    expect(JSON.parse(init.body)).toEqual({ level: 1, muted: true })
  })

  it("clamps a negative level to 0", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    providerFetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await castSetVolume(device, -0.5, false)

    const [, init] = providerFetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ level: 0, muted: false })
  })
})

describe("parseCastStateValue", () => {
  it("parses a minimal valid payload", () => {
    expect(parseCastStateValue({ state: "playing", positionSeconds: 12 })).toEqual({
      state: "playing",
      positionSeconds: 12,
    })
  })

  it("accepts volume and muted when in range", () => {
    expect(parseCastStateValue({ state: "playing", positionSeconds: 12, volume: 0.4, muted: true })).toEqual({
      state: "playing",
      positionSeconds: 12,
      volume: 0.4,
      muted: true,
    })
  })

  it("drops an out-of-range volume", () => {
    const result = parseCastStateValue({ state: "playing", positionSeconds: 12, volume: 1.5 })
    expect(result?.volume).toBeUndefined()
  })

  it("drops a non-boolean muted field", () => {
    const result = parseCastStateValue({ state: "playing", positionSeconds: 12, muted: "yes" })
    expect(result?.muted).toBeUndefined()
  })

  it("returns null for a missing required field", () => {
    expect(parseCastStateValue({ positionSeconds: 12 })).toBeNull()
    expect(parseCastStateValue({ state: "playing" })).toBeNull()
  })

  it("returns null for garbage input", () => {
    expect(parseCastStateValue(null)).toBeNull()
    expect(parseCastStateValue("nope")).toBeNull()
    expect(parseCastStateValue(42)).toBeNull()
  })
})

describe("fetchCastState vs fetchCastStateWithFallback", () => {
  it("fetchCastState only tries the pinned host and returns null on a network failure", async () => {
    const device = makeDevice()
    providerFetchMock.mockImplementation(() => networkFailure())

    const state = await fetchCastState(device)

    expect(state).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })

  it("fetchCastStateWithFallback walks to the next host and pins it", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    providerFetchMock.mockImplementation((url: string) => {
      if (url.includes(HOST_A)) return networkFailure()
      return Promise.resolve(jsonResponse(200, { state: "playing", positionSeconds: 12 }))
    })

    const state = await fetchCastStateWithFallback(device)

    expect(state).toEqual({ state: "playing", positionSeconds: 12 })
    expect(listTvDevices()[0].pinnedHostIndex).toBe(1)
  })
})

describe("probeTvDeviceAuthorized host fallback", () => {
  it("walks past a dead pinned host and reports online from the next one", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    providerFetchMock.mockImplementation((url: string) => {
      if (url.includes(HOST_A)) return networkFailure()
      return Promise.resolve(jsonResponse(200, {}))
    })

    const result = await probeTvDeviceAuthorized(device)

    expect(result).toBe("online")
    expect(listTvDevices()[0].pinnedHostIndex).toBe(1)
  })
})

describe("pairTvDevice host fallback", () => {
  it("pairs against the first reachable candidate host and remembers the full list", async () => {
    providerFetchMock.mockImplementation((url: string) => {
      if (url.includes(HOST_A)) return networkFailure()
      return Promise.resolve(jsonResponse(200, { key: "new-key", name: "Living Room TV" }))
    })

    const device = await pairTvDevice({ host: HOST_A, port: 8765, code: "123456", hosts: [HOST_A, HOST_B] })

    expect(device.host).toBe(HOST_B)
    expect(device.hosts).toEqual([HOST_A, HOST_B])
    expect(device.pinnedHostIndex).toBe(1)
  })
})
