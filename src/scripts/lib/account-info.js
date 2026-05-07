import { log } from "@/scripts/lib/log.js"
import { cachedFetch, getCached } from "@/scripts/lib/cache.js"
import { buildApiUrl, safeHttpUrl } from "@/scripts/lib/creds.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { retryWithBackoff, HttpRetryError } from "@/scripts/lib/retry.ts"

const USER_INFO_TTL_MS = 60 * 60 * 1000 // 1 hour
const CACHE_KIND = "user_info"
const EVT_INFO_LOADED = "xt:user-info-loaded"

/**
 * Fetch (or read from cache) the Xtream user_info / server_info blob for one
 * playlist. Returns the parsed payload or null when the request fails or the
 * playlist isn't an Xtream source.
 *
 * @param {{ host: string, port?: string, user: string, pass: string }} creds
 * @param {string} playlistId
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureUserInfo(creds, playlistId, opts = {}) {
  if (!creds?.host || !creds?.user || !creds?.pass || !playlistId) return null
  const apiUrl = buildApiUrl(creds, "")
  if (!safeHttpUrl(apiUrl)) return null
  try {
    const { data } = await cachedFetch(
      playlistId,
      CACHE_KIND,
      USER_INFO_TTL_MS,
      () =>
        retryWithBackoff(async () => {
          const response = await providerFetch(apiUrl)
          if (!response.ok) {
            throw new HttpRetryError(
              response.status,
              `HTTP ${response.status} ${response.statusText}`
            )
          }
          return response.json()
        }),
      opts
    )
    try {
      document.dispatchEvent(
        new CustomEvent(EVT_INFO_LOADED, { detail: { playlistId } })
      )
    } catch {}
    return data || null
  } catch (e) {
    log.warn("[xt:account-info] fetch failed:", e?.message || e)
    return null
  }
}

/** Sync read of the cached payload, or null when not hydrated yet. */
export function getCachedUserInfoSync(playlistId) {
  if (!playlistId) return null
  const hit = getCached(playlistId, CACHE_KIND)
  return hit?.data || null
}

/**
 * Provider-declared maximum simultaneous connections. Returns 0 when unknown
 * (M3U sources, no playlist, or cache cold).
 */
export function getMaxConnectionsSync(playlistId) {
  const info = getCachedUserInfoSync(playlistId)
  const raw = info?.user_info?.max_connections
  if (raw == null) return 0
  const n = parseInt(String(raw), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Provider-declared active connections at the time of last cache write. */
export function getActiveConnectionsSync(playlistId) {
  const info = getCachedUserInfoSync(playlistId)
  const raw = info?.user_info?.active_cons
  if (raw == null) return 0
  const n = parseInt(String(raw), 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Account expiration as ms-since-epoch, or null when unknown / lifetime. */
export function getExpirationMsSync(playlistId) {
  const info = getCachedUserInfoSync(playlistId)
  const ts = parseInt(info?.user_info?.exp_date ?? "", 10)
  return Number.isFinite(ts) ? ts * 1000 : null
}

export function getActivePlaylistIdSync() {
  try {
    const raw = localStorage.getItem("xt_playlists") || ""
    if (!raw) return ""
    const parsed = JSON.parse(raw)
    return parsed?.selectedId || ""
  } catch {
    return ""
  }
}

export const USER_INFO_LOADED_EVENT = EVT_INFO_LOADED
