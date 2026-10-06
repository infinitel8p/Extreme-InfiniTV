import { describe, expect, it } from "vitest"
import {
  channelCategoryNames,
  channelMatchesCategory,
  channelPassesCategoryFilter,
  liveContextIdsForPlaylist,
  nativeChannelId,
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
