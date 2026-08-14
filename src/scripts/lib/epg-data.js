// Shared EPG data layer for /livetv and /epg.

import { log } from "@/scripts/lib/log.js"
import {
  fmtBase,
  isLikelyM3USource,
  getEntries,
  entryToCreds,
} from "@/scripts/lib/creds.js"
import { loadCustomDoc } from "@/scripts/lib/custom-playlist.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  setCached as cacheSet,
  getCached as cacheGet,
  hydrate as cacheHydrate,
  invalidatePrefix as cacheInvalidatePrefix,
} from "@/scripts/lib/cache.js"
import { getChannelEpgOverride } from "@/scripts/lib/preferences.js"
import { retryWithBackoff, HttpRetryError } from "@/scripts/lib/retry.ts"
import { EPG_PAST_WINDOW_MS } from "@/scripts/lib/epg-constants.ts"

const FRESH_MS = 60 * 60 * 1000
const TZ_KEY_PREFIX = "xt_epg_offset:"
const TZ_INFERRED_KEY_PREFIX = "xt_epg_offset_inferred:"
const EPG_HTTP_META_PREFIX = "xt_epg_http:"
const EPG_CACHE_KIND_PREFIX = "epg_parsed"
const EPG_CACHE_TTL = 4 * 60 * 60 * 1000
const EVT_LOADED = "xt:epg-loaded"
const EVT_OFFSET_CHANGED = "xt:epg-offset-changed"
const EVT_SOURCE_STATUS = "xt:epg-source-status"
const GZIP_CT_RX = /application\/(x-)?gzip|application\/x-gunzip/i
export { EPG_PAST_WINDOW_MS }

