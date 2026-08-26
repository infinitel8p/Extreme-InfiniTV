// Serves normalized TheTVDB records from Cache API -> R2 -> upstream.
import { TVDB_CONTRACT_VERSION, type TvdbEnvelope } from "@/scripts/lib/tvdb-contract"
import {
  cacheUrlFor,
  parseFindRequest,
  parseSeasonRequest,
  parseTitleRequest,
  type TvdbRequest,
} from "@/scripts/lib/tvdb-params"
import {
  applyTvdbTranslation,
  normalizeSeason,
  normalizeTitle,
  pickRemoteIdMatches,
  pickSearchMatch,
  recordCarriesTmdbId,
} from "@/scripts/lib/tvdb-normalize"
import {
  findByTmdbId,
  getExtendedRecord,
  getSeasonEpisodesCached,
  getTranslation,
  searchByName,
  TvdbUpstreamError,
  type TvdbEnv,
} from "./tvdb"
import { rateLimitExceeded, retryAfterSeconds } from "@/scripts/lib/tvdb-rate-limit"

const DAY_SECONDS = 24 * 60 * 60
const TTL_TITLE = 30 * DAY_SECONDS
const TTL_SEASON_ENDED = 30 * DAY_SECONDS
// A running series gains episodes, so its season list can't be pinned for a month.
const TTL_SEASON_CONTINUING = DAY_SECONDS
// Short enough that a title added upstream next week isn't written off for good.
const TTL_NEGATIVE = DAY_SECONDS
const MAX_REMOTE_ID_CANDIDATES = 3
// Edge entries outlive their logical ttl so a stale copy is still there to serve
// while the refresh runs behind it.
const STALE_GRACE_SECONDS = 7 * DAY_SECONDS

interface CachedPayload {
  storedAt: number
  ttl: number
  data: unknown
}

// Per-isolate, so simultaneous misses for one key make a single upstream call.
const inflight = new Map<string, Promise<CachedPayload>>()

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
} as const

function plainResponse(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...CORS_HEADERS, ...extra } })
}

function jsonResponse(payload: CachedPayload, nowSeconds: number): Response {
  const ageSeconds = Math.max(0, nowSeconds - payload.storedAt)
  const envelope: TvdbEnvelope<unknown> = {
    v: TVDB_CONTRACT_VERSION,
    source: "thetvdb",
    ageSeconds,
    data: payload.data ?? null,
  }
  return new Response(JSON.stringify(envelope), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${Math.max(0, payload.ttl - ageSeconds)}`,
      ...CORS_HEADERS,
      "X-Tvdb-Age": String(ageSeconds),
    },
  })
}

async function readCache(request: TvdbRequest, env: TvdbEnv): Promise<CachedPayload | null> {
  const cacheUrl = cacheUrlFor(request)
  const edgeHit = await caches.default.match(cacheUrl)
  if (edgeHit) return (await edgeHit.json()) as CachedPayload
  if (!env.TVDB_CACHE) return null
  const object = await env.TVDB_CACHE.get(new URL(cacheUrl).pathname.slice(1))
  return object ? ((await object.json()) as CachedPayload) : null
}

async function writeCache(request: TvdbRequest, env: TvdbEnv, payload: CachedPayload): Promise<void> {
  const cacheUrl = cacheUrlFor(request)
  const body = JSON.stringify(payload)
  await caches.default.put(
    cacheUrl,
    new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${payload.ttl + STALE_GRACE_SECONDS}`,
      },
    })
  )
  if (!env.TVDB_CACHE) return
  await env.TVDB_CACHE.put(new URL(cacheUrl).pathname.slice(1), body, {
    httpMetadata: { contentType: "application/json" },
  })
}

async function buildTitle(request: TvdbRequest, env: TvdbEnv): Promise<CachedPayload> {
  if (request.route !== "title") throw new Error("wrong route")
  const now = Math.floor(Date.now() / 1000)
  const candidates = pickRemoteIdMatches(await findByTmdbId(env, request.tmdbId), request.kind)
  let title = null
  let tvdbId = 0
  for (const candidate of candidates.slice(0, MAX_REMOTE_ID_CANDIDATES)) {
    const candidateId = Number(candidate?.id)
    if (!Number.isInteger(candidateId) || candidateId <= 0) continue
    const extended = await getExtendedRecord(env, request.kind, candidateId)
    // The wrapper carries no source marker, so only the extended record can prove it.
    if (!recordCarriesTmdbId(extended, request.tmdbId)) continue
    const normalized = normalizeTitle(extended, request.language, request.kind)
    if (!normalized) continue
    title = normalized
    tvdbId = candidateId
    break
  }
  if (!title) return { storedAt: now, ttl: TTL_NEGATIVE, data: null }
  // Base records carry the original language (jpn for anime), so English needs this too.
  const translation = await getTranslation(env, request.kind, tvdbId, request.language).catch(() => null)
  return { storedAt: now, ttl: TTL_TITLE, data: applyTvdbTranslation(title, translation) }
}

