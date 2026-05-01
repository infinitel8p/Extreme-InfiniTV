// Per-playlist favorites + recently-played + playback progress + view
// preferences (hidden categories, sort order), persisted alongside creds.
import { Store } from "@tauri-apps/plugin-store"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

const STORAGE_KEY = "xt_prefs"
const RECENT_CAP = 30
const PROGRESS_CAP = 200
const COMPLETED_THRESHOLD = 0.95
const EVT_FAV_CHANGED = "xt:favorites-changed"
const EVT_REC_CHANGED = "xt:recents-changed"
const EVT_PROGRESS_CHANGED = "xt:progress-changed"
const EVT_HIDDEN_CHANGED = "xt:hidden-categories-changed"
const EVT_ALLOWED_CHANGED = "xt:allowed-categories-changed"
const EVT_CAT_MODE_CHANGED = "xt:category-mode-changed"
const EVT_VIEW_CHANGED = "xt:view-prefs-changed"
const EVT_FAV_ORDER_CHANGED = "xt:favorites-order-changed"

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
  } catch {}
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
/**
 * @typedef {{ id: number, name: string, logo?: string|null, ts: number }} RecentEntry
 * @typedef {{ favLive: Set<number>, favVod: Set<number>, favSeries: Set<number>,
 *             recLive: RecentEntry[], recVod: RecentEntry[], recSeries: RecentEntry[] }} PlaylistPrefs
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
    progVod: Object.create(null),
    progEpisode: Object.create(null),
    hiddenLive: new Set(),
    hiddenVod: new Set(),
    hiddenSeries: new Set(),
    allowedLive: new Set(),
    allowedVod: new Set(),
    allowedSeries: new Set(),
    catModeLive: "hide",
    catModeVod: "hide",
    catModeSeries: "hide",
    favOrderLive: [],
    favOrderVod: [],
    favOrderSeries: [],
    viewSort: { vod: "default", series: "default" },
  }
}

function hydrate(raw) {
  cache = new Map()
  if (!raw || typeof raw !== "object") return
  for (const [pid, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue
    const v = val.viewSort && typeof val.viewSort === "object" ? val.viewSort : {}
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
      allowedLive: new Set(
        Array.isArray(val.allowedLive) ? val.allowedLive.map(String) : []
      ),
      allowedVod: new Set(
        Array.isArray(val.allowedVod) ? val.allowedVod.map(String) : []
      ),
      allowedSeries: new Set(
        Array.isArray(val.allowedSeries) ? val.allowedSeries.map(String) : []
      ),
      catModeLive: val.catModeLive === "select" ? "select" : "hide",
      catModeVod: val.catModeVod === "select" ? "select" : "hide",
      catModeSeries: val.catModeSeries === "select" ? "select" : "hide",
      favOrderLive: Array.isArray(val.favOrderLive)
        ? val.favOrderLive.map(Number).filter(Number.isFinite)
        : [],
      favOrderVod: Array.isArray(val.favOrderVod)
        ? val.favOrderVod.map(Number).filter(Number.isFinite)
        : [],
      favOrderSeries: Array.isArray(val.favOrderSeries)
        ? val.favOrderSeries.map(Number).filter(Number.isFinite)
        : [],
      viewSort: {
        vod: ["default", "added", "az"].includes(v.vod) ? v.vod : "default",
        series: ["default", "added", "az"].includes(v.series)
          ? v.series
          : "default",
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
      progVod: v.progVod,
      progEpisode: v.progEpisode,
      hiddenLive: [...v.hiddenLive],
      hiddenVod: [...v.hiddenVod],
      hiddenSeries: [...v.hiddenSeries],
      allowedLive: [...v.allowedLive],
      allowedVod: [...v.allowedVod],
      allowedSeries: [...v.allowedSeries],
      catModeLive: v.catModeLive,
      catModeVod: v.catModeVod,
      catModeSeries: v.catModeSeries,
      favOrderLive: v.favOrderLive.slice(),
      favOrderVod: v.favOrderVod.slice(),
      favOrderSeries: v.favOrderSeries.slice(),
      viewSort: { vod: v.viewSort.vod, series: v.viewSort.series },
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
    } catch {}
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
  const keys = Object.keys(bucket)
  if (keys.length <= PROGRESS_CAP) return
  keys.sort((a, b) => (bucket[a].updatedAt || 0) - (bucket[b].updatedAt || 0))
  const drop = keys.slice(0, keys.length - PROGRESS_CAP)
  for (const k of drop) delete bucket[k]
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

// ---------------------------------------------------------------------------
// Hidden categories
// ---------------------------------------------------------------------------
/** @param {"live"|"vod"|"series"} kind */
function hiddenKey(kind) {
  if (kind === "vod") return "hiddenVod"
  if (kind === "series") return "hiddenSeries"
  return "hiddenLive"
}

