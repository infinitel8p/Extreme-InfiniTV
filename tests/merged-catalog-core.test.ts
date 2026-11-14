import { describe, it, expect } from "vitest"
import {
  rowKey,
  parseRowKey,
  stampRowsWithPlaylist,
  concatInPlaylistOrder,
  mergedCategoryKey,
  parseMergedCategoryKey,
  isSpecialCategoryValue,
  categoryLabel,
  buildMergedCategoryRows,
  mergeOrderedFavorites,
  mergeRecents,
  resolveDeepLinkChannel,
  buildMergedChannelGroups,
} from "@/scripts/lib/merged-catalog-core.ts"

const PLAYLIST_A = "3f2b8c1e-aaaa-4bbb-8ccc-123456789abc"

describe("rowKey", () => {
  it("round trips uuid-like playlist ids", () => {
    const key = rowKey({ playlistId: PLAYLIST_A, id: 42 })
    expect(key).toBe(`${PLAYLIST_A}:42`)
    expect(parseRowKey(key)).toEqual({ playlistId: PLAYLIST_A, id: "42" })
  })

  it("rejects malformed keys", () => {
    expect(parseRowKey("nocolon")).toBeNull()
    expect(parseRowKey(":5")).toBeNull()
    expect(parseRowKey("abc:")).toBeNull()
  })
})

describe("stampRowsWithPlaylist", () => {
  it("returns new objects and leaves input untouched", () => {
    const rows = [{ id: 1 }, { id: 2 }]
    const stamped = stampRowsWithPlaylist(rows, "pl")
    expect(stamped).toEqual([
      { id: 1, playlistId: "pl" },
      { id: 2, playlistId: "pl" },
    ])
    expect(rows[0]).toEqual({ id: 1 })
    expect(stamped[0]).not.toBe(rows[0])
  })

  it("memoizes per input array and playlist", () => {
    const rows = [{ id: 1 }]
    expect(stampRowsWithPlaylist(rows, "a")).toBe(stampRowsWithPlaylist(rows, "a"))
    expect(stampRowsWithPlaylist(rows, "a")).not.toBe(stampRowsWithPlaylist(rows, "b"))
    expect(stampRowsWithPlaylist([{ id: 1 }], "a")).not.toBe(stampRowsWithPlaylist(rows, "a"))
  })
})

describe("concatInPlaylistOrder", () => {
  it("keeps playlist order then row order", () => {
    expect(
      concatInPlaylistOrder([
        { playlistId: "a", rows: [1, 2] },
        { playlistId: "b", rows: [3] },
      ]),
    ).toEqual([1, 2, 3])
  })
})

describe("merged category keys", () => {
  it.each(["News", "Sports · Live", "A:B", "Películas · 日本"])("round trips %s", (name) => {
    const key = mergedCategoryKey(PLAYLIST_A, name)
    expect(parseMergedCategoryKey(key, "fallback")).toEqual({ playlistId: PLAYLIST_A, name })
  })

  it("parses a legacy bare name against the fallback playlist", () => {
    expect(parseMergedCategoryKey("News", "fb")).toEqual({ playlistId: "fb", name: "News" })
  })

  it("returns null for special values", () => {
    expect(parseMergedCategoryKey("", "fb")).toBeNull()
    expect(parseMergedCategoryKey("__favorites__", "fb")).toBeNull()
    expect(parseMergedCategoryKey("__genre__:drama", "fb")).toBeNull()
    expect(isSpecialCategoryValue("__recents__")).toBe(true)
    expect(isSpecialCategoryValue("Movies")).toBe(false)
  })
})

describe("categoryLabel", () => {
  it("is plain when not merged", () => {
    expect(categoryLabel("News", "Home", false)).toBe("News")
  })

  it("appends the playlist title when merged", () => {
    expect(categoryLabel("News", "Home", true)).toBe("News · Home")
  })

  it("stays plain when the title is empty", () => {
    expect(categoryLabel("News", "", true)).toBe("News")
  })
})

