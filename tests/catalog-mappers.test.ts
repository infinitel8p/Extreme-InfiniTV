import { describe, it, expect } from "vitest"
import {
  parseCategoriesToMap,
  mapXtreamLiveRows,
  mapXtreamVodRows,
  mapXtreamSeriesRows,
} from "../src/scripts/lib/catalog-mappers.js"
import { normalize } from "../src/scripts/lib/text"

describe("parseCategoriesToMap", () => {
  it("accepts a plain array", () => {
    const map = parseCategoriesToMap([
      { category_id: 1, category_name: "News" },
      { category_id: 2, category_name: "Sports" },
    ])
    expect(map.get("1")).toBe("News")
    expect(map.get("2")).toBe("Sports")
  })

  it("accepts a {categories} wrapper", () => {
    const map = parseCategoriesToMap({
      categories: [{ category_id: 3, category_name: "Kids" }],
    })
    expect(map.get("3")).toBe("Kids")
  })

  it("returns an empty map for unrecognized shapes", () => {
    const map = parseCategoriesToMap({ nope: true })
    expect(map.size).toBe(0)
  })

  it("skips entries with null or undefined category_id", () => {
    const map = parseCategoriesToMap([
      { category_id: null, category_name: "Ignored" },
      { category_id: undefined, category_name: "AlsoIgnored" },
      { category_id: 5, category_name: "Kept" },
    ])
    expect(map.size).toBe(1)
    expect(map.get("5")).toBe("Kept")
  })

  it("coerces numeric category_id to a string key", () => {
    const map = parseCategoriesToMap([{ category_id: 42, category_name: "Movies" }])
    expect(map.has("42")).toBe(true)
    expect(map.has(42 as unknown as string)).toBe(false)
  })
})

describe("mapXtreamLiveRows", () => {
  it("resolves category via category_ids[0] fallback when category_name is blank", () => {
    const categoryMap = new Map([["10", "News"]])
    const rows = mapXtreamLiveRows(
      [{ stream_id: 1, name: "CNN", category_ids: [10], category_id: 20 }],
      categoryMap
    )
    expect(rows[0].category).toBe("News")
  })

  it("falls back to category_id when category_ids is empty", () => {
    const categoryMap = new Map([["20", "World"]])
    const rows = mapXtreamLiveRows(
      [{ stream_id: 1, name: "BBC", category_ids: [], category_id: 20 }],
      categoryMap
    )
    expect(rows[0].category).toBe("World")
  })

  it("prefers category_name over the category map", () => {
    const categoryMap = new Map([["10", "News"]])
    const rows = mapXtreamLiveRows(
      [{ stream_id: 1, name: "CNN", category_ids: [10], category_name: "Breaking" }],
      categoryMap
    )
    expect(rows[0].category).toBe("Breaking")
  })

  it("filters out rows missing id or name", () => {
    const rows = mapXtreamLiveRows(
      [
        { stream_id: 1, name: "" },
        { stream_id: 0, name: "No id" },
        { stream_id: 2, name: "Valid" },
      ],
      new Map()
    )
    expect(rows.map((row) => row.name)).toEqual(["Valid"])
  })

  it("coerces tv_archive and tv_archive_duration to numbers", () => {
    const rows = mapXtreamLiveRows(
      [{ stream_id: 1, name: "Ch", tv_archive: "1", tv_archive_duration: "48" }],
      new Map()
    )
    expect(rows[0].tvArchive).toBe(1)
    expect(rows[0].tvArchiveDuration).toBe(48)
  })

  it("defaults tv_archive and tv_archive_duration to 0 when missing", () => {
    const rows = mapXtreamLiveRows([{ stream_id: 1, name: "Ch" }], new Map())
    expect(rows[0].tvArchive).toBe(0)
    expect(rows[0].tvArchiveDuration).toBe(0)
  })

  it("sets norm to normalize(name + ' ' + category)", () => {
    const rows = mapXtreamLiveRows(
      [{ stream_id: 1, name: "CNN", category_name: "News" }],
      new Map()
    )
    expect(rows[0].norm).toBe(normalize("CNN News"))
  })
})

