import { describe, it, expect } from "vitest"
import { deriveProviderStatsFromNetLog } from "../src/scripts/lib/playlist-health"
import type { NetLogEntry } from "../src/scripts/lib/net-log"

function entry(overrides: Partial<NetLogEntry>): NetLogEntry {
  return {
    seq: 1,
    startedAt: 1000,
    durationMs: 50,
    method: "GET",
    url: "https://x.test/api",
    kind: "api",
    transport: "native",
    status: 200,
    ok: true,
    outcome: "ok",
    ...overrides,
  }
}

describe("deriveProviderStatsFromNetLog", () => {
  it("returns all-null/zero for an empty log", () => {
    const result = deriveProviderStatsFromNetLog([])
    expect(result).toEqual({
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: "",
      successes: 0,
      failures: 0,
    })
  })

  it("counts ok entries as successes and tracks the latest end time", () => {
    const entries = [
      entry({ seq: 1, startedAt: 1000, durationMs: 100 }),
      entry({ seq: 2, startedAt: 5000, durationMs: 200 }),
    ]
    const result = deriveProviderStatsFromNetLog(entries)
    expect(result.successes).toBe(2)
    expect(result.failures).toBe(0)
    expect(result.lastSuccessAt).toBe(5200)
  })

  it("counts error entries as failures and captures the latest error message", () => {
    const entries = [
      entry({ seq: 1, startedAt: 1000, durationMs: 50, outcome: "error", ok: false, status: null, error: "first" }),
      entry({ seq: 2, startedAt: 4000, durationMs: 50, outcome: "error", ok: false, status: null, error: "second" }),
    ]
    const result = deriveProviderStatsFromNetLog(entries)
    expect(result.failures).toBe(2)
    expect(result.successes).toBe(0)
    expect(result.lastFailureAt).toBe(4050)
    expect(result.lastError).toBe("second")
  })

  it("ignores aborted entries entirely", () => {
    const entries = [entry({ outcome: "aborted", ok: false, status: null })]
    const result = deriveProviderStatsFromNetLog(entries)
    expect(result.successes).toBe(0)
    expect(result.failures).toBe(0)
  })

  it("mixes successes and failures independently", () => {
    const entries = [
      entry({ seq: 1, startedAt: 1000, durationMs: 10 }),
      entry({ seq: 2, startedAt: 2000, durationMs: 10, outcome: "error", ok: false, status: null, error: "boom" }),
      entry({ seq: 3, startedAt: 3000, durationMs: 10 }),
    ]
    const result = deriveProviderStatsFromNetLog(entries)
    expect(result.successes).toBe(2)
    expect(result.failures).toBe(1)
    expect(result.lastSuccessAt).toBe(3010)
    expect(result.lastFailureAt).toBe(2010)
    expect(result.lastError).toBe("boom")
  })
})
