import { describe, it, expect } from "vitest"
import { computeRootFontSizePx } from "../src/scripts/tv/root-font-size"

describe("computeRootFontSizePx", () => {
  it("fits the 60rem x 33.75rem design canvas to a 1080p viewport", () => {
    // 1920/60 = 32, 1080/33.75 = 32 - exact fit at this resolution.
    expect(computeRootFontSizePx(1920, 1080, 1)).toBe(32)
  })

  it("picks the narrower axis when width and height don't match the canvas ratio", () => {
    // Width-bound: 1280/60 ~= 21.33 vs 1080/33.75 = 32.
    expect(computeRootFontSizePx(1280, 1080, 1)).toBeCloseTo(1280 / 60, 5)
  })

  it("applies the font scale multiplier", () => {
    expect(computeRootFontSizePx(1920, 1080, 1.25)).toBe(40)
  })

  it("never goes below the 12px floor on a tiny viewport", () => {
    expect(computeRootFontSizePx(320, 200, 1)).toBe(12)
  })
})
