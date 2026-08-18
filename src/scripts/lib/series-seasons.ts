// Lazy season-count resolver for series rows (grid + global search).
//
// The bulk `get_series` list the catalog caches has no season count - only
// the per-series `get_series_info` action does. This module resolves a season
// count for a single series id: it reuses the `series_info_<id>` entry the
// detail page already caches when present, and otherwise fetches it through a
// small throttled queue so painting a page of series rows doesn't fire dozens
// of simultaneous provider requests (Xtream providers cap concurrent
// connections). Resolution is gated behind an IntersectionObserver so only
// rows actually scrolled into view ever trigger a fetch.

import { getCached, setCached, hydrate } from "@/scripts/lib/cache.js"
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"

// Match detail.ts so the two share one cache entry per series.
const SERIES_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CONCURRENT = 3

function seriesInfoKind(seriesId: string | number): string {
  return `series_info_${seriesId}`
}

/** Localized "N seasons" label (singular-aware). */
export function seasonsLabel(count: number): string {
  return count === 1
    ? t("series.seasonsCountOne", { count })
    : t("series.seasonsCount", { count })
}

/**
 * Count distinct seasons in a get_series_info payload. Prefers the season
 * keys that actually carry episodes (most accurate for what a viewer can
 * play); falls back to the `seasons` metadata array.
 */
export function countSeasons(info: any): number {
  if (!info || typeof info !== "object") return 0
  const episodes = info.episodes
  if (episodes && typeof episodes === "object" && !Array.isArray(episodes)) {
    const keys = Object.keys(episodes).filter(
      (key) => Array.isArray(episodes[key]) && episodes[key].length
    )
    if (keys.length) return keys.length
  }
  if (Array.isArray(episodes)) {
    const seen = new Set<string>()
    for (const episode of episodes) seen.add(String(episode?.season ?? "1"))
    if (seen.size) return seen.size
  }
  if (Array.isArray(info.seasons)) return info.seasons.length
  return 0
}

/**
 * Flatten a get_series_info payload into its episode ids, across every
 * season key. Used to verify "every episode is watched" against the real
 * episode list rather than just the recorded progress entries.
 */
export function extractEpisodeIds(info: any): number[] {
  if (!info || typeof info !== "object") return []
  const episodes = info.episodes
  const ids: number[] = []
  const collect = (episode: any) => {
    const id = Number(episode?.id)
    if (Number.isFinite(id)) ids.push(id)
  }
  if (episodes && typeof episodes === "object" && !Array.isArray(episodes)) {
    for (const season of Object.values(episodes)) {
      if (Array.isArray(season)) season.forEach(collect)
    }
  } else if (Array.isArray(episodes)) {
    episodes.forEach(collect)
  }
  return ids
}

/**
 * Synchronous read of the cached series-info state. `cached` is true whenever a
 * (non-expired) payload is in memory, even when it contains zero seasons - so
 * callers can tell "no data yet" apart from "confirmed to have no seasons" and
 * avoid re-fetching a series the provider genuinely lists with no episodes.
 */
function getCachedSeriesInfo(
  playlistId: string,
  seriesId: string | number
): { cached: boolean; data: any } {
  if (!playlistId || seriesId == null) return { cached: false, data: null }
  const hit = getCached(playlistId, seriesInfoKind(seriesId))
  if (!hit) return { cached: false, data: null }
  return { cached: true, data: hit.data }
}

function getCachedSeasonState(
  playlistId: string,
  seriesId: string | number
): { cached: boolean; count: number | null } {
  const { cached, data } = getCachedSeriesInfo(playlistId, seriesId)
  if (!cached) return { cached: false, count: null }
  const count = countSeasons(data)
  return { cached: true, count: count > 0 ? count : null }
}

/**
 * Synchronous read: cached episode ids for a series, or null when the
 * series_info payload isn't in memory yet. Callers that need a network fetch
 * on miss should go through requestEpisodeIds.
 */
export function getCachedEpisodeIds(
  playlistId: string,
  seriesId: string | number
): number[] | null {
  const { cached, data } = getCachedSeriesInfo(playlistId, seriesId)
  return cached ? extractEpisodeIds(data) : null
}

/**
 * Synchronous read: season count from already-cached series info, or null
 * when nothing is in memory yet. Callers that want IDB-backed reads should go
 * through requestSeasonCount / observeSeasonCount.
 */
export function getCachedSeasonCount(
  playlistId: string,
  seriesId: string | number
): number | null {
  return getCachedSeasonState(playlistId, seriesId).count
}

// ---------------------------------------------------------------------------
// Throttled fetch queue
// ---------------------------------------------------------------------------
type Job = () => Promise<void>
const _queue: Job[] = []
const _pending = new Map<string, Promise<any | null>>()
const _failed = new Set<string>()
let _active = 0

function jobKey(playlistId: string, seriesId: string | number): string {
  return `${playlistId}::${seriesId}`
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:active-changed", () => _failed.clear())
}

