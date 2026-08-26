// Pure TheTVDB -> wire-contract mapping; runs on the Worker, not in the app.
import { normalizeSearchName } from "@/scripts/lib/tvdb-params"
import type {
  TvdbCastMember,
  TvdbEpisode,
  TvdbKind,
  TvdbSeason,
  TvdbSeasonOrder,
  TvdbTitle,
} from "@/scripts/lib/tvdb-contract"

// Loose mirrors of the upstream schemas - the spec marks almost nothing required.
export interface TvdbRawStatus {
  name?: string | null
}

export interface TvdbRawCharacter {
  name?: string | null
  personName?: string | null
  personImgURL?: string | null
  image?: string | null
  type?: number | null
  sort?: number | null
}

export interface TvdbRawTrailer {
  url?: string | null
  language?: string | null
}

export interface TvdbRawSeriesRecord {
  id?: number | null
  name?: string | null
  overview?: string | null
  image?: string | null
  year?: string | number | null
  firstAired?: string | null
  score?: number | null
  status?: TvdbRawStatus | null
  genres?: Array<{ name?: string | null }> | null
  characters?: TvdbRawCharacter[] | null
  artworks?: Array<{ image?: string | null; type?: number | null; score?: number | null }> | null
  trailers?: TvdbRawTrailer[] | null
  remoteIds?: Array<{ id?: string | number | null; sourceName?: string | null }> | null
}

export interface TvdbRawEpisode {
  number?: number | null
  seasonNumber?: number | null
  name?: string | null
  overview?: string | null
  image?: string | null
  aired?: string | null
}

// Per /artwork/types: 1/16 are Banners and 3/15 Backgrounds, so match per kind.
const ARTWORK_TYPES = {
  series: { poster: 2, background: 3 },
  movie: { poster: 14, background: 15 },
} as const

const ARTWORK_HOST = "https://artworks.thetvdb.com"

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Absolute on series and movie records, but relative on episodes. */
function imageUrl(value: unknown): string | null {
  const raw = cleanText(value)
  if (/^https:\/\//i.test(raw)) return raw
  return /^\/[^/]/.test(raw) ? `${ARTWORK_HOST}${raw}` : null
}

function parseYear(record: TvdbRawSeriesRecord): number | null {
  const fromYear = Number(record.year)
  if (Number.isInteger(fromYear) && fromYear > 1800 && fromYear < 2200) return fromYear
  const match = cleanText(record.firstAired).match(/^(\d{4})/)
  return match ? Number(match[1]) : null
}

function normalizeStatus(status: TvdbRawStatus | null | undefined): TvdbTitle["status"] {
  const name = cleanText(status?.name).toLowerCase()
  if (name === "ended" || name === "completed") return "ended"
  if (name.startsWith("continu") || name === "upcoming") return "continuing"
  return "unknown"
}

function pickArtwork(
  artworks: TvdbRawSeriesRecord["artworks"],
  artworkType: number
): string | null {
  const candidates = (artworks || [])
    .filter((artwork) => Number(artwork?.type) === artworkType)
    .filter((artwork) => imageUrl(artwork?.image))
    .sort((first, second) => Number(second?.score ?? 0) - Number(first?.score ?? 0))
  return candidates.length > 0 ? imageUrl(candidates[0].image) : null
}

export function youtubeKeyFromTvdbTrailer(url: unknown): string | null {
  const raw = cleanText(url)
  if (!raw) return null
  const match = raw.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/)
  return match ? match[1] : null
}

function pickTrailerKey(trailers: TvdbRawTrailer[] | null | undefined, language: string): string | null {
  const usable = (trailers || []).filter((trailer) => youtubeKeyFromTvdbTrailer(trailer?.url))
  if (usable.length === 0) return null
  const preferred =
    usable.find((trailer) => cleanText(trailer.language) === language) ??
    usable.find((trailer) => cleanText(trailer.language) === "eng") ??
    usable[0]
  return youtubeKeyFromTvdbTrailer(preferred.url)
}

// Character type 3 is the acting role; anything else is crew and not cast.
const ACTOR_CHARACTER_TYPE = 3
const MAX_CAST = 20

function normalizeCast(characters: TvdbRawCharacter[] | null | undefined): TvdbCastMember[] {
  return (characters || [])
    .filter((character) => character?.type == null || Number(character.type) === ACTOR_CHARACTER_TYPE)
    .map((character) => ({
      name: cleanText(character?.personName),
      character: cleanText(character?.name),
      profileUrl: imageUrl(character?.personImgURL ?? character?.image),
      sort: Number(character?.sort ?? Number.MAX_SAFE_INTEGER),
    }))
    .filter((member) => member.name !== "")
    .sort((first, second) => first.sort - second.sort)
    .slice(0, MAX_CAST)
    .map(({ name, character, profileUrl }) => ({ name, character, profileUrl }))
}

