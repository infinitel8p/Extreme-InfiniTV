import { describe, it, expect } from "vitest"
import {
  sortChannelsForView,
  sortCategoryNames,
} from "../src/scripts/lib/channel-sort"

const channels = [
  { id: 1, name: "Zeta News", category: "News", chno: 3 },
  { id: 2, name: "Alpha Sports", category: "Sports", chno: 1 },
  { id: 3, name: "Mid Movies", category: "Movies" },
  { id: 4, name: "beta News", category: "News", chno: 2 },
]

describe("sortChannelsForView", () => {
  it("keeps source order in default mode", () => {
    const out = sortChannelsForView(channels, "default")
    expect(out.map((channel) => channel.id)).toEqual([1, 2, 3, 4])
  })

  it("sorts by relevance score in default mode when searching", () => {
    const scoreById = new Map([
      [1, 5],
      [2, 9],
      [4, 7],
    ])
    const out = sortChannelsForView(channels, "default", scoreById)
    expect(out.map((channel) => channel.id)).toEqual([2, 4, 1, 3])
  })

  it("sorts by channel number, unnumbered channels last in source order", () => {
    const unnumberedFirst = [
      { id: 10, name: "No number A" },
      ...channels,
      { id: 11, name: "No number B" },
    ]
    const out = sortChannelsForView(unnumberedFirst, "number")
    expect(out.map((channel) => channel.id)).toEqual([2, 4, 1, 10, 3, 11])
  })

  it("sorts A-Z case-insensitively", () => {
    const out = sortChannelsForView(channels, "az")
    expect(out.map((channel) => channel.name)).toEqual([
      "Alpha Sports",
      "beta News",
      "Mid Movies",
      "Zeta News",
    ])
  })

  it("ignores leading punctuation when sorting by name", () => {
    const noisy = [
      { id: 20, name: "- NO EVENT STREAMING - | DE: PPV" },
      { id: 21, name: "Alpha Sports" },
      { id: 22, name: "| US | Zulu TV" },
    ]
    const out = sortChannelsForView(noisy, "az")
    expect(out.map((channel) => channel.id)).toEqual([21, 20, 22])
  })

  it("sorts Z-A as the reverse of A-Z", () => {
    const out = sortChannelsForView(channels, "za")
    expect(out.map((channel) => channel.name)).toEqual([
      "Zeta News",
      "Mid Movies",
      "beta News",
      "Alpha Sports",
    ])
  })

  it("groups by category then name in cataz mode", () => {
    const out = sortChannelsForView(channels, "cataz")
    expect(out.map((channel) => channel.id)).toEqual([3, 4, 1, 2])
  })

  it("falls back to source order for unknown modes", () => {
    const out = sortChannelsForView(channels, "bogus")
    expect(out.map((channel) => channel.id)).toEqual([1, 2, 3, 4])
  })

  it("never mutates the input list", () => {
    const copy = channels.slice()
    sortChannelsForView(channels, "az")
    sortChannelsForView(channels, "number")
    expect(channels).toEqual(copy)
  })
})

describe("sortCategoryNames", () => {
  const categoryNames = ["Zeta", "alpha", "Mid", "Beta"]

  it("keeps source order in default mode", () => {
    const out = sortCategoryNames(categoryNames, "default")
    expect(out).toEqual(["Zeta", "alpha", "Mid", "Beta"])
  })

  it("sorts A-Z case-insensitively", () => {
    const out = sortCategoryNames(categoryNames, "az")
    expect(out).toEqual(["alpha", "Beta", "Mid", "Zeta"])
  })

  it("sorts Z-A as the reverse of A-Z", () => {
    const out = sortCategoryNames(categoryNames, "za")
    expect(out).toEqual(["Zeta", "Mid", "Beta", "alpha"])
  })

  it("never mutates the input list", () => {
    const copy = categoryNames.slice()
    sortCategoryNames(categoryNames, "default")
    sortCategoryNames(categoryNames, "az")
    sortCategoryNames(categoryNames, "za")
    expect(categoryNames).toEqual(copy)
  })
})
