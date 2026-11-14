import { describe, it, expect } from "vitest"
import {
  filterAndSortEntries,
  gridCategoryMatcher,
  gridEntryKey,
  gridWatchedMatcher,
} from "@/scripts/lib/tv-grid-filter"
import { filterCatalog } from "@/scripts/tv/catalog-filter-client"
import { normalize } from "@/scripts/lib/text.ts"

interface Row {
  id: number
  key?: string
  name: string
  category?: string | null
}

const GENRE_PREFIX = "__genre__:"

const mergedRows: Row[] = [
  { id: 1, key: "pl-a:1", name: "Alpha", category: "Action · A" },
  { id: 1, key: "pl-b:1", name: "Beta", category: "Action · B" },
  { id: 2, key: "pl-b:2", name: "Gamma", category: "Drama · B" },
]

describe("gridEntryKey", () => {
  it("prefers the explicit key and falls back to the id", () => {
    expect(gridEntryKey({ id: 7, key: "pl-a:7" })).toBe("pl-a:7")
    expect(gridEntryKey({ id: 7 })).toBe("7")
  })
})

describe("gridCategoryMatcher", () => {
  it("matches genre rows by key so colliding ids across playlists stay apart", () => {
    const matches = gridCategoryMatcher<Row>({
      genrePrefix: GENRE_PREFIX,
      genreMatchKeys: ["pl-b:1"],
      uncategorizedLabel: "Uncategorized",
    })
    const hits = mergedRows.filter((row) => matches(row, `${GENRE_PREFIX}action`))
    expect(hits.map((row) => row.name)).toEqual(["Beta"])
  })

  it("matches single-mode rows by stringified id", () => {
    const matches = gridCategoryMatcher<Row>({
      genrePrefix: GENRE_PREFIX,
      genreMatchKeys: ["2"],
      uncategorizedLabel: "Uncategorized",
    })
    expect(matches({ id: 2, name: "x" }, `${GENRE_PREFIX}drama`)).toBe(true)
    expect(matches({ id: 3, name: "y" }, `${GENRE_PREFIX}drama`)).toBe(false)
  })

  it("compares the rewritten category label for plain categories", () => {
    const matches = gridCategoryMatcher<Row>({ genrePrefix: GENRE_PREFIX, uncategorizedLabel: "Uncategorized" })
    expect(matches(mergedRows[0], "Action · A")).toBe(true)
    expect(matches(mergedRows[1], "Action · A")).toBe(false)
    expect(matches({ id: 9, name: "z", category: "  " }, "Uncategorized")).toBe(true)
  })
})

describe("gridWatchedMatcher", () => {
  it("hides only the watched playlist's copy of a colliding id", () => {
    const isWatched = gridWatchedMatcher<Row>(["pl-a:1"])
    expect(mergedRows.filter(isWatched).map((row) => row.name)).toEqual(["Alpha"])
  })
})

describe("filterCatalog with keyed params", () => {
  it("applies genre keys and watched keys through the sync path", async () => {
    const indexes = await filterCatalog("test:merged-keys", mergedRows, {
      state: { category: `${GENRE_PREFIX}action`, query: "", hideWatched: true, sort: "default" },
      category: { isGenreCategory: true, genreMatchKeys: ["pl-a:1", "pl-b:1"], uncategorizedLabel: "Uncategorized" },
      watchedKeys: ["pl-a:1"],
    })
    expect(indexes && Array.from(indexes)).toEqual([1])
  })

  it("matches the main-thread pipeline", async () => {
    const state = { category: "Drama · B", query: "", hideWatched: false, sort: "az" }
    const indexes = await filterCatalog("test:merged-parity", mergedRows, {
      state,
      category: { isGenreCategory: false, uncategorizedLabel: "Uncategorized" },
    })
    const expected = filterAndSortEntries(mergedRows, state, {
      categoryMatcher: gridCategoryMatcher<Row>({ genrePrefix: GENRE_PREFIX, uncategorizedLabel: "Uncategorized" }),
      isWatched: () => false,
      normalize,
    })
    expect(indexes && Array.from(indexes, (index) => mergedRows[index])).toEqual(expected)
  })
})