describe("buildMergedCategoryRows", () => {
  const sources = [
    { playlistId: "a", title: "Alpha" },
    { playlistId: "b", title: "Beta" },
  ]

  it("keeps same-named categories separate per playlist", () => {
    const rows = buildMergedCategoryRows(
      sources,
      new Map([
        ["a", [{ category: "News" }, { category: "News" }, { category: "Sports" }]],
        ["b", [{ category: "News" }]],
      ]),
      "Uncategorized",
      true,
    )
    expect(rows.map((row) => [row.playlistId, row.name, row.count, row.label])).toEqual([
      ["a", "News", 2, "News · Alpha"],
      ["a", "Sports", 1, "Sports · Alpha"],
      ["b", "News", 1, "News · Beta"],
    ])
    expect(rows[0].key).toBe(mergedCategoryKey("a", "News"))
  })

  it("counts multi-category items once per category", () => {
    const rows = buildMergedCategoryRows(
      [sources[0]],
      new Map([["a", [{ categories: ["Drama", "Drama", "Crime"] }]]]),
      "Uncategorized",
      false,
    )
    expect(rows.map((row) => [row.name, row.count, row.label])).toEqual([
      ["Drama", 1, "Drama"],
      ["Crime", 1, "Crime"],
    ])
  })

  it("applies the fallback name to empty categories", () => {
    const rows = buildMergedCategoryRows(
      [sources[0]],
      new Map([["a", [{ category: null }, { category: "" }, {}]]]),
      "Uncategorized",
      false,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Uncategorized", count: 3 })
  })
})

describe("mergeOrderedFavorites", () => {
  it("orders by playlist then favorites order and skips missing rows", () => {
    const rowsByKey = new Map([
      ["a:1", { playlistId: "a", id: 1 }],
      ["a:2", { playlistId: "a", id: 2 }],
      ["b:1", { playlistId: "b", id: 1 }],
    ])
    const favorites: Record<string, number[]> = { a: [2, 99, 1], b: [1] }
    const out = mergeOrderedFavorites(["a", "b"], (playlistId) => favorites[playlistId], rowsByKey)
    expect(out.map(rowKey)).toEqual(["a:2", "a:1", "b:1"])
  })
})

describe("mergeRecents", () => {
  it("sorts by ts desc, ties by playlist order, missing ts last", () => {
    const rowsByKey = new Map([
      ["a:1", { playlistId: "a", id: 1 }],
      ["a:2", { playlistId: "a", id: 2 }],
      ["b:1", { playlistId: "b", id: 1 }],
      ["b:2", { playlistId: "b", id: 2 }],
    ])
    const recents: Record<string, Array<{ id: number; ts?: number }>> = {
      a: [{ id: 1, ts: 50 }, { id: 2 }],
      b: [{ id: 1, ts: 50 }, { id: 2, ts: 70 }],
    }
    const out = mergeRecents(["a", "b"], (playlistId) => recents[playlistId], rowsByKey)
    expect(out.map(rowKey)).toEqual(["b:2", "a:1", "b:1", "a:2"])
  })
})

describe("resolveDeepLinkChannel", () => {
  const rows = [
    { playlistId: "a", id: 5, name: "A5" },
    { playlistId: "b", id: 5, name: "B5" },
    { playlistId: "b", id: 6, name: "B6" },
  ]

  it("matches the exact playlist when given", () => {
    expect(resolveDeepLinkChannel(rows, 5, "b", "a")?.name).toBe("B5")
    expect(resolveDeepLinkChannel(rows, 6, "a", "a")).toBeNull()
  })

  it("prefers the active playlist without pl", () => {
    expect(resolveDeepLinkChannel(rows, 5, null, "b")?.name).toBe("B5")
    expect(resolveDeepLinkChannel(rows, "5", undefined, "a")?.name).toBe("A5")
  })

  it("falls back to the first row with that id", () => {
    expect(resolveDeepLinkChannel(rows, 6, null, "a")?.name).toBe("B6")
    expect(resolveDeepLinkChannel(rows, 404, null, "a")).toBeNull()
  })
})

describe("buildMergedChannelGroups", () => {
  const opts = { favoritesKey: "__favorites__", allKey: "__all__" }
  const groupsA = [
    { key: "__favorites__", label: "Favorites", channels: ["a1"] },
    { key: "__all__", label: "All", channels: ["a1", "a2"] },
    { key: "News", label: "News", channels: ["a1"] },
  ]
  const groupsB = [
    { key: "__favorites__", label: "Favorites", channels: [] },
    { key: "__all__", label: "All", channels: ["b1"] },
    { key: "News", label: "News", channels: ["b1"] },
  ]

  it("passes a single playlist through unchanged", () => {
    expect(buildMergedChannelGroups([{ playlistId: "a", title: "Alpha", groups: groupsA }], opts)).toBe(groupsA)
  })

  it("merges favorites and all and prefixes other groups", () => {
    const out = buildMergedChannelGroups(
      [
        { playlistId: "a", title: "Alpha", groups: groupsA },
        { playlistId: "b", title: "Beta", groups: groupsB },
      ],
      opts,
    )
    expect(out.map((group) => [group.key, group.label])).toEqual([
      ["__favorites__", "Favorites"],
      ["__all__", "All"],
      [mergedCategoryKey("a", "News"), "News · Alpha"],
      [mergedCategoryKey("b", "News"), "News · Beta"],
    ])
    expect(out[0].channels).toEqual(["a1"])
    expect(out[1].channels).toEqual(["a1", "a2", "b1"])
  })

  it("drops an empty favorites group but keeps all", () => {
    const out = buildMergedChannelGroups(
      [
        { playlistId: "a", title: "Alpha", groups: [groupsA[1]] },
        { playlistId: "b", title: "Beta", groups: groupsB },
      ],
      opts,
    )
    expect(out.map((group) => group.key)).toEqual(["__all__", mergedCategoryKey("b", "News")])
  })
})
