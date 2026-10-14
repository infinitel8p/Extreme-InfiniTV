import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { getCached, hydrate, setCached } from "@/scripts/lib/cache.js"
import {
  clearOpenSubtitlesSession,
  getOpenSubtitlesSession,
  setOpenSubtitlesSession,
} from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.ts"
import { t } from "@/scripts/lib/i18n.js"
import { toastWarn } from "@/scripts/lib/toast.js"
import {
  buildSubtitleSearchParams,
  canonicalQueryString,
  normalizeSearchResponse,
  type OpenSubtitlesResult,
  type SubtitleSearchContext,
} from "@/scripts/lib/opensubtitles-params.ts"

const DEFAULT_BASE_URL = "https://api.opensubtitles.com/api/v1"
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const TEXT_CACHE_ENTRY_ID = "opensubs"
const TEXT_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000
const FALLBACK_SESSION_MS = 23 * 60 * 60 * 1000
const LINK_REUSE_MS = 2.5 * 60 * 60 * 1000
const API_HOST_PATTERN = /(^|\.)opensubtitles\.(com|org)$/i

export type OpenSubtitlesErrorCode =
  | "not-configured"
  | "bad-key"
  | "unauthorized"
  | "quota"
  | "throttled"
  | "expired-link"
  | "network"
  | "unknown"

export class OpenSubtitlesError extends Error {
  code: OpenSubtitlesErrorCode
  resetTimeUtc?: string
  remaining?: number

  constructor(
    code: OpenSubtitlesErrorCode,
    detail?: { message?: string; resetTimeUtc?: string; remaining?: number }
  ) {
    super(detail?.message || code)
    this.name = "OpenSubtitlesError"
    this.code = code
    this.resetTimeUtc = detail?.resetTimeUtc
    this.remaining = detail?.remaining
  }
}

export type OpenSubtitlesSession = {
  token: string
  baseUrl: string
  username: string
  allowedDownloads: number | null
  level: string | null
  vip: boolean
  expiresAt: number
}

export type OpenSubtitlesUserInfo = {
  allowedDownloads: number | null
  remainingDownloads: number | null
  level: string | null
  vip: boolean
}

type SearchPage = { results: OpenSubtitlesResult[]; page: number; totalPages: number }

type TextResult = { text: string; remaining: number | null; fileName: string | null; link: string | null }

const searchCache = new Map<string, { at: number; value: SearchPage }>()
const linkByFileId = new Map<number, { link: string; at: number }>()
const inflightText = new Map<number, Promise<TextResult>>()
let sessionRejectionToasted = false

function freshLink(fileId: number): string | null {
  const entry = linkByFileId.get(fileId)
  return entry && Date.now() - entry.at < LINK_REUSE_MS ? entry.link : null
}

function rejectSession(): void {
  clearOpenSubtitlesSession()
  if (sessionRejectionToasted) return
  sessionRejectionToasted = true
  toastWarn(t("player.subtitles.signInHint"))
}

export function isSafeDownloadLink(link: string): boolean {
  try {
    return new URL(link).protocol === "https:"
  } catch {
    return false
  }
}

export function opensubtitlesAvailable(): boolean {
  return Boolean(import.meta.env.PUBLIC_OPENSUBTITLES_API_KEY)
}

function apiKey(): string {
  const key = import.meta.env.PUBLIC_OPENSUBTITLES_API_KEY
  if (!key) throw new OpenSubtitlesError("not-configured")
  return String(key)
}

function appVersion(): string {
  try {
    const meta = document.querySelector('meta[name="x-app-version"]')?.getAttribute("content")
    if (meta) return meta
  } catch {
    // no DOM
  }
  return "0.0.0"
}

function appUserAgent(): string {
  return `Extreme InfiniTV v${appVersion()}`
}

function activeSession(): OpenSubtitlesSession | null {
  const session = getOpenSubtitlesSession() as OpenSubtitlesSession | null
  if (!session) return null
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    clearOpenSubtitlesSession()
    return null
  }
  return session
}

