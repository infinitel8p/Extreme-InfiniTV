// Shared catalog fetch + parse + cache

import { cachedFetch } from "@/scripts/lib/cache.js"
import {
  loadCreds,
  buildApiUrl,
  isLikelyM3USource,
} from "@/scripts/lib/creds.js"
import { normalize } from "@/scripts/lib/text.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { ensureUserInfo } from "@/scripts/lib/account-info.js"

const CHANNELS_TTL_MS = 24 * 60 * 60 * 1000
const VOD_TTL_MS = 24 * 60 * 60 * 1000
const SERIES_TTL_MS = 24 * 60 * 60 * 1000

const EVT_WARMED = "xt:catalog-warmed"
const EVT_WARMING_START = "xt:catalog-warming-start"
const EVT_WARMING_PROGRESS = "xt:catalog-warming-progress"

function dispatch(name, detail) {
  try {
    document.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {}
}

// ---------------------------------------------------------------------------
// Live (Xtream + M3U)
// ---------------------------------------------------------------------------
async function fetchLiveCategoryMap(creds) {
  const r = await providerFetch(buildApiUrl(creds, "get_live_categories"))
  const data = await r.json().catch(() => [])
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.categories)
    ? data.categories
    : []
  return new Map(
    arr
      .filter((c) => c && c.category_id != null)
      .map((c) => [String(c.category_id), String(c.category_name || "").trim()])
  )
}

function parseM3U(text) {
  const out = []
  const lines = text.split(/\r?\n/)
  let pending = null
  const readAttr = (s, key) =>
    s.match(new RegExp(`\\b${key}="([^"]*)"`, "i"))?.[1] ||
    s.match(new RegExp(`\\b${key}=([^\\s,]+)`, "i"))?.[1] ||
    ""
  const stripAttrs = (s) =>
    s
      .replace(/\b[\w-]+="[^"]*"/g, "")
      .replace(/\b(tvg-[\w-]+|group-title|channel-id|channel-number)=[^\s,]+/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  let idSeq = 1
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("#EXTM3U")) continue
    if (line.startsWith("#EXTINF")) {
      const commaIdx = line.indexOf(",")
      const afterComma = commaIdx >= 0 ? line.slice(commaIdx + 1) : ""
      const name = stripAttrs(afterComma) || `Channel ${idSeq}`
      const logo = readAttr(line, "tvg-logo")
      const group = readAttr(line, "group-title") || "Uncategorized"
      const tvgId = readAttr(line, "tvg-id") || readAttr(line, "channel-id")
      pending = {
        name,
        logo,
        category: group,
        tvgId: tvgId || "",
      }
      continue
    }
    if (line.startsWith("#")) continue
    if (pending) {
      out.push({
        id: idSeq++,
        name: pending.name,
        category: pending.category,
        logo: pending.logo || null,
        tvgId: pending.tvgId || undefined,
        norm: normalize(
          `${pending.name} ${pending.category} ${pending.tvgId || ""}`
        ),
        url: line,
      })
      pending = null
    }
  }
  return out
}

export async function ensureLive(creds, playlistId, opts = {}) {
  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  const kind = isM3U ? "m3u" : "live"
  const { data } = await cachedFetch(playlistId, kind, CHANNELS_TTL_MS, async () => {
    if (isM3U) {
      const r = await providerFetch(creds.host)
      if (!r.ok) throw new Error(`M3U ${r.status}`)
      const text = await r.text()
      return parseM3U(text)
        .filter((x) => x.url && x.name)
        .sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        )
    }
    const catMap = await fetchLiveCategoryMap(creds)
    const r = await providerFetch(buildApiUrl(creds, "get_live_streams"))
    const body = await r.text()
    if (!r.ok) throw new Error(`API ${r.status}`)
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed?.streams || parsed?.results || []
    return (arr || [])
      .map((ch) => {
        const name = String(ch.name || "")
        const ids =
          (Array.isArray(ch.category_ids) &&
            ch.category_ids.length &&
            ch.category_ids) ||
          (ch.category_id != null ? [ch.category_id] : [])
        let category = String(ch.category_name || "").trim()
        if (!category && ids.length && catMap?.size) {
          for (const id of ids) {
            const n = catMap.get(String(id))
            if (n) {
              category = n
              break
            }
          }
        }
        return {
          id: Number(ch.stream_id),
          name,
          category,
          logo: ch.stream_icon || null,
          tvgId: String(ch.epg_channel_id || "") || undefined,
          norm: normalize(name + " " + category),
        }
      })
      .filter((x) => x.id && x.name)
      .sort((a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" })
      )
  }, { force: !!opts.force })
  return data || []
}

// ---------------------------------------------------------------------------
// VOD
// ---------------------------------------------------------------------------
async function fetchVodCategoryMap(creds) {
  const r = await providerFetch(buildApiUrl(creds, "get_vod_categories"))
  const data = await r.json().catch(() => [])
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.categories)
    ? data.categories
    : []
  return new Map(
    arr
      .filter((c) => c && c.category_id != null)
      .map((c) => [String(c.category_id), String(c.category_name || "").trim()])
  )
}

