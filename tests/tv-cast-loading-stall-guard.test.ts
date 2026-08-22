import { describe, it, expect } from "vitest"
import { createCastLoadingStallGuard, CAST_LOADING_STALL_TIMEOUT_MS } from "@/scripts/lib/tv-cast-state-feed"

const PLAY_REQUESTED_AT = 1_000_000

function frame(overrides: Partial<Parameters<ReturnType<typeof createCastLoadingStallGuard>["observe"]>[0]> = {}) {
  return {
    stateValue: "loading",
    playRequestedAtMs: PLAY_REQUESTED_AT,
    nowMs: PLAY_REQUESTED_AT + 500,
    ...overrides,
  }
}

describe("createCastLoadingStallGuard", () => {
  it("stays false while loading is still within the timeout", () => {
    const guard = createCastLoadingStallGuard()
    expect(guard.observe(frame({ nowMs: PLAY_REQUESTED_AT + CAST_LOADING_STALL_TIMEOUT_MS - 1 }))).toBe(false)
  })

  it("declares failure once loading has sat past the timeout", () => {
    const guard = createCastLoadingStallGuard()
    expect(guard.observe(frame({ nowMs: PLAY_REQUESTED_AT + CAST_LOADING_STALL_TIMEOUT_MS }))).toBe(true)
  })

  it("cancels the pending judgment once a non-loading frame lands, even past the timeout later", () => {
    const guard = createCastLoadingStallGuard()
    expect(guard.observe(frame({ stateValue: "playing", nowMs: PLAY_REQUESTED_AT + 1000 }))).toBe(false)
    expect(guard.observe(frame({ nowMs: PLAY_REQUESTED_AT + CAST_LOADING_STALL_TIMEOUT_MS + 10_000 }))).toBe(false)
  })

  it("fires at most once per play request", () => {
    const guard = createCastLoadingStallGuard()
    const stalledAt = PLAY_REQUESTED_AT + CAST_LOADING_STALL_TIMEOUT_MS
    expect(guard.observe(frame({ nowMs: stalledAt }))).toBe(true)
    expect(guard.observe(frame({ nowMs: stalledAt + 5000 }))).toBe(false)
  })

  it("re-arms for the next play request", () => {
    const guard = createCastLoadingStallGuard()
    const stalledAt = PLAY_REQUESTED_AT + CAST_LOADING_STALL_TIMEOUT_MS
    expect(guard.observe(frame({ nowMs: stalledAt }))).toBe(true)

    const nextRequestedAt = PLAY_REQUESTED_AT + 600_000
    expect(guard.observe(frame({ playRequestedAtMs: nextRequestedAt, nowMs: nextRequestedAt + 500 }))).toBe(false)
    expect(
      guard.observe(frame({ playRequestedAtMs: nextRequestedAt, nowMs: nextRequestedAt + CAST_LOADING_STALL_TIMEOUT_MS }))
    ).toBe(true)
  })
})