export function resolveApiBase(baseUrl: string | null | undefined): string {
  const host = (baseUrl ?? "").trim()
  if (!host) return DEFAULT_BASE_URL
  try {
    const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`)
    if (url.protocol !== "https:" || !API_HOST_PATTERN.test(url.hostname)) return DEFAULT_BASE_URL
    return `${url.origin}/api/v1`
  } catch {
    return DEFAULT_BASE_URL
  }
}

function apiBase(session: OpenSubtitlesSession | null): string {
  return resolveApiBase(session?.baseUrl)
}

function buildHeaders(session: OpenSubtitlesSession | null, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "*/*",
    "Api-Key": apiKey(),
    "X-User-Agent": appUserAgent(),
  }
  if (hasBody) headers["Content-Type"] = "application/json"
  if (session) headers.Authorization = `Bearer ${session.token}`
  return headers
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json()
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function isInvalidTokenBody(status: number, body: Record<string, unknown>): boolean {
  const message = String(body.message ?? "").toLowerCase()
  return (status === 406 || status === 500) && message.includes("invalid")
}

function errorFromResponse(status: number, body: Record<string, unknown>): OpenSubtitlesError {
  const message = typeof body.message === "string" ? body.message : undefined
  if (status === 401) return new OpenSubtitlesError("unauthorized", { message })
  if (status === 403) return new OpenSubtitlesError("bad-key", { message })
  if (status === 429) return new OpenSubtitlesError("throttled", { message })
  if (status === 410) return new OpenSubtitlesError("expired-link", { message })
  if (isInvalidTokenBody(status, body)) return new OpenSubtitlesError("unauthorized", { message })
  if (status === 406) {
    return new OpenSubtitlesError("quota", {
      message,
      resetTimeUtc: typeof body.reset_time_utc === "string" ? body.reset_time_utc : undefined,
      remaining: typeof body.remaining === "number" ? body.remaining : undefined,
    })
  }
  return new OpenSubtitlesError("unknown", { message: message || `HTTP ${status}` })
}

async function apiRequest(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; session: OpenSubtitlesSession | null }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const hasBody = options.body !== undefined
  let response: Response
  try {
    response = await providerFetch(`${apiBase(options.session)}${path}`, {
      method: options.method || "GET",
      headers: buildHeaders(options.session, hasBody),
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      logKind: "api",
      dns: "global",
      userAgent: appUserAgent(),
    })
  } catch (requestError) {
    if (options.signal?.aborted) throw requestError
    log.warn("[xt:opensubs] request failed:", path, requestError)
    throw new OpenSubtitlesError("network")
  }
  return { status: response.status, body: await readJson(response) }
}

export async function searchSubtitles(
  context: SubtitleSearchContext,
  options: { languages: string[]; page?: number; signal?: AbortSignal }
): Promise<SearchPage> {
  apiKey()
  const params = buildSubtitleSearchParams(context, options.languages, { page: options.page })
  const queryString = canonicalQueryString(params)
  const cached = searchCache.get(queryString)
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.value

  const run = async (session: OpenSubtitlesSession | null) =>
    apiRequest(`/subtitles?${queryString}`, { signal: options.signal, session })

  const session = activeSession()
  let outcome = await run(session)
  if (session && (outcome.status === 401 || isInvalidTokenBody(outcome.status, outcome.body))) {
    log.info("[xt:opensubs] session rejected, retrying anonymously")
    rejectSession()
    outcome = await run(null)
  }
  if (outcome.status !== 200) throw errorFromResponse(outcome.status, outcome.body)

  const value = normalizeSearchResponse(outcome.body)
  searchCache.set(queryString, { at: Date.now(), value })
  return value
}

function textCacheKind(fileId: number): string {
  return `file:${fileId}`
}

async function requestDownloadLink(
  fileId: number,
  signal: AbortSignal | undefined
): Promise<{ link: string; remaining: number | null; fileName: string | null }> {
  const session = activeSession()
  const outcome = await apiRequest("/download", {
    method: "POST",
    body: { file_id: fileId, sub_format: "srt" },
    signal,
    session,
  })
  if (outcome.status !== 200) {
    if (session && isInvalidTokenBody(outcome.status, outcome.body)) rejectSession()
    throw errorFromResponse(outcome.status, outcome.body)
  }
  const link = typeof outcome.body.link === "string" ? outcome.body.link : ""
  if (!link || !isSafeDownloadLink(link)) {
    throw new OpenSubtitlesError("unknown", { message: "invalid download link" })
  }
  linkByFileId.set(fileId, { link, at: Date.now() })
  return {
    link,
    remaining: typeof outcome.body.remaining === "number" ? outcome.body.remaining : null,
    fileName: typeof outcome.body.file_name === "string" ? outcome.body.file_name : null,
  }
}

export async function downloadSubtitleLink(
  fileId: number,
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  apiKey()
  return freshLink(fileId) ?? (await requestDownloadLink(fileId, options.signal)).link
}

async function fetchSubtitleText(fileId: number, signal: AbortSignal | undefined): Promise<TextResult> {
  const kind = textCacheKind(fileId)
  await hydrate(TEXT_CACHE_ENTRY_ID, kind)
  const hit = getCached(TEXT_CACHE_ENTRY_ID, kind)
  if (hit && typeof hit.data?.text === "string") {
    return { text: hit.data.text, remaining: null, fileName: hit.data.fileName ?? null, link: freshLink(fileId) }
  }

  const { link, remaining, fileName } = await requestDownloadLink(fileId, signal)

  let linkResponse: Response
  try {
    linkResponse = await providerFetch(link, {
      signal,
      logKind: "api",
      dns: "global",
      userAgent: appUserAgent(),
    })
  } catch (linkError) {
    if (signal?.aborted) throw linkError
    log.warn("[xt:opensubs] link fetch failed:", linkError)
    throw new OpenSubtitlesError("network")
  }
  if (!linkResponse.ok) throw errorFromResponse(linkResponse.status, {})
  const text = new TextDecoder("utf-8").decode(await linkResponse.arrayBuffer())
  setCached(TEXT_CACHE_ENTRY_ID, kind, { text, fileName }, TEXT_CACHE_TTL_MS)
  return { text, remaining, fileName, link }
}

export function downloadSubtitleText(
  fileId: number,
  options: { signal?: AbortSignal } = {}
): Promise<TextResult> {
  apiKey()
  const pending = inflightText.get(fileId)
  if (pending) return pending
  const request = fetchSubtitleText(fileId, options.signal).finally(() => inflightText.delete(fileId))
  inflightText.set(fileId, request)
  return request
}

function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/")
    const claims = JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")))
    return typeof claims.exp === "number" ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

export async function loginOpenSubtitles(
  username: string,
  password: string,
  options: { signal?: AbortSignal } = {}
): Promise<OpenSubtitlesSession> {
  const outcome = await apiRequest("/login", {
    method: "POST",
    body: { username, password },
    signal: options.signal,
    session: null,
  })
  if (outcome.status !== 200) throw errorFromResponse(outcome.status, outcome.body)
  const token = typeof outcome.body.token === "string" ? outcome.body.token : ""
  if (!token) throw new OpenSubtitlesError("unknown", { message: "missing token" })
  const user = (outcome.body.user ?? {}) as Record<string, unknown>
  const session: OpenSubtitlesSession = {
    token,
    baseUrl: typeof outcome.body.base_url === "string" ? outcome.body.base_url : "",
    username,
    allowedDownloads: typeof user.allowed_downloads === "number" ? user.allowed_downloads : null,
    level: typeof user.level === "string" ? user.level : null,
    vip: user.vip === true,
    expiresAt: jwtExpiryMs(token) ?? Date.now() + FALLBACK_SESSION_MS,
  }
  setOpenSubtitlesSession(session)
  return session
}

export async function logoutOpenSubtitles(): Promise<void> {
  const session = getOpenSubtitlesSession() as OpenSubtitlesSession | null
  if (session && opensubtitlesAvailable()) {
    try {
      await apiRequest("/logout", { method: "DELETE", session })
    } catch (logoutError) {
      log.warn("[xt:opensubs] logout request failed:", logoutError)
    }
  }
  clearOpenSubtitlesSession()
}

export async function fetchOpenSubtitlesUserInfo(
  options: { signal?: AbortSignal } = {}
): Promise<OpenSubtitlesUserInfo> {
  const session = activeSession()
  if (!session) throw new OpenSubtitlesError("unauthorized")
  const outcome = await apiRequest("/infos/user", { signal: options.signal, session })
  if (outcome.status !== 200) {
    if (isInvalidTokenBody(outcome.status, outcome.body)) rejectSession()
    throw errorFromResponse(outcome.status, outcome.body)
  }
  const data = (outcome.body.data ?? {}) as Record<string, unknown>
  return {
    allowedDownloads: typeof data.allowed_downloads === "number" ? data.allowed_downloads : null,
    remainingDownloads: typeof data.remaining_downloads === "number" ? data.remaining_downloads : null,
    level: typeof data.level === "string" ? data.level : null,
    vip: data.vip === true,
  }
}
