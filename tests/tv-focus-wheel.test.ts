import { describe, it, expect } from "vitest"
import { resolveWheelStepIntent } from "@/scripts/tv/focus"

describe("resolveWheelStepIntent", () => {
  it("steps an x-axis scroller right/left on horizontal-dominant wheel", () => {
    expect(resolveWheelStepIntent("x", 10, 0, false)).toEqual({ handled: true, direction: "right", delta: 10 })
    expect(resolveWheelStepIntent("x", -10, 0, false)).toEqual({ handled: true, direction: "left", delta: -10 })
  })

  it("lets a vertical wheel over an x-axis scroller pass through", () => {
    expect(resolveWheelStepIntent("x", 0, 10, false)).toEqual({ handled: false, direction: null, delta: 0 })
  })

  it("treats shift+wheel over an x-axis scroller as horizontal even with only deltaY", () => {
    expect(resolveWheelStepIntent("x", 0, 10, true)).toEqual({ handled: true, direction: "right", delta: 10 })
  })

  it("requires strictly greater deltaX than deltaY for an x-axis scroller", () => {
    expect(resolveWheelStepIntent("x", 5, 5, false)).toEqual({ handled: false, direction: null, delta: 0 })
  })

  it("steps a y-axis scroller down/up on vertical wheel", () => {
    expect(resolveWheelStepIntent("y", 0, 10, false)).toEqual({ handled: true, direction: "down", delta: 10 })
    expect(resolveWheelStepIntent("y", 0, -10, false)).toEqual({ handled: true, direction: "up", delta: -10 })
  })

  it("lets a horizontal-dominant wheel over a y-axis scroller pass through", () => {
    expect(resolveWheelStepIntent("y", 10, 0, false)).toEqual({ handled: false, direction: null, delta: 0 })
  })

  it("a y-axis scroller wins on equal deltas", () => {
    expect(resolveWheelStepIntent("y", 5, 5, false)).toEqual({ handled: true, direction: "down", delta: 5 })
  })

  it("returns unhandled for a zero delta on either axis", () => {
    expect(resolveWheelStepIntent("x", 0, 0, false)).toEqual({ handled: false, direction: null, delta: 0 })
    expect(resolveWheelStepIntent("y", 0, 0, false)).toEqual({ handled: false, direction: null, delta: 0 })
  })
})
