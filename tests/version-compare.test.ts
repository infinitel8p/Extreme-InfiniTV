import { describe, it, expect } from "vitest"
import { parseVersion, compareVersions } from "../src/scripts/lib/version-compare"

describe("parseVersion", () => {
  it("strips a leading v and splits on dots", () => {
    expect(parseVersion("v1.6.3")).toEqual([1, 6, 3])
    expect(parseVersion("1.6.3")).toEqual([1, 6, 3])
  })

  it("drops non-numeric pre-release suffixes", () => {
    expect(parseVersion("1.6.3-beta.2")).toEqual([1, 6, 3, 2])
    expect(parseVersion("2.0.0-rc")).toEqual([2, 0, 0])
  })

  it("returns an empty array for garbage", () => {
    expect(parseVersion("")).toEqual([])
    expect(parseVersion("nightly")).toEqual([])
  })
})

describe("compareVersions", () => {
  it("orders equal versions as 0", () => {
    expect(compareVersions("1.6.3", "1.6.3")).toBe(0)
    expect(compareVersions("v1.6.3", "1.6.3")).toBe(0)
  })

  it("treats a higher left as newer", () => {
    expect(compareVersions("1.6.3", "1.6.2")).toBe(1)
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1)
  })

  it("treats a lower left as older", () => {
    expect(compareVersions("1.6.2", "1.6.3")).toBe(-1)
  })

  // The classic string-compare trap: "1.10.0" must beat "1.9.0".
  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1)
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1)
  })

  it("pads missing trailing segments with zero", () => {
    expect(compareVersions("1.6", "1.6.0")).toBe(0)
    expect(compareVersions("1.6.1", "1.6")).toBe(1)
  })

  it("ranks a prerelease below its release version", () => {
    expect(compareVersions("1.6.4-beta.3", "1.6.4")).toBeLessThan(0)
    expect(compareVersions("1.6.4-beta2", "1.6.4")).toBeLessThan(0)
  })

  it("orders prerelease identifiers numerically, not lexically", () => {
    expect(compareVersions("1.6.4-beta.2", "1.6.4-beta.3")).toBeLessThan(0)
    expect(compareVersions("1.6.4-beta.9", "1.6.4-beta.10")).toBeLessThan(0)
  })

  it("compares the numeric core before the prerelease tag", () => {
    expect(compareVersions("1.6.3", "1.6.4-beta.1")).toBeLessThan(0)
    expect(compareVersions("1.6.4-beta.1", "1.6.5")).toBeLessThan(0)
  })

  it("treats a leading v the same as no prefix", () => {
    expect(compareVersions("v1.6.4-beta.3", "1.6.4-beta.3")).toBe(0)
  })

  it("compares alphanumeric prerelease identifiers lexically", () => {
    expect(compareVersions("1.6.4-alpha", "1.6.4-beta")).toBeLessThan(0)
  })

  it("treats a shorter prerelease identifier list as lower", () => {
    expect(compareVersions("1.6.4-beta", "1.6.4-beta.1")).toBeLessThan(0)
  })

  it("normalizes a dotless prerelease identifier like the dotted format", () => {
    expect(compareVersions("1.6.4-beta.3", "1.6.4-beta2")).toBeGreaterThan(0)
    expect(compareVersions("1.6.4-beta2", "1.6.4-beta.2")).toBe(0)
    expect(compareVersions("1.6.4-beta10", "1.6.4-beta.3")).toBeGreaterThan(0)
    expect(compareVersions("1.6.4", "1.6.4-beta2")).toBeGreaterThan(0)
  })
})
