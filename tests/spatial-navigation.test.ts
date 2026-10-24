/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import SpatialNavigation from "../src/scripts/spatial-navigation.js"

function stubRect(
  elem: HTMLElement,
  rect: { top: number; left: number; right: number; bottom: number }
): void {
  elem.getBoundingClientRect = vi.fn(
    () =>
      ({
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        toJSON() {},
      }) as DOMRect
  )
}

function dispatchArrowDown(): void {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "keyCode", { get: () => 40 })
  window.dispatchEvent(event)
}

describe("spatial-navigation.js focusNext perf fixes", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    SpatialNavigation.init()
  })

  afterEach(() => {
    SpatialNavigation.uninit()
  })

  it("measures a sibling rooted section's elements at most once even though the catch-all section also matches them", () => {
    document.body.innerHTML = `
      <div id="tv-main">
        <div id="rail-a">
          <a id="card-a1" tabindex="0"></a>
          <a id="card-a2" tabindex="0"></a>
        </div>
        <div id="rail-b">
          <a id="card-b1" tabindex="0"></a>
        </div>
        <a id="below" tabindex="0"></a>
      </div>
    `
    const cardA1 = document.getElementById("card-a1") as HTMLElement
    const cardA2 = document.getElementById("card-a2") as HTMLElement
    const cardB1 = document.getElementById("card-b1") as HTMLElement
    const below = document.getElementById("below") as HTMLElement

    stubRect(cardA1, { top: 0, left: 0, right: 50, bottom: 50 })
    stubRect(cardA2, { top: 0, left: 60, right: 110, bottom: 50 })
    stubRect(cardB1, { top: 0, left: 120, right: 170, bottom: 50 })
    stubRect(below, { top: 100, left: 0, right: 50, bottom: 150 })

    const filterRailB = vi.fn(() => true)
    const filterMain = vi.fn(() => true)

    SpatialNavigation.add("rail-a", {
      selector: "a",
      root: document.getElementById("rail-a"),
      navigableFilter: () => true,
    })
    SpatialNavigation.add("rail-b", {
      selector: "a",
      root: document.getElementById("rail-b"),
      navigableFilter: filterRailB,
    })
    SpatialNavigation.add("main", {
      selector: "a",
      root: document.getElementById("tv-main"),
      navigableFilter: filterMain,
    })

    cardA1.focus()
    expect(document.activeElement).toBe(cardA1)

    dispatchArrowDown()

    expect(document.activeElement).toBe(below)
    // The sibling rail's card must only ever be measured by its own section, never re-measured
    // by the broader catch-all "main" section once "rail-b" has already claimed it.
    expect(filterRailB).toHaveBeenCalledTimes(1)
    expect(filterMain).not.toHaveBeenCalledWith(cardB1, expect.anything())
    // getBoundingClientRect runs at most once per element for the whole keypress, even though
    // the focused card is both the navigate() target and (via "main") a candidate.
    expect((cardA1.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect((cardA2.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect((cardB1.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("keeps the offsetWidth/offsetHeight fallback only when no navigableFilter is configured", () => {
    document.body.innerHTML = `
      <div id="filtered"><a id="filtered-card" tabindex="0"></a></div>
      <div id="unfiltered"><a id="unfiltered-card" tabindex="0"></a></div>
    `
    // jsdom always reports 0 for offsetWidth/offsetHeight - a section with a filter must still
    // accept the element on that basis alone, one without a filter must still reject it.
    SpatialNavigation.add("filtered", {
      selector: "a",
      root: document.getElementById("filtered"),
      navigableFilter: () => true,
    })
    SpatialNavigation.add("unfiltered", {
      selector: "a",
      root: document.getElementById("unfiltered"),
    })

    expect(SpatialNavigation.focus("filtered")).toBe(true)
    expect(SpatialNavigation.focus("unfiltered")).toBe(false)
  })
})
