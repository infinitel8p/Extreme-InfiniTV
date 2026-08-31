// Per-title ambient colour: resolves a calm accent from a title's artwork and
// exposes it as CSS custom properties for the hero band and focus glide to tint.

import { log } from "@/scripts/lib/log.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { scaleToFit, imgCacheKey, isCacheableImageUrl, type ImgKind } from "@/scripts/lib/img-scale"
import { toAmbient, ambientCss, dominantColor, type RgbColor, type OklchColor } from "@/scripts/lib/ambient-math"
import { motionAllowed, TV_EASE, heavyEffectsAllowed } from "@/scripts/tv/motion"
import type { AmbientWorkerResponse } from "@/scripts/tv/ambient-worker"

const SAMPLE_MAX_DIM = 48
const LRU_CAPACITY = 64
const SESSION_KEY = "xt_tv_ambient_v1"
const LIGHT_LIGHTNESS_RANGE: [number, number] = [0.7, 0.86]
const SOFT_ALPHA = 0.35
const GLOW_ALPHA = 0.18

// Mirrors lib/img-cache.ts's schema so a title already cached for display is
// sampled with zero extra network - never written to here, only read.
const IMG_CACHE_DB_NAME = "xt_img_cache"
const IMG_CACHE_DB_VERSION = 1
const IMG_CACHE_STORE = "images"

export interface AmbientColor {
  oklch: OklchColor
  /** `--tv-ambient`: full-strength accent. */
  css: string
  /** `--tv-ambient-soft`: alpha 0.35, for scrims. */
  soft: string
  /** `--tv-ambient-glow`: alpha 0.18, for the focus glide's outer spill. */
  glow: string
}

export type AmbientVarName = "--tv-ambient" | "--tv-ambient-soft" | "--tv-ambient-glow"
const ALL_AMBIENT_VARS: AmbientVarName[] = ["--tv-ambient", "--tv-ambient-soft", "--tv-ambient-glow"]

export interface ApplyAmbientOptions {
  vars?: AmbientVarName[]
  kind?: ImgKind
}

function isLightTheme(): boolean {
  const explicit = document.documentElement.style.colorScheme
  if (explicit === "light") return true
  if (explicit === "dark") return false
  return !window.matchMedia("(prefers-color-scheme: dark)").matches
}

function buildAmbientColor(rgb: RgbColor): AmbientColor {
  const oklch = toAmbient(rgb, isLightTheme() ? { lightness: LIGHT_LIGHTNESS_RANGE } : undefined)
  return { oklch, css: ambientCss(oklch), soft: ambientCss(oklch, SOFT_ALPHA), glow: ambientCss(oklch, GLOW_ALPHA) }
}

// ---------------------------------------------------------------------------
// In-memory LRU + sessionStorage mirror
// ---------------------------------------------------------------------------

const memoryCache = new Map<string, AmbientColor | null>()
const inFlight = new Map<string, Promise<AmbientColor | null>>()

function memoryGet(url: string): AmbientColor | null | undefined {
  const cached = memoryCache.get(url)
  if (cached === undefined) return undefined
  memoryCache.delete(url)
  memoryCache.set(url, cached)
  return cached
}

function memorySet(url: string, color: AmbientColor | null): void {
  memoryCache.delete(url)
  memoryCache.set(url, color)
  while (memoryCache.size > LRU_CAPACITY) {
    const oldestKey = memoryCache.keys().next().value
    if (oldestKey === undefined) break
    memoryCache.delete(oldestKey)
  }
  persistSession()
}

function persistSession(): void {
  try {
    const entries: Array<[string, { l: number; c: number; h: number }]> = []
    for (const [url, color] of memoryCache) {
      if (color) entries.push([url, color.oklch])
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(entries))
  } catch {
    // Quota or unavailable storage - ambient just re-resolves next session.
  }
}

function hydrateSession(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return
    const entries = JSON.parse(raw) as Array<[string, { l: number; c: number; h: number }]>
    for (const [url, oklch] of entries) {
      memoryCache.set(url, { oklch, css: ambientCss(oklch), soft: ambientCss(oklch, SOFT_ALPHA), glow: ambientCss(oklch, GLOW_ALPHA) })
    }
  } catch {
    // Corrupt or foreign payload - start cold.
  }
}

if (typeof sessionStorage !== "undefined") hydrateSession()

