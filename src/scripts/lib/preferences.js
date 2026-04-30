// Per-playlist favorites + recently-played + playback progress, persisted
// alongside creds.
//
// Storage shape (one JSON blob under "xt_prefs"):
//   { [playlistId]: {
//       favLive: number[], favVod: number[], favSeries: number[],
//       recLive: RecentEntry[], recVod: RecentEntry[], recSeries: RecentEntry[],
//       progVod: { [movieId]: VodProgressEntry },
//       progEpisode: { [episodeId]: EpisodeProgressEntry }
//     } }
// RecentEntry          = { id, name, logo?, ts }   // ts = ms since epoch
// ProgressEntry        = { position, duration, updatedAt, completed }
// VodProgressEntry     = ProgressEntry & { name?, logo? }
// EpisodeProgressEntry = ProgressEntry & {
//   seriesId, season, episodeNum, episodeTitle?, seriesName?, seriesLogo?
// }
//
// Live channel ids, VOD movie ids and series ids each share a numeric space
// per provider but mean different things, so favorites/recents/progress are
// namespaced by kind at the leaf, not by id.
//
// Same dual-mode persistence as creds.js: Tauri plugin-store on desktop,
// localStorage + cookie on web/SSR. Reads are served from an in-memory cache
// that is hydrated lazily on first use, so per-row hot paths
// (e.g. virtualised channel render, episode list paint) can stay synchronous.
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
    recLive: [],
    recVod: [],
    recSeries: [],
    progVod: Object.create(null),
    progEpisode: Object.create(null),
  }
}

function hydrate(raw) {
  cache = new Map()
  if (!raw || typeof raw !== "object") return
  for (const [pid, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue
    cache.set(pid, {
      favLive: new Set(Array.isArray(val.favLive) ? val.favLive : []),
      favVod: new Set(Array.isArray(val.favVod) ? val.favVod : []),
      favSeries: new Set(Array.isArray(val.favSeries) ? val.favSeries : []),
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
      recLive: v.recLive,
      recVod: v.recVod,
      recSeries: v.recSeries,
      progVod: v.progVod,
      progEpisode: v.progEpisode,
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
function recKey(kind) {
  if (kind === "vod") return "recVod"
  if (kind === "series") return "recSeries"
  return "recLive"
}

/**
 * Synchronous read from the in-memory cache. Caller is responsible for
 * `await ensureLoaded()` before relying on results - but if loading hasn't
 * happened yet, this returns an empty Set rather than throwing, which is
 * correct for "show no stars yet" behaviour during the initial render.
 *
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
 * Toggle and persist. Returns the new state (true = is now a favorite).
 * @param {string} playlistId @param {"live"|"vod"} kind @param {number} id
 */
export function toggleFavorite(playlistId, kind, id) {
  if (!playlistId || id == null) return false
  const e = getOrCreate(playlistId)
  const set = e[favKey(kind)]
  let isFav
  if (set.has(id)) {
    set.delete(id)
    isFav = false
  } else {
    set.add(id)
    isFav = true
  }
  scheduleSave()
  dispatch(EVT_FAV_CHANGED, { playlistId, kind, id, isFav })
  return isFav
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
 * Push an entry to recents. Dedupes (same id moves to top), capped at
 * RECENT_CAP. Safe to call on every play() - internal short-circuit keeps it
 * cheap when the same channel is replayed. We store name + logo alongside the
 * id so the recent rail can render *before* the channel list has loaded
 * (matches iptvnator's pattern: recents survive a stale-cache cold start).
 *
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

/**
 * Trim the kind-bucket so it doesn't grow without bound. Drops the
 * oldest-updated entries when over PROGRESS_CAP. Keeps completed entries
 * in eviction order with everything else - the Continue Watching strip
 * filters them out anyway.
 */
function trimBucket(bucket) {
  const keys = Object.keys(bucket)
  if (keys.length <= PROGRESS_CAP) return
  keys.sort((a, b) => (bucket[a].updatedAt || 0) - (bucket[b].updatedAt || 0))
  const drop = keys.slice(0, keys.length - PROGRESS_CAP)
  for (const k of drop) delete bucket[k]
}

/**
 * Record progress for a movie or episode. `position` and `duration` are in
 * seconds. When `position / duration >= COMPLETED_THRESHOLD`, the entry is
 * marked completed; subsequent setProgress calls won't un-complete it.
 *
 * For VOD entries, pass `extras` with name / logo so the Continue Watching
 * strip can render without depending on a fresh VOD list cache.
 *
 * For episode entries, pass `extras` with seriesId / season / episodeNum
 * (and optionally episodeTitle / seriesName / seriesLogo) so the Continue
 * Watching strip can render without depending on a fresh series list.
 *
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
 * Continue Watching entries for a playlist - in-progress (not completed)
 * movies and episodes, sorted most-recent-first. Each entry has a `kind`
 * and `id` plus the underlying ProgressEntry fields, so the caller can
 * render without further lookups (episodes carry seriesId / season /
 * episodeNum / seriesName / seriesLogo on the record itself).
 *
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