// FNV-1a 32-bit hash. Deterministic, short, no crypto needed - just used to
// derive a per-URL cache key suffix.
function urlHash(url) {
  let h = 0x811c9dc5
  const s = String(url)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

function cacheKindFor(url) {
  return `${EPG_CACHE_KIND_PREFIX}:${urlHash(url)}`
}

async function findEntry(playlistId) {
  if (!playlistId) return null
  try {
    const entries = await getEntries()
    return entries.find((entry) => entry._id === playlistId) || null
  } catch {
    return null
  }
}

/**
 * @typedef {Object} EpgSource
 * @property {string} url
 * @property {"override"|"m3u-header"|"xtream-default"|"custom-sources"|"additional"} source
 * @property {"primary"|"additional"} kind
 */

// Splits only on commas followed by a URL scheme (or protocol-relative //) so query-string commas survive.
function splitHeaderEpgUrls(raw) {
  if (!raw || typeof raw !== "string") return []
  const seen = new Set()
  const out = []
  for (const part of raw.split(/\s*,+\s*(?=(?:https?:)?\/\/)/i)) {
    const trimmed = part.trim()
    if (!trimmed || !/^(?:https?:)?\/\//i.test(trimmed) || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Pure URL-resolution helper. Given the playlist entry, the creds, and the
 * M3U `x-tvg-url` header value (already loaded by the caller, since storage
 * is async on Tauri), build the ordered source list:
 *   1. user-supplied primary `epgUrl` if set, else the auto-detected source
 *      (provider default for Xtream / `x-tvg-url` for M3U - a comma-joined
 *      list becomes primary + additional `m3u-header` sources). Auto-detect
 *      is suppressed when `entry.disableProviderEpg` is true - lets the user
 *      verify their custom additional sources in isolation.
 *   2. each `additionalEpgUrls[]` entry, in order, deduped against the primary
 *
 * Returns an empty list when no usable source is available.
 *
 * @param {{ type?: string, epgUrl?: string, additionalEpgUrls?: string[], disableProviderEpg?: boolean } | null} entry
 * @param {{host:string,port:string,user:string,pass:string}} creds
 * @param {string} m3uHeaderUrl - raw (possibly comma-joined) `x-tvg-url` value for M3U playlists, or ""
 * @param {string[]} [customSourceUrls] - custom playlist only: provider EPG URLs
 *   unioned from every source entry (already resolved by the async wrapper)
 * @returns {EpgSource[]}
 */
export function buildEpgUrlsFromEntry(entry, creds, m3uHeaderUrl, customSourceUrls = []) {
  const out = []
  const seen = new Set()
  const skipAuto = !!entry?.disableProviderEpg

  const push = (url, source, kind) => {
    const trimmed = typeof url === "string" ? url.trim() : ""
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push({ url: trimmed, source, kind })
  }

  if (entry?.epgUrl) {
    push(entry.epgUrl, "override", "primary")
  } else if (!skipAuto && entry?.type === "custom") {
    for (const url of customSourceUrls) push(url, "custom-sources", "primary")
  } else if (!skipAuto && isLikelyM3USource(creds?.host, creds?.user, creds?.pass)) {
    const headerUrls = splitHeaderEpgUrls(m3uHeaderUrl)
    headerUrls.forEach((url, index) => {
      push(url, "m3u-header", index === 0 ? "primary" : "additional")
    })
  } else if (!skipAuto && creds?.host) {
    const base = fmtBase(creds.host, creds.port).replace(/\/+$/, "")
    const url =
      `${base}/xmltv.php?username=${encodeURIComponent(creds.user || "")}` +
      `&password=${encodeURIComponent(creds.pass || "")}`
    push(url, "xtream-default", "primary")
  }

  if (Array.isArray(entry?.additionalEpgUrls)) {
    for (const extra of entry.additionalEpgUrls) {
      push(extra, "additional", "additional")
    }
  }

  return out
}

/** Custom playlist only: union of every source entry's provider default EPG URL. */
async function collectCustomSourceEpgUrls(playlistId) {
  const doc = await loadCustomDoc(playlistId)
  const sourceEntryIds = new Set()
  for (const channel of doc.channels) {
    if (!Array.isArray(channel.sources)) continue
    for (const source of channel.sources) {
      if (source.kind === "xtream" || source.kind === "m3u") sourceEntryIds.add(source.entryId)
    }
  }
  if (!sourceEntryIds.size) return []
  const entries = await getEntries()
  const resolvedUrls = await Promise.all(
    [...sourceEntryIds].map(async (sourceEntryId) => {
      const sourceEntry = entries.find((candidate) => candidate._id === sourceEntryId)
      if (!sourceEntry) return null
      if (sourceEntry.type === "xtream") {
        const sourceCreds = entryToCreds(sourceEntry)
        const base = fmtBase(sourceCreds.host, sourceCreds.port).replace(/\/+$/, "")
        return (
          `${base}/xmltv.php?username=${encodeURIComponent(sourceCreds.user || "")}` +
          `&password=${encodeURIComponent(sourceCreds.pass || "")}`
        )
      }
      let stored = ""
      try { stored = localStorage.getItem(`xt_m3u_epg:${sourceEntryId}`) || "" } catch {}
      if (!stored) {
        // A never-opened m3u source has no cached x-tvg-url yet; warm it once so its default EPG isn't silently dropped.
        try {
          const { ensureLive } = await import("@/scripts/lib/catalog.js")
          await ensureLive(entryToCreds(sourceEntry), sourceEntryId)
          stored = localStorage.getItem(`xt_m3u_epg:${sourceEntryId}`) || ""
        } catch {}
      }
      return splitHeaderEpgUrls(stored)
    })
  )
  return resolvedUrls.flat().filter(Boolean)
}

/**
 * Storage-aware wrapper: loads the active entry and the M3U `x-tvg-url`
 * header (if any) then delegates to `buildEpgUrlsFromEntry`.
 *
 * @param {{host:string,port:string,user:string,pass:string}} creds
 * @param {string} playlistId
 * @returns {Promise<EpgSource[]>}
 */
export async function buildEpgUrls(creds, playlistId) {
  const entry = await findEntry(playlistId)
  let m3uHeaderUrl = ""
  try {
    m3uHeaderUrl = localStorage.getItem(`xt_m3u_epg:${playlistId}`) || ""
  } catch {}
  let customSourceUrls = []
  if (entry?.type === "custom" && !entry.epgUrl && !entry.disableProviderEpg) {
    customSourceUrls = await collectCustomSourceEpgUrls(playlistId)
  }
  return buildEpgUrlsFromEntry(entry, creds, m3uHeaderUrl, customSourceUrls)
}

/**
 * Waterfall-merge a sequence of `tvg-id -> programmes[]` maps. The first
 * map's keys always win on conflict; each subsequent map only fills in
 * `tvg-id`s that no earlier map supplied. Used so user-supplied additional
 * EPG sources can plug coverage gaps without overwriting the primary's
 * programmes.
 *
 * @param {Array<Map<string, any[]>>} maps
 * @returns {Map<string, any[]>}
 */
export function mergeProgrammeMaps(maps) {
  const out = new Map()
  for (const map of maps) {
    if (!map) continue
    for (const [tvgId, programmes] of map) {
      if (!out.has(tvgId)) out.set(tvgId, programmes)
    }
  }
  return out
}

/**
 * Same waterfall semantics as mergeProgrammeMaps, but for the
 * tvg-id -> display-name map collected from <channel> elements.
 *
 * @param {Array<Map<string, string>>} maps
 * @returns {Map<string, string>}
 */
export function mergeChannelNameMaps(maps) {
  const out = new Map()
  for (const map of maps) {
    if (!map) continue
    for (const [tvgId, name] of map) {
      if (!out.has(tvgId) && name) out.set(tvgId, name)
    }
  }
  return out
}

/** @typedef {{ start:number, stop:number, title:string, desc:string, catchupId?:string, rawStart?:number, rawStop?:number }} Programme */

/**
 * @typedef {Object} EpgState
 * @property {Map<string, Programme[]>} programmes - keyed by tvgId (lower-cased)
 * @property {Map<string, string>} channelNames - lower-cased tvgId -> display name (from XMLTV <channel><display-name>)
 * @property {number} fetchedAt   - epoch ms
 * @property {number} offsetMin   - minutes added to raw XMLTV timestamps
 * @property {boolean} offsetIsAuto - true when offsetMin came from auto-detect
 */

/** @type {Map<string, EpgState>} */
const memCache = new Map()
/** @type {Map<string, Promise<EpgState | null>>} */
const inflight = new Map()

// ---------------------------------------------------------------------------
// Worker-backed XMLTV parsing. Falls back to main-thread parseXmlTv when
// Worker construction fails (web build SSR snapshot, sandboxed contexts) or
// when the worker reports it can't access DOMParser.
// ---------------------------------------------------------------------------
/** @type {Worker | null} */
let xmlWorker = null
let xmlWorkerBroken = false
let xmlWorkerSeq = 0
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>} */
const xmlWorkerPending = new Map()

function getXmlWorker() {
  if (xmlWorkerBroken) return null
  if (xmlWorker) return xmlWorker
  if (typeof Worker === "undefined") {
    xmlWorkerBroken = true
    return null
  }
  try {
    xmlWorker = new Worker(
      new URL("./epg-worker.ts", import.meta.url),
      { type: "module" }
    )
    xmlWorker.addEventListener("message", (event) => {
      const data = event.data || {}
      const pending = xmlWorkerPending.get(data.id)
      if (!pending) return
      xmlWorkerPending.delete(data.id)
      pending.resolve(data)
    })
    xmlWorker.addEventListener("error", (event) => {
      log.warn("[xt:epg-worker] error:", event?.message || event)
      xmlWorkerBroken = true
      xmlWorker?.terminate()
      xmlWorker = null
      for (const pending of xmlWorkerPending.values()) {
        pending.reject(new Error("epg worker error"))
      }
      xmlWorkerPending.clear()
    })
    return xmlWorker
  } catch (error) {
    log.warn("[xt:epg-worker] construct failed:", error)
    xmlWorkerBroken = true
    return null
  }
}

async function parseXmlTvOffMain(xml) {
  const worker = getXmlWorker()
  if (!worker) return parseXmlTv(xml)
  const id = ++xmlWorkerSeq
  let reply = null
  try {
    reply = await new Promise((resolve, reject) => {
      xmlWorkerPending.set(id, { resolve, reject })
      worker.postMessage({ id, xml })
    })
  } catch (err) {
    log.warn(
      "[xt:epg-data] worker parse failed, parsing on main thread (may jank for large EPGs):",
      err?.message || err
    )
    return parseXmlTv(xml)
  }
  if (!reply || reply.fallback) {
    log.warn("[xt:epg-data] worker reported fallback, parsing on main thread")
    return parseXmlTv(xml)
  }
  if (reply.error) throw new Error(reply.error)
  return {
    programmes: new Map(reply.programmes),
    channelNames: new Map(reply.channelNames || []),
    hasExplicitTimezones: !!reply.hasExplicitTimezones,
  }
}

// ---------------------------------------------------------------------------
// XMLTV parsing
// ---------------------------------------------------------------------------
export function parseXmlTvDate(s) {
  if (!s) return 0
  const trimmed = String(s).trim()
  // 14 digits, optional space + signed 4-digit offset.
  const m = trimmed.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/
  )
  if (!m) return 0
  const [, y, mo, d, h, mi, s2, sign, oh, om] = m
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s2)
  if (!sign) return utc
  const offsetMs = (parseInt(oh, 10) * 60 + parseInt(om, 10)) * 60 * 1000
  return sign === "+" ? utc - offsetMs : utc + offsetMs
}

// Same shape as the sign group in parseXmlTvDate's regex - detects whether a raw
// XMLTV timestamp carried an explicit offset rather than a floating local time.
const TZ_SUFFIX_RX = /^\d{14}\s*[+-]\d{4}$/
function hasTzSuffix(raw) {
  return TZ_SUFFIX_RX.test(String(raw || "").trim())
}

/**
 * @param {string} xml
 * @returns {{ programmes: Map<string, Programme[]>, channelNames: Map<string, string>, hasExplicitTimezones: boolean }}
 */
export function parseXmlTv(xml) {
  /** @type {Map<string, Programme[]>} */
  const programmes = new Map()
  /** @type {Map<string, string>} */
  const channelNames = new Map()
  const sanitized = xml.replace(/<!DOCTYPE[^>[]*>/i, "")
  if (/<!DOCTYPE\b/i.test(sanitized) || /<!ENTITY\b/i.test(sanitized)) {
    throw new Error("XMLTV contains forbidden DOCTYPE/ENTITY declaration")
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/xml")
  const err = doc.querySelector("parsererror")
  if (err) throw new Error("XMLTV parse error: " + err.textContent.slice(0, 200))

  // <channel id="..."><display-name>..</display-name></channel>.
  // Collected so the manual EPG-mapping picker can show readable names
  // alongside raw tvg-ids. First display-name wins when several are present
  // (XMLTV often carries one per locale).
  for (const channel of doc.querySelectorAll("channel")) {
    const id = (channel.getAttribute("id") || "").toLowerCase()
    if (!id) continue
    const name =
      channel.querySelector("display-name")?.textContent?.trim() || ""
    if (name) channelNames.set(id, name)
  }

  const lo = Date.now() - EPG_PAST_WINDOW_MS
  const hi = Date.now() + 36 * 60 * 60 * 1000

  let timezoneTimestampCount = 0
  let timezoneSuffixCount = 0

  const list = doc.querySelectorAll("programme")
  for (const programme of list) {
    const channel = (programme.getAttribute("channel") || "").toLowerCase()
    if (!channel) continue
    const startRaw = programme.getAttribute("start") || ""
    const stopRaw = programme.getAttribute("stop") || ""
    if (startRaw) {
      timezoneTimestampCount++
      if (hasTzSuffix(startRaw)) timezoneSuffixCount++
    }
    if (stopRaw) {
      timezoneTimestampCount++
      if (hasTzSuffix(stopRaw)) timezoneSuffixCount++
    }
    const start = parseXmlTvDate(startRaw)
    const stop = parseXmlTvDate(stopRaw)
    if (!start || !stop || stop <= start) continue
    if (stop < lo || start > hi) continue

    const title = programme.querySelector("title")?.textContent?.trim() || "Untitled"
    const desc = programme.querySelector("desc")?.textContent?.trim() || ""
    // Non-standard, some catchup providers require a programme-specific id in the catchup URL.
    const catchupId = programme.getAttribute("catchup-id") || undefined

    let arr = programmes.get(channel)
    if (!arr) {
      arr = []
      programmes.set(channel, arr)
    }
    arr.push({ start, stop, title, desc, catchupId })
  }

  for (const arr of programmes.values()) {
    arr.sort((first, second) => first.start - second.start)
    let lastStop = -Infinity
    let writeIdx = 0
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].start >= lastStop) {
        arr[writeIdx++] = arr[i]
        lastStop = arr[i].stop
      }
    }
    arr.length = writeIdx
  }
  const hasExplicitTimezones =
    timezoneTimestampCount > 0 && timezoneSuffixCount > timezoneTimestampCount / 2
  return { programmes, channelNames, hasExplicitTimezones }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
/** Binary-search current/next lookup shared by `getNowNext` and `getNowNextForChannel`. */
function getNowNextFromArray(arr, atMs) {
  if (!arr || !arr.length) return { current: null, next: null }

  let lo = 0
  let hi = arr.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].start <= atMs) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  let current = null
  let next = null
  if (best >= 0 && arr[best].stop > atMs) current = arr[best]
  const afterIdx = current ? best + 1 : Math.max(0, best + 1)
  if (afterIdx < arr.length) next = arr[afterIdx]
  return { current, next }
}

