// IndexedDB-backed catalog cache with in-memory hydration layer
import { log } from "@/scripts/lib/log.js"

const PREFIX = "xt_cache:"
const DB_NAME = "xt_cache"
const DB_VERSION = 3
const STORE = "entries"
const META_LS_KEY = "xt_cache_meta" // legacy; kept only for clean-up.
const EVT_REVALIDATED = "xt:cache-revalidated"
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30d
const PRUNE_SENTINEL_KEY = "xt_cache_last_pruned_at"
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000 // run sweep at most once a day

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
    return Promise.reject(new Error("IndexedDB unavailable"))
  }
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      } else if (event.oldVersion < 3) {
        req.transaction.objectStore(STORE).clear()
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error("IDB blocked"))
  })
  _dbPromise.catch(() => {
    _dbPromise = null
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

let _pruneRan = false
async function pruneOldEntries() {
  if (_pruneRan) return
  _pruneRan = true
  try {
    let lastPrune = 0
    try { lastPrune = Number(localStorage.getItem(PRUNE_SENTINEL_KEY)) || 0 } catch {}
    if (Date.now() - lastPrune < PRUNE_INTERVAL_MS) return
    const keys = await idbAllKeys()
    let removed = 0
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(PREFIX)) continue
      const value = await idbGet(key)
      const fetchedAt = value?.fetchedAt || 0
      if (fetchedAt && Date.now() - fetchedAt > MAX_AGE_MS) {
        await idbDelete(key)
        _mem.delete(key)
        removed++
      }
    }
    try { localStorage.setItem(PRUNE_SENTINEL_KEY, String(Date.now())) } catch {}
    if (removed > 0) log.log("[xt:cache] pruned", removed, "stale entries (>30d)")
  } catch (e) {
    log.warn("[xt:cache] prune sweep failed:", e)
  }
}

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
  if (!_pruneRan) {
    const ric =
      typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback
        : (callback) => setTimeout(callback, 500)
    ric(() => { pruneOldEntries() }, { timeout: 5000 })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync cache read from the in-memory map. Returns null if not hydrated
 * (await hydrate() / cachedFetch() first for data that may live in IDB).
 * When hit, callers should consult the `stale` flag rather than checking
 * for null - a stale entry still has usable `data`.
 *
 * @returns {{ data: any, fetchedAt: number, age: number, stale: boolean } | null}
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
 * Every cached (kind, data) pair whose kind starts with `kindPrefix`, merging the in-memory layer over an IDB range query.
 * @returns {Promise<Array<{ kind: string, data: any }>>}
 */
export async function getCachedByKindPrefix(entryId, kindPrefix) {
  if (!entryId || !kindPrefix) return []
  const prefix = `${PREFIX}${entryId}:${kindPrefix}`
  const kindStart = prefix.length - kindPrefix.length
  const byKind = new Map()
  for (const [key, entry] of _mem) {
    if (typeof key !== "string" || !key.startsWith(prefix)) continue
    if (!entry || typeof entry !== "object" || !("data" in entry)) continue
    byKind.set(key.slice(kindStart), entry.data)
  }
  try {
    const db = await openDB()
    const idbResults = await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly")
      const range = IDBKeyRange.bound(prefix, prefix + "￿")
      const req = tx.objectStore(STORE).openCursor(range)
      const results = []
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve(results)
          return
        }
        const value = cursor.value
        if (typeof cursor.key === "string" && value && typeof value === "object" && "data" in value) {
          results.push({ kind: cursor.key.slice(kindStart), data: value.data })
        }
        cursor.continue()
      }
      req.onerror = () => resolve(results)
    })
    // In-memory wins on key collision since it's always the freshest write.
    for (const { kind, data } of idbResults) {
      if (!byKind.has(kind)) byKind.set(kind, data)
    }
  } catch (e) {
    log.warn("[xt:cache] getCachedByKindPrefix threw for", entryId, kindPrefix, e)
  }
  return [...byKind].map(([kind, data]) => ({ kind, data }))
}

