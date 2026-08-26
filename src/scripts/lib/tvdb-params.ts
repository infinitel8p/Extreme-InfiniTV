// Pure proxy request validation: closed value sets bound cache-key cardinality.
import {
  isTvdbKind,
  isTvdbSeasonOrder,
  type TvdbKind,
  type TvdbSeasonOrder,
} from "@/scripts/lib/tvdb-contract"

const MAX_TMDB_ID = 100_000_000
const MAX_SEASON_NUMBER = 200
const MAX_NAME_LENGTH = 120
const MIN_YEAR = 1878
const MAX_YEAR = 2200

const DEFAULT_LANGUAGE = "eng"

// An unrecognised locale costs a translation, not a request.
const LANGUAGE_BY_LOCALE: Record<string, string> = {
  en: "eng",
  es: "spa",
  de: "deu",
  fr: "fra",
  "pt-BR": "por",
  it: "ita",
  ru: "rus",
  zh: "zho",
  ja: "jpn",
  tr: "tur",
  ar: "ara",
  ur: "urd",
  nl: "nld",
  hi: "hin",
  id: "ind",
  pl: "pol",
}

const ALLOWED_LANGUAGES = new Set(Object.values(LANGUAGE_BY_LOCALE))

export function tvdbLanguageFor(locale: string | null | undefined): string {
  if (!locale) return DEFAULT_LANGUAGE
  const exact = LANGUAGE_BY_LOCALE[locale]
  if (exact) return exact
  return LANGUAGE_BY_LOCALE[locale.split("-")[0]] || DEFAULT_LANGUAGE
}

function parseBoundedInt(raw: string | null, min: number, max: number): number | null {
  if (raw == null || !/^\d{1,9}$/.test(raw)) return null
  const value = Number(raw)
  return value >= min && value <= max ? value : null
}

function parseLanguage(raw: string | null): string | null {
  if (raw == null) return DEFAULT_LANGUAGE
  return ALLOWED_LANGUAGES.has(raw) ? raw : null
}

export interface TvdbTitleRequest {
  route: "title"
  kind: TvdbKind
  tmdbId: number
  language: string
}

export interface TvdbFindRequest {
  route: "find"
  kind: TvdbKind
  /** Sent upstream: accents intact, since search matches better with them. */
  query: string
  /** Key-only: accent-stripped and lowercased so equivalent names share a cache entry. */
  name: string
  year: number | null
  language: string
}

export interface TvdbSeasonRequest {
  route: "season"
  kind: "series"
  /** Exactly one of these is set; a name-matched title only has the TheTVDB id. */
  tmdbId: number | null
  tvdbId: number | null
  language: string
  seasonNumber: number
  order: TvdbSeasonOrder
}

export type TvdbRequest = TvdbTitleRequest | TvdbFindRequest | TvdbSeasonRequest

/** Free text can't be whitelisted, so it is normalized, length-capped and hashed into the key. */
export function normalizeSearchName(raw: string | null): string | null {
  if (raw == null) return null
  const collapsed = raw
    .normalize("NFKD")
    // NFKD splits accents into combining marks, which are neither L nor N.
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  if (collapsed.length < 2) return null
  return collapsed.slice(0, MAX_NAME_LENGTH)
}

/**
 * FNV-1a, so an unbounded name yields a bounded key component. The length is
 * appended because 32 bits alone collide often enough that two titles would
 * serve each other's record for a full TTL.
 */
export function hashName(name: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(36)}x${name.length.toString(36)}`
}

// A colon sinks the right result in upstream ranking, so it is a separator here.
/** Upstream query text: punctuation and noise out, accents kept. */
export function searchQueryFor(raw: string | null): string | null {
  if (raw == null) return null
  const collapsed = raw
    .replace(/[^\p{L}\p{N}\p{M} '’&-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (collapsed.length < 2) return null
  return collapsed.slice(0, MAX_NAME_LENGTH)
}

export function parseFindRequest(params: URLSearchParams): TvdbFindRequest | null {
  const kind = params.get("kind") ?? "series"
  const rawName = params.get("name")
  const query = searchQueryFor(rawName)
  const name = normalizeSearchName(rawName)
  const language = parseLanguage(params.get("lang"))
  const yearParam = params.get("year")
  const year = yearParam == null ? null : parseBoundedInt(yearParam, MIN_YEAR, MAX_YEAR)
  if (!isTvdbKind(kind) || query == null || name == null || language == null) return null
  if (yearParam != null && year == null) return null
  return { route: "find", kind, query, name, year, language }
}

export function parseTitleRequest(params: URLSearchParams): TvdbTitleRequest | null {
  const kind = params.get("kind") ?? "series"
  const tmdbId = parseBoundedInt(params.get("tmdb"), 1, MAX_TMDB_ID)
  const language = parseLanguage(params.get("lang"))
  if (!isTvdbKind(kind) || tmdbId == null || language == null) return null
  return { route: "title", kind, tmdbId, language }
}

export function parseSeasonRequest(params: URLSearchParams): TvdbSeasonRequest | null {
  const tmdbId = parseBoundedInt(params.get("tmdb"), 1, MAX_TMDB_ID)
  const tvdbId = parseBoundedInt(params.get("tvdb"), 1, MAX_TMDB_ID)
  const seasonNumber = parseBoundedInt(params.get("season"), 0, MAX_SEASON_NUMBER)
  const language = parseLanguage(params.get("lang"))
  const order = params.get("order") ?? "official"
  if (seasonNumber == null || language == null || !isTvdbSeasonOrder(order)) return null
  if ((tmdbId == null) === (tvdbId == null)) return null
  return { route: "season", kind: "series", tmdbId, tvdbId, language, seasonNumber, order }
}

/** Versioned so a normalizer change invalidates cleanly instead of serving mixed shapes. */
export function cacheKeyFor(request: TvdbRequest): string {
  if (request.route === "title") {
    return `v3:title:${request.kind}:${request.tmdbId}:${request.language}`
  }
  if (request.route === "find") {
    return `v3:find:${request.kind}:${hashName(request.name)}:${request.year ?? "any"}:${request.language}`
  }
  const seriesRef = request.tvdbId == null ? `t${request.tmdbId}` : `v${request.tvdbId}`
  return `v3:season:${seriesRef}:${request.seasonNumber}:${request.order}:${request.language}`
}

/** Cache API needs an absolute URL; the host is arbitrary but must be stable. */
export function cacheUrlFor(request: TvdbRequest): string {
  return `https://tvdb-cache.internal/${cacheKeyFor(request)}`
}