/**
 * @param {Map<string, Programme[]>} programmes
 * @param {string|undefined|null} tvgId
 * @param {number} [atMs]
 * @returns {{ current: Programme|null, next: Programme|null }}
 */
export function getNowNext(programmes, tvgId, atMs = Date.now()) {
  if (!programmes || !tvgId) return { current: null, next: null }
  const arr = programmes.get(String(tvgId).toLowerCase())
  return getNowNextFromArray(arr, atMs)
}

/** Shifted copy of a channel's programmes; `rawStart`/`rawStop` keep the true XMLTV time for catch-up. */
export function shiftChannelProgrammes(programmes, tvgShiftHours) {
  if (!programmes || !programmes.length) return programmes || []
  const hours = Number(tvgShiftHours)
  if (!Number.isFinite(hours) || hours === 0) return programmes
  const shiftMs = hours * 60 * 60 * 1000
  return programmes.map((programme) => ({
    ...programme,
    start: programme.start + shiftMs,
    stop: programme.stop + shiftMs,
    rawStart: programme.start,
    rawStop: programme.stop,
  }))
}

/** Like `getNowNext`, but resolves tvg-id + tvg-shift first (catch-up math calls `getNowNext` directly). */
export function getNowNextForChannel(programmes, channel, playlistId, atMs = Date.now()) {
  if (!programmes || !channel) return { current: null, next: null }
  const tvgId = effectiveTvgId(channel, playlistId)
  if (!tvgId) return { current: null, next: null }
  const arr = programmes.get(String(tvgId).toLowerCase())
  const shifted = shiftChannelProgrammes(arr, channel.tvgShift)
  return getNowNextFromArray(shifted, atMs)
}

// ---------------------------------------------------------------------------
// Timezone offset
// ---------------------------------------------------------------------------
const TZ_CANDIDATE_MIN = -12 * 60
const TZ_CANDIDATE_MAX = 14 * 60
const TZ_CANDIDATE_STEP = 30

