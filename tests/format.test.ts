import { describe, it, expect } from "vitest"
import { formatBehindLive, formatPaddedHms, parseHmsToSeconds, ratingSortValue } from "../src/scripts/lib/format"

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

describe("formatPaddedHms", () => {
  it("zero-pads minutes and seconds under an hour", () => {
    expect(formatPaddedHms(65)).toBe("01:05")
  })

  it("rolls over into hours past 60 minutes", () => {
    expect(formatPaddedHms(3_660)).toBe("1:01:00")
  })

  it("clamps negative or non-finite totals to 00:00", () => {
    expect(formatPaddedHms(-5)).toBe("00:00")
    expect(formatPaddedHms(NaN)).toBe("00:00")
  })
})

describe("parseHmsToSeconds", () => {
  it("parses HH:MM:SS", () => {
    expect(parseHmsToSeconds("00:28:44")).toBe(1724)
  })

  it("parses MM:SS", () => {
    expect(parseHmsToSeconds("28:44")).toBe(1724)
  })

  it("returns 0 for a bare number with no colon", () => {
    expect(parseHmsToSeconds("1724")).toBe(0)
  })

  it("returns 0 for empty, null, or undefined input", () => {
    expect(parseHmsToSeconds("")).toBe(0)
    expect(parseHmsToSeconds(null)).toBe(0)
    expect(parseHmsToSeconds(undefined)).toBe(0)
  })

  it("returns 0 for unparseable clock strings", () => {
    expect(parseHmsToSeconds("not:a:time")).toBe(0)
    expect(parseHmsToSeconds("1:2:3:4")).toBe(0)
  })
})

describe("ratingSortValue", () => {
  it("returns 0 for an empty string", () => {
    expect(ratingSortValue("")).toBe(0)
  })

  it("parses a numeric string rating", () => {
    expect(ratingSortValue("7.2")).toBe(7.2)
  })

  it("returns 0 for garbage input", () => {
    expect(ratingSortValue("not-a-rating")).toBe(0)
  })

  it("returns 0 for null", () => {
    expect(ratingSortValue(null)).toBe(0)
  })

  it("returns 0 for a zero rating", () => {
    expect(ratingSortValue("0")).toBe(0)
  })

  it("accepts a number input", () => {
    expect(ratingSortValue(4.5)).toBe(4.5)
  })
})
