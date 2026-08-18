import { describe, it, expect } from "vitest"
import { buildGenreIndexFromRows } from "@/scripts/lib/genre-index.ts"
import type { GenreId } from "@/scripts/lib/genres.ts"

describe("buildGenreIndexFromRows", () => {
  it("classifies rows from the genre string alone", () => {
    const index = buildGenreIndexFromRows(
      [{ id: 1, category: "", genre: "Action, Comedy" }],
      {}
    )
    expect(index.sets.get("action")).toEqual(new Set([1]))
    expect(index.sets.get("comedy")).toEqual(new Set([1]))
    expect(index.classifiedCount).toBe(1)
    expect(index.totalCount).toBe(1)
  })

  it("includes category-only matches in sets but not in classifiedCount", () => {
    const index = buildGenreIndexFromRows(
      [{ id: 2, category: "Horror Movies", genre: "" }],
      {}
    )
    expect(index.sets.get("horror")).toEqual(new Set([2]))
    expect(index.classifiedCount).toBe(0)
    expect(index.totalCount).toBe(1)
  })

  it("merges detail notes with row genres as a union", () => {
    const notes: Record<number, GenreId[]> = { 3: ["thriller"] }
    const index = buildGenreIndexFromRows(
      [{ id: 3, category: "", genre: "Drama" }],
      notes
    )
    expect(index.sets.get("drama")).toEqual(new Set([3]))
    expect(index.sets.get("thriller")).toEqual(new Set([3]))
    expect(index.classifiedCount).toBe(1)
  })

  it("counts a title classified via notes alone (no row genre)", () => {
    const notes: Record<number, GenreId[]> = { 4: ["western"] }
    const index = buildGenreIndexFromRows([{ id: 4, category: "" }], notes)
    expect(index.sets.get("western")).toEqual(new Set([4]))
    expect(index.classifiedCount).toBe(1)
  })

  it("unions category fallback on top of row genre + notes for the same title", () => {
    const notes: Record<number, GenreId[]> = { 5: ["mystery"] }
    const index = buildGenreIndexFromRows(
      [{ id: 5, category: "Family Fun", genre: "Crime" }],
      notes
    )
    expect(index.sets.get("crime")).toEqual(new Set([5]))
    expect(index.sets.get("mystery")).toEqual(new Set([5]))
    expect(index.sets.get("family")).toEqual(new Set([5]))
    expect(index.classifiedCount).toBe(1)
  })

  it("returns empty sets and zero counts for an empty row list", () => {
    const index = buildGenreIndexFromRows([], {})
    expect(index.sets.size).toBe(0)
    expect(index.classifiedCount).toBe(0)
    expect(index.totalCount).toBe(0)
  })

  it("computes totalCount/classifiedCount across a mixed row set", () => {
    const notes: Record<number, GenreId[]> = { 20: ["horror"] }
    const rows = [
      { id: 10, category: "", genre: "Action" },
      { id: 11, category: "Uncategorized", genre: "" },
      { id: 20, category: "" },
    ]
    const index = buildGenreIndexFromRows(rows, notes)
    expect(index.totalCount).toBe(3)
    expect(index.classifiedCount).toBe(2)
    expect(index.sets.get("action")).toEqual(new Set([10]))
    expect(index.sets.has("uncategorized" as GenreId)).toBe(false)
  })

  it("skips rows with a non-numeric id", () => {
    const index = buildGenreIndexFromRows(
      [{ id: "not-a-number", category: "", genre: "Comedy" }],
      {}
    )
    expect(index.sets.size).toBe(0)
    expect(index.classifiedCount).toBe(0)
    expect(index.totalCount).toBe(1)
  })

  it("keeps each genre id's title set independent across multiple titles", () => {
    const index = buildGenreIndexFromRows(
      [
        { id: 30, category: "", genre: "Comedy" },
        { id: 31, category: "", genre: "Comedy, Drama" },
      ],
      {}
    )
    expect(index.sets.get("comedy")).toEqual(new Set([30, 31]))
    expect(index.sets.get("drama")).toEqual(new Set([31]))
    expect(index.classifiedCount).toBe(2)
  })
})