// Minimum score lead a challenger needs over the sticky preferred offset
// before we let it take over - keeps the result from flipping between two
// near-tied candidates across otherwise-identical loads.
const TZ_PREFERRED_SWITCH_MARGIN = 2

/**
 * @param {Map<string, Programme[]>} programmes
 * @param {number} [preferredOffsetMin] - last inferred offset for this playlist, if any
 * @returns {number}
 */
export function inferTimezoneOffsetMin(programmes, preferredOffsetMin) {
  if (!programmes || !programmes.size) return 0
  const now = Date.now()
  /** @type {Programme[][]} */
  const channels = []
  for (const arr of programmes.values()) {
    if (arr.length) channels.push(arr)
    if (channels.length >= 50) break
  }
  if (!channels.length) return 0

  const hasPreferred = Number.isFinite(preferredOffsetMin)
  let bestOffset = 0
  let bestScore = -1
  let preferredScore = -1
  for (
    let off = TZ_CANDIDATE_MIN;
    off <= TZ_CANDIDATE_MAX;
    off += TZ_CANDIDATE_STEP
  ) {
    const shift = off * 60 * 1000
    let score = 0
    for (const arr of channels) {
      let lo = 0
      let hi = arr.length - 1
      let foundLive = false
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const s = arr[mid].start + shift
        const e = arr[mid].stop + shift
        if (s <= now && now < e) {
          foundLive = true
          break
        }
        if (s > now) hi = mid - 1
        else lo = mid + 1
      }
      if (foundLive) score++
    }

    if (hasPreferred && off === preferredOffsetMin) preferredScore = score

    if (
      score > bestScore ||
      (score === bestScore && Math.abs(off) < Math.abs(bestOffset))
    ) {
      bestScore = score
      bestOffset = off
    }
  }

  if (!hasPreferred || bestOffset === preferredOffsetMin) return bestOffset
  return bestScore >= preferredScore + TZ_PREFERRED_SWITCH_MARGIN
    ? bestOffset
    : preferredOffsetMin
}

// Any explicit-tz source disables inference: applyOffset shifts all merged programmes and would double-shift the already-correct ones.
/**
 * @param {boolean} anySourceHasExplicitTimezones
 * @param {Map<string, Programme[]>} programmes
 * @param {number} [preferredOffsetMin]
 * @returns {number}
 */
export function resolveAutoOffsetMin(
  anySourceHasExplicitTimezones,
  programmes,
  preferredOffsetMin
) {
  if (anySourceHasExplicitTimezones) return 0
  return inferTimezoneOffsetMin(programmes, preferredOffsetMin)
}

function applyOffset(programmes, offsetMin) {
  if (!offsetMin) return
  const shift = offsetMin * 60 * 1000
  for (const arr of programmes.values()) {
    for (const programme of arr) {
      programme.start += shift
      programme.stop += shift
    }
  }
}

/**
 * @param {string} playlistId
 * @returns {"auto"|number}
 */
export function getOffsetSetting(playlistId) {
  if (!playlistId) return "auto"
  try {
    const raw = localStorage.getItem(TZ_KEY_PREFIX + playlistId)
    if (!raw || raw === "auto") return "auto"
    const n = Number(raw)
    return Number.isFinite(n) ? n : "auto"
  } catch {
    return "auto"
  }
}

/**
 * @param {string} playlistId
 * @param {"auto"|number} value
 */
export function setOffsetSetting(playlistId, value) {
  if (!playlistId) return
  try {
    if (value === "auto") localStorage.removeItem(TZ_KEY_PREFIX + playlistId)
    else localStorage.setItem(TZ_KEY_PREFIX + playlistId, String(value))
  } catch {}
  memCache.delete(playlistId)
  document.dispatchEvent(
    new CustomEvent(EVT_OFFSET_CHANGED, { detail: { playlistId, value } })
  )
}

/**
 * Last auto-inferred offset for a playlist, persisted so re-inference on
 * every fresh EPG load prefers the previous result instead of flip-flopping
 * between near-tied candidates.
 *
 * @param {string} playlistId
 * @returns {number|undefined}
 */
