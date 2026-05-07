// IndexedDB-backed catalog cache with in-memory hydration layer
import { log } from "@/scripts/lib/log.js"

const PREFIX = "xt_cache:"
const DB_NAME = "xt_cache"
const DB_VERSION = 1
const STORE = "entries"
const META_LS_KEY = "xt_cache_meta" // legacy; kept only for clean-up.
const EVT_REVALIDATED = "xt:cache-revalidated"

const makeKey = (entryId, kind) => `${PREFIX}${entryId}:${kind}`

// ---------------------------------------------------------------------------
// In-memory layer
// ---------------------------------------------------------------------------
/** @type {Map<string, { data: any, fetchedAt: number, ttl: number }>} */
const _mem = new Map()

// ---------------------------------------------------------------------------
// IndexedDB layer
// ---------------------------------------------------------------------------
/** @type {Promise<IDBDatabase>|null} */
let _dbPromise = null

function openDB() {
  if (_dbPromise) return _dbPromise
  if (typeof indexedDB === "undefined") {
    _dbPromise = Promise.reject(new Error("IndexedDB unavailable"))
    return _dbPromise
  }
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error("IDB blocked"))
  })
  return _dbPromise
}

async function idbGet(key) {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

async function idbPut(key, value) {
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => {
        log.warn("[xt:cache] idbPut tx error for", key, tx.error)
        resolve(false)
      }
      tx.onabort = () => {
        log.warn("[xt:cache] idbPut tx aborted for", key, tx.error)
        resolve(false)
      }
    })
  } catch (e) {
    log.warn("[xt:cache] idbPut threw for", key, e)
    return false
  }
}

async function idbDelete(key) {
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => {
        log.warn("[xt:cache] idbDelete tx error for", key, tx.error)
        resolve(false)
      }
    })
  } catch (e) {
    log.warn("[xt:cache] idbDelete threw for", key, e)
    return false
  }
}

async function idbAllKeys() {
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => resolve([])
    })
  } catch {
    return []
  }
}

async function idbDeleteWhere(prefix) {
  try {
    const db = await openDB()
    const keys = await idbAllKeys()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      const store = tx.objectStore(STORE)
      let removed = 0
      for (const k of keys) {
        if (typeof k === "string" && k.startsWith(prefix)) {
          store.delete(k)
          removed++
        }
      }
      tx.oncomplete = () => resolve(removed)
      tx.onerror = () => {
        log.warn("[xt:cache] idbDeleteWhere tx error for prefix", prefix, tx.error)
        resolve(removed)
      }
    })
  } catch (e) {
    log.warn("[xt:cache] idbDeleteWhere threw for prefix", prefix, e)
    return 0
  }
}

async function idbClearAll() {
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => {
        log.warn("[xt:cache] idbClearAll tx error", tx.error)
        resolve(false)
      }
    })
  } catch (e) {
    log.warn("[xt:cache] idbClearAll threw", e)
    return false
  }
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------
/** @type {Map<string, Promise<void>>} */
const _hydrating = new Map()

