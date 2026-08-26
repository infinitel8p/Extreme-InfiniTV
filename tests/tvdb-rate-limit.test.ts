import { describe, it, expect, beforeEach } from "vitest"
import { rateLimitExceeded, resetRateLimits, retryAfterSeconds } from "@/scripts/lib/tvdb-rate-limit"

const WINDOW_MS = 60_000
const LIMIT = 120

beforeEach(() => {
  resetRateLimits()
})

describe("rateLimitExceeded", () => {
  it("allows traffic up to the limit and blocks past it", () => {
    for (let call = 1; call <= LIMIT; call++) {
      expect(rateLimitExceeded("1.2.3.4", 1_000)).toBe(false)
    }
    expect(rateLimitExceeded("1.2.3.4", 1_000)).toBe(true)
  })

  it("tracks each client independently", () => {
    for (let call = 1; call <= LIMIT + 1; call++) rateLimitExceeded("1.2.3.4", 1_000)
    expect(rateLimitExceeded("1.2.3.4", 1_000)).toBe(true)
    expect(rateLimitExceeded("5.6.7.8", 1_000)).toBe(false)
  })

  it("starts a fresh window once the old one elapses", () => {
    for (let call = 1; call <= LIMIT + 1; call++) rateLimitExceeded("1.2.3.4", 1_000)
    expect(rateLimitExceeded("1.2.3.4", 1_000)).toBe(true)
    expect(rateLimitExceeded("1.2.3.4", 1_000 + WINDOW_MS)).toBe(false)
  })

  it("never limits a request with no client ip", () => {
    for (let call = 1; call <= LIMIT * 2; call++) {
      expect(rateLimitExceeded("", 1_000)).toBe(false)
    }
  })

  it("does not grow without bound", () => {
    for (let client = 0; client < 6_000; client++) {
      rateLimitExceeded(`10.0.${Math.floor(client / 256)}.${client % 256}`, 1_000)
    }
    // Post-eviction the tracker still works rather than throwing or wedging.
    expect(rateLimitExceeded("10.0.0.1", 1_000)).toBe(false)
  })
})

describe("retryAfterSeconds", () => {
  it("reports the remaining window, at least one second", () => {
    rateLimitExceeded("1.2.3.4", 0)
    expect(retryAfterSeconds("1.2.3.4", 0)).toBe(60)
    expect(retryAfterSeconds("1.2.3.4", 59_500)).toBe(1)
    expect(retryAfterSeconds("1.2.3.4", WINDOW_MS)).toBe(1)
  })

  it("falls back to one second for an untracked client", () => {
    expect(retryAfterSeconds("9.9.9.9", 0)).toBe(1)
  })
})
