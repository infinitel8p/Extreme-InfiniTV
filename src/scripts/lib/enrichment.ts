// Title-enrichment facade: TVDB first, TMDb (with a key) only gap-fills.
import { getCached, hydrate, setCached } from "@/scripts/lib/cache.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { getTvdbEnabled } from "@/scripts/lib/app-settings.js"
import { tmdbLanguageFor } from "@/scripts/lib/tmdb.ts"
import {
  fetchMovieEnrichment,
  fetchSeriesEnrichment,
  resolveTmdbId,
  type CachedProviderInfo,
  type TmdbKind,
  type TmdbTitleEnrichment,
} from "@/scripts/lib/tmdb-enrich.ts"
import { mergeTitleEnrichment, tvdbEnrichment } from "@/scripts/lib/tvdb-proxy.ts"

const CACHE_ENTRY_ID = "tmdb"
const DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type EnrichmentKind = "movie" | "series"

export interface TitleEnrichmentRequest {
  kind: EnrichmentKind
  playlistId: string
  itemId: string
  name: string
  year?: number | null
  providerTmdbId?: number | null
}

function tmdbKindFor(kind: EnrichmentKind): TmdbKind {
  return kind === "movie" ? "vod" : "series"
}

// Its own namespace: the merged TVDB+TMDb record must never collide with
// tmdb-enrich.ts's pristine tmdb_movie/series cache, or disabling TVDB later
// would keep serving TVDB-tainted data for the rest of the TTL.
function enrichedDetailCacheKind(kind: EnrichmentKind, tmdbId: number, language: string): string {
  return `enriched_${kind}_${tmdbId}:${language}:v1`
}

// Mirrors resolveTmdbId's match-cache key format.
function matchCacheKind(kind: EnrichmentKind, playlistId: string, itemId: string, language: string): string {
  return `tmdb_match_${tmdbKindFor(kind)}_${playlistId}_${itemId}:${language}`
}

// A title with no TMDb id anywhere gets its own namespace, keyed by TheTVDB id.
function tvdbOnlyDetailCacheKind(kind: EnrichmentKind, tvdbId: number, language: string): string {
  return `tvdb_${kind}_${tvdbId}:${language}:v1`
}

function tvdbMatchCacheKind(kind: EnrichmentKind, playlistId: string, itemId: string, language: string): string {
  return `tvdb_match_${kind}_${playlistId}_${itemId}:${language}`
}

function normalizeTmdbId(value: number | string | null | undefined): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

// ---------------------------------------------------------------------------
// Concurrency limiter: bulk callers (e.g. the ambient manifest) resolve many
// titles at once; TheTVDB proxy Worker rate-limits at 120 req/60s per IP.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_TVDB_RESOLVES = 3
let activeTvdbResolves = 0
const tvdbResolveQueue: Array<() => void> = []

function acquireTvdbSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeTvdbResolves < MAX_CONCURRENT_TVDB_RESOLVES) {
        activeTvdbResolves++
        resolve(() => {
          activeTvdbResolves--
          const next = tvdbResolveQueue.shift()
          if (next) next()
        })
      } else {
        tvdbResolveQueue.push(tryAcquire)
      }
    }
    tryAcquire()
  })
}

/** Runs `run` once fewer than MAX_CONCURRENT_TVDB_RESOLVES TVDB calls are in flight. */
export async function withTvdbConcurrencyLimit<T>(run: () => Promise<T>): Promise<T> {
  const release = await acquireTvdbSlot()
  try {
    return await run()
  } finally {
    release()
  }
}

function persistEnrichment(params: {
  kind: EnrichmentKind
  playlistId: string
  itemId: string
  language: string
  tmdbId: number | null
  tvdbId: number | null
  enrichment: TmdbTitleEnrichment
}): void {
  const { kind, playlistId, itemId, language, tmdbId, tvdbId, enrichment } = params
  if (tmdbId != null) {
    setCached(CACHE_ENTRY_ID, enrichedDetailCacheKind(kind, tmdbId, language), enrichment, DETAIL_TTL_MS)
    setCached(CACHE_ENTRY_ID, matchCacheKind(kind, playlistId, itemId, language), { tmdbId }, MATCH_TTL_MS)
    return
  }
  if (tvdbId != null) {
    setCached(CACHE_ENTRY_ID, tvdbOnlyDetailCacheKind(kind, tvdbId, language), enrichment, DETAIL_TTL_MS)
    setCached(CACHE_ENTRY_ID, tvdbMatchCacheKind(kind, playlistId, itemId, language), { tvdbId }, MATCH_TTL_MS)
  }
}

export interface TitleEnrichmentDetails {
  enrichment: TmdbTitleEnrichment
  tmdbId: number | null
  tvdbId: number | null
}

/**
 * TVDB-first; TMDb (when active) only gap-fills what TVDB left empty. Also
 * surfaces the resolved ids, since season lookups need them independently
 * of whether the enrichment itself resolved (a name-matched TVDB title has
 * no tmdbId but still has a tvdbId to key its seasons on).
 */
