/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest"
import { retryDisableMsForStreak } from "@/scripts/tv/playback"

describe("retryDisableMsForStreak", () => {
  it("disables for 2s on the first failure", () => {
    expect(retryDisableMsForStreak(0)).toBe(2000)
  })

  it("doubles per consecutive failure", () => {
    expect(retryDisableMsForStreak(1)).toBe(4000)
    expect(retryDisableMsForStreak(2)).toBe(8000)
  })

  it("caps the backoff so it never grows unbounded", () => {
    expect(retryDisableMsForStreak(3)).toBe(16000)
    expect(retryDisableMsForStreak(10)).toBe(16000)
  })

  it("treats a negative streak the same as zero", () => {
    expect(retryDisableMsForStreak(-5)).toBe(2000)
  })
})
