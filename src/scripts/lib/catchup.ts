// Pure helpers for IPTV catch-up (archive) playback: availability gating, Xtream timeshift URLs, clock drift, M3U catchup templates.

import type { StreamProfile } from "@/scripts/lib/timeshift-math.ts"

export interface CatchupCapableChannel {
  tvArchive?: number
  tvArchiveDuration?: number
  catchup?: string | null
  catchupDays?: number | null
  catchupSource?: string | null
  url?: string
}

export const DEFAULT_CATCHUP_DAYS = 7

export function channelSupportsCatchup(channel: CatchupCapableChannel): boolean {
  if (Number(channel.tvArchive) === 1) return true
  return Boolean(channel.catchup) || Boolean(channel.catchupSource)
}

export function catchupWindowDays(channel: CatchupCapableChannel): number {
  const archiveDuration = Number(channel.tvArchiveDuration)
  if (Number.isFinite(archiveDuration) && archiveDuration > 0) return archiveDuration
  const catchupDays = Number(channel.catchupDays)
  if (Number.isFinite(catchupDays) && catchupDays > 0) return catchupDays
  return DEFAULT_CATCHUP_DAYS
}

export function isCatchupPlayable(
  channel: CatchupCapableChannel,
  programmeStartMs: number,
  nowMs: number,
): boolean {
  if (!channelSupportsCatchup(channel)) return false
  const windowMs = catchupWindowDays(channel) * 24 * 60 * 60 * 1000
  return programmeStartMs >= nowMs - windowMs && programmeStartMs < nowMs
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** Format `date` with SimpleDateFormat-style tokens (yyyy, MM, dd, HH, mm, ss, and unpadded variants). */
function formatLocalDatePattern(date: Date, pattern: string): string {
  const tokens: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    yy: String(date.getFullYear()).slice(-2),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: pad2(date.getDate()),
    d: String(date.getDate()),
    HH: pad2(date.getHours()),
    H: String(date.getHours()),
    mm: pad2(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad2(date.getSeconds()),
    s: String(date.getSeconds()),
  }
  return pattern.replace(/yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g, (match) => tokens[match])
}

/** Format a UTC instant, shifted to the provider's local clock, as `YYYY-MM-DD:HH-MM`. */
export function formatTimeshiftStart(startUtcMs: number, serverOffsetMs: number): string {
  const shifted = new Date(startUtcMs + serverOffsetMs)
  const year = shifted.getUTCFullYear()
  const month = pad2(shifted.getUTCMonth() + 1)
  const day = pad2(shifted.getUTCDate())
  const hours = pad2(shifted.getUTCHours())
  const minutes = pad2(shifted.getUTCMinutes())
  return `${year}-${month}-${day}:${hours}-${minutes}`
}

/** Duration in whole minutes, clamped so an in-progress programme doesn't request past `now`. */
export function clampedDurationMinutes(startMs: number, stopMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((Math.min(stopMs, nowMs) - startMs) / 60000))
}

export type XtreamTimeshiftForm = "rest" | "legacy"

export function buildXtreamTimeshiftUrl(opts: {
  baseUrl: string
  username: string
  password: string
  streamId: string | number
  startUtcMs: number
  durationMinutes: number
  serverOffsetMs: number
  extension: string
  form: XtreamTimeshiftForm
  /** Provider-facing start shift, hours-to-ms; duration stays computed from the uncorrected window (Kodi parity). */
  catchupCorrectionMs?: number
}): string {
  const base = opts.baseUrl.replace(/\/+$/, "")
  const encodedUsername = encodeURIComponent(opts.username)
  const encodedPassword = encodeURIComponent(opts.password)
  const encodedStreamId = encodeURIComponent(String(opts.streamId))
  const correctedStartUtcMs = opts.startUtcMs - (opts.catchupCorrectionMs ?? 0)
  const start = formatTimeshiftStart(correctedStartUtcMs, opts.serverOffsetMs)
  const ext = opts.extension.replace(/^\.+/, "")

  if (opts.form === "rest") {
    return `${base}/timeshift/${encodedUsername}/${encodedPassword}/${opts.durationMinutes}/${start}/${encodedStreamId}.${ext}`
  }

  const query =
    `username=${encodedUsername}` +
    `&password=${encodedPassword}` +
    `&stream=${encodedStreamId}` +
    `&start=${encodeURIComponent(start)}` +
    `&duration=${opts.durationMinutes}`
  return `${base}/streaming/timeshift.php?${query}`
}

const TIME_NOW_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/