export async function ensureVod(creds, playlistId, opts = {}) {
  if (!creds?.user || !creds?.pass) return []
  const { data } = await cachedFetch(playlistId, "vod", VOD_TTL_MS, async () => {
    const catMap = await fetchVodCategoryMap(creds)
    const r = await providerFetch(buildApiUrl(creds, "get_vod_streams"))
    const body = await r.text()
    if (!r.ok) throw new Error(`API ${r.status}`)
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed?.movies || parsed?.results || []
    return (arr || [])
      .map((m) => {
        const name = String(m.name || m.title || "")
        const id = Number(m.stream_id || m.id)
        const logo = m.stream_icon || m.cover || null
        const year = String(m.year || m.releaseDate || "").trim() || ""
        const rating = m.rating || m.rating_5based || m.vote_average || ""
        const duration = m.duration || m.runtime || m.duration_secs || ""
        const categoryId =
          (Array.isArray(m.category_ids) &&
            m.category_ids.length &&
            m.category_ids[0]) ||
          m.category_id
        let category = String(m.category_name || "").trim()
        if (!category && categoryId != null && catMap?.size) {
          category = catMap.get(String(categoryId)) || ""
        }
        const added = Number(m.added) || 0
        return {
          id,
          name,
          logo: logo || null,
          year,
          rating: rating ? String(rating) : "",
          duration: duration ? String(duration) : "",
          category,
          plot: "",
          added,
          norm: normalize(`${name} ${category} ${year}`),
        }
      })
      .filter((m) => m.id && m.name)
      .sort((a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" })
      )
  }, { force: !!opts.force })
  return data || []
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------
async function fetchSeriesCategoryMap(creds) {
  const r = await providerFetch(buildApiUrl(creds, "get_series_categories"))
  const data = await r.json().catch(() => [])
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.categories)
    ? data.categories
    : []
  return new Map(
    arr
      .filter((c) => c && c.category_id != null)
      .map((c) => [String(c.category_id), String(c.category_name || "").trim()])
  )
}

export async function ensureSeries(creds, playlistId, opts = {}) {
  if (!creds?.user || !creds?.pass) return []
  const { data } = await cachedFetch(playlistId, "series", SERIES_TTL_MS, async () => {
    const catMap = await fetchSeriesCategoryMap(creds)
    const r = await providerFetch(buildApiUrl(creds, "get_series"))
    const body = await r.text()
    if (!r.ok) throw new Error(`API ${r.status}`)
    const parsed = JSON.parse(body)
    const arr = Array.isArray(parsed) ? parsed : parsed?.series || parsed?.results || []
    return (arr || [])
      .map((s) => {
        const name = String(s.name || s.title || "")
        const id = Number(s.series_id || s.id)
        const logo = s.cover || s.stream_icon || null
        const year = String(
          s.year || s.releaseDate || s.release_date || ""
        ).trim()
        const rating = s.rating || s.rating_5based || ""
        const categoryId =
          (Array.isArray(s.category_ids) &&
            s.category_ids.length &&
            s.category_ids[0]) ||
          s.category_id
        let category = String(s.category_name || "").trim()
        if (!category && categoryId != null && catMap?.size) {
          category = catMap.get(String(categoryId)) || ""
        }
        const added =
          Number(s.last_modified) ||
          Number(s.added) ||
          Number(
            s.releaseDate ? Date.parse(s.releaseDate) / 1000 : 0
          ) ||
          0
        return {
          id,
          name,
          logo: logo || null,
          year: year || "",
          rating: rating ? String(rating) : "",
          category,
          plot: s.plot || "",
          added,
          norm: normalize(`${name} ${category} ${year}`),
        }
      })
      .filter((s) => s.id && s.name)
      .sort((a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" })
      )
  }, { force: !!opts.force })
  return data || []
}

const inflight = new Map()

export async function warmupActive(playlistId, opts = {}) {
  let creds
  let pid = playlistId
  try {
    creds = await loadCreds()
  } catch {
    return { live: [], vod: [], series: [], errors: { creds: "no creds" } }
  }
  if (!creds?.host) {
    return { live: [], vod: [], series: [], errors: { creds: "no creds" } }
  }
  if (!pid) {
    const { getActiveEntry } = await import("@/scripts/lib/creds.js")
    const e = await getActiveEntry()
    pid = e?._id
  }
  if (!pid) {
    return { live: [], vod: [], series: [], errors: { playlist: "no active" } }
  }

  // Don't dedupe forced refreshes; the user just hit "refresh" expecting
  // a fresh round-trip even if a background warmup is mid-flight.
  if (!opts.force && inflight.has(pid)) return inflight.get(pid)

  const run = (async () => {
    const errors = {}
    dispatch(EVT_WARMING_START, { playlistId: pid, kinds: ["live", "vod", "series"] })
    const wrap = (kind, fn) =>
      fn()
        .then((data) => {
          dispatch(EVT_WARMING_PROGRESS, {
            playlistId: pid,
            kind,
            status: "done",
            count: Array.isArray(data) ? data.length : 0,
          })
          return data
        })
        .catch((e) => {
          errors[kind] = String(e?.message || e)
          dispatch(EVT_WARMING_PROGRESS, {
            playlistId: pid,
            kind,
            status: "error",
            error: errors[kind],
          })
          return []
        })
    const force = !!opts.force
    const [live, vod, series] = await Promise.all([
      wrap("live", () => ensureLive(creds, pid, { force })),
      wrap("vod", () => ensureVod(creds, pid, { force })),
      wrap("series", () => ensureSeries(creds, pid, { force })),
      // user_info comes alongside the catalog so download-concurrency caps
      // and the expiration banner are populated without waiting for /settings.
      // Failure is ignored - M3U sources won't have a player_api endpoint.
      ensureUserInfo(creds, pid, { force }).catch(() => null),
    ])
    dispatch(EVT_WARMED, { playlistId: pid, errors })
    return { live, vod, series, errors }
  })()
    .finally(() => {
      // Hold the in-flight result for a beat so back-to-back callers reuse it.
      setTimeout(() => inflight.delete(pid), 1500)
    })

  inflight.set(pid, run)
  return run
}

export const CATALOG_WARMED_EVENT = EVT_WARMED
export const CATALOG_WARMING_START_EVENT = EVT_WARMING_START
export const CATALOG_WARMING_PROGRESS_EVENT = EVT_WARMING_PROGRESS
