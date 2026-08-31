// Cache-only reads of a playlist's live channels, with the per-channel overlay applied.
// Deliberately separate from catalog.js: a favorites strip only needs cached rows, and
// catalog.js drags in the whole fetch stack (xtream-api, provider-fetch, m3u-parser,
// tmdb-backfill) which would then be statically bound into every page that reads one.
import { getCached } from "@/scripts/lib/cache.js"
import { getChannelOverrides, ensureLoaded as ensurePrefsLoaded } from "@/scripts/lib/preferences.js"
import { applyChannelOverrides } from "@/scripts/lib/channel-overrides.ts"
import { log } from "@/scripts/lib/log.js"

export interface LiveReadOptions {
  /** Keep hidden channels in the result (the management UI needs them). */
  includeHidden?: boolean
}

/**
 * Overlays the user's per-channel edits onto a provider catalog. The cache keeps
 * provider truth, so a refresh never destroys an edit and revert always works.
 */
// Untyped on purpose: the callers are JS (catalog.js) and every page's own channel
// shape. The typed contract lives in channel-overrides.ts.
export function applyLiveOverrides(
  channels: any[],
  playlistId: string,
  isM3U: boolean,
  options: LiveReadOptions = {}
): any[] {
  if (!playlistId) return channels
  try {
    return applyChannelOverrides(channels, getChannelOverrides(playlistId), {
      isM3U,
      includeHidden: !!options.includeHidden,
    })
  } catch (overrideError) {
    log.warn("[xt:catalog] channel overrides skipped:", overrideError)
    return channels
  }
}

/** True once a playlist's live catalog is in the cache, whatever its backend. */
export function hasCachedLiveChannels(playlistId: string): boolean {
  if (!playlistId) return false
  return !!(getCached(playlistId, "live") || getCached(playlistId, "m3u"))
}

/**
 * Cache-only read of a playlist's live channels with overrides applied. Every
 * caller that reached for `getCached(live) || getCached(m3u)` goes through here,
 * so a rename shows up on the hub, in search and on the EPG grid too - not only
 * where `ensureLive` happens to be awaited.
 */
export function readCachedLiveChannels(playlistId: string, options: LiveReadOptions = {}): any[] {
  if (!playlistId) return []
  const liveHit = getCached(playlistId, "live")
  const m3uHit = getCached(playlistId, "m3u")
  const liveRows = liveHit && Array.isArray(liveHit.data) ? liveHit.data : null
  const m3uRows = m3uHit && Array.isArray(m3uHit.data) ? m3uHit.data : null
  const isM3U = !(liveRows && liveRows.length)
  const data = (liveRows && liveRows.length ? liveRows : null) || m3uRows || liveRows || []
  return applyLiveOverrides(data, playlistId, isM3U, options)
}

/** Prefs hold the overrides, so a cache-only reader has to wait for them once. */
export async function ensureOverridesReady(): Promise<void> {
  try {
    await ensurePrefsLoaded()
  } catch (prefsError) {
    log.warn("[xt:catalog] preferences load failed, overrides inactive:", prefsError)
  }
}
