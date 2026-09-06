// Decodes + maps + sorts a raw Xtream catalog payload off the main thread so a
// multi-MB JSON body never exists as a parsed structure on the main thread.

import {
  mapXtreamLiveRows,
  mapXtreamVodRows,
  mapXtreamSeriesRows,
  unwrapRows,
} from "@/scripts/lib/catalog-mappers.js"
import { isTrustedWorkerMessage } from "@/scripts/lib/worker-origin.ts"

export type CatalogIngestKind = "live" | "vod" | "series"

export interface CatalogIngestRequest {
  type: "ingest"
  requestId: number
  kind: CatalogIngestKind
  streams: ArrayBuffer
  categories: Array<[string, string]>
}

export interface CatalogIngestResponse {
  requestId: number
  rows?: unknown[]
  error?: string
}

const ARRAY_KEY_BY_KIND: Record<CatalogIngestKind, "streams" | "movies" | "series"> = {
  live: "streams",
  vod: "movies",
  series: "series",
}

function mapRows(kind: CatalogIngestKind, rawRows: unknown[], categoryMap: Map<string, string>): unknown[] {
  if (kind === "live") return mapXtreamLiveRows(rawRows, categoryMap)
  if (kind === "vod") return mapXtreamVodRows(rawRows, categoryMap)
  return mapXtreamSeriesRows(rawRows, categoryMap)
}

/** Pure request handler, exported so tests can drive the worker's message contract directly. */
export function handleIngestRequest(request: CatalogIngestRequest): CatalogIngestResponse {
  try {
    const text = new TextDecoder("utf-8").decode(request.streams)
    const parsed = JSON.parse(text)
    const rawRows = unwrapRows(parsed, ARRAY_KEY_BY_KIND[request.kind])
    const categoryMap = new Map(request.categories)
    const rows = mapRows(request.kind, rawRows, categoryMap)
    return { requestId: request.requestId, rows }
  } catch (error) {
    return { requestId: request.requestId, error: error instanceof Error ? error.message : String(error) }
  }
}

self.addEventListener("message", (event: MessageEvent<CatalogIngestRequest>) => {
  if (!isTrustedWorkerMessage(event)) return
  const request = event.data
  if (!request || request.type !== "ingest") return
  const response = handleIngestRequest(request)
  ;(self as unknown as Worker).postMessage(response)
})
