const PREFIX = "xt_cache:"
const META_KEY = "xt_cache_meta"

const makeKey = (entryId, kind) => `${PREFIX}${entryId}:${kind}`

function readHot(key) {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function writeHot(key, payload) {
  try {
    sessionStorage.setItem(key, payload)
  } catch {}
}
function dropHot(key) {
  try {
    sessionStorage.removeItem(key)
  } catch {}
}

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

function evictOldestBatch(batchSize) {
  const meta = readMeta()
  const entries = Object.entries(meta)
  if (entries.length === 0) return 0
  entries.sort((a, b) => a[1] - b[1])
  const drop = entries.slice(0, Math.min(batchSize, entries.length))
  for (const [k] of drop) {
    try {
      localStorage.removeItem(k)
    } catch {}
    delete meta[k]
  }
  writeMeta(meta)
  return drop.length
}

const TRIM_TOAST_THRESHOLD_MS = 1000
let trimToastEl = null

function showTrimToast() {
  if (typeof document === "undefined" || !document.body) return
  if (trimToastEl) return
  const el = document.createElement("div")
  el.setAttribute("role", "status")
  el.setAttribute("aria-live", "polite")
  el.textContent = "Trimming local cache…"
  el.style.cssText = [
    "position:fixed",
    "right:max(0.75rem,env(safe-area-inset-right))",
    "bottom:max(0.75rem,env(safe-area-inset-bottom))",
    "z-index:9999",
    "padding:0.5rem 0.875rem",
    "border-radius:0.75rem",
    "background:var(--xt-surface,#1b1b22)",
    "color:var(--xt-fg,#e7e7ea)",
    "border:1px solid var(--xt-line,rgba(255,255,255,0.08))",
    "font-size:0.8125rem",
    "box-shadow:0 8px 24px rgba(0,0,0,0.32)",
    "pointer-events:none",
  ].join(";")
  document.body.appendChild(el)
  trimToastEl = el
}

function hideTrimToast() {
  if (trimToastEl && trimToastEl.parentNode) {
    trimToastEl.parentNode.removeChild(trimToastEl)
  }
  trimToastEl = null
}

/**
 * @returns {{ data: any, fetchedAt: number, age: number } | null}
 */
export function getCached(entryId, kind) {
  if (!entryId) return null
  const key = makeKey(entryId, kind)

  // Hot tier first.
  const hot = readHot(key)
  if (hot) {
    const age = Date.now() - hot.fetchedAt
    if (age <= hot.ttl) {
      return { data: hot.data, fetchedAt: hot.fetchedAt, age }
    }
    dropHot(key)
  }

  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const obj = JSON.parse(raw)
    const age = Date.now() - obj.fetchedAt
    if (age > obj.ttl) return null
    writeHot(key, raw)
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

  let trimStartedAt = 0
  let toastShown = false
  const MAX_ATTEMPTS = 8
  const BATCH = 32

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      localStorage.setItem(key, payload)
      const meta = readMeta()
      meta[key] = Date.now()
      writeMeta(meta)
      writeHot(key, payload)
      if (toastShown) hideTrimToast()
      return
    } catch (e) {
      if (e && e.name === "QuotaExceededError") {
        if (trimStartedAt === 0) trimStartedAt = Date.now()
        if (
          !toastShown &&
          Date.now() - trimStartedAt > TRIM_TOAST_THRESHOLD_MS
        ) {
          showTrimToast()
          toastShown = true
        }
        const removed = evictOldestBatch(BATCH)
        if (removed > 0) continue
      }
      if (toastShown) hideTrimToast()
      console.warn("cache write failed:", e)
      return
    }
  }
  if (toastShown) hideTrimToast()
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
  try {
    const sessRemove = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(prefix)) sessRemove.push(k)
    }
    for (const k of sessRemove) sessionStorage.removeItem(k)
  } catch {}
}

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
  const key = makeKey(entryId, kind)
  try {
    localStorage.removeItem(key)
    const meta = readMeta()
    delete meta[key]
    writeMeta(meta)
  } catch {}
  dropHot(key)
}
