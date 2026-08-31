import { describe, it, expect, vi, beforeEach } from "vitest"

const xtreamApiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/scripts/lib/xtream-api.js", () => ({
  xtreamApiFetch: xtreamApiFetchMock,
}))

import {
  mapShortEpgRows,
  xtreamShortEpgAvailable,
  fetchShortEpg,
  fetchChannelEpgTable,
  createShortEpgCache,
  type Programme,
  type XtreamCreds,
} from "../src/scripts/lib/short-epg.ts"

const xtreamCreds: XtreamCreds = {
  host: "iptv.example.com",
  port: "8080",
  user: "alice",
  pass: "secret",
}

const m3uCreds: XtreamCreds = {
  host: "https://m3u.example.com/list.m3u8",
  port: "",
  user: "",
  pass: "",
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64")
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: async () => body }
}

describe("mapShortEpgRows", () => {
  it("maps plain-text and base64 title/description, converting seconds to ms", () => {
    const rows = [
      {
        title: "Local News",
        description: "Local News",
        start_timestamp: "900",
        stop_timestamp: "1900",
      },
      {
        title: b64("Late Night Show"),
        description: b64("Élan Café — 20h"),
        start_timestamp: "2000",
        stop_timestamp: "3000",
      },
    ]
    const result = mapShortEpgRows(rows, 0)
    expect(result).toEqual([
      { start: 900_000, stop: 1_900_000, title: "Local News", desc: "Local News" },
      { start: 2_000_000, stop: 3_000_000, title: "Late Night Show", desc: "Élan Café — 20h" },
    ])
  })

  it("falls back to title_raw/description_raw and an untitled label when both are missing", () => {
    const rows = [
      { title_raw: "Fallback Title", description_raw: "Fallback desc.", start: "100", end: "200" },
      { start: "300", end: "400" },
    ]
    const result = mapShortEpgRows(rows, 0)
    expect(result[0]).toEqual({ start: 100_000, stop: 200_000, title: "Fallback Title", desc: "Fallback desc." })
    expect(result[1].title).toBe("Untitled")
    expect(result[1].desc).toBe("")
  })

  it("maps has_archive to a boolean and omits it when absent", () => {
    const rows = [
      { title: "A", start: "10", end: "20", has_archive: "1" },
      { title: "B", start: "20", end: "30", has_archive: "0" },
      { title: "C", start: "30", end: "40" },
    ]
    const result = mapShortEpgRows(rows, 0)
    expect(result[0].hasArchive).toBe(true)
    expect(result[1].hasArchive).toBe(false)
    expect(result[2].hasArchive).toBeUndefined()
  })

  it("drops rows with invalid, non-finite, or non-positive-duration ranges", () => {
    const rows = [
      { title: "bad-order", start: "200", end: "100" },
      { title: "zero-duration", start: "100", end: "100" },
      { title: "nan", start: "not-a-number", end: "999" },
      { title: "ok", start: "100", end: "200" },
    ]
    const result = mapShortEpgRows(rows, 0)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe("ok")
  })

  it("drops rows already ended by nowMs but keeps history when nowMs is 0", () => {
    const rows = [
      { title: "past.", start: "10", end: "20" },
      { title: "current", start: "15", end: "9999999999" },
    ]
    const filtered = mapShortEpgRows(rows, 20_000)
    expect(filtered.map((programme) => programme.title)).toEqual(["current"])

    const unfiltered = mapShortEpgRows(rows, 0)
    expect(unfiltered.map((programme) => programme.title)).toEqual(["past.", "current"])
  })

  it("sorts by start ascending regardless of input order", () => {
    const rows = [
      { title: "second", start: "200", end: "300" },
      { title: "first", start: "100", end: "150" },
    ]
    const result = mapShortEpgRows(rows, 0)
    expect(result.map((programme) => programme.title)).toEqual(["first", "second"])
  })

  it("ignores non-array input and malformed row entries", () => {
    expect(mapShortEpgRows(null, 0)).toEqual([])
    expect(mapShortEpgRows(undefined, 0)).toEqual([])
    expect(mapShortEpgRows([null, 42, "x", { start: "1", end: "2" }], 0)).toHaveLength(1)
  })
})

