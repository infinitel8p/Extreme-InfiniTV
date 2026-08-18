// Multi-source genre classification (bulk row genre, detail-page notes, category fallback) for movies/series.
import { getCached, hydrate, setCached, CACHE_REVALIDATED_EVENT } from "@/scripts/lib/cache.js"
import { parseGenreString, genreForCategoryName, CANONICAL_GENRES, type GenreId } from "@/scripts/lib/genres.ts"
import { tmdbDiscoverByGenre, type TmdbDiscoverItem } from "@/scripts/lib/tmdb.ts"
import { matchAllTitlesToCatalog } from "@/scripts/lib/tmdb-match.ts"
import { isTmdbActive } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

export const GENRE_CAT_PREFIX = "__genre__:"
export const GENRE_INDEX_EVENT = "xt:genre-index-changed"

export interface GenreIndex {
  sets: Map<GenreId, Set<number>>
  classifiedCount: number
  totalCount: number
}

interface GenreIndexInternal extends GenreIndex {
  classifiedIds: Set<number>
}

interface GenreRow {
  id: number | string
  category?: string | null
  genre?: string | null
  name?: string
  year?: number | string | null
  tmdb?: number | string | null
}

type GenreKind = "vod" | "series"
type GenreNotes = Record<number, GenreId[]>

const DISPATCH_DEBOUNCE_MS = 250
const PERSIST_DEBOUNCE_MS = 800
const NOTES_TTL_MS = 400 * 24 * 60 * 60 * 1000
const GENRE_SWEEP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const GENRE_SWEEP_MAX_PAGES_PER_TMDB_ID = 25

function genreSweepCacheKind(kind: GenreKind, genreId: GenreId): string {
  return `genre_sweep_${kind}_${genreId}`
}

function notesCacheKind(kind: GenreKind): string {
  return `genre_notes_${kind}`
}

function memoKey(playlistId: string, kind: GenreKind): string {
  return `${playlistId}:${kind}`
}

/** Pure classification core: merges row genre, detail notes, and category fallback into an inverted index. */
export function buildGenreIndexFromRows(rows: GenreRow[], notes: GenreNotes): GenreIndex {
  const sets = new Map<GenreId, Set<number>>()
  const classifiedIds = new Set<number>()

  const addToSet = (genreId: GenreId, titleId: number) => {
    let bucket = sets.get(genreId)
    if (!bucket) {
      bucket = new Set()
      sets.set(genreId, bucket)
    }
    bucket.add(titleId)
  }

  for (const row of rows || []) {
    const titleId = Number(row?.id)
    if (!Number.isFinite(titleId)) continue

    const strongGenres = new Set<GenreId>([
      ...parseGenreString(row.genre),
      ...(notes[titleId] || []),
    ])
    for (const genreId of strongGenres) addToSet(genreId, titleId)
    if (strongGenres.size) classifiedIds.add(titleId)

    for (const genreId of genreForCategoryName(row.category)) addToSet(genreId, titleId)
  }

  const result: GenreIndexInternal = {
    sets,
    classifiedCount: classifiedIds.size,
    totalCount: (rows || []).length,
    classifiedIds,
  }
  return result
}

/** Union of tmdb-id-matched rows and (for rows without a tmdb id) name+year fallback matches. */
export function matchDiscoverToRows(items: TmdbDiscoverItem[], rows: GenreRow[]): number[] {
  const matchedIds = new Set<number>()
  if (!items.length || !rows.length) return []

  const tmdbIdSet = new Set(items.map((item) => item.tmdbId))
  const rowsWithoutTmdbId: Array<{ id: number; name: string; year?: number | string | null }> = []

  for (const row of rows) {
    const titleId = Number(row.id)
    if (!Number.isFinite(titleId)) continue
    const rowTmdbId = Number(row.tmdb)
    if (Number.isFinite(rowTmdbId) && rowTmdbId > 0) {
      if (tmdbIdSet.has(rowTmdbId)) matchedIds.add(titleId)
      continue
    }
    rowsWithoutTmdbId.push({ id: titleId, name: row.name || "", year: row.year })
  }

  if (rowsWithoutTmdbId.length) {
    const titles = items.map((item) => ({ title: item.name, year: item.year }))
    const matched = matchAllTitlesToCatalog(titles, rowsWithoutTmdbId)
    for (const entry of matched) matchedIds.add(Number(entry.id))
  }

  return [...matchedIds]
}

const memoIndex = new Map<string, GenreIndex>()
const memoNotes = new Map<string, GenreNotes>()
const notesLoading = new Map<string, Promise<GenreNotes>>()
const dispatchTimers = new Map<string, ReturnType<typeof setTimeout>>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

function dispatchGenreIndexEvent(playlistId: string, kind: GenreKind) {
  try {
    document.dispatchEvent(new CustomEvent(GENRE_INDEX_EVENT, { detail: { playlistId, kind } }))
  } catch {}
}

