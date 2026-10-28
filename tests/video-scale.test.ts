/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest"
import {
  normalizeVideoScale,
  computeForcedRatioBox,
  mpvPropertiesForVideoScale,
  createVideoScaleController,
} from "../src/scripts/lib/video-scale"

describe("normalizeVideoScale", () => {
  it("passes through every valid mode", () => {
    expect(normalizeVideoScale("fit")).toBe("fit")
    expect(normalizeVideoScale("fill")).toBe("fill")
    expect(normalizeVideoScale("zoom")).toBe("zoom")
    expect(normalizeVideoScale("16:9")).toBe("16:9")
    expect(normalizeVideoScale("4:3")).toBe("4:3")
  })

  it("falls back to fit for anything invalid", () => {
    expect(normalizeVideoScale(undefined)).toBe("fit")
    expect(normalizeVideoScale(null)).toBe("fit")
    expect(normalizeVideoScale("")).toBe("fit")
    expect(normalizeVideoScale("stretch")).toBe("fit")
    expect(normalizeVideoScale(42)).toBe("fit")
  })
})

describe("computeForcedRatioBox", () => {
  it("letterboxes a wider-than-target container (height-bound)", () => {
    expect(computeForcedRatioBox(1600, 900, 4 / 3)).toEqual({
      width: 1200,
      height: 900,
      left: 200,
      top: 0,
    })
  })

  it("pillarboxes a taller-than-target container (width-bound)", () => {
    expect(computeForcedRatioBox(800, 900, 16 / 9)).toEqual({
      width: 800,
      height: 450,
      left: 0,
      top: 225,
    })
  })

  it("fills the container exactly when the ratio already matches", () => {
    expect(computeForcedRatioBox(1920, 1080, 16 / 9)).toEqual({
      width: 1920,
      height: 1080,
      left: 0,
      top: 0,
    })
  })

  it("returns the full container box when the ratio is invalid", () => {
    expect(computeForcedRatioBox(1600, 900, 0)).toEqual({
      width: 1600,
      height: 900,
      left: 0,
      top: 0,
    })
    expect(computeForcedRatioBox(1600, 900, -1)).toEqual({
      width: 1600,
      height: 900,
      left: 0,
      top: 0,
    })
    expect(computeForcedRatioBox(1600, 900, NaN)).toEqual({
      width: 1600,
      height: 900,
      left: 0,
      top: 0,
    })
  })

  it("returns a zeroed box when container dimensions are zero, negative, or NaN", () => {
    expect(computeForcedRatioBox(0, 900, 16 / 9)).toEqual({
      width: 0,
      height: 900,
      left: 0,
      top: 0,
    })
    expect(computeForcedRatioBox(-100, 900, 16 / 9)).toEqual({
      width: 0,
      height: 900,
      left: 0,
      top: 0,
    })
    expect(computeForcedRatioBox(1600, NaN, 16 / 9)).toEqual({
      width: 1600,
      height: 0,
      left: 0,
      top: 0,
    })
  })
})

describe("mpvPropertiesForVideoScale", () => {
  it("resets every property for fit", () => {
    expect(mpvPropertiesForVideoScale("fit")).toEqual({
      panscan: 0,
      videoUnscaled: false,
      videoAspectOverride: "no",
    })
  })

  it("crops via panscan for fill and zoom", () => {
    expect(mpvPropertiesForVideoScale("fill")).toEqual({
      panscan: 1,
      videoUnscaled: false,
      videoAspectOverride: "no",
    })
    expect(mpvPropertiesForVideoScale("zoom")).toEqual({
      panscan: 1,
      videoUnscaled: false,
      videoAspectOverride: "no",
    })
  })

  it("forces the aspect ratio for 16:9 and 4:3 without cropping", () => {
    expect(mpvPropertiesForVideoScale("16:9")).toEqual({
      panscan: 0,
      videoUnscaled: false,
      videoAspectOverride: "16:9",
    })
    expect(mpvPropertiesForVideoScale("4:3")).toEqual({
      panscan: 0,
      videoUnscaled: false,
      videoAspectOverride: "4:3",
    })
  })
})

describe("createVideoScaleController with a getHandle callback", () => {
  it("drives mpv properties via setProperty instead of the stylesheet attribute", () => {
    const container = document.createElement("div")
    const setProperty = vi.fn().mockResolvedValue(undefined)
    const controller = createVideoScaleController(() => container, () => ({ setProperty }))

    controller.apply("zoom")

    expect(setProperty).toHaveBeenCalledWith("panscan", 1)
    expect(setProperty).toHaveBeenCalledWith("video-unscaled", false)
    expect(setProperty).toHaveBeenCalledWith("video-aspect-override", "no")
    expect(container.hasAttribute("data-xt-video-scale")).toBe(false)
  })

  it("falls back to the stylesheet attribute when the handle has no setProperty", () => {
    const container = document.createElement("div")
    const controller = createVideoScaleController(() => container, () => ({}))

    controller.apply("fill")

    expect(container.getAttribute("data-xt-video-scale")).toBe("fill")
  })

  it("falls back to the stylesheet attribute when getHandle is omitted", () => {
    const container = document.createElement("div")
    const controller = createVideoScaleController(() => container)

    controller.apply("zoom")

    expect(container.getAttribute("data-xt-video-scale")).toBe("zoom")
  })
})