/**
 * Cache-or-fetch primitive. Hydrates from IDB first, returns cached value
 * if fresh, otherwise runs the fetcher and persists.
 *
 * In-flight calls are deduped per (entryId, kind, force) so a Sidebar warmup
 * racing with a page-bundle loader doesn't fire two parallel network requests
 * for the same playlist.
 *
 * @param {string} entryId
 * @param {string} kind
 * @param {number} ttlMs
 * @param {() => Promise<any>} fetcher
 * @param {{ force?: boolean }} [opts]
 */
const _inflightFetch = new Map()
export async function cachedFetch(entryId, kind, ttlMs, fetcher, opts = {}) {
  if (!opts.force) {
    await hydrate(entryId, kind)
    const hit = getCached(entryId, kind)
    if (hit && !hit.stale) {
      return { data: hit.data, fromCache: true, age: hit.age, stale: false }
    }
    if (hit && hit.stale) {
      const key = makeKey(entryId, kind)
      const failedAt = _revalidateFailedAt.get(key) || 0
      if (Date.now() - failedAt > REVALIDATE_BACKOFF_MS) {
        revalidateInBackground(entryId, kind, ttlMs, fetcher)
      }
      return { data: hit.data, fromCache: true, age: hit.age, stale: true }
    }
  }
  const inflightKey = makeKey(entryId, kind) + (opts.force ? ":force" : "")
  const existing = _inflightFetch.get(inflightKey)
  if (existing) return existing
  const run = Promise.resolve().then(async () => {
    try {
      const data = await fetcher()
      setCached(entryId, kind, data, ttlMs)
      return { data, fromCache: false, age: 0, stale: false }
    } finally {
      _inflightFetch.delete(inflightKey)
    }
  })
  _inflightFetch.set(inflightKey, run)
  return run
}

/** True when a non-forced JS fetch for (entryId, kind) is already in flight. */
export function hasInflightFetch(entryId, kind) {
  return _inflightFetch.has(makeKey(entryId, kind))
}

const _revalidating = new Map()
const _revalidateFailedAt = new Map()
const REVALIDATE_BACKOFF_MS = 30 * 1000

function revalidateInBackground(entryId, kind, ttlMs, fetcher) {
  const key = makeKey(entryId, kind)
  if (_revalidating.has(key)) return _revalidating.get(key)
  const promise = (async () => {
    try {
      const data = await fetcher()
      setCached(entryId, kind, data, ttlMs)
      _revalidateFailedAt.delete(key)
      try {
        document.dispatchEvent(
          new CustomEvent(EVT_REVALIDATED, { detail: { entryId, kind } })
        )
      } catch {}
    } catch (e) {
      _revalidateFailedAt.set(key, Date.now())
      log.warn("[xt:cache] revalidate failed:", kind, e?.message || e)
    } finally {
      _revalidating.delete(key)
    }
  })()
  _revalidating.set(key, promise)
  return promise
}

export const CACHE_REVALIDATED_EVENT = EVT_REVALIDATED

// ---------------------------------------------------------------------------
// Custom-playlist dependents
// ---------------------------------------------------------------------------
/** @type {Promise<Array<{entryId: string, sourceEntryIds: string[]}>>|null} */
let _customDepsInflight = null

async function readCustomDependencies() {
  if (_customDepsInflight) return _customDepsInflight
  _customDepsInflight = (async () => {
    const { getEntries } = await import("./creds.js")
    const { loadCustomDoc, collectSourceEntryIds } = await import("./custom-playlist.ts")
    const entries = await getEntries()
    const dependencies = []
    for (const entry of entries) {
      if (entry?.type !== "custom" || !entry._id) continue
      try {
        const doc = await loadCustomDoc(entry._id)
        dependencies.push({ entryId: entry._id, sourceEntryIds: collectSourceEntryIds(doc) })
      } catch (err) {
        log.warn("[xt:cache] custom doc read failed for", entry._id, err?.message || err)
      }
    }
    return dependencies
  })()
  try {
    return await _customDepsInflight
  } finally {
    _customDepsInflight = null
  }
}

