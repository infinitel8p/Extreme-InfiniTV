// Thin TMDb v3 API client. Auth via Bearer (v4 read token) or api_key query param.

const TMDB_BASE = "https://api.themoviedb.org/3"

export const TMDB_POSTER_SIZE = "w500"
export const TMDB_BACKDROP_SIZE = "w1280"
export const TMDB_PROFILE_SIZE = "w185"
export const TMDB_STILL_SIZE = "w300"

export class TmdbHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "TmdbHttpError"
    this.status = status
  }
}

export interface TmdbVideo {
  key: string
  site: string
  type: string
  official?: boolean
}

export interface TmdbVideosResponse {
  results?: TmdbVideo[]
}

export interface TmdbCastMember {
  id: number
  name: string
  character?: string
  profile_path?: string | null
}

export interface TmdbCrewMember {
  id?: number
  name: string
  job?: string
}

export interface TmdbPersonCreditItem {
  id: number
  media_type: "movie" | "tv"
  title?: string
  original_title?: string
  name?: string
  original_name?: string
  release_date?: string
  first_air_date?: string
}

export interface TmdbPersonCreditsResponse {
  cast?: TmdbPersonCreditItem[]
  crew?: TmdbPersonCreditItem[]
}

export interface TmdbCredits {
  cast?: TmdbCastMember[]
  crew?: TmdbCrewMember[]
}

export interface TmdbSearchResult {
  id: number
  title?: string
  original_title?: string
  name?: string
  original_name?: string
  release_date?: string
  first_air_date?: string
  vote_count?: number
  popularity?: number
  poster_path?: string | null
  overview?: string
}

export interface TmdbBundle {
  id: number
  title?: string
  name?: string
  overview?: string
  poster_path?: string | null
  backdrop_path?: string | null
  vote_average?: number
  genres?: Array<{ id: number; name: string }>
  credits?: TmdbCredits
  videos?: TmdbVideosResponse
  recommendations?: { results?: TmdbSearchResult[] }
}

export interface TmdbSeasonEpisode {
  episode_number: number
  name?: string
  overview?: string
  still_path?: string | null
}

export interface TmdbSeasonResponse {
  episodes?: TmdbSeasonEpisode[]
}

function isBearerKey(key: string): boolean {
  return /^eyJ/.test(key)
}

function buildTmdbUrl(
  key: string,
  path: string,
  params: Record<string, string | number | undefined>
): string {
  const url = new URL(TMDB_BASE + path)
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    url.searchParams.set(name, String(value))
  }
  if (!isBearerKey(key)) url.searchParams.set("api_key", key)
  return url.toString()
}

async function tmdbFetch<T>(
  key: string,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = buildTmdbUrl(key, path, params)
  const headers: Record<string, string> = { Accept: "application/json" }
  if (isBearerKey(key)) headers.Authorization = `Bearer ${key}`

  let response = await fetch(url, { headers })
  if (response.status === 429) {
    const retryAfterHeader = Number(response.headers.get("Retry-After"))
    const retryAfterSeconds = Math.max(Number.isFinite(retryAfterHeader) ? retryAfterHeader : 0, 1)
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000))
    response = await fetch(url, { headers })
  }

  if (!response.ok) {
    if (response.status === 401) throw new TmdbHttpError(401, "Invalid TMDb API key")
    if (response.status === 404) throw new TmdbHttpError(404, "Not found on TMDb")
    if (response.status === 429) throw new TmdbHttpError(429, "Rate limited by TMDb")
    throw new TmdbHttpError(response.status, `TMDb request failed (${response.status})`)
  }
  return response.json()
}

export async function validateTmdbKey(key: string): Promise<{ ok: boolean; status?: number }> {
  try {
    await tmdbFetch(key, "/configuration")
    return { ok: true }
  } catch (error) {
    const status = error instanceof TmdbHttpError ? error.status : undefined
    return { ok: false, status }
  }
}

