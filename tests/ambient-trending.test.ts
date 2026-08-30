import { describe, it, expect } from "vitest"
import {
  matchTrendingToCatalog,
  type TrendingCandidate,
  type TrendingCatalogRow,
} from "@/scripts/lib/ambient-trending.ts"

function trending(overrides: Partial<TrendingCandidate> = {}): TrendingCandidate {
  return { tmdbId: null, name: "Some Movie", year: 2020, ...overrides }
}

function row(overrides: Partial<TrendingCatalogRow> = {}): TrendingCatalogRow {
  return { id: 1, name: "Some Movie", year: 2020, tmdb: null, ...overrides }
}

describe("matchTrendingToCatalog", () => {
  it("matches by tmdb id even when the names differ", () => {
    const result = matchTrendingToCatalog(
      [trending({ tmdbId: 42, name: "Trending Name", year: 2019 })],
      [row({ id: 5, name: "Provider Name", year: 2020, tmdb: 42 })]
    )
    expect(result.map((matchedRow) => matchedRow.id)).toEqual([5])
  })

  it("falls back to cleaned name + year when no tmdb id matches", () => {
    const result = matchTrendingToCatalog(
      [trending({ tmdbId: null, name: "The Great Movie", year: 2021 })],
      [row({ id: 9, name: "DE - The Great Movie (2021)", year: null, tmdb: null })]
    )
    expect(result.map((matchedRow) => matchedRow.id)).toEqual([9])
  })

  it("does not tolerate an off-by-one year", () => {
    const result = matchTrendingToCatalog(
      [trending({ tmdbId: null, name: "Off By One", year: 2021 })],
      [row({ id: 3, name: "Off By One", year: 2022, tmdb: null })]
    )
    expect(result).toEqual([])
  })

  it("dedupes when two trending entries resolve to the same catalog row", () => {
    const result = matchTrendingToCatalog(
      [
        trending({ tmdbId: 42, name: "Movie A", year: 2020 }),
        trending({ tmdbId: null, name: "Movie A", year: 2020 }),
      ],
      [row({ id: 1, name: "Movie A", year: 2020, tmdb: 42 })]
    )
    expect(result).toHaveLength(1)
  })

  it("preserves trending order, not catalog order", () => {
    const result = matchTrendingToCatalog(
      [
        trending({ tmdbId: null, name: "Second", year: 2020 }),
        trending({ tmdbId: null, name: "First", year: 2020 }),
      ],
      [
        row({ id: 1, name: "First", year: 2020 }),
        row({ id: 2, name: "Second", year: 2020 }),
      ]
    )
    expect(result.map((matchedRow) => matchedRow.id)).toEqual([2, 1])
  })

  it("skips a trending entry with neither an id nor a name match", () => {
    const result = matchTrendingToCatalog(
      [trending({ tmdbId: null, name: "Nowhere To Be Found", year: 2020 })],
      [row({ id: 1, name: "Something Else", year: 2020 })]
    )
    expect(result).toEqual([])
  })
})
