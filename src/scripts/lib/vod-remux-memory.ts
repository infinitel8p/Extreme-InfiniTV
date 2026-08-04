// Movies and episodes pinned to the ffmpeg remux path after a direct-playback attempt failed to demux;
// persisted per playlist (module state alone dies on every page navigation, unlike a plain Set).

import { log } from "@/scripts/lib/log.js"

export type RemuxContentKind = "movie" | "episode"

/** Shared by movies/detail.ts and series/detail.ts so both pages pin/read the same key for an item. */
export function buildRemuxContentKey(kind: RemuxContentKind, id: string | number): string {
  return `${kind}:${id}`
}

let remuxFallbackCache: { playlistId: string; ids: Set<string> } | null = null

function loadRemuxFallbackSet(playlistId: string): Set<string> {
  if (remuxFallbackCache && remuxFallbackCache.playlistId === playlistId) {
    return remuxFallbackCache.ids
  }
  let ids = new Set<string>()
  try {
    const raw = localStorage.getItem(`xt_vod_remux_fallback:${playlistId}`)
    if (raw) ids = new Set(JSON.parse(raw))
  } catch {}
  remuxFallbackCache = { playlistId, ids }
  return ids
}

export function isRemuxPinnedContent(playlistId: string, contentKey: string): boolean {
  if (!playlistId) return false
  return loadRemuxFallbackSet(playlistId).has(contentKey)
}

export function rememberRemuxPinnedContent(playlistId: string, contentKey: string): void {
  if (!playlistId) return
  const ids = loadRemuxFallbackSet(playlistId)
  if (ids.has(contentKey)) return
  ids.add(contentKey)
  try {
    localStorage.setItem(`xt_vod_remux_fallback:${playlistId}`, JSON.stringify([...ids]))
  } catch (err) {
    log.warn("[xt:vod-remux-memory] failed to persist remux pin, this item will retry direct playback next time:", err)
  }
}
