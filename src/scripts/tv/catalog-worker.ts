// Runs the TV movies/series catalog filter+sort off the main thread; keeps the
// posted catalog resident so only the small filter params cross per request.

import {
  filterAndSortIndexes,
  gridCategoryMatcher,
  gridWatchedMatcher,
  type GridFilterEntry,
  type GridFilterState,
} from "@/scripts/lib/tv-grid-filter"
import { normalize, parseSearchQuery, scoreNormMatch } from "@/scripts/lib/text.ts"
import { isTrustedWorkerMessage } from "@/scripts/lib/worker-origin.ts"

// Duplicated from lib/genre-index.ts (which pulls in document/IndexedDB-dependent
// modules that don't run in a worker) - keep this literal in sync with that one.
const GENRE_CAT_PREFIX = "__genre__:"

interface WorkerCatalogEntry extends GridFilterEntry {
  category?: string | null
}

export interface CatalogFilterWorkerParams {
  category: string | null
  query: string
  hideWatched: boolean
  sort: string
  isGenreCategory: boolean
  genreMatchKeys?: string[]
  uncategorizedLabel: string
  watchedKeys?: string[]
}

interface CatalogMessage {
  type: "catalog"
  catalogId: string
  entries: WorkerCatalogEntry[]
}

interface FilterMessage {
  type: "filter"
  requestId: number
  catalogId: string
  params: CatalogFilterWorkerParams
}

interface SearchMessage {
  type: "search"
  requestId: number
  catalogId: string
  query: string
  cap: number
}

type IncomingMessage = CatalogMessage | FilterMessage | SearchMessage

export interface CatalogFilterWorkerResponse {
  requestId: number
  indexes: Uint32Array
}

// Search queries live+vod+series in one pass; anything beyond that is a stale view's catalog.
const MAX_RESIDENT_CATALOGS = 3
const catalogs = new Map<string, WorkerCatalogEntry[]>()

function storeCatalog(catalogId: string, entries: WorkerCatalogEntry[]): void {
  catalogs.delete(catalogId)
  catalogs.set(catalogId, entries)
  while (catalogs.size > MAX_RESIDENT_CATALOGS) {
    const oldestId = catalogs.keys().next().value
    if (oldestId === undefined) break
    catalogs.delete(oldestId)
  }
}

const post = (message: CatalogFilterWorkerResponse): void =>
  (self as unknown as Worker).postMessage(message, [message.indexes.buffer])

self.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  if (!isTrustedWorkerMessage(event)) return
  const message = event.data
  if (!message) return

  if (message.type === "catalog") {
    storeCatalog(message.catalogId, message.entries)
    return
  }

  if (message.type === "search") {
    const entries = catalogs.get(message.catalogId) || []
    const tokens = parseSearchQuery(message.query)
    const scored: Array<{ index: number; score: number }> = []
    for (let index = 0; index < entries.length; index++) {
      const score = scoreNormMatch(entries[index].norm || "", tokens, entries[index].name)
      if (score > 0) scored.push({ index, score })
    }
    scored.sort((left, right) => right.score - left.score)
    const indexes = Uint32Array.from(scored.slice(0, message.cap).map((entry) => entry.index))
    post({ requestId: message.requestId, indexes })
    return
  }

  const entries = catalogs.get(message.catalogId) || []
  const state: GridFilterState = {
    category: message.params.category,
    query: message.params.query,
    hideWatched: message.params.hideWatched,
    sort: message.params.sort,
  }
  const indexes = filterAndSortIndexes(entries, state, {
    categoryMatcher: gridCategoryMatcher<WorkerCatalogEntry>({
      genrePrefix: GENRE_CAT_PREFIX,
      genreMatchKeys: message.params.genreMatchKeys,
      uncategorizedLabel: message.params.uncategorizedLabel,
    }),
    isWatched: gridWatchedMatcher<WorkerCatalogEntry>(message.params.watchedKeys),
    normalize,
  })
  post({ requestId: message.requestId, indexes })
})
