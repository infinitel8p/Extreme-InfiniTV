// Downscale-and-cache pipeline for provider logos/posters, keyed by URL in IndexedDB.

import { log } from "@/scripts/lib/log.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  scaleToFit,
  imgCacheKey,
  isCacheableImageUrl,
  imgKindMaxDim,
  type ImgKind,
} from "@/scripts/lib/img-scale"
import { createTimedIdbOpener } from "@/scripts/lib/idb-open.ts"
import { memoryConservative } from "@/scripts/tv/motion"

const DB_NAME = "xt_img_cache"
const DB_VERSION = 1
const STORE = "images"

interface StoredImage {
  blob: Blob
  cachedAt: number
}

const idbOpener = createTimedIdbOpener({
  name: DB_NAME,
  version: DB_VERSION,
  logTag: "xt:img-cache",
  upgrade(db) {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
  },
})

function openDb(): Promise<IDBDatabase | null> {
  return idbOpener.open()
}

async function idbGet(key: string): Promise<StoredImage | null> {
  if (typeof indexedDB === "undefined") return null
  try {
    const db = await openDb()
    if (!db) return null
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    log.warn("[xt:img-cache] idbGet failed:", err)
    return null
  }
}

async function idbPut(key: string, value: StoredImage): Promise<void> {
  if (typeof indexedDB === "undefined") return
  try {
    const db = await openDb()
    if (!db) return
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch (err) {
    log.warn("[xt:img-cache] idbPut failed:", err)
  }
}

async function idbAllKeys(): Promise<string[]> {
  try {
    const db = await openDb()
    if (!db) return []
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).getAllKeys()
      req.onsuccess = () => resolve((req.result as string[]) || [])
      req.onerror = () => resolve([])
    })
  } catch (err) {
    log.warn("[xt:img-cache] idbAllKeys failed:", err)
    return []
  }
}

async function idbClear(): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch (err) {
    log.warn("[xt:img-cache] idbClear failed:", err)
  }
}

// Single cursor pass: delete entries older than maxAgeMs and return their keys.
async function idbPruneExpired(maxAgeMs: number): Promise<string[]> {
  try {
    const db = await openDb()
    if (!db) return []
    return await new Promise<string[]>((resolve) => {
      const cutoff = Date.now() - maxAgeMs
      const deletedKeys: string[] = []
      const tx = db.transaction(STORE, "readwrite")
      const cursorRequest = tx.objectStore(STORE).openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) return
        const value = cursor.value as StoredImage
        if (value?.cachedAt && value.cachedAt < cutoff) {
          deletedKeys.push(String(cursor.key))
          cursor.delete()
        }
        cursor.continue()
      }
      tx.oncomplete = () => resolve(deletedKeys)
      tx.onerror = () => resolve(deletedKeys)
      tx.onabort = () => resolve(deletedKeys)
    })
  } catch (err) {
    log.warn("[xt:img-cache] idbPruneExpired failed:", err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
const objectUrlMemo = new Map<string, string>()
const failedUrls = new Set<string>()
const inFlight = new Map<string, Promise<void>>()

// Bounds live blob URLs; LRU order keeps in-DOM images safe from eviction.
const MAX_MEMO_ENTRIES = 512
const MAX_MEMO_ENTRIES_LITE = 128

function maxMemoEntries(): number {
  return memoryConservative() ? MAX_MEMO_ENTRIES_LITE : MAX_MEMO_ENTRIES
}

// Reads a memoized object URL and refreshes its recency (Map insertion order).
function memoGet(cacheKey: string): string | undefined {
  const objectUrl = objectUrlMemo.get(cacheKey)
  if (objectUrl === undefined) return undefined
  objectUrlMemo.delete(cacheKey)
  objectUrlMemo.set(cacheKey, objectUrl)
  return objectUrl
}

// An existing memo wins so an in-flight sibling <img> load is never revoked.
function memoAdopt(cacheKey: string, blob: Blob): string {
  const existing = memoGet(cacheKey)
  if (existing) return existing
  const objectUrl = URL.createObjectURL(blob)
  objectUrlMemo.set(cacheKey, objectUrl)
  while (objectUrlMemo.size > maxMemoEntries()) {
    const oldestKey = objectUrlMemo.keys().next().value
    if (oldestKey === undefined) break
    const oldestUrl = objectUrlMemo.get(oldestKey)
    objectUrlMemo.delete(oldestKey)
    if (oldestUrl) URL.revokeObjectURL(oldestUrl)
  }
  return objectUrl
}

const MAX_CONCURRENT = 6
const MAX_CONCURRENT_LITE = 2
let runningCount = 0
// Two queues sharing one concurrency budget: a visible <img> waiting to display never queues
// behind idle background fills (prefetch/warm), only behind other visible images.
const foregroundQueue: Array<() => void> = []
const backgroundQueue: Array<() => void> = []

function maxConcurrent(): number {
  return memoryConservative() ? MAX_CONCURRENT_LITE : MAX_CONCURRENT
}

function runLimited<T>(job: () => Promise<T>, priority: "foreground" | "background" = "background"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      runningCount++
      job()
        .then(resolve, reject)
        .finally(() => {
          runningCount--
          const next = foregroundQueue.shift() || backgroundQueue.shift()
          if (next) next()
        })
    }
    if (runningCount < maxConcurrent()) run()
    else (priority === "foreground" ? foregroundQueue : backgroundQueue).push(run)
  })
}

