import { describe, it, expect } from "vitest"
import {
  filterAndSortEntries,
  filterAndSortIndexes,
  rowWindow,
  rowOf,
  type GridFilterState,
} from "@/scripts/lib/tv-grid-filter"

interface Entry {
  id: number
  name: string
  norm: string
  category: string
  added: number
  rating: string
  year: string
}

function makeEntries(): Entry[] {
  return [
    { id: 1, name: "Alpha", norm: "alpha action", category: "Action", added: 100, rating: "7.0", year: "2020" },
    { id: 2, name: "Beta", norm: "beta comedy", category: "Comedy", added: 300, rating: "9.0", year: "2022" },
    { id: 3, name: "Gamma", norm: "gamma action", category: "Action", added: 200, rating: "5.0", year: "2019" },
    { id: 4, name: "Delta", norm: "delta comedy", category: "Comedy", added: 400, rating: "", year: "2021" },
  ]
}

const genreActionIds = new Set([1, 3])

const baseCtx = {
  categoryMatcher: (entry: Entry, category: string) => {
    if (category === "__genre__:action") return genreActionIds.has(entry.id)
    return entry.category === category
  },
  isWatched: (entry: Entry) => entry.id === 2 || entry.id === 4,
  normalize: (text: string) => text.trim().toLowerCase(),
}

function baseState(overrides: Partial<GridFilterState> = {}): GridFilterState {
  return { category: null, query: "", hideWatched: false, sort: "default", ...overrides }
}

describe("filterAndSortEntries", () => {
  it("returns all entries unfiltered by default", () => {
    const result = filterAndSortEntries(makeEntries(), baseState(), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([1, 2, 3, 4])
  })

  it("filters by a plain category", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ category: "Comedy" }), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([2, 4])
  })

  it("filters by a virtual genre category via categoryMatcher", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ category: "__genre__:action" }), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([1, 3])
  })

  it("filters by query against the precomputed norm field", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ query: "comedy" }), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([2, 4])
  })

  it("drops entries with no query match", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ query: "nope" }), baseCtx)
    expect(result).toEqual([])
  })

  it("hides watched entries when hideWatched is enabled", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ hideWatched: true }), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([1, 3])
  })

  it("combines category, hideWatched, and query", () => {
    const result = filterAndSortEntries(
      makeEntries(),
      baseState({ category: "Comedy", hideWatched: true, query: "beta" }),
      baseCtx
    )
    expect(result).toEqual([])
  })

  it("sorts by added descending", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ sort: "added" }), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([4, 2, 3, 1])
  })

  it("sorts by rating descending, falling back to name for equal/empty ratings", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ sort: "rating" }), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([2, 1, 3, 4])
  })

  it("sorts alphabetically for az", () => {
    const result = filterAndSortEntries(makeEntries(), baseState({ sort: "az" }), baseCtx)
    expect(result.map((entry) => entry.id)).toEqual([1, 2, 4, 3])
  })

  it("sorts default query results by relevance score", () => {
    const entries: Entry[] = [
      { id: 10, name: "Zebra Party", norm: "zebra party", category: "Comedy", added: 1, rating: "", year: "" },
      { id: 11, name: "Party Zebra", norm: "party zebra", category: "Comedy", added: 1, rating: "", year: "" },
    ]
    const result = filterAndSortEntries(entries, baseState({ query: "party" }), baseCtx)
    // "party" starts the norm for id 11, so it scores higher than id 10 (mid-string match).
    expect(result.map((entry) => entry.id)).toEqual([11, 10])
  })

  it("does not mutate the input array", () => {
    const entries = makeEntries()
    const snapshot = entries.map((entry) => entry.id)
    filterAndSortEntries(entries, baseState({ sort: "az" }), baseCtx)
    expect(entries.map((entry) => entry.id)).toEqual(snapshot)
  })
})

describe("filterAndSortIndexes", () => {
  it("returns indexes into the original array matching filterAndSortEntries", () => {
    const entries = makeEntries()
    const state = baseState({ sort: "rating" })
    const indexes = filterAndSortIndexes(entries, state, baseCtx)
    const byIndex = Array.from(indexes).map((index) => entries[index])
    expect(byIndex).toEqual(filterAndSortEntries(entries, state, baseCtx))
  })

  it("keeps indexes relative to the untouched input array after filtering", () => {
    const entries = makeEntries()
    const indexes = filterAndSortIndexes(entries, baseState({ category: "Comedy" }), baseCtx)
    expect(Array.from(indexes)).toEqual([1, 3])
  })

  it("returns an empty array when nothing matches", () => {
    const indexes = filterAndSortIndexes(makeEntries(), baseState({ query: "nope" }), baseCtx)
    expect(indexes.length).toBe(0)
  })

  it("does not mutate the input array", () => {
    const entries = makeEntries()
    const snapshot = entries.map((entry) => entry.id)
    filterAndSortIndexes(entries, baseState({ sort: "az" }), baseCtx)
    expect(entries.map((entry) => entry.id)).toEqual(snapshot)
  })
})

describe("rowWindow", () => {
  it("clamps the start at zero near the top", () => {
    expect(rowWindow(100, 0, 3, 2)).toEqual({ start: 0, end: 5 })
  })

  it("clamps the end at totalRows near the bottom", () => {
    expect(rowWindow(10, 9, 3, 2)).toEqual({ start: 5, end: 10 })
  })

  it("windows around a focused row in the middle", () => {
    expect(rowWindow(100, 50, 3, 2)).toEqual({ start: 46, end: 55 })
  })

  it("returns an empty window for zero rows", () => {
    expect(rowWindow(0, 0, 3, 2)).toEqual({ start: 0, end: 0 })
  })

  it("clamps an out-of-range focused row", () => {
    expect(rowWindow(5, 99, 3, 2)).toEqual({ start: 0, end: 5 })
    expect(rowWindow(5, -3, 3, 2)).toEqual({ start: 0, end: 5 })
  })

  it("still mounts a row above the focused one with zero overscan when 2+ rows are visible", () => {
    // keepFocusedInView can anchor the focused row a few px below the viewport's top edge, so
    // the row above it can be partially visible - losing it would show a blank strip while scrolling.
    expect(rowWindow(20, 5, 2, 0)).toEqual({ start: 4, end: 7 })
  })

  it("mounts no extra leading row when only one row is visible", () => {
    expect(rowWindow(20, 5, 1, 0)).toEqual({ start: 5, end: 6 })
  })
})

describe("rowOf", () => {
  it("computes the row for an index given a column count", () => {
    expect(rowOf(0, 6)).toBe(0)
    expect(rowOf(5, 6)).toBe(0)
    expect(rowOf(6, 6)).toBe(1)
    expect(rowOf(13, 6)).toBe(2)
  })

  it("returns 0 for a non-positive column count", () => {
    expect(rowOf(10, 0)).toBe(0)
  })
})