describe("xtreamShortEpgAvailable", () => {
  it("is true for a well-formed Xtream source", () => {
    expect(xtreamShortEpgAvailable(xtreamCreds)).toBe(true)
  })

  it("is false for an M3U-style source", () => {
    expect(xtreamShortEpgAvailable(m3uCreds)).toBe(false)
  })

  it("is false when host/user/pass are missing", () => {
    expect(xtreamShortEpgAvailable(null)).toBe(false)
    expect(xtreamShortEpgAvailable({ host: "", user: "", pass: "" })).toBe(false)
    expect(xtreamShortEpgAvailable({ host: "iptv.example.com", user: "alice", pass: "" })).toBe(false)
  })
})

describe("fetchShortEpg", () => {
  beforeEach(() => {
    xtreamApiFetchMock.mockReset()
  })

  it("fetches get_short_epg and maps epg_listings", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const startSeconds = nowSeconds + 100
    const stopSeconds = nowSeconds + 200
    xtreamApiFetchMock.mockResolvedValueOnce(
      jsonResponse({ epg_listings: [{ title: "Now Airing", start: String(startSeconds), end: String(stopSeconds) }] })
    )
    const result = await fetchShortEpg(xtreamCreds, 55, 4)
    expect(result).toEqual([{ start: startSeconds * 1000, stop: stopSeconds * 1000, title: "Now Airing", desc: "" }])
    expect(xtreamApiFetchMock).toHaveBeenCalledWith(
      "get_short_epg",
      { stream_id: "55", limit: "4" },
      {}
    )
  })

  it("forwards entryId as an xtreamApiFetch option", async () => {
    xtreamApiFetchMock.mockResolvedValueOnce(jsonResponse({ epg_listings: [] }))
    await fetchShortEpg({ ...xtreamCreds, entryId: "playlist-1" }, 55)
    expect(xtreamApiFetchMock).toHaveBeenCalledWith(
      "get_short_epg",
      { stream_id: "55", limit: "4" },
      { entryId: "playlist-1" }
    )
  })

  it("returns null for a non-ok response, malformed body, or thrown error", async () => {
    xtreamApiFetchMock.mockResolvedValueOnce(jsonResponse({}, false))
    expect(await fetchShortEpg(xtreamCreds, 1)).toBeNull()

    xtreamApiFetchMock.mockResolvedValueOnce(jsonResponse({ foo: "bar" }))
    expect(await fetchShortEpg(xtreamCreds, 1)).toBeNull()

    xtreamApiFetchMock.mockRejectedValueOnce(new Error("network down"))
    expect(await fetchShortEpg(xtreamCreds, 1)).toBeNull()
  })

  it("returns null without calling xtreamApiFetch for an M3U-style source", async () => {
    expect(await fetchShortEpg(m3uCreds, 1)).toBeNull()
    expect(xtreamApiFetchMock).not.toHaveBeenCalled()
  })
})

