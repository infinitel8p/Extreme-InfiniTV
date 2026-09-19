// Main-thread client for catalog-ingest-worker.ts: decodes+maps+sorts a raw Xtream
// catalog payload off the main thread. Not gated on effect tier - unlike the TV
// catalog-filter-client, this worker keeps no resident catalog copy between calls.

import { log } from "@/scripts/lib/log.js"
import {
  mapXtreamLiveRows,
  mapXtreamVodRows,
  mapXtreamSeriesRows,
  unwrapRows,
} from "@/scripts/lib/catalog-mappers.js"
import type { CatalogIngestKind, CatalogIngestRequest, CatalogIngestResponse } from "./catalog-ingest-worker"

const IDLE_RELEASE_MS = 60_000
// A wedged worker on a big catalog shouldn't be cut off before a slow device could
// plausibly finish; budgeted per megabyte like epg-data.js's xmlWorkerTimeoutMs.
const INGEST_TIMEOUT_MIN_MS = 15_000
const INGEST_TIMEOUT_PER_MB_MS = 3_000

export function catalogIngestTimeoutMs(byteLength: number): number {
  const megabytes = Math.max(0, byteLength) / (1024 * 1024)
  return INGEST_TIMEOUT_MIN_MS + Math.ceil(megabytes) * INGEST_TIMEOUT_PER_MB_MS
}

const ARRAY_KEY_BY_KIND: Record<CatalogIngestKind, "streams" | "movies" | "series"> = {
  live: "streams",
  vod: "movies",
  series: "series",
}

function mapRowsSync(kind: CatalogIngestKind, rawRows: unknown[], categoryMap: Map<string, string>): unknown[] {
  if (kind === "live") return mapXtreamLiveRows(rawRows, categoryMap)
  if (kind === "vod") return mapXtreamVodRows(rawRows, categoryMap)
  return mapXtreamSeriesRows(rawRows, categoryMap)
}

function ingestSync(
  kind: CatalogIngestKind,
  streamsBuf: ArrayBuffer,
  categoryEntries: Array<[string, string]>
): unknown[] {
  const text = new TextDecoder("utf-8").decode(streamsBuf)
  const parsed = JSON.parse(text)
  const rawRows = unwrapRows(parsed, ARRAY_KEY_BY_KIND[kind])
  return mapRowsSync(kind, rawRows, new Map(categoryEntries))
}

// A dedicated worker is single-threaded, so the three catalog kinds naturally
// serialize behind it - no need for a resident-catalog cap like catalog-filter-client.
let worker: Worker | null = null
let workerBroken = false
let requestSeq = 0
let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null
const pendingByRequestId = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>()

function settleAllPending(error: Error): void {
  for (const pending of pendingByRequestId.values()) pending.reject(error)
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
}

function retireWorker(): void {
  workerBroken = true
  dropWorker()
}

/** Frees the worker; a later request just builds a fresh one. */
export function releaseCatalogIngestWorker(): void {
  if (!worker) return
  dropWorker()
}

function noteWorkerActivity(): void {
  if (idleReleaseTimer) clearTimeout(idleReleaseTimer)
  idleReleaseTimer = setTimeout(releaseCatalogIngestWorker, IDLE_RELEASE_MS)
}

if (typeof document !== "undefined") {
  document.addEventListener("astro:before-swap", releaseCatalogIngestWorker)
}

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  if (typeof Worker === "undefined") {
    workerBroken = true
    return null
  }
  try {
    const nextWorker = new Worker(new URL("./catalog-ingest-worker.ts", import.meta.url), { type: "module" })
    nextWorker.addEventListener("message", (event: MessageEvent<CatalogIngestResponse>) => {
      const pending = pendingByRequestId.get(event.data.requestId)
      pendingByRequestId.delete(event.data.requestId)
      if (!pending) return
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve(event.data.rows || [])
    })
    nextWorker.addEventListener("error", (event) => {
      log.warn("[xt:catalog-ingest] worker error:", event?.message || event)
      retireWorker()
      settleAllPending(new Error("catalog ingest worker error"))
    })
    worker = nextWorker
    return worker
  } catch (error) {
    log.warn("[xt:catalog-ingest] worker construct failed:", error)
    workerBroken = true
    return null
  }
}

// Serializes the main-thread fallback so a low-memory device without Worker support
// (or a broken worker) never runs two large JSON.parse + map passes concurrently;
// a setTimeout yield between kinds gives input handling a chance to breathe.
let fallbackChain: Promise<void> = Promise.resolve()

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function runFallback(
  kind: CatalogIngestKind,
  streamsBuf: ArrayBuffer,
  categoryEntries: Array<[string, string]>
): Promise<unknown[]> {
  const run = fallbackChain.then(async () => {
    await yieldToMainThread()
    return ingestSync(kind, streamsBuf, categoryEntries)
  })
  fallbackChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * Decodes+maps+sorts a raw Xtream catalog body off the main thread, falling back to a
 * yielded main-thread parse when Worker isn't available. Worker errors and timeouts are
 * rethrown as plain Errors so catalog.js's HttpRetryError classification still applies.
 */
export async function ingestXtreamBytes(
  kind: CatalogIngestKind,
  streamsBuf: ArrayBuffer,
  categoryEntries: Array<[string, string]>
): Promise<unknown[]> {
  const activeWorker = getWorker()
  if (!activeWorker) return runFallback(kind, streamsBuf, categoryEntries)

  noteWorkerActivity()
  const requestId = ++requestSeq
  const request: CatalogIngestRequest = { type: "ingest", requestId, kind, streams: streamsBuf, categories: categoryEntries }

  return new Promise<unknown[]>((resolve, reject) => {
    const timeoutMs = catalogIngestTimeoutMs(streamsBuf.byteLength)
    const timer = setTimeout(() => {
      const error = new Error(`catalog ingest worker did not reply within ${timeoutMs}ms`)
      pendingByRequestId.delete(requestId)
      // A wedged worker won't recover; retire it rather than pay the budget again next call.
      retireWorker()
      // Every other pending request was riding the same wedged worker - reject them now
      // instead of leaving each to wait out its own timeout.
      settleAllPending(error)
      reject(error)
    }, timeoutMs)
    pendingByRequestId.set(requestId, {
      resolve: (rows) => {
        clearTimeout(timer)
        resolve(rows)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    activeWorker.postMessage(request, [streamsBuf])
  })
}
