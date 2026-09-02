import { describe, it, expect } from "vitest"
import {
  cssRectToPhysicalBounds,
  cssRectToNativeVideoHoleVars,
  deriveEvents,
  buildLoadOptions,
  boundsEqual,
} from "../src/scripts/lib/mpv-embedded"

describe("cssRectToPhysicalBounds", () => {
  it("scales a CSS rect by an integer device pixel ratio", () => {
    expect(cssRectToPhysicalBounds({ x: 10, y: 20, width: 300, height: 200 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 10, y: 20, width: 300, height: 200 }, 2)).toEqual({
      x: 20,
      y: 40,
      width: 600,
      height: 400,
      radius: 0,
    })
  })

  it("rounds a fractional device pixel ratio to whole physical pixels", () => {
    expect(cssRectToPhysicalBounds({ x: 3, y: 3, width: 111, height: 63 }, 1.5)).toEqual({
      x: 5,
      y: 5,
      width: 167,
      height: 95,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 50 }, 1.25)).toEqual({
      x: 0,
      y: 0,
      width: 125,
      height: 63,
      radius: 0,
    })
  })

  it("passes through a zero-size rect", () => {
    expect(cssRectToPhysicalBounds({ x: 0, y: 0, width: 0, height: 0 }, 2)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      radius: 0,
    })
  })

  it("rounds negative coordinates (scrolled offscreen) correctly", () => {
    expect(cssRectToPhysicalBounds({ x: -10.4, y: -20.6, width: 100, height: 100 }, 1)).toEqual({
      x: -10,
      y: -21,
      width: 100,
      height: 100,
      radius: 0,
    })
  })

  it("falls back to a ratio of 1 for an invalid device pixel ratio", () => {
    expect(cssRectToPhysicalBounds({ x: 10, y: 10, width: 100, height: 100 }, 0)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 10, y: 10, width: 100, height: 100 }, NaN)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 10, y: 10, width: 100, height: 100 }, -2)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      radius: 0,
    })
  })

  it("converts a CSS pixel radius by the device pixel ratio", () => {
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "8px" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 16 })
  })

  it("rounds a fractional device pixel ratio applied to the radius", () => {
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "12px" }, 1.5),
    ).toEqual({ x: 0, y: 0, width: 150, height: 150, radius: 18 })
  })

  it("falls back to a radius of 0 for percentages and other non-pixel values", () => {
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "50%" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 0 })
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "0px" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 0 })
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 0 })
  })
})

describe("boundsEqual", () => {
  const bounds = { x: 1, y: 2, width: 300, height: 200, radius: 8 }

  it("is true for two structurally identical bounds", () => {
    expect(boundsEqual(bounds, { ...bounds })).toBe(true)
  })

  it("is true for the same reference, including two nulls", () => {
    expect(boundsEqual(bounds, bounds)).toBe(true)
    expect(boundsEqual(null, null)).toBe(true)
  })

  it("is false when any single field differs", () => {
    expect(boundsEqual(bounds, { ...bounds, x: 2 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, y: 3 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, width: 301 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, height: 201 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, radius: 9 })).toBe(false)
  })

  it("is false when only one side is null", () => {
    expect(boundsEqual(bounds, null)).toBe(false)
    expect(boundsEqual(null, bounds)).toBe(false)
  })
})

describe("cssRectToNativeVideoHoleVars", () => {
  it("maps a CSS rect to px custom properties with a zero radius when omitted", () => {
    expect(cssRectToNativeVideoHoleVars({ x: 10, y: 20, width: 300, height: 200 })).toEqual({
      "--xt-video-x": "10px",
      "--xt-video-y": "20px",
      "--xt-video-w": "300px",
      "--xt-video-h": "200px",
      "--xt-video-r": "0px",
    })
  })

  it("preserves fractional values and reads a CSS pixel radius", () => {
    expect(
      cssRectToNativeVideoHoleVars({ x: 10.5, y: 20.25, width: 300.75, height: 200.1, radius: "12px" }),
    ).toEqual({
      "--xt-video-x": "10.5px",
      "--xt-video-y": "20.25px",
      "--xt-video-w": "300.75px",
      "--xt-video-h": "200.1px",
      "--xt-video-r": "12px",
    })
  })
})

