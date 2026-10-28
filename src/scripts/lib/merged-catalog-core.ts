export type CatalogKind = "live" | "vod" | "series"

export interface MergedPlaylistSource {
  playlistId: string
  title: string
}

export interface MergedRowIdentity {
  playlistId: string
  id: number | string
}

export function rowKey(row: MergedRowIdentity): string {
  return `${row.playlistId}:${row.id}`
}

export function parseRowKey(key: string): { playlistId: string; id: string } | null {
  const split = key.lastIndexOf(":")
  if (split <= 0 || split === key.length - 1) return null
  return { playlistId: key.slice(0, split), id: key.slice(split + 1) }
}

const stampMemo = new WeakMap<object, Map<string, unknown[]>>()

export function stampRowsWithPlaylist<T extends object>(
  rows: T[],
  playlistId: string,
): Array<T & { playlistId: string }> {
  let byPlaylist = stampMemo.get(rows)
  if (!byPlaylist) {
    byPlaylist = new Map()
    stampMemo.set(rows, byPlaylist)
  }
  const memoized = byPlaylist.get(playlistId)
  if (memoized) return memoized as Array<T & { playlistId: string }>
  const stamped = rows.map((row) => ({ ...row, playlistId }))
  byPlaylist.set(playlistId, stamped)
  return stamped
}

export function concatInPlaylistOrder<T>(byPlaylist: Array<{ playlistId: string; rows: T[] }>): T[] {
  const out: T[] = []
  for (const entry of byPlaylist) {
    for (const row of entry.rows) out.push(row)
  }
  return out
}

export const MERGED_CATEGORY_SEPARATOR = "\u0000"

export function mergedCategoryKey(playlistId: string, name: string): string {
  return `${playlistId}${MERGED_CATEGORY_SEPARATOR}${name}`
}

export function isSpecialCategoryValue(value: string): boolean {
  return value === "" || value.startsWith("__")
}

export function parseMergedCategoryKey(
  key: string,
  fallbackPlaylistId: string,
): { playlistId: string; name: string } | null {
  if (isSpecialCategoryValue(key)) return null
  const split = key.indexOf(MERGED_CATEGORY_SEPARATOR)
  if (split < 0) return { playlistId: fallbackPlaylistId, name: key }
  return { playlistId: key.slice(0, split), name: key.slice(split + 1) }
}

export function categoryLabel(name: string, playlistTitle: string, isMerged: boolean): string {
  return isMerged && playlistTitle ? `${name} · ${playlistTitle}` : name
}

export interface MergedCategoryRow {
  key: string
  playlistId: string
  name: string
  label: string
  count: number
}

export function buildMergedCategoryRows(
  sources: MergedPlaylistSource[],
  rowsByPlaylist: Map<string, Array<{ category?: string | null; categories?: string[] | null }>>,
  fallbackName: string,
  isMerged: boolean,
): MergedCategoryRow[] {
  const out: MergedCategoryRow[] = []
  for (const source of sources) {
    const counts = new Map<string, MergedCategoryRow>()
    for (const row of rowsByPlaylist.get(source.playlistId) || []) {
      const names = row.categories?.length ? row.categories : [row.category]
      const seen = new Set<string>()
      for (const rawName of names) {
        const name = rawName || fallbackName
        if (seen.has(name)) continue
        seen.add(name)
        const existing = counts.get(name)
        if (existing) {
          existing.count++
        } else {
          counts.set(name, {
            key: mergedCategoryKey(source.playlistId, name),
            playlistId: source.playlistId,
            name,
            label: categoryLabel(name, source.title, isMerged),
            count: 1,
          })
        }
      }
    }
    out.push(...counts.values())
  }
  return out
}

export function mergeOrderedFavorites<T extends MergedRowIdentity>(
  playlistIds: string[],
  getOrderedIds: (playlistId: string) => Array<number | string>,
  rowsByKey: Map<string, T>,
): T[] {
  const out: T[] = []
  for (const playlistId of playlistIds) {
    for (const id of getOrderedIds(playlistId)) {
      const row = rowsByKey.get(rowKey({ playlistId, id }))
      if (row) out.push(row)
    }
  }
  return out
}

export function mergeRecents<T extends MergedRowIdentity>(
  playlistIds: string[],
  getRecents: (playlistId: string) => Array<{ id: number | string; ts?: number }>,
  rowsByKey: Map<string, T>,
): T[] {
  const candidates: Array<{ row: T; ts: number; order: number }> = []
  for (const playlistId of playlistIds) {
    for (const recent of getRecents(playlistId)) {
      const row = rowsByKey.get(rowKey({ playlistId, id: recent.id }))
      if (row) candidates.push({ row, ts: recent.ts || 0, order: candidates.length })
    }
  }
  candidates.sort((first, second) => second.ts - first.ts || first.order - second.order)
  return candidates.map((candidate) => candidate.row)
}

export function resolveDeepLinkChannel<T extends MergedRowIdentity>(
  rows: T[],
  id: number | string,
  playlistId: string | null | undefined,
  activePlaylistId: string,
): T | null {
  const wanted = String(id)
  const matches = rows.filter((row) => String(row.id) === wanted)
  if (playlistId) return matches.find((row) => row.playlistId === playlistId) || null
  return matches.find((row) => row.playlistId === activePlaylistId) || matches[0] || null
}

export interface MergedChannelGroup {
  key: string
  label: string
  channels: unknown[]
}

export function buildMergedChannelGroups(
  perPlaylist: Array<{
    playlistId: string
    title: string
    groups: Array<{ key: string; label: string; channels: unknown[] }>
  }>,
  opts: { favoritesKey: string; allKey: string },
): MergedChannelGroup[] {
  if (perPlaylist.length === 1) return perPlaylist[0].groups
  const favorites: MergedChannelGroup = { key: opts.favoritesKey, label: "", channels: [] }
  const all: MergedChannelGroup = { key: opts.allKey, label: "", channels: [] }
  const rest: MergedChannelGroup[] = []
  let favoritesLabelSet = false
  let allLabelSet = false
  for (const playlist of perPlaylist) {
    for (const group of playlist.groups) {
      if (group.key === opts.favoritesKey) {
        if (!favoritesLabelSet) {
          favorites.label = group.label
          favoritesLabelSet = true
        }
        favorites.channels.push(...group.channels)
      } else if (group.key === opts.allKey) {
        if (!allLabelSet) {
          all.label = group.label
          allLabelSet = true
        }
        all.channels.push(...group.channels)
      } else {
        rest.push({
          key: mergedCategoryKey(playlist.playlistId, group.key),
          label: categoryLabel(group.label, playlist.title, true),
          channels: group.channels,
        })
      }
    }
  }
  const out: MergedChannelGroup[] = []
  if (favorites.channels.length) out.push(favorites)
  out.push(all)
  out.push(...rest)
  return out
}