async function buildSeason(request: TvdbRequest, env: TvdbEnv): Promise<CachedPayload> {
  if (request.route !== "season") throw new Error("wrong route")
  const now = Math.floor(Date.now() / 1000)
  let tvdbId = request.tvdbId ?? 0
  if (!tvdbId && request.tmdbId != null) {
    const tmdbId = request.tmdbId
    for (const candidate of pickRemoteIdMatches(await findByTmdbId(env, tmdbId), "series").slice(0, MAX_REMOTE_ID_CANDIDATES)) {
      const candidateId = Number(candidate?.id)
      if (!Number.isInteger(candidateId) || candidateId <= 0) continue
      const extended = await getExtendedRecord(env, "series", candidateId)
      if (!recordCarriesTmdbId(extended, tmdbId)) continue
      tvdbId = candidateId
      break
    }
  }
  if (!Number.isInteger(tvdbId) || tvdbId <= 0) {
    return { storedAt: now, ttl: TTL_NEGATIVE, data: null }
  }
  const episodes = await getSeasonEpisodesCached(env, tvdbId, request.order, request.language)
  const season = normalizeSeason(episodes, request.seasonNumber, request.order)
  if (season.episodes.length === 0) {
    return { storedAt: now, ttl: TTL_NEGATIVE, data: season }
  }
  const extended = await getExtendedRecord(env, "series", tvdbId).catch(() => null)
  const ended = normalizeTitle(extended, request.language, "series")?.status === "ended"
  return { storedAt: now, ttl: ended ? TTL_SEASON_ENDED : TTL_SEASON_CONTINUING, data: season }
}

async function buildFind(request: TvdbRequest, env: TvdbEnv): Promise<CachedPayload> {
  if (request.route !== "find") throw new Error("wrong route")
  const now = Math.floor(Date.now() / 1000)
  const results = await searchByName(env, request.kind, request.query, request.year)
  const tvdbId = pickSearchMatch(results, request.kind, request.year, request.query)
  if (tvdbId == null) return { storedAt: now, ttl: TTL_NEGATIVE, data: null }
  const extended = await getExtendedRecord(env, request.kind, tvdbId)
  const title = normalizeTitle(extended, request.language, request.kind)
  if (!title) return { storedAt: now, ttl: TTL_NEGATIVE, data: null }
  const translation = await getTranslation(env, request.kind, tvdbId, request.language).catch(() => null)
  return { storedAt: now, ttl: TTL_TITLE, data: applyTvdbTranslation(title, translation) }
}

function buildFor(request: TvdbRequest, env: TvdbEnv): Promise<CachedPayload> {
  if (request.route === "title") return buildTitle(request, env)
  if (request.route === "find") return buildFind(request, env)
  return buildSeason(request, env)
}

function build(request: TvdbRequest, env: TvdbEnv): Promise<CachedPayload> {
  const key = cacheUrlFor(request)
  const existing = inflight.get(key)
  if (existing) return existing
  const pending = buildFor(request, env).finally(() => inflight.delete(key))
  inflight.set(key, pending)
  return pending
}

function parse(url: URL): TvdbRequest | null {
  if (url.pathname === "/v1/title") return parseTitleRequest(url.searchParams)
  if (url.pathname === "/v1/find") return parseFindRequest(url.searchParams)
  if (url.pathname === "/v1/season") return parseSeasonRequest(url.searchParams)
  return null
}

export default {
  async fetch(httpRequest: Request, env: TvdbEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(httpRequest.url)
    if (httpRequest.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      })
    }
    if (httpRequest.method !== "GET") return plainResponse("method not allowed", 405)
    if (url.pathname === "/healthz") return plainResponse("ok", 200)

    const request = parse(url)
    if (!request) return plainResponse("bad request", 400)

    const nowMs = Date.now()
    const clientIp = httpRequest.headers.get("cf-connecting-ip") || ""
    if (rateLimitExceeded(clientIp, nowMs)) {
      return plainResponse("too many requests", 429, {
        "Retry-After": String(retryAfterSeconds(clientIp, nowMs)),
      })
    }

    const now = Math.floor(nowMs / 1000)
    try {
      const cached = await readCache(request, env)
      if (cached) {
        const stale = now - cached.storedAt > cached.ttl
        if (stale) {
          ctx.waitUntil(
            build(request, env)
              .then((fresh) => writeCache(request, env, fresh))
              .catch(() => {})
          )
        }
        return jsonResponse(cached, now)
      }
      const fresh = await build(request, env)
      ctx.waitUntil(writeCache(request, env, fresh).catch(() => {}))
      return jsonResponse(fresh, now)
    } catch (error) {
      const status = error instanceof TvdbUpstreamError ? 502 : 500
      return new Response(JSON.stringify({ v: TVDB_CONTRACT_VERSION, error: "upstream" }), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          // Keep a failing upstream from turning into a retry storm.
          "Cache-Control": "public, max-age=60",
          ...CORS_HEADERS,
        },
      })
    }
  },
} satisfies ExportedHandler<TvdbEnv>