let sharedObserver: IntersectionObserver | null = null
const pendingParams = new WeakMap<Element, { url: string; kind: ImgKind }>()

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null
  if (sharedObserver) return sharedObserver
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const target = entry.target as HTMLImageElement
        sharedObserver?.unobserve(target)
        const params = pendingParams.get(target)
        pendingParams.delete(target)
        if (params) void handleVisible(target, params.url, params.kind)
      }
    },
    { rootMargin: "200px", threshold: 0 }
  )
  return sharedObserver
}

async function encodeViaDomCanvas(
  bitmap: ImageBitmap,
  width: number,
  height: number
): Promise<Blob | null> {
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.85))
}

async function encodeDownscaled(
  bitmap: ImageBitmap,
  width: number,
  height: number
): Promise<Blob | null> {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext("2d")
      if (ctx && typeof canvas.convertToBlob === "function") {
        ctx.drawImage(bitmap, 0, 0, width, height)
        return await canvas.convertToBlob({ type: "image/webp", quality: 0.85 })
      }
    }
    return await encodeViaDomCanvas(bitmap, width, height)
  } catch (err) {
    log.warn("[xt:img-cache] encode failed:", err)
    return null
  }
}

async function downscaleBlob(originalBlob: Blob, kind: ImgKind): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(originalBlob)
  } catch {
    return originalBlob
  }
  try {
    const targetSize = scaleToFit(bitmap.width, bitmap.height, imgKindMaxDim(kind, memoryConservative()))
    if (!targetSize) return originalBlob
    const encoded = await encodeDownscaled(bitmap, targetSize.width, targetSize.height)
    return encoded || originalBlob
  } finally {
    bitmap.close()
  }
}

// Fetches, downscales and caches `url` without touching any <img>. Feeds `displayImg`
// (when given) from the same fetched blob so the cold path never issues a second
// network request for the image it is about to show.
async function fetchAndCache(
  cacheKey: string,
  url: string,
  kind: ImgKind,
  displayImg?: HTMLImageElement,
  stillWanted?: () => boolean
): Promise<void> {
  let previewUrl: string | null = null
  try {
    const response = await providerFetch(url, { logKind: "image" })
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
    const originalBlob = await response.blob()
    if (displayImg && (!stillWanted || stillWanted()) && displayImg.isConnected) {
      previewUrl = URL.createObjectURL(originalBlob)
      displayImg.src = previewUrl
    }
    const storedBlob = await downscaleBlob(originalBlob, kind)
    await idbPut(cacheKey, { blob: storedBlob, cachedAt: Date.now() })
    const finalUrl = memoAdopt(cacheKey, storedBlob)
    // Only swap when the img still shows our own preview - a caller may have moved on to a
    // different image (row recycled) while the fetch and downscale were in flight.
    if (displayImg?.isConnected && displayImg.src === previewUrl) displayImg.src = finalUrl
  } catch (err) {
    log.warn("[xt:img-cache] background fill failed:", err)
    failedUrls.add(url)
    if (displayImg?.isConnected && (!stillWanted || stillWanted())) displayImg.src = url
  } finally {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }
}

