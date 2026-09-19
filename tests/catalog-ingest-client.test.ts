// Vitest runs in node without Worker, so these exercise ingestXtreamBytes's
// synchronous main-thread fallback and assert it matches the plain mappers exactly.
import { describe, it, expect } from "vitest"
import { ingestXtreamBytes } from "../src/scripts/lib/catalog-ingest-client"
import {
  parseCategoriesToMap,
  mapXtreamLiveRows,
  mapXtreamVodRows,
  mapXtreamSeriesRows,
  unwrapRows,
} from "../src/scripts/lib/catalog-mappers.js"

function toBuffer(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer
}

const rawCategories = [
  { category_id: 1, category_name: "News" },
  { category_id: 2, category_name: "Movies" },
]

describe("ingestXtreamBytes: live", () => {
  const rawLive = [
    { stream_id: 1, name: "CNN", category_ids: [1] },
    { stream_id: 2, name: "BBC", category_id: 1, num: 2 },
    { stream_id: 0, name: "Bad" },
  ]

  it("matches mapXtreamLiveRows on a bare array payload", async () => {
    const categoryMap = parseCategoriesToMap(rawCategories)
    const rows = await ingestXtreamBytes("live", toBuffer(rawLive), Array.from(categoryMap))
    expect(rows).toEqual(mapXtreamLiveRows(rawLive, categoryMap))
  })

  it("matches mapXtreamLiveRows on a {streams} wrapper payload", async () => {
    const categoryMap = parseCategoriesToMap(rawCategories)
    const wrapped = { streams: rawLive }
    const rows = await ingestXtreamBytes("live", toBuffer(wrapped), Array.from(categoryMap))
    expect(rows).toEqual(mapXtreamLiveRows(unwrapRows(wrapped, "streams"), categoryMap))
  })
})

describe("ingestXtreamBytes: vod", () => {
  const rawVod = [
    { stream_id: 10, name: "Movie One", category_id: 2, added: 100, tmdb: 55 },
    { stream_id: 11, name: "Another Movie", category_id: 2, added: 200 },
  ]

  it("matches mapXtreamVodRows including its name sort", async () => {
    const categoryMap = parseCategoriesToMap(rawCategories)
    const rows = await ingestXtreamBytes("vod", toBuffer(rawVod), Array.from(categoryMap))
    expect(rows).toEqual(mapXtreamVodRows(rawVod, categoryMap))
  })

  it("matches mapXtreamVodRows on a {movies} wrapper payload", async () => {
    const categoryMap = parseCategoriesToMap(rawCategories)
    const wrapped = { movies: rawVod }
    const rows = await ingestXtreamBytes("vod", toBuffer(wrapped), Array.from(categoryMap))
    expect(rows).toEqual(mapXtreamVodRows(unwrapRows(wrapped, "movies"), categoryMap))
  })
})

describe("ingestXtreamBytes: series", () => {
  const rawSeries = [
    { series_id: 20, name: "Show One", category_id: 2, last_modified: 100, genre: "Drama" },
    { series_id: 21, name: "Show Two", category_id: 2, last_modified: 50 },
  ]

  it("matches mapXtreamSeriesRows including its name sort", async () => {
    const categoryMap = parseCategoriesToMap(rawCategories)
    const rows = await ingestXtreamBytes("series", toBuffer(rawSeries), Array.from(categoryMap))
    expect(rows).toEqual(mapXtreamSeriesRows(rawSeries, categoryMap))
  })

  it("matches mapXtreamSeriesRows on a {results} wrapper payload", async () => {
    const categoryMap = parseCategoriesToMap(rawCategories)
    const wrapped = { results: rawSeries }
    const rows = await ingestXtreamBytes("series", toBuffer(wrapped), Array.from(categoryMap))
    expect(rows).toEqual(mapXtreamSeriesRows(unwrapRows(wrapped, "series"), categoryMap))
  })
})

describe("ingestXtreamBytes: error propagation", () => {
  it("rejects with a plain Error on malformed JSON, so HttpRetryError classification still applies", async () => {
    const badBuffer = new TextEncoder().encode("not json").buffer
    await expect(ingestXtreamBytes("live", badBuffer, [])).rejects.toBeInstanceOf(Error)
  })
})
