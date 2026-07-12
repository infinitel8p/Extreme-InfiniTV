// Pure helpers for IPTV catch-up (archive) playback: availability gating, Xtream timeshift URLs, clock drift, M3U catchup templates.

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
}): string {
  const base = opts.baseUrl.replace(/\/+$/, "")
  const encodedUsername = encodeURIComponent(opts.username)
  const encodedPassword = encodeURIComponent(opts.password)
  const encodedStreamId = encodeURIComponent(String(opts.streamId))
  const start = formatTimeshiftStart(opts.startUtcMs, opts.serverOffsetMs)
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
}

/** Expand pvr.iptvsimple-style and TiviMate/diyp-style (`${(b)pattern}`/`${(e)pattern}`) catchup placeholders; unrecognized ones pass through untouched. */
export function expandCatchupTemplate(template: string, ctx: CatchupTemplateContext): string {
  const endMs = Math.min(ctx.stopUtcMs, ctx.nowUtcMs)
  const startSec = Math.floor(ctx.startUtcMs / 1000)
  const endSec = Math.floor(endMs / 1000)
  const nowSec = Math.floor(ctx.nowUtcMs / 1000)
  const durationSec = Math.floor((endMs - ctx.startUtcMs) / 1000)
  const offsetSec = Math.floor((ctx.nowUtcMs - ctx.startUtcMs) / 1000)
  const startDate = new Date(ctx.startUtcMs)
  const endDate = new Date(endMs)

  let result = template
    .replace(/\$\{\((b|e)\)([^}]+)\}/g, (_match, marker, pattern) =>
      formatLocalDatePattern(marker === "b" ? startDate : endDate, pattern),
    )
    .replace(/\{duration:(\d+)\}/g, (_match, divisor) => String(Math.floor(durationSec / Number(divisor))))
    .replace(/\{offset:(\d+)\}/g, (_match, divisor) => String(Math.floor(offsetSec / Number(divisor))))

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
    ["{Y}", String(startDate.getUTCFullYear())],
    ["{m}", pad2(startDate.getUTCMonth() + 1)],
    ["{d}", pad2(startDate.getUTCDate())],
    ["{H}", pad2(startDate.getUTCHours())],
    ["{M}", pad2(startDate.getUTCMinutes())],
    ["{S}", pad2(startDate.getUTCSeconds())],
  ]
  for (const [placeholder, value] of replacements) {
    result = result.split(placeholder).join(value)
  }
  return result
}

const FLUSSONIC_URL_PATTERN = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/?]+)(\?.*)?$/

function buildFlussonicCatchupUrl(
  url: string,
  mode: string,
  ctx: CatchupTemplateContext,
): string | null {
  const match = FLUSSONIC_URL_PATTERN.exec(url)
  if (!match) return null
  const [, host, chanId, listName, query] = match
  const queryTail = query ?? ""
  const startEpochSec = Math.floor(ctx.startUtcMs / 1000)
  const offsetSec = Math.floor((ctx.nowUtcMs - ctx.startUtcMs) / 1000)

  if (mode === "fs" || mode === "flussonic-ts" || listName === "mpegts") {
    return `${host}/${chanId}/timeshift_abs-${startEpochSec}.ts${queryTail}`
  }
  if (listName === "index.m3u8") {
    return `${host}/${chanId}/timeshift_rel-${offsetSec}.m3u8${queryTail}`
  }
  const listNameWithoutExt = listName.replace(/\.m3u8$/, "")
  return `${host}/${chanId}/${listNameWithoutExt}-timeshift_rel-${offsetSec}.m3u8${queryTail}`
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
    return source ? expandCatchupTemplate(source, ctx) : null
  }
  return source ? expandCatchupTemplate(source, ctx) : null
}

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
