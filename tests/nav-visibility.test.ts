// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { isElementVisibleForNav } from "@/scripts/lib/nav-visibility"

function stubRect(elem: HTMLElement, rect: Partial<DOMRect>): void {
  elem.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON() {},
      ...rect,
    }) as DOMRect
}

describe("isElementVisibleForNav", () => {
  it("accepts an element on screen", () => {
    const el = document.createElement("div")
    el.checkVisibility = () => true
    stubRect(el, { right: 100, bottom: 100 })
    expect(isElementVisibleForNav(el)).toBe(true)
  })

  it("rejects an element scrolled entirely past the left/top edge", () => {
    const el = document.createElement("div")
    el.checkVisibility = () => true
    stubRect(el, { right: 0, bottom: 100 })
    expect(isElementVisibleForNav(el)).toBe(false)

    const el2 = document.createElement("div")
    el2.checkVisibility = () => true
    stubRect(el2, { right: 100, bottom: 0 })
    expect(isElementVisibleForNav(el2)).toBe(false)
  })

  it("rejects when checkVisibility() itself says hidden, without reading the rect", () => {
    const el = document.createElement("div")
    el.checkVisibility = () => false
    stubRect(el, { right: 100, bottom: 100 })
    expect(isElementVisibleForNav(el)).toBe(false)
  })
})
