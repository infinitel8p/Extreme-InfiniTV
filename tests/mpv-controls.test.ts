import { describe, it, expect } from "vitest"
import {
  seekFraction,
  seekTargetFromFraction,
  isSeekableContent,
  nextAutoHideState,
  type AutoHideState,
} from "../src/scripts/lib/mpv-controls"

describe("seekFraction", () => {
  it("maps the midpoint of a known duration to 0.5", () => {
    expect(seekFraction(30, 60)).toBe(0.5)
  })

  it("clamps a current time past the duration to 1", () => {
    expect(seekFraction(90, 60)).toBe(1)
  })

  it("clamps a negative current time to 0", () => {
    expect(seekFraction(-5, 60)).toBe(0)
  })

  it("returns 0 for a non-finite or zero duration", () => {
    expect(seekFraction(10, 0)).toBe(0)
    expect(seekFraction(10, NaN)).toBe(0)
    expect(seekFraction(10, Infinity)).toBe(0)
  })

  it("returns 0 for a non-finite current time", () => {
    expect(seekFraction(NaN, 60)).toBe(0)
  })
})

describe("seekTargetFromFraction", () => {
  it("maps 0.5 to the midpoint of a known duration", () => {
    expect(seekTargetFromFraction(0.5, 60)).toBe(30)
  })

  it("clamps a fraction outside 0..1", () => {
    expect(seekTargetFromFraction(1.5, 60)).toBe(60)
    expect(seekTargetFromFraction(-0.5, 60)).toBe(0)
  })

  it("returns 0 for a non-finite or zero duration", () => {
    expect(seekTargetFromFraction(0.5, 0)).toBe(0)
    expect(seekTargetFromFraction(0.5, NaN)).toBe(0)
  })

  it("round-trips with seekFraction", () => {
    const duration = 120
    const fraction = seekFraction(90, duration)
    expect(seekTargetFromFraction(fraction, duration)).toBe(90)
  })
})

describe("isSeekableContent", () => {
  it("is never seekable when isLive is explicitly true", () => {
    expect(isSeekableContent(true, 3600)).toBe(false)
  })

  it("is always seekable when isLive is explicitly false", () => {
    expect(isSeekableContent(false, 0)).toBe(true)
    expect(isSeekableContent(false, NaN)).toBe(true)
  })

  it("derives from duration when isLive is unknown", () => {
    expect(isSeekableContent(undefined, 120)).toBe(true)
    expect(isSeekableContent(undefined, 0)).toBe(false)
    expect(isSeekableContent(undefined, NaN)).toBe(false)
  })

  it("flips to seekable once a late duration arrives, with no isLive hint", () => {
    expect(isSeekableContent(undefined, 0)).toBe(false)
    expect(isSeekableContent(undefined, 5400)).toBe(true)
  })
})

describe("nextAutoHideState", () => {
  const base: AutoHideState = { visible: true, focused: false, paused: false }

  it("reveals on activity", () => {
    const hidden: AutoHideState = { visible: false, focused: false, paused: false }
    expect(nextAutoHideState(hidden, "activity")).toEqual({ visible: true, focused: false, paused: false })
  })

  it("reveals and marks focused on focus", () => {
    const hidden: AutoHideState = { visible: false, focused: false, paused: false }
    expect(nextAutoHideState(hidden, "focus")).toEqual({ visible: true, focused: true, paused: false })
  })

  it("clears focused on blur without forcing a hide", () => {
    const focused: AutoHideState = { visible: true, focused: true, paused: false }
    expect(nextAutoHideState(focused, "blur")).toEqual({ visible: true, focused: false, paused: false })
  })

  it("reveals and marks paused on pause", () => {
    const hidden: AutoHideState = { visible: false, focused: false, paused: false }
    expect(nextAutoHideState(hidden, "pause")).toEqual({ visible: true, focused: false, paused: true })
  })

  it("clears paused on play without hiding", () => {
    const paused: AutoHideState = { visible: true, focused: false, paused: true }
    expect(nextAutoHideState(paused, "play")).toEqual({ visible: true, focused: false, paused: false })
  })

  it("hides on timeout while playing and unfocused", () => {
    expect(nextAutoHideState(base, "timeout")).toEqual({ visible: false, focused: false, paused: false })
  })

  it("never hides on timeout while paused", () => {
    const paused: AutoHideState = { visible: true, focused: false, paused: true }
    expect(nextAutoHideState(paused, "timeout")).toBe(paused)
  })

  it("never hides on timeout while a control has focus", () => {
    const focused: AutoHideState = { visible: true, focused: true, paused: false }
    expect(nextAutoHideState(focused, "timeout")).toBe(focused)
  })
})