describe("buildLoadOptions", () => {
  it("defaults isLive to true and every other field to null when nothing is supplied", () => {
    expect(buildLoadOptions({})).toEqual({
      userAgent: null,
      referer: null,
      startSeconds: null,
      isLive: true,
      networkTimeoutSeconds: null,
    })
  })

  it("carries userAgent/referer through untouched", () => {
    expect(
      buildLoadOptions({ userAgent: "xtream/1.0", referer: "https://example.com" }),
    ).toEqual({
      userAgent: "xtream/1.0",
      referer: "https://example.com",
      startSeconds: null,
      isLive: true,
      networkTimeoutSeconds: null,
    })
  })

  it("carries a positive networkTimeoutSeconds through", () => {
    expect(buildLoadOptions({ networkTimeoutSeconds: 45 }).networkTimeoutSeconds).toBe(45)
  })

  it("ignores a zero, negative, or non-finite networkTimeoutSeconds", () => {
    expect(buildLoadOptions({ networkTimeoutSeconds: 0 }).networkTimeoutSeconds).toBe(null)
    expect(buildLoadOptions({ networkTimeoutSeconds: -5 }).networkTimeoutSeconds).toBe(null)
    expect(buildLoadOptions({ networkTimeoutSeconds: null }).networkTimeoutSeconds).toBe(null)
  })

  it("only sets isLive to false when explicitly false", () => {
    expect(buildLoadOptions({ isLive: false }).isLive).toBe(false)
    expect(buildLoadOptions({ isLive: true }).isLive).toBe(true)
    expect(buildLoadOptions({ isLive: undefined }).isLive).toBe(true)
  })

  it("uses timelineOffsetSeconds as the start position even below the resume threshold", () => {
    expect(buildLoadOptions({ timelineOffsetSeconds: 2 }).startSeconds).toBe(2)
  })

  it("ignores a zero or negative timelineOffsetSeconds and falls back to resumeSeconds", () => {
    expect(buildLoadOptions({ timelineOffsetSeconds: 0, resumeSeconds: 30 }).startSeconds).toBe(30)
    expect(buildLoadOptions({ timelineOffsetSeconds: -5, resumeSeconds: 30 }).startSeconds).toBe(30)
  })

  it("ignores resumeSeconds at or below the resume threshold", () => {
    expect(buildLoadOptions({ resumeSeconds: 5 }).startSeconds).toBe(null)
    expect(buildLoadOptions({ resumeSeconds: 3 }).startSeconds).toBe(null)
  })

  it("uses resumeSeconds above the resume threshold", () => {
    expect(buildLoadOptions({ resumeSeconds: 6 }).startSeconds).toBe(6)
  })

  it("prefers timelineOffsetSeconds over resumeSeconds when both are given", () => {
    expect(buildLoadOptions({ timelineOffsetSeconds: 120, resumeSeconds: 600 }).startSeconds).toBe(120)
  })
})

describe("deriveEvents", () => {
  it("returns no events for an unchanged empty state", () => {
    expect(deriveEvents(null, {})).toEqual([])
  })

  it("fires playing on the first state transition when core-idle is already false and unpaused", () => {
    expect(deriveEvents(null, { coreIdle: false, pause: false })).toEqual(["playing"])
  })

  it("does not fire playing when core-idle goes false but playback is paused", () => {
    expect(deriveEvents({ coreIdle: true }, { coreIdle: false, pause: true })).toEqual(["pause"])
  })

  it("fires waiting when pausedForCache transitions to true", () => {
    expect(deriveEvents({ pausedForCache: false }, { pausedForCache: true })).toEqual(["waiting"])
  })

  it("fires waiting when seeking transitions from undefined to true", () => {
    expect(deriveEvents({}, { seeking: true })).toEqual(["waiting"])
  })

  it("does not repeat waiting when pausedForCache stays true across updates", () => {
    const holdingCache = { pausedForCache: true }
    expect(deriveEvents(holdingCache, { pausedForCache: true, timePos: 12 })).toEqual(["timeupdate"])
  })

  it("fires timeupdate only when timePos actually changes", () => {
    expect(deriveEvents({ timePos: 10 }, { timePos: 10.5 })).toEqual(["timeupdate"])
    expect(deriveEvents({ timePos: 10 }, { timePos: 10 })).toEqual([])
  })

  it("fires pause when pause transitions to true", () => {
    expect(deriveEvents({ pause: false }, { pause: true })).toEqual(["pause"])
  })

  it("does not re-fire pause when already paused", () => {
    expect(deriveEvents({ pause: true }, { pause: true })).toEqual([])
  })

  it("can fire multiple events for one merged update, in a stable order", () => {
    expect(
      deriveEvents({ seeking: false, timePos: 5 }, { seeking: true, timePos: 6 }),
    ).toEqual(["waiting", "timeupdate"])
  })

  it("fires playing and no pause event on resume from a caller-driven unpause", () => {
    expect(
      deriveEvents({ coreIdle: true, pause: true }, { coreIdle: false, pause: false }),
    ).toEqual(["playing"])
  })
})
