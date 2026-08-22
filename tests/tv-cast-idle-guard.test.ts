/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

import { createIdleTeardownGuard, IDLE_TEARDOWN_GRACE_MS } from "@/scripts/lib/tv-cast-state-feed"
import { castPlay, isCastPlaySettling, CAST_PLAY_SETTLE_MS, type TvDevice } from "@/scripts/lib/tv-cast"
import type { CastDescriptorV1 } from "@/scripts/lib/tv-cast-descriptor"

const SESSION_START = 1_000_000

function guardInput(overrides: Partial<Parameters<ReturnType<typeof createIdleTeardownGuard>["allowsTeardown"]>[0]> = {}) {
  return {
    stateValue: "idle",
    sessionStartedAtMs: SESSION_START,
    nowMs: SESSION_START + 500,
    playPending: false,
    ...overrides,
  }
}

describe("createIdleTeardownGuard", () => {
  it("ignores the stale idle a fresh cast gets before the receiver reports loading", () => {
    const guard = createIdleTeardownGuard()
    expect(guard.allowsTeardown(guardInput())).toBe(false)
  })

  it("ignores idle while a /play is settling even after real playback was seen", () => {
    const guard = createIdleTeardownGuard()
    guard.allowsTeardown(guardInput({ stateValue: "playing" }))
    expect(guard.allowsTeardown(guardInput({ playPending: true }))).toBe(false)
  })

  it("trusts idle once playback was seen for this session", () => {
    const guard = createIdleTeardownGuard()
    guard.allowsTeardown(guardInput({ stateValue: "playing" }))
    expect(guard.allowsTeardown(guardInput())).toBe(true)
  })

  it("trusts idle from a receiver that never played once the grace window passed", () => {
    const guard = createIdleTeardownGuard()
    expect(guard.allowsTeardown(guardInput({ nowMs: SESSION_START + IDLE_TEARDOWN_GRACE_MS }))).toBe(true)
  })

  it("never reports teardown for a non-idle frame", () => {
    const guard = createIdleTeardownGuard()
    for (const stateValue of ["loading", "buffering", "playing", "paused", "error", "ended"]) {
      expect(guard.allowsTeardown(guardInput({ stateValue, nowMs: SESSION_START + 60_000 }))).toBe(false)
    }
  })

  it("re-arms the grace for the next cast, so an engine-swap idle can't kill the new session", () => {
    const guard = createIdleTeardownGuard()
    guard.allowsTeardown(guardInput({ stateValue: "playing" }))
    const nextStart = SESSION_START + 90_000
    expect(guard.allowsTeardown({
      stateValue: "idle",
      sessionStartedAtMs: nextStart,
      nowMs: nextStart + 200,
      playPending: false,
    })).toBe(false)
  })

  it("replays the observed episode-cast frame order without tearing the new session down", () => {
    const guard = createIdleTeardownGuard()
    const firstEpisode = [
      { stateValue: "loading", sessionStartedAtMs: SESSION_START, nowMs: SESSION_START + 100, playPending: true },
      { stateValue: "playing", sessionStartedAtMs: SESSION_START, nowMs: SESSION_START + 2000, playPending: false },
    ]
    for (const frame of firstEpisode) expect(guard.allowsTeardown(frame)).toBe(false)

    // Next episode: the receiver tears its old engine down and reports idle mid-/play.
    const nextStart = SESSION_START + 600_000
    const nextEpisode = [
      { stateValue: "idle", sessionStartedAtMs: nextStart, nowMs: nextStart + 30, playPending: true },
      { stateValue: "loading", sessionStartedAtMs: nextStart, nowMs: nextStart + 400, playPending: true },
      { stateValue: "playing", sessionStartedAtMs: nextStart, nowMs: nextStart + 1500, playPending: false },
    ]
    for (const frame of nextEpisode) expect(guard.allowsTeardown(frame)).toBe(false)

    // A real stop later on still clears the session.
    expect(
      guard.allowsTeardown({
        stateValue: "idle",
        sessionStartedAtMs: nextStart,
        nowMs: nextStart + 120_000,
        playPending: false,
      })
    ).toBe(true)
  })
})

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

const DEVICE: TvDevice = {
  id: "device-1",
  name: "Living Room TV",
  host: "192.168.1.50",
  port: 8765,
  key: "secret-key",
  createdAt: 1000,
  lastSeenAt: 1000,
}

const DESCRIPTOR: CastDescriptorV1 = {
  v: 1,
  src: "https://provider.example/episode.mp4",
  mime: "video/mp4",
  isLive: false,
  title: "S01E02",
}

describe("isCastPlaySettling", () => {
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

  it("stays false before any cast", () => {
    expect(isCastPlaySettling(0)).toBe(false)
  })

  it("is true while the /play request is in flight and through the settle window after it", async () => {
    let releasePlay: (value: unknown) => void = () => {}
    providerFetchMock.mockImplementation(
      () => new Promise((resolve) => {
        releasePlay = resolve
      })
    )

    const played = castPlay(DEVICE, DESCRIPTOR)
    expect(isCastPlaySettling()).toBe(true)

    releasePlay({ ok: true, status: 200, json: () => Promise.resolve({}) })
    await played

    const settledAt = Date.now()
    expect(isCastPlaySettling(settledAt)).toBe(true)
    expect(isCastPlaySettling(settledAt + CAST_PLAY_SETTLE_MS)).toBe(false)
  })
})