function readInferredOffsetSetting(playlistId) {
  if (!playlistId) return undefined
  try {
    const raw = localStorage.getItem(TZ_INFERRED_KEY_PREFIX + playlistId)
    if (raw == null) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {string} playlistId
 * @param {number} offsetMin
 */
function writeInferredOffsetSetting(playlistId, offsetMin) {
  if (!playlistId) return
  try {
    localStorage.setItem(TZ_INFERRED_KEY_PREFIX + playlistId, String(offsetMin))
  } catch {}
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
/**
 * Per-URL HTTP cache validators, stored as one JSON blob per playlist:
 *   { [urlHash]: { lastModified, etag } }
 * Used to send `If-Modified-Since` / `If-None-Match` and short-circuit on
 * 304. Migrated transparently from the pre-multi-source single-source shape
 * (`{ lastModified, etag }` at the top level).
 */
function readEpgHttpMeta(playlistId) {
  if (!playlistId) return {}
  try {
    const raw = localStorage.getItem(EPG_HTTP_META_PREFIX + playlistId)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    // Legacy single-source shape: { lastModified, etag } at the top level.
    if ("lastModified" in parsed || "etag" in parsed) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeEpgHttpMeta(playlistId, meta) {
  if (!playlistId) return
  try {
    if (!meta || !Object.keys(meta).length) {
      localStorage.removeItem(EPG_HTTP_META_PREFIX + playlistId)
    } else {
      localStorage.setItem(EPG_HTTP_META_PREFIX + playlistId, JSON.stringify(meta))
    }
  } catch {}
}

/**
 * Pure-function gzip detector: returns true if the bytes look gzipped via
 * any of (a) magic-byte prefix 1F 8B (the only fully reliable signal -
 * some upstreams send gzip without setting any header), (b) Content-Type,
 * (c) Content-Disposition filename, (d) URL extension.
 *
 * @param {string} url
 * @param {Uint8Array} bytes
 * @param {{ contentType?: string, contentDisposition?: string }} headers
 */
export function detectGzip(url, bytes, headers = {}) {
  if (bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return true
  }
  const ct = headers.contentType || ""
  const cd = headers.contentDisposition || ""
  const lower = String(url || "").toLowerCase().split("?")[0] ?? ""
  return (
    lower.endsWith(".gz") ||
    lower.endsWith(".gzip") ||
    GZIP_CT_RX.test(ct) ||
    /\.gz["']?(\s|$|;)/i.test(cd)
  )
}

async function readResponseAsXml(url, response) {
  // Read body to a buffer first so we can sniff magic bytes regardless of
  // what the server claims via headers - some upstreams send gzip without
  // any of: Content-Encoding, Content-Type matching gzip, or `.gz` URL ext.
  // The 1F 8B prefix is the only fully reliable signal.
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const looksGzipped = detectGzip(url, bytes, {
    contentType: response.headers?.get?.("content-type") || "",
    contentDisposition: response.headers?.get?.("content-disposition") || "",
  })

  if (!looksGzipped) return new TextDecoder("utf-8").decode(bytes)
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "This browser/WebView can't decompress gzipped EPG payloads. Try a provider that serves plain XML."
    )
  }
  const sourceStream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const decompressed = sourceStream.pipeThrough(new DecompressionStream("gzip"))
  return new Response(decompressed).text()
}

/**
 * Conditional EPG fetch for a single URL. Returns either { notModified: true }
 * or { notModified: false, xml, lastModified, etag }.
 *
 * Forces the Tauri `plugin-http` path on desktop / Android so EPG fetches
 * bypass browser CORS - the only way arbitrary XMLTV hosts (iptv-org,
 * epgshare, free-epg.de etc.) work, since they don't send
 * `Access-Control-Allow-Origin`. On the web build there's no escape; we
 * surface a clearer error than the bare `TypeError: Failed to fetch` the
 * browser emits in that case.
 */
async function fetchEpgConditional(url, meta) {
  const headers = {}
  if (meta?.lastModified) headers["If-Modified-Since"] = meta.lastModified
  if (meta?.etag) headers["If-None-Match"] = meta.etag
  const init = { forceTauri: true, logKind: "epg" }
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    init.signal = AbortSignal.timeout(90_000)
  }
  if (Object.keys(headers).length) init.headers = headers
  let response
  try {
    response = await providerFetch(url, init)
  } catch (err) {
    if (isLikelyCorsError(err)) {
      throw new Error(
        "Blocked by browser CORS. This source has no Access-Control-Allow-Origin header. Open the desktop or Android build to use it (Tauri bypasses CORS), or pick a host that sends the header."
      )
    }
    throw err
  }
  if (response.status === 304) {
    return { notModified: true, url }
  }
  if (!response.ok) {
    throw new HttpRetryError(
      response.status,
      `EPG ${response.status} ${response.statusText}`
    )
  }
  const xml = await readResponseAsXml(url, response)
  return {
    notModified: false,
    xml,
    lastModified: response.headers?.get?.("last-modified") || null,
    etag: response.headers?.get?.("etag") || null,
  }
}

function isLikelyCorsError(err) {
  if (typeof window === "undefined") return false
  // `window.__TAURI__` truthy means we already had the Tauri plugin path;
  // a failure there is a real network error, not CORS.
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return false
  if (!(err instanceof TypeError)) return false
  const msg = String(err?.message || "").toLowerCase()
  // Chromium / WebKit / Firefox all phrase CORS-blocked fetches as a generic
  // TypeError - the canonical strings are "failed to fetch", "load failed",
  // and "networkerror when attempting to fetch resource".
  return (
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("networkerror")
  )
}

/**
 * Fetch + parse one EPG source. Reuses the per-URL HTTP meta + IDB cache so
 * a 304 short-circuits to the cached parsed map.
 *
 * @param {string} playlistId
 * @param {EpgSource} src
 * @param {Object} httpMeta - mutated in place with the latest validators
 * @returns {Promise<{ programmes: Map<string, any[]>, channelNames: Map<string, string>, count: number, cached: boolean, hasExplicitTimezones: boolean }>}
 */
async function fetchAndParseSource(playlistId, src, httpMeta) {
  const hash = urlHash(src.url)
  const kind = cacheKindFor(src.url)

  const result = await retryWithBackoff(() =>
    fetchEpgConditional(src.url, httpMeta[hash])
  )

  if (result.notModified) {
    await cacheHydrate(playlistId, kind)
    const hit = cacheGet(playlistId, kind)
    if (hit?.data?.entries) {
      // Clone cached programmes: applyOffset mutates start/stop in place and the
      // cache hands out entries by reference, so a shared object would re-shift
      // (drift by offsetMin) on every 304-served load.
      const programmes = cloneProgrammeEntries(hit.data.entries)
      const channelNames = new Map(hit.data.channelNames || [])
      return {
        programmes,
        channelNames,
        count: countProgrammes(programmes),
        cached: true,
        hasExplicitTimezones: !!hit.data.hasExplicitTimezones,
      }
    }
    // 304 but no cached parsed payload survived (TTL expired, IDB pruned).
    // Drop the stale validator and force a fresh fetch.
    delete httpMeta[hash]
    const fresh = await retryWithBackoff(() =>
      fetchEpgConditional(src.url, null)
    )
    if (fresh.notModified || !fresh.xml) {
      throw new Error("304 with no cached body and no fresh payload")
    }
    const parsed = await parseXmlTvOffMain(fresh.xml)
    const entries = Array.from(parsed.programmes.entries())
    try {
      cacheSet(
        playlistId,
        kind,
        {
          entries,
          channelNames: Array.from(parsed.channelNames.entries()),
          hasExplicitTimezones: parsed.hasExplicitTimezones,
        },
        EPG_CACHE_TTL
      )
    } catch (err) {
      log.warn("[xt:epg-data] EPG cache write failed:", err?.message || err)
    }
    httpMeta[hash] = {
      lastModified: fresh.lastModified || null,
      etag: fresh.etag || null,
    }

    const programmes = cloneProgrammeEntries(entries)
    return {
      programmes,
      channelNames: parsed.channelNames,
      count: countProgrammes(programmes),
      cached: false,
      hasExplicitTimezones: parsed.hasExplicitTimezones,
    }
  }

  const parsed = await parseXmlTvOffMain(result.xml)
  const entries = Array.from(parsed.programmes.entries())
  try {
    cacheSet(
      playlistId,
      kind,
      {
        entries,
        channelNames: Array.from(parsed.channelNames.entries()),
        hasExplicitTimezones: parsed.hasExplicitTimezones,
      },
      EPG_CACHE_TTL
    )
  } catch (err) {
    log.warn("[xt:epg-data] EPG cache write failed:", err?.message || err)
  }
  httpMeta[hash] = {
    lastModified: result.lastModified || null,
    etag: result.etag || null,
  }

  const programmes = cloneProgrammeEntries(entries)
  return {
    programmes,
    channelNames: parsed.channelNames,
    count: countProgrammes(programmes),
    cached: false,
    hasExplicitTimezones: parsed.hasExplicitTimezones,
  }
}

function cloneProgrammeEntries(entries) {
  return new Map(
    entries.map(([tvgId, arr]) => [
      tvgId,
      Array.isArray(arr) ? arr.map((programme) => ({ ...programme })) : arr,
    ])
  )
}

function countProgrammes(map) {
  let total = 0
  for (const arr of map.values()) total += arr.length
  return total
}

/**
 * @typedef {Object} EpgSourceStatus
 * @property {string} url
 * @property {EpgSource["source"]} source
 * @property {EpgSource["kind"]} kind
 * @property {"ok"|"error"} status
 * @property {number} [count]   - programmes loaded from this source (status=ok)
 * @property {boolean} [cached] - true when served from per-URL cache (status=ok)
 * @property {string} [error]   - human-readable failure reason (status=error)
 */

/**
 * @param {string} playlistId
 * @param {{host:string,port:string,user:string,pass:string}} creds
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<EpgState | null>}
 */
export async function loadProgrammes(playlistId, creds, opts = {}) {
  if (!playlistId || !creds?.host) return null

  if (!opts.force) {
    const hit = memCache.get(playlistId)
    if (hit && Date.now() - hit.fetchedAt < FRESH_MS) return hit
  }

  const existing = inflight.get(playlistId)
  if (existing && !opts.force) return existing

  const promise = (async () => {
    try {
      const sources = await buildEpgUrls(creds, playlistId)
      if (!sources.length) {
        // No EPG configured (M3U with no x-tvg-url and no override). Nothing
        // to do; consumers fall back to whatever sync data the cache holds.
        dispatchSourceStatus(playlistId, [])
        return null
      }

      const httpMeta = readEpgHttpMeta(playlistId)
      /** @type {EpgSourceStatus[]} */
      const statuses = []
      /** @type {Map<string, any[]>[]} */
      const programmeMaps = []
      /** @type {Map<string, string>[]} */
      const channelNameMaps = []
      // See resolveAutoOffsetMin: any explicit-tz source skips inference to avoid double-shifting correct-UTC programmes.
      let anySourceHasExplicitTimezones = false

      const fetchResults = await Promise.allSettled(
        sources.map((src) => fetchAndParseSource(playlistId, src, httpMeta))
      )

      for (let i = 0; i < sources.length; i++) {
        const src = sources[i]
        const result = fetchResults[i]
        if (result.status === "fulfilled") {
          const { programmes, channelNames, count, cached, hasExplicitTimezones } =
            result.value
          programmeMaps.push(programmes)
          channelNameMaps.push(channelNames)
          if (hasExplicitTimezones) anySourceHasExplicitTimezones = true
          statuses.push({
            url: src.url,
            source: src.source,
            kind: src.kind,
            status: "ok",
            count,
            cached,
          })
        } else {
          const err = result.reason
          log.warn(
            `[xt:epg-data] source failed (${src.source}):`,
            err?.message || err
          )
          statuses.push({
            url: src.url,
            source: src.source,
            kind: src.kind,
            status: "error",
            error: String(err?.message || err || "Unknown error"),
          })
        }
      }

      writeEpgHttpMeta(playlistId, httpMeta)
      dispatchSourceStatus(playlistId, statuses)

      if (!programmeMaps.length) {
        // Every source errored. Surface a null result; the per-source status
        // event has already told the UI what went wrong.
        return null
      }

      const programmes = mergeProgrammeMaps(programmeMaps)
      const channelNames = mergeChannelNameMaps(channelNameMaps)
      if (!programmes.size) return null

      const setting = getOffsetSetting(playlistId)
      let offsetMin = 0
      const offsetIsAuto = setting === "auto"
      if (offsetIsAuto) {
        const preferredOffset = readInferredOffsetSetting(playlistId)
        offsetMin = resolveAutoOffsetMin(
          anySourceHasExplicitTimezones,
          programmes,
          preferredOffset
        )
        if (!anySourceHasExplicitTimezones) {
          writeInferredOffsetSetting(playlistId, offsetMin)
        }
      } else {
        offsetMin = Number(setting) || 0
      }
      applyOffset(programmes, offsetMin)

      const state = {
        programmes,
        channelNames,
        // Pre-built so the per-channel name match in effectiveTvgId /
        // classifyTvgIdSource is O(1). Crucial when the mapping dialog
        // has to classify a 50k-row playlist.
        nameIndex: buildChannelNameIndex(channelNames),
        fetchedAt: Date.now(),
        offsetMin,
        offsetIsAuto,
      }
      memCache.set(playlistId, state)
      document.dispatchEvent(
        new CustomEvent(EVT_LOADED, {
          detail: { playlistId, offsetMin, offsetIsAuto },
        })
      )
      return state
    } catch (e) {
      log.warn("[xt:epg-data] load failed:", e)
      return null
    } finally {
      inflight.delete(playlistId)
    }
  })()
  inflight.set(playlistId, promise)
  return promise
}

function dispatchSourceStatus(playlistId, sources) {
  try {
    document.dispatchEvent(
      new CustomEvent(EVT_SOURCE_STATUS, {
        detail: { playlistId, sources },
      })
    )
  } catch {}
}

/** Cache lookup without triggering a fetch. */
export function getProgrammesSync(playlistId) {
  if (!playlistId) return null
  return memCache.get(playlistId) || null
}

/**
 * Reverse the display-offset shift applied by applyOffset(): programmes in
 * EpgState carry display-shifted start/stop times, but catch-up URLs need
 * the original XMLTV UTC time. Returns displayedMs unchanged when no
 * offset-carrying state is cached for the playlist.
 *
 * @param {string} playlistId
 * @param {number} displayedMs
 * @returns {number}
 */
export function displayedToUtcMs(playlistId, displayedMs) {
  const state = playlistId ? memCache.get(playlistId) : null
  if (!state || !state.offsetMin) return displayedMs
  return displayedMs - state.offsetMin * 60 * 1000
}

/**
 * Inverse of displayedToUtcMs(): shifts a UTC instant into the display-shifted space programmes are stored in.
 *
 * @param {string} playlistId
 * @param {number} utcMs
 * @returns {number}
 */
export function utcToDisplayedMs(playlistId, utcMs) {
  const state = playlistId ? memCache.get(playlistId) : null
  if (!state || !state.offsetMin) return utcMs
  return utcMs + state.offsetMin * 60 * 1000
}

export function invalidateEpgPlaylist(playlistId) {
  if (!playlistId) return
  memCache.delete(playlistId)
  inflight.delete(playlistId)
  writeEpgHttpMeta(playlistId, null)
  // Drop every per-URL EPG cache row in one shot without touching the
  // playlist's live/vod/series catalog caches.
  cacheInvalidatePrefix(playlistId, EPG_CACHE_KIND_PREFIX + ":")
}

export const EPG_LOADED_EVENT = EVT_LOADED
export const EPG_OFFSET_EVENT = EVT_OFFSET_CHANGED
export const EPG_SOURCE_STATUS_EVENT = EVT_SOURCE_STATUS

// ---------------------------------------------------------------------------
// Per-channel tvg-id resolution + EPG-channel discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the tvg-id that should be used to look up EPG for a given channel.
 * Resolution order:
 *   1. user override from `channelEpgMap` (Jellyfin-style manual mapping)
 *   2. `channel.tvgId` if it exists in the loaded XMLTV programmes
 *   3. fuzzy match on `channel.name` against XMLTV `<display-name>` entries
 *      after stripping quality suffixes ("HD", "FHD", "UHD", "4K", "SD") so
 *      "MDR Sachsen HD" auto-matches an EPG channel called "MDR Sachsen".
 *
 * Pure-function variant for tests / non-Tauri contexts.
 *
 * @param {{ id: number|string, name?: string, tvgId?: string|null }} channel
 * @param {Record<string,string>} overrides         - { channelId -> tvgId }
 * @param {Map<string, any[]>}    [programmes]       - tvg-id -> programmes[]
 * @param {Map<string, string>}   [channelNames]     - tvg-id -> display-name
 * @returns {string}
 */
export function resolveTvgId(channel, overrides, programmes, channelNames) {
  if (!channel) return ""
  const channelId = channel.id != null ? String(channel.id) : ""
  const overridden = channelId && overrides ? overrides[channelId] : ""
  if (overridden) return String(overridden).toLowerCase()
  const rawTvgId = channel.tvgId
    ? String(channel.tvgId).toLowerCase()
    : ""
  if (rawTvgId && programmes && programmes.has(rawTvgId)) return rawTvgId
  // Fall through to name match - either there's no auto tvg-id or it
  // doesn't exist in the loaded XMLTV.
  if (channel.name && channelNames && channelNames.size) {
    const match = findBestEpgChannelByName(channel.name, channelNames)
    if (match) return match
  }
  return rawTvgId
}

// Common quality / format suffix tokens stripped before name comparison. The
// list is conservative on purpose - tokens like "+1" (timeshift) or "italia"
// would change channel identity, not just labeling, so we leave them alone.
const QUALITY_SUFFIX_RX =
  /(?:\b|[\s_.-])(hd|fhd|uhd|4k|sd|hevc|h\.?26[45]|hq|sd1|hd1)(?=\b|[\s_.-]|$)/gi

/**
 * Normalise a channel name for fuzzy comparison: lowercase, NFD-strip
 * diacritics, drop quality/format suffixes, then collapse everything
 * non-alphanumeric into a single contiguous string so playlists and EPGs
 * can disagree on spacing/punctuation without breaking the match.
 *
 *  - "Channel 21 HD" -> "channel21"
 *  - "Channel21"     -> "channel21"
 *  - "zdf_neo HD"    -> "zdfneo"
 *  - "ZDFneo"        -> "zdfneo"
 *  - "Sky+1 HD"      -> "sky+1"   (plus is part of channel identity)
 *
 * Exported for tests.
 */
export function normaliseChannelName(name) {
  if (!name) return ""
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(QUALITY_SUFFIX_RX, " ")
    .replace(/[^\p{L}\p{N}+]+/gu, "")
}

// Sentinel for ambiguous normalised names in the index. We refuse to
// auto-match when several distinct tvg-ids reduce to the same normalised
// name - silently picking one would mislead the user.
const NAME_INDEX_COLLISION = "\0\0AMBIG\0\0"

/**
 * Build a normalised-name -> tvg-id lookup so per-channel name matching is
 * O(1) instead of O(M) per call. Built once after each EPG load and stored
 * on EpgState; consumers should not call this in hot paths.
 *
 * @param {Map<string, string>} channelNames - tvg-id -> display-name
 * @returns {Map<string, string>}
 */
export function buildChannelNameIndex(channelNames) {
  const index = new Map()
  if (!channelNames) return index
  for (const [tvgId, displayName] of channelNames) {
    const norm = normaliseChannelName(displayName)
    if (!norm) continue
    const existing = index.get(norm)
    if (!existing) {
      index.set(norm, tvgId)
    } else if (existing !== tvgId) {
      index.set(norm, NAME_INDEX_COLLISION)
    }
  }
  return index
}

/**
 * O(1) lookup against a pre-built name index. Returns "" on collision or
 * miss so callers can fall through.
 *
 * @param {string} channelName
 * @param {Map<string, string>} nameIndex - output of buildChannelNameIndex
 * @returns {string}
 */
export function findInChannelNameIndex(channelName, nameIndex) {
  if (!nameIndex || !nameIndex.size) return ""
  const target = normaliseChannelName(channelName)
  if (!target) return ""
  const hit = nameIndex.get(target)
  return hit && hit !== NAME_INDEX_COLLISION ? hit : ""
}

/**
 * Find the unique XMLTV channel whose normalised display-name matches the
 * channel name. Returns the tvg-id (lower-cased) on a unique hit, "" on
 * ambiguity or miss. Conservatism on purpose - a wrong auto-match would
 * silently mislead the user, so we refuse ties and the user has to map
 * manually via the picker.
 *
 * Pure variant kept for tests / pure callers. App code should use the
 * index path via `findInChannelNameIndex` for performance.
 *
 * @param {string} channelName
 * @param {Map<string, string>} channelNames - tvg-id -> display-name
 * @returns {string}
 */
export function findBestEpgChannelByName(channelName, channelNames) {
  return findInChannelNameIndex(channelName, buildChannelNameIndex(channelNames))
}

// Memoise the per-channel resolution. Key = `${playlistId}:${channelId}`,
// value = { tvgId, fetchedAt }. Invalidate on EPG load or override change.
/** @type {Map<string, { tvgId: string, fetchedAt: number }>} */
const tvgIdMemo = new Map()

function invalidateTvgIdMemo(playlistId) {
  if (!playlistId) {
    tvgIdMemo.clear()
    return
  }
  const prefix = `${playlistId}:`
  for (const key of [...tvgIdMemo.keys()]) {
    if (key.startsWith(prefix)) tvgIdMemo.delete(key)
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:epg-loaded", (event) => {
    const detail = event.detail
    if (detail?.playlistId) invalidateTvgIdMemo(detail.playlistId)
  })
  document.addEventListener("xt:channel-epg-changed", (event) => {
    const detail = event.detail
    if (detail?.playlistId) invalidateTvgIdMemo(detail.playlistId)
  })

  document.addEventListener("xt:active-changed", () => {
    tvgIdMemo.clear()
    availableEpgCache.clear()
  })
}

/**
 * Storage-aware variant: looks up the override straight from `preferences.js`
 * and falls back through tvg-id and fuzzy name match. Use this in app code;
 * `resolveTvgId` is the test seam.
 *
 * @param {{ id: number|string, name?: string, tvgId?: string|null }} channel
 * @param {string} playlistId
 */
export function effectiveTvgId(channel, playlistId) {
  if (!channel) return ""
  const override = playlistId
    ? getChannelEpgOverride(playlistId, channel.id)
    : ""
  if (override) return String(override).toLowerCase()
  const rawTvgId = channel.tvgId
    ? String(channel.tvgId).toLowerCase()
    : ""

  const state = playlistId ? memCache.get(playlistId) : null
  // Without EPG loaded we can't sanity-check a tvg-id or run name match, so
  // surface whatever the playlist says and let the caller's lookup fail
  // gracefully. The EPG_LOADED_EVENT listener invalidates the memo so once
  // data arrives we re-resolve.
  if (!state) return rawTvgId

  if (rawTvgId && state.programmes.has(rawTvgId)) return rawTvgId

  if (!channel.name) return rawTvgId

  const memoKey = `${playlistId}:${channel.id}`
  const hit = tvgIdMemo.get(memoKey)
  if (hit && hit.fetchedAt === state.fetchedAt) return hit.tvgId

  const match = findInChannelNameIndex(channel.name, state.nameIndex)
  const resolved = match || rawTvgId
  tvgIdMemo.set(memoKey, { tvgId: resolved, fetchedAt: state.fetchedAt })
  return resolved
}

/**
 * Classify how a channel's effective tvg-id was determined. Used by the
 * mapping dialog to show "Override" / "Auto" / "Auto (name)" / "No EPG"
 * badges.
 *
 * @param {{ id: number|string, name?: string, tvgId?: string|null }} channel
 * @param {string} playlistId
 * @returns {"override" | "tvg-id" | "name" | "none"}
 */
export function classifyTvgIdSource(channel, playlistId) {
  if (!channel || !playlistId) return "none"
  if (getChannelEpgOverride(playlistId, channel.id)) return "override"
  const state = memCache.get(playlistId)
  if (!state) {
    // EPG isn't loaded yet - the best we can say is whether a raw tvg-id
    // exists. Treat that as a tentative "tvg-id" hit; classification
    // refines once the data lands.
    return channel.tvgId ? "tvg-id" : "none"
  }
  const rawTvgId = channel.tvgId
    ? String(channel.tvgId).toLowerCase()
    : ""
  if (rawTvgId && state.programmes.has(rawTvgId)) return "tvg-id"
  if (channel.name) {
    const match = findInChannelNameIndex(channel.name, state.nameIndex)
    if (match) return "name"
  }
  return "none"
}

/**
 * @typedef {Object} AvailableEpgChannel
 * @property {string} tvgId   - lower-cased XMLTV channel id
 * @property {string} name    - <display-name> or the tvgId when missing
 * @property {number} count   - number of programmes currently loaded
 */

// Cached snapshot of getAvailableEpgChannels so the picker dialog doesn't
// rebuild + sort the (potentially 5-50k entry) list on every keystroke. Keyed
// by playlistId, validated against state.fetchedAt so a fresh EPG load
// invalidates automatically.
/** @type {Map<string, { fetchedAt: number, entries: AvailableEpgChannel[] }>} */
const availableEpgCache = new Map()

/**
 * Snapshot of every tvg-id that has programmes in the in-memory EPG state for
 * a playlist. Used by the mapping picker. Returns [] when the EPG hasn't
 * loaded yet (caller should kick off `loadProgrammes` first).
 *
 * @param {string} playlistId
 * @returns {AvailableEpgChannel[]}
 */
export function getAvailableEpgChannels(playlistId) {
  if (!playlistId) return []
  const state = memCache.get(playlistId)
  if (!state || !state.programmes) return []
  const cached = availableEpgCache.get(playlistId)
  if (cached && cached.fetchedAt === state.fetchedAt) return cached.entries

  /** @type {AvailableEpgChannel[]} */
  const out = []
  for (const [tvgId, programmes] of state.programmes) {
    out.push({
      tvgId,
      name: state.channelNames?.get(tvgId) || tvgId,
      count: programmes.length,
    })
  }
  out.sort((first, second) =>
    first.name.localeCompare(second.name, "en", { sensitivity: "base" })
  )
  availableEpgCache.set(playlistId, { fetchedAt: state.fetchedAt, entries: out })
  return out
}

/**
 * Fetch + parse a single EPG URL without writing to cache. Used by the
 * "Test sources" button on /login: lets the user iterate on URLs before
 * committing them to a playlist.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, count?: number, channels?: number, error?: string }>}
 */
export async function testEpgSource(url, opts = {}) {
  if (!url || typeof url !== "string") {
    return { ok: false, error: "Empty URL" }
  }
  try {
    const init = { forceTauri: true, logKind: "epg" }
    if (opts.signal) init.signal = opts.signal
    let response
    try {
      response = await providerFetch(url, init)
    } catch (err) {
      if (isLikelyCorsError(err)) {
        return {
          ok: false,
          error:
            "Blocked by browser CORS. Open the desktop / Android build to verify (Tauri bypasses CORS).",
        }
      }
      throw err
    }
    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText || ""}`.trim(),
      }
    }
    const xml = await readResponseAsXml(url, response)
    const parsed = await parseXmlTvOffMain(xml)
    let count = 0
    for (const arr of parsed.programmes.values()) count += arr.length
    return {
      ok: true,
      count,
      channels: parsed.programmes.size,
    }
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err || "Unknown error"),
    }
  }
}