function scheduleDispatch(playlistId: string, kind: GenreKind) {
  const key = memoKey(playlistId, kind)
  if (dispatchTimers.has(key)) return
  const timer = setTimeout(() => {
    dispatchTimers.delete(key)
    dispatchGenreIndexEvent(playlistId, kind)
  }, DISPATCH_DEBOUNCE_MS)
  dispatchTimers.set(key, timer)
}

function persistNotes(playlistId: string, kind: GenreKind) {
  const key = memoKey(playlistId, kind)
  const existing = persistTimers.get(key)
  if (existing) {
    clearTimeout(existing)
    persistTimers.delete(key)
  }
  const notes = memoNotes.get(key)
  if (notes) setCached(playlistId, notesCacheKind(kind), notes, NOTES_TTL_MS)
}

function schedulePersist(playlistId: string, kind: GenreKind) {
  const key = memoKey(playlistId, kind)
  const existing = persistTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    persistTimers.delete(key)
    const notes = memoNotes.get(key)
    if (notes) setCached(playlistId, notesCacheKind(kind), notes, NOTES_TTL_MS)
  }, PERSIST_DEBOUNCE_MS)
  persistTimers.set(key, timer)
}

async function loadNotes(playlistId: string, kind: GenreKind): Promise<GenreNotes> {
  const key = memoKey(playlistId, kind)
  const cached = memoNotes.get(key)
  if (cached) return cached
  const inflight = notesLoading.get(key)
  if (inflight) return inflight
  const run = (async () => {
    await hydrate(playlistId, notesCacheKind(kind))
    const hit = getCached(playlistId, notesCacheKind(kind))
    const notes = (hit?.data as GenreNotes) || {}
    memoNotes.set(key, notes)
    return notes
  })()
  notesLoading.set(key, run)
  try {
    return await run
  } finally {
    notesLoading.delete(key)
  }
}

async function loadRows(playlistId: string, kind: GenreKind): Promise<GenreRow[]> {
  await hydrate(playlistId, kind)
  const hit = getCached(playlistId, kind)
  return Array.isArray(hit?.data) ? (hit.data as GenreRow[]) : []
}

export async function getGenreIndex(playlistId: string, kind: GenreKind): Promise<GenreIndex> {
  const key = memoKey(playlistId, kind)
  const cached = memoIndex.get(key)
  if (cached) return cached
  const [rows, notes] = await Promise.all([loadRows(playlistId, kind), loadNotes(playlistId, kind)])
  const index = buildGenreIndexFromRows(rows, notes)
  memoIndex.set(key, index)
  return index
}