// Fetches, downscales and caches `url` without touching any <img>
function backgroundFill(cacheKey: string, url: string, kind: ImgKind): Promise<void> {
  return fetchAndCache(cacheKey, url, kind)
}

function scheduleBackgroundFill(
  cacheKey: string,
  url: string,
  kind: ImgKind,
  stillWanted: () => boolean
): void {
  if (failedUrls.has(url) || inFlight.has(cacheKey)) return
  const fill = new Promise<void>((resolve) => {
    const ric =
      typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback
        : (callback: () => void) => setTimeout(callback, 1000)
    ric(() => {
      void runLimited(() =>
        stillWanted() ? backgroundFill(cacheKey, url, kind) : Promise.resolve()
      ).then(resolve)
    })
  })
  inFlight.set(cacheKey, fill)
  fill.finally(() => inFlight.delete(cacheKey))
}

// Cold-cache visible path: joins an already in-flight fetch for the same cacheKey instead of
// starting a second one, otherwise fetches once through the shared limiter and feeds `img`.
async function fillAndDisplay(
  img: HTMLImageElement,
  cacheKey: string,
  url: string,
  kind: ImgKind,
  stillWanted: () => boolean
): Promise<void> {
  const existingFill = inFlight.get(cacheKey)
  if (existingFill) {
    await existingFill
    if (stillWanted() && img.isConnected) img.src = memoGet(cacheKey) || url
    return
  }
  // The foreground queue is already saturated - waiting it out would leave the <img> blank
  // until its turn. Fall back to a native load now and still cache the downscaled variant
  // in the background for next time, instead of blocking the image on our own queue.
  if (runningCount >= maxConcurrent()) {
    img.src = url
    scheduleBackgroundFill(cacheKey, url, kind, stillWanted)
    return
  }
  const fill = runLimited(
    () => (stillWanted() ? fetchAndCache(cacheKey, url, kind, img, stillWanted) : Promise.resolve()),
    "foreground"
  )
  inFlight.set(cacheKey, fill)
  fill.finally(() => inFlight.delete(cacheKey))
  await fill
}

async function handleVisible(img: HTMLImageElement, url: string, kind: ImgKind): Promise<void> {
  if (!img.isConnected) return
  schedulePrune()
  const cacheKey = imgCacheKey(kind, url)
  const memoized = memoGet(cacheKey)
  if (memoized) {
    img.src = memoized
    return
  }
  const cached = await idbGet(cacheKey)
  if (!img.isConnected) return
  if (cached?.blob) {
    img.src = memoAdopt(cacheKey, cached.blob)
    return
  }
  // WeakRef, not the element: a queued fill can wait out several navigations, and a
  // captured <img> pins the whole detached view it belongs to until the queue drains.
  const imgRef = typeof WeakRef === "function" ? new WeakRef(img) : null
  const stillWanted = imgRef ? () => imgRef.deref()?.isConnected === true : () => img.isConnected
  if (!stillWanted()) return
  await fillAndDisplay(img, cacheKey, url, kind, stillWanted)
}

/** Primes the IDB cache entry for `url` without mounting or decoding any <img>. */
export function warmCachedImage(url: string, kind: ImgKind): void {
  if (!isCacheableImageUrl(url) || failedUrls.has(url)) return
  const cacheKey = imgCacheKey(kind, url)
  if (memoGet(cacheKey)) return
  void (async () => {
    const cached = await idbGet(cacheKey)
    if (cached?.blob) {
      memoAdopt(cacheKey, cached.blob)
      return
    }
    scheduleBackgroundFill(cacheKey, url, kind, () => true)
  })()
}

