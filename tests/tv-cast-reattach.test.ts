/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

const discoverReceiversMock = vi.fn()
vi.mock("@/scripts/lib/receiver-discovery.ts", () => ({
  discoverReceivers: (...args: unknown[]) => discoverReceiversMock(...args),
}))

import {
  saveTvDevice,
  listTvDevices,
  setCastSession,
  clearCastSession,
  getCastSession,
  tryReattachCastSession,
  hasReattachableCastBackup,
  isReattachableBackup,
  isActivelyPlayingState,
  isCastRoutingActive,
  matchDiscoveredReceiver,
  type TvDevice,
  type CastSession,
  type CastSessionBackup,
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

const BACKUP_KEY = "xt_cast_session_backup_v1"
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
    ...overrides,
  }
}

function makeSession(overrides: Partial<CastSession> = {}): CastSession {
  return {
    deviceId: "device-1",
    deviceName: "Living Room TV",
    host: HOST_A,
    port: 8765,
    key: "secret-key",
    title: "Channel One",
    isLive: true,
    startedAt: 1000,
    ...overrides,
  }
}

function writeBackup(overrides: Partial<CastSessionBackup> = {}, sessionOverrides: Partial<CastSession> = {}): void {
  const backup: CastSessionBackup = { session: makeSession(sessionOverrides), savedAt: Date.now(), ...overrides }
  memoryLocalStorage.setItem(BACKUP_KEY, JSON.stringify(backup))
}

function networkFailure(): Promise<Response> {
  return Promise.reject(new TypeError("Failed to fetch"))
}

function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

/** Resolves discovery synchronously with the given list, mirroring the callback-based real API. */
function mockDiscoveryResult(list: unknown[]): void {
  discoverReceiversMock.mockImplementation((onFound: (list: unknown[]) => void, _timeoutMs: number, onDone?: (err: string | null) => void) => {
    onFound(list)
    onDone?.(null)
    return () => {}
  })
}

describe("isReattachableBackup", () => {
  const now = 1_700_000_000_000

  it("accepts a fresh, well-shaped backup", () => {
    const backup: CastSessionBackup = { session: makeSession(), savedAt: now - 1000 }
    expect(isReattachableBackup(backup, now)).toBe(true)
  })

  it("rejects a backup older than 12 hours", () => {
    const backup: CastSessionBackup = { session: makeSession(), savedAt: now - 12 * 60 * 60 * 1000 - 1 }
    expect(isReattachableBackup(backup, now)).toBe(false)
  })

  it("accepts a backup right at the 12-hour boundary", () => {
    const backup: CastSessionBackup = { session: makeSession(), savedAt: now - 12 * 60 * 60 * 1000 + 1 }
    expect(isReattachableBackup(backup, now)).toBe(true)
  })

  it("rejects a backup missing savedAt", () => {
    expect(isReattachableBackup({ session: makeSession() }, now)).toBe(false)
  })

  it("rejects a backup whose session is missing required fields", () => {
    expect(isReattachableBackup({ session: { deviceId: "device-1" }, savedAt: now }, now)).toBe(false)
  })

  it("rejects garbage input", () => {
    expect(isReattachableBackup(null, now)).toBe(false)
    expect(isReattachableBackup("nope", now)).toBe(false)
    expect(isReattachableBackup(42, now)).toBe(false)
  })
})

describe("hasReattachableCastBackup", () => {
  it("returns false when there is no backup", () => {
    expect(hasReattachableCastBackup()).toBe(false)
  })

  it("returns true for a fresh backup", () => {
    writeBackup()
    expect(hasReattachableCastBackup()).toBe(true)
  })

  it("returns false for an expired backup", () => {
    writeBackup({ savedAt: Date.now() - 13 * 60 * 60 * 1000 })
    expect(hasReattachableCastBackup()).toBe(false)
  })

  it("returns false for a malformed backup", () => {
    memoryLocalStorage.setItem(BACKUP_KEY, "{not json")
    expect(hasReattachableCastBackup()).toBe(false)
  })
})

describe("isActivelyPlayingState", () => {
  it.each([
    ["playing", true],
    ["paused", true],
    ["idle", false],
    ["error", false],
  ])("state=%s -> %s", (state, expected) => {
    expect(isActivelyPlayingState({ state, positionSeconds: 0 })).toBe(expected)
  })
})

describe("matchDiscoveredReceiver", () => {
  it("matches by receiver id when present", () => {
    const device = makeDevice({ id: "receiver-42" })
    const discovered = [
      { name: "Kitchen TV", host: "10.0.0.9", port: 8765, hosts: ["10.0.0.9"] },
      { name: "Wrong Name", host: HOST_B, port: 8765, id: "receiver-42", hosts: [HOST_B] },
    ]
    expect(matchDiscoveredReceiver(device, discovered)).toBe(discovered[1])
  })

  it("falls back to a name match when no id matches", () => {
    const device = makeDevice({ id: "device-1", name: "Living Room TV" })
    const discovered = [{ name: "Living Room TV", host: HOST_B, port: 8765, hosts: [HOST_B] }]
    expect(matchDiscoveredReceiver(device, discovered)).toBe(discovered[0])
  })

  it("returns null when nothing matches", () => {
    const device = makeDevice()
    const discovered = [{ name: "Kitchen TV", host: "10.0.0.9", port: 8765, hosts: ["10.0.0.9"] }]
    expect(matchDiscoveredReceiver(device, discovered)).toBeNull()
  })
})

