import { describe, it, expect } from "vitest"
import { resolveZapTarget, type ZapChannel } from "@/scripts/tv/osd-zap"

describe("resolveZapTarget", () => {
  const channels: ZapChannel[] = [
    { id: "a" },
    { id: "b", chno: 50 },
    { id: "c" },
  ]

  it("resolves an exact chno match over list position", () => {
    expect(resolveZapTarget("50", channels)).toBe(channels[1])
  })

  it("falls back to a 1-based list index when no chno matches", () => {
    expect(resolveZapTarget("1", channels)).toBe(channels[0])
    expect(resolveZapTarget("3", channels)).toBe(channels[2])
  })

  it("strips leading zeros", () => {
    expect(resolveZapTarget("003", channels)).toBe(channels[2])
    expect(resolveZapTarget("050", channels)).toBe(channels[1])
  })

  it("returns null when the number is out of range", () => {
    expect(resolveZapTarget("99", channels)).toBeNull()
  })

  it("returns null for empty or non-numeric input", () => {
    expect(resolveZapTarget("", channels)).toBeNull()
    expect(resolveZapTarget("abc", channels)).toBeNull()
  })

  it("returns null for a negative number", () => {
    expect(resolveZapTarget("-1", channels)).toBeNull()
  })
})