function ianaOffsetMs(timeZone: string, nowMs: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
  const offsetPart = formatter
    .formatToParts(new Date(nowMs))
    .find((part) => part.type === "timeZoneName")?.value ?? ""
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetPart)
  if (!match) throw new Error(`Unrecognized IANA offset format: ${offsetPart}`)
  const sign = match[1] === "-" ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3])
  return sign * (hours * 60 + minutes) * 60000
}

/**
 * Xtream `server_info` reports the server's wall clock (`time_now`) and, when
 * present, a true UTC epoch (`timestamp_now`). The drift between the two is
 * the server's UTC offset; rounded to the nearest 15 minutes to absorb clock
 * skew. Falls back to the IANA `timezone` string, then 0.
 */
export function computeServerOffsetMs(
  serverInfo: { time_now?: string; timestamp_now?: number | string; timezone?: string } | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!serverInfo) return 0

  if (serverInfo.time_now && serverInfo.timestamp_now !== undefined && serverInfo.timestamp_now !== null) {
    const timestampNowSec = Number(serverInfo.timestamp_now)
    const match = TIME_NOW_PATTERN.exec(serverInfo.time_now.trim())
    if (Number.isFinite(timestampNowSec) && match) {
      const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match
      const parsedAsUtcMs = Date.UTC(
        Number(yearStr),
        Number(monthStr) - 1,
        Number(dayStr),
        Number(hourStr),
        Number(minuteStr),
        Number(secondStr),
      )
      const rawOffsetMs = parsedAsUtcMs - timestampNowSec * 1000
      const fifteenMinutesMs = 15 * 60000
      return Math.round(rawOffsetMs / fifteenMinutesMs) * fifteenMinutesMs
    }
  }

  if (serverInfo.timezone) {
    try {
      return ianaOffsetMs(serverInfo.timezone, nowMs)
    } catch {
      return 0
    }
  }

  return 0
}

export interface CatchupTemplateContext {
  startUtcMs: number
  stopUtcMs: number
  nowUtcMs: number
  /** Hours (decimal, may be negative); positive shifts every generated timestamp earlier. Doesn't affect window/playability checks. */
  catchupCorrectionHours?: number | null
  /** Programme-specific `catchup-id` from XMLTV; substituted into `{catchup-id}` last, everywhere it appears. */
  catchupId?: string | null
}

/** Render `date`'s local-time components into an rtp2httpd/Kodi-style colon-format string; only Y/m/d/H/M/S are special, everything else passes through. */
function formatColonPattern(date: Date, pattern: string): string {
  return pattern.replace(/[YmdHMS]/g, (token) => {
    switch (token) {
      case "Y": return String(date.getFullYear())
      case "m": return pad2(date.getMonth() + 1)
      case "d": return pad2(date.getDate())
      case "H": return pad2(date.getHours())
      case "M": return pad2(date.getMinutes())
      case "S": return pad2(date.getSeconds())
      default: return token
    }
  })
}

/** True for playseek/tvdr-dialect templates (rtp2httpd contract): the server accepts a future end instant and keeps streaming toward it. */
export function templateUsesPlayseek(template: string): boolean {
  return /(?:^|[?&])(?:playseek|tvdr)=/i.test(template)
}