describe("session backup mirroring", () => {
  it("mirrors setCastSession into the localStorage backup with a savedAt timestamp", () => {
    setCastSession(makeSession())
    const raw = memoryLocalStorage.getItem(BACKUP_KEY)
    expect(raw).not.toBeNull()
    const backup = JSON.parse(raw!)
    expect(backup.session).toEqual(makeSession())
    expect(typeof backup.savedAt).toBe("number")
  })

  it("removes the backup on clearCastSession", () => {
    setCastSession(makeSession())
    clearCastSession()
    expect(memoryLocalStorage.getItem(BACKUP_KEY)).toBeNull()
    expect(getCastSession()).toBeNull()
  })
})

describe("tryReattachCastSession", () => {
  it("returns null without probing when a live session already exists", async () => {
    setCastSession(makeSession())

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("returns null when there is no backup", async () => {
    const result = await tryReattachCastSession()
    expect(result).toBeNull()
  })

  it("discards a malformed backup and returns null", async () => {
    memoryLocalStorage.setItem(BACKUP_KEY, "{not json")

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(memoryLocalStorage.getItem(BACKUP_KEY)).toBeNull()
  })

  it("discards a backup older than 12 hours and returns null", async () => {
    writeBackup({ savedAt: Date.now() - 13 * 60 * 60 * 1000 })

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(memoryLocalStorage.getItem(BACKUP_KEY)).toBeNull()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("discards the backup when the device was unpaired", async () => {
    writeBackup()

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(memoryLocalStorage.getItem(BACKUP_KEY)).toBeNull()
  })

  it("restores the session when the paired device answers with active playback", async () => {
    saveTvDevice(makeDevice())
    writeBackup()
    providerFetchMock.mockResolvedValue(jsonResponse(200, { state: "playing", positionSeconds: 42 }))

    const result = await tryReattachCastSession()

    expect(result).not.toBeNull()
    expect(result!.deviceId).toBe("device-1")
    expect(result!.dismissed).toBe(false)
    expect(getCastSession()).toEqual(result)
    expect(discoverReceiversMock).not.toHaveBeenCalled()
  })

  it("keeps a dismissed session dismissed on reattach instead of resurrecting cast routing", async () => {
    saveTvDevice(makeDevice())
    writeBackup({}, { dismissed: true })
    providerFetchMock.mockResolvedValue(jsonResponse(200, { state: "playing", positionSeconds: 42 }))

    const result = await tryReattachCastSession()

    expect(result).not.toBeNull()
    expect(result!.dismissed).toBe(true)
    expect(getCastSession()).toEqual(result)
    expect(isCastRoutingActive()).toBe(false)
  })

  it("removes the backup and returns null when the receiver answers idle", async () => {
    saveTvDevice(makeDevice())
    writeBackup()
    providerFetchMock.mockResolvedValue(jsonResponse(200, { state: "idle", positionSeconds: 0 }))

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(memoryLocalStorage.getItem(BACKUP_KEY)).toBeNull()
    expect(getCastSession()).toBeNull()
  })

  it("rediscovers and reattaches when the pinned host is unreachable but a match is found", async () => {
    saveTvDevice(makeDevice())
    writeBackup()
    providerFetchMock.mockImplementation((url: string) => {
      if (url.includes(HOST_A)) return networkFailure()
      return Promise.resolve(jsonResponse(200, { state: "paused", positionSeconds: 10 }))
    })
    mockDiscoveryResult([{ name: "Living Room TV", host: HOST_B, port: 8765, hosts: [HOST_B] }])

    const result = await tryReattachCastSession()

    expect(result).not.toBeNull()
    expect(result!.host).toBe(HOST_B)
    expect(discoverReceiversMock).toHaveBeenCalledTimes(1)
    expect(listTvDevices()[0].host).toBe(HOST_B)
  })

  it("keeps the backup for a later retry when rediscovery finds no match (transient, not conclusive)", async () => {
    saveTvDevice(makeDevice())
    writeBackup()
    providerFetchMock.mockImplementation(() => networkFailure())
    mockDiscoveryResult([{ name: "Kitchen TV", host: "10.0.0.9", port: 8765, hosts: ["10.0.0.9"] }])

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(memoryLocalStorage.getItem(BACKUP_KEY)).not.toBeNull()
    expect(hasReattachableCastBackup()).toBe(true)
  })

  it("keeps the backup when rediscovery finds a match but it is still unreachable (transient)", async () => {
    saveTvDevice(makeDevice())
    writeBackup()
    providerFetchMock.mockImplementation(() => networkFailure())
    mockDiscoveryResult([{ name: "Living Room TV", host: HOST_B, port: 8765, hosts: [HOST_B] }])

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(memoryLocalStorage.getItem(BACKUP_KEY)).not.toBeNull()
  })

  it("does not persist the rediscovered host onto the paired device until its own probe confirms it", async () => {
    saveTvDevice(makeDevice())
    writeBackup()
    providerFetchMock.mockImplementation(() => networkFailure())
    mockDiscoveryResult([{ name: "Living Room TV", host: HOST_B, port: 8765, hosts: [HOST_B] }])

    await tryReattachCastSession()

    expect(listTvDevices()[0].host).toBe(HOST_A)
  })

  it("does not clobber a session started while the probe was in flight", async () => {
    saveTvDevice(makeDevice())
    writeBackup()
    const raceSession = makeSession({ deviceId: "device-2", title: "Race Channel" })
    providerFetchMock.mockImplementation(async () => {
      // Simulate the user (or another reattach) starting a session while our probe is still in flight.
      setCastSession(raceSession)
      return jsonResponse(200, { state: "playing", positionSeconds: 42 })
    })

    const result = await tryReattachCastSession()

    expect(result).toBeNull()
    expect(getCastSession()).toEqual(raceSession)
  })
})