/**
 * Drop the cached overlay of every custom playlist referencing `sourceEntryId`.
 * Without this a source edit / refresh stays invisible until that TTL expires.
 */
export async function invalidateCustomDependents(sourceEntryId) {
  if (!sourceEntryId) return []
  try {
    const dependencies = await readCustomDependencies()
    if (!dependencies.length) return []
    const { collectDependentCustomEntryIds } = await import("./custom-playlist.ts")
    const dependents = collectDependentCustomEntryIds(sourceEntryId, dependencies)
    for (const entryId of dependents) {
      invalidate(entryId, "m3u")
      try {
        document.dispatchEvent(
          new CustomEvent(EVT_REVALIDATED, { detail: { entryId, kind: "m3u" } })
        )
      } catch {}
    }
    return dependents
  } catch (err) {
    log.warn("[xt:cache] custom dependent invalidation failed:", err?.message || err)
    return []
  }
}

/** Drop every cache entry for one playlist (e.g. on edit/remove). */
export function invalidateEntry(entryId) {
  if (!entryId) return
  const prefix = `${PREFIX}${entryId}:`
  for (const k of [..._mem.keys()]) {
    if (k.startsWith(prefix)) _mem.delete(k)
  }
  idbDeleteWhere(prefix).catch(() => {})
  invalidateCustomDependents(entryId).catch(() => {})
}

/**
 * Drop every cache entry whose `kind` starts with the given prefix for one
 * playlist. Used by EPG cache invalidation when the source URL list changes:
 * the per-URL kinds are `epg_parsed:<hash>`, and we want to wipe all of them
 * without touching the playlist's live/vod/series catalog caches.
 */
export function invalidatePrefix(entryId, kindPrefix) {
  if (!entryId || !kindPrefix) return
  const prefix = `${PREFIX}${entryId}:${kindPrefix}`
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
  // Prefer the browser's own quota estimate when available - this is O(1)
  // and avoids reading + re-stringifying every cached value on the main
  // thread. The estimate covers our entire origin (IDB + caches + etc.),
  // which is a close-enough proxy for the catalog cache itself.
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate && typeof estimate.usage === "number") return estimate.usage
  } catch {}

  const keys = await idbAllKeys()
  let bytes = 0
  for (const key of keys) {
    if (typeof key !== "string" || !key.startsWith(PREFIX)) continue
    const value = await idbGet(key)
    try {
      bytes += key.length + JSON.stringify(value).length
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
let _legacyCleanupRan = false
function runLegacyCleanup() {
  // Module-level guard first so Safari private mode (where sessionStorage
  // setItem throws) doesn't re-scan localStorage on every page load.
  if (_legacyCleanupRan) return
  _legacyCleanupRan = true
  try {
    if (sessionStorage.getItem(LEGACY_CLEANUP_SENTINEL) === "1") return
  } catch {}
  try {
    if (localStorage.getItem(LEGACY_CLEANUP_SENTINEL) === "1") return
  } catch {}
  try {
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key.startsWith(PREFIX) || key === META_LS_KEY)) toRemove.push(key)
    }
    for (const key of toRemove) localStorage.removeItem(key)
  } catch {}
  try {
    sessionStorage.setItem(LEGACY_CLEANUP_SENTINEL, "1")
  } catch {}
  try {
    localStorage.setItem(LEGACY_CLEANUP_SENTINEL, "1")
  } catch {}
}
if (typeof window !== "undefined") {
  const ric =
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback
      : (callback) => setTimeout(callback, 1)
  ric(runLegacyCleanup, { timeout: 5000 })
}
