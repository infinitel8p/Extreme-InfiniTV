import { describe, it, expect } from "vitest"
import {
  pickLocalSimilar,
  parseProviderPeople,
  type LocalSimilarCandidate,
} from "../src/scripts/lib/similar-local"

describe("pickLocalSimilar", () => {
  const current = { id: 1, category: "Action", castNames: [], directorName: null }

  it("matches candidates sharing the same category", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "B", category: "Action" },
      { id: 3, name: "C", category: "Comedy" },
    ]
    const result = pickLocalSimilar(current, candidates)
    expect(result.map((entry) => entry.id)).toEqual([2])
  })

  it("excludes an empty-category title with no cast/director overlap", () => {
    const candidates: LocalSimilarCandidate[] = [{ id: 2, name: "B", category: "" }]
    const result = pickLocalSimilar({ ...current, category: "" }, candidates)
    expect(result).toEqual([])
  })

  it("ranks a director match above a category-only match", () => {
    const withDirector = { ...current, directorName: "Jane Doe" }
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "Category only", category: "Action" },
      { id: 3, name: "Director match", category: "Comedy" },
    ]
    const result = pickLocalSimilar(withDirector, candidates, {
      infoLookup: (id) =>
        id === 3 ? { castNames: [], directorName: "jane doe" } : { castNames: [], directorName: null },
    })
    expect(result.map((entry) => entry.id)).toEqual([3, 2])
  })

  it("caps the cast-overlap bonus at three matching names", () => {
    const withCast = { ...current, castNames: ["A", "B", "C", "D"] }
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "Four overlaps", category: "Comedy" },
      { id: 3, name: "Two overlaps", category: "Comedy" },
    ]
    const result = pickLocalSimilar(withCast, candidates, {
      infoLookup: (id) =>
        id === 2
          ? { castNames: ["A", "B", "C", "D"], directorName: null }
          : { castNames: ["A", "B"], directorName: null },
    })
    // 4 overlaps caps at 3 (score 6), 2 overlaps score 4: both rank above the category-less baseline
    expect(result.map((entry) => entry.id)).toEqual([2, 3])
  })

  it("excludes the current title itself", () => {
    const candidates: LocalSimilarCandidate[] = [{ id: 1, name: "Self", category: "Action" }]
    const result = pickLocalSimilar(current, candidates)
    expect(result).toEqual([])
  })

  it("breaks a score tie by rating, highest first", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "Low rated", category: "Action", rating: "5.0" },
      { id: 3, name: "High rated", category: "Action", rating: "8.5" },
    ]
    const result = pickLocalSimilar(current, candidates)
    expect(result.map((entry) => entry.id)).toEqual([3, 2])
  })

  it("breaks a score and rating tie by name ascending", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "Zebra", category: "Action" },
      { id: 3, name: "Apple", category: "Action" },
    ]
    const result = pickLocalSimilar(current, candidates)
    expect(result.map((entry) => entry.id)).toEqual([3, 2])
  })

  it("caps the result at limit", () => {
    const candidates: LocalSimilarCandidate[] = Array.from({ length: 20 }, (_, index) => ({
      id: index + 2,
      name: `Title ${index}`,
      category: "Action",
    }))
    const result = pickLocalSimilar(current, candidates, { limit: 5 })
    expect(result).toHaveLength(5)
  })

  it("no longer excludes a candidate whose language prefix differs from sourcePrefix", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "AL - Same Language", category: "Action" },
      { id: 3, name: "DE - Other Language", category: "Action" },
    ]
    const result = pickLocalSimilar(current, candidates, { sourcePrefix: "AL" })
    expect(result.map((entry) => entry.id).sort()).toEqual([2, 3])
  })

  it("keeps an unprefixed candidate alongside prefixed ones when sourcePrefix is set", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "AL - Same Language", category: "Action" },
      { id: 3, name: "Unprefixed Title", category: "Action" },
      { id: 4, name: "DE - Other Language", category: "Action" },
    ]
    const result = pickLocalSimilar(current, candidates, { sourcePrefix: "AL" })
    expect(result.map((entry) => entry.id).sort()).toEqual([2, 3, 4])
  })

  it("applies no language filtering when sourcePrefix is null", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "AL - Same Language", category: "Action" },
      { id: 3, name: "DE - Other Language", category: "Action" },
    ]
    const result = pickLocalSimilar(current, candidates)
    expect(result.map((entry) => entry.id).sort()).toEqual([2, 3])
  })

  it("dedupes candidates by group key, keeping the sourcePrefix variant", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "EN - Same Title", category: "Action" },
      { id: 3, name: "DE - Same Title", category: "Action" },
    ]
    const result = pickLocalSimilar(current, candidates, {
      sourcePrefix: "DE",
      groupKeyForEntry: () => "group-1",
    })
    expect(result.map((entry) => entry.id)).toEqual([3])
  })

  it("dedupes candidates by group key using preferredTags order when there is no sourcePrefix match", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "DE - Same Title", category: "Action" },
      { id: 3, name: "FR - Same Title", category: "Action" },
    ]
    const result = pickLocalSimilar(current, candidates, {
      preferredTags: ["FR"],
      groupKeyForEntry: () => "group-1",
    })
    expect(result.map((entry) => entry.id)).toEqual([3])
  })

  it("dedupes candidates by group key, falling back to the unprefixed variant", () => {
    const candidates: LocalSimilarCandidate[] = [
      { id: 2, name: "DE - Same Title", category: "Action" },
      { id: 3, name: "Same Title", category: "Action" },
    ]
    const result = pickLocalSimilar(current, candidates, {
      groupKeyForEntry: () => "group-1",
    })
    expect(result.map((entry) => entry.id)).toEqual([3])
  })
})

describe("parseProviderPeople", () => {
  it("splits, trims, and drops empty cast entries", () => {
    const result = parseProviderPeople({ cast: " A, B ,,C " })
    expect(result.castNames).toEqual(["A", "B", "C"])
  })

  it("falls back to actors when cast is missing", () => {
    const result = parseProviderPeople({ actors: "X, Y" })
    expect(result.castNames).toEqual(["X", "Y"])
  })

  it("takes only the first director when comma-separated", () => {
    const result = parseProviderPeople({ director: "Jane Doe, John Smith" })
    expect(result.directorName).toBe("Jane Doe")
  })

  it("returns empty defaults for missing fields", () => {
    expect(parseProviderPeople({})).toEqual({ castNames: [], directorName: null })
    expect(parseProviderPeople(null)).toEqual({ castNames: [], directorName: null })
  })
})