export async function resolveTitleEnrichmentDetailed(
  request: TitleEnrichmentRequest
): Promise<TitleEnrichmentDetails | null> {
  const { kind, playlistId, itemId, name, year, providerTmdbId } = request
  const language = tmdbLanguageFor(getActiveLocale())

  let tmdbId = normalizeTmdbId(providerTmdbId)

  const tvdbResult = getTvdbEnabled()
    ? await withTvdbConcurrencyLimit(() => tvdbEnrichment(tmdbId, kind, { name, year: year ?? null }))
    : null

  if (tmdbId == null) {
    tmdbId = await resolveTmdbId(playlistId, tmdbKindFor(kind), {
      id: itemId,
      name,
      year,
      providerTmdbId,
    })
  }

  const tmdbResult =
    tmdbId != null
      ? await (kind === "movie" ? fetchMovieEnrichment(tmdbId) : fetchSeriesEnrichment(tmdbId))
      : null

  const merged = mergeTitleEnrichment(tvdbResult?.enrichment ?? null, tmdbResult ?? null)
  if (!merged) return null

  // TMDb genres are localized to the active language; prefer them whenever TMDb has any.
  const enrichment =
    tmdbResult?.genres && tmdbResult.genres.length > 0
      ? { ...merged, genres: tmdbResult.genres }
      : merged

  const tvdbId = tvdbResult?.tvdbId ?? null
  persistEnrichment({ kind, playlistId, itemId, language, tmdbId, tvdbId, enrichment })
  return { enrichment, tmdbId, tvdbId }
}

/** TVDB-first; TMDb (when active) only gap-fills what TVDB left empty. */
export async function resolveTitleEnrichment(
  request: TitleEnrichmentRequest
): Promise<TmdbTitleEnrichment | null> {
  const details = await resolveTitleEnrichmentDetailed(request)
  return details?.enrichment ?? null
}

export interface PeekedTitleEnrichment {
  enrichment: TmdbTitleEnrichment
  tmdbId: number | null
  tvdbId: number | null
}

/** Cache-only peek: the merged enriched cache first, then the tvdb-only namespace, with the resolved id. */
export async function peekTitleEnrichmentDetailed(
  kind: EnrichmentKind,
  playlistId: string,
  itemId: string
): Promise<PeekedTitleEnrichment | null> {
  const language = tmdbLanguageFor(getActiveLocale())

  const tmdbMatchKind = matchCacheKind(kind, playlistId, itemId, language)
  await hydrate(CACHE_ENTRY_ID, tmdbMatchKind)
  const tmdbMatch = getCached(CACHE_ENTRY_ID, tmdbMatchKind)
  const matchedTmdbId = normalizeTmdbId(tmdbMatch?.data?.tmdbId)
  if (matchedTmdbId != null) {
    const detailKind = enrichedDetailCacheKind(kind, matchedTmdbId, language)
    await hydrate(CACHE_ENTRY_ID, detailKind)
    const detail = getCached(CACHE_ENTRY_ID, detailKind)
    if (detail && !detail.stale) {
      return { enrichment: detail.data as TmdbTitleEnrichment, tmdbId: matchedTmdbId, tvdbId: null }
    }
  }

  const matchKind = tvdbMatchCacheKind(kind, playlistId, itemId, language)
  await hydrate(CACHE_ENTRY_ID, matchKind)
  const match = getCached(CACHE_ENTRY_ID, matchKind)
  const tvdbId = normalizeTmdbId(match?.data?.tvdbId)
  if (tvdbId == null) return null

  const detailKind = tvdbOnlyDetailCacheKind(kind, tvdbId, language)
  await hydrate(CACHE_ENTRY_ID, detailKind)
  const detail = getCached(CACHE_ENTRY_ID, detailKind)
  return detail && !detail.stale ? { enrichment: detail.data as TmdbTitleEnrichment, tmdbId: null, tvdbId } : null
}

/** Cache-only peek: today's tmdbId-keyed cache, then the tvdb-only namespace. */
export async function peekTitleEnrichment(
  kind: EnrichmentKind,
  playlistId: string,
  itemId: string
): Promise<TmdbTitleEnrichment | null> {
  const details = await peekTitleEnrichmentDetailed(kind, playlistId, itemId)
  return details?.enrichment ?? null
}

// ---------------------------------------------------------------------------
// Combined early-paint probe: enrichment (both namespaces) + provider info,
// bounded so a cold IndexedDB read can't delay first paint.
// ---------------------------------------------------------------------------
const EARLY_PROBE_TIMEOUT_MS = 150

function withEarlyProbeTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), EARLY_PROBE_TIMEOUT_MS)),
  ])
}

async function peekCachedProviderInfo<T>(entryId: string, kind: string): Promise<CachedProviderInfo<T> | null> {
  await hydrate(entryId, kind)
  const hit = getCached(entryId, kind)
  return hit ? { data: hit.data as T, stale: hit.stale } : null
}

export interface EarlyTitleEnrichmentProbe<T> {
  enrichment: TmdbTitleEnrichment | null
  tmdbId: number | null
  tvdbId: number | null
  providerInfo: CachedProviderInfo<T> | null
}

export async function peekEarlyTitleEnrichment<T>(
  kind: EnrichmentKind,
  playlistId: string,
  itemId: string,
  providerEntryId: string,
  providerCacheKind: string
): Promise<EarlyTitleEnrichmentProbe<T>> {
  const combined = Promise.all([
    peekTitleEnrichmentDetailed(kind, playlistId, itemId),
    peekCachedProviderInfo<T>(providerEntryId, providerCacheKind),
  ])
  const [details, providerInfo] = await withEarlyProbeTimeout(combined, [null, null] as const)
  return {
    enrichment: details?.enrichment ?? null,
    tmdbId: details?.tmdbId ?? null,
    tvdbId: details?.tvdbId ?? null,
    providerInfo,
  }
}
