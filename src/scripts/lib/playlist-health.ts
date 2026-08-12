import { getCached } from "@/scripts/lib/cache.js"
import { log } from "@/scripts/lib/log.js"
import {
  ensureUserInfo,
  getCachedUserInfoSync,
  getMaxConnectionsSync,
  getActiveConnectionsSync,
  getExpirationMsSync,
} from "@/scripts/lib/account-info.js"
import { getProgrammesSync } from "@/scripts/lib/epg-data.js"
import { getProviderStats } from "@/scripts/lib/provider-fetch.js"
import { getNetworkLog, type NetLogEntry } from "@/scripts/lib/net-log"

export type AccountStatus = "active" | "expired" | "inactive" | "unknown"

export interface CatalogKindHealth {
  fetchedAt: number | null
  ageMs: number | null
  itemCount: number | null
}

export interface PlaylistHealth {
  playlistId: string
  fetchedAt: number
  account: {
    status: AccountStatus
    activeConnections: number | null
    maxConnections: number | null
    expDateMs: number | null
    daysUntilExpiry: number | null
  }
  catalog: {
    live: CatalogKindHealth
    vod: CatalogKindHealth
    series: CatalogKindHealth
  }
  epg: {
    fetchedAt: number | null
    ageMs: number | null
    channelsWithProgrammes: number
  }
  provider: {
    lastSuccessAt: number | null
    lastFailureAt: number | null
    lastError: string
    successes: number
    failures: number
  }
}

function summarizeAccount(playlistId: string): PlaylistHealth["account"] {
  const info = getCachedUserInfoSync(playlistId)
  const userInfo = info?.user_info || null
  const maxConnections = getMaxConnectionsSync(playlistId) || null
  const activeConnections = userInfo?.active_cons != null
    ? getActiveConnectionsSync(playlistId)
    : null
  const expDateMs = getExpirationMsSync(playlistId)
  const daysUntilExpiry = expDateMs
    ? Math.floor((expDateMs - Date.now()) / 86_400_000)
    : null

  let status: AccountStatus = "unknown"
  const rawStatus = String(userInfo?.status || "").toLowerCase()
  if (!userInfo) status = "unknown"
  else if (expDateMs && expDateMs < Date.now()) status = "expired"
  else if (rawStatus === "active") status = "active"
  else if (rawStatus) status = "inactive"

  return { status, activeConnections, maxConnections, expDateMs, daysUntilExpiry }
}

function readCatalogKind(
  playlistId: string,
  kind: string
): CatalogKindHealth {
  const hit = getCached(playlistId, kind)
  if (!hit) return { fetchedAt: null, ageMs: null, itemCount: null }
  const itemCount = Array.isArray(hit.data) ? hit.data.length : null
  return {
    fetchedAt: hit.fetchedAt,
    ageMs: typeof hit.age === "number" ? hit.age : Date.now() - hit.fetchedAt,
    itemCount,
  }
}

function readEpg(playlistId: string): PlaylistHealth["epg"] {
  const state = getProgrammesSync(playlistId) as
    | { fetchedAt?: number; programmes?: Map<string, unknown[]> }
    | null
  if (!state) {
    return { fetchedAt: null, ageMs: null, channelsWithProgrammes: 0 }
  }
  const fetchedAt = typeof state.fetchedAt === "number" ? state.fetchedAt : null
  return {
    fetchedAt,
    ageMs: fetchedAt ? Date.now() - fetchedAt : null,
    channelsWithProgrammes: state.programmes?.size ?? 0,
  }
}

/**
 * Reduces persisted net-log entries into the same shape as getProviderStats().
 * Used when the module-level counters are empty (fresh page load after an
 * MPA navigation) but the session's network log still has requests to show.
 */
export function deriveProviderStatsFromNetLog(entries: NetLogEntry[]): PlaylistHealth["provider"] {
  let lastSuccessAt = 0
  let lastFailureAt = 0
  let lastError = ""
  let successes = 0
  let failures = 0
  for (const entry of entries) {
    if (entry.outcome === "aborted") continue
    const endedAt = entry.startedAt + entry.durationMs
    if (entry.outcome === "error") {
      failures++
      if (endedAt >= lastFailureAt) {
        lastFailureAt = endedAt
        lastError = entry.error || lastError
      }
    } else {
      successes++
      if (endedAt > lastSuccessAt) lastSuccessAt = endedAt
    }
  }
  return {
    lastSuccessAt: lastSuccessAt || null,
    lastFailureAt: lastFailureAt || null,
    lastError,
    successes,
    failures,
  }
}

function summarizeProvider(): PlaylistHealth["provider"] {
  const stats = getProviderStats()
  if (stats.successes || stats.failures) {
    return {
      lastSuccessAt: stats.lastSuccessAt || null,
      lastFailureAt: stats.lastFailureAt || null,
      lastError: stats.lastError,
      successes: stats.successes,
      failures: stats.failures,
    }
  }
  return deriveProviderStatsFromNetLog(getNetworkLog().entries)
}

/**
 * Synchronous snapshot of the current playlist health state. Pulls
 * exclusively from in-memory caches and localStorage - safe to call
 * during render. Returns "unknown" / null fields when data hasn't been
 * hydrated yet rather than throwing.
 */
export function getPlaylistHealth(playlistId: string): PlaylistHealth {
  // For "live" we ALSO check the m3u kind because m3u-source playlists
  // store channels under that key. Whichever has data wins.
  const live = readCatalogKind(playlistId, "live")
  const liveOrM3U = live.fetchedAt ? live : readCatalogKind(playlistId, "m3u")

  return {
    playlistId,
    fetchedAt: Date.now(),
    account: summarizeAccount(playlistId),
    catalog: {
      live: liveOrM3U,
      vod: readCatalogKind(playlistId, "vod"),
      series: readCatalogKind(playlistId, "series"),
    },
    epg: readEpg(playlistId),
    provider: summarizeProvider(),
  }
}

/**
 * Re-runs ensureUserInfo() to refresh account info, then returns a fresh
 * snapshot. Catalog / EPG aren't re-fetched here - the user already has
 * the "Refresh active" button in Settings for that.
 */
export async function refreshPlaylistHealth(
  playlistId: string,
  creds: { host: string; port?: string; user: string; pass: string }
): Promise<PlaylistHealth> {
  if (creds?.host && creds?.user && creds?.pass) {
    try {
      await ensureUserInfo(creds, playlistId, { force: true })
    } catch (refreshError) {
      log.warn("[xt:playlist-health] account info refresh failed:", refreshError)
    }
  }
  return getPlaylistHealth(playlistId)
}

// ---------------------------------------------------------------------------
// Formatting helpers - shared so settings.astro doesn't reinvent them
// ---------------------------------------------------------------------------

/** "2 minutes ago", "3 hours ago", "5 days ago", or "never". */
export function fmtAgo(timestamp: number | null): string {
  if (!timestamp) return "-"
  const ms = Date.now() - timestamp
  if (ms < 0) return "-"
  if (ms < 60_000) return "just now"
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** Locale-formatted date for an exp_date timestamp, or "-" / "never". */
export function fmtAbsDate(timestamp: number | null): string {
  if (!timestamp) return "-"
  try {
    return new Date(timestamp).toLocaleDateString()
  } catch {
    return "-"
  }
}
