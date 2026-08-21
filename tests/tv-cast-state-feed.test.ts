/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const getCastSessionMock = vi.fn()
const sessionAsDeviceMock = vi.fn()
const fetchCastStateMock = vi.fn()
const fetchCastStateWithFallbackMock = vi.fn()

vi.mock("@/scripts/lib/tv-cast.js", async () => {
  const actual = await vi.importActual<typeof import("@/scripts/lib/tv-cast")>("@/scripts/lib/tv-cast.js")
  return {
    ...actual,
    getCastSession: (...args: unknown[]) => getCastSessionMock(...args),
    sessionAsDevice: (...args: unknown[]) => sessionAsDeviceMock(...args),
    fetchCastState: (...args: unknown[]) => fetchCastStateMock(...args),
    fetchCastStateWithFallback: (...args: unknown[]) => fetchCastStateWithFallbackMock(...args),
  }
})

import {
  subscribeCastStateFeed,
  effectiveCadence,
  parseFeedMessage,
  nextMissState,
  MAX_CONSECUTIVE_MISSES,
} from "@/scripts/lib/tv-cast-state-feed"

const SESSION = {
  deviceId: "device-1",
  deviceName: "Living Room TV",
  host: "192.168.1.50",
  port: 8765,
  key: "secret-key",
  title: "Channel One",
  isLive: false,
  startedAt: 1000,
}

const DEVICE = {
  id: "device-1",
  name: "Living Room TV",
  host: "192.168.1.50",
  port: 8765,
  key: "secret-key",
  createdAt: 0,
  lastSeenAt: 0,
}

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom's WebSocket attempts a real connection; force the "unsupported" branch so
  // transport-wiring tests exercise the polling fallback deterministically.
  vi.stubGlobal("WebSocket", undefined)
  getCastSessionMock.mockReset().mockReturnValue(SESSION)
  sessionAsDeviceMock.mockReset().mockReturnValue(DEVICE)
  fetchCastStateMock.mockReset()
  fetchCastStateWithFallbackMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("effectiveCadence", () => {
  it("returns Infinity when there are no subscribers", () => {
    expect(effectiveCadence([])).toBe(Infinity)
  })

  it("returns the fastest requested cadence", () => {
    expect(effectiveCadence([2000, 500, 1000])).toBe(500)
  })

  it("returns the single cadence for one subscriber", () => {
    expect(effectiveCadence([2000])).toBe(2000)
  })
})

describe("parseFeedMessage", () => {
  it("parses a valid state frame", () => {
    expect(parseFeedMessage(JSON.stringify({ state: "playing", positionSeconds: 42 }))).toEqual({
      state: "playing",
      positionSeconds: 42,
    })
  })

  it("carries volume and muted through", () => {
    expect(
      parseFeedMessage(JSON.stringify({ state: "paused", positionSeconds: 5, volume: 0.6, muted: false }))
    ).toEqual({ state: "paused", positionSeconds: 5, volume: 0.6, muted: false })
  })

  it("returns null for malformed JSON", () => {
    expect(parseFeedMessage("{not json")).toBeNull()
  })

  it("returns null for well-formed JSON missing required fields", () => {
    expect(parseFeedMessage(JSON.stringify({ positionSeconds: 5 }))).toBeNull()
  })

  it("returns null for a JSON primitive", () => {
    expect(parseFeedMessage("42")).toBeNull()
  })
})

describe("nextMissState", () => {
  it("resets the count to zero on a hit", () => {
    expect(nextMissState(2, true)).toEqual({ count: 0, lost: false })
  })

  it("increments the count on a miss without giving up early", () => {
    expect(nextMissState(0, false)).toEqual({ count: 1, lost: false })
    expect(nextMissState(1, false)).toEqual({ count: 2, lost: false })
  })

  it("flags lost once the max miss count is reached", () => {
    expect(nextMissState(2, false)).toEqual({ count: 3, lost: true })
  })

  it("honors a custom max miss count", () => {
    expect(nextMissState(0, false, 1)).toEqual({ count: 1, lost: true })
  })
})

