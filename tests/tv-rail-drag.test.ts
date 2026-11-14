import { describe, it, expect } from "vitest"
import { clampDragShift, pickAnchorIndex, DRAG_START_THRESHOLD_PX } from "@/scripts/tv/rail-drag"

describe("clampDragShift", () => {
  it("passes through a shift within range", () => {
    expect(clampDragShift(-100, -20, 400)).toBe(-120)
  })

  it("clamps at 0 when the drag would push the track past its resting start", () => {
    expect(clampDragShift(-10, 50, 400)).toBe(0)
  })

  it("clamps at -maxShiftPx when the drag would push the track past its end", () => {
    expect(clampDragShift(-380, -100, 400)).toBe(-400)
  })

  it("collapses to 0 when maxShiftPx is 0 (rail fits without scrolling)", () => {
    expect(clampDragShift(0, -50, 0)).toBe(0)
  })
})

describe("pickAnchorIndex", () => {
  it("picks the card whose offset is nearest the anchor after the shift", () => {
    const cardOffsetsPx = [0, 160, 320, 480, 640]
    expect(pickAnchorIndex(cardOffsetsPx, -300, 16)).toBe(2)
  })

  it("picks index 0 when the shift lands back at rest", () => {
    const cardOffsetsPx = [0, 160, 320, 480]
    expect(pickAnchorIndex(cardOffsetsPx, 0, 16)).toBe(0)
  })

  it("breaks a tie by keeping the lower index", () => {
    const cardOffsetsPx = [0, 100, 200]
    expect(pickAnchorIndex(cardOffsetsPx, -150, 0)).toBe(1)
  })

  it("returns -1 for an empty rail", () => {
    expect(pickAnchorIndex([], -100, 16)).toBe(-1)
  })
})

describe("DRAG_START_THRESHOLD_PX", () => {
  it("is a small pixel budget before a click turns into a drag", () => {
    expect(DRAG_START_THRESHOLD_PX).toBe(6)
  })
})
