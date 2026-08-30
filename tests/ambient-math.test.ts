import { describe, it, expect } from "vitest"
import {
  dominantColor,
  rgbToOklch,
  toAmbient,
  ambientCss,
  blendTowardSlate,
} from "../src/scripts/lib/ambient-math"

function solidRgba(width: number, height: number, r: number, g: number, b: number, alpha = 255): Uint8ClampedArray {
  const bytes = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    bytes[i * 4] = r
    bytes[i * 4 + 1] = g
    bytes[i * 4 + 2] = b
    bytes[i * 4 + 3] = alpha
  }
  return bytes
}

describe("dominantColor", () => {
  it("returns the saturated colour of a mostly-red image", () => {
    const bytes = solidRgba(4, 4, 220, 40, 40)
    const result = dominantColor(bytes, 4, 4)
    expect(result).not.toBeNull()
    expect(result!.r).toBeGreaterThan(result!.g)
    expect(result!.r).toBeGreaterThan(result!.b)
  })

  it("picks the larger of two colour blocks", () => {
    const bytes = new Uint8ClampedArray(8 * 4 * 4)
    for (let i = 0; i < 8 * 4; i++) {
      const isBlue = i < 8
      bytes[i * 4] = isBlue ? 30 : 200
      bytes[i * 4 + 1] = isBlue ? 30 : 180
      bytes[i * 4 + 2] = isBlue ? 200 : 30
      bytes[i * 4 + 3] = 255
    }
    const result = dominantColor(bytes, 8, 4)
    expect(result).not.toBeNull()
    expect(result!.r).toBeGreaterThan(result!.b)
  })

  it("returns null for a solid black image", () => {
    expect(dominantColor(solidRgba(4, 4, 0, 0, 0), 4, 4)).toBeNull()
  })

  it("returns null for a solid white image", () => {
    expect(dominantColor(solidRgba(4, 4, 255, 255, 255), 4, 4)).toBeNull()
  })

  it("returns null for a solid grey (monochrome) image", () => {
    expect(dominantColor(solidRgba(4, 4, 128, 128, 128), 4, 4)).toBeNull()
  })

  it("returns null when every pixel is fully transparent", () => {
    expect(dominantColor(solidRgba(4, 4, 200, 40, 40, 0), 4, 4)).toBeNull()
  })

  it("returns null for empty or mismatched buffers", () => {
    expect(dominantColor(new Uint8ClampedArray(0), 0, 0)).toBeNull()
    expect(dominantColor(new Uint8ClampedArray(4), 4, 4)).toBeNull()
  })
})

describe("rgbToOklch", () => {
  it("gives pure red a warm hue and non-zero chroma", () => {
    const oklch = rgbToOklch({ r: 255, g: 0, b: 0 })
    expect(oklch.c).toBeGreaterThan(0.1)
    expect(oklch.h).toBeGreaterThanOrEqual(0)
    expect(oklch.h).toBeLessThan(60)
  })

  it("gives neutral grey zero chroma", () => {
    const oklch = rgbToOklch({ r: 128, g: 128, b: 128 })
    expect(oklch.c).toBeCloseTo(0, 3)
  })

  it("normalizes negative hues into 0-360", () => {
    const oklch = rgbToOklch({ r: 40, g: 40, b: 220 })
    expect(oklch.h).toBeGreaterThanOrEqual(0)
    expect(oklch.h).toBeLessThan(360)
  })
})

describe("toAmbient", () => {
  it("clamps lightness into the dark-theme band by default", () => {
    const bright = toAmbient({ r: 255, g: 240, b: 230 })
    expect(bright.l).toBeLessThanOrEqual(0.62)
    const dim = toAmbient({ r: 20, g: 10, b: 10 })
    expect(dim.l).toBeGreaterThanOrEqual(0.35)
  })

  it("clamps lightness into a custom light-theme band", () => {
    const result = toAmbient({ r: 20, g: 10, b: 10 }, { lightness: [0.7, 0.86] })
    expect(result.l).toBeGreaterThanOrEqual(0.7)
    expect(result.l).toBeLessThanOrEqual(0.86)
  })

  it("caps chroma at 0.09", () => {
    const result = toAmbient({ r: 255, g: 0, b: 0 })
    expect(result.c).toBeLessThanOrEqual(0.09)
  })

  it("preserves hue", () => {
    const source = rgbToOklch({ r: 40, g: 200, b: 60 })
    const result = toAmbient({ r: 40, g: 200, b: 60 })
    expect(result.h).toBeCloseTo(source.h, 5)
  })
})

describe("ambientCss", () => {
  it("formats without alpha", () => {
    expect(ambientCss({ l: 0.5, c: 0.08, h: 210 })).toBe("oklch(50.0% 0.0800 210.0)")
  })

  it("formats with alpha", () => {
    expect(ambientCss({ l: 0.5, c: 0.08, h: 210 }, 0.35)).toBe("oklch(50.0% 0.0800 210.0 / 0.35)")
  })
})

describe("blendTowardSlate", () => {
  it("returns the input unchanged at amount 0", () => {
    const color = { l: 0.55, c: 0.08, h: 140 }
    expect(blendTowardSlate(color, 0)).toEqual(color)
  })

  it("fully desaturates and neutralizes lightness at amount 1", () => {
    const result = blendTowardSlate({ l: 0.3, c: 0.08, h: 140 }, 1)
    expect(result.c).toBeCloseTo(0, 5)
    expect(result.l).toBeCloseTo(0.5, 5)
  })

  it("preserves hue while reducing chroma monotonically", () => {
    const source = { l: 0.55, c: 0.08, h: 140 }
    const half = blendTowardSlate(source, 0.5)
    const full = blendTowardSlate(source, 1)
    expect(half.h).toBe(140)
    expect(half.c).toBeGreaterThan(full.c)
    expect(half.c).toBeLessThan(source.c)
  })

  it("clamps out-of-range amounts", () => {
    expect(blendTowardSlate({ l: 0.55, c: 0.08, h: 140 }, -1)).toEqual({ l: 0.55, c: 0.08, h: 140 })
    expect(blendTowardSlate({ l: 0.55, c: 0.08, h: 140 }, 2).c).toBeCloseTo(0, 5)
  })
})
