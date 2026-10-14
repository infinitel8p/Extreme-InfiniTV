import { mergedCategoryKey, rowKey } from "@/scripts/lib/merged-catalog-core.ts"

export interface LiveRowLike {
  id: number | string
  playlistId?: string
  category?: string | null
  categories?: string[] | null
  isHeader?: boolean
}

export function channelCategoryNames(row: LiveRowLike, fallbackName = ""): string[] {
  const raw = row.categories?.length ? row.categories : [row.category]
  return raw.map((name) => (name ?? "").trim() || fallbackName)
}

export function channelMatchesCategory(
  row: LiveRowLike,
  selection: { playlistId: string; name: string },
  fallbackName = "",
): boolean {
  return (
    row.playlistId === selection.playlistId &&
    channelCategoryNames(row, fallbackName).includes(selection.name)
  )
}

export function channelPassesCategoryFilter(
  row: LiveRowLike,
  passes: (categoryKey: string) => boolean,
  fallbackName = "",
): boolean {
  const playlistId = row.playlistId ?? ""
  return channelCategoryNames(row, fallbackName).some((name) =>
    passes(mergedCategoryKey(playlistId, name)),
  )
}

export function liveContextIdsForPlaylist(rows: LiveRowLike[], playlistId: string): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (row.isHeader || row.playlistId !== playlistId) continue
    ids.push(String(row.id))
  }
  return ids
}

export function nativeChannelId(row: LiveRowLike & { playlistId: string }, merged: boolean): string {
  return merged ? rowKey(row) : String(row.id)
}

export function resolveNativeChannel<T extends LiveRowLike & { playlistId: string }>(
  rows: T[],
  rawId: string | number,
): T | null {
  const wanted = String(rawId)
  return (
    rows.find((row) => rowKey(row) === wanted) ||
    rows.find((row) => String(row.id) === wanted) ||
    null
  )
}
