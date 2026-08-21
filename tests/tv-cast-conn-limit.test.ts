/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

const getActivePlaylistIdSyncMock = vi.fn()
const getConnectionLimitWarningMock = vi.fn()
vi.mock("@/scripts/lib/account-info.js", () => ({
  getActivePlaylistIdSync: (...args: unknown[]) => getActivePlaylistIdSyncMock(...args),
  getConnectionLimitWarning: (...args: unknown[]) => getConnectionLimitWarningMock(...args),
}))

const confirmDialogMock = vi.fn()
vi.mock("@/scripts/lib/confirm-dialog.js", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...args),
}))

const toastMock = vi.fn()
vi.mock("@/scripts/lib/toast.js", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}))

const openTvDevicePickerMock = vi.fn()
vi.mock("@/scripts/lib/tv-device-dialog.js", () => ({
  openTvDevicePicker: (...args: unknown[]) => openTvDevicePickerMock(...args),
}))

import {
  decideConnLimitGateAction,
  saveTvDevice,
  setCastSession,
  playOnTv,
  routePlayToCast,
  type TvDevice,
} from "@/scripts/lib/tv-cast"
import type { CastDescriptorV1 } from "@/scripts/lib/tv-cast-descriptor"

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
  getActivePlaylistIdSyncMock.mockReturnValue("playlist-1")
  getConnectionLimitWarningMock.mockReturnValue({ level: "crit", currentCons: 1, maxCons: 1 })
  providerFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
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

const liveDescriptor: CastDescriptorV1 = {
  v: 1,
  src: "https://provider.example/live.m3u8",
  mime: "application/x-mpegURL",
  isLive: true,
  title: "Channel One",
}

describe("decideConnLimitGateAction", () => {
  it("proceeds silently when the warning is unknown (M3U source or cold cache)", () => {
    expect(decideConnLimitGateAction(null)).toBe("proceed")
  })

  it("proceeds silently when well below the connection cap", () => {
    expect(decideConnLimitGateAction({ level: "ok", currentCons: 1, maxCons: 5 })).toBe("proceed")
  })

  it("shows a non-blocking toast when approaching the connection cap", () => {
    expect(decideConnLimitGateAction({ level: "warn", currentCons: 4, maxCons: 5 })).toBe("toast")
  })

  it("blocks with a confirm dialog when at or over the connection cap", () => {
    expect(decideConnLimitGateAction({ level: "crit", currentCons: 5, maxCons: 5 })).toBe("block-confirm")
  })
})

describe("connection-limit gate placement and frequency (castToDevice)", () => {
  it("blocks an initial live handoff at the crit level via confirm dialog, before the descriptor is built", async () => {
    confirmDialogMock.mockResolvedValue(false)
    openTvDevicePickerMock.mockResolvedValue(makeDevice())
    const buildDescriptor = vi.fn().mockResolvedValue(liveDescriptor)

    const result = await playOnTv({ holdsProviderConnection: true, buildDescriptor })

    expect(result).toBe(false)
    expect(confirmDialogMock).toHaveBeenCalledTimes(1)
    expect(buildDescriptor).not.toHaveBeenCalled()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("proceeds with the initial handoff once the user confirms past the crit gate", async () => {
    confirmDialogMock.mockResolvedValue(true)
    openTvDevicePickerMock.mockResolvedValue(makeDevice())

    const result = await playOnTv({ holdsProviderConnection: true, buildDescriptor: () => liveDescriptor })

    expect(result).toBe(true)
    expect(providerFetchMock).toHaveBeenCalled()
  })

  it("does not gate a plain VOD handoff that holds no provider connection", async () => {
    openTvDevicePickerMock.mockResolvedValue(makeDevice())

    const result = await playOnTv({
      buildDescriptor: () => ({ ...liveDescriptor, isLive: false }),
    })

    expect(result).toBe(true)
    expect(confirmDialogMock).not.toHaveBeenCalled()
    expect(getConnectionLimitWarningMock).not.toHaveBeenCalled()
  })

  it("skips the gate on a channel zap while already casting to this device - the receiver just swaps streams", async () => {
    const device = makeDevice()
    saveTvDevice(device)
    setCastSession({
      deviceId: device.id,
      deviceName: device.name,
      host: device.host,
      port: device.port,
      key: device.key,
      title: "Previous channel",
      isLive: true,
      startedAt: Date.now(),
    })

    const result = await routePlayToCast({ holdsProviderConnection: true, buildDescriptor: () => liveDescriptor })

    expect(result).toBe(true)
    expect(confirmDialogMock).not.toHaveBeenCalled()
    expect(getConnectionLimitWarningMock).not.toHaveBeenCalled()
  })

  it("still gates a fresh handoff to a different device while another cast session is active", async () => {
    saveTvDevice(makeDevice({ id: "device-2", name: "Other TV" }))
    setCastSession({
      deviceId: "device-1",
      deviceName: "Living Room TV",
      host: "192.168.1.50",
      port: 8765,
      key: "secret-key",
      title: "Previous channel",
      isLive: true,
      startedAt: Date.now(),
    })
    confirmDialogMock.mockResolvedValue(false)
    openTvDevicePickerMock.mockResolvedValue(makeDevice({ id: "device-2", name: "Other TV" }))
    const buildDescriptor = vi.fn().mockResolvedValue(liveDescriptor)

    const result = await playOnTv({ holdsProviderConnection: true, buildDescriptor })

    expect(result).toBe(false)
    expect(confirmDialogMock).toHaveBeenCalledTimes(1)
    expect(buildDescriptor).not.toHaveBeenCalled()
  })
})
