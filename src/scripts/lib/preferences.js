// Per-playlist favorites + recently-played, persisted alongside creds.
//
// Storage shape (one JSON blob under "xt_prefs"):
//   { [playlistId]: { favLive: number[], favVod: number[],
//                     recLive: RecentEntry[], recVod: RecentEntry[] } }
// RecentEntry = { id, name, ts }   // ts = ms since epoch
//
// Live channel ids and VOD movie ids share the same numeric space per
// provider but mean different things, so favorites/recents are namespaced
// by kind ("live" | "vod") at the leaf, not by id.
//
// Same dual-mode persistence as creds.js: Tauri plugin-store on desktop,
// localStorage + cookie on web/SSR. Reads are served from an in-memory cache
// that is hydrated lazily on first use, so per-row hot paths
// (e.g. virtualised channel render) can stay synchronous.
import { Store } from "@tauri-apps/plugin-store"

const isTauri =
  typeof window !== "undefined" && !!window.__TAURI__

const STORAGE_KEY = "xt_prefs"
const RECENT_CAP = 30
const EVT_FAV_CHANGED = "xt:favorites-changed"
const EVT_REC_CHANGED = "xt:recents-changed"

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
// Raw read / write — mirrors creds.js
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
 * @typedef {{ favLive: Set<number>, favVod: Set<number>,
 *             recLive: RecentEntry[], recVod: RecentEntry[] }} PlaylistPrefs
 */

/** @type {Map<string, PlaylistPrefs>} */
let cache = new Map()
let loadPromise = null

function emptyEntry() {
  return { favLive: new Set(), favVod: new Set(), recLive: [], recVod: [] }
}

function hydrate(raw) {
  cache = new Map()
  if (!raw || typeof raw !== "object") return
  for (const [pid, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue
    cache.set(pid, {
      favLive: new Set(Array.isArray(val.favLive) ? val.favLive : []),
      favVod: new Set(Array.isArray(val.favVod) ? val.favVod : []),
      recLive: Array.isArray(val.recLive) ? val.recLive.slice(0, RECENT_CAP) : [],
      recVod: Array.isArray(val.recVod) ? val.recVod.slice(0, RECENT_CAP) : [],
    })
  }
}

function dehydrate() {
  const out = {}
  for (const [pid, v] of cache) {
    out[pid] = {
      favLive: [...v.favLive],
      favVod: [...v.favVod],
      recLive: v.recLive,
      recVod: v.recVod,
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
  // Coalesce rapid mutations (e.g. push recent on play() while user is also
  // toggling a favorite). One write per microtask is plenty.
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

/** @param {"live"|"vod"} kind */
function favKey(kind) {
  return kind === "vod" ? "favVod" : "favLive"
}
/** @param {"live"|"vod"} kind */
function recKey(kind) {
  return kind === "vod" ? "recVod" : "recLive"
}

/**
 * Synchronous read from the in-memory cache. Caller is responsible for
 * `await ensureLoaded()` before relying on results — but if loading hasn't
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
 * RECENT_CAP. Safe to call on every play() — internal short-circuit keeps it
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