// ---------------------------------------------------------------------------
// Bitmap sampling: worker-first, hidden-canvas fallback
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let workerBroken = false
let requestSeq = 0
const pendingByRequestId = new Map<number, (rgb: RgbColor | null) => void>()

function retireWorker(): void {
  workerBroken = true
  try {
    worker?.terminate()
  } catch {}
  worker = null
  for (const resolve of pendingByRequestId.values()) resolve(null)
  pendingByRequestId.clear()
}

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    const nextWorker = new Worker(new URL("./ambient-worker.ts", import.meta.url), { type: "module" })
    nextWorker.addEventListener("message", (event: MessageEvent<AmbientWorkerResponse>) => {
      const resolve = pendingByRequestId.get(event.data.requestId)
      pendingByRequestId.delete(event.data.requestId)
      resolve?.(event.data.rgb)
    })
    nextWorker.addEventListener("error", (event) => {
      log.warn("[xt:ambient] worker error:", event?.message || event)
      retireWorker()
    })
    worker = nextWorker
    return worker
  } catch (error) {
    log.warn("[xt:ambient] worker construct failed:", error)
    workerBroken = true
    return null
  }
}

function drawToHiddenCanvas(bitmap: ImageBitmap): { bytes: Uint8ClampedArray | null; width: number; height: number } {
  if (typeof document === "undefined") return { bytes: null, width: 0, height: 0 }
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext("2d")
  if (!ctx) return { bytes: null, width: 0, height: 0 }
  ctx.drawImage(bitmap, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { bytes: data, width, height }
}

async function sampleBitmap(bitmap: ImageBitmap): Promise<RgbColor | null> {
  const activeWorker = typeof Worker === "undefined" ? null : getWorker()
  if (!activeWorker) {
    const { bytes, width, height } = drawToHiddenCanvas(bitmap)
    bitmap.close()
    return bytes ? dominantColor(bytes, width, height) : null
  }
  const requestId = ++requestSeq
  const resultPromise = new Promise<RgbColor | null>((resolve) => pendingByRequestId.set(requestId, resolve))
  if (typeof OffscreenCanvas !== "undefined") {
    activeWorker.postMessage({ requestId, bitmap }, [bitmap])
  } else {
    const { bytes, width, height } = drawToHiddenCanvas(bitmap)
    bitmap.close()
    if (!bytes) {
      pendingByRequestId.delete(requestId)
      return null
    }
    activeWorker.postMessage({ requestId, bytes, width, height }, [bytes.buffer])
  }
  return resultPromise
}

async function downscaledBitmapFrom(blob: Blob): Promise<ImageBitmap | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    return null
  }
  const target = scaleToFit(bitmap.width, bitmap.height, SAMPLE_MAX_DIM)
  if (!target) return bitmap
  try {
    const resized = await createImageBitmap(bitmap, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "low" })
    bitmap.close()
    return resized
  } catch {
    return bitmap
  }
}

// ---------------------------------------------------------------------------
// Blob sourcing: img-cache's IDB first, provider fetch otherwise
// ---------------------------------------------------------------------------

let imgCacheDbPromise: Promise<IDBDatabase | null> | null = null

function openImgCacheDb(): Promise<IDBDatabase | null> {
  if (imgCacheDbPromise) return imgCacheDbPromise
  imgCacheDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null)
      return
    }
    try {
      const req = indexedDB.open(IMG_CACHE_DB_NAME, IMG_CACHE_DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IMG_CACHE_STORE)) db.createObjectStore(IMG_CACHE_STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return imgCacheDbPromise
}

