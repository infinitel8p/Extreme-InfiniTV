import { describe, expect, it } from "vitest"
import {
  channelCategoryNames,
  channelMatchesCategory,
  channelPassesCategoryFilter,
  liveContextIdsForPlaylist,
  nativeChannelId,
  nativeLiveChannelRows,
  resolveNativeChannel,
} from "@/scripts/lib/merged-live.ts"

const rows = [
  { id: 1, playlistId: "a", category: "News" },
  { id: 1, playlistId: "b", category: "News", categories: ["News", "Sport"] },
  { id: 2, playlistId: "b", category: "", isHeader: false },
  { id: 3, playlistId: "b", category: "Hdr", isHeader: true },
]

describe("channelCategoryNames", () => {
  it("prefers the categories list and trims", () => {
    expect(channelCategoryNames({ id: 1, category: "x", categories: [" A ", "B"] })).toEqual(["A", "B"])
  })
  it("maps empty names to the fallback", () => {
    expect(channelCategoryNames({ id: 1, category: "" }, "Uncategorized")).toEqual(["Uncategorized"])
  })
})

describe("channelMatchesCategory", () => {
  it("requires the same playlist and a matching name", () => {
    expect(channelMatchesCategory(rows[0], { playlistId: "a", name: "News" })).toBe(true)
    expect(channelMatchesCategory(rows[0], { playlistId: "b", name: "News" })).toBe(false)
    expect(channelMatchesCategory(rows[1], { playlistId: "b", name: "Sport" })).toBe(true)
  })
  it("matches the fallback label for empty categories", () => {
    expect(channelMatchesCategory(rows[2], { playlistId: "b", name: "Uncategorized" }, "Uncategorized")).toBe(true)
  })
})

describe("channelPassesCategoryFilter", () => {
  it("passes when any category key passes", () => {
    const seen: string[] = []
    const passes = channelPassesCategoryFilter(
      rows[1],
      (key) => {
        seen.push(key)
        return key.endsWith("Sport")
      },
      "",
    )
    expect(passes).toBe(true)
    expect(seen).toHaveLength(2)
  })
  it("fails when every category is filtered out", () => {
    expect(channelPassesCategoryFilter(rows[0], () => false)).toBe(false)
  })
})

describe("liveContextIdsForPlaylist", () => {
  it("scopes to one playlist and drops headers", () => {
    expect(liveContextIdsForPlaylist(rows, "b")).toEqual(["1", "2"])
    expect(liveContextIdsForPlaylist(rows, "a")).toEqual(["1"])
  })
})

describe("nativeLiveChannelRows", () => {
  const keyOf = (row: { id: number | string; playlistId?: string }) => `${row.playlistId}:${row.id}`
  const one = { id: 1, playlistId: "a" }
  const two = { id: 2, playlistId: "a" }
  const three = { id: 3, playlistId: "a" }

  it("keeps filtered order when the initial channel is present", () => {
    expect(nativeLiveChannelRows([three, one, two], one, keyOf)).toEqual([three, one, two])
  })
  it("prepends the initial channel when absent", () => {
    expect(nativeLiveChannelRows([two, three], one, keyOf)).toEqual([one, two, three])
  })
  it("drops header rows", () => {
    const header = { id: 9, playlistId: "a", isHeader: true }
    expect(nativeLiveChannelRows([header, one, two], one, keyOf)).toEqual([one, two])
  })
  it("returns only the initial channel for an empty list", () => {
    expect(nativeLiveChannelRows([], one, keyOf)).toEqual([one])
  })
  it("does not duplicate the initial channel", () => {
    expect(nativeLiveChannelRows([one, two], one, keyOf)).toHaveLength(2)
  })
  it("keeps same-id rows from different playlists distinct", () => {
    const otherOne = { id: 1, playlistId: "b" }
    expect(nativeLiveChannelRows([otherOne, two], one, keyOf)).toEqual([one, otherOne, two])
  })
})

describe("native channel ids", () => {
  it("uses the row key only when merged", () => {
    expect(nativeChannelId({ id: 4, playlistId: "a" }, false)).toBe("4")
    expect(nativeChannelId({ id: 4, playlistId: "a" }, true)).toBe("a:4")
  })
  it("resolves keys and bare ids", () => {
    const list = [
      { id: 1, playlistId: "a" },
      { id: 1, playlistId: "b" },
    ]
    expect(resolveNativeChannel(list, "b:1")).toBe(list[1])
    expect(resolveNativeChannel(list, "1")).toBe(list[0])
    expect(resolveNativeChannel(list, "9")).toBeNull()
  })
})
