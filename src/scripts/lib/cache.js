// Tiny TTL'd JSON cache backed by localStorage.
// Designed for the channel/VOD lists - parsing 5,000+ M3U entries or hitting
// `get_live_streams` is expensive enough that we don't want to repeat it on
// every page navigation.
//
// Layout:
//   localStorage["xt_cache:<entryId>:<kind>"] = { data, fetchedAt, ttl }
//   localStorage["xt_cache_meta"] = { "<full key>": <fetchedAt>, ... }
//
// `meta` is a write-time-ordered index used purely for LRU eviction when we
// hit the storage quota. It's safe to lose - re-derived on next write.

const PREFIX = "xt_cache:"
const META_KEY = "xt_cache_meta"

const makeKey = (entryId, kind) => `${PREFIX}${entryId}:${kind}`

function readMeta() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "{}")
  } catch {
    return {}
  }
}
function writeMeta(meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch {}
}

function evictOldest() {
  const meta = readMeta()
  let oldestKey = null
  let oldestTime = Infinity
  for (const [k, t] of Object.entries(meta)) {
    if (t < oldestTime) {
      oldestTime = t
      oldestKey = k
    }
  }
  if (oldestKey) {
    try {
      localStorage.removeItem(oldestKey)
    } catch {}
    delete meta[oldestKey]
    writeMeta(meta)
  }
  return Boolean(oldestKey)
}

/**
 * @returns {{ data: any, fetchedAt: number, age: number } | null}
 */
export function getCached(entryId, kind) {
  if (!entryId) return null
  try {
    const raw = localStorage.getItem(makeKey(entryId, kind))
    if (!raw) return null
    const obj = JSON.parse(raw)
    const age = Date.now() - obj.fetchedAt
    if (age > obj.ttl) return null
    return { data: obj.data, fetchedAt: obj.fetchedAt, age }
  } catch {
    return null
  }
}

export function setCached(entryId, kind, data, ttlMs) {
  if (!entryId) return
  const key = makeKey(entryId, kind)
  const payload = JSON.stringify({
    data,
    fetchedAt: Date.now(),
    ttl: ttlMs,
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      localStorage.setItem(key, payload)
      const meta = readMeta()
      meta[key] = Date.now()
      writeMeta(meta)
      return
    } catch (e) {
      if (e && e.name === "QuotaExceededError" && evictOldest()) continue
      console.warn("cache write failed:", e)
      return
    }
  }
}

/**
 * Cache-or-fetch primitive.
 *
 * @param {string} entryId  Active playlist id.
 * @param {string} kind     "live" | "vod" | "user_info" | etc.
 * @param {number} ttlMs    How long the result stays fresh.
 * @param {() => Promise<any>} fetcher  Produces fresh data on miss.
 * @param {{ force?: boolean }} [opts]  `force: true` skips the cache read.
 */
export async function cachedFetch(entryId, kind, ttlMs, fetcher, opts = {}) {
  if (!opts.force) {
    const hit = getCached(entryId, kind)
    if (hit) return { data: hit.data, fromCache: true, age: hit.age }
  }
  const data = await fetcher()
  setCached(entryId, kind, data, ttlMs)
  return { data, fromCache: false, age: 0 }
}

/** Drop every cache entry for one playlist (e.g. on edit/remove). */
export function invalidateEntry(entryId) {
  if (!entryId) return
  const prefix = `${PREFIX}${entryId}:`
  try {
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
    const meta = readMeta()
    for (const k of toRemove) delete meta[k]
    writeMeta(meta)
  } catch {}
}

/**
 * Most recent cache fetch for any kind under this playlist, in milliseconds
 * since epoch. Returns null when nothing is cached. Cheap (reads only the
 * meta index, not the full payloads).
 */
export function getNewestCacheTime(entryId) {
  if (!entryId) return null
  const prefix = `${PREFIX}${entryId}:`
  const meta = readMeta()
  let newest = 0
  for (const [k, t] of Object.entries(meta)) {
    if (k.startsWith(prefix) && t > newest) newest = t
  }
  return newest > 0 ? newest : null
}

/** Drop one specific (entry, kind) combo. */
export function invalidate(entryId, kind) {
  try {
    localStorage.removeItem(makeKey(entryId, kind))
    const meta = readMeta()
    delete meta[makeKey(entryId, kind)]
    writeMeta(meta)
  } catch {}
}
