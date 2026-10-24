import { describe, it, expect } from "vitest"
import { edgeScrollVelocity } from "../src/scripts/lib/drag-autoscroll"

describe("edgeScrollVelocity", () => {
  const top = 100
  const bottom = 500
  const threshold = 56
  const maxSpeed = 14

  it("returns negative velocity inside the top band", () => {
    expect(edgeScrollVelocity(top + 10, top, bottom, threshold, maxSpeed)).toBeLessThan(0)
  })

  it("returns positive velocity inside the bottom band", () => {
    expect(edgeScrollVelocity(bottom - 10, top, bottom, threshold, maxSpeed)).toBeGreaterThan(0)
  })

  it("returns zero in the middle", () => {
    expect(edgeScrollVelocity((top + bottom) / 2, top, bottom, threshold, maxSpeed)).toBe(0)
  })

  it("clamps at maxSpeed at the very edge", () => {
    expect(edgeScrollVelocity(top, top, bottom, threshold, maxSpeed)).toBe(-maxSpeed)
    expect(edgeScrollVelocity(bottom, top, bottom, threshold, maxSpeed)).toBe(maxSpeed)
  })

  it("clamps at maxSpeed beyond the container bounds", () => {
    expect(edgeScrollVelocity(top - 200, top, bottom, threshold, maxSpeed)).toBe(-maxSpeed)
    expect(edgeScrollVelocity(bottom + 200, top, bottom, threshold, maxSpeed)).toBe(maxSpeed)
  })

  it("scales monotonically with proximity to the top edge", () => {
    const far = edgeScrollVelocity(top + 40, top, bottom, threshold, maxSpeed)
    const near = edgeScrollVelocity(top + 10, top, bottom, threshold, maxSpeed)
    const atEdge = edgeScrollVelocity(top, top, bottom, threshold, maxSpeed)
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far))
    expect(Math.abs(atEdge)).toBeGreaterThan(Math.abs(near))
  })

  it("scales monotonically with proximity to the bottom edge", () => {
    const far = edgeScrollVelocity(bottom - 40, top, bottom, threshold, maxSpeed)
    const near = edgeScrollVelocity(bottom - 10, top, bottom, threshold, maxSpeed)
    const atEdge = edgeScrollVelocity(bottom, top, bottom, threshold, maxSpeed)
    expect(near).toBeGreaterThan(far)
    expect(atEdge).toBeGreaterThan(near)
  })
})