export function normalizeTitle(
  record: TvdbRawSeriesRecord | null | undefined,
  language: string,
  kind: TvdbKind
): TvdbTitle | null {
  const tvdbId = Number(record?.id)
  if (!record || !Number.isInteger(tvdbId) || tvdbId <= 0) return null
  const types = ARTWORK_TYPES[kind]
  return {
    tvdbId,
    title: cleanText(record.name),
    overview: cleanText(record.overview),
    posterUrl: pickArtwork(record.artworks, types.poster) ?? imageUrl(record.image),
    backdropUrl: pickArtwork(record.artworks, types.background),
    cast: normalizeCast(record.characters),
    genres: (record.genres || []).map((genre) => cleanText(genre?.name)).filter((name) => name !== ""),
    year: parseYear(record),
    status: normalizeStatus(record.status),
    trailerYoutubeKey: pickTrailerKey(record.trailers, language),
  }
}

/** One flat list per order, so filtering by seasonNumber is what makes a season. */
export function normalizeSeason(
  episodes: TvdbRawEpisode[] | null | undefined,
  seasonNumber: number,
  order: TvdbSeasonOrder
): TvdbSeason {
  const normalized: TvdbEpisode[] = (episodes || [])
    .filter((episode) => Number(episode?.seasonNumber) === seasonNumber)
    .map((episode) => ({
      episodeNumber: Number(episode?.number),
      name: cleanText(episode?.name),
      overview: cleanText(episode?.overview),
      stillUrl: imageUrl(episode?.image),
      airedAt: cleanText(episode?.aired) || null,
    }))
    .filter((episode) => Number.isInteger(episode.episodeNumber) && episode.episodeNumber > 0)
    .sort((first, second) => first.episodeNumber - second.episodeNumber)
  return { seasonNumber, order, episodes: normalized }
}

export interface TvdbRawTranslation {
  name?: string | null
  overview?: string | null
}

/** Overlays only the fields the translation actually carries. */
export function applyTvdbTranslation(
  title: TvdbTitle,
  translation: TvdbRawTranslation | null | undefined
): TvdbTitle {
  const name = cleanText(translation?.name)
  const overview = cleanText(translation?.overview)
  if (!name && !overview) return title
  return { ...title, title: name || title.title, overview: overview || title.overview }
}

export interface TvdbRawSearchResult {
  tvdb_id?: string | number | null
  id?: string | number | null
  type?: string | null
  year?: string | number | null
  name?: string | null
  translations?: Record<string, string> | null
  aliases?: string[] | null
}

/** Anime records carry an original-language name, so translations and aliases count too. */
function searchResultTitles(result: TvdbRawSearchResult): string[] {
  return [
    cleanText(result?.name),
    ...Object.values(result?.translations || {}).map((value) => cleanText(value)),
    ...(result?.aliases || []).map((value) => cleanText(value)),
  ].filter((value) => value !== "")
}

function titleMatchesQuery(result: TvdbRawSearchResult, normalizedQuery: string): boolean {
  for (const candidate of searchResultTitles(result)) {
    const normalized = normalizeSearchName(candidate)
    if (!normalized) continue
    if (normalized === normalizedQuery) return true
    // Covers subtitle drift ("Re Zero" vs "Re Zero Starting Life") while refusing
    // an incidental overlap: "the off" must not match "the office reunion".
    const [shorter, longer] =
      normalized.length < normalizedQuery.length
        ? [normalized, normalizedQuery]
        : [normalizedQuery, normalized]
    if (shorter.length >= 6 && ` ${longer} `.includes(` ${shorter} `)) return true
  }
  return false
}

/**
 * Search returns ids as `series-305089` strings and mixes entity types in one
 * list. Upstream matching is fuzzy, so a title check is required: without it an
 * uncleanable provider name silently adopts an unrelated work's artwork.
 */
export function pickSearchMatch(
  results: TvdbRawSearchResult[] | null | undefined,
  kind: TvdbKind,
  year: number | null,
  query?: string | null
): number | null {
  const normalizedQuery = normalizeSearchName(query ?? null)
  const candidates = (results || [])
    .filter((result) => result?.type == null || cleanText(result.type) === kind)
    .filter((result) => !normalizedQuery || titleMatchesQuery(result, normalizedQuery))
  const byYear =
    year == null
      ? candidates
      : candidates.filter((result) => Number(result?.year) === year)
  for (const result of byYear.length > 0 ? byYear : candidates) {
    const raw = String(result?.tvdb_id ?? result?.id ?? "").trim().replace(/^\D+-?/, "")
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return null
}

/**
 * A bare integer matches every numeric remote-id source TheTVDB indexes, so the
 * wrapper can carry records that have nothing to do with the requested TMDb id.
 * Callers must confirm a candidate with recordCarriesTmdbId before trusting it.
 */
export function pickRemoteIdMatches(
  results: Array<Record<string, unknown>> | null | undefined,
  kind: TvdbKind
): TvdbRawSeriesRecord[] {
  const matches: TvdbRawSeriesRecord[] = []
  for (const result of results || []) {
    const record = result?.[kind]
    if (record && typeof record === "object") matches.push(record as TvdbRawSeriesRecord)
  }
  return matches
}

/** Only extended records list their sources, which is why this runs after that fetch. */
export function recordCarriesTmdbId(
  record: TvdbRawSeriesRecord | null | undefined,
  tmdbId: number
): boolean {
  return (record?.remoteIds || []).some(
    (remote) =>
      cleanText(remote?.sourceName).toLowerCase().includes("themoviedb") &&
      String(remote?.id ?? "").trim() === String(tmdbId)
  )
}