/** Expand pvr.iptvsimple-style and TiviMate/diyp-style (`${(b)pattern}`/`${(e)pattern}`) catchup placeholders; unrecognized ones pass through untouched. */
export function expandCatchupTemplate(template: string, ctx: CatchupTemplateContext): string {
  const correctionMs = (ctx.catchupCorrectionHours || 0) * 3600_000
  const rawEndMs = templateUsesPlayseek(template) ? ctx.stopUtcMs : Math.min(ctx.stopUtcMs, ctx.nowUtcMs)
  // duration is a raw end-start delta (both operands would shift equally, so correction is a no-op here).
  const durationSec = Math.floor((rawEndMs - ctx.startUtcMs) / 1000)
  // Kodi parity: only start/end get corrected, so a positive correction grows the offset (now - correctedStart), reaching further back into the archive.
  const offsetSec = Math.floor((ctx.nowUtcMs - (ctx.startUtcMs - correctionMs)) / 1000)

  const startDate = new Date(ctx.startUtcMs - correctionMs)
  const endDate = new Date(rawEndMs - correctionMs)
  const nowDate = new Date(ctx.nowUtcMs)
  const startSec = Math.floor(startDate.getTime() / 1000)
  const endSec = Math.floor(endDate.getTime() / 1000)
  const nowSec = Math.floor(nowDate.getTime() / 1000)

  let result = template
    .replace(/\$\{\((b|e)\)([^}]+)\}/g, (_match, marker, pattern) =>
      formatLocalDatePattern(marker === "b" ? startDate : endDate, pattern),
    )
    .replace(/\{duration:(\d+)\}/g, (_match, divisor) => String(Math.floor(durationSec / Number(divisor))))
    .replace(/\{offset:(\d+)\}/g, (_match, divisor) => String(Math.floor(offsetSec / Number(divisor))))
    .replace(/(?<!\$)\{utc:([^}]*)\}/g, (_match, fmt) => formatColonPattern(startDate, fmt))
    .replace(/\$\{start:([^}]*)\}/g, (_match, fmt) => formatColonPattern(startDate, fmt))
    .replace(/(?<!\$)\{utcend:([^}]*)\}/g, (_match, fmt) => formatColonPattern(endDate, fmt))
    .replace(/\$\{end:([^}]*)\}/g, (_match, fmt) => formatColonPattern(endDate, fmt))
    .replace(/(?<!\$)\{lutc:([^}]*)\}/g, (_match, fmt) => formatColonPattern(nowDate, fmt))
    .replace(/\$\{now:([^}]*)\}/g, (_match, fmt) => formatColonPattern(nowDate, fmt))
    .replace(/\$\{timestamp:([^}]*)\}/g, (_match, fmt) => formatColonPattern(nowDate, fmt))

  // Deliberate superset of Kodi's first-occurrence-only substitution: every occurrence gets replaced, not just the first.
  const replacements: [string, string][] = [
    ["{utc}", String(startSec)],
    ["${start}", String(startSec)],
    ["{utcend}", String(endSec)],
    ["${end}", String(endSec)],
    ["{lutc}", String(nowSec)],
    ["${now}", String(nowSec)],
    ["${timestamp}", String(nowSec)],
    // ${duration} must run before {duration}: it contains that bare form as a substring.
    ["${duration}", String(durationSec)],
    ["{duration}", String(durationSec)],
    ["${offset}", String(offsetSec)],
    ["{Y}", String(startDate.getFullYear())],
    ["{m}", pad2(startDate.getMonth() + 1)],
    ["{d}", pad2(startDate.getDate())],
    ["{H}", pad2(startDate.getHours())],
    ["{M}", pad2(startDate.getMinutes())],
    ["{S}", pad2(startDate.getSeconds())],
  ]
  for (const [placeholder, value] of replacements) {
    result = result.split(placeholder).join(value)
  }

  if (ctx.catchupId) {
    result = result.split("{catchup-id}").join(ctx.catchupId)
  }
  return result
}

// Stage 1: well-formed Flussonic naming (`.../<id>/<listName><mpegts|.m3u8>`); the literal extension decides ts vs. hls, not the requested mode.
const FLUSSONIC_URL_PATTERN = /^(https?:\/\/[^/]+)\/(.*)\/([^/]*)(mpegts|\.m3u8)(\?.*)?$/
// Stage 2: any other Flussonic-shaped URL (server hands back an arbitrary directory name) - here the mode tag decides.
const FLUSSONIC_GENERIC_URL_PATTERN = /^(https?:\/\/[^/]+)\/(.*)\/([^?]*)(\?.*)?$/

function buildFlussonicCatchupUrl(
  url: string,
  mode: string,
  ctx: CatchupTemplateContext,
): string | null {
  const correctionMs = (ctx.catchupCorrectionHours || 0) * 3600_000
  const startEpochSec = Math.floor((ctx.startUtcMs - correctionMs) / 1000)
  // Kodi parity: "now" stays raw, so a positive correction grows the offset, reaching further back.
  const offsetSec = Math.max(0, Math.floor((ctx.nowUtcMs - (ctx.startUtcMs - correctionMs)) / 1000))

  const wellFormedMatch = FLUSSONIC_URL_PATTERN.exec(url)
  if (wellFormedMatch) {
    const [, host, chanId, listName, streamTypeTag, query] = wellFormedMatch
    const queryTail = query ?? ""
    if (streamTypeTag === "mpegts") {
      return `${host}/${chanId}/timeshift_abs-${startEpochSec}.ts${queryTail}`
    }
    if (listName === "index") {
      return `${host}/${chanId}/timeshift_rel-${offsetSec}.m3u8${queryTail}`
    }
    return `${host}/${chanId}/${listName}-timeshift_rel-${offsetSec}.m3u8${queryTail}`
  }

  const genericMatch = FLUSSONIC_GENERIC_URL_PATTERN.exec(url)
  if (genericMatch) {
    const [, host, chanId, , query] = genericMatch
    const queryTail = query ?? ""
    if (mode === "flussonic-ts" || mode === "fs") {
      return `${host}/${chanId}/timeshift_abs-${startEpochSec}.ts${queryTail}`
    }
    if (mode === "flussonic" || mode === "flussonic-hls") {
      return `${host}/${chanId}/timeshift_rel-${offsetSec}.m3u8${queryTail}`
    }
  }
  return null
}