async function readCachedBlob(cacheKey: string): Promise<Blob | null> {
  try {
    const db = await openImgCacheDb()
    if (!db || !db.objectStoreNames.contains(IMG_CACHE_STORE)) return null
    return await new Promise((resolve) => {
      const tx = db.transaction(IMG_CACHE_STORE, "readonly")
      const req = tx.objectStore(IMG_CACHE_STORE).get(cacheKey)
      req.onsuccess = () => resolve(req.result?.blob ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function resolveAmbient(imageUrl: string, kind: ImgKind): Promise<AmbientColor | null> {
  if (!isCacheableImageUrl(imageUrl)) return null
  try {
    let blob = await readCachedBlob(imgCacheKey(kind, imageUrl))
    if (!blob) {
      const response = await providerFetch(imageUrl, { logKind: "image" })
      if (!response.ok) return null
      blob = await response.blob()
    }
    if (!blob) return null
    const bitmap = await downscaledBitmapFrom(blob)
    if (!bitmap) return null
    const rgb = await sampleBitmap(bitmap)
    return rgb ? buildAmbientColor(rgb) : null
  } catch (error) {
    log.warn("[xt:ambient] resolve failed:", error)
    return null
  }
}

/** Resolves the calm ambient accent for `imageUrl`, memoized in-process and across a session. */
export function ambientFor(imageUrl: string | null | undefined, kind: ImgKind = "poster"): Promise<AmbientColor | null> {
  if (!imageUrl) return Promise.resolve(null)
  if (!heavyEffectsAllowed()) return Promise.resolve(null)
  const memoized = memoryGet(imageUrl)
  if (memoized !== undefined) return Promise.resolve(memoized)
  const pending = inFlight.get(imageUrl)
  if (pending) return pending
  const promise = resolveAmbient(imageUrl, kind)
    .then((color) => {
      memorySet(imageUrl, color)
      return color
    })
    .finally(() => inFlight.delete(imageUrl))
  inFlight.set(imageUrl, promise)
  return promise
}

// ---------------------------------------------------------------------------
// DOM application: registered custom properties so the colour transition
// itself is animatable, gated on motionAllowed() rather than left to chance.
// ---------------------------------------------------------------------------

let stylesInjected = false

function ensureAmbientStylesInjected(): void {
  if (stylesInjected || typeof document === "undefined") return
  stylesInjected = true
  const style = document.createElement("style")
  style.textContent = `
@property --tv-ambient { syntax: "<color>"; inherits: true; initial-value: transparent; }
@property --tv-ambient-soft { syntax: "<color>"; inherits: true; initial-value: transparent; }
@property --tv-ambient-glow { syntax: "<color>"; inherits: true; initial-value: transparent; }
[data-tv-ambient] {
  transition: --tv-ambient 480ms ${TV_EASE}, --tv-ambient-soft 480ms ${TV_EASE}, --tv-ambient-glow 480ms ${TV_EASE};
}
@media (prefers-reduced-motion: reduce) {
  [data-tv-ambient] { transition: none; }
}
html[data-perf-mode="on"] [data-tv-ambient] { transition: none; }
`
  document.head.appendChild(style)
}

function setAmbientVar(element: HTMLElement, name: AmbientVarName, value: string): void {
  if (motionAllowed()) {
    element.style.setProperty(name, value)
    return
  }
  // Suspend the transition for one frame so the value lands instantly.
  const previousTransition = element.style.transitionProperty
  element.style.transitionProperty = "none"
  element.style.setProperty(name, value)
  void element.offsetHeight
  element.style.transitionProperty = previousTransition
}

const applyTokenByElement = new WeakMap<HTMLElement, number>()
let applyTokenSeq = 0

function syncAmbientAttribute(element: HTMLElement): void {
  const hasAny = ALL_AMBIENT_VARS.some((name) => element.style.getPropertyValue(name))
  if (hasAny) element.dataset.tvAmbient = "1"
  else delete element.dataset.tvAmbient
}

/** Resolves `imageUrl`'s ambient colour and writes it onto `element`'s CSS custom properties. */
export async function applyAmbient(
  element: HTMLElement,
  imageUrl: string | null | undefined,
  options?: ApplyAmbientOptions
): Promise<void> {
  if (!heavyEffectsAllowed()) return
  ensureAmbientStylesInjected()
  const vars = options?.vars ?? ALL_AMBIENT_VARS
  const token = ++applyTokenSeq
  applyTokenByElement.set(element, token)

  const color = await ambientFor(imageUrl, options?.kind ?? "poster")
  if (applyTokenByElement.get(element) !== token || !element.isConnected) return

  if (!color) {
    clearAmbient(element, options)
    return
  }
  const valueByVar: Record<AmbientVarName, string> = {
    "--tv-ambient": color.css,
    "--tv-ambient-soft": color.soft,
    "--tv-ambient-glow": color.glow,
  }
  for (const name of vars) setAmbientVar(element, name, valueByVar[name])
  syncAmbientAttribute(element)
}

/** Removes any ambient custom properties `applyAmbient` set on `element`. */
export function clearAmbient(element: HTMLElement, options?: ApplyAmbientOptions): void {
  applyTokenByElement.set(element, ++applyTokenSeq)
  const vars = options?.vars ?? ALL_AMBIENT_VARS
  for (const name of vars) element.style.removeProperty(name)
  syncAmbientAttribute(element)
}
