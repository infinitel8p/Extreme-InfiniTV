import { describe, it, expect } from "vitest"
import { nextRowIndex } from "@/scripts/tv/ui/virtual-rows"

describe("nextRowIndex", () => {
  it("steps by one for arrow keys", () => {
    expect(nextRowIndex(5, "ArrowDown", 20, 4)).toBe(6)
    expect(nextRowIndex(5, "ArrowUp", 20, 4)).toBe(4)
  })

  it("clamps arrow steps at the list bounds", () => {
    expect(nextRowIndex(19, "ArrowDown", 20, 4)).toBe(19)
    expect(nextRowIndex(0, "ArrowUp", 20, 4)).toBe(0)
  })

  it("pages by the visible row count", () => {
    expect(nextRowIndex(2, "PageDown", 20, 5)).toBe(7)
    expect(nextRowIndex(10, "PageUp", 20, 5)).toBe(5)
  })

  it("clamps page steps at the list bounds", () => {
    expect(nextRowIndex(18, "PageDown", 20, 5)).toBe(19)
    expect(nextRowIndex(2, "PageUp", 20, 5)).toBe(0)
  })

  it("jumps to the first or last index", () => {
    expect(nextRowIndex(9, "Home", 20, 5)).toBe(0)
    expect(nextRowIndex(9, "End", 20, 5)).toBe(19)
  })

  it("returns the current index unchanged for an empty list", () => {
    expect(nextRowIndex(0, "ArrowDown", 0, 5)).toBe(0)
  })
})
