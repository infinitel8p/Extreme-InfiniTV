// Non-pure resolver: turns a (channel, programme-window) request into a playable catch-up src.

import { log } from "@/scripts/lib/log.js"
import { fmtBase } from "@/scripts/lib/creds.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { getServerInfoSync, getCachedUserInfoSync, ensureUserInfo } from "@/scripts/lib/account-info.js"
import {
  buildM3uCatchupUrl,
  buildXtreamTimeshiftUrl,
  clampedDurationMinutes,
  computeServerOffsetMs,
  parseXtreamStyleLiveUrl,
  streamProfileFor,
  XTREAM_STREAM_PROFILE,
  type XtreamTimeshiftForm,
} from "@/scripts/lib/catchup.ts"
import { splitMountStart, type StreamProfile } from "@/scripts/lib/timeshift-math.ts"

export interface CatchupRequestChannel {
  id: number | string
  name?: string
  url?: string
  tvArchive?: number
  tvArchiveDuration?: number
  catchup?: string | null
  catchupDays?: number | null
  catchupSource?: string | null
  catchupCorrection?: number | null
}

export interface CatchupRequest {
  channel: CatchupRequestChannel
  startUtcMs: number
  stopUtcMs: number
  catchupId?: string | null
}

export interface CatchupResolution {
  src: string
  kindHint: "hls" | "ts"
  /** Actual start instant of the mounted segment; the virtual-timeline zero for player.currentTime(). */
  effectiveStartUtcMs: number
  profile: StreamProfile
}

export interface CatchupCreds {
  host: string
  port?: string
  user: string
  pass: string
}

interface CachedVariant {
  form: XtreamTimeshiftForm
  extension: string
}

const VARIANT_KEY_PREFIX = "xt_catchup_variant:"
const PROBE_TIMEOUT_MS = 5000
const SERVER_INFO_WARMUP_TIMEOUT_MS = 5000

function readCachedVariant(playlistId: string): CachedVariant | null {
  if (!playlistId) return null
  try {
    const raw = localStorage.getItem(VARIANT_KEY_PREFIX + playlistId)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.form && parsed?.extension) return parsed
  } catch {}
  return null
}

function writeCachedVariant(playlistId: string, variant: CachedVariant): void {
  if (!playlistId) return
  try {
    localStorage.setItem(VARIANT_KEY_PREFIX + playlistId, JSON.stringify(variant))
  } catch {}
}

async function probeVariantUrl(url: string): Promise<boolean> {
  if (typeof AbortController === "undefined") return true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await providerFetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      signal: controller.signal,
      logKind: "media",
    })
    const reachable = response.ok || response.status === 206
    // Timeshift streams are endless; cancel so the probe doesn't hold a provider connection slot.
    try { void response.body?.cancel?.()?.catch?.(() => {}) } catch {}
    return reachable
  } catch (err) {
    log.warn("[xt:catchup] variant probe failed:", url, String((err as Error)?.message || err))
    return false
  } finally {
    clearTimeout(timer)
    try { controller.abort() } catch {}
  }
}

function extensionToKindHint(extension: string): "hls" | "ts" {
  return extension === "m3u8" ? "hls" : "ts"
}

type ServerInfo = Parameters<typeof computeServerOffsetMs>[0]

/** Cold-start fallback: waits (bounded) for the account-info warmup so the timeshift offset isn't silently 0. */
async function warmServerInfo(creds: CatchupCreds, playlistId: string): Promise<ServerInfo> {
  try {
    const data = await Promise.race([
      ensureUserInfo(creds, playlistId),
      new Promise<{ server_info?: ServerInfo } | null>((resolve) =>
        setTimeout(() => resolve(null), SERVER_INFO_WARMUP_TIMEOUT_MS),
      ),
    ])
    return data?.server_info ?? null
  } catch {
    return null
  }
}

