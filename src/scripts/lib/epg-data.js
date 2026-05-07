// Shared EPG data layer for /livetv and /epg.

import { log } from "@/scripts/lib/log.js"
import {
  fmtBase,
  isLikelyM3USource,
} from "@/scripts/lib/creds.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  setCached as cacheSet,
  getCached as cacheGet,
  hydrate as cacheHydrate,
} from "@/scripts/lib/cache.js"
import { retryWithBackoff, HttpRetryError } from "@/scripts/lib/retry.ts"

const FRESH_MS = 60 * 60 * 1000
const TZ_KEY_PREFIX = "xt_epg_offset:"
const EPG_HTTP_META_PREFIX = "xt_epg_http:"
const EPG_CACHE_KIND = "epg_parsed"
const EPG_CACHE_TTL = 4 * 60 * 60 * 1000
const EVT_LOADED = "xt:epg-loaded"
const EVT_OFFSET_CHANGED = "xt:epg-offset-changed"
const GZIP_CT_RX = /application\/(x-)?gzip|application\/x-gunzip/i

/** @typedef {{ start:number, stop:number, title:string, desc:string }} Programme */

/**
 * @typedef {Object} EpgState
 * @property {Map<string, Programme[]>} programmes - keyed by tvgId (lower-cased)
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
  const reply = await new Promise((resolve, reject) => {
    xmlWorkerPending.set(id, { resolve, reject })
    worker.postMessage({ id, xml })
  }).catch(() => null)
  if (!reply || reply.fallback) return parseXmlTv(xml)
  if (reply.error) throw new Error(reply.error)
  return new Map(reply.programmes)
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

/**
 * @param {string} xml
 * @returns {Map<string, Programme[]>}
 */