export async function hydrate(entryId, kind) {
  if (!entryId) return
  const key = makeKey(entryId, kind)
  if (_mem.has(key)) return
  if (_hydrating.has(key)) return _hydrating.get(key)
  const p = (async () => {
    const obj = await idbGet(key)
    if (obj && typeof obj === "object" && "data" in obj) {
      _mem.set(key, obj)
    }
  })()
  _hydrating.set(key, p)
  try {
    await p
  } finally {
    _hydrating.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync cache read from the in-memory map. Returns null if not hydrated.
 * For data that might live in IDB, await hydrate() or cachedFetch() first.
 *
 * @returns {{ data: any, fetchedAt: number, age: number } | null}
 */
export function getCached(entryId, kind) {
  if (!entryId) return null
  const key = makeKey(entryId, kind)
  const e = _mem.get(key)
  if (!e) return null
  const age = Date.now() - e.fetchedAt
  return { data: e.data, fetchedAt: e.fetchedAt, age, stale: age > e.ttl }
}

export function setCached(entryId, kind, data, ttlMs) {
  if (!entryId) return
  const key = makeKey(entryId, kind)
  const payload = { data, fetchedAt: Date.now(), ttl: ttlMs }
  _mem.set(key, payload)
  idbPut(key, payload).catch((e) =>
    log.warn("[xt:cache] IDB write failed:", e)
  )
}

/**
 * Cache-or-fetch primitive. Hydrates from IDB first, returns cached value
 * if fresh, otherwise runs the fetcher and persists.
 *
 * @param {string} entryId
 * @param {string} kind
 * @param {number} ttlMs
 * @param {() => Promise<any>} fetcher
 * @param {{ force?: boolean }} [opts]
 */
export async function cachedFetch(entryId, kind, ttlMs, fetcher, opts = {}) {
  if (!opts.force) {
    await hydrate(entryId, kind)
    const hit = getCached(entryId, kind)
    if (hit && !hit.stale) {
      return { data: hit.data, fromCache: true, age: hit.age, stale: false }
    }
    if (hit && hit.stale) {
      revalidateInBackground(entryId, kind, ttlMs, fetcher)
      return { data: hit.data, fromCache: true, age: hit.age, stale: true }
    }
  }
  const data = await fetcher()
  setCached(entryId, kind, data, ttlMs)
  return { data, fromCache: false, age: 0, stale: false }
}

const _revalidating = new Map()

function revalidateInBackground(entryId, kind, ttlMs, fetcher) {
  const key = makeKey(entryId, kind)
  if (_revalidating.has(key)) return _revalidating.get(key)
  const promise = (async () => {
    try {
      const data = await fetcher()
      setCached(entryId, kind, data, ttlMs)
      try {
        document.dispatchEvent(
          new CustomEvent(EVT_REVALIDATED, { detail: { entryId, kind } })
        )
      } catch {}
    } catch (e) {
      log.warn("[xt:cache] revalidate failed:", kind, e?.message || e)
    } finally {
      _revalidating.delete(key)
    }
  })()
  _revalidating.set(key, promise)
  return promise
}

export const CACHE_REVALIDATED_EVENT = EVT_REVALIDATED

/** Drop every cache entry for one playlist (e.g. on edit/remove). */
export function invalidateEntry(entryId) {
  if (!entryId) return
  const prefix = `${PREFIX}${entryId}:`
  for (const k of [..._mem.keys()]) {
    if (k.startsWith(prefix)) _mem.delete(k)
  }
  idbDeleteWhere(prefix).catch(() => {})
}

/** Drop one specific (entry, kind) combo. */
export function invalidate(entryId, kind) {
  if (!entryId) return
  const key = makeKey(entryId, kind)
  _mem.delete(key)
  idbDelete(key).catch(() => {})
}

/** Newest fetchedAt across kinds for one playlist (in-memory only). */
export function getNewestCacheTime(entryId) {
  if (!entryId) return null
  const prefix = `${PREFIX}${entryId}:`
  let newest = 0
  for (const [k, e] of _mem) {
    if (k.startsWith(prefix) && e.fetchedAt > newest) newest = e.fetchedAt
  }
  return newest > 0 ? newest : null
}

export async function getNewestCacheTimeAsync(entryId) {
  if (!entryId) return null
  const prefix = `${PREFIX}${entryId}:`
  const keys = await idbAllKeys()
  let newest = 0
  for (const k of keys) {
    if (typeof k !== "string" || !k.startsWith(prefix)) continue
    const v = await idbGet(k)
    if (v?.fetchedAt && v.fetchedAt > newest) newest = v.fetchedAt
  }
  return newest > 0 ? newest : null
}

export async function getCacheSizeAsync() {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.storage?.estimate
    ) {
      const est = await navigator.storage.estimate()
      if (typeof est.usage === "number") return est.usage
    }
  } catch {}
  // Fallback: stringify each entry. Slow on big catalogs but rare path.
  const keys = await idbAllKeys()
  let bytes = 0
  for (const k of keys) {
    if (typeof k !== "string" || !k.startsWith(PREFIX)) continue
    const v = await idbGet(k)
    try {
      bytes += k.length + JSON.stringify(v).length
    } catch {}
  }
  return bytes
}

export function getCacheEntryCount() {
  let n = 0
  for (const k of _mem.keys()) {
    if (k.startsWith(PREFIX)) n++
  }
  return n
}

/**
 * Wipe every cache entry across all playlists. Used by Settings.
 * @returns {Promise<number>} number of entries removed
 */
export async function clearAll() {
  const before = (await idbAllKeys()).filter(
    (k) => typeof k === "string" && k.startsWith(PREFIX)
  ).length
  _mem.clear()
  await idbClearAll()
  // Clean up legacy localStorage cache entries from prior versions.
  try {
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.startsWith(PREFIX) || k === META_LS_KEY)) toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {}
  try {
    const sessRemove = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(PREFIX)) sessRemove.push(k)
    }
    for (const k of sessRemove) sessionStorage.removeItem(k)
  } catch {}
  return before
}

// ---------------------------------------------------------------------------
// One-time cleanup of legacy localStorage entries.
// ---------------------------------------------------------------------------
const LEGACY_CLEANUP_SENTINEL = "xt_cache_legacy_cleaned_v1"
function runLegacyCleanup() {
  try {
    if (sessionStorage.getItem(LEGACY_CLEANUP_SENTINEL) === "1") return
  } catch {}
  try {
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.startsWith(PREFIX) || k === META_LS_KEY)) toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {}
  try {
    sessionStorage.setItem(LEGACY_CLEANUP_SENTINEL, "1")
  } catch {}
}
if (typeof window !== "undefined") {
  const ric =
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback
      : (callback) => setTimeout(callback, 1)
  ric(runLegacyCleanup, { timeout: 5000 })
}
