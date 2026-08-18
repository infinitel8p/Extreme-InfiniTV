import { describe, it, expect } from "vitest"
import { parseGridState, gridStateMatchesLocation, type GridState } from "../src/scripts/lib/grid-state.ts"

const NOW = 1_700_000_000_000

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ search: "matrix", renderedCount: 400, scrollY: 1200, savedAt: NOW, ...overrides })
}

describe("parseGridState", () => {
  it("round-trips a valid payload", () => {
    expect(parseGridState(payload(), NOW)).toEqual({
      search: "matrix",
      renderedCount: 400,
      scrollY: 1200,
      personSignature: null,
    })
  })

  it("returns null when older than the 30 minute TTL", () => {
    const raw = payload({ savedAt: NOW - 31 * 60 * 1000 })
    expect(parseGridState(raw, NOW)).toBeNull()
  })

  it("accepts a payload right at the TTL edge", () => {
    const raw = payload({ savedAt: NOW - 30 * 60 * 1000 })
    expect(parseGridState(raw, NOW)).not.toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseGridState("{not json", NOW)).toBeNull()
  })

  it("returns null for null, undefined, or empty raw input", () => {
    expect(parseGridState(null, NOW)).toBeNull()
    expect(parseGridState(undefined, NOW)).toBeNull()
    expect(parseGridState("", NOW)).toBeNull()
  })

  it("returns null when the parsed value is not an object", () => {
    expect(parseGridState("42", NOW)).toBeNull()
    expect(parseGridState('"a string"', NOW)).toBeNull()
    expect(parseGridState("null", NOW)).toBeNull()
  })

  it("returns null when savedAt is missing or not a number", () => {
    expect(parseGridState(JSON.stringify({ search: "x" }), NOW)).toBeNull()
    expect(parseGridState(JSON.stringify({ search: "x", savedAt: "nope" }), NOW)).toBeNull()
  })

  it("coerces a missing search to an empty string", () => {
    const raw = JSON.stringify({ renderedCount: 10, scrollY: 0, savedAt: NOW })
    expect(parseGridState(raw, NOW)).toEqual({ search: "", renderedCount: 10, scrollY: 0, personSignature: null })
  })

  it("coerces a non-numeric renderedCount and scrollY to 0", () => {
    const raw = payload({ renderedCount: "many", scrollY: "far" })
    expect(parseGridState(raw, NOW)).toEqual({
      search: "matrix",
      renderedCount: 0,
      scrollY: 0,
      personSignature: null,
    })
  })

  it("floors fractional renderedCount and scrollY", () => {
    const raw = payload({ renderedCount: 200.9, scrollY: 55.4 })
    expect(parseGridState(raw, NOW)).toEqual({
      search: "matrix",
      renderedCount: 200,
      scrollY: 55,
      personSignature: null,
    })
  })

  it("clamps a negative scrollY to 0", () => {
    const raw = payload({ scrollY: -500 })
    expect(parseGridState(raw, NOW)?.scrollY).toBe(0)
  })

  it("clamps a negative renderedCount to 0", () => {
    const raw = payload({ renderedCount: -20 })
    expect(parseGridState(raw, NOW)?.renderedCount).toBe(0)
  })

  it("defaults personSignature to null when absent", () => {
    expect(parseGridState(payload(), NOW)?.personSignature).toBeNull()
  })

  it("keeps a valid personSignature", () => {
    const raw = payload({ personSignature: { person: "Keanu Reeves", personId: 6384 } })
    expect(parseGridState(raw, NOW)?.personSignature).toEqual({ person: "Keanu Reeves", personId: 6384 })
  })

  it("keeps a personSignature with a null personId", () => {
    const raw = payload({ personSignature: { person: "Keanu Reeves", personId: null } })
    expect(parseGridState(raw, NOW)?.personSignature).toEqual({ person: "Keanu Reeves", personId: null })
  })

  it("discards a personSignature with an empty or missing person name", () => {
    expect(parseGridState(payload({ personSignature: { person: "", personId: 1 } }), NOW)?.personSignature).toBeNull()
    expect(parseGridState(payload({ personSignature: { personId: 1 } }), NOW)?.personSignature).toBeNull()
  })

  it("discards a malformed personSignature value", () => {
    expect(parseGridState(payload({ personSignature: "Keanu Reeves" }), NOW)?.personSignature).toBeNull()
    expect(parseGridState(payload({ personSignature: 42 }), NOW)?.personSignature).toBeNull()
  })
})

function gridState(overrides: Partial<GridState> = {}): GridState {
  return { search: "", renderedCount: 200, scrollY: 0, personSignature: null, ...overrides }
}

describe("gridStateMatchesLocation", () => {
  it("matches when both the saved state and the current URL have no person filter", () => {
    expect(gridStateMatchesLocation(gridState(), "")).toBe(true)
  })

  it("matches when the saved and current person signatures are equal", () => {
    const state = gridState({ personSignature: { person: "Keanu Reeves", personId: 6384 } })
    expect(gridStateMatchesLocation(state, "?person=Keanu+Reeves&personId=6384")).toBe(true)
  })

  it("mismatches on a different person name", () => {
    const state = gridState({ personSignature: { person: "Keanu Reeves", personId: 6384 } })
    expect(gridStateMatchesLocation(state, "?person=Carrie-Anne+Moss&personId=6384")).toBe(false)
  })

  it("mismatches on a different personId with the same name", () => {
    const state = gridState({ personSignature: { person: "Keanu Reeves", personId: 6384 } })
    expect(gridStateMatchesLocation(state, "?person=Keanu+Reeves&personId=999")).toBe(false)
  })

  it("mismatches when the saved state has no signature but the current URL does", () => {
    expect(gridStateMatchesLocation(gridState(), "?person=Keanu+Reeves&personId=6384")).toBe(false)
  })

  it("mismatches when the saved state has a signature but the current URL has none", () => {
    const state = gridState({ personSignature: { person: "Keanu Reeves", personId: 6384 } })
    expect(gridStateMatchesLocation(state, "")).toBe(false)
  })
})
