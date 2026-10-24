import { describe, expect, it } from "vitest"
import { interleaveByPlaylist, selectRowsForCategory, type GridFilterContext } from "../src/scripts/lib/grid-filter.ts"
import { mergedCategoryKey } from "../src/scripts/lib/merged-catalog-core.ts"

const rows = [
  { id: 101, playlistId: "A", category: "Action", name: "A101" },
  { id: 102, playlistId: "A", category: "Drama", name: "A102" },
  { id: 101, playlistId: "B", category: "Action", name: "B101" },
  { id: 103, playlistId: "B", category: "", name: "B103" },
]

function makeContext(overrides: Partial<GridFilterContext> = {}): GridFilterContext {
  return {
    favoritesFor: () => new Set(),
    recentsFor: () => [],
    genreSetFor: () => null,
    categoryPassesFilter: () => true,
    fallbackPlaylistId: "A",
    ...overrides,
  }
}

const names = (selected: typeof rows) => selected.map((row) => row.name)

describe("selectRowsForCategory", () => {
  it("keeps the same numeric id in two playlists as two rows", () => {
    expect(names(selectRowsForCategory(rows, "", makeContext()))).toEqual(["A101", "A102", "B101", "B103"])
  })

  it("resolves favorites against each row's own playlist", () => {
    const context = makeContext({
      favoritesFor: (playlistId) => (playlistId === "B" ? new Set([101]) : new Set()),
    })
    expect(names(selectRowsForCategory(rows, "__favorites__", context))).toEqual(["B101"])
  })

  it("merges recents across playlists by timestamp", () => {
    const context = makeContext({
      recentsFor: (playlistId) =>
        playlistId === "A"
          ? [{ id: 102, ts: 10 }, { id: 101, ts: 1 }]
          : [{ id: 103, ts: 5 }, { id: 999, ts: 50 }],
    })
    expect(names(selectRowsForCategory(rows, "__recents__", context))).toEqual(["A102", "B103", "A101"])
  })

  it("uses the genre set of each row's playlist", () => {
    const context = makeContext({
      genreSetFor: (playlistId, genreId) =>
        genreId === "action" ? (playlistId === "A" ? new Set([101]) : undefined) : null,
    })
    expect(names(selectRowsForCategory(rows, "__genre__:action", context))).toEqual(["A101"])
  })

  it("does not let a hidden category in A hide the same name in B", () => {
    const context = makeContext({
      categoryPassesFilter: (value) => value !== mergedCategoryKey("A", "Action"),
    })
    expect(names(selectRowsForCategory(rows, "", context))).toEqual(["A102", "B101", "B103"])
  })

  it("selects only the matching playlist for a composite category key", () => {
    const selected = selectRowsForCategory(rows, mergedCategoryKey("B", "Action"), makeContext())
    expect(names(selected)).toEqual(["B101"])
  })

  it("resolves a legacy bare category name to the fallback playlist", () => {
    expect(names(selectRowsForCategory(rows, "Action", makeContext()))).toEqual(["A101"])
    expect(names(selectRowsForCategory(rows, "Action", makeContext({ fallbackPlaylistId: "B" })))).toEqual(["B101"])
  })

  it("matches uncategorized rows through the fallback category name", () => {
    const context = makeContext({ fallbackCategoryName: "Uncategorized" })
    const selected = selectRowsForCategory(rows, mergedCategoryKey("B", "Uncategorized"), context)
    expect(names(selected)).toEqual(["B103"])
  })
})

describe("interleaveByPlaylist", () => {
  it("round-robins groups up to the limit", () => {
    expect(interleaveByPlaylist([[1, 2, 3], [4, 5], [6]], 5)).toEqual([1, 4, 6, 2, 5])
  })

  it("gives a short group's remainder to the others", () => {
    expect(interleaveByPlaylist([[1], [2, 3, 4]], 4)).toEqual([1, 2, 3, 4])
  })

  it("returns everything when under the limit", () => {
    expect(interleaveByPlaylist([[1], [2]], 12)).toEqual([1, 2])
  })
})