describe("fetchChannelEpgTable", () => {
  beforeEach(() => {
    xtreamApiFetchMock.mockReset()
  })

  it("uses get_simple_data_table when it succeeds", async () => {
    xtreamApiFetchMock.mockResolvedValueOnce(
      jsonResponse({ epg_listings: [{ title: "Day show", start: "100", end: "200" }] })
    )
    const result = await fetchChannelEpgTable(xtreamCreds, 7)
    expect(result).toEqual([{ start: 100_000, stop: 200_000, title: "Day show", desc: "" }])
    expect(xtreamApiFetchMock).toHaveBeenCalledTimes(1)
    expect(xtreamApiFetchMock).toHaveBeenCalledWith("get_simple_data_table", { stream_id: "7" }, {})
  })

  it("falls back to get_simple_date_table when the first spelling fails", async () => {
    xtreamApiFetchMock.mockResolvedValueOnce(jsonResponse({}, false))
    xtreamApiFetchMock.mockResolvedValueOnce(
      jsonResponse({ epg_listings: [{ title: "Fallback show.", start: "100", end: "200" }] })
    )
    const result = await fetchChannelEpgTable(xtreamCreds, 7)
    expect(result).toEqual([{ start: 100_000, stop: 200_000, title: "Fallback show.", desc: "" }])
    expect(xtreamApiFetchMock).toHaveBeenNthCalledWith(1, "get_simple_data_table", { stream_id: "7" }, {})
    expect(xtreamApiFetchMock).toHaveBeenNthCalledWith(2, "get_simple_date_table", { stream_id: "7" }, {})
  })

  it("returns an empty array when the provider legitimately has no listings", async () => {
    xtreamApiFetchMock.mockResolvedValueOnce(jsonResponse({ epg_listings: [] }))
    expect(await fetchChannelEpgTable(xtreamCreds, 7)).toEqual([])
    expect(xtreamApiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns null when every action spelling fails", async () => {
    xtreamApiFetchMock.mockRejectedValueOnce(new Error("boom"))
    xtreamApiFetchMock.mockResolvedValueOnce(jsonResponse({}, false))
    expect(await fetchChannelEpgTable(xtreamCreds, 7)).toBeNull()
    expect(xtreamApiFetchMock).toHaveBeenCalledTimes(2)
  })
})

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("createShortEpgCache", () => {
  let currentTime: number
  const now = () => currentTime

  beforeEach(() => {
    currentTime = 1_000_000
  })

  it("caches a fresh now/next result and dedupes concurrent in-flight requests", async () => {
    const fetchShortEpgFn = vi.fn(async (): Promise<Programme[]> => [
      { start: currentTime - 1000, stop: currentTime + 1000, title: "Current", desc: "" },
      { start: currentTime + 1000, stop: currentTime + 2000, title: "Next", desc: "" },
    ])
    const cache = createShortEpgCache({ fetchShortEpg: fetchShortEpgFn, now })

    const [first, second] = await Promise.all([
      cache.getNowNext(xtreamCreds, 1),
      cache.getNowNext(xtreamCreds, 1),
    ])
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)
    expect(first?.current?.title).toBe("Current")
    expect(first?.next?.title).toBe("Next")
    expect(second).toEqual(first)

    const cachedAgain = await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)
    expect(cachedAgain?.current?.title).toBe("Current")
  })

  it("expires the now/next cache entry once the current programme's stop passes", async () => {
    const fetchShortEpgFn = vi.fn(async (): Promise<Programme[]> => [
      { start: currentTime, stop: currentTime + 5000, title: "Current", desc: "" },
    ])
    const cache = createShortEpgCache({ fetchShortEpg: fetchShortEpgFn, now, nowNextMaxTtlMs: 15 * 60 * 1000 })

    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)

    currentTime += 4999
    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)

    currentTime += 2 // now past the cached programme's stop
    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(2)
  })

  it("expires the now/next cache entry after the max TTL even if the programme is still airing", async () => {
    const fetchShortEpgFn = vi.fn(async (): Promise<Programme[]> => [
      { start: currentTime, stop: currentTime + 60 * 60 * 1000, title: "Long show", desc: "" },
    ])
    const cache = createShortEpgCache({ fetchShortEpg: fetchShortEpgFn, now, nowNextMaxTtlMs: 15 * 60 * 1000 })

    await cache.getNowNext(xtreamCreds, 1)
    currentTime += 15 * 60 * 1000 - 1
    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)

    currentTime += 1
    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(2)
  })

  it("caches the full programme table with a fixed TTL", async () => {
    const fetchChannelEpgTableFn = vi.fn(async (): Promise<Programme[]> => [
      { start: 0, stop: 1000, title: "History", desc: "" },
    ])
    const cache = createShortEpgCache({ fetchChannelEpgTable: fetchChannelEpgTableFn, now, programmesTtlMs: 1000 })

    const first = await cache.getProgrammes(xtreamCreds, 5)
    expect(first).toHaveLength(1)
    expect(fetchChannelEpgTableFn).toHaveBeenCalledTimes(1)

    currentTime += 999
    await cache.getProgrammes(xtreamCreds, 5)
    expect(fetchChannelEpgTableFn).toHaveBeenCalledTimes(1)

    currentTime += 2
    await cache.getProgrammes(xtreamCreds, 5)
    expect(fetchChannelEpgTableFn).toHaveBeenCalledTimes(2)
  })

  it("caches a negative result on failure and retries only after the negative TTL", async () => {
    const fetchShortEpgFn = vi.fn(async (): Promise<Programme[] | null> => null)
    const cache = createShortEpgCache({ fetchShortEpg: fetchShortEpgFn, now, negativeTtlMs: 60_000 })

    expect(await cache.getNowNext(xtreamCreds, 9)).toBeNull()
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)

    currentTime += 59_999
    expect(await cache.getNowNext(xtreamCreds, 9)).toBeNull()
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)

    currentTime += 2
    expect(await cache.getNowNext(xtreamCreds, 9)).toBeNull()
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(2)
  })

  it("evicts the least-recently-used channel once the LRU cap is exceeded", async () => {
    const fetchShortEpgFn = vi.fn(async (): Promise<Programme[]> => [])
    const cache = createShortEpgCache({ fetchShortEpg: fetchShortEpgFn, now, maxEntries: 2 })

    await cache.getNowNext(xtreamCreds, 1)
    await cache.getNowNext(xtreamCreds, 2)
    await cache.getNowNext(xtreamCreds, 3) // evicts channel 1
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(3)

    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(4) // channel 1 had to be refetched

    await cache.getNowNext(xtreamCreds, 3)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(4) // channel 3 was still cached
  })

  it("caps parallel requests and serves the most recently queued one first (LIFO)", async () => {
    const started: number[] = []
    const deferreds = new Map<number, ReturnType<typeof createDeferred<Programme[]>>>()
    const fetchShortEpgFn = vi.fn((_creds: XtreamCreds, streamId: string | number) => {
      const id = Number(streamId)
      started.push(id)
      const deferred = createDeferred<Programme[]>()
      deferreds.set(id, deferred)
      return deferred.promise
    })
    const cache = createShortEpgCache({ fetchShortEpg: fetchShortEpgFn, now, concurrency: 4 })

    const results = [1, 2, 3, 4, 5, 6].map((id) => cache.getNowNext(xtreamCreds, id))
    expect(started).toEqual([1, 2, 3, 4])

    deferreds.get(1)!.resolve([])
    await flushAsync()
    expect(started).toEqual([1, 2, 3, 4, 6])

    deferreds.get(2)!.resolve([])
    await flushAsync()
    expect(started).toEqual([1, 2, 3, 4, 6, 5])

    deferreds.get(3)!.resolve([])
    deferreds.get(4)!.resolve([])
    deferreds.get(5)!.resolve([])
    deferreds.get(6)!.resolve([])
    await Promise.all(results)
  })

  it("clear() drops cached entries and negative results so the next call refetches", async () => {
    const fetchShortEpgFn = vi.fn(async (): Promise<Programme[]> => [])
    const cache = createShortEpgCache({ fetchShortEpg: fetchShortEpgFn, now })

    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(1)
    cache.clear()
    await cache.getNowNext(xtreamCreds, 1)
    expect(fetchShortEpgFn).toHaveBeenCalledTimes(2)
  })
})
