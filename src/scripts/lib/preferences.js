// Per-playlist favorites + recently-played + playback progress + view
// preferences (hidden categories, sort order), persisted alongside creds.
import { Store } from "@tauri-apps/plugin-store"
import { getProgressRetentionDays } from "@/scripts/lib/app-settings.js"
import { normalizeVideoScale, VIDEO_SCALE_MODES } from "@/scripts/lib/video-scale.ts"
import { log } from "@/scripts/lib/log.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

const STORAGE_KEY = "xt_prefs"
const VALID_CATEGORY_SORTS = new Set(["default", "az", "za"])
const LANG_FILTER_PATTERN = /^[A-Z0-9+]{0,8}$/
const RECENT_CAP = 30
const SEARCH_RECENT_CAP = 10
const PROGRESS_CAP = 200
const DAY_MS = 24 * 60 * 60 * 1000
const COMPLETED_THRESHOLD = 0.95
const EVT_FAV_CHANGED = "xt:favorites-changed"
const EVT_REC_CHANGED = "xt:recents-changed"
const EVT_PROGRESS_CHANGED = "xt:progress-changed"
const EVT_HIDDEN_CHANGED = "xt:hidden-categories-changed"
const EVT_ALLOWED_CHANGED = "xt:allowed-categories-changed"
const EVT_CAT_MODE_CHANGED = "xt:category-mode-changed"
const EVT_CAT_SORT_CHANGED = "xt:category-sort-changed"
const EVT_EPG_SYNC_CHANGED = "xt:epg-sync-changed"
const EVT_CHANNEL_EPG_CHANGED = "xt:channel-epg-changed"
const EVT_VIEW_CHANGED = "xt:view-prefs-changed"
const EVT_FAV_ORDER_CHANGED = "xt:favorites-order-changed"
const EVT_WATCHLIST_CHANGED = "xt:watchlist-changed"
const EVT_CHANNEL_VIDEO_SCALE_CHANGED = "xt:channel-video-scale-changed"
export const EVT_SEARCH_RECENT_CHANGED = "xt:search-recent-changed"
export const EVT_HIDE_WATCHED_CHANGED = "xt:hide-watched-changed"
export const EVT_LANG_FILTER_CHANGED = "xt:lang-filter-changed"
export const EVT_GROUP_LANGS_CHANGED = "xt:group-langs-changed"

let storePromise = null
function getStore() {
  if (!isTauri) return Promise.resolve(null)
  if (!storePromise) storePromise = Store.load(".xtream.creds.json")
  return storePromise
}

const getCookie = (name) => {
  try {
    const m = document.cookie.match(
      new RegExp(
        "(?:^|; )" +
          name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") +
          "=([^;]*)"
      )
    )
    return m ? decodeURIComponent(m[1]) : ""
  } catch {
    return ""
  }
}
const setCookie = (name, value, days = 365) => {
  try {
    const d = new Date()
    d.setTime(d.getTime() + days * 864e5)
    document.cookie = `${name}=${encodeURIComponent(
      value
    )}; expires=${d.toUTCString()}; path=/`
  } catch {}
}

// ---------------------------------------------------------------------------
// Raw read / write - mirrors creds.js
// ---------------------------------------------------------------------------
async function readRaw() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) || getCookie(STORAGE_KEY) || ""
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") return parsed
    }
  } catch {}
  const store = await getStore()
  if (store) {
    const v = await store.get(STORAGE_KEY)
    if (v && typeof v === "object") return v
  }
  return null
}