export function parseXmlTv(xml) {
  /** @type {Map<string, Programme[]>} */
  const out = new Map()
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  const err = doc.querySelector("parsererror")
  if (err) throw new Error("XMLTV parse error: " + err.textContent.slice(0, 200))

  const lo = Date.now() - 6 * 60 * 60 * 1000
  const hi = Date.now() + 36 * 60 * 60 * 1000

  const list = doc.querySelectorAll("programme")
  for (const p of list) {
    const ch = (p.getAttribute("channel") || "").toLowerCase()
    if (!ch) continue
    const start = parseXmlTvDate(p.getAttribute("start") || "")
    const stop = parseXmlTvDate(p.getAttribute("stop") || "")
    if (!start || !stop || stop <= start) continue
    if (stop < lo || start > hi) continue

    const title = p.querySelector("title")?.textContent?.trim() || "Untitled"
    const desc = p.querySelector("desc")?.textContent?.trim() || ""

    let arr = out.get(ch)
    if (!arr) {
      arr = []
      out.set(ch, arr)
    }
    arr.push({ start, stop, title, desc })
  }

  for (const arr of out.values()) {
    arr.sort((a, b) => a.start - b.start)
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
  return out
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
/**
 * @param {Map<string, Programme[]>} programmes
 * @param {string|undefined|null} tvgId
 * @param {number} [atMs]
 * @returns {{ current: Programme|null, next: Programme|null }}
 */
export function getNowNext(programmes, tvgId, atMs = Date.now()) {
  if (!programmes || !tvgId) return { current: null, next: null }
  const arr = programmes.get(String(tvgId).toLowerCase())
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

// ---------------------------------------------------------------------------
// Timezone offset
// ---------------------------------------------------------------------------
const TZ_CANDIDATE_MIN = -12 * 60
const TZ_CANDIDATE_MAX = 14 * 60
const TZ_CANDIDATE_STEP = 30

/**
 * @param {Map<string, Programme[]>} programmes
 * @returns {number}
 */
export function inferTimezoneOffsetMin(programmes) {
  if (!programmes || !programmes.size) return 0
  const now = Date.now()
  /** @type {Programme[][]} */
  const channels = []
  for (const arr of programmes.values()) {
    if (arr.length) channels.push(arr)
    if (channels.length >= 50) break
  }
  if (!channels.length) return 0

  let bestOffset = 0
  let bestScore = -1
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

    if (
      score > bestScore ||
      (score === bestScore && Math.abs(off) < Math.abs(bestOffset))
    ) {
      bestScore = score
      bestOffset = off
    }
  }
  return bestOffset
}

function applyOffset(programmes, offsetMin) {
  if (!offsetMin) return
  const shift = offsetMin * 60 * 1000
  for (const arr of programmes.values()) {
    for (const p of arr) {
      p.start += shift
      p.stop += shift
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

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function readEpgHttpMeta(playlistId) {
  if (!playlistId) return null
  try {
    const raw = localStorage.getItem(EPG_HTTP_META_PREFIX + playlistId)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeEpgHttpMeta(playlistId, meta) {
  if (!playlistId) return
  try {
    if (!meta) localStorage.removeItem(EPG_HTTP_META_PREFIX + playlistId)
    else localStorage.setItem(EPG_HTTP_META_PREFIX + playlistId, JSON.stringify(meta))
  } catch {}
}

function buildEpgUrl(creds, playlistId) {
  if (isLikelyM3USource(creds.host, creds.user, creds.pass)) {
    let url = ""
    try {
      url = localStorage.getItem(`xt_m3u_epg:${playlistId}`) || ""
    } catch {}
    if (!url) throw new Error("This M3U playlist has no x-tvg-url EPG.")
    return url
  }
  const base = fmtBase(creds.host, creds.port).replace(/\/+$/, "")
  return (
    `${base}/xmltv.php?username=${encodeURIComponent(creds.user)}` +
    `&password=${encodeURIComponent(creds.pass)}`
  )
}

async function readResponseAsXml(url, response) {
  const ct = response.headers?.get?.("content-type") || ""
  const cd = response.headers?.get?.("content-disposition") || ""
  const lower = String(url).toLowerCase().split("?")[0] ?? ""
  const looksGzipped =
    lower.endsWith(".gz") ||
    lower.endsWith(".gzip") ||
    GZIP_CT_RX.test(ct) ||
    /\.gz["']?(\s|$|;)/i.test(cd)
  if (!looksGzipped) return response.text()
  if (typeof DecompressionStream !== "function" || !response.body) {
    throw new Error(
      "This browser/WebView can't decompress gzipped EPG payloads. Try a provider that serves plain XML."
    )
  }
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"))
  return new Response(stream).text()
}

/**
 * Conditional EPG fetch. Returns either { notModified: true } or
 * { notModified: false, xml, lastModified, etag }.
 */
async function fetchEpgConditional(creds, playlistId) {
  const url = buildEpgUrl(creds, playlistId)
  const meta = readEpgHttpMeta(playlistId)
  const headers = {}
  if (meta?.lastModified) headers["If-Modified-Since"] = meta.lastModified
  if (meta?.etag) headers["If-None-Match"] = meta.etag
  const init = Object.keys(headers).length ? { headers } : {}
  const response = await providerFetch(url, init)
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
      const result = await retryWithBackoff(() =>
        fetchEpgConditional(creds, playlistId)
      )
      let programmes
      if (result.notModified) {
        await cacheHydrate(playlistId, EPG_CACHE_KIND)
        const hit = cacheGet(playlistId, EPG_CACHE_KIND)
        if (hit?.data?.entries) {
          programmes = new Map(hit.data.entries)
        } else {
          // 304 but no cached parsed payload survived
          writeEpgHttpMeta(playlistId, null)
          const fresh = await retryWithBackoff(() =>
            fetchEpgConditional(creds, playlistId)
          )
          if (fresh.notModified || !fresh.xml) return null
          programmes = await parseXmlTvOffMain(fresh.xml)
          try {
            cacheSet(
              playlistId,
              EPG_CACHE_KIND,
              { entries: Array.from(programmes.entries()) },
              EPG_CACHE_TTL
            )
          } catch {}
          writeEpgHttpMeta(playlistId, {
            lastModified: fresh.lastModified || null,
            etag: fresh.etag || null,
          })
        }
      } else {
        programmes = await parseXmlTvOffMain(result.xml)
        try {
          cacheSet(
            playlistId,
            EPG_CACHE_KIND,
            { entries: Array.from(programmes.entries()) },
            EPG_CACHE_TTL
          )
        } catch {}
        writeEpgHttpMeta(playlistId, {
          lastModified: result.lastModified || null,
          etag: result.etag || null,
        })
      }
      const setting = getOffsetSetting(playlistId)
      let offsetMin = 0
      let offsetIsAuto = setting === "auto"
      if (offsetIsAuto) offsetMin = inferTimezoneOffsetMin(programmes)
      else offsetMin = Number(setting) || 0
      applyOffset(programmes, offsetMin)
      const state = {
        programmes,
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

/** Cache lookup without triggering a fetch. */
export function getProgrammesSync(playlistId) {
  if (!playlistId) return null
  return memCache.get(playlistId) || null
}

export function invalidateEpgPlaylist(playlistId) {
  if (!playlistId) return
  memCache.delete(playlistId)
  inflight.delete(playlistId)
  writeEpgHttpMeta(playlistId, null)
}

export const EPG_LOADED_EVENT = EVT_LOADED
export const EPG_OFFSET_EVENT = EVT_OFFSET_CHANGED
