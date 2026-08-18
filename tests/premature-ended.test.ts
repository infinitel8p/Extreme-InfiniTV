import { describe, it, expect } from "vitest"
import { shouldTrustEndedEvent } from "../src/scripts/lib/premature-ended"

describe("shouldTrustEndedEvent", () => {
  it("distrusts the event while a recovery is in flight, even near the known end", () => {
    const result = shouldTrustEndedEvent({
      currentTimeSeconds: 1199,
      knownDurationSeconds: 1200,
      recoveryInFlight: true,
    })
    expect(result).toBe(false)
  })

  it("distrusts the event at 96% of a known duration", () => {
    const result = shouldTrustEndedEvent({
      currentTimeSeconds: 1152,
      knownDurationSeconds: 1200,
      recoveryInFlight: false,
    })
    expect(result).toBe(false)
  })

  it("trusts the event at 98% of a known duration", () => {
    const result = shouldTrustEndedEvent({
      currentTimeSeconds: 1176,
      knownDurationSeconds: 1200,
      recoveryInFlight: false,
    })
    expect(result).toBe(true)
  })

  it("trusts the event when the known duration is null", () => {
    const result = shouldTrustEndedEvent({
      currentTimeSeconds: 10,
      knownDurationSeconds: null,
      recoveryInFlight: false,
    })
    expect(result).toBe(true)
  })

  it("trusts the event when the known duration is 0", () => {
    const result = shouldTrustEndedEvent({
      currentTimeSeconds: 10,
      knownDurationSeconds: 0,
      recoveryInFlight: false,
    })
    expect(result).toBe(true)
  })

  it("trusts the event when the known duration is NaN", () => {
    const result = shouldTrustEndedEvent({
      currentTimeSeconds: 10,
      knownDurationSeconds: Number.NaN,
      recoveryInFlight: false,
    })
    expect(result).toBe(true)
  })
})
