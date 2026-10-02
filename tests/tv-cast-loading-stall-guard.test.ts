import { describe, it, expect } from "vitest"
import { createCastLoadingStallGuard, castLoadingStallTimeoutMs } from "@/scripts/lib/tv-cast-state-feed"

const PLAY_REQUESTED_AT = 1_000_000

function frame(overrides: Partial<Parameters<ReturnType<typeof createCastLoadingStallGuard>["observe"]>[0]> = {}) {
  return {
    stateValue: "loading",
    playRequestedAtMs: PLAY_REQUESTED_AT,
    nowMs: PLAY_REQUESTED_AT + 500,
    isLive: false,
    ...overrides,
  }
}

describe("castLoadingStallTimeoutMs", () => {
  it("gives live a shorter timeout than VOD", () => {
    expect(castLoadingStallTimeoutMs(true)).toBeLessThan(castLoadingStallTimeoutMs(false))
  })
})

describe("createCastLoadingStallGuard", () => {
  it("stays false while loading is still within the VOD timeout", () => {
    const guard = createCastLoadingStallGuard()
    const timeoutMs = castLoadingStallTimeoutMs(false)
    expect(guard.observe(frame({ nowMs: PLAY_REQUESTED_AT + timeoutMs - 1 }))).toBe(false)
  })

  it("declares failure once VOD loading has sat past its timeout", () => {
    const guard = createCastLoadingStallGuard()
    const timeoutMs = castLoadingStallTimeoutMs(false)
    expect(guard.observe(frame({ nowMs: PLAY_REQUESTED_AT + timeoutMs }))).toBe(true)
  })

  it("uses the shorter live timeout when the session is live", () => {
    const guard = createCastLoadingStallGuard()
    const liveTimeoutMs = castLoadingStallTimeoutMs(true)
    const vodTimeoutMs = castLoadingStallTimeoutMs(false)
    expect(guard.observe(frame({ isLive: true, nowMs: PLAY_REQUESTED_AT + liveTimeoutMs - 1 }))).toBe(false)
    expect(guard.observe(frame({ isLive: true, nowMs: PLAY_REQUESTED_AT + liveTimeoutMs }))).toBe(true)
    expect(liveTimeoutMs).toBeLessThan(vodTimeoutMs)
  })

  it("cancels the pending judgment once a non-loading frame lands, even past the timeout later", () => {
    const guard = createCastLoadingStallGuard()
    const timeoutMs = castLoadingStallTimeoutMs(false)
    expect(guard.observe(frame({ stateValue: "playing", nowMs: PLAY_REQUESTED_AT + 1000 }))).toBe(false)
    expect(guard.observe(frame({ nowMs: PLAY_REQUESTED_AT + timeoutMs + 10_000 }))).toBe(false)
  })

  it("fires at most once per play request", () => {
    const guard = createCastLoadingStallGuard()
    const stalledAt = PLAY_REQUESTED_AT + castLoadingStallTimeoutMs(false)
    expect(guard.observe(frame({ nowMs: stalledAt }))).toBe(true)
    expect(guard.observe(frame({ nowMs: stalledAt + 5000 }))).toBe(false)
  })

  it("re-arms for the next play request", () => {
    const guard = createCastLoadingStallGuard()
    const stalledAt = PLAY_REQUESTED_AT + castLoadingStallTimeoutMs(false)
    expect(guard.observe(frame({ nowMs: stalledAt }))).toBe(true)

    const nextRequestedAt = PLAY_REQUESTED_AT + 600_000
    expect(guard.observe(frame({ playRequestedAtMs: nextRequestedAt, nowMs: nextRequestedAt + 500 }))).toBe(false)
    expect(
      guard.observe(
        frame({ playRequestedAtMs: nextRequestedAt, nowMs: nextRequestedAt + castLoadingStallTimeoutMs(false) })
      )
    ).toBe(true)
  })
})