/** Fetch (or serve cached) `url`, downscale to `kind`'s bucket, and mount it once visible. */
export function mountCachedImage(img: HTMLImageElement, url: string, kind: ImgKind): void {
  if (!isCacheableImageUrl(url)) {
    img.src = url
    return
  }
  const cacheKey = imgCacheKey(kind, url)
  const memoized = memoGet(cacheKey)
  if (memoized) {
    img.src = memoized
    return
  }
  if (failedUrls.has(url)) {
    img.src = url
    return
  }
  const observer = getObserver()
  if (!observer) {
    void handleVisible(img, url, kind)
    return
  }
  pendingParams.set(img, { url, kind })
  observer.observe(img)
}

/**
 * Detaches every cached <img> under `root` from the shared observer and drops its src.
 * An observed target is a strong root, so one unreleased <img> pins its whole detached tree.
 */
export function releaseCachedImages(root: ParentNode | HTMLImageElement | null | undefined): void {
  if (!root) return
  const release = (img: HTMLImageElement): void => {
    sharedObserver?.unobserve(img)
    pendingParams.delete(img)
    img.removeAttribute("src")
    img.removeAttribute("srcset")
  }
  if (root instanceof HTMLImageElement) {
    release(root)
    return
  }
  for (const img of root.querySelectorAll<HTMLImageElement>("img")) release(img)
}

export interface CachedImgParams {
  url: string | null | undefined
  kind: ImgKind
}

/** Svelte action wrapper around `mountCachedImage`. */
export function cachedImg(
  node: HTMLImageElement,
  params: CachedImgParams
): { update(params: CachedImgParams): void; destroy(): void } {
  let mountedUrl = params.url
  if (params.url) mountCachedImage(node, params.url, params.kind)
  return {
    update(nextParams) {
      if (nextParams.url === mountedUrl) return
      mountedUrl = nextParams.url
      if (nextParams.url) {
        mountCachedImage(node, nextParams.url, nextParams.kind)
        return
      }
      sharedObserver?.unobserve(node)
      pendingParams.delete(node)
      node.removeAttribute("src")
    },
    destroy() {
      sharedObserver?.unobserve(node)
      pendingParams.delete(node)
    },
  }
}

export async function clearImageCache(): Promise<number> {
  const removed = (await idbAllKeys()).length
  await idbClear()
  for (const objectUrl of objectUrlMemo.values()) URL.revokeObjectURL(objectUrl)
  objectUrlMemo.clear()
  failedUrls.clear()
  return removed
}

/**
 * Drops the in-memory object-URL memo and failed-URL set on Android memory pressure,
 * without touching the persisted IndexedDB cache - a cheap release, not a wipe.
 * Object URLs still displayed by a connected <img> are kept; revoking those would blank
 * the image currently on screen.
 */
function releaseMemoryPressureCache(): void {
  const displayedUrls = new Set(
    Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]'), (img) => img.src)
  )
  for (const [cacheKey, objectUrl] of objectUrlMemo) {
    if (displayedUrls.has(objectUrl)) continue
    URL.revokeObjectURL(objectUrl)
    objectUrlMemo.delete(cacheKey)
  }
  failedUrls.clear()
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:memory-pressure", releaseMemoryPressureCache)
}

// ---------------------------------------------------------------------------
// Prune sweep: drop entries older than 30 days, at most once a day.
// ---------------------------------------------------------------------------
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const PRUNE_SENTINEL_KEY = "xt_img_cache_pruned_at"
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

let pruneScheduled = false

async function pruneOldEntries(): Promise<void> {
  try {
    let lastPrune = 0
    try {
      lastPrune = Number(localStorage.getItem(PRUNE_SENTINEL_KEY)) || 0
    } catch {}
    if (Date.now() - lastPrune < PRUNE_INTERVAL_MS) return
    const prunedKeys = await idbPruneExpired(MAX_AGE_MS)
    for (const key of prunedKeys) {
      const objectUrl = objectUrlMemo.get(key)
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrlMemo.delete(key)
      }
    }
    try {
      localStorage.setItem(PRUNE_SENTINEL_KEY, String(Date.now()))
    } catch {}
  } catch (err) {
    log.warn("[xt:img-cache] prune sweep failed:", err)
  }
}

function schedulePrune(): void {
  if (pruneScheduled) return
  pruneScheduled = true
  const ric =
    typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback
      : (callback: () => void) => setTimeout(callback, 500)
  ric(() => {
    void pruneOldEntries()
  })
}