/** @param {string} playlistId @param {"live"|"vod"|"series"} kind */
export function getHiddenCategories(playlistId, kind) {
  const e = cache.get(playlistId)
  return e ? e[hiddenKey(kind)] : new Set()
}

/** @param {string} playlistId @param {"live"|"vod"|"series"} kind @param {string|number} categoryId */
export function isCategoryHidden(playlistId, kind, categoryId) {
  if (categoryId == null) return false
  const e = cache.get(playlistId)
  return !!e && e[hiddenKey(kind)].has(String(categoryId))
}

/**
 * @param {string} playlistId
 * @param {"live"|"vod"|"series"} kind
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
 *  `category_id` (Xtream) or `id` (our M3U-shape category). */
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
/** @param {"live"|"vod"|"series"} kind */
function allowedKey(kind) {
  if (kind === "vod") return "allowedVod"
  if (kind === "series") return "allowedSeries"
  return "allowedLive"
}

/** @param {"live"|"vod"|"series"} kind */
function catModeKey(kind) {
  if (kind === "vod") return "catModeVod"
  if (kind === "series") return "catModeSeries"
  return "catModeLive"
}

/** @param {string} playlistId @param {"live"|"vod"|"series"} kind */
export function getAllowedCategories(playlistId, kind) {
  const entry = cache.get(playlistId)
  return entry ? entry[allowedKey(kind)] : new Set()
}

/** @param {string} playlistId @param {"live"|"vod"|"series"} kind @param {string|number} categoryId */
export function isCategoryAllowed(playlistId, kind, categoryId) {
  if (categoryId == null) return false
  const entry = cache.get(playlistId)
  return !!entry && entry[allowedKey(kind)].has(String(categoryId))
}

/**
 * @param {string} playlistId
 * @param {"live"|"vod"|"series"} kind
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
 * @param {"live"|"vod"|"series"} kind
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

/** @param {string} playlistId @param {"live"|"vod"|"series"} kind */
export function getCategoryMode(playlistId, kind) {
  const entry = cache.get(playlistId)
  if (!entry) return "hide"
  return entry[catModeKey(kind)] === "select" ? "select" : "hide"
}

/** @param {string} playlistId @param {"live"|"vod"|"series"} kind @param {"hide"|"select"} mode */
export function setCategoryMode(playlistId, kind, mode) {
  if (!playlistId) return
  const next = mode === "select" ? "select" : "hide"
  const entry = getOrCreate(playlistId)
  if (entry[catModeKey(kind)] === next) return
  entry[catModeKey(kind)] = next
  scheduleSave()
  dispatch(EVT_CAT_MODE_CHANGED, { playlistId, kind, mode: next })
}

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
const VALID_SORTS = new Set(["default", "added", "az"])

/** @param {string} playlistId @param {"vod"|"series"} kind */
export function getViewSort(playlistId, kind) {
  const e = cache.get(playlistId)
  const v = e?.viewSort?.[kind]
  return VALID_SORTS.has(v) ? v : "default"
}

/** @param {string} playlistId @param {"vod"|"series"} kind @param {string} mode */
export function setViewSort(playlistId, kind, mode) {
  if (!playlistId) return
  const m = VALID_SORTS.has(mode) ? mode : "default"
  const e = getOrCreate(playlistId)
  if (e.viewSort[kind] === m) return
  e.viewSort[kind] = m
  scheduleSave()
  dispatch(EVT_VIEW_CHANGED, { playlistId, kind, mode: m })
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
