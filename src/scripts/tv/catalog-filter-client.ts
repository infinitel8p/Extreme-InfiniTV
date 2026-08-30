// Main-thread client for catalog-worker.ts: falls back to synchronous main-thread
// filtering for small catalogs or when the worker is unavailable/broken, and drops
// replies superseded by a newer request for the same catalog.

import { filterAndSortIndexes, type GridFilterEntry, type GridFilterState } from "@/scripts/lib/tv-grid-filter"
import { normalize, scoreNormMatch } from "@/scripts/lib/text.ts"
import { log } from "@/scripts/lib/log.js"
import { effectTier } from "@/scripts/tv/motion"
import type { CatalogFilterWorkerParams, CatalogFilterWorkerResponse } from "./catalog-worker"

export const SYNC_THRESHOLD = 400
const GENRE_CAT_PREFIX = "__genre__:"
const IDLE_RELEASE_MS = 60_000

export interface CatalogFilterCategoryParams {
  isGenreCategory: boolean
  genreMatchIds?: Array<number | string>
  uncategorizedLabel: string
}

export interface CatalogFilterParams {
  state: GridFilterState
  category: CatalogFilterCategoryParams
  watchedIds?: Array<number | string>
}

interface WorkerCatalogEntry extends GridFilterEntry {
  category?: string | null
}

function categoryMatcherFor(params: CatalogFilterCategoryParams) {
  const genreMatchIds = params.genreMatchIds ? new Set(params.genreMatchIds.map(Number)) : null
  return (entry: WorkerCatalogEntry, category: string): boolean => {
    if (category.startsWith(GENRE_CAT_PREFIX)) return genreMatchIds?.has(Number(entry.id)) ?? false
    const name = String(entry.category || "").trim() || params.uncategorizedLabel
    return name === category
  }
}

function isWatchedFor(watchedIds?: Array<number | string>) {
  const watchedSet = watchedIds ? new Set(watchedIds) : null
  return (entry: WorkerCatalogEntry): boolean => !!watchedSet?.has(entry.id)
}

function filterSync<T extends WorkerCatalogEntry>(entries: T[], params: CatalogFilterParams): Uint32Array {
  return filterAndSortIndexes(entries, params.state, {
    categoryMatcher: categoryMatcherFor(params.category),
    isWatched: isWatchedFor(params.watchedIds),
    normalize,
  })
}

interface SearchableEntry {
  norm?: string
}

function searchSync<T extends SearchableEntry>(entries: T[], query: string, cap: number): Uint32Array {
  const tokens = normalize(query).split(" ").filter(Boolean)
  const scored: Array<{ index: number; score: number }> = []
  for (let index = 0; index < entries.length; index++) {
    const score = scoreNormMatch(entries[index].norm || "", tokens)
    if (score > 0) scored.push({ index, score })
  }
  scored.sort((left, right) => right.score - left.score)
  return Uint32Array.from(scored.slice(0, cap).map((entry) => entry.index))
}

let worker: Worker | null = null
let workerBroken = false
let requestSeq = 0
let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null
const catalogSentByCatalogId = new Map<string, unknown>()
const latestRequestIdByCatalogId = new Map<string, number>()
const pendingByRequestId = new Map<number, (indexes: Uint32Array | null) => void>()

function settlePending(indexes: Uint32Array | null): void {
  for (const resolve of pendingByRequestId.values()) resolve(indexes)
  pendingByRequestId.clear()
}

function dropWorker(): void {
  if (idleReleaseTimer) {
    clearTimeout(idleReleaseTimer)
    idleReleaseTimer = null
  }
  try {
    worker?.terminate()
  } catch {}
  worker = null
  // Structured-clone copies of the catalog live in the worker; the client's own
  // map pins the source array. Both go with the worker.
  catalogSentByCatalogId.clear()
}

function retireWorker(): void {
  workerBroken = true
  dropWorker()
}

/** Frees the worker's catalog copies; a later request just builds a fresh worker. */
export function releaseCatalogWorker(): void {
  if (!worker) return
  dropWorker()
  settlePending(null)
}

function noteWorkerActivity(): void {
  if (idleReleaseTimer) clearTimeout(idleReleaseTimer)
  idleReleaseTimer = setTimeout(releaseCatalogWorker, IDLE_RELEASE_MS)
}

if (typeof document !== "undefined") {
  document.addEventListener("astro:before-swap", releaseCatalogWorker)
}