function pump(): void {
  while (_active < MAX_CONCURRENT && _queue.length) {
    const job = _queue.shift()!
    _active++
    job().finally(() => {
      _active--
      pump()
    })
  }
}

async function isActivePlaylist(playlistId: string): Promise<boolean> {
  try {
    const entry = await getActiveEntry()
    return !!entry && entry._id === playlistId
  } catch {
    return false
  }
}

async function fetchSeriesInfo(
  playlistId: string,
  seriesId: string | number
): Promise<any | null> {
  try {
    const response = await xtreamApiFetch("get_series_info", {
      series_id: String(seriesId),
      series: String(seriesId),
    })
    if (!response.ok) throw new Error(`get_series_info ${response.status}`)
    const data = await response.json()
    if (!(await isActivePlaylist(playlistId))) return null
    setCached(playlistId, seriesInfoKind(seriesId), data, SERIES_INFO_TTL_MS)
    return data
  } catch (err) {
    _failed.add(jobKey(playlistId, seriesId))
    log.warn(`[xt:seasons] ${seriesId} lookup failed:`, err)
    return null
  }
}

/**
 * Resolve the raw get_series_info payload for one series. Returns the cached
 * value immediately when available, otherwise queues a throttled fetch.
 * Resolves to null when unavailable (M3U source, network failure, or a
 * playlist switch mid-fetch). Shared by requestSeasonCount and
 * requestEpisodeIds so both derive from one cache entry / one fetch.
 */
export function requestSeriesInfo(
  playlistId: string,
  seriesId: string | number
): Promise<any | null> {
  if (!playlistId || seriesId == null) return Promise.resolve(null)

  const cached = getCachedSeriesInfo(playlistId, seriesId)
  if (cached.cached) return Promise.resolve(cached.data)
  const key = jobKey(playlistId, seriesId)
  if (_failed.has(key)) return Promise.resolve(null)
  const existing = _pending.get(key)
  if (existing) return existing

  const promise = new Promise<any | null>((resolve) => {
    _queue.push(async () => {
      if (!(await isActivePlaylist(playlistId))) {
        resolve(null)
        return
      }

      await hydrate(playlistId, seriesInfoKind(seriesId)).catch(() => {})
      const fromCache = getCachedSeriesInfo(playlistId, seriesId)
      if (fromCache.cached) {
        resolve(fromCache.data)
        return
      }
      resolve(await fetchSeriesInfo(playlistId, seriesId))
    })
    pump()
  }).finally(() => _pending.delete(key))

  _pending.set(key, promise)
  return promise
}

/**
 * Resolve a season count for one series. Resolves to null when unavailable
 * (M3U source, network failure, or genuinely no seasons).
 */
export function requestSeasonCount(
  playlistId: string,
  seriesId: string | number
): Promise<number | null> {
  return requestSeriesInfo(playlistId, seriesId).then((data) => {
    const count = countSeasons(data)
    return count > 0 ? count : null
  })
}

/**
 * Resolve a series' real episode ids, fetching on cache miss. Resolves to
 * null when unavailable, so callers can tell "unproven" apart from "confirmed
 * empty" and stay conservative about the former.
 */
export function requestEpisodeIds(
  playlistId: string,
  seriesId: string | number
): Promise<number[] | null> {
  return requestSeriesInfo(playlistId, seriesId).then((data) =>
    data ? extractEpisodeIds(data) : null
  )
}

// ---------------------------------------------------------------------------
// Viewport-gated resolution
// ---------------------------------------------------------------------------
interface TargetMeta {
  playlistId: string
  seriesId: string | number
  onResolved: (count: number) => void
}

let _io: IntersectionObserver | null = null
const _targets = new WeakMap<Element, TargetMeta>()

function ensureObserver(): IntersectionObserver | null {
  if (_io || typeof IntersectionObserver === "undefined") return _io
  _io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const element = entry.target
        const meta = _targets.get(element)
        _io!.unobserve(element)
        _targets.delete(element)
        if (!meta) continue
        requestSeasonCount(meta.playlistId, meta.seriesId).then((count) => {
          if (count != null) meta.onResolved(count)
        })
      }
    },
    { rootMargin: "200px" }
  )
  return _io
}

/**
 * Resolve a season count for `element` once it scrolls into view, then invoke
 * `onResolved(count)`. Cached counts resolve synchronously. Bounds fetches to
 * rows the user actually sees, so a 2000-series grid stays cheap.
 */
export function observeSeasonCount(
  element: Element | null,
  playlistId: string,
  seriesId: string | number,
  onResolved: (count: number) => void
): void {
  if (!element || !playlistId || seriesId == null) return
  const cached = getCachedSeasonCount(playlistId, seriesId)
  if (cached != null) {
    onResolved(cached)
    return
  }
  const observer = ensureObserver()
  if (!observer) {
    // No IntersectionObserver (very old WebView): resolve eagerly.
    requestSeasonCount(playlistId, seriesId).then((count) => {
      if (count != null) onResolved(count)
    })
    return
  }
  _targets.set(element, { playlistId, seriesId, onResolved })
  observer.observe(element)
}