async function writeRaw(data) {
  const store = await getStore()
  const json = JSON.stringify(data)
  if (store) {
    await store.set(STORAGE_KEY, data)
    await store.save()
  }
  try {
    localStorage.setItem(STORAGE_KEY, json)
    setCookie(STORAGE_KEY, json)
  } catch (writeError) {
    log.error("[xt:prefs] localStorage/cookie write failed:", writeError)
  }
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
/**
 * @typedef {{ id: number, name: string, logo?: string|null, ts: number }} RecentEntry
 * @typedef {{ text: string, ts: number }} SearchRecentEntry
 * @typedef {{ favLive: Set<number>, favVod: Set<number>, favSeries: Set<number>,
 *             recLive: RecentEntry[], recVod: RecentEntry[], recSeries: RecentEntry[],
 *             searchRecent: SearchRecentEntry[] }} PlaylistPrefs
 */

/** @type {Map<string, PlaylistPrefs>} */
let cache = new Map()
let loadPromise = null

function emptyEntry() {
  return {
    favLive: new Set(),
    favVod: new Set(),
    favSeries: new Set(),
    favMetaLive: Object.create(null),
    favMetaVod: Object.create(null),
    favMetaSeries: Object.create(null),
    recLive: [],
    recVod: [],
    recSeries: [],
    searchRecent: [],
    progVod: Object.create(null),
    progEpisode: Object.create(null),
    hiddenLive: new Set(),
    hiddenVod: new Set(),
    hiddenSeries: new Set(),
    hiddenEpg: new Set(),
    allowedLive: new Set(),
    allowedVod: new Set(),
    allowedSeries: new Set(),
    allowedEpg: new Set(),
    catModeLive: "hide",
    catModeVod: "hide",
    catModeSeries: "hide",
    catModeEpg: "hide",
    catSortLive: "default",
    catSortVod: "default",
    catSortSeries: "default",
    catSortEpg: "default",
    syncEpgWithLive: true,
    channelEpgMap: Object.create(null),
    favOrderLive: [],
    favOrderVod: [],
    favOrderSeries: [],
    // Watchlist is intentionally separate from favorites: "want to watch
    // later" is a different intent than "permanent shortcut". Live channels
    // are excluded - they're ephemeral and don't fit the "save for later"
    // model. Each map is { id -> { ts, name, logo } } so the cross-playlist
    // /watchlist page can sort by added-time and render names / posters for
    // items whose source playlist is currently switched out.
    watchVod: Object.create(null),
    watchSeries: Object.create(null),
    viewSort: { vod: "default", series: "default", live: "default" },
    videoScaleLive: Object.create(null),
    videoScaleVod: Object.create(null),
    videoScaleSeries: Object.create(null),
    hideWatchedVod: false,
    hideWatchedSeries: false,
    watchedSeriesOverride: Object.create(null),
    langFilter: { vod: "", series: "" },
    groupLangs: { vod: true, series: true },
  }
}

function hydrate(raw) {
  cache = new Map()
  if (!raw || typeof raw !== "object") return
  for (const [pid, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue
    const v = val.viewSort && typeof val.viewSort === "object" ? val.viewSort : {}
    const langFilterRaw = val.langFilter && typeof val.langFilter === "object" ? val.langFilter : {}
    const groupLangsRaw = val.groupLangs && typeof val.groupLangs === "object" ? val.groupLangs : {}
    cache.set(pid, {
      favLive: new Set(Array.isArray(val.favLive) ? val.favLive : []),
      favVod: new Set(Array.isArray(val.favVod) ? val.favVod : []),
      favSeries: new Set(Array.isArray(val.favSeries) ? val.favSeries : []),
      favMetaLive:
        val.favMetaLive && typeof val.favMetaLive === "object"
          ? { ...val.favMetaLive }
          : Object.create(null),
      favMetaVod:
        val.favMetaVod && typeof val.favMetaVod === "object"
          ? { ...val.favMetaVod }
          : Object.create(null),
      favMetaSeries:
        val.favMetaSeries && typeof val.favMetaSeries === "object"
          ? { ...val.favMetaSeries }
          : Object.create(null),
      recLive: Array.isArray(val.recLive) ? val.recLive.slice(0, RECENT_CAP) : [],
      recVod: Array.isArray(val.recVod) ? val.recVod.slice(0, RECENT_CAP) : [],
      recSeries: Array.isArray(val.recSeries)
        ? val.recSeries.slice(0, RECENT_CAP)
        : [],
      searchRecent: Array.isArray(val.searchRecent)
        ? val.searchRecent
            .filter((entry) => entry && typeof entry.text === "string")
            .map((entry) => ({ text: entry.text, ts: Number(entry.ts) || 0 }))
            .slice(0, SEARCH_RECENT_CAP)
        : [],
      progVod:
        val.progVod && typeof val.progVod === "object"
          ? { ...val.progVod }
          : Object.create(null),
      progEpisode:
        val.progEpisode && typeof val.progEpisode === "object"
          ? { ...val.progEpisode }
          : Object.create(null),
      hiddenLive: new Set(
        Array.isArray(val.hiddenLive) ? val.hiddenLive.map(String) : []
      ),
      hiddenVod: new Set(
        Array.isArray(val.hiddenVod) ? val.hiddenVod.map(String) : []
      ),
      hiddenSeries: new Set(
        Array.isArray(val.hiddenSeries) ? val.hiddenSeries.map(String) : []
      ),
      hiddenEpg: new Set(
        Array.isArray(val.hiddenEpg) ? val.hiddenEpg.map(String) : []
      ),
      allowedLive: new Set(
        Array.isArray(val.allowedLive) ? val.allowedLive.map(String) : []
      ),
      allowedVod: new Set(
        Array.isArray(val.allowedVod) ? val.allowedVod.map(String) : []
      ),
      allowedSeries: new Set(
        Array.isArray(val.allowedSeries) ? val.allowedSeries.map(String) : []
      ),
      allowedEpg: new Set(
        Array.isArray(val.allowedEpg) ? val.allowedEpg.map(String) : []
      ),
      catModeLive: val.catModeLive === "select" ? "select" : "hide",
      catModeVod: val.catModeVod === "select" ? "select" : "hide",
      catModeSeries: val.catModeSeries === "select" ? "select" : "hide",
      catModeEpg: val.catModeEpg === "select" ? "select" : "hide",
      catSortLive: VALID_CATEGORY_SORTS.has(val.catSortLive)
        ? val.catSortLive
        : "default",
      catSortVod: VALID_CATEGORY_SORTS.has(val.catSortVod)
        ? val.catSortVod
        : "default",
      catSortSeries: VALID_CATEGORY_SORTS.has(val.catSortSeries)
        ? val.catSortSeries
        : "default",
      catSortEpg: VALID_CATEGORY_SORTS.has(val.catSortEpg)
        ? val.catSortEpg
        : "default",
      syncEpgWithLive: val.syncEpgWithLive !== false,
      channelEpgMap:
        val.channelEpgMap && typeof val.channelEpgMap === "object"
          ? Object.assign(Object.create(null), val.channelEpgMap)
          : Object.create(null),
      favOrderLive: Array.isArray(val.favOrderLive)
        ? val.favOrderLive.map(Number).filter(Number.isFinite)
        : [],
      favOrderVod: Array.isArray(val.favOrderVod)
        ? val.favOrderVod.map(Number).filter(Number.isFinite)
        : [],
      favOrderSeries: Array.isArray(val.favOrderSeries)
        ? val.favOrderSeries.map(Number).filter(Number.isFinite)
        : [],
      // Prototype-less to match emptyEntry(); even though every read is
      // hasOwnProperty-guarded, keep the shape consistent so future contributors
      // don't accidentally mix `bag.toString` style accidental hits.
      watchVod:
        val.watchVod && typeof val.watchVod === "object"
          ? Object.assign(Object.create(null), val.watchVod)
          : Object.create(null),
      watchSeries:
        val.watchSeries && typeof val.watchSeries === "object"
          ? Object.assign(Object.create(null), val.watchSeries)
          : Object.create(null),
      viewSort: {
        vod: ["default", "added", "az"].includes(v.vod) ? v.vod : "default",
        series: ["default", "added", "az"].includes(v.series)
          ? v.series
          : "default",
        live: ["default", "number", "az", "za", "cataz"].includes(v.live)
          ? v.live
          : "default",
      },
      videoScaleLive:
        val.videoScaleLive && typeof val.videoScaleLive === "object"
          ? Object.assign(Object.create(null), val.videoScaleLive)
          : Object.create(null),
      videoScaleVod:
        val.videoScaleVod && typeof val.videoScaleVod === "object"
          ? Object.assign(Object.create(null), val.videoScaleVod)
          : Object.create(null),
      videoScaleSeries:
        val.videoScaleSeries && typeof val.videoScaleSeries === "object"
          ? Object.assign(Object.create(null), val.videoScaleSeries)
          : Object.create(null),
      hideWatchedVod: !!val.hideWatchedVod,
      hideWatchedSeries: !!val.hideWatchedSeries,
      watchedSeriesOverride:
        val.watchedSeriesOverride && typeof val.watchedSeriesOverride === "object"
          ? Object.assign(Object.create(null), val.watchedSeriesOverride)
          : Object.create(null),
      langFilter: {
        vod: typeof langFilterRaw.vod === "string" && LANG_FILTER_PATTERN.test(langFilterRaw.vod)
          ? langFilterRaw.vod
          : "",
        series: typeof langFilterRaw.series === "string" && LANG_FILTER_PATTERN.test(langFilterRaw.series)
          ? langFilterRaw.series
          : "",
      },
      groupLangs: {
        vod: groupLangsRaw.vod !== false,
        series: groupLangsRaw.series !== false,
      },
    })
  }
}

function dehydrate() {
  const out = {}
  for (const [pid, v] of cache) {
    out[pid] = {
      favLive: [...v.favLive],
      favVod: [...v.favVod],
      favSeries: [...v.favSeries],
      favMetaLive: v.favMetaLive,
      favMetaVod: v.favMetaVod,
      favMetaSeries: v.favMetaSeries,
      recLive: v.recLive,
      recVod: v.recVod,
      recSeries: v.recSeries,
      searchRecent: v.searchRecent,
      progVod: v.progVod,
      progEpisode: v.progEpisode,
      hiddenLive: [...v.hiddenLive],
      hiddenVod: [...v.hiddenVod],
      hiddenSeries: [...v.hiddenSeries],
      hiddenEpg: [...v.hiddenEpg],
      allowedLive: [...v.allowedLive],
      allowedVod: [...v.allowedVod],
      allowedSeries: [...v.allowedSeries],
      allowedEpg: [...v.allowedEpg],
      catModeLive: v.catModeLive,
      catModeVod: v.catModeVod,
      catModeSeries: v.catModeSeries,
      catModeEpg: v.catModeEpg,
      catSortLive: v.catSortLive,
      catSortVod: v.catSortVod,
      catSortSeries: v.catSortSeries,
      catSortEpg: v.catSortEpg,
      syncEpgWithLive: v.syncEpgWithLive,
      channelEpgMap: { ...v.channelEpgMap },
      favOrderLive: v.favOrderLive.slice(),
      favOrderVod: v.favOrderVod.slice(),
      favOrderSeries: v.favOrderSeries.slice(),
      watchVod: v.watchVod,
      watchSeries: v.watchSeries,
      viewSort: {
        vod: v.viewSort.vod,
        series: v.viewSort.series,
        live: v.viewSort.live,
      },
      videoScaleLive: { ...v.videoScaleLive },
      videoScaleVod: { ...v.videoScaleVod },
      videoScaleSeries: { ...v.videoScaleSeries },
      hideWatchedVod: v.hideWatchedVod,
      hideWatchedSeries: v.hideWatchedSeries,
      watchedSeriesOverride: { ...v.watchedSeriesOverride },
      langFilter: { vod: v.langFilter.vod, series: v.langFilter.series },
      groupLangs: { vod: v.groupLangs.vod, series: v.groupLangs.series },
    }
  }
  return out
}

export function ensureLoaded() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const raw = await readRaw()
    hydrate(raw)
  })()
  return loadPromise
}

