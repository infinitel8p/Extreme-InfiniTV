import { describe, it, expect } from "vitest"
import {
  pickBecauseSeedPool,
  pickNextSeed,
  seedKey,
  buildBecauseRow,
  type WatchedSignal,
  type BecauseSeed,
} from "../src/scripts/lib/because-watched"
import type { LocalSimilarCandidate } from "../src/scripts/lib/similar-local"

describe("pickBecauseSeedPool", () => {
  it("orders signals by updatedAt descending", () => {
    const signals: WatchedSignal[] = [
      { kind: "vod", id: 1, name: "Old Movie", updatedAt: 100 },
      { kind: "vod", id: 2, name: "New Movie", updatedAt: 200 },
    ]
    const pool = pickBecauseSeedPool(signals)
    expect(pool).toEqual([
      { kind: "vod", id: 2, name: "New Movie", updatedAt: 200 },
      { kind: "vod", id: 1, name: "Old Movie", updatedAt: 100 },
    ])
  })

  it("normalizes an episode signal into a series seed", () => {
    const signals: WatchedSignal[] = [
      { kind: "episode", id: 10, seriesId: 5, seriesName: "Some Show", updatedAt: 50 },
    ]
    const pool = pickBecauseSeedPool(signals)
    expect(pool).toEqual([{ kind: "series", id: 5, name: "Some Show", updatedAt: 50 }])
  })

  it("dedupes multiple episodes of the same series to one seed at the max updatedAt", () => {
    const signals: WatchedSignal[] = [
      { kind: "episode", id: 1, seriesId: 5, seriesName: "Some Show", updatedAt: 50 },
      { kind: "episode", id: 2, seriesId: 5, seriesName: "Some Show", updatedAt: 300 },
      { kind: "episode", id: 3, seriesId: 5, seriesName: "Some Show", updatedAt: 150 },
    ]
    const pool = pickBecauseSeedPool(signals)
    expect(pool).toEqual([{ kind: "series", id: 5, name: "Some Show", updatedAt: 300 }])
  })

  it("skips a vod signal without a name", () => {
    const signals: WatchedSignal[] = [{ kind: "vod", id: 1, updatedAt: 100 }]
    expect(pickBecauseSeedPool(signals)).toEqual([])
  })

  it("skips an episode signal without a seriesId", () => {
    const signals: WatchedSignal[] = [
      { kind: "episode", id: 1, seriesName: "Some Show", updatedAt: 100 },
    ]
    expect(pickBecauseSeedPool(signals)).toEqual([])
  })

  it("skips an episode signal without a seriesName", () => {
    const signals: WatchedSignal[] = [{ kind: "episode", id: 1, seriesId: 5, updatedAt: 100 }]
    expect(pickBecauseSeedPool(signals)).toEqual([])
  })

  it("skips a signal with a non-numeric id", () => {
    const signals: WatchedSignal[] = [{ kind: "vod", id: "not-a-number", name: "Movie", updatedAt: 100 }]
    expect(pickBecauseSeedPool(signals)).toEqual([])
  })

  it("returns an empty array for empty input", () => {
    expect(pickBecauseSeedPool([])).toEqual([])
  })

  it("still yields a seed for completed-only signals", () => {
    const signals: WatchedSignal[] = [
      { kind: "vod", id: 1, name: "Finished Movie", updatedAt: 100, completed: true },
    ]
    const pool = pickBecauseSeedPool(signals)
    expect(pool).toEqual([{ kind: "vod", id: 1, name: "Finished Movie", updatedAt: 100 }])
  })

  it("caps the pool at poolSize", () => {
    const signals: WatchedSignal[] = Array.from({ length: 10 }, (_, index) => ({
      kind: "vod" as const,
      id: index,
      name: `Movie ${index}`,
      updatedAt: index,
    }))
    const pool = pickBecauseSeedPool(signals, 3)
    expect(pool.map((seed) => seed.id)).toEqual([9, 8, 7])
  })
})

describe("pickNextSeed", () => {
  const pool: BecauseSeed[] = [
    { kind: "vod", id: 1, name: "First", updatedAt: 300 },
    { kind: "vod", id: 2, name: "Second", updatedAt: 200 },
    { kind: "vod", id: 3, name: "Third", updatedAt: 100 },
  ]

  it("returns null for an empty pool", () => {
    expect(pickNextSeed([], null)).toBeNull()
    expect(pickNextSeed([], "vod:1")).toBeNull()
  })

  it("returns pool[0] when lastShownKey is null", () => {
    expect(pickNextSeed(pool, null)).toEqual(pool[0])
  })

  it("returns pool[0] when lastShownKey is not found in the pool", () => {
    expect(pickNextSeed(pool, "vod:999")).toEqual(pool[0])
  })

  it("returns the entry after the matching one", () => {
    expect(pickNextSeed(pool, seedKey(pool[0]))).toEqual(pool[1])
  })

  it("wraps around to pool[0] after the last entry", () => {
    expect(pickNextSeed(pool, seedKey(pool[2]))).toEqual(pool[0])
  })

  it("returns the single entry of a single-entry pool for any key", () => {
    const singlePool: BecauseSeed[] = [{ kind: "vod", id: 1, name: "Only", updatedAt: 100 }]
    expect(pickNextSeed(singlePool, null)).toEqual(singlePool[0])
    expect(pickNextSeed(singlePool, seedKey(singlePool[0]))).toEqual(singlePool[0])
    expect(pickNextSeed(singlePool, "vod:999")).toEqual(singlePool[0])
  })
})

