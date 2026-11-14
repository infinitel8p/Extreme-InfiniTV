import { describe, expect, it } from "vitest"
import {
  EPG_MIN_COVERAGE_MS,
  EPG_REUSE_MAX_AGE_MS,
  programmeHorizonMs,
  shouldReuseCachedEpg,
} from "@/scripts/lib/epg-cache-policy.ts"

describe("programmeHorizonMs", () => {
  it("returns -Infinity for empty input", () => {
    expect(programmeHorizonMs([])).toBe(-Infinity)
  })

  it("returns the single channel's max stop", () => {
    const entries: Array<[string, Array<{ start: number; stop: number }>]> = [
      ["channel1", [{ start: 1000, stop: 2000 }, { start: 2000, stop: 3000 }]],
    ]
    expect(programmeHorizonMs(entries)).toBe(3000)
  })

  it("finds the max stop even when it is not the last element", () => {
    const entries: Array<[string, Array<{ start: number; stop: number }>]> = [
      ["channel1", [{ start: 1000, stop: 50000 }, { start: 2000, stop: 3000 }]],
    ]
    expect(programmeHorizonMs(entries)).toBe(50000)
  })

  it("scans across multiple channels for the overall max stop", () => {
    const entries: Array<[string, Array<{ start: number; stop: number }>]> = [
      ["channel1", [{ start: 1000, stop: 2000 }]],
      ["channel2", [{ start: 1500, stop: 5000 }]],
      ["channel3", [{ start: 500, stop: 1200 }]],
    ]
    expect(programmeHorizonMs(entries)).toBe(5000)
  })
})

describe("shouldReuseCachedEpg", () => {
  const nowMs = 1_000_000_000_000

  it("reuses a fresh cache entry with enough forward coverage", () => {
    expect(
      shouldReuseCachedEpg({
        fetchedAtMs: nowMs - 60_000,
        horizonMs: nowMs + EPG_MIN_COVERAGE_MS + 60_000,
        nowMs,
      })
    ).toBe(true)
  })

  it("rejects a cache entry older than the max age", () => {
    expect(
      shouldReuseCachedEpg({
        fetchedAtMs: nowMs - (EPG_REUSE_MAX_AGE_MS + 60_000),
        horizonMs: nowMs + EPG_MIN_COVERAGE_MS + 60_000,
        nowMs,
      })
    ).toBe(false)
  })

  it("rejects a cache entry that covers less than the minimum coverage ahead", () => {
    expect(
      shouldReuseCachedEpg({
        fetchedAtMs: nowMs - 60_000,
        horizonMs: nowMs + EPG_MIN_COVERAGE_MS - 60_000,
        nowMs,
      })
    ).toBe(false)
  })

  it("rejects an empty (-Infinity) horizon", () => {
    expect(
      shouldReuseCachedEpg({
        fetchedAtMs: nowMs - 60_000,
        horizonMs: -Infinity,
        nowMs,
      })
    ).toBe(false)
  })

  it("rejects a fetchedAt timestamp in the future", () => {
    expect(
      shouldReuseCachedEpg({
        fetchedAtMs: nowMs + 60_000,
        horizonMs: nowMs + EPG_MIN_COVERAGE_MS + 60_000,
        nowMs,
      })
    ).toBe(false)
  })

  it("rejects at the exact max-age boundary", () => {
    expect(
      shouldReuseCachedEpg({
        fetchedAtMs: nowMs - EPG_REUSE_MAX_AGE_MS,
        horizonMs: nowMs + EPG_MIN_COVERAGE_MS + 60_000,
        nowMs,
      })
    ).toBe(false)
  })
})