function genreArraysEqual(a: GenreId[], b: GenreId[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((genreId) => setA.has(genreId))
}

async function applyDetailNote(
  playlistId: string,
  kind: GenreKind,
  titleId: number,
  parsedGenres: GenreId[]
) {
  const key = memoKey(playlistId, kind)
  const notes = await loadNotes(playlistId, kind)
  const existing = notes[titleId] || []
  const merged = Array.from(new Set([...existing, ...parsedGenres])) as GenreId[]
  if (genreArraysEqual(existing, merged)) return

  const nextNotes = { ...notes, [titleId]: merged }
  memoNotes.set(key, nextNotes)
  schedulePersist(playlistId, kind)

  const index = memoIndex.get(key) as GenreIndexInternal | undefined
  if (index) {
    for (const genreId of merged) {
      let bucket = index.sets.get(genreId)
      if (!bucket) {
        bucket = new Set()
        index.sets.set(genreId, bucket)
      }
      bucket.add(titleId)
    }
    if (!index.classifiedIds.has(titleId)) {
      index.classifiedIds.add(titleId)
      index.classifiedCount = index.classifiedIds.size
    }
  }

  scheduleDispatch(playlistId, kind)
}

/** Batched version of applyDetailNote: one merge, one persist, one dispatch for a whole sweep. */
async function applyGenreBoost(
  playlistId: string,
  kind: GenreKind,
  genreId: GenreId,
  titleIds: number[]
): Promise<void> {
  const key = memoKey(playlistId, kind)
  const notes = await loadNotes(playlistId, kind)
  const nextNotes = { ...notes }
  let changed = false

  for (const titleId of titleIds) {
    const existing = nextNotes[titleId] || []
    if (existing.includes(genreId)) continue
    nextNotes[titleId] = [...existing, genreId]
    changed = true
  }
  if (!changed) return

  memoNotes.set(key, nextNotes)
  // The sweep stamp lands right after this, so a debounced write could lose the notes to a navigation.
  persistNotes(playlistId, kind)

  const index = memoIndex.get(key) as GenreIndexInternal | undefined
  if (index) {
    let bucket = index.sets.get(genreId)
    if (!bucket) {
      bucket = new Set()
      index.sets.set(genreId, bucket)
    }
    for (const titleId of titleIds) {
      bucket.add(titleId)
      index.classifiedIds.add(titleId)
    }
    index.classifiedCount = index.classifiedIds.size
  }

  scheduleDispatch(playlistId, kind)
}

export function noteDetailGenres(
  playlistId: string,
  kind: GenreKind,
  titleId: number,
  rawGenre: string | null | undefined
): void {
  if (!playlistId || !Number.isFinite(titleId)) return
  const parsed = parseGenreString(rawGenre)
  if (!parsed.length) return
  applyDetailNote(playlistId, kind, titleId, parsed).catch((err) => {
    log.warn("[xt:genre-index] note detail genres failed:", err)
  })
}

const TMDB_ID_SWEEP_CONCURRENCY = 3

async function mapWithConcurrency<Item, Result>(
  items: Item[],
  limit: number,
  mapper: (item: Item) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++
      results[currentIndex] = await mapper(items[currentIndex])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function sweepTmdbGenreId(
  kind: GenreKind,
  tmdbGenreId: number,
  items: TmdbDiscoverItem[]
): Promise<boolean> {
  let page = 1
  let totalPages = 1
  while (page <= totalPages && page <= GENRE_SWEEP_MAX_PAGES_PER_TMDB_ID) {
    const result = await tmdbDiscoverByGenre(kind, tmdbGenreId, page)
    if (!result) return false
    items.push(...result.items)
    totalPages = result.totalPages || 1
    page++
  }
  return true
}

const genreSweepInFlight = new Set<string>()

/** True when a stamp claims boosted titles the notes store no longer holds (interrupted persist). */
export function sweepStampLostItsNotes(
  stampData: unknown,
  notes: GenreNotes,
  genreId: GenreId
): boolean {
  const rawMatched = Number((stampData as { matched?: unknown } | null)?.matched)
  // Stamps written before `matched` existed are verified once, then rewritten with a count.
  const matched = Number.isFinite(rawMatched) ? rawMatched : 1
  if (matched <= 0) return false
  for (const genres of Object.values(notes)) {
    if (genres.includes(genreId)) return false
  }
  return true
}

/** TMDb discover sweep for one genre, boosting matched catalog titles into the same notes store as noteDetailGenres. */
export async function ensureGenreBoost(playlistId: string, kind: GenreKind, genreId: GenreId): Promise<void> {
  if (!playlistId || !isTmdbActive()) return
  const sweepKey = `${memoKey(playlistId, kind)}:${genreId}`
  if (genreSweepInFlight.has(sweepKey)) return

  const stampKind = genreSweepCacheKind(kind, genreId)
  await hydrate(playlistId, stampKind)
  const stamp = getCached(playlistId, stampKind)
  if (stamp && !stamp.stale) {
    const notes = await loadNotes(playlistId, kind)
    if (!sweepStampLostItsNotes(stamp.data, notes, genreId)) return
  }

  genreSweepInFlight.add(sweepKey)
  try {
    const canonical = CANONICAL_GENRES.find((genre) => genre.id === genreId)
    const tmdbGenreIds = canonical ? (kind === "vod" ? canonical.tmdbMovieIds : canonical.tmdbTvIds) : []
    if (!tmdbGenreIds.length) {
      setCached(playlistId, stampKind, { sweptAt: Date.now(), matched: 0 }, GENRE_SWEEP_TTL_MS)
      return
    }

    const items: TmdbDiscoverItem[] = []
    const completions = await mapWithConcurrency(tmdbGenreIds, TMDB_ID_SWEEP_CONCURRENCY, (tmdbGenreId) =>
      sweepTmdbGenreId(kind, tmdbGenreId, items)
    )
    const allComplete = completions.every(Boolean)

    let matchedCount = 0
    if (items.length) {
      const rows = await loadRows(playlistId, kind)
      const matchedIds = matchDiscoverToRows(items, rows)
      matchedCount = matchedIds.length
      if (matchedIds.length) await applyGenreBoost(playlistId, kind, genreId, matchedIds)
    }

    // A failed page mid-sweep leaves the stamp unwritten so a later call can retry.
    if (allComplete) {
      setCached(playlistId, stampKind, { sweptAt: Date.now(), matched: matchedCount }, GENRE_SWEEP_TTL_MS)
    }
  } catch (err) {
    log.warn("[xt:genre-index] genre boost sweep failed:", kind, genreId, err)
  } finally {
    genreSweepInFlight.delete(sweepKey)
  }
}

export function invalidateGenreIndex(playlistId: string, kind?: GenreKind): void {
  if (!playlistId) return
  const kinds: GenreKind[] = kind ? [kind] : ["vod", "series"]
  for (const genreKind of kinds) {
    memoIndex.delete(memoKey(playlistId, genreKind))
    scheduleDispatch(playlistId, genreKind)
  }
}

if (typeof document !== "undefined") {
  document.addEventListener(CACHE_REVALIDATED_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as { entryId?: string; kind?: string } | undefined
    if (!detail?.entryId) return
    if (detail.kind === "vod" || detail.kind === "series") {
      invalidateGenreIndex(detail.entryId, detail.kind)
    }
  })
}
