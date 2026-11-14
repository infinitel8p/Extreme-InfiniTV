import { mergedCategoryKey, mergeRecents, parseMergedCategoryKey, rowKey } from "@/scripts/lib/merged-catalog-core.ts"

export const GRID_CAT_FAVORITES = "__favorites__"
export const GRID_CAT_RECENTS = "__recents__"
export const GRID_CAT_GENRE_PREFIX = "__genre__:"

export interface GridFilterRow {
  id: number | string
  playlistId?: string
  category?: string | null
}

export interface GridFilterContext {
  favoritesFor(playlistId: string): Set<number>
  recentsFor(playlistId: string): Array<{ id: number | string; ts?: number }>
  genreSetFor(playlistId: string, genreId: string): Set<number> | null | undefined
  categoryPassesFilter(value: string): boolean
  fallbackPlaylistId: string
  fallbackCategoryName?: string
}

export function selectRowsForCategory<T extends GridFilterRow>(
  rows: T[],
  activeCat: string,
  ctx: GridFilterContext,
): T[] {
  const playlistOf = (row: T): string => row.playlistId ?? ctx.fallbackPlaylistId
  const fallbackName = ctx.fallbackCategoryName ?? ""

  if (activeCat === GRID_CAT_FAVORITES) {
    const favoritesByPlaylist = new Map<string, Set<number>>()
    return rows.filter((row) => {
      const playlistId = playlistOf(row)
      let favorites = favoritesByPlaylist.get(playlistId)
      if (!favorites) {
        favorites = ctx.favoritesFor(playlistId)
        favoritesByPlaylist.set(playlistId, favorites)
      }
      return favorites.has(Number(row.id))
    })
  }

  if (activeCat === GRID_CAT_RECENTS) {
    const rowsByKey = new Map<string, T>()
    const playlistOrder: string[] = []
    for (const row of rows) {
      const playlistId = playlistOf(row)
      if (!playlistOrder.includes(playlistId)) playlistOrder.push(playlistId)
      rowsByKey.set(rowKey({ playlistId, id: row.id }), row)
    }
    return mergeRecents(playlistOrder, ctx.recentsFor, rowsByKey)
  }

  if (activeCat.startsWith(GRID_CAT_GENRE_PREFIX)) {
    const genreId = activeCat.slice(GRID_CAT_GENRE_PREFIX.length)
    const setsByPlaylist = new Map<string, Set<number> | null | undefined>()
    return rows.filter((row) => {
      const playlistId = playlistOf(row)
      if (!setsByPlaylist.has(playlistId)) {
        setsByPlaylist.set(playlistId, ctx.genreSetFor(playlistId, genreId))
      }
      return setsByPlaylist.get(playlistId)?.has(Number(row.id)) ?? false
    })
  }

  const selected = activeCat ? parseMergedCategoryKey(activeCat, ctx.fallbackPlaylistId) : null
  return rows.filter((row) => {
    const playlistId = playlistOf(row)
    const name = row.category || fallbackName
    if (selected && (playlistId !== selected.playlistId || name !== selected.name)) return false
    return ctx.categoryPassesFilter(mergedCategoryKey(playlistId, name))
  })
}

export function interleaveByPlaylist<T>(groups: T[][], limit: number): T[] {
  const out: T[] = []
  for (let depth = 0; out.length < limit; depth++) {
    let tookAny = false
    for (const group of groups) {
      if (depth < group.length && out.length < limit) {
        out.push(group[depth])
        tookAny = true
      }
    }
    if (!tookAny) break
  }
  return out
}
