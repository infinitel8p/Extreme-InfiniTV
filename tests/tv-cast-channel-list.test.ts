import { describe, it, expect } from "vitest"

import {
  buildCastChannelGroups,
  searchCastChannels,
  channelCategories,
  GROUP_ALL,
  GROUP_FAVORITES,
  type CastChannel,
} from "@/scripts/lib/tv-cast-channel-list"
import { resolveTunedLiveContext } from "@/scripts/lib/tv-cast-live"

const LABELS = {
  uncategorizedLabel: "Uncategorized",
  favoritesLabel: "Favorites",
  allLabel: "All channels",
}

function channel(id: number, name: string, extra: Partial<CastChannel> = {}): CastChannel {
  return { id, name, ...extra }
}

const CATALOG: CastChannel[] = [
  channel(1, "Sky Sport 1", { category: "Sports", chno: 101 }),
  channel(2, "ARD", { category: "News", chno: 1 }),
  channel(3, "Movie Central", { category: "Movies", chno: 55 }),
  channel(4, "Local Access", { category: null }),
  channel(5, "DAZN 1", { categories: ["Sports", "Premium"], chno: 102 }),
]

describe("channelCategories", () => {
  it("falls back to the uncategorized label for an empty category", () => {
    expect(channelCategories(channel(9, "X", { category: null }), "Uncategorized")).toEqual(["Uncategorized"])
    expect(channelCategories(channel(9, "X", { category: "  " }), "Uncategorized")).toEqual(["Uncategorized"])
  })

  it("prefers the multi-group list over the single category and dedupes it", () => {
    const categories = channelCategories(
      channel(9, "X", { category: "Sports", categories: ["Sports", "Premium", "Sports"] }),
      "Uncategorized"
    )
    expect(categories).toEqual(["Sports", "Premium"])
  })
})

describe("buildCastChannelGroups", () => {
  it("puts favorites first, then all channels, then categories", () => {
    const groups = buildCastChannelGroups(CATALOG, { ...LABELS, favorites: new Set([2]) })
    expect(groups.map((group) => group.key)).toEqual([
      GROUP_FAVORITES,
      GROUP_ALL,
      "Sports",
      "News",
      "Movies",
      "Uncategorized",
      "Premium",
    ])
    expect(groups[0].channels.map((entry) => entry.id)).toEqual([2])
    expect(groups[1].channels).toHaveLength(5)
  })

  it("omits the favorites group when nothing in the catalog is favorited", () => {
    const groups = buildCastChannelGroups(CATALOG, { ...LABELS, favorites: new Set([999]) })
    expect(groups.map((group) => group.key)).not.toContain(GROUP_FAVORITES)
  })

  it("lists a multi-group channel under each of its groups", () => {
    const groups = buildCastChannelGroups(CATALOG, LABELS)
    const sports = groups.find((group) => group.key === "Sports")!
    const premium = groups.find((group) => group.key === "Premium")!
    expect(sports.channels.map((entry) => entry.id)).toContain(5)
    expect(premium.channels.map((entry) => entry.id)).toEqual([5])
  })

  it("drops hidden categories, including from All channels", () => {
    const groups = buildCastChannelGroups(CATALOG, { ...LABELS, hiddenCategories: new Set(["Sports"]) })
    expect(groups.map((group) => group.key)).not.toContain("Sports")
    const all = groups.find((group) => group.key === GROUP_ALL)!
    expect(all.channels.map((entry) => entry.id)).toEqual([2, 3, 4, 5])
  })

  it("keeps a multi-group channel visible when only one of its groups is hidden", () => {
    const groups = buildCastChannelGroups(CATALOG, { ...LABELS, hiddenCategories: new Set(["Premium"]) })
    const sports = groups.find((group) => group.key === "Sports")!
    expect(sports.channels.map((entry) => entry.id)).toEqual([1, 5])
  })

  it("shows only allowed categories in select mode", () => {
    const groups = buildCastChannelGroups(CATALOG, {
      ...LABELS,
      categoryMode: "select",
      allowedCategories: new Set(["News"]),
    })
    expect(groups.map((group) => group.key)).toEqual([GROUP_ALL, "News"])
  })

  it("treats an empty allow list in select mode as no filter", () => {
    const groups = buildCastChannelGroups(CATALOG, {
      ...LABELS,
      categoryMode: "select",
      allowedCategories: new Set(),
    })
    expect(groups.find((group) => group.key === GROUP_ALL)!.channels).toHaveLength(5)
  })

  it("applies the category sort mode to the group order", () => {
    const groups = buildCastChannelGroups(CATALOG, { ...LABELS, categorySort: "az" })
    expect(groups.map((group) => group.key)).toEqual([
      GROUP_ALL,
      "Movies",
      "News",
      "Premium",
      "Sports",
      "Uncategorized",
    ])
  })

  it("applies each channel sort mode inside a group", () => {
    const byNumber = buildCastChannelGroups(CATALOG, { ...LABELS, channelSort: "number" })
    expect(byNumber.find((group) => group.key === GROUP_ALL)!.channels.map((entry) => entry.id)).toEqual([
      2, 3, 1, 5, 4,
    ])

    const alphabetical = buildCastChannelGroups(CATALOG, { ...LABELS, channelSort: "az" })
    expect(alphabetical.find((group) => group.key === GROUP_ALL)!.channels.map((entry) => entry.name)).toEqual([
      "ARD",
      "DAZN 1",
      "Local Access",
      "Movie Central",
      "Sky Sport 1",
    ])

    const reversed = buildCastChannelGroups(CATALOG, { ...LABELS, channelSort: "za" })
    expect(reversed.find((group) => group.key === GROUP_ALL)!.channels[0].name).toBe("Sky Sport 1")

    const sourceOrder = buildCastChannelGroups(CATALOG, { ...LABELS, channelSort: "default" })
    expect(sourceOrder.find((group) => group.key === GROUP_ALL)!.channels.map((entry) => entry.id)).toEqual([
      1, 2, 3, 4, 5,
    ])
  })

  it("returns no groups for an empty catalog", () => {
    expect(buildCastChannelGroups([], LABELS)).toEqual([])
  })
})

