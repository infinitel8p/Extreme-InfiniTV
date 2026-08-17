import { describe, it, expect } from "vitest"
import { matchDiscoverToRows, sweepStampLostItsNotes } from "@/scripts/lib/genre-index.ts"
import type { TmdbDiscoverItem } from "@/scripts/lib/tmdb.ts"

function item(overrides: Partial<TmdbDiscoverItem> = {}): TmdbDiscoverItem {
  return { tmdbId: 1, name: "Sample Title", year: "2000", ...overrides }
}

describe("matchDiscoverToRows", () => {
  it("matches a row by tmdb id even when name/year differ entirely", () => {
    const items = [item({ tmdbId: 100, name: "Whatever Title", year: "1999" })]
    const rows = [{ id: 1, tmdb: 100, name: "Totally Different Name", year: "2020" }]
    expect(matchDiscoverToRows(items, rows)).toEqual([1])
  })

  it("only falls back to name+year matching for rows without a tmdb id", () => {
    const items = [item({ tmdbId: 200, name: "Inception", year: "2010" })]
    const rows = [
      { id: 2, tmdb: 999, name: "Inception", year: "2010" },
      { id: 3, name: "Inception", year: "2010" },
    ]
    expect(matchDiscoverToRows(items, rows)).toEqual([3])
  })

  it("does not cross-match rows whose year is more than a year off", () => {
    const items = [item({ tmdbId: 300, name: "Old Movie", year: "1950" })]
    const rows = [{ id: 4, name: "Old Movie", year: "1999" }]
    expect(matchDiscoverToRows(items, rows)).toEqual([])
  })

  it("matches the name fallback across case and diacritics", () => {
    const items = [item({ tmdbId: 400, name: "Amélie", year: "2001" })]
    const rows = [{ id: 5, name: "AMELIE", year: "2001" }]
    expect(matchDiscoverToRows(items, rows)).toEqual([5])
  })

  it("dedupes a row matched by more than one discover item", () => {
    const items = [
      item({ tmdbId: 500, name: "Dup Movie", year: "2005" }),
      item({ tmdbId: 501, name: "Dup Movie", year: "2005" }),
    ]
    const rows = [{ id: 6, name: "Dup Movie", year: "2005" }]
    expect(matchDiscoverToRows(items, rows)).toEqual([6])
  })

  it("unions id matches and name+year fallback matches without duplicates", () => {
    const items = [
      item({ tmdbId: 600, name: "A", year: "2000" }),
      item({ tmdbId: 601, name: "B", year: "2001" }),
    ]
    const rows = [
      { id: 7, tmdb: 600, name: "Zzz", year: "1900" },
      { id: 8, name: "B", year: "2001" },
      { id: 9, name: "C", year: "2002" },
    ]
    expect(matchDiscoverToRows(items, rows).sort()).toEqual([7, 8])
  })

  it("returns [] for an empty item list or an empty row list", () => {
    expect(matchDiscoverToRows([], [{ id: 1, name: "Anything" }])).toEqual([])
    expect(matchDiscoverToRows([item()], [])).toEqual([])
  })
})

describe("sweepStampLostItsNotes", () => {
  it("keeps a stamp whose boosted notes are still present", () => {
    expect(sweepStampLostItsNotes({ sweptAt: 1, matched: 2 }, { 5: ["action"] }, "action")).toBe(false)
  })

  it("drops a stamp that claimed matches the notes no longer hold", () => {
    expect(sweepStampLostItsNotes({ sweptAt: 1, matched: 2 }, {}, "action")).toBe(true)
    expect(sweepStampLostItsNotes({ sweptAt: 1, matched: 2 }, { 5: ["comedy"] }, "action")).toBe(true)
  })

  it("keeps a stamp that matched nothing", () => {
    expect(sweepStampLostItsNotes({ sweptAt: 1, matched: 0 }, {}, "action")).toBe(false)
  })

  it("verifies legacy stamps without a matched count", () => {
    expect(sweepStampLostItsNotes({ sweptAt: 1 }, {}, "action")).toBe(true)
    expect(sweepStampLostItsNotes({ sweptAt: 1 }, { 5: ["action"] }, "action")).toBe(false)
  })
})
