import { describe, it, expect } from "vitest"
import {
  LIVE_RETURN_THRESHOLD_MS,
  WINDOW_START_MARGIN_MS,
  clampSeekTarget,
  splitMountStart,
  shouldReturnToLive,
} from "../src/scripts/lib/timeshift-math"

describe("clampSeekTarget", () => {
  const nowUtcMs = Date.UTC(2024, 0, 2, 12, 0, 0)
  const catchupWindowMs = 7 * 86_400_000

  it("clamps a past-window target to windowStart + margin", () => {
    const targetUtcMs = nowUtcMs - catchupWindowMs - 3600_000
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({
      kind: "shifted",
      targetUtcMs: nowUtcMs - catchupWindowMs + WINDOW_START_MARGIN_MS,
    })
  })

  it("resolves a future target to live", () => {
    const result = clampSeekTarget(nowUtcMs + 60_000, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({ kind: "live" })
  })

  it("resolves a target within the live threshold to live", () => {
    const result = clampSeekTarget(nowUtcMs - 30_000, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({ kind: "live" })
  })

  it("resolves a target just beyond the live threshold to shifted", () => {
    const targetUtcMs = nowUtcMs - (LIVE_RETURN_THRESHOLD_MS + 1000)
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({ kind: "shifted", targetUtcMs })
  })
})

describe("splitMountStart", () => {
  it("floors to the minute and returns the residual seek for minute granularity", () => {
    const targetUtcMs = Date.UTC(2024, 0, 1, 10, 7, 43)
    const result = splitMountStart(targetUtcMs, "minute")
    expect(result.mountStartUtcMs).toBe(Date.UTC(2024, 0, 1, 10, 7, 0))
    expect(result.seekSeconds).toBe(43)
  })

  it("returns zero residual for second granularity", () => {
    const targetUtcMs = Date.UTC(2024, 0, 1, 10, 7, 43)
    const result = splitMountStart(targetUtcMs, "second")
    expect(result.mountStartUtcMs).toBe(targetUtcMs)
    expect(result.seekSeconds).toBe(0)
  })

  it("keeps the Xtream flooring math in lockstep with the resolver", () => {
    const targetUtcMs = Date.UTC(2024, 0, 1, 10, 7, 43)
    const expectedMountStartUtcMs = Math.floor(targetUtcMs / 60_000) * 60_000
    expect(splitMountStart(targetUtcMs, "minute").mountStartUtcMs).toBe(expectedMountStartUtcMs)
  })
})

describe("shouldReturnToLive", () => {
  const nowUtcMs = 1_000_000

  it("returns true exactly at the threshold", () => {
    expect(shouldReturnToLive(nowUtcMs - LIVE_RETURN_THRESHOLD_MS, nowUtcMs)).toBe(true)
  })

  it("returns true when ahead of the live edge", () => {
    expect(shouldReturnToLive(nowUtcMs + 5000, nowUtcMs)).toBe(true)
  })

  it("returns false just beyond the threshold", () => {
    expect(shouldReturnToLive(nowUtcMs - LIVE_RETURN_THRESHOLD_MS - 1000, nowUtcMs)).toBe(false)
  })
})