describe("buildBecauseRow", () => {
  const seed: BecauseSeed = { kind: "vod", id: 1, name: "War of the Worlds", updatedAt: 100 }

  it("returns co-category candidates", () => {
    const catalog: LocalSimilarCandidate[] = [
      { id: 1, name: "War of the Worlds", category: "Sci-Fi" },
      { id: 2, name: "Other Sci-Fi", category: "Sci-Fi" },
      { id: 3, name: "Drama Title", category: "Drama" },
    ]
    const result = buildBecauseRow(seed, catalog)
    expect(result.map((entry) => entry.id)).toEqual([2])
  })

  it("excludes the seed itself", () => {
    const catalog: LocalSimilarCandidate[] = [
      { id: 1, name: "War of the Worlds", category: "Sci-Fi" },
      { id: 2, name: "Other Sci-Fi", category: "Sci-Fi" },
    ]
    const result = buildBecauseRow(seed, catalog)
    expect(result.some((entry) => entry.id === 1)).toBe(false)
  })

  it("excludes watched entries via isWatched", () => {
    const catalog: LocalSimilarCandidate[] = [
      { id: 1, name: "War of the Worlds", category: "Sci-Fi" },
      { id: 2, name: "Watched Already", category: "Sci-Fi" },
      { id: 3, name: "Unwatched", category: "Sci-Fi" },
    ]
    const result = buildBecauseRow(seed, catalog, { isWatched: (id) => id === 2 })
    expect(result.map((entry) => entry.id)).toEqual([3])
  })

  it("returns an empty array when the seed is missing from the catalog", () => {
    const catalog: LocalSimilarCandidate[] = [{ id: 2, name: "Other Sci-Fi", category: "Sci-Fi" }]
    expect(buildBecauseRow(seed, catalog)).toEqual([])
  })

  it("respects the limit option", () => {
    const catalog: LocalSimilarCandidate[] = [
      { id: 1, name: "War of the Worlds", category: "Sci-Fi" },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: index + 2,
        name: `Title ${index}`,
        category: "Sci-Fi",
      })),
    ]
    const result = buildBecauseRow(seed, catalog, { limit: 5 })
    expect(result).toHaveLength(5)
  })

  it("no longer excludes a candidate with a different language prefix from the seed", () => {
    const prefixedSeed: BecauseSeed = { kind: "vod", id: 1, name: "DE | Krieg der Welten", updatedAt: 100 }
    const catalog: LocalSimilarCandidate[] = [
      { id: 1, name: "DE | Krieg der Welten", category: "Sci-Fi" },
      { id: 2, name: "DE | Andere Welten", category: "Sci-Fi" },
      { id: 3, name: "FR | Autres Mondes", category: "Sci-Fi" },
      { id: 4, name: "Unprefixed Title", category: "Sci-Fi" },
    ]
    const result = buildBecauseRow(prefixedSeed, catalog)
    expect(result.map((entry) => entry.id).sort()).toEqual([2, 3, 4])
  })

  it("dedupes same-title candidates across language prefixes, preferring the preferredTags variant", () => {
    const catalog: LocalSimilarCandidate[] = [
      { id: 1, name: "War of the Worlds", category: "Sci-Fi" },
      { id: 2, name: "DE | Other Sci-Fi", category: "Sci-Fi" },
      { id: 3, name: "EN | Other Sci-Fi", category: "Sci-Fi" },
    ]
    const result = buildBecauseRow(seed, catalog)
    expect(result.map((entry) => entry.id)).toEqual([3])
  })

  it("reorders results when infoLookup supplies a director match", () => {
    const catalog: LocalSimilarCandidate[] = [
      { id: 1, name: "War of the Worlds", category: "Sci-Fi" },
      { id: 2, name: "Category only", category: "Sci-Fi" },
      { id: 3, name: "Director match", category: "Drama" },
    ]
    const result = buildBecauseRow(seed, catalog, {
      infoLookup: (id) => {
        if (id === 1) return { castNames: [], directorName: "Jane Doe" }
        if (id === 3) return { castNames: [], directorName: "jane doe" }
        return { castNames: [], directorName: null }
      },
    })
    expect(result.map((entry) => entry.id)).toEqual([3, 2])
  })
})