describe("mapXtreamVodRows", () => {
  it("sorts by name using en/base localeCompare", () => {
    const rows = mapXtreamVodRows(
      [
        { stream_id: 1, name: "banana" },
        { stream_id: 2, name: "Apple" },
        { stream_id: 3, name: "cherry" },
      ],
      new Map()
    )
    expect(rows.map((row) => row.name)).toEqual(["Apple", "banana", "cherry"])
  })

  it("defaults added to 0 when missing", () => {
    const rows = mapXtreamVodRows([{ stream_id: 1, name: "Movie" }], new Map())
    expect(rows[0].added).toBe(0)
  })

  it("coerces added to a number", () => {
    const rows = mapXtreamVodRows(
      [{ stream_id: 1, name: "Movie", added: "12345" }],
      new Map()
    )
    expect(rows[0].added).toBe(12345)
  })

  it("stringifies rating and duration only when present", () => {
    const rows = mapXtreamVodRows(
      [
        { stream_id: 1, name: "A", rating: 7.5, duration: 5400 },
        { stream_id: 2, name: "B" },
      ],
      new Map()
    )
    expect(rows[0].rating).toBe("7.5")
    expect(rows[0].duration).toBe("5400")
    expect(rows[1].rating).toBe("")
    expect(rows[1].duration).toBe("")
  })

  it("falls back through name/title, logo, and category_id[0] sources", () => {
    const categoryMap = new Map([["9", "Comedy"]])
    const rows = mapXtreamVodRows(
      [{ stream_id: 1, title: "Only Title", cover: "cover.jpg", category_ids: [9] }],
      categoryMap
    )
    expect(rows[0].name).toBe("Only Title")
    expect(rows[0].logo).toBe("cover.jpg")
    expect(rows[0].category).toBe("Comedy")
  })

  it("filters out rows missing id or name", () => {
    const rows = mapXtreamVodRows(
      [{ stream_id: 1, name: "" }, { stream_id: 0, name: "No id" }],
      new Map()
    )
    expect(rows).toEqual([])
  })
})

describe("mapXtreamSeriesRows", () => {
  it("prefers last_modified over added over releaseDate", () => {
    const rows = mapXtreamSeriesRows(
      [
        {
          series_id: 1,
          name: "A",
          last_modified: "100",
          added: "200",
          releaseDate: "2020-01-01",
        },
      ],
      new Map()
    )
    expect(rows[0].added).toBe(100)
  })

  it("falls back to added when last_modified is missing", () => {
    const rows = mapXtreamSeriesRows(
      [{ series_id: 1, name: "A", added: "200", releaseDate: "2020-01-01" }],
      new Map()
    )
    expect(rows[0].added).toBe(200)
  })

  it("falls back to Date.parse(releaseDate)/1000 when last_modified and added are absent", () => {
    const releaseDate = "2020-01-01T00:00:00.000Z"
    const rows = mapXtreamSeriesRows([{ series_id: 1, name: "A", releaseDate }], new Map())
    expect(rows[0].added).toBe(Date.parse(releaseDate) / 1000)
  })

  it("defaults added to 0 when no source is present", () => {
    const rows = mapXtreamSeriesRows([{ series_id: 1, name: "A" }], new Map())
    expect(rows[0].added).toBe(0)
  })

  it("sorts by name using en/base localeCompare", () => {
    const rows = mapXtreamSeriesRows(
      [
        { series_id: 1, name: "banana" },
        { series_id: 2, name: "Apple" },
      ],
      new Map()
    )
    expect(rows.map((row) => row.name)).toEqual(["Apple", "banana"])
  })

  it("resolves category via category_ids[0] fallback then category_id", () => {
    const categoryMap = new Map([["7", "Drama"]])
    const rows = mapXtreamSeriesRows(
      [{ series_id: 1, name: "A", category_ids: [7] }],
      categoryMap
    )
    expect(rows[0].category).toBe("Drama")
  })

  it("filters out rows missing id or name", () => {
    const rows = mapXtreamSeriesRows(
      [{ series_id: 1, name: "" }, { series_id: 0, name: "No id" }],
      new Map()
    )
    expect(rows).toEqual([])
  })

  it("keeps plot from the source row", () => {
    const rows = mapXtreamSeriesRows([{ series_id: 1, name: "A", plot: "A story" }], new Map())
    expect(rows[0].plot).toBe("A story")
  })
})
