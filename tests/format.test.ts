import { describe, it, expect } from "vitest"
import { formatBehindLive } from "../src/scripts/lib/format"

describe("formatBehindLive", () => {
  it("renders zero as 0:00", () => {
    expect(formatBehindLive(0)).toBe("0:00")
  })

  it("clamps negative values to 0:00", () => {
    expect(formatBehindLive(-5000)).toBe("0:00")
  })

  it("renders seconds under a minute", () => {
    expect(formatBehindLive(59_000)).toBe("0:59")
  })

  it("renders minutes and seconds under an hour", () => {
    expect(formatBehindLive(83_000)).toBe("1:23")
  })

  it("renders hours, minutes, and seconds from an hour up", () => {
    expect(formatBehindLive(3_723_000)).toBe("1:02:03")
  })

  it("renders exactly one hour as 1:00:00", () => {
    expect(formatBehindLive(3_600_000)).toBe("1:00:00")
  })
})
