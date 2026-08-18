// Shared catalog fetch + parse + cache

import {
  cachedFetch,
  getCached,
  hydrate as hydrateCache,
  invalidateCustomDependents,
} from "@/scripts/lib/cache.js"
import {
  loadCreds,
  isLikelyM3USource,
  isLocalM3UHost,
  isCustomHost,
  readLocalM3UContent,
  getEntries,
  entryToCreds,
  isTauri,
} from "@/scripts/lib/creds.js"
import { normalize } from "@/scripts/lib/text.js"
import {
  parseCategoriesToMap,
  mapXtreamLiveRows,
  mapXtreamVodRows,
  mapXtreamSeriesRows,
  rowsNeedTmdbBackfill,
  rowsNeedGenreBackfill,
} from "@/scripts/lib/catalog-mappers.js"
import { triggerTmdbBackfillOnce } from "@/scripts/lib/tmdb-backfill.ts"
import { providerFetch, streamingText } from "@/scripts/lib/provider-fetch.js"
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import { ensureUserInfo } from "@/scripts/lib/account-info.js"
import { parseM3U, isHlsStreamManifest } from "@/scripts/lib/m3u-parser.ts"
import {
  loadCustomDoc,
  resolveCustomChannels,
  collectSourceEntryIds,
} from "@/scripts/lib/custom-playlist.ts"
import { buildLiveStreamUrl } from "@/scripts/lib/stream-urls.ts"
import { t } from "@/scripts/lib/i18n.js"
import { retryWithBackoff, HttpRetryError } from "@/scripts/lib/retry.ts"
import { log } from "@/scripts/lib/log.js"

export const CHANNELS_TTL_MS = 24 * 60 * 60 * 1000
export const VOD_TTL_MS = 24 * 60 * 60 * 1000
export const SERIES_TTL_MS = 24 * 60 * 60 * 1000

const EVT_WARMED = "xt:catalog-warmed"
const EVT_WARMING_START = "xt:catalog-warming-start"
const EVT_WARMING_PROGRESS = "xt:catalog-warming-progress"
const EVT_WARMING_BYTES = "xt:catalog-warming-bytes"

