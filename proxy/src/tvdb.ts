// Upstream access; the bearer token lives in KV, the API key never leaves here.
import type { TvdbKind } from "@/scripts/lib/tvdb-contract"
import type { TvdbRawEpisode, TvdbRawSeriesRecord } from "@/scripts/lib/tvdb-normalize"

const API_BASE = "https://api4.thetvdb.com/v4"
const TOKEN_KEY = "bearer-token"
// Tokens are valid a month; refresh early so a slow request can't race expiry.
const TOKEN_TTL_SECONDS = 25 * 24 * 60 * 60
// Terms forbid concealing identity, so identify the project on every call.
const USER_AGENT = "Extreme-InfiniTV-Proxy (+https://github.com/infinitel8p/Extreme-InfiniTV)"

export interface TvdbEnv {
  TVDB_API_KEY: string
  TVDB_TOKEN: KVNamespace
  TVDB_CACHE?: R2Bucket
}

export class TvdbUpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "TvdbUpstreamError"
  }
}

async function login(env: TvdbEnv): Promise<string> {
  const response = await fetch(`${API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    // A project key takes no pin; sending an empty one is rejected.
    body: JSON.stringify({ apikey: env.TVDB_API_KEY }),
  })
  if (!response.ok) {
    throw new TvdbUpstreamError(response.status, `login failed: ${response.status}`)
  }
  const payload = (await response.json()) as { data?: { token?: string } }
  const token = payload.data?.token
  if (!token) throw new TvdbUpstreamError(502, "login returned no token")
  await env.TVDB_TOKEN.put(TOKEN_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS })
  return token
}

async function bearerToken(env: TvdbEnv): Promise<string> {
  return (await env.TVDB_TOKEN.get(TOKEN_KEY)) ?? login(env)
}

/** Returns null on 404 so a missing record is a cacheable answer, not an error. */
async function getJson<T>(env: TvdbEnv, path: string, retryOn401 = true): Promise<T | null> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${await bearerToken(env)}`, "User-Agent": USER_AGENT },
  })
  if (response.status === 404) return null
  if (response.status === 401 && retryOn401) {
    // KV is eventually consistent, so a delete-then-read can return the dead
    // token; mint a new one directly instead.
    const token = await login(env)
    const retry = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
    })
    if (retry.status === 404) return null
    if (!retry.ok) throw new TvdbUpstreamError(retry.status, `${path} failed: ${retry.status}`)
    return ((await retry.json()) as { data?: T }).data ?? null
  }
  if (!response.ok) {
    throw new TvdbUpstreamError(response.status, `${path} failed: ${response.status}`)
  }
  const payload = (await response.json()) as { data?: T }
  return payload.data ?? null
}

export async function findByTmdbId(
  env: TvdbEnv,
  tmdbId: number
): Promise<Array<Record<string, unknown>> | null> {
  return getJson<Array<Record<string, unknown>>>(env, `/search/remoteid/${tmdbId}`)
}

export async function searchByName(
  env: TvdbEnv,
  kind: TvdbKind,
  name: string,
  year: number | null
): Promise<Array<Record<string, unknown>> | null> {
  const params = new URLSearchParams({ query: name, type: kind, limit: "5" })
  if (year != null) params.set("year", String(year))
  return getJson<Array<Record<string, unknown>>>(env, `/search?${params}`)
}

export async function getExtendedRecord(
  env: TvdbEnv,
  kind: TvdbKind,
  tvdbId: number
): Promise<TvdbRawSeriesRecord | null> {
  const collection = kind === "movie" ? "movies" : "series"
  return getJson<TvdbRawSeriesRecord>(env, `/${collection}/${tvdbId}/extended`)
}

export async function getTranslation(
  env: TvdbEnv,
  kind: TvdbKind,
  tvdbId: number,
  language: string
): Promise<{ name?: string | null; overview?: string | null } | null> {
  const collection = kind === "movie" ? "movies" : "series"
  return getJson(env, `/${collection}/${tvdbId}/translations/${language}`)
}

// Upstream pages at 500; long-running series are exactly the target case here.
const EPISODE_PAGE_SIZE = 500
const MAX_EPISODE_PAGES = 12

const flatEpisodeCache = new Map<string, Promise<TvdbRawEpisode[] | null>>()

/** Each season would otherwise re-walk every page of the same flat list. */
export function getSeasonEpisodesCached(
  env: TvdbEnv,
  tvdbId: number,
  order: string,
  language: string
): Promise<TvdbRawEpisode[] | null> {
  const key = `${tvdbId}:${order}:${language}`
  const existing = flatEpisodeCache.get(key)
  if (existing) return existing
  const pending = getSeasonEpisodes(env, tvdbId, order, language).finally(() => {
    flatEpisodeCache.delete(key)
  })
  flatEpisodeCache.set(key, pending)
  return pending
}

/** One flat list per ordering; normalizeSeason slices it into a season. */
export async function getSeasonEpisodes(
  env: TvdbEnv,
  tvdbId: number,
  order: string,
  language: string
): Promise<TvdbRawEpisode[] | null> {
  const collected: TvdbRawEpisode[] = []
  for (let page = 0; page < MAX_EPISODE_PAGES; page++) {
    const payload = await getJson<{ episodes?: TvdbRawEpisode[] }>(
      env,
      `/series/${tvdbId}/episodes/${order}/${language}?page=${page}`
    )
    const episodes = payload?.episodes ?? []
    if (page === 0 && episodes.length === 0) return null
    collected.push(...episodes)
    if (episodes.length < EPISODE_PAGE_SIZE) break
  }
  return collected
}