function getWorker(): Worker | null {
  if (workerBroken) return null
  // A dedicated worker shares the renderer process, so its catalog copy doubles
  // the resident catalog - never worth it on a low-memory TV.
  if (effectTier() !== "full") return null
  if (worker) return worker
  if (typeof Worker === "undefined") {
    workerBroken = true
    return null
  }
  try {
    const nextWorker = new Worker(new URL("./catalog-worker.ts", import.meta.url), { type: "module" })
    nextWorker.addEventListener("message", (event: MessageEvent<CatalogFilterWorkerResponse>) => {
      const resolve = pendingByRequestId.get(event.data.requestId)
      pendingByRequestId.delete(event.data.requestId)
      resolve?.(event.data.indexes)
    })
    nextWorker.addEventListener("error", (event) => {
      log.warn("[xt:catalog-worker] error:", event?.message || event)
      retireWorker()
      settlePending(new Uint32Array(0))
    })
    worker = nextWorker
    return worker
  } catch (error) {
    log.warn("[xt:catalog-worker] construct failed:", error)
    workerBroken = true
    return null
  }
}

/**
 * Filters+sorts `entries` for `catalogId`, off the main thread when the catalog is
 * large enough to be worth it. Returns `null` when a newer call for the same
 * `catalogId` has already superseded this one - callers should ignore that reply.
 */
export async function filterCatalog<T extends WorkerCatalogEntry>(
  catalogId: string,
  entries: T[],
  params: CatalogFilterParams
): Promise<Uint32Array | null> {
  const requestId = ++requestSeq
  latestRequestIdByCatalogId.set(catalogId, requestId)
  const isStale = (): boolean => latestRequestIdByCatalogId.get(catalogId) !== requestId

  if (entries.length < SYNC_THRESHOLD) {
    const indexes = filterSync(entries, params)
    return isStale() ? null : indexes
  }

  const activeWorker = getWorker()
  if (!activeWorker) {
    const indexes = filterSync(entries, params)
    return isStale() ? null : indexes
  }

  noteWorkerActivity()
  if (catalogSentByCatalogId.get(catalogId) !== entries) {
    catalogSentByCatalogId.set(catalogId, entries)
    activeWorker.postMessage({ type: "catalog", catalogId, entries })
  }

  const workerParams: CatalogFilterWorkerParams = {
    category: params.state.category,
    query: params.state.query,
    hideWatched: params.state.hideWatched,
    sort: params.state.sort,
    isGenreCategory: params.category.isGenreCategory,
    genreMatchIds: params.category.genreMatchIds,
    uncategorizedLabel: params.category.uncategorizedLabel,
    watchedIds: params.watchedIds,
  }

  return new Promise<Uint32Array | null>((resolve) => {
    pendingByRequestId.set(requestId, (indexes) => resolve(indexes && !isStale() ? indexes : null))
    activeWorker.postMessage({ type: "filter", requestId, catalogId, params: workerParams })
  })
}

/**
 * Ranks `entries` for `catalogId` against `query`, off the main thread when the catalog is
 * large enough to be worth it. Returns `null` when a newer call for the same `catalogId` has
 * already superseded this one - callers should ignore that reply.
 */
export async function searchCatalog<T extends SearchableEntry>(
  catalogId: string,
  entries: T[],
  query: string,
  cap: number
): Promise<Uint32Array | null> {
  const requestId = ++requestSeq
  latestRequestIdByCatalogId.set(catalogId, requestId)
  const isStale = (): boolean => latestRequestIdByCatalogId.get(catalogId) !== requestId

  if (entries.length < SYNC_THRESHOLD) {
    const indexes = searchSync(entries, query, cap)
    return isStale() ? null : indexes
  }

  const activeWorker = getWorker()
  if (!activeWorker) {
    const indexes = searchSync(entries, query, cap)
    return isStale() ? null : indexes
  }

  noteWorkerActivity()
  if (catalogSentByCatalogId.get(catalogId) !== entries) {
    catalogSentByCatalogId.set(catalogId, entries)
    activeWorker.postMessage({ type: "catalog", catalogId, entries })
  }

  return new Promise<Uint32Array | null>((resolve) => {
    pendingByRequestId.set(requestId, (indexes) => resolve(indexes && !isStale() ? indexes : null))
    activeWorker.postMessage({ type: "search", requestId, catalogId, query, cap })
  })
}
