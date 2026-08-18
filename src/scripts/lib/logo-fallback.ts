// Runtime side of the iptv-org logo fallback: cached logos.json index plus channel-row DOM patching.

import { log } from "./log.ts"
import { safeHttpUrl } from "./creds.js"
import {
  buildLogoIndex,
  pickBestLogos,
  matchLogo,
  type LogoApiRecord,
  type LogoIndex,
} from "./logo-fallback-match.ts"

const LOGOS_URL = "https://iptv-org.github.io/api/logos.json"
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 60 * 1000
const FAIL_AT_KEY = "xt_logo_fallback_fail_at"

const DB_NAME = "xt_logo_fallback"
const DB_VERSION = 1
const STORE = "entries"
const RECORD_KEY = "logos"

interface StoredLogos {
  pairs: Array<[string, string]>
  fetchedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"))
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error("IDB blocked"))
  })
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

async function idbGetLogos(): Promise<StoredLogos | null> {
  if (typeof indexedDB === "undefined") return null
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(RECORD_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    log.warn("[xt:logo-fallback] idbGetLogos failed:", err)
    return null
  }
}

async function idbPutLogos(value: StoredLogos): Promise<void> {
  if (typeof indexedDB === "undefined") return
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(value, RECORD_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch (err) {
    log.warn("[xt:logo-fallback] idbPutLogos failed:", err)
  }
}

// MPA: module state resets per navigation, so the failure backoff is mirrored to localStorage.
function readFailureAt(): number {
  try {
    return Number(localStorage.getItem(FAIL_AT_KEY)) || 0
  } catch {
    return 0
  }
}

function writeFailureAt(value: number): void {
  try {
    if (value) localStorage.setItem(FAIL_AT_KEY, String(value))
    else localStorage.removeItem(FAIL_AT_KEY)
  } catch (err) {
    log.warn("[xt:logo-fallback] localStorage write failed:", err)
  }
}

let indexPromise: Promise<LogoIndex | null> | null = null
let lastFailureAt = readFailureAt()

async function fetchAndIndex(): Promise<LogoIndex | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(LOGOS_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`logos.json fetch failed: ${response.status}`)
    const records: LogoApiRecord[] = await response.json()
    const pairs = pickBestLogos(records)
    await idbPutLogos({ pairs, fetchedAt: Date.now() })
    return buildLogoIndex(pairs)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function refreshInBackground(): Promise<void> {
  try {
    const index = await fetchAndIndex()
    lastFailureAt = 0
    writeFailureAt(0)
    // Serve the fresh index to the current page too.
    indexPromise = Promise.resolve(index)
  } catch (err) {
    log.warn("[xt:logo-fallback] background refresh failed:", err)
  }
}

/** Load (or lazily fetch) the logo index; safe to call repeatedly, dedupes in-flight work. */
export async function ensureLogoIndex(): Promise<LogoIndex | null> {
  if (indexPromise) return indexPromise
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return null

  const promise = (async (): Promise<LogoIndex | null> => {
    const cached = await idbGetLogos()
    if (cached && cached.pairs) {
      const index = buildLogoIndex(cached.pairs)
      if (Date.now() - cached.fetchedAt > TTL_MS) {
        void refreshInBackground()
      }
      return index
    }

    try {
      const index = await fetchAndIndex()
      lastFailureAt = 0
      writeFailureAt(0)
      return index
    } catch (err) {
      log.warn("[xt:logo-fallback] fetch failed:", err)
      lastFailureAt = Date.now()
      writeFailureAt(lastFailureAt)
      // Reset so the next call after the backoff retries instead of replaying this failure.
      indexPromise = null
      return null
    }
  })()

  indexPromise = promise
  return promise
}

/** Resolve a fallback logo URL for one channel, or null if none is known. */
export async function getFallbackLogoUrl(channel: {
  name?: string | null
  tvgId?: string | null
}): Promise<string | null> {
  const index = await ensureLogoIndex()
  if (!index) return null
  return matchLogo(index, channel)
}

/** Fire-and-forget: fill an empty logo container once a fallback is found; never touches it synchronously. */
export function requestLogoFallback(
  container: HTMLElement,
  channel: { name?: string | null; tvgId?: string | null }
): void {
  void (async () => {
    try {
      const url = await getFallbackLogoUrl(channel)
      if (!url) return
      const safeUrl = safeHttpUrl(url)
      if (!safeUrl) return
      if (!container.isConnected) return
      if (container.querySelector("img")) return

      const img = document.createElement("img")
      img.dataset.logoFallback = "true"
      img.src = safeUrl
      img.alt = ""
      img.loading = "lazy"
      img.decoding = "async"
      ;(img as any).fetchPriority = "low"
      img.referrerPolicy = "no-referrer"
      img.className = "h-full w-full object-contain"
      img.onload = () => container.setAttribute("data-loaded", "true")
      img.onerror = () => {
        img.remove()
        container.setAttribute("data-loaded", "true")
      }
      container.appendChild(img)
    } catch (err) {
      log.warn("[xt:logo-fallback] requestLogoFallback failed:", err)
    }
  })()
}
