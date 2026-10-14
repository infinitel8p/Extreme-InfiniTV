import { describe, it, expect } from "vitest"
import { selectTopK } from "../src/scripts/lib/top-k"

const byNumberDesc = (a: number, b: number) => b - a

describe("selectTopK", () => {
  it("returns an empty array when k is zero or negative", () => {
    expect(selectTopK([1, 2, 3], 0, byNumberDesc)).toEqual([])
    expect(selectTopK([1, 2, 3], -1, byNumberDesc)).toEqual([])
  })

  it("returns every item, sorted, when the input is smaller than k", () => {
    expect(selectTopK([3, 1, 2], 10, byNumberDesc)).toEqual([3, 2, 1])
  })

  it("keeps only the top k items in sorted order", () => {
    const items = [5, 1, 9, 3, 7, 2, 8, 4, 6, 0]
    expect(selectTopK(items, 3, byNumberDesc)).toEqual([9, 8, 7])
  })

  it("matches a full sort-then-slice for a larger random-ish input", () => {
    const items = [12, 4, 99, 3, 3, 55, 21, 8, 1, 0, 45, 7, 100, -3]
    const expected = items.slice().sort(byNumberDesc).slice(0, 5)
    expect(selectTopK(items, 5, byNumberDesc)).toEqual(expected)
  })

  it("preserves earlier items on ties (stable enough for equal ranks)", () => {
    const items = [
      { id: "a", score: 1 },
      { id: "b", score: 1 },
      { id: "c", score: 1 },
    ]
    const out = selectTopK(items, 2, (a, b) => b.score - a.score)
    expect(out.map((item) => item.id)).toEqual(["a", "b"])
  })

  it("never mutates the input array", () => {
    const items = [3, 1, 2]
    const copy = items.slice()
    selectTopK(items, 2, byNumberDesc)
    expect(items).toEqual(copy)
  })
})