describe("subscribeCastStateFeed transport wiring", () => {
  it("falls back to polling when WebSocket is unavailable and delivers state to the subscriber", async () => {
    fetchCastStateMock.mockResolvedValue({ state: "playing", positionSeconds: 5 })
    const listener = vi.fn()
    const unsubscribe = subscribeCastStateFeed(listener, { cadenceMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)

    expect(fetchCastStateMock).toHaveBeenCalled()
    expect(listener).toHaveBeenCalledWith({ state: "playing", positionSeconds: 5 })

    unsubscribe()
  })

  it("calls onLost after MAX_CONSECUTIVE_MISSES consecutive poll misses", async () => {
    fetchCastStateMock.mockResolvedValue(null)
    fetchCastStateWithFallbackMock.mockResolvedValue(null)
    const listener = vi.fn()
    const onLost = vi.fn()
    const unsubscribe = subscribeCastStateFeed(listener, { cadenceMs: 1000, onLost })

    for (let tick = 0; tick < MAX_CONSECUTIVE_MISSES; tick++) {
      await vi.advanceTimersByTimeAsync(1000)
    }

    expect(onLost).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()

    unsubscribe()
  })

  it("stops fetching once the subscriber unsubscribes", async () => {
    fetchCastStateMock.mockResolvedValue({ state: "playing", positionSeconds: 1 })
    const listener = vi.fn()
    const unsubscribe = subscribeCastStateFeed(listener, { cadenceMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    unsubscribe()
    fetchCastStateMock.mockClear()

    await vi.advanceTimersByTimeAsync(3000)

    expect(fetchCastStateMock).not.toHaveBeenCalled()
  })
})

describe("subscribeCastStateFeed onHealth transitions", () => {
  it("reports the poll transport with zero misses on a hit", async () => {
    fetchCastStateMock.mockResolvedValue({ state: "playing", positionSeconds: 1 })
    const onHealth = vi.fn()
    const unsubscribe = subscribeCastStateFeed(vi.fn(), { cadenceMs: 1000, onHealth })

    await vi.advanceTimersByTimeAsync(1000)

    expect(onHealth).toHaveBeenCalledWith({ consecutiveMisses: 0, transport: "poll" })

    unsubscribe()
  })

  it("increments consecutiveMisses on each poll miss", async () => {
    fetchCastStateMock.mockResolvedValue(null)
    fetchCastStateWithFallbackMock.mockResolvedValue(null)
    const onHealth = vi.fn()
    const unsubscribe = subscribeCastStateFeed(vi.fn(), { cadenceMs: 1000, onHealth, onLost: vi.fn() })

    await vi.advanceTimersByTimeAsync(1000)
    expect(onHealth).toHaveBeenLastCalledWith({ consecutiveMisses: 1, transport: "poll" })

    await vi.advanceTimersByTimeAsync(1000)
    expect(onHealth).toHaveBeenLastCalledWith({ consecutiveMisses: 2, transport: "poll" })

    unsubscribe()
  })

  it("does not re-emit an unchanged health snapshot", async () => {
    fetchCastStateMock.mockResolvedValue({ state: "playing", positionSeconds: 1 })
    const onHealth = vi.fn()
    const unsubscribe = subscribeCastStateFeed(vi.fn(), { cadenceMs: 1000, onHealth })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(onHealth).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it("resets consecutiveMisses to zero once a miss streak recovers", async () => {
    fetchCastStateMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "playing", positionSeconds: 2 })
    const onHealth = vi.fn()
    const unsubscribe = subscribeCastStateFeed(vi.fn(), { cadenceMs: 1000, onHealth })

    await vi.advanceTimersByTimeAsync(1000)
    expect(onHealth).toHaveBeenLastCalledWith({ consecutiveMisses: 1, transport: "poll" })

    await vi.advanceTimersByTimeAsync(1000)
    expect(onHealth).toHaveBeenLastCalledWith({ consecutiveMisses: 0, transport: "poll" })

    unsubscribe()
  })
})
