// Impure TMDb orchestrator: resolves provider entries to TMDb ids and fetches
// enrichment through cache.js. cachedFetch never persists a thrown fetcher
// error, so a transient HTTP/network failure here simply isn't cached -
// only a genuine "no match"/valid result gets written.
import { cachedFetch, hydrate, getCached } from "@/scripts/lib/cache.js"
import { getTmdbApiKey, isTmdbActive } from "@/scripts/lib/app-settings.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import {
  TmdbHttpError,
  tmdbLanguageFor,
  tmdbImageUrl,
  tmdbMovieBundle,
  tmdbTvBundle,
  tmdbTvSeason,
  tmdbSearchMovie,
  tmdbSearchTv,
  tmdbPersonCredits,
  extractTrailerYoutubeKey,
  extractDirectorEntry,
  extractCast,
  TMDB_POSTER_SIZE,
  TMDB_BACKDROP_SIZE,
  TMDB_PROFILE_SIZE,
  TMDB_STILL_SIZE,
  type TmdbBundle,
  type TmdbSearchResult,
  type TmdbPersonCreditItem,
} from "@/scripts/lib/tmdb.ts"
import { cleanProviderTitle, pickTmdbMatch } from "@/scripts/lib/tmdb-match.ts"

const TMDB_MATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TMDB_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000
// TMDb data is playlist-independent, so every playlist shares one cache namespace.
const TMDB_CACHE_ENTRY_ID = "tmdb"

export type TmdbKind = "vod" | "series"

export interface ProviderEntry {
  id: string | number
  name: string
  year?: number | string | null
  providerTmdbId?: number | string | null
}

function mediaTypeFor(kind: TmdbKind): "movie" | "tv" {
  return kind === "series" ? "tv" : "movie"
}

function parseYearField(yearField?: number | string | null): number | null {
  if (yearField == null) return null
  if (typeof yearField === "number") return Number.isFinite(yearField) ? yearField : null
  const match = String(yearField).match(/(\d{4})/)
  return match ? Number(match[1]) : null
}

async function searchAndPick(
  apiKey: string,
  mediaType: "movie" | "tv",
  query: string,
  year: number | null,
  language: string
) {
  const results: TmdbSearchResult[] =
    mediaType === "movie"
      ? await tmdbSearchMovie(apiKey, query, { year, language })
      : await tmdbSearchTv(apiKey, query, { year, language })
  return pickTmdbMatch(results, { variants: [query], year, mediaType })
}

async function resolveTmdbIdUncached(
  apiKey: string,
  kind: TmdbKind,
  providerEntry: ProviderEntry,
  language: string
): Promise<{ tmdbId: number | null }> {
  const mediaType = mediaTypeFor(kind)
  const providerTmdbId = Number(providerEntry.providerTmdbId)

  if (Number.isFinite(providerTmdbId) && providerTmdbId > 0) {
    try {
      if (mediaType === "movie") await tmdbMovieBundle(apiKey, providerTmdbId, language)
      else await tmdbTvBundle(apiKey, providerTmdbId, language)
      return { tmdbId: providerTmdbId }
    } catch (error) {
      if (!(error instanceof TmdbHttpError) || error.status !== 404) throw error
    }
  }

  const { variants, year: nameYear } = cleanProviderTitle(providerEntry.name)
  const year = nameYear ?? parseYearField(providerEntry.year)

  const [firstVariant, secondVariant, thirdVariant] = variants
  if (!firstVariant) return { tmdbId: null }

  const firstMatch = await searchAndPick(apiKey, mediaType, firstVariant, year, language)
  if (firstMatch) return { tmdbId: firstMatch.id }

  if (secondVariant && secondVariant !== firstVariant) {
    const secondMatch = await searchAndPick(apiKey, mediaType, secondVariant, year, language)
    if (secondMatch) return { tmdbId: secondMatch.id }
  }

  if (thirdVariant && thirdVariant !== firstVariant && thirdVariant !== secondVariant) {
    const thirdMatch = await searchAndPick(apiKey, mediaType, thirdVariant, year, language)
    if (thirdMatch) return { tmdbId: thirdMatch.id }
  }

  return { tmdbId: null }
}

export async function resolveTmdbId(
  playlistId: string,
  kind: TmdbKind,
  providerEntry: ProviderEntry
): Promise<number | null> {
  if (!isTmdbActive()) return null
  const apiKey = getTmdbApiKey()
  const language = tmdbLanguageFor(getActiveLocale())
  const cacheKind = `tmdb_match_${kind}_${playlistId}_${providerEntry.id}:${language}`
  try {
    const result = await cachedFetch(TMDB_CACHE_ENTRY_ID, cacheKind, TMDB_MATCH_TTL_MS, () =>
      resolveTmdbIdUncached(apiKey, kind, providerEntry, language)
    )
    return result.data.tmdbId
  } catch (error) {
    log.warn("[xt:tmdb] resolveTmdbId failed:", providerEntry.id, error)
    return null
  }
}

