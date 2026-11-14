import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  prefs: new Map<string, { mode: "hide" | "select"; hidden: Set<string>; allowed: Set<string> }>(),
  reads: 0,
}))

vi.mock("../src/scripts/lib/preferences.js", () => {
  const read = (playlistId: string) => {
    state.reads++
    return state.prefs.get(playlistId) ?? { mode: "hide", hidden: new Set(), allowed: new Set() }
  }
  return {
    getCategoryMode: (playlistId: string) => read(playlistId).mode,
    getHiddenCategories: (playlistId: string) => read(playlistId).hidden,
    getAllowedCategories: (playlistId: string) => read(playlistId).allowed,
  }
})

import {
  categoryPassesPrefs,
  categoryVisibleFor,
  filterRowsByCategoryPrefs,
} from "../src/scripts/lib/category-visibility.ts"

beforeEach(() => {
  state.prefs.clear()
  state.reads = 0
})

describe("categoryPassesPrefs", () => {
  it("hides names in the hidden set in hide mode", () => {
    const prefs = { mode: "hide" as const, hidden: new Set(["Adult"]), allowed: new Set<string>() }
    expect(categoryPassesPrefs(prefs, "Adult")).toBe(false)
    expect(categoryPassesPrefs(prefs, "Drama")).toBe(true)
  })

  it("passes everything in select mode with an empty allowed set", () => {
    const prefs = { mode: "select" as const, hidden: new Set(["Adult"]), allowed: new Set<string>() }
    expect(categoryPassesPrefs(prefs, "Adult")).toBe(true)
  })

  it("passes only allowed names in select mode", () => {
    const prefs = { mode: "select" as const, hidden: new Set<string>(), allowed: new Set(["Drama"]) }
    expect(categoryPassesPrefs(prefs, "Drama")).toBe(true)
    expect(categoryPassesPrefs(prefs, "Action")).toBe(false)
  })
})

describe("filterRowsByCategoryPrefs", () => {
  it("falls back to the given name for empty categories", () => {
    state.prefs.set("A", { mode: "hide", hidden: new Set(["Uncategorized"]), allowed: new Set() })
    const rows = [
      { id: 1, playlistId: "A", category: "" },
      { id: 2, playlistId: "A", category: "Drama" },
    ]
    const kept = filterRowsByCategoryPrefs(rows, "vod", { fallbackCategoryName: "Uncategorized" })
    expect(kept.map((row) => row.id)).toEqual([2])
  })

  it("reads prefs once per playlist and applies each playlist's own sets", () => {
    state.prefs.set("A", { mode: "hide", hidden: new Set(["Action"]), allowed: new Set() })
    state.prefs.set("B", { mode: "select", hidden: new Set(), allowed: new Set(["Action"]) })
    const rows = [
      { id: 1, playlistId: "A", category: "Action" },
      { id: 2, playlistId: "A", category: "Drama" },
      { id: 3, playlistId: "B", category: "Action" },
      { id: 4, playlistId: "B", category: "Drama" },
    ]
    const kept = filterRowsByCategoryPrefs(rows, "series", { fallbackCategoryName: "Uncategorized" })
    expect(kept.map((row) => row.id)).toEqual([2, 3])
    expect(state.reads).toBe(6)
  })

  it("uses playlistIdOf when rows carry no playlistId", () => {
    state.prefs.set("A", { mode: "hide", hidden: new Set(["Action"]), allowed: new Set() })
    const rows = [{ id: 1, category: "Action" }, { id: 2, category: "Drama" }]
    const kept = filterRowsByCategoryPrefs(rows, "live", {
      playlistIdOf: () => "A",
      fallbackCategoryName: "Uncategorized",
    })
    expect(kept.map((row) => row.id)).toEqual([2])
  })
})

describe("categoryVisibleFor", () => {
  it("reads the stored prefs for the playlist", () => {
    state.prefs.set("A", { mode: "hide", hidden: new Set(["Action"]), allowed: new Set() })
    expect(categoryVisibleFor("A", "vod", "Action")).toBe(false)
    expect(categoryVisibleFor("B", "vod", "Action")).toBe(true)
  })
})
