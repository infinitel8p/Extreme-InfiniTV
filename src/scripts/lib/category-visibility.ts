import { getAllowedCategories, getCategoryMode, getHiddenCategories } from "./preferences.js"

export type CategoryPrefsKind = "live" | "vod" | "series"

export interface CategoryPrefs {
  mode: "hide" | "select"
  hidden: Set<string> | null | undefined
  allowed: Set<string> | null | undefined
}

export const CATEGORY_PREFS_EVENTS = [
  "xt:hidden-categories-changed",
  "xt:allowed-categories-changed",
  "xt:category-mode-changed",
] as const

export function categoryNameOf(row: { category?: string | null }, fallbackCategoryName: string): string {
  return ((row.category || "") + "").trim() || fallbackCategoryName
}

export function categoryPassesPrefs(prefs: CategoryPrefs, categoryName: string): boolean {
  if (prefs.mode === "select") {
    return !prefs.allowed || prefs.allowed.size === 0 || prefs.allowed.has(categoryName)
  }
  return !prefs.hidden?.has(categoryName)
}

function readPrefs(playlistId: string, kind: CategoryPrefsKind): CategoryPrefs {
  return {
    mode: getCategoryMode(playlistId, kind),
    hidden: getHiddenCategories(playlistId, kind),
    allowed: getAllowedCategories(playlistId, kind),
  }
}

export function categoryVisibleFor(playlistId: string, kind: CategoryPrefsKind, categoryName: string): boolean {
  return categoryPassesPrefs(readPrefs(playlistId, kind), categoryName)
}

export function filterRowsByCategoryPrefs<Row extends { category?: string | null; playlistId?: string }>(
  rows: Row[],
  kind: CategoryPrefsKind,
  options: { playlistIdOf?: (row: Row) => string; fallbackCategoryName: string }
): Row[] {
  const prefsByPlaylist = new Map<string, CategoryPrefs>()
  return rows.filter((row) => {
    const playlistId = options.playlistIdOf ? options.playlistIdOf(row) : (row.playlistId ?? "")
    let prefs = prefsByPlaylist.get(playlistId)
    if (!prefs) {
      prefs = readPrefs(playlistId, kind)
      prefsByPlaylist.set(playlistId, prefs)
    }
    return categoryPassesPrefs(prefs, categoryNameOf(row, options.fallbackCategoryName))
  })
}