export interface TmdbCastMemberOut {
  name: string
  character: string
  profilePath: string | null
  tmdbPersonId: number
}

export interface TmdbRecommendationOut {
  tmdbId: number
  title: string
  year: number | null
}

export interface TmdbTitleEnrichment {
  tmdbId: number
  title: string
  overview: string
  posterUrl: string | null
  backdropUrl: string | null
  director: string | null
  directorPersonId: number | null
  cast: TmdbCastMemberOut[]
  trailerYoutubeKey: string | null
  recommendations: TmdbRecommendationOut[]
  voteAverage: number
  genres: string[]
  tagline: string | null
  year: number | null
}

const YEAR_MIN = 1900
const YEAR_MAX = 2099

function extractYearFromDate(dateField?: string | null): number | null {
  if (!dateField) return null
  const match = dateField.match(/^(\d{4})/)
  if (!match) return null
  const year = Number(match[1])
  return year >= YEAR_MIN && year <= YEAR_MAX ? year : null
}

// TMDb movie/tv detail responses always include tagline/release dates; TmdbBundle doesn't declare them.
type TmdbBundleWithTagline = TmdbBundle & {
  tagline?: string | null
  release_date?: string | null
  first_air_date?: string | null
}

function mapBundleToEnrichment(
  bundle: TmdbBundleWithTagline,
  tmdbId: number,
  mediaType: "movie" | "tv"
): TmdbTitleEnrichment {
  const recommendations = (bundle.recommendations?.results || []).slice(0, 12).map((item) => ({
    tmdbId: item.id,
    title:
      mediaType === "movie"
        ? item.title || item.original_title || ""
        : item.name || item.original_name || "",
    year: extractYearFromDate(mediaType === "movie" ? item.release_date : item.first_air_date),
  }))

  const directorEntry = extractDirectorEntry(bundle.credits)

  return {
    tmdbId,
    title: (mediaType === "movie" ? bundle.title : bundle.name) || "",
    overview: bundle.overview || "",
    posterUrl: tmdbImageUrl(bundle.poster_path, TMDB_POSTER_SIZE),
    backdropUrl: tmdbImageUrl(bundle.backdrop_path, TMDB_BACKDROP_SIZE),
    director: directorEntry?.name ?? null,
    directorPersonId: directorEntry?.tmdbPersonId ?? null,
    cast: extractCast(bundle.credits).map((member) => ({
      ...member,
      profilePath: tmdbImageUrl(member.profilePath, TMDB_PROFILE_SIZE),
    })),
    trailerYoutubeKey: extractTrailerYoutubeKey(bundle.videos),
    recommendations,
    voteAverage: bundle.vote_average || 0,
    genres: (bundle.genres || []).map((genre) => genre.name),
    tagline: bundle.tagline || null,
    year: extractYearFromDate(mediaType === "movie" ? bundle.release_date : bundle.first_air_date),
  }
}

const ENGLISH_FALLBACK_LANGUAGE = "en-US"

// Best-effort: a failed or empty fallback just leaves the primary-language text as-is.
async function fillEnglishTextFallback(
  apiKey: string,
  mediaType: "movie" | "tv",
  tmdbId: number,
  language: string,
  enrichment: TmdbTitleEnrichment
): Promise<TmdbTitleEnrichment> {
  if (language === ENGLISH_FALLBACK_LANGUAGE) return enrichment
  // Tagline alone is decorative and often absent on TMDb; only a missing overview justifies the fetch.
  if (enrichment.overview) return enrichment
  try {
    const bundle: TmdbBundleWithTagline =
      mediaType === "movie"
        ? await tmdbMovieBundle(apiKey, tmdbId, ENGLISH_FALLBACK_LANGUAGE)
        : await tmdbTvBundle(apiKey, tmdbId, ENGLISH_FALLBACK_LANGUAGE)
    return {
      ...enrichment,
      overview: enrichment.overview || bundle.overview || "",
      tagline: enrichment.tagline || bundle.tagline || null,
    }
  } catch (error) {
    log.warn("[xt:tmdb] en-US text fallback failed:", mediaType, tmdbId, error)
    return enrichment
  }
}

