// Client for the TheTVDB proxy Worker; needs no user API key.
import { cachedFetch } from "@/scripts/lib/cache.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { getTvdbEnabled } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"
import { hashName, normalizeSearchName, tvdbLanguageFor } from "@/scripts/lib/tvdb-params"
import type { TmdbTitleEnrichment } from "@/scripts/lib/tmdb-enrich"
import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"
import {
  TVDB_CONTRACT_VERSION,
  type TvdbKind,
  type TvdbSeason,
  type TvdbSeasonOrder,
  type TvdbTitle,
  type TvdbTrendingEntry,
} from "@/scripts/lib/tvdb-contract"

const PROXY_BASE = "https://xt-tvdb-proxy.infinitel8p.com"
const CACHE_ENTRY_ID = "tvdb"
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const TRENDING_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000
// Bounds a single 429 retry: a longer reset isn't worth stalling the page for.
const MAX_RETRY_WAIT_MS = 3_000

/** The provider's own id, so a lookup needs no TMDb key. */
export function parseProviderTmdbId(record: unknown): number | null {
  if (!record || typeof record !== "object") return null
  const source = record as Record<string, unknown>
  const raw = source.tmdb ?? source.tmdb_id
  const parsed = Number(String(raw ?? "").trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** Shaped like TMDb enrichment, so the detail pages need no second render path. */
export function tvdbTitleToEnrichment(title: TvdbTitle, tmdbId: number): TmdbTitleEnrichment {
  return {
    tmdbId,
    title: title.title,
    overview: title.overview,
    posterUrl: title.posterUrl,
    backdropUrl: title.backdropUrl,
    // ?? tolerates an envelope from a worker deploy that predates logoUrl/bannerUrl.
    logoUrl: title.logoUrl ?? null,
    bannerUrl: title.bannerUrl ?? null,
    director: null,
    directorPersonId: null,
    // No TMDb person id, so the card renders non-interactive.
    cast: title.cast.map((member) => ({
      name: member.name,
      character: member.character,
      profilePath: member.profileUrl,
      tmdbPersonId: 0,
    })),
    trailerYoutubeKey: title.trailerYoutubeKey,
    recommendations: [],
    // TheTVDB exposes popularity, not a 0-10 rating, so it contributes none.
    voteAverage: 0,
    genres: title.genres,
    tagline: null,
    year: title.year,
  }
}

/**
 * Only core gaps trigger a call. Trailer, backdrop and genres are commonly absent
 * on TMDb, so including them would put a network round trip on nearly every open.
 */
export function enrichmentNeedsFill(enrichment: TmdbTitleEnrichment | null): boolean {
  if (!enrichment) return true
  return (
    !enrichment.posterUrl ||
    !enrichment.overview ||
    enrichment.overviewIsFallback === true ||
    enrichment.cast.length === 0
  )
}

// TVDB cast entries are all stamped tmdbPersonId 0, so a real id means TMDb-sourced.
function hasTmdbCastIds(enrichment: TmdbTitleEnrichment): boolean {
  return enrichment.cast.some((member) => member.tmdbPersonId > 0)
}

/** Per-field fill; the side with real TMDb cast ids wins cast and genres (localized). */
export function mergeTitleEnrichment(
  primary: TmdbTitleEnrichment | null,
  fallback: TmdbTitleEnrichment | null
): TmdbTitleEnrichment | null {
  if (!primary) return fallback
  if (!fallback) return primary
  // A TMDb overview flagged as fallback is untranslated, so a localized one wins.
  const preferFallbackOverview =
    (!primary.overview || primary.overviewIsFallback === true) && Boolean(fallback.overview)
  const cast = hasTmdbCastIds(primary)
    ? primary.cast
    : hasTmdbCastIds(fallback)
      ? fallback.cast
      : primary.cast.length > 0
        ? primary.cast
        : fallback.cast
  const genres =
    hasTmdbCastIds(fallback) && fallback.genres.length > 0
      ? fallback.genres
      : primary.genres.length > 0
        ? primary.genres
        : fallback.genres
  return {
    ...primary,
    posterUrl: primary.posterUrl || fallback.posterUrl,
    backdropUrl: primary.backdropUrl || fallback.backdropUrl,
    logoUrl: primary.logoUrl || fallback.logoUrl,
    bannerUrl: primary.bannerUrl || fallback.bannerUrl,
    overview: preferFallbackOverview ? fallback.overview : primary.overview,
    overviewIsFallback: preferFallbackOverview ? false : primary.overviewIsFallback,
    director: primary.director || fallback.director,
    directorPersonId: primary.director ? primary.directorPersonId : fallback.directorPersonId,
    cast,
    recommendations: primary.recommendations.length > 0 ? primary.recommendations : fallback.recommendations,
    genres,
    tagline: primary.tagline || fallback.tagline,
    year: primary.year ?? fallback.year,
    voteAverage: primary.voteAverage > 0 ? primary.voteAverage : fallback.voteAverage,
    trailerYoutubeKey: primary.trailerYoutubeKey || fallback.trailerYoutubeKey,
  }
}

/** `failed` keeps a transient error from being read as "no such title". */
type ProxyResult<T> = { ok: true; data: T | null } | { ok: false; data: null }

const FAILED: ProxyResult<never> = { ok: false, data: null }

function fetchOnce(path: string): Promise<Response> {
  return providerFetch(`${PROXY_BASE}${path}`, {
    logKind: "api",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    dns: "global",
  })
}

// Session-only: a confirmed 429 backs off every further proxy call for a bit,
// and a failed path gets a short memo so a burst of callers (e.g. ambient)
// doesn't keep re-hitting an endpoint that just failed.
let rateLimitedUntilMs = 0
const FAILED_PATH_MEMO_MS = 30_000
const failedPathUntilMs = new Map<string, number>()

function markRateLimited(waitMs: number): void {
  rateLimitedUntilMs = Math.max(rateLimitedUntilMs, Date.now() + waitMs)
}

/** Test-only: clears the module-level rate-limit and failure memo between cases. */
export function resetTvdbProxyRateLimitForTests(): void {
  rateLimitedUntilMs = 0
  failedPathUntilMs.clear()
}

async function fetchWithRetry(path: string): Promise<Response> {
  const response = await fetchOnce(path)
  if (response.status !== 429) return response
  const retryAfterSeconds = Number(response.headers.get("Retry-After"))
  const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 1000
  if (waitMs > MAX_RETRY_WAIT_MS) {
    markRateLimited(waitMs)
    return response
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  const retried = await fetchOnce(path)
  if (retried.status === 429) markRateLimited(waitMs)
  return retried
}

async function fetchEnvelope<T>(
  path: string,
  cacheKind: string,
  ttlMs: number = TTL_MS
): Promise<ProxyResult<T>> {
  if (!getTvdbEnabled()) return FAILED
  try {
    const result = await cachedFetch(CACHE_ENTRY_ID, cacheKind, ttlMs, async () => {
      const now = Date.now()
      if (now < rateLimitedUntilMs) throw new Error("tvdb proxy rate limited, cooling down")
      const failedUntil = failedPathUntilMs.get(path)
      if (failedUntil && now < failedUntil) throw new Error("tvdb proxy path recently failed")
      const response = await fetchWithRetry(path)
      if (!response.ok) {
        failedPathUntilMs.set(path, Date.now() + FAILED_PATH_MEMO_MS)
        throw new Error(`tvdb proxy ${response.status}`)
      }
      const envelope = await response.json()
      if (envelope?.v !== TVDB_CONTRACT_VERSION) {
        failedPathUntilMs.set(path, Date.now() + FAILED_PATH_MEMO_MS)
        throw new Error("tvdb contract mismatch")
      }
      failedPathUntilMs.delete(path)
      // A null payload is a real answer, so it caches too.
      return { data: (envelope.data ?? null) as T | null }
    })
    return { ok: true, data: result.data.data }
  } catch (error) {
    log.warn("[xt:tvdb] proxy fetch failed:", path, error)
    return FAILED
  }
}

export async function fetchTvdbTitle(tmdbId: number, kind: TvdbKind): Promise<TvdbTitle | null> {
  const language = tvdbLanguageFor(getActiveLocale())
  const result = await fetchEnvelope<TvdbTitle>(
    `/v1/title?tmdb=${tmdbId}&kind=${kind}&lang=${language}`,
    `tvdb_title_${kind}_${tmdbId}:${language}`
  )
  return result.data
}

/** Keyless-fallback trending pool, intersected with the library by ambient-trending.ts. */
export async function fetchTvdbTrending(kind: TvdbKind): Promise<TvdbTrendingEntry[]> {
  const language = tvdbLanguageFor(getActiveLocale())
  const result = await fetchEnvelope<TvdbTrendingEntry[]>(
    `/v1/trending?kind=${kind}&lang=${language}`,
    `tvdb_trending_${kind}:${language}`,
    TRENDING_TTL_MS
  )
  return result.data ?? []
}

/** For entries the provider ships no tmdb id for. */
export async function findTvdbTitle(
  name: string,
  kind: TvdbKind,
  year?: number | null
): Promise<TvdbTitle | null> {
  // Provider names carry prefixes and tags ("DE - ... (2016) (JP)") that wreck a search.
  // Same 3-variant fallback the TMDb matcher uses (tmdb-enrich.ts resolveTmdbIdUncached).
  const { variants, year: titleYear } = cleanProviderTitle(name)
  const effectiveYear = Number.isInteger(year) && year ? year : titleYear
  const language = tvdbLanguageFor(getActiveLocale())
  const yearParam = effectiveYear ? `&year=${effectiveYear}` : ""

  for (const query of variants.slice(0, 3)) {
    const normalized = normalizeSearchName(query)
    if (!normalized) continue
    const result = await fetchEnvelope<TvdbTitle>(
      `/v1/find?name=${encodeURIComponent(query)}&kind=${kind}${yearParam}&lang=${language}`,
      `tvdb_find_${kind}_${hashName(normalized)}_${effectiveYear ?? "any"}:${language}`
    )
    if (result.data) return result.data
  }
  return null
}

export interface TvdbEnrichmentResult {
  enrichment: TmdbTitleEnrichment
  /** Lets a name-matched title still resolve seasons, which have no tmdb id to key on. */
  tvdbId: number
}

export async function tvdbEnrichment(
  tmdbId: number | null,
  kind: TvdbKind,
  fallback?: { name: string; year?: number | null }
): Promise<TvdbEnrichmentResult | null> {
  const language = tvdbLanguageFor(getActiveLocale())
  let title: TvdbTitle | null = null

  if (tmdbId) {
    const byId = await fetchEnvelope<TvdbTitle>(
      `/v1/title?tmdb=${tmdbId}&kind=${kind}&lang=${language}`,
      `tvdb_title_${kind}_${tmdbId}:${language}`
    )
    // Only a definitive "no such title" justifies a name search; a failed request
    // must not, or a blip can stamp another work's artwork onto this one.
    if (!byId.ok) return null
    title = byId.data
  }

  if (!title && fallback) {
    title = await findTvdbTitle(fallback.name, kind, fallback.year)
  }
  if (!title) return null
  return { enrichment: tvdbTitleToEnrichment(title, tmdbId ?? 0), tvdbId: title.tvdbId }
}

export interface TvdbSeasonRef {
  tmdbId?: number | null
  tvdbId?: number | null
}

export async function fetchTvdbSeason(
  ref: TvdbSeasonRef,
  seasonNumber: number,
  order: TvdbSeasonOrder = "official"
): Promise<TvdbSeason | null> {
  // Exactly one id: the Worker rejects a request carrying both or neither.
  const seriesParam = ref.tvdbId ? `tvdb=${ref.tvdbId}` : ref.tmdbId ? `tmdb=${ref.tmdbId}` : null
  if (!seriesParam) return null
  const language = tvdbLanguageFor(getActiveLocale())
  const result = await fetchEnvelope<TvdbSeason>(
    `/v1/season?${seriesParam}&season=${seasonNumber}&order=${order}&lang=${language}`,
    `tvdb_season_${seriesParam}_${seasonNumber}_${order}:${language}`
  )
  return result.data
}