export async function tmdbSearchMovie(
  key: string,
  query: string,
  { year, language }: { year?: number | null; language?: string } = {}
): Promise<TmdbSearchResult[]> {
  const params: Record<string, string | number | undefined> = { query, language }
  if (Number.isFinite(year)) params.year = year as number
  const data = await tmdbFetch<{ results?: TmdbSearchResult[] }>(key, "/search/movie", params)
  return data.results || []
}

export async function tmdbSearchTv(
  key: string,
  query: string,
  { year, language }: { year?: number | null; language?: string } = {}
): Promise<TmdbSearchResult[]> {
  const params: Record<string, string | number | undefined> = { query, language }
  if (Number.isFinite(year)) params.first_air_date_year = year as number
  const data = await tmdbFetch<{ results?: TmdbSearchResult[] }>(key, "/search/tv", params)
  return data.results || []
}

export async function tmdbMovieBundle(
  key: string,
  tmdbId: number,
  language?: string
): Promise<TmdbBundle> {
  return tmdbFetch<TmdbBundle>(key, `/movie/${tmdbId}`, {
    append_to_response: "credits,videos,recommendations",
    language,
  })
}

export async function tmdbTvBundle(
  key: string,
  tmdbId: number,
  language?: string
): Promise<TmdbBundle> {
  return tmdbFetch<TmdbBundle>(key, `/tv/${tmdbId}`, {
    append_to_response: "credits,videos,recommendations",
    language,
  })
}

export async function tmdbTvSeason(
  key: string,
  tmdbId: number,
  seasonNumber: number,
  language?: string
): Promise<TmdbSeasonResponse> {
  return tmdbFetch<TmdbSeasonResponse>(key, `/tv/${tmdbId}/season/${seasonNumber}`, { language })
}

export async function tmdbPersonCredits(
  key: string,
  personId: number,
  language?: string
): Promise<TmdbPersonCreditsResponse> {
  return tmdbFetch<TmdbPersonCreditsResponse>(key, `/person/${personId}/combined_credits`, { language })
}

const LOCALE_TO_TMDB_LANGUAGE: Record<string, string> = {
  en: "en-US",
  es: "es-ES",
  de: "de-DE",
  fr: "fr-FR",
  "pt-BR": "pt-BR",
  it: "it-IT",
  ru: "ru-RU",
  zh: "zh-CN",
  ja: "ja-JP",
  tr: "tr-TR",
  ar: "ar-SA",
  ur: "ur-PK",
  nl: "nl-NL",
  hi: "hi-IN",
  id: "id-ID",
  pl: "pl-PL",
}

export function tmdbLanguageFor(locale: string): string {
  return LOCALE_TO_TMDB_LANGUAGE[locale] || "en-US"
}

export function tmdbImageUrl(path: string | null | undefined, size: string): string | null {
  if (!path) return null
  return `https://image.tmdb.org/t/p/${size}${path}`
}

export function extractTrailerYoutubeKey(videos?: TmdbVideosResponse | null): string | null {
  const youtube = (videos?.results || []).filter((video) => video.site === "YouTube")
  const officialTrailer = youtube.find((video) => video.type === "Trailer" && video.official)
  if (officialTrailer) return officialTrailer.key
  const trailer = youtube.find((video) => video.type === "Trailer")
  if (trailer) return trailer.key
  const teaser = youtube.find((video) => video.type === "Teaser")
  return teaser ? teaser.key : null
}

export function extractDirector(credits?: TmdbCredits | null): string | null {
  const director = (credits?.crew || []).find((member) => member.job === "Director")
  return director ? director.name : null
}

export function extractDirectorEntry(
  credits?: TmdbCredits | null
): { name: string; tmdbPersonId: number | null } | null {
  const director = (credits?.crew || []).find((member) => member.job === "Director")
  return director ? { name: director.name, tmdbPersonId: director.id ?? null } : null
}

export function extractCast(
  credits?: TmdbCredits | null,
  limit = 12
): Array<{ name: string; character: string; profilePath: string | null; tmdbPersonId: number }> {
  return (credits?.cast || []).slice(0, limit).map((member) => ({
    name: member.name,
    character: member.character || "",
    profilePath: member.profile_path || null,
    tmdbPersonId: member.id,
  }))
}