export async function fetchMovieEnrichment(tmdbId: number): Promise<TmdbTitleEnrichment | null> {
  if (!isTmdbActive()) return null
  const apiKey = getTmdbApiKey()
  const language = tmdbLanguageFor(getActiveLocale())
  const cacheKind = `tmdb_movie_${tmdbId}:${language}`
  try {
    const result = await cachedFetch(TMDB_CACHE_ENTRY_ID, cacheKind, TMDB_DETAIL_TTL_MS, async () => {
      const bundle = await tmdbMovieBundle(apiKey, tmdbId, language)
      const enrichment = mapBundleToEnrichment(bundle, tmdbId, "movie")
      return fillEnglishTextFallback(apiKey, "movie", tmdbId, language, enrichment)
    })
    return result.data
  } catch (error) {
    log.warn("[xt:tmdb] fetchMovieEnrichment failed:", tmdbId, error)
    return null
  }
}

export async function fetchSeriesEnrichment(tmdbId: number): Promise<TmdbTitleEnrichment | null> {
  if (!isTmdbActive()) return null
  const apiKey = getTmdbApiKey()
  const language = tmdbLanguageFor(getActiveLocale())
  const cacheKind = `tmdb_series_${tmdbId}:${language}`
  try {
    const result = await cachedFetch(TMDB_CACHE_ENTRY_ID, cacheKind, TMDB_DETAIL_TTL_MS, async () => {
      const bundle = await tmdbTvBundle(apiKey, tmdbId, language)
      const enrichment = mapBundleToEnrichment(bundle, tmdbId, "tv")
      return fillEnglishTextFallback(apiKey, "tv", tmdbId, language, enrichment)
    })
    return result.data
  } catch (error) {
    log.warn("[xt:tmdb] fetchSeriesEnrichment failed:", tmdbId, error)
    return null
  }
}

export interface TmdbSeasonEpisodeOut {
  episodeNumber: number
  name: string
  overview: string
  stillUrl: string | null
}

export interface TmdbSeasonEnrichment {
  episodes: TmdbSeasonEpisodeOut[]
}

// Best-effort: a failed fallback fetch just leaves episodes missing primary-language text.
async function fillEnglishSeasonFallback(
  apiKey: string,
  tmdbId: number,
  seasonNumber: number,
  language: string,
  episodes: TmdbSeasonEpisodeOut[]
): Promise<TmdbSeasonEpisodeOut[]> {
  if (language === ENGLISH_FALLBACK_LANGUAGE) return episodes
  if (!episodes.some((episode) => !episode.name || !episode.overview)) return episodes
  try {
    const season = await tmdbTvSeason(apiKey, tmdbId, seasonNumber, ENGLISH_FALLBACK_LANGUAGE)
    const fallbackByNumber = new Map((season.episodes || []).map((episode) => [episode.episode_number, episode]))
    return episodes.map((episode) => {
      const fallback = fallbackByNumber.get(episode.episodeNumber)
      if (!fallback) return episode
      return {
        ...episode,
        name: episode.name || fallback.name || "",
        overview: episode.overview || fallback.overview || "",
      }
    })
  } catch (error) {
    log.warn("[xt:tmdb] en-US season fallback failed:", tmdbId, seasonNumber, error)
    return episodes
  }
}

export async function fetchSeasonEnrichment(
  tmdbId: number,
  seasonNumber: number
): Promise<TmdbSeasonEnrichment | null> {
  if (!isTmdbActive()) return null
  const apiKey = getTmdbApiKey()
  const language = tmdbLanguageFor(getActiveLocale())
  const cacheKind = `tmdb_season_${tmdbId}_${seasonNumber}:${language}`
  try {
    const result = await cachedFetch(TMDB_CACHE_ENTRY_ID, cacheKind, TMDB_DETAIL_TTL_MS, async () => {
      const season = await tmdbTvSeason(apiKey, tmdbId, seasonNumber, language)
      const episodes = (season.episodes || []).map((episode) => ({
        episodeNumber: episode.episode_number,
        name: episode.name || "",
        overview: episode.overview || "",
        stillUrl: tmdbImageUrl(episode.still_path, TMDB_STILL_SIZE),
      }))
      const filledEpisodes = await fillEnglishSeasonFallback(apiKey, tmdbId, seasonNumber, language, episodes)
      return { episodes: filledEpisodes }
    })
    return result.data
  } catch (error) {
    log.warn("[xt:tmdb] fetchSeasonEnrichment failed:", tmdbId, seasonNumber, error)
    return null
  }
}

export interface TmdbPersonTitleOut {
  tmdbId: number
  title: string
  year: number | null
}