function appendShiftUrl(url: string, ctx: CatchupTemplateContext): string {
  const separator = url.includes("?") ? "&" : "?"
  return url + expandCatchupTemplate(`${separator}utc={utc}&lutc={lutc}`, ctx)
}

/** Build a playable catch-up URL for an M3U channel, or null when the mode needs caller-side credentials (`xc`) or doesn't match. */
export function buildM3uCatchupUrl(
  channel: CatchupCapableChannel,
  ctx: CatchupTemplateContext,
): string | null {
  const url = channel.url ?? ""
  if (!url) return null
  const rawMode = (channel.catchup ?? "").trim().toLowerCase()
  const mode = rawMode === "timeshift" ? "shift" : rawMode
  const source = channel.catchupSource || null

  if (mode === "" || mode === "default") {
    return source ? expandCatchupTemplate(source, ctx) : appendShiftUrl(url, ctx)
  }
  if (mode === "append") {
    return source ? url + expandCatchupTemplate(source, ctx) : appendShiftUrl(url, ctx)
  }
  if (mode === "shift") {
    return appendShiftUrl(url, ctx)
  }
  if (mode === "flussonic" || mode === "flussonic-hls" || mode === "flussonic-ts" || mode === "fs") {
    return buildFlussonicCatchupUrl(url, mode, ctx)
  }
  if (mode === "xc") {
    return null
  }
  if (mode === "vod") {
    if (source) return expandCatchupTemplate(source, ctx)
    // Kodi parity: an empty catchup-source in VOD mode defaults to the bare `{catchup-id}` template.
    return ctx.catchupId ? expandCatchupTemplate("{catchup-id}", ctx) : null
  }
  return source ? expandCatchupTemplate(source, ctx) : null
}

const END_TOKEN_PATTERN = /\{utcend(:[^}]*)?\}|\$\{end(:[^}]*)?\}|\{duration(:\d+)?\}|\$\{duration\}|\$\{\(e\)[^}]+\}/

/** true when a catchup-source template carries an end/duration token, meaning the resulting stream terminates at the requested window end. */
export function templateHasEndToken(template: string): boolean {
  return END_TOKEN_PATTERN.test(template)
}

/** Classify a channel's catch-up mode into the terminates/granularity shape ffmpegdirect uses to gate seek/resume/auto-advance. */
export function streamProfileFor(channel: CatchupCapableChannel): StreamProfile {
  const rawMode = (channel.catchup ?? "").trim().toLowerCase()
  const mode = rawMode === "timeshift" ? "shift" : rawMode

  if (mode === "xc") return { granularitySeconds: 60, terminates: true }
  if (mode === "flussonic" || mode === "flussonic-hls" || mode === "flussonic-ts" || mode === "fs") {
    return { granularitySeconds: 1, terminates: false }
  }
  if (mode === "vod") return { granularitySeconds: 1, terminates: true }
  // buildM3uCatchupUrl always appends a raw utc/lutc pair for shift mode, ignoring catchupSource.
  if (mode === "shift") return { granularitySeconds: 1, terminates: false }

  const source = channel.catchupSource || null
  // playseek ends expand unclamped, so the stream follows live rather than terminating.
  if (source && templateUsesPlayseek(source)) return { granularitySeconds: 1, terminates: false }
  if (source) return { granularitySeconds: 1, terminates: templateHasEndToken(source) }
  return { granularitySeconds: 1, terminates: false }
}

/** Xtream credentials-path mounts carry an explicit duration, so they always terminate on a minute-floored window. */
export const XTREAM_STREAM_PROFILE: StreamProfile = { granularitySeconds: 60, terminates: true }

const XTREAM_STYLE_LIVE_URL_PATTERN =
  /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/([^/.?]+)(\.m3u8|\.ts)?(?:\?.*)?$/

/** Recover Xtream credentials + streamId from a plain `.../<user>/<pass>/<id>` live URL, used when an M3U's `catchup="xc"` really points at an Xtream backend. */
export function parseXtreamStyleLiveUrl(url: string): {
  baseUrl: string
  username: string
  password: string
  streamId: string
  extension: string
} | null {
  const match = XTREAM_STYLE_LIVE_URL_PATTERN.exec(url)
  if (!match) return null
  const [, baseUrl, username, password, streamId, extension] = match
  return {
    baseUrl,
    username,
    password,
    streamId,
    extension: extension ? extension.slice(1) : "ts",
  }
}