describe("searchCastChannels", () => {
  it("returns nothing for an empty query", () => {
    expect(searchCastChannels(CATALOG, "   ")).toEqual([])
  })

  it("matches on name regardless of case and diacritics", () => {
    expect(searchCastChannels(CATALOG, "sky").map((entry) => entry.id)).toEqual([1])
  })

  it("requires every token to match", () => {
    expect(searchCastChannels(CATALOG, "sky cinema")).toEqual([])
  })

  it("ranks a leading match above a mid-string one", () => {
    const catalog = [channel(1, "Euro Sport"), channel(2, "Sport 24")]
    expect(searchCastChannels(catalog, "sport").map((entry) => entry.id)).toEqual([2, 1])
  })

  it("ranks an exact channel-number hit above any name match", () => {
    const catalog = [channel(1, "Channel 55"), channel(3, "Movie Central", { chno: 55 })]
    expect(searchCastChannels(catalog, "55").map((entry) => entry.id)).toEqual([3, 1])
  })
})

describe("resolveTunedLiveContext", () => {
  const existing = { playlistId: "p1", channelIds: ["1", "2", "3"], index: 0 }

  it("keeps the session list and moves the index when the channel is already in it", () => {
    expect(resolveTunedLiveContext(existing, "p1", "3", ["3", "9"])).toEqual({
      playlistId: "p1",
      channelIds: ["1", "2", "3"],
      index: 2,
    })
  })

  it("rebuilds from the browsed group when the channel is outside the session list", () => {
    expect(resolveTunedLiveContext(existing, "p1", "9", ["8", "9", "10"])).toEqual({
      playlistId: "p1",
      channelIds: ["8", "9", "10"],
      index: 1,
    })
  })

  it("creates a context from the browsed group when the session has none", () => {
    expect(resolveTunedLiveContext(undefined, "p1", "9", ["8", "9"])).toEqual({
      playlistId: "p1",
      channelIds: ["8", "9"],
      index: 1,
    })
  })

  it("rebuilds when the session context belongs to another playlist", () => {
    expect(resolveTunedLiveContext(existing, "p2", "2", ["2", "4"])).toEqual({
      playlistId: "p2",
      channelIds: ["2", "4"],
      index: 0,
    })
  })

  it("windows a very long group around the tuned channel", () => {
    const ids = Array.from({ length: 900 }, (_, index) => String(index))
    const context = resolveTunedLiveContext(undefined, "p1", "800", ids)!
    expect(context.channelIds).toHaveLength(500)
    expect(context.channelIds[context.index]).toBe("800")
  })
})