async function resolveXtreamCatchup(
  playlistId: string,
  creds: CatchupCreds,
  base: { baseUrl: string; username: string; password: string; streamId: string | number },
  startUtcMs: number,
  stopUtcMs: number,
  catchupCorrectionMs: number,
): Promise<CatchupResolution | null> {
  const durationMinutes = clampedDurationMinutes(startUtcMs, stopUtcMs, Date.now())
  const serverInfo = getServerInfoSync(playlistId) ?? (await warmServerInfo(creds, playlistId))
  const serverOffsetMs = computeServerOffsetMs(serverInfo)

  const allowedOutputFormats = getCachedUserInfoSync(playlistId)?.user_info?.allowed_output_formats
  const allowsM3u8 =
    !Array.isArray(allowedOutputFormats) ||
    allowedOutputFormats.map((format: unknown) => String(format).toLowerCase()).includes("m3u8")

  const extensions = allowsM3u8 ? ["m3u8", "ts"] : ["ts"]
  const forms: XtreamTimeshiftForm[] = ["rest", "legacy"]

  // Last-known-good wire format first, then rest+m3u8 -> legacy+m3u8 -> rest+ts -> legacy+ts.
  const candidates: CachedVariant[] = []
  const cached = readCachedVariant(playlistId)
  if (cached && extensions.includes(cached.extension)) candidates.push(cached)
  for (const extension of extensions) {
    for (const form of forms) {
      if (cached && cached.form === form && cached.extension === extension) continue
      candidates.push({ form, extension })
    }
  }

  for (const variant of candidates) {
    const url = buildXtreamTimeshiftUrl({
      baseUrl: base.baseUrl,
      username: base.username,
      password: base.password,
      streamId: base.streamId,
      startUtcMs,
      durationMinutes,
      serverOffsetMs,
      extension: variant.extension,
      form: variant.form,
      catchupCorrectionMs,
    })
    if (await probeVariantUrl(url)) {
      writeCachedVariant(playlistId, variant)
      return {
        src: url,
        kindHint: extensionToKindHint(variant.extension),
        effectiveStartUtcMs: splitMountStart(startUtcMs, "minute").mountStartUtcMs,
        profile: XTREAM_STREAM_PROFILE,
      }
    }
  }
  log.warn("[xt:catchup] all timeshift variants failed", { playlistId, streamId: base.streamId })
  return null
}

/** Resolve a playable catch-up src for a channel + programme window. Returns null when every candidate fails. */
export async function resolveCatchupSrc(
  playlistId: string,
  creds: CatchupCreds,
  request: CatchupRequest,
): Promise<CatchupResolution | null> {
  const { channel, startUtcMs, stopUtcMs, catchupId } = request
  const mode = (channel.catchup ?? "").trim().toLowerCase()

  if (channel.url && mode !== "xc") {
    const url = buildM3uCatchupUrl(channel, {
      startUtcMs,
      stopUtcMs,
      nowUtcMs: Date.now(),
      catchupCorrectionHours: channel.catchupCorrection,
      catchupId,
    })
    if (!url) return null
    const path = url.split("?")[0] || ""
    const kindHint: "hls" | "ts" = /\.m3u8$/i.test(path) ? "hls" : "ts"
    return {
      src: url,
      kindHint,
      effectiveStartUtcMs: splitMountStart(startUtcMs, "second").mountStartUtcMs,
      profile: streamProfileFor(channel),
    }
  }

  const catchupCorrectionMs = (channel.catchupCorrection ?? 0) * 3_600_000

  if (mode === "xc") {
    const parsed = parseXtreamStyleLiveUrl(channel.url || "")
    if (!parsed) return null
    return resolveXtreamCatchup(
      playlistId,
      creds,
      { baseUrl: parsed.baseUrl, username: parsed.username, password: parsed.password, streamId: parsed.streamId },
      startUtcMs,
      stopUtcMs,
      catchupCorrectionMs,
    )
  }

  if (!creds?.host || !creds?.user || !creds?.pass) return null
  const baseUrl = fmtBase(creds.host, creds.port)
  return resolveXtreamCatchup(
    playlistId,
    creds,
    { baseUrl, username: creds.user, password: creds.pass, streamId: channel.id },
    startUtcMs,
    stopUtcMs,
    catchupCorrectionMs,
  )
}