function dispatch(name, detail) {
  try {
    document.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {}
}

/** Build an onProgress callback that throttles to ~one event per animation
 *  frame and dispatches xt:catalog-warming-bytes for the warming indicator. */
function makeBytesEmitter(playlistId, kind) {
  let raf = 0
  let lastBytes = 0
  let lastTotal = 0
  let pending = false
  return (received, total) => {
    lastBytes = received
    lastTotal = total
    if (pending) return
    pending = true
    raf = requestAnimationFrame(() => {
      pending = false
      raf = 0
      dispatch(EVT_WARMING_BYTES, {
        playlistId,
        kind,
        bytes: lastBytes,
        total: lastTotal,
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Live (Xtream + M3U)
// ---------------------------------------------------------------------------
async function fetchLiveCategoryMap(playlistId) {
  const r = await xtreamApiFetch("get_live_categories", {}, { entryId: playlistId })
  if (!r.ok) throw new HttpRetryError(r.status, `live_categories ${r.status}`)
  const data = await r.json().catch((err) => {
    log.warn("[xt:catalog] live categories parse failed:", err?.message || err)
    return []
  })
  return parseCategoriesToMap(data)
}

export function m3uToChannelList(text, sourceUrl, streamHeaders, logo, manifestType, drmScheme, licenseKey) {
  const fallbackCategory = t("stream.uncategorized") || "Uncategorized"
  const isDirectStream = typeof sourceUrl === "string" && /^https?:\/\//i.test(sourceUrl)
  const isDashSource = isDirectStream && manifestType === "mpd"
  if (isDirectStream && (isHlsStreamManifest(text) || isDashSource)) {
    const name = t("stream.directStream") || "Live stream"
    return [{
      id: 1,
      name,
      category: fallbackCategory,
      categories: [fallbackCategory],
      logo: logo || null,
      tvgId: undefined,
      chno: undefined,
      tvgShift: null,
      norm: normalize(`${name} ${fallbackCategory}`),
      url: sourceUrl,
      isRadio: false,
      catchup: null,
      catchupDays: null,
      catchupSource: null,
      catchupCorrection: null,
      userAgent: streamHeaders?.userAgent || null,
      referer: streamHeaders?.referer || null,
      manifestType: isDashSource ? "mpd" : null,
      drmScheme: drmScheme || null,
      licenseKey: licenseKey || null,
    }]
  }
  const { entries } = parseM3U(text)
  const out = []
  let idSeq = 1
  for (const entry of entries) {
    if (!entry.url || !entry.name) continue
    const category = entry.category || fallbackCategory
    const categories = entry.categories && entry.categories.length ? entry.categories : [category]
    out.push({
      id: idSeq++,
      name: entry.name,
      category,
      categories,
      logo: entry.logo,
      tvgId: entry.tvgId || undefined,
      chno: entry.chno ?? undefined,
      tvgShift: entry.tvgShift ?? null,
      norm: normalize(`${entry.name} ${category} ${entry.tvgId || ""}`),
      url: entry.url,
      isRadio: !!entry.isRadio,
      catchup: entry.catchup ?? null,
      catchupDays: entry.catchupDays ?? null,
      catchupSource: entry.catchupSource ?? null,
      catchupCorrection: entry.catchupCorrection ?? null,
      userAgent: entry.userAgent ?? null,
      referer: entry.referer ?? null,
      manifestType: entry.manifestType ?? null,
      drmScheme: entry.drmScheme ?? null,
      licenseKey: entry.licenseKey ?? null,
    })
  }
  return out
}

/** Build the source pools a custom playlist's channels resolve against, hydrating each referenced entry's own live catalog through the normal cached path. */
export async function buildCustomSourcePools(doc, opts = {}) {
  const sourceEntryIds = collectSourceEntryIds(doc)
  const entries = await getEntries()
  const pools = new Map()
  await Promise.all(
    sourceEntryIds.map(async (sourceEntryId) => {
      const sourceEntry = entries.find((entry) => entry._id === sourceEntryId)
      // Custom sources would recurse into ensureLive and deadlock on cachedFetch's in-flight dedup.
      if (!sourceEntry || sourceEntry.type === "custom") return
      let channels
      try {
        channels = await ensureLive(entryToCreds(sourceEntry), sourceEntryId, opts)
      } catch (err) {
        log.warn("[xt:catalog] custom playlist source hydration failed:", sourceEntryId, err?.message || err)
        return
      }
      if (sourceEntry.type === "xtream") {
        pools.set(sourceEntryId, {
          kind: "xtream",
          channels,
          // Re-derived per call so a mirror failover is reflected in the stream URL.
          buildUrl: (streamId) => {
            const sourceCreds = entryToCreds(sourceEntry)
            return buildLiveStreamUrl(sourceCreds, streamId, sourceCreds.liveContainer)
          },
        })
      } else {
        pools.set(sourceEntryId, { kind: "m3u", channels })
      }
    })
  )
  return pools
}

async function fetchCustomLiveChannels(playlistId, opts = {}) {
  const doc = await loadCustomDoc(playlistId)
  const pools = await buildCustomSourcePools(doc, opts)
  return resolveCustomChannels(doc, pools)
}

export async function ensureLive(creds, playlistId, opts = {}) {
  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  const kind = isM3U ? "m3u" : "live"
  if (isTauri) {
    try {
      const { awaitNativeKind } = await import("@/scripts/lib/warmup-native.ts")
      await awaitNativeKind(playlistId, kind)
    } catch (err) {
      log.warn("[xt:catalog] await native kind failed:", err?.message || err)
    }
  }
  const onBytes = makeBytesEmitter(playlistId, "live")
  const { data } = await cachedFetch(playlistId, kind, CHANNELS_TTL_MS, () => retryWithBackoff(async () => {
    if (isM3U) {
      if (isCustomHost(creds.host)) {
        return fetchCustomLiveChannels(playlistId, opts)
      }
      let text
      if (isLocalM3UHost(creds.host)) {
        text = await readLocalM3UContent(creds.host)
        try { onBytes(text.length, text.length) } catch {}
      } else {
        const r = await providerFetch(creds.host, { logKind: "playlist" })
        if (!r.ok) throw new HttpRetryError(r.status, `M3U ${r.status}`)
        text = await streamingText(r, onBytes)
      }
      try {
        // Comma-joined; epg-data.js splits it back apart on read.
        const { epgUrls } = parseM3U(text)
        if (epgUrls.length && typeof localStorage !== "undefined") {
          localStorage.setItem(`xt_m3u_epg:${playlistId}`, epgUrls.join(","))
        }
      } catch {}
      const activeEntry = (await getEntries()).find((entry) => entry._id === playlistId)
      return m3uToChannelList(
        text,
        creds.host,
        activeEntry?.streamHeaders,
        activeEntry?.logo,
        activeEntry?.manifestType,
        activeEntry?.drmScheme,
        activeEntry?.licenseKey
      )
    }
    const catMap = await fetchLiveCategoryMap(playlistId)
    const r = await xtreamApiFetch("get_live_streams", {}, { entryId: playlistId })
    const body = await streamingText(r, onBytes)
    if (!r.ok) throw new HttpRetryError(r.status, `live_streams ${r.status}`)
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed?.streams || parsed?.results || []
    return mapXtreamLiveRows(arr, catMap)
  }), { force: !!opts.force })
  return data || []
}

// ---------------------------------------------------------------------------
// VOD
// ---------------------------------------------------------------------------
async function fetchVodCategoryMap() {
  const r = await xtreamApiFetch("get_vod_categories")
  if (!r.ok) throw new HttpRetryError(r.status, `vod_categories ${r.status}`)
  const data = await r.json().catch((err) => {
    log.warn("[xt:catalog] vod categories parse failed:", err?.message || err)
    return []
  })
  return parseCategoriesToMap(data)
}

export async function ensureVod(creds, playlistId, opts = {}) {
  if (!creds?.user || !creds?.pass) return []
  if (isTauri) {
    try {
      const { awaitNativeKind } = await import("@/scripts/lib/warmup-native.ts")
      await awaitNativeKind(playlistId, "vod")
    } catch (err) {
      log.warn("[xt:catalog] await native kind failed:", err?.message || err)
    }
  }
  const onBytes = makeBytesEmitter(playlistId, "vod")
  const fetcher = () => retryWithBackoff(async () => {
    const catMap = await fetchVodCategoryMap()
    const r = await xtreamApiFetch("get_vod_streams")
    const body = await streamingText(r, onBytes)
    if (!r.ok) throw new HttpRetryError(r.status, `vod_streams ${r.status}`)
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed?.movies || parsed?.results || []
    return mapXtreamVodRows(arr, catMap)
  })
  const { data } = await cachedFetch(playlistId, "vod", VOD_TTL_MS, fetcher, { force: !!opts.force })
  if (!opts.force && rowsNeedTmdbBackfill(data)) {
    triggerTmdbBackfillOnce(playlistId, "vod", VOD_TTL_MS, fetcher)
  }
  return data || []
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------
async function fetchSeriesCategoryMap() {
  const r = await xtreamApiFetch("get_series_categories")
  if (!r.ok) throw new HttpRetryError(r.status, `series_categories ${r.status}`)
  const data = await r.json().catch((err) => {
    log.warn("[xt:catalog] series categories parse failed:", err?.message || err)
    return []
  })
  return parseCategoriesToMap(data)
}

export async function ensureSeries(creds, playlistId, opts = {}) {
  if (!creds?.user || !creds?.pass) return []
  if (isTauri) {
    try {
      const { awaitNativeKind } = await import("@/scripts/lib/warmup-native.ts")
      await awaitNativeKind(playlistId, "series")
    } catch (err) {
      log.warn("[xt:catalog] await native kind failed:", err?.message || err)
    }
  }
  const onBytes = makeBytesEmitter(playlistId, "series")
  const fetcher = () => retryWithBackoff(async () => {
    const catMap = await fetchSeriesCategoryMap()
    const r = await xtreamApiFetch("get_series")
    const body = await streamingText(r, onBytes)
    if (!r.ok) throw new HttpRetryError(r.status, `series ${r.status}`)
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed) ? parsed : parsed?.series || parsed?.results || []
    return mapXtreamSeriesRows(arr, catMap)
  })
  const { data } = await cachedFetch(playlistId, "series", SERIES_TTL_MS, fetcher, { force: !!opts.force })
  if (!opts.force && (rowsNeedTmdbBackfill(data) || rowsNeedGenreBackfill(data))) {
    triggerTmdbBackfillOnce(playlistId, "series", SERIES_TTL_MS, fetcher)
  }
  return data || []
}

const inflight = new Map()

export async function warmupActive(playlistId, opts = {}) {
  let creds
  let pid = playlistId
  try {
    creds = await loadCreds()
  } catch (err) {
    log.warn("[xt:catalog] warmup loadCreds failed:", err?.message || err)
    return { live: [], vod: [], series: [], errors: { creds: "no creds" } }
  }
  if (!creds?.host) {
    return { live: [], vod: [], series: [], errors: { creds: "no creds" } }
  }
  if (!pid) {
    const { getActiveEntry } = await import("@/scripts/lib/creds.js")
    const e = await getActiveEntry()
    pid = e?._id
  }
  if (!pid) {
    return { live: [], vod: [], series: [], errors: { playlist: "no active" } }
  }

  // Don't dedupe forced refreshes; the user just hit "refresh" expecting
  // a fresh round-trip even if a background warmup is mid-flight.
  if (!opts.force && inflight.has(pid)) return inflight.get(pid)

  const run = (async () => {
    if (isTauri) {
      try {
        const { warmupActiveNative } = await import("@/scripts/lib/warmup-native.ts")
        const nativeResult = await warmupActiveNative(pid, { force: !!opts.force })
        if (nativeResult) return nativeResult
      } catch (err) {
        log.warn("[xt:catalog] native warmup failed, using JS path:", err?.message || err)
      }
    }
    const errors = {}
    const force = !!opts.force
    const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
    const liveKey = isM3U ? "m3u" : "live"

    await Promise.all([
      hydrateCache(pid, liveKey),
      hydrateCache(pid, "vod"),
      hydrateCache(pid, "series"),
    ])
    const allHot =
      !force &&
      !!getCached(pid, liveKey) &&
      !!getCached(pid, "vod") &&
      !!getCached(pid, "series")

    if (!allHot) {
      dispatch(EVT_WARMING_START, { playlistId: pid, kinds: ["live", "vod", "series"] })
    }
    const wrap = (kind, fn) =>
      fn()
        .then((data) => {
          if (!allHot) {
            dispatch(EVT_WARMING_PROGRESS, {
              playlistId: pid,
              kind,
              status: "done",
              count: Array.isArray(data) ? data.length : 0,
            })
          }
          return data
        })
        .catch((e) => {
          errors[kind] = String(e?.message || e)
          log.warn(`[xt:catalog] ${kind} warmup failed:`, errors[kind])
          if (!allHot) {
            dispatch(EVT_WARMING_PROGRESS, {
              playlistId: pid,
              kind,
              status: "error",
              error: errors[kind],
            })
          }
          return []
        })
    const [live, vod, series] = await Promise.all([
      wrap("live", () => ensureLive(creds, pid, { force })),
      wrap("vod", () => ensureVod(creds, pid, { force })),
      wrap("series", () => ensureSeries(creds, pid, { force })),
      // user_info comes alongside the catalog so download-concurrency caps
      // and the expiration banner are populated without waiting for /settings.
      // Failure is ignored - M3U sources won't have a player_api endpoint.
      ensureUserInfo(creds, pid, { force }).catch(() => null),
    ])
    if (force) await invalidateCustomDependents(pid)
    dispatch(EVT_WARMED, { playlistId: pid, errors })
    return { live, vod, series, errors }
  })()
    .finally(() => {
      // Hold the in-flight result for a beat so back-to-back callers reuse it.
      setTimeout(() => inflight.delete(pid), 1500)
    })

  inflight.set(pid, run)
  return run
}

export const CATALOG_WARMED_EVENT = EVT_WARMED
export const CATALOG_WARMING_START_EVENT = EVT_WARMING_START
export const CATALOG_WARMING_PROGRESS_EVENT = EVT_WARMING_PROGRESS
export const CATALOG_WARMING_BYTES_EVENT = EVT_WARMING_BYTES

const ENSURE_BY_KIND = {
  live: ensureLive,
  vod: ensureVod,
  series: ensureSeries,
}

/** Force a re-fetch of one kind. Used by the warming indicator's retry chip
 *  so a transient failure on (say) vod doesn't require re-warming all three. */
export async function retryWarmupKind(playlistId, kind) {
  const fetcher = ENSURE_BY_KIND[kind]
  if (!fetcher) return
  let creds
  try {
    creds = await loadCreds()
  } catch (err) {
    log.warn("[xt:catalog] retryWarmupKind loadCreds failed:", err?.message || err)
    return
  }
  if (!creds?.host) return
  let pid = playlistId
  if (!pid) {
    const { getActiveEntry } = await import("@/scripts/lib/creds.js")
    const e = await getActiveEntry()
    pid = e?._id
  }
  if (!pid) return
  if (isTauri) {
    try {
      const { retryKindNative } = await import("@/scripts/lib/warmup-native.ts")
      if (await retryKindNative(pid, kind)) return
    } catch (err) {
      log.warn("[xt:catalog] native retry failed, using JS path:", err?.message || err)
    }
  }
  dispatch(EVT_WARMING_PROGRESS, { playlistId: pid, kind, status: "pending" })
  try {
    const data = await fetcher(creds, pid, { force: true })
    if (kind === "live") await invalidateCustomDependents(pid)
    dispatch(EVT_WARMING_PROGRESS, {
      playlistId: pid,
      kind,
      status: "done",
      count: Array.isArray(data) ? data.length : 0,
    })
  } catch (e) {
    log.warn(`[xt:catalog] retry ${kind} failed:`, String(e?.message || e))
    dispatch(EVT_WARMING_PROGRESS, {
      playlistId: pid,
      kind,
      status: "error",
      error: String(e?.message || e),
    })
  }
}