function getOrCreate(playlistId) {
  if (!playlistId) return emptyEntry()
  let entry = cache.get(playlistId)
  if (!entry) {
    entry = emptyEntry()
    cache.set(playlistId, entry)
  }
  return entry
}

let saveScheduled = false
function scheduleSave() {
  if (saveScheduled) return
  saveScheduled = true
  queueMicrotask(async () => {
    saveScheduled = false
    try {
      await writeRaw(dehydrate())
    } catch (saveError) {
      log.error("[xt:prefs] failed to persist preferences:", saveError)
    }
  })
}

function dispatch(name, detail) {
  try {
    document.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** @param {"live"|"vod"|"series"} kind */
function favKey(kind) {
  if (kind === "vod") return "favVod"
  if (kind === "series") return "favSeries"
  return "favLive"
}
/** @param {"live"|"vod"|"series"} kind */
function favMetaKey(kind) {
  if (kind === "vod") return "favMetaVod"
  if (kind === "series") return "favMetaSeries"
  return "favMetaLive"
}
/** @param {"live"|"vod"|"series"} kind */
function recKey(kind) {
  if (kind === "vod") return "recVod"
  if (kind === "series") return "recSeries"
  return "recLive"
}

/**
 * @param {string} playlistId
 * @param {"live"|"vod"} kind
 * @returns {Set<number>}
 */
export function getFavorites(playlistId, kind) {
  const e = cache.get(playlistId)
  return e ? e[favKey(kind)] : new Set()
}

/** @param {string} playlistId @param {"live"|"vod"} kind @param {number} id */
export function isFavorite(playlistId, kind, id) {
  const e = cache.get(playlistId)
  return !!e && e[favKey(kind)].has(id)
}

/**
 * @param {string} playlistId @param {"live"|"vod"|"series"} kind @param {number} id
 * @param {{ name?: string, logo?: string|null }} [extras]
 */
export function toggleFavorite(playlistId, kind, id, extras) {
  if (!playlistId || id == null) return false
  const e = getOrCreate(playlistId)
  const set = e[favKey(kind)]
  const meta = e[favMetaKey(kind)]
  let isFav
  if (set.has(id)) {
    set.delete(id)
    delete meta[String(id)]
    isFav = false
  } else {
    set.add(id)
    if (extras && (extras.name || extras.logo !== undefined)) {
      meta[String(id)] = {
        name: extras.name || meta[String(id)]?.name || "",
        logo: extras.logo === undefined ? meta[String(id)]?.logo || null : extras.logo,
      }
    }
    isFav = true
  }
  scheduleSave()
  dispatch(EVT_FAV_CHANGED, { playlistId, kind, id, isFav })
  return isFav
}

export function setFavoriteMeta(playlistId, kind, id, meta) {
  if (!playlistId || id == null) return
  const e = cache.get(playlistId)
  if (!e || !e[favKey(kind)].has(Number(id))) return
  const bag = e[favMetaKey(kind)]
  const k = String(id)
  const prev = bag[k] || {}
  const next = {
    name: meta?.name || prev.name || "",
    logo: meta?.logo === undefined ? prev.logo || null : meta.logo,
  }
  if (prev.name === next.name && prev.logo === next.logo) return
  bag[k] = next
  scheduleSave()
}

export function getFavoriteMeta(playlistId, kind, id) {
  if (!playlistId || id == null) return null
  const e = cache.get(playlistId)
  if (!e) return null
  return e[favMetaKey(kind)][String(id)] || null
}

// ---------------------------------------------------------------------------
// Watchlist - "want to watch later", separate from favorites
// ---------------------------------------------------------------------------
/** @param {"vod"|"series"} kind */
function watchKey(kind) {
  if (kind === "vod") return "watchVod"
  if (kind === "series") return "watchSeries"
  return null
}

/** @param {string} playlistId @param {"vod"|"series"} kind */
export function getWatchlist(playlistId, kind) {
  const key = watchKey(kind)
  if (!key) return {}
  const e = cache.get(playlistId)
  return e ? e[key] : {}
}

/** @param {string} playlistId @param {"vod"|"series"} kind @param {number} id */
export function isOnWatchlist(playlistId, kind, id) {
  const key = watchKey(kind)
  if (!key) return false
  const e = cache.get(playlistId)
  return !!e && Object.prototype.hasOwnProperty.call(e[key], String(id))
}

/**
 * @param {string} playlistId
 * @param {"vod"|"series"} kind
 * @param {number} id
 * @param {{ name?: string, logo?: string|null }} [extras]
 * @returns {boolean} new state (true = on watchlist)
 */
export function toggleWatchlist(playlistId, kind, id, extras) {
  const key = watchKey(kind)
  if (!key || !playlistId || id == null) return false
  const e = getOrCreate(playlistId)
  const bag = e[key]
  const stringId = String(id)
  let onWatchlist
  if (Object.prototype.hasOwnProperty.call(bag, stringId)) {
    delete bag[stringId]
    onWatchlist = false
  } else {
    bag[stringId] = {
      ts: Date.now(),
      name: extras?.name || "",
      logo: extras?.logo === undefined ? null : extras.logo,
    }
    onWatchlist = true
  }
  scheduleSave()
  dispatch(EVT_WATCHLIST_CHANGED, { playlistId, kind, id, onWatchlist })
  return onWatchlist
}

export function setWatchlistMeta(playlistId, kind, id, meta) {
  const key = watchKey(kind)
  if (!key || !playlistId || id == null) return
  const e = cache.get(playlistId)
  if (!e) return
  const bag = e[key]
  const stringId = String(id)
  const prev = bag[stringId]
  if (!prev) return
  const next = {
    ts: prev.ts,
    name: meta?.name || prev.name || "",
    logo: meta?.logo === undefined ? prev.logo || null : meta.logo,
  }
  if (prev.name === next.name && prev.logo === next.logo) return
  bag[stringId] = next
  scheduleSave()
}

export function getWatchlistMeta(playlistId, kind, id) {
  const key = watchKey(kind)
  if (!key || !playlistId || id == null) return null
  const e = cache.get(playlistId)
  return e?.[key]?.[String(id)] || null
}

/**
 * Cross-playlist union of watchlist entries, sorted by added-time (newest
 * first). Each row carries its source `playlistId` so the caller can switch
 * the active playlist before navigating to detail.
 * @returns {Array<{ playlistId: string, kind: "vod"|"series", id: number, ts: number, name: string, logo: string|null }>}
 */
export function getAllGlobalWatchlist() {
  const out = []
  for (const [playlistId, entry] of cache) {
    for (const kind of /** @type {const} */ (["vod", "series"])) {
      const bag = entry[watchKey(kind)]
      for (const [stringId, meta] of Object.entries(bag)) {
        out.push({
          playlistId,
          kind,
          id: Number(stringId),
          ts: meta?.ts || 0,
          name: meta?.name || "",
          logo: meta?.logo || null,
        })
      }
    }
  }
  out.sort((a, b) => b.ts - a.ts)
  return out
}

/**
 * Sync read of recents. Most-recent first.
 * @param {string} playlistId @param {"live"|"vod"} kind
 * @returns {RecentEntry[]}
 */
export function getRecents(playlistId, kind) {
  const e = cache.get(playlistId)
  return e ? e[recKey(kind)] : []
}

/**
 * @param {string} playlistId @param {"live"|"vod"} kind
 * @param {number} id @param {string} name @param {string|null} [logo]
 */
export function pushRecent(playlistId, kind, id, name, logo = null) {
  if (!playlistId || id == null) return
  const e = getOrCreate(playlistId)
  const list = e[recKey(kind)]
  // If same channel is already at top, just bump ts (no list churn).
  if (list[0] && list[0].id === id) {
    list[0].ts = Date.now()
    list[0].name = name || list[0].name
    if (logo) list[0].logo = logo
  } else {
    const existingIdx = list.findIndex((r) => r.id === id)
    if (existingIdx > 0) list.splice(existingIdx, 1)
    list.unshift({ id, name: name || "", logo: logo || null, ts: Date.now() })
    if (list.length > RECENT_CAP) list.length = RECENT_CAP
  }
  scheduleSave()
  dispatch(EVT_REC_CHANGED, { playlistId, kind })
}

/**
 * Remove one entry from the recents list (e.g. dismissing a live channel from
 * the hub strip). No-op if there's nothing to clear.
 * @param {string} playlistId @param {"live"|"vod"|"series"} kind @param {number} id
 */
export function clearRecent(playlistId, kind, id) {
  if (!playlistId || id == null) return
  const entry = cache.get(playlistId)
  if (!entry) return
  const list = entry[recKey(kind)]
  const idx = list.findIndex((row) => row.id === id)
  if (idx === -1) return
  list.splice(idx, 1)
  scheduleSave()
  dispatch(EVT_REC_CHANGED, { playlistId, kind })
}

/** Clear an entry's prefs (e.g. when its playlist is removed). */
export function clearForPlaylist(playlistId) {
  if (!playlistId) return
  if (cache.delete(playlistId)) scheduleSave()
}

// ---------------------------------------------------------------------------
// Recent searches - committed queries only (never per-keystroke partials).
// ---------------------------------------------------------------------------

/**
 * Sync read of recent searches. Most-recent first.
 * @param {string} playlistId
 * @returns {SearchRecentEntry[]}
 */
export function getRecentSearches(playlistId) {
  const entry = cache.get(playlistId)
  return entry ? entry.searchRecent : []
}

/**
 * Record a committed search query. Ignores empty/short text and
 * case-insensitively dedupes against an existing entry (moved to the top
 * with a fresh timestamp rather than duplicated).
 * @param {string} playlistId @param {string} text
 */
export function pushRecentSearch(playlistId, text) {
  const trimmedText = (text || "").trim()
  if (!playlistId || trimmedText.length < 2) return
  const playlistEntry = getOrCreate(playlistId)
  const list = playlistEntry.searchRecent
  const lowerText = trimmedText.toLowerCase()
  const existingIdx = list.findIndex(
    (searchEntry) => searchEntry.text.toLowerCase() === lowerText
  )
  if (existingIdx !== -1) list.splice(existingIdx, 1)
  list.unshift({ text: trimmedText, ts: Date.now() })
  if (list.length > SEARCH_RECENT_CAP) list.length = SEARCH_RECENT_CAP
  scheduleSave()
  dispatch(EVT_SEARCH_RECENT_CHANGED, { playlistId })
}

/**
 * Remove one entry from the recent-searches list (case-insensitive match).
 * No-op if there's nothing to remove.
 * @param {string} playlistId @param {string} text
 */
export function removeRecentSearch(playlistId, text) {
  if (!playlistId) return
  const playlistEntry = cache.get(playlistId)
  if (!playlistEntry) return
  const lowerText = (text || "").trim().toLowerCase()
  const idx = playlistEntry.searchRecent.findIndex(
    (searchEntry) => searchEntry.text.toLowerCase() === lowerText
  )
  if (idx === -1) return
  playlistEntry.searchRecent.splice(idx, 1)
  scheduleSave()
  dispatch(EVT_SEARCH_RECENT_CHANGED, { playlistId })
}

/** Drop every recent search for a playlist. No-op if already empty. */
export function clearRecentSearches(playlistId) {
  if (!playlistId) return
  const entry = cache.get(playlistId)
  if (!entry || !entry.searchRecent.length) return
  entry.searchRecent = []
  scheduleSave()
  dispatch(EVT_SEARCH_RECENT_CHANGED, { playlistId })
}

// ---------------------------------------------------------------------------
// Playback progress
// ---------------------------------------------------------------------------
/**
 * @typedef {{ position: number, duration: number, updatedAt: number, completed: boolean }} ProgressEntry
 * @typedef {ProgressEntry & { name?: string, logo?: string|null }} VodProgressEntry
 * @typedef {ProgressEntry & {
 *   seriesId: number, season: (string|number), episodeNum: (string|number|null),
 *   episodeTitle?: string, seriesName?: string, seriesLogo?: string|null
 * }} EpisodeProgressEntry
 */

/** @param {"vod"|"episode"} kind */
function progKey(kind) {
  return kind === "episode" ? "progEpisode" : "progVod"
}

/**
 * Sync read of one item's progress.
 * @param {string} playlistId
 * @param {"vod"|"episode"} kind
 * @param {number|string} id
 * @returns {VodProgressEntry|EpisodeProgressEntry|null}
 */
export function getProgress(playlistId, kind, id) {
  if (!playlistId || id == null) return null
  const e = cache.get(playlistId)
  if (!e) return null
  return e[progKey(kind)][String(id)] || null
}

/**
 * @param {string} playlistId
 * @param {"vod"|"episode"} kind
 * @param {number|string} id
 * @returns {boolean}
 */
export function isCompleted(playlistId, kind, id) {
  const p = getProgress(playlistId, kind, id)
  return !!p?.completed
}

/**
 * Returns the progress fraction in [0, 1], or 0 when no progress / unknown
 * duration. Useful for Continue Watching progress pills.
 * @param {string} playlistId
 * @param {"vod"|"episode"} kind
 * @param {number|string} id
 */
export function getProgressFraction(playlistId, kind, id) {
  const p = getProgress(playlistId, kind, id)
  if (!p || !(p.duration > 0)) return 0
  if (p.completed) return 1
  return Math.max(0, Math.min(1, (p.position || 0) / p.duration))
}

function trimBucket(bucket) {
  const retentionDays = getProgressRetentionDays()
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * DAY_MS
    for (const key of Object.keys(bucket)) {
      if ((bucket[key]?.updatedAt || 0) < cutoff) delete bucket[key]
    }
  }
  const keys = Object.keys(bucket)
  if (keys.length <= PROGRESS_CAP) return
  keys.sort((a, b) => (bucket[a].updatedAt || 0) - (bucket[b].updatedAt || 0))
  const drop = keys.slice(0, keys.length - PROGRESS_CAP)
  for (const key of drop) delete bucket[key]
}

/**
 * @param {string} playlistId
 * @param {"vod"|"episode"} kind
 * @param {number|string} id
 * @param {number} position
 * @param {number} duration
 * @param {object} [extras]
 */
export function setProgress(playlistId, kind, id, position, duration, extras) {
  if (!playlistId || id == null) return
  const pos = Number(position) || 0
  const dur = Number(duration) || 0
  const e = getOrCreate(playlistId)
  const bucket = e[progKey(kind)]
  const prev = bucket[String(id)]
  const wasCompleted = !!prev?.completed
  const completed =
    wasCompleted ||
    (dur > 0 && pos / dur >= COMPLETED_THRESHOLD)

  const next = {
    ...(prev || {}),
    ...(extras || {}),
    position: pos,
    duration: dur || prev?.duration || 0,
    updatedAt: Date.now(),
    completed,
  }
  bucket[String(id)] = next
  trimBucket(bucket)
  scheduleSave()

  // Only fire the event when something the UI cares about flipped: a fresh
  // entry, a completion transition, or a meaningful position jump (>=5s).
  // Routine timeupdate ticks (1s drift) shouldn't churn subscribers.
  const positionDelta = Math.abs(pos - (prev?.position || 0))
  const positionChanged = positionDelta >= 5
  const completionChanged = !wasCompleted && completed
  const wasNew = !prev
  if (wasNew || completionChanged || positionChanged) {
    dispatch(EVT_PROGRESS_CHANGED, {
      playlistId,
      kind,
      id,
      completed,
      position: pos,
      duration: next.duration,
    })
  }
}

/**
 * Force an entry to completed (e.g. on the Video.js `ended` event, or when
 * the user manually marks an episode watched).
 * @param {string} playlistId
 * @param {"vod"|"episode"} kind
 * @param {number|string} id
 * @param {object} [extras]
 */
export function markCompleted(playlistId, kind, id, extras) {
  if (!playlistId || id == null) return
  const e = getOrCreate(playlistId)
  const bucket = e[progKey(kind)]
  const prev = bucket[String(id)]
  if (prev?.completed && !extras) return
  const next = {
    ...(prev || {}),
    ...(extras || {}),
    position: prev?.duration || prev?.position || 0,
    duration: prev?.duration || 0,
    updatedAt: Date.now(),
    completed: true,
  }
  bucket[String(id)] = next
  trimBucket(bucket)
  scheduleSave()
  dispatch(EVT_PROGRESS_CHANGED, {
    playlistId,
    kind,
    id,
    completed: true,
    position: next.position,
    duration: next.duration,
  })
}

/**
 * Drop the progress entry for an item (e.g. "rewatch" / "remove from
 * Continue Watching"). No-op if there's nothing to clear.
 * @param {string} playlistId
 * @param {"vod"|"episode"} kind
 * @param {number|string} id
 */
export function clearProgress(playlistId, kind, id) {
  if (!playlistId || id == null) return
  const e = cache.get(playlistId)
  if (!e) return
  const bucket = e[progKey(kind)]
  if (!(String(id) in bucket)) return
  delete bucket[String(id)]
  scheduleSave()
  dispatch(EVT_PROGRESS_CHANGED, { playlistId, kind, id, removed: true })
}

/** @returns {Promise<number>} total items removed */
export async function clearViewingHistory() {
  await ensureLoaded()
  let removed = 0
  const affectedPlaylistIds = []
  for (const [playlistId, entry] of cache) {
    const count =
      entry.recLive.length +
      entry.recVod.length +
      entry.recSeries.length +
      Object.keys(entry.progVod).length +
      Object.keys(entry.progEpisode).length
    if (!count) continue
    entry.recLive = []
    entry.recVod = []
    entry.recSeries = []
    entry.progVod = Object.create(null)
    entry.progEpisode = Object.create(null)
    removed += count
    affectedPlaylistIds.push(playlistId)
  }
  if (!removed) return 0
  scheduleSave()
  for (const playlistId of affectedPlaylistIds) {
    for (const kind of ["live", "vod", "series"]) {
      dispatch(EVT_REC_CHANGED, { playlistId, kind })
    }
    for (const kind of ["vod", "episode"]) {
      dispatch(EVT_PROGRESS_CHANGED, { playlistId, kind, removed: true })
    }
  }
  return removed
}

/**
 * @param {string} playlistId
 * @param {number} [limit]
 * @returns {Array<{kind: "vod"|"episode", id: string} & (VodProgressEntry|EpisodeProgressEntry)>}
 */
export function getContinueWatching(playlistId, limit = 6) {
  const e = cache.get(playlistId)
  if (!e) return []
  const out = []
  for (const [id, p] of Object.entries(e.progVod)) {
    if (p?.completed) continue
    if (!(p?.position > 0)) continue
    out.push({ kind: "vod", id, ...p })
  }
  for (const [id, p] of Object.entries(e.progEpisode)) {
    if (p?.completed) continue
    if (!(p?.position > 0)) continue
    out.push({ kind: "episode", id, ...p })
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out.slice(0, Math.max(0, limit))
}

/**
 * Recently watched vod + episode signals for "Because you watched" seeding.
 * Includes completed entries unconditionally; unfinished entries need the
 * same meaningful-progress gating as getContinueWatching (position > 0).
 * @param {string} playlistId
 * @param {number} [limit]
 * @returns {Array<{kind: "vod"|"episode", id: string, name?: string, seriesId?: number, seriesName?: string, updatedAt: number, completed: boolean}>}
 */
export function getWatchedSignals(playlistId, limit = 20) {
  const entry = cache.get(playlistId)
  if (!entry) return []
  const out = []
  for (const [id, progress] of Object.entries(entry.progVod)) {
    if (!progress?.completed && !(progress?.position > 0)) continue
    out.push({
      kind: "vod",
      id,
      name: progress.name,
      updatedAt: progress.updatedAt || 0,
      completed: !!progress.completed,
    })
  }
  for (const [id, progress] of Object.entries(entry.progEpisode)) {
    if (!progress?.completed && !(progress?.position > 0)) continue
    out.push({
      kind: "episode",
      id,
      seriesId: progress.seriesId,
      seriesName: progress.seriesName,
      updatedAt: progress.updatedAt || 0,
      completed: !!progress.completed,
    })
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out.slice(0, Math.max(0, limit))
}

export const PROGRESS_COMPLETED_THRESHOLD = COMPLETED_THRESHOLD

/**
 * Roll up per-episode progress for a series. Used by the series poster badge
 * and the "next-up" autoplay handoff.
 *
 * @param {string} playlistId
 * @param {number|string} seriesId
 */
export function getSeriesProgressSummary(playlistId, seriesId) {
  if (!playlistId || seriesId == null) return null
  const entry = cache.get(playlistId)
  if (!entry) return null
  const sid = Number(seriesId)
  if (!Number.isFinite(sid)) return null

  let watchedCount = 0
  let lastWatched = null
  let lastEpisodeId = null

  for (const [id, prog] of Object.entries(entry.progEpisode)) {
    if (!prog || Number(prog.seriesId) !== sid) continue
    if (prog.completed || prog.position > 1) watchedCount++
    if (!lastWatched || (prog.updatedAt || 0) > (lastWatched.updatedAt || 0)) {
      lastWatched = prog
      lastEpisodeId = id
    }
  }

  if (!lastWatched) return null
  return {
    watchedCount,
    lastWatched,
    lastEpisodeId,
    lastSeason: lastWatched.season ?? null,
    lastEpisodeNum: lastWatched.episodeNum ?? null,
  }
}

/**
 * Progress-entry rollup for a series: which recorded episode ids are
 * completed, and whether any recorded episode is not. Doesn't know the
 * series' real episode list - callers verify against that separately.
 * @param {string} playlistId
 * @param {number|string} seriesId
 * @returns {{ completedIds: number[], hasIncompleteEpisode: boolean }}
 */
export function getSeriesEpisodeProgress(playlistId, seriesId) {
  const empty = { completedIds: [], hasIncompleteEpisode: false }
  if (!playlistId || seriesId == null) return empty
  const entry = cache.get(playlistId)
  if (!entry) return empty
  const sid = Number(seriesId)
  if (!Number.isFinite(sid)) return empty

  const completedIds = []
  let hasIncompleteEpisode = false
  for (const [episodeId, prog] of Object.entries(entry.progEpisode)) {
    if (!prog || Number(prog.seriesId) !== sid) continue
    if (prog.completed) completedIds.push(Number(episodeId))
    else hasIncompleteEpisode = true
  }
  return { completedIds, hasIncompleteEpisode }
}

/**
 * Manual "mark as watched" override for a series, independent of per-episode
 * progress. Unmarking also clears any recorded episode progress for that
 * series so a re-watch starts clean.
 * @param {string} playlistId
 * @param {number|string} seriesId
 * @param {boolean} watched
 */
export function setSeriesWatchedOverride(playlistId, seriesId, watched) {
  if (!playlistId || seriesId == null) return
  const sid = Number(seriesId)
  if (!Number.isFinite(sid)) return
  const entry = getOrCreate(playlistId)
  const key = String(sid)

  if (watched) {
    if (key in entry.watchedSeriesOverride) return
    entry.watchedSeriesOverride[key] = Date.now()
  } else {
    const hadOverride = key in entry.watchedSeriesOverride
    if (hadOverride) delete entry.watchedSeriesOverride[key]
    let progressRemoved = false
    for (const episodeId of Object.keys(entry.progEpisode)) {
      if (Number(entry.progEpisode[episodeId]?.seriesId) !== sid) continue
      delete entry.progEpisode[episodeId]
      progressRemoved = true
    }
    if (!hadOverride && !progressRemoved) return
  }

  scheduleSave()
  dispatch(EVT_PROGRESS_CHANGED, {
    playlistId,
    kind: "episode",
    seriesId: sid,
    override: true,
  })
}

/** @param {string} playlistId @param {number|string} seriesId */
export function hasSeriesWatchedOverride(playlistId, seriesId) {
  if (!playlistId || seriesId == null) return false
  const entry = cache.get(playlistId)
  if (!entry) return false
  return String(Number(seriesId)) in entry.watchedSeriesOverride
}

// ---------------------------------------------------------------------------
// Hidden categories
// ---------------------------------------------------------------------------
/** @param {"live"|"vod"|"series"|"epg"} kind */
function hiddenKey(kind) {
  if (kind === "vod") return "hiddenVod"
  if (kind === "series") return "hiddenSeries"
  if (kind === "epg") return "hiddenEpg"
  return "hiddenLive"
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind */
export function getHiddenCategories(playlistId, kind) {
  const e = cache.get(playlistId)
  return e ? e[hiddenKey(kind)] : new Set()
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind @param {string|number} categoryId */
export function isCategoryHidden(playlistId, kind, categoryId) {
  if (categoryId == null) return false
  const e = cache.get(playlistId)
  return !!e && e[hiddenKey(kind)].has(String(categoryId))
}

/**
 * @param {string} playlistId
 * @param {"live"|"vod"|"series"|"epg"} kind
 * @param {string|number} categoryId
 * @param {boolean} hidden
 */
export function setCategoryHidden(playlistId, kind, categoryId, hidden) {
  if (!playlistId || categoryId == null) return
  const e = getOrCreate(playlistId)
  const set = e[hiddenKey(kind)]
  const id = String(categoryId)
  const had = set.has(id)
  if (hidden && !had) set.add(id)
  else if (!hidden && had) set.delete(id)
  else return
  scheduleSave()
  dispatch(EVT_HIDDEN_CHANGED, { playlistId, kind, categoryId: id, hidden })
}

/** Filter a category list, dropping hidden ones. Each item must expose
 *  `category_id` (Xtream) or `id` (our M3U-shape category).
 *  @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind */
export function filterVisibleCategories(playlistId, kind, categories) {
  if (!Array.isArray(categories) || !categories.length) return categories || []
  const set = getHiddenCategories(playlistId, kind)
  if (!set.size) return categories
  return categories.filter(
    (c) => !set.has(String(c.category_id ?? c.id ?? ""))
  )
}

// ---------------------------------------------------------------------------
// Allowed categories (allowlist mode) + category filter mode
// ---------------------------------------------------------------------------
/** @param {"live"|"vod"|"series"|"epg"} kind */
function allowedKey(kind) {
  if (kind === "vod") return "allowedVod"
  if (kind === "series") return "allowedSeries"
  if (kind === "epg") return "allowedEpg"
  return "allowedLive"
}

/** @param {"live"|"vod"|"series"|"epg"} kind */
function catModeKey(kind) {
  if (kind === "vod") return "catModeVod"
  if (kind === "series") return "catModeSeries"
  if (kind === "epg") return "catModeEpg"
  return "catModeLive"
}

/** @param {"live"|"vod"|"series"|"epg"} kind */
function catSortKey(kind) {
  if (kind === "vod") return "catSortVod"
  if (kind === "series") return "catSortSeries"
  if (kind === "epg") return "catSortEpg"
  return "catSortLive"
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind */
export function getAllowedCategories(playlistId, kind) {
  const entry = cache.get(playlistId)
  return entry ? entry[allowedKey(kind)] : new Set()
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind @param {string|number} categoryId */
export function isCategoryAllowed(playlistId, kind, categoryId) {
  if (categoryId == null) return false
  const entry = cache.get(playlistId)
  return !!entry && entry[allowedKey(kind)].has(String(categoryId))
}

/**
 * @param {string} playlistId
 * @param {"live"|"vod"|"series"|"epg"} kind
 * @param {string|number} categoryId
 * @param {boolean} allowed
 */
export function setCategoryAllowed(playlistId, kind, categoryId, allowed) {
  if (!playlistId || categoryId == null) return
  const entry = getOrCreate(playlistId)
  const set = entry[allowedKey(kind)]
  const id = String(categoryId)
  const had = set.has(id)
  if (allowed && !had) set.add(id)
  else if (!allowed && had) set.delete(id)
  else return
  scheduleSave()
  dispatch(EVT_ALLOWED_CHANGED, { playlistId, kind, categoryId: id, allowed })
}

/**
 * Replace the entire allowed set for a kind. Useful for "select all visible"
 * in the picker.
 * @param {string} playlistId
 * @param {"live"|"vod"|"series"|"epg"} kind
 * @param {Iterable<string|number>} categoryIds
 */
export function setAllowedCategories(playlistId, kind, categoryIds) {
  if (!playlistId) return
  const entry = getOrCreate(playlistId)
  const next = new Set()
  for (const id of categoryIds || []) {
    if (id == null) continue
    next.add(String(id))
  }
  entry[allowedKey(kind)] = next
  scheduleSave()
  dispatch(EVT_ALLOWED_CHANGED, { playlistId, kind })
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind */
export function getCategoryMode(playlistId, kind) {
  const entry = cache.get(playlistId)
  if (!entry) return "hide"
  return entry[catModeKey(kind)] === "select" ? "select" : "hide"
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind @param {"hide"|"select"} mode */
export function setCategoryMode(playlistId, kind, mode) {
  if (!playlistId) return
  const next = mode === "select" ? "select" : "hide"
  const entry = getOrCreate(playlistId)
  if (entry[catModeKey(kind)] === next) return
  entry[catModeKey(kind)] = next
  scheduleSave()
  dispatch(EVT_CAT_MODE_CHANGED, { playlistId, kind, mode: next })
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind @returns {"default"|"az"|"za"} */
export function getCategorySort(playlistId, kind) {
  const entry = cache.get(playlistId)
  const value = entry?.[catSortKey(kind)]
  return VALID_CATEGORY_SORTS.has(value) ? value : "default"
}

/** @param {string} playlistId @param {"live"|"vod"|"series"|"epg"} kind @param {"default"|"az"|"za"} mode */
export function setCategorySort(playlistId, kind, mode) {
  if (!playlistId) return
  const next = VALID_CATEGORY_SORTS.has(mode) ? mode : "default"
  const entry = getOrCreate(playlistId)
  if (entry[catSortKey(kind)] === next) return
  entry[catSortKey(kind)] = next
  scheduleSave()
  dispatch(EVT_CAT_SORT_CHANGED, { playlistId, kind, mode: next })
}

/**
 * When true (default), EPG reads/writes its hide/allow/mode through Live TV's
 * state so the user only configures category visibility once. Off lets EPG
 * keep its own independent filter.
 *
 * @param {string} playlistId
 */
export function getSyncEpgWithLive(playlistId) {
  const entry = cache.get(playlistId)
  if (!entry) return true
  return entry.syncEpgWithLive !== false
}

/** @param {string} playlistId @param {boolean} on */
export function setSyncEpgWithLive(playlistId, on) {
  if (!playlistId) return
  const entry = getOrCreate(playlistId)
  const next = on !== false
  if (entry.syncEpgWithLive === next) return
  entry.syncEpgWithLive = next
  scheduleSave()
  dispatch(EVT_EPG_SYNC_CHANGED, { playlistId, on: next })
}

/**
 * The kind whose hide/allow/mode the EPG actually consults right now: "live"
 * when the per-playlist sync toggle is on (default), "epg" otherwise.
 * @param {string} playlistId
 * @returns {"live"|"epg"}
 */
export function resolveEpgKind(playlistId) {
  return getSyncEpgWithLive(playlistId) ? "live" : "epg"
}

// ---------------------------------------------------------------------------
// Per-channel EPG tvg-id overrides (Jellyfin-style manual mapping)
// ---------------------------------------------------------------------------

/** @param {string} playlistId */
export function getChannelEpgMap(playlistId) {
  const entry = cache.get(playlistId)
  return entry?.channelEpgMap || Object.create(null)
}

/** @param {string} playlistId @param {number|string} channelId */
export function getChannelEpgOverride(playlistId, channelId) {
  if (channelId == null) return ""
  const map = getChannelEpgMap(playlistId)
  return map[String(channelId)] || ""
}

/**
 * @param {string} playlistId @param {number|string} channelId
 * @param {string} tvgId - empty string clears the override
 */
export function setChannelEpgOverride(playlistId, channelId, tvgId) {
  if (!playlistId || channelId == null) return
  const entry = getOrCreate(playlistId)
  const key = String(channelId)
  const value = (tvgId || "").trim()
  if (!value) {
    if (!(key in entry.channelEpgMap)) return
    delete entry.channelEpgMap[key]
  } else {
    if (entry.channelEpgMap[key] === value) return
    entry.channelEpgMap[key] = value
  }
  scheduleSave()
  dispatch(EVT_CHANNEL_EPG_CHANGED, {
    playlistId,
    channelId: Number(channelId),
    tvgId: value,
  })
}

export function clearChannelEpgOverride(playlistId, channelId) {
  setChannelEpgOverride(playlistId, channelId, "")
}

/** Drop every per-channel override for a playlist. */
export function clearAllChannelEpgOverrides(playlistId) {
  if (!playlistId) return
  const entry = cache.get(playlistId)
  if (!entry || !Object.keys(entry.channelEpgMap).length) return
  entry.channelEpgMap = Object.create(null)
  scheduleSave()
  dispatch(EVT_CHANNEL_EPG_CHANGED, { playlistId, channelId: null, tvgId: "" })
}

export const CHANNEL_EPG_CHANGED_EVENT = EVT_CHANNEL_EPG_CHANGED

// ---------------------------------------------------------------------------
// Per-item video display mode override (Live TV channel / movie / series)
// ---------------------------------------------------------------------------
/** @param {"live"|"vod"|"series"} kind */
function videoScaleKey(kind) {
  if (kind === "vod") return "videoScaleVod"
  if (kind === "series") return "videoScaleSeries"
  return "videoScaleLive"
}

/**
 * @param {string} playlistId @param {"live"|"vod"|"series"} kind
 * @param {number|string} id @returns {string|null}
 */
export function getVideoScaleOverride(playlistId, kind, id) {
  if (!playlistId || id == null) return null
  const entry = cache.get(playlistId)
  return entry?.[videoScaleKey(kind)][String(id)] || null
}

/**
 * @param {string} playlistId @param {"live"|"vod"|"series"} kind
 * @param {number|string} id
 * @param {string|null} mode - null/invalid clears the override
 */
export function setVideoScaleOverride(playlistId, kind, id, mode) {
  if (!playlistId || id == null) return
  const entry = getOrCreate(playlistId)
  const map = entry[videoScaleKey(kind)]
  const key = String(id)
  const isValidMode = mode != null && VIDEO_SCALE_MODES.includes(mode)
  if (!isValidMode) {
    if (!(key in map)) return
    delete map[key]
    scheduleSave()
    dispatch(EVT_CHANNEL_VIDEO_SCALE_CHANGED, {
      playlistId,
      kind,
      itemId: Number(id),
      mode: null,
    })
    return
  }
  const next = normalizeVideoScale(mode)
  if (map[key] === next) return
  map[key] = next
  scheduleSave()
  dispatch(EVT_CHANNEL_VIDEO_SCALE_CHANGED, {
    playlistId,
    kind,
    itemId: Number(id),
    mode: next,
  })
}

/** Drop every per-item display-mode override for a playlist + kind. */
export function clearAllVideoScaleOverrides(playlistId, kind) {
  if (!playlistId) return
  const entry = cache.get(playlistId)
  const mapKey = videoScaleKey(kind)
  if (!entry || !Object.keys(entry[mapKey]).length) return
  entry[mapKey] = Object.create(null)
  scheduleSave()
  dispatch(EVT_CHANNEL_VIDEO_SCALE_CHANGED, { playlistId, kind, itemId: null, mode: null })
}

export const CHANNEL_VIDEO_SCALE_CHANGED_EVENT = EVT_CHANNEL_VIDEO_SCALE_CHANGED

// ---------------------------------------------------------------------------
// Favorites ordering
// ---------------------------------------------------------------------------
/** @param {"live"|"vod"|"series"} kind */
function favOrderKey(kind) {
  if (kind === "vod") return "favOrderVod"
  if (kind === "series") return "favOrderSeries"
  return "favOrderLive"
}

/**
 * @param {string} playlistId @param {"live"|"vod"|"series"} kind
 * @returns {number[]}
 */
export function getFavoritesOrdered(playlistId, kind) {
  const e = cache.get(playlistId)
  if (!e) return []
  const set = e[favKey(kind)]
  if (!set.size) return []
  const order = e[favOrderKey(kind)]
  const out = []
  const seen = new Set()
  for (const id of order) {
    if (set.has(id) && !seen.has(id)) {
      out.push(id)
      seen.add(id)
    }
  }
  for (const id of set) {
    if (!seen.has(id)) out.push(id)
  }
  return out
}

/**
 * @param {string} playlistId @param {"live"|"vod"|"series"} kind @param {number[]} ids
 */
export function setFavoritesOrder(playlistId, kind, ids) {
  if (!playlistId || !Array.isArray(ids)) return
  const e = getOrCreate(playlistId)
  const set = e[favKey(kind)]
  const next = []
  const seen = new Set()
  for (const raw of ids) {
    const id = Number(raw)
    if (!Number.isFinite(id)) continue
    if (!set.has(id) || seen.has(id)) continue
    next.push(id)
    seen.add(id)
  }
  e[favOrderKey(kind)] = next
  scheduleSave()
  dispatch(EVT_FAV_ORDER_CHANGED, { playlistId, kind })
}

/**
 * Move one favorite up or down by one slot. Returns the new order.
 * @param {string} playlistId @param {"live"|"vod"|"series"} kind
 * @param {number} id @param {-1|1} delta -1 = up, +1 = down
 */
export function moveFavorite(playlistId, kind, id, delta) {
  if (!playlistId || id == null || (delta !== -1 && delta !== 1)) return []
  const order = getFavoritesOrdered(playlistId, kind)
  const idx = order.indexOf(Number(id))
  if (idx === -1) return order
  const target = idx + delta
  if (target < 0 || target >= order.length) return order
  ;[order[idx], order[target]] = [order[target], order[idx]]
  setFavoritesOrder(playlistId, kind, order)
  return order
}

/**
 * @param {string} playlistId
 * @returns {Array<{ kind: "live"|"vod"|"series", id: number }>}
 */
export function getGlobalFavorites(playlistId) {
  if (!playlistId) return []
  const out = []
  for (const kind of /** @type {const} */ (["live", "vod", "series"])) {
    for (const id of getFavoritesOrdered(playlistId, kind)) {
      out.push({ kind, id })
    }
  }
  return out
}

/**
 * Cross-playlist union of favorites. Each row keeps its source `playlistId`
 * so the caller can switch the active playlist before navigating to detail.
 * Entries are grouped by playlist (insertion order in the cache) and ordered
 * within a playlist by `getFavoritesOrdered`.
 * @returns {Array<{ playlistId: string, kind: "live"|"vod"|"series", id: number }>}
 */
export function getAllGlobalFavorites() {
  const out = []
  for (const playlistId of cache.keys()) {
    for (const kind of /** @type {const} */ (["live", "vod", "series"])) {
      for (const id of getFavoritesOrdered(playlistId, kind)) {
        out.push({ playlistId, kind, id })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// View sort preferences (recently-added etc.)
// ---------------------------------------------------------------------------
const VALID_SORTS_BY_KIND = {
  vod: new Set(["default", "added", "rating", "az"]),
  series: new Set(["default", "added", "rating", "az"]),
  live: new Set(["default", "number", "az", "za", "cataz"]),
}

/** @param {string} playlistId @param {"vod"|"series"|"live"} kind */
export function getViewSort(playlistId, kind) {
  const e = cache.get(playlistId)
  const v = e?.viewSort?.[kind]
  return VALID_SORTS_BY_KIND[kind]?.has(v) ? v : "default"
}

/** @param {string} playlistId @param {"vod"|"series"|"live"} kind @param {string} mode */
export function setViewSort(playlistId, kind, mode) {
  if (!playlistId) return
  const m = VALID_SORTS_BY_KIND[kind]?.has(mode) ? mode : "default"
  const e = getOrCreate(playlistId)
  if (e.viewSort[kind] === m) return
  e.viewSort[kind] = m
  scheduleSave()
  dispatch(EVT_VIEW_CHANGED, { playlistId, kind, mode: m })
}

// ---------------------------------------------------------------------------
// Hide watched (movies / series grid toggle)
// ---------------------------------------------------------------------------
const HIDE_WATCHED_KEY_BY_KIND = { vod: "hideWatchedVod", series: "hideWatchedSeries" }

/** @param {string} playlistId @param {"vod"|"series"} kind */
export function getHideWatched(playlistId, kind) {
  const entry = cache.get(playlistId)
  return !!entry?.[HIDE_WATCHED_KEY_BY_KIND[kind]]
}

/** @param {string} playlistId @param {"vod"|"series"} kind @param {boolean} enabled */
export function setHideWatched(playlistId, kind, enabled) {
  if (!playlistId) return
  const key = HIDE_WATCHED_KEY_BY_KIND[kind]
  if (!key) return
  const entry = getOrCreate(playlistId)
  const next = !!enabled
  if (entry[key] === next) return
  entry[key] = next
  scheduleSave()
  dispatch(EVT_HIDE_WATCHED_CHANGED, { playlistId, kind, enabled: next })
}

/** @param {string} playlistId @param {"vod"|"series"} kind */
export function getLanguageFilter(playlistId, kind) {
  const entry = cache.get(playlistId)
  return entry?.langFilter?.[kind] || ""
}

/** @param {string} playlistId @param {"vod"|"series"} kind @param {string} tag */
export function setLanguageFilter(playlistId, kind, tag) {
  if (!playlistId) return
  const normalized = String(tag || "").toUpperCase()
  const sanitized = LANG_FILTER_PATTERN.test(normalized) ? normalized : ""
  const entry = getOrCreate(playlistId)
  if (entry.langFilter[kind] === sanitized) return
  entry.langFilter[kind] = sanitized
  scheduleSave()
  dispatch(EVT_LANG_FILTER_CHANGED, { playlistId, kind, tag: sanitized })
}

/** @param {string} playlistId @param {"vod"|"series"} kind */
export function getGroupLanguages(playlistId, kind) {
  const entry = cache.get(playlistId)
  return entry?.groupLangs?.[kind] !== false
}

/** @param {string} playlistId @param {"vod"|"series"} kind @param {boolean} enabled */
export function setGroupLanguages(playlistId, kind, enabled) {
  if (!playlistId) return
  const entry = getOrCreate(playlistId)
  const next = !!enabled
  if (entry.groupLangs[kind] === next) return
  entry.groupLangs[kind] = next
  scheduleSave()
  dispatch(EVT_GROUP_LANGS_CHANGED, { playlistId, kind, enabled: next })
}

// ---------------------------------------------------------------------------
// Bulk export / import (used by backup.js)
// ---------------------------------------------------------------------------
/** Snapshot the in-memory cache as JSON-safe data. */
export function snapshotPrefs() {
  return dehydrate()
}

export async function restorePrefs(snapshot) {
  hydrate(snapshot && typeof snapshot === "object" ? snapshot : {})
  await writeRaw(dehydrate())
}