/** Every movie/tv credit for a person, filtered to `kind`'s media type and deduped by tmdbId. */
export async function fetchPersonTitles(
  kind: TmdbKind,
  personId: number
): Promise<TmdbPersonTitleOut[]> {
  if (!isTmdbActive()) return []
  const apiKey = getTmdbApiKey()
  const language = tmdbLanguageFor(getActiveLocale())
  const cacheKind = `tmdb_person_${personId}_${kind}:${language}`
  try {
    const result = await cachedFetch(TMDB_CACHE_ENTRY_ID, cacheKind, TMDB_DETAIL_TTL_MS, async () => {
      const mediaType = mediaTypeFor(kind)
      const credits = await tmdbPersonCredits(apiKey, personId, language)
      const items: TmdbPersonCreditItem[] = [...(credits.cast || []), ...(credits.crew || [])].filter(
        (item) => item.media_type === mediaType
      )
      const byId = new Map<number, TmdbPersonTitleOut>()
      for (const item of items) {
        if (byId.has(item.id)) continue
        const title =
          mediaType === "movie" ? item.title || item.original_title || "" : item.name || item.original_name || ""
        if (!title) continue
        byId.set(item.id, {
          tmdbId: item.id,
          title,
          year: extractYearFromDate(mediaType === "movie" ? item.release_date : item.first_air_date),
        })
      }
      return [...byId.values()]
    })
    return result.data
  } catch (error) {
    log.warn("[xt:tmdb] fetchPersonTitles failed:", personId, kind, error)
    return []
  }
}

// ----------------------------
// Cache-only lookups for the pre-paint merge: hydrate + read IndexedDB without
// ever calling the network, bounded so a cold/blocked IDB can't delay first paint.
// ----------------------------
const CACHE_PROBE_TIMEOUT_MS = 150

function withProbeTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), CACHE_PROBE_TIMEOUT_MS)),
  ])
}

async function peekFreshCache<T>(cacheKind: string): Promise<T | null> {
  await hydrate(TMDB_CACHE_ENTRY_ID, cacheKind)
  const hit = getCached(TMDB_CACHE_ENTRY_ID, cacheKind)
  return hit && !hit.stale ? (hit.data as T) : null
}

export interface CachedTmdbEnrichment {
  tmdbId: number
  enrichment: TmdbTitleEnrichment
}

// Unbounded: callers combine this with other probes under one shared withProbeTimeout window.
async function peekCachedEnrichmentRaw(
  playlistId: string,
  kind: TmdbKind,
  mediaId: string | number
): Promise<CachedTmdbEnrichment | null> {
  if (!isTmdbActive()) return null
  const language = tmdbLanguageFor(getActiveLocale())
  const matchCacheKind = `tmdb_match_${kind}_${playlistId}_${mediaId}:${language}`
  const match = await peekFreshCache<{ tmdbId: number | null }>(matchCacheKind)
  if (!match?.tmdbId) return null
  const detailCacheKind =
    kind === "series" ? `tmdb_series_${match.tmdbId}:${language}` : `tmdb_movie_${match.tmdbId}:${language}`
  const enrichment = await peekFreshCache<TmdbTitleEnrichment>(detailCacheKind)
  return enrichment ? { tmdbId: match.tmdbId, enrichment } : null
}

/** Network-free: returns the cached season enrichment for tmdbId/seasonNumber, or null if missing/stale. */
export async function peekCachedSeasonEnrichment(
  tmdbId: number,
  seasonNumber: number
): Promise<TmdbSeasonEnrichment | null> {
  if (!isTmdbActive()) return null
  const language = tmdbLanguageFor(getActiveLocale())
  const cacheKind = `tmdb_season_${tmdbId}_${seasonNumber}:${language}`
  return withProbeTimeout(peekFreshCache<TmdbSeasonEnrichment>(cacheKind), null)
}

export interface CachedProviderInfo<T> {
  data: T
  stale: boolean
}

// Generic cache-only read (any entryId/kind), used for the provider info probe below.
async function peekCachedEntryRaw<T>(entryId: string, kind: string): Promise<CachedProviderInfo<T> | null> {
  await hydrate(entryId, kind)
  const hit = getCached(entryId, kind)
  return hit ? { data: hit.data as T, stale: hit.stale } : null
}

export interface EarlyDetailProbeResult<T> {
  enrichment: CachedTmdbEnrichment | null
  providerInfo: CachedProviderInfo<T> | null
}

/**
 * Network-free: probes the TMDb enrichment cache and the provider info cache
 * (any entryId/kind, e.g. vod_info_<id> or series_info_<id>) concurrently under
 * one shared bound, so boot() can decide what to merge into the first paint.
 */
export async function peekEarlyDetailData<T>(
  playlistId: string,
  kind: TmdbKind,
  mediaId: string | number,
  providerEntryId: string,
  providerCacheKind: string
): Promise<EarlyDetailProbeResult<T>> {
  const combined = Promise.all([
    peekCachedEnrichmentRaw(playlistId, kind, mediaId),
    peekCachedEntryRaw<T>(providerEntryId, providerCacheKind),
  ])
  const [enrichment, providerInfo] = await withProbeTimeout(combined, [null, null] as const)
  return { enrichment, providerInfo }
}
