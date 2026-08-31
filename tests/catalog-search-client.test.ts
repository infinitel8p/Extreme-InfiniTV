import { describe, it, expect } from "vitest"
import { searchCatalog } from "@/scripts/tv/catalog-filter-client"

interface Entry {
  id: number
  norm: string
}

function makeEntries(): Entry[] {
  return [
    { id: 1, norm: "alpha news" },
    { id: 2, norm: "beta alpha sports" },
    { id: 3, norm: "gamma weather" },
    { id: 4, norm: "delta" },
  ]
}

describe("searchCatalog", () => {
  it("ranks matches by score and drops non-matches", async () => {
    const indexes = await searchCatalog("test:rank", makeEntries(), "alpha", 30)
    expect(indexes && Array.from(indexes)).toEqual([0, 1])
  })

  it("requires every token to match", async () => {
    const indexes = await searchCatalog("test:tokens", makeEntries(), "beta sports", 30)
    expect(indexes && Array.from(indexes)).toEqual([1])
  })

  it("caps the result count", async () => {
    const entries = [
      { id: 1, norm: "alpha one" },
      { id: 2, norm: "alpha two" },
      { id: 3, norm: "alpha three" },
    ]
    const indexes = await searchCatalog("test:cap", entries, "alpha", 2)
    expect(indexes?.length).toBe(2)
  })

  it("returns an empty result when nothing matches", async () => {
    const indexes = await searchCatalog("test:empty", makeEntries(), "zzz", 30)
    expect(indexes && Array.from(indexes)).toEqual([])
  })

  it("treats entries with no norm as unmatchable", async () => {
    const entries = [{ id: 1 }, { id: 2, norm: "alpha" }]
    const indexes = await searchCatalog("test:missing-norm", entries, "alpha", 30)
    expect(indexes && Array.from(indexes)).toEqual([1])
  })
})
