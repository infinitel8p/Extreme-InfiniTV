// Ranked artwork rotation for the ambient/screensaver screen, biased toward watched/watching content.
import { ensureLoaded, getContinueWatching, getRecents, getWatchlist, getWatchedSignals } from "@/scripts/lib/preferences.js"
import { getCached, getCachedByKindPrefix, hydrate } from "@/scripts/lib/cache.js"
import { pickBecauseSeedPool, buildBecauseRow } from "@/scripts/lib/because-watched.ts"
import type { LocalSimilarCandidate } from "@/scripts/lib/similar-local.ts"
import { sanitizeProviderBackdropUrl } from "@/scripts/lib/morph-detail.ts"
import { getCachedTitleEnrichment, type TmdbTitleEnrichment } from "@/scripts/lib/tmdb-enrich.ts"
import { resolveTitleEnrichment } from "@/scripts/lib/enrichment.ts"
import { tmdbTrending } from "@/scripts/lib/tmdb.ts"
import { fetchTvdbTrending } from "@/scripts/lib/tvdb-proxy.ts"
import { matchTrendingToCatalog, type TrendingCandidate } from "@/scripts/lib/ambient-trending.ts"
import { isEnrichmentActive, isTmdbActive } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

const DEFAULT_LIMIT = 50
const RECOMMENDED_SEED_COUNT = 3
const RECOMMENDED_PICKS_PER_SEED = 6
const BACKDROP_FETCH_CONCURRENCY = 3
// A cold library with nothing cached yet must not fire one TVDB/TMDb call per entry.
const MAX_ARTWORK_FETCHES = 24

export type AmbientTier = "watching" | "recent" | "recommended" | "catalog"

export interface AmbientEntry {
  kind: "vod" | "series"
  id: string
  title: string
  posterUrl: string | null
  backdropUrl: string | null
  logoUrl: string | null
  tier: AmbientTier
}

export type AmbientCandidate = Omit<AmbientEntry, "tier">

export interface AssembleAmbientEntriesInput {
  trending: AmbientCandidate[]
  watching: AmbientCandidate[]
  recent: AmbientCandidate[]
  recommended: AmbientCandidate[]
  catalog: AmbientCandidate[]
  limit: number
  random: () => number
}

function hasArtwork(candidate: AmbientCandidate): boolean {
  return !!(candidate.posterUrl || candidate.backdropUrl || candidate.logoUrl)
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const shuffled = items.slice()
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }
  return shuffled
}

export function assembleAmbientEntries(input: AssembleAmbientEntriesInput): AmbientEntry[] {
  const { trending, watching, recent, recommended, catalog, limit, random } = input
  const seenKeys = new Set<string>()
  const entries: AmbientEntry[] = []

  function addFromTier(candidates: AmbientCandidate[], tier: AmbientTier) {
    for (const candidate of candidates) {
      if (entries.length >= limit) return
      if (!candidate.title?.trim()) continue
      if (!hasArtwork(candidate)) continue
      const dedupeKey = `${candidate.kind}:${candidate.id}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      entries.push({ ...candidate, tier })
    }
  }

  // Trending order already carries meaning (score rank), so it isn't shuffled.
  // Tagged "recommended": the wire tier set is fixed by the receiver's sanitizer.
  addFromTier(trending, "recommended")
  addFromTier(watching, "watching")
  addFromTier(shuffle(recent, random), "recent")
  addFromTier(shuffle(recommended, random), "recommended")
  addFromTier(shuffle(catalog, random), "catalog")

  return entries
}

// ---------------------------------------------------------------------------
// Impure collector: cache-only wiring against preferences.js / cache.js.
// ---------------------------------------------------------------------------

interface CatalogRow {
  id: number | string
  name?: string
  logo?: string | null
  category?: string
  rating?: unknown
  year?: number | string | null
  tmdb?: number | null
}

function catalogRowTitle(row: CatalogRow | undefined): string {
  return row?.name || ""
}

function catalogRowPoster(row: CatalogRow | undefined): string | null {
  return row?.logo || null
}

function catalogRowYear(row: CatalogRow | undefined): number | null {
  const parsed = Number(row?.year)
  return Number.isFinite(parsed) ? parsed : null
}

async function loadCatalog(playlistId: string, kind: "vod" | "series"): Promise<CatalogRow[]> {
  await hydrate(playlistId, kind)
  return getCached(playlistId, kind)?.data || []
}

function indexCatalogById(rows: CatalogRow[]): Map<string, CatalogRow> {
  const byId = new Map<string, CatalogRow>()
  for (const row of rows) {
    if (row?.id == null) continue
    byId.set(String(row.id), row)
  }
  return byId
}

// preferences.js's JSDoc types are looser than its runtime behavior (e.g. the
// vod/episode union doesn't narrow on `kind`, and "series" isn't in the
// recents/watchlist kind unions even though the implementation supports it).
interface ContinueWatchingRow {
  kind: "vod" | "episode"
  id: string
  name?: string
  logo?: string | null
  seriesId?: number
  seriesName?: string
  seriesLogo?: string | null
}

interface RecentRow {
  id: number | string
  name?: string
  logo?: string | null
}

interface WatchlistMeta {
  ts: number
  name?: string
  logo?: string | null
}

function readContinueWatching(playlistId: string): ContinueWatchingRow[] {
  return getContinueWatching(playlistId, 12) as unknown as ContinueWatchingRow[]
}

function readRecents(playlistId: string, kind: "vod" | "series"): RecentRow[] {
  return (getRecents as (playlistId: string, kind: string) => RecentRow[])(playlistId, kind)
}

function readWatchlist(playlistId: string, kind: "vod" | "series"): Record<string, WatchlistMeta> {
  return (getWatchlist as (playlistId: string, kind: string) => Record<string, WatchlistMeta>)(playlistId, kind)
}

function collectWatchingCandidates(
  playlistId: string,
  vodById: Map<string, CatalogRow>,
  seriesById: Map<string, CatalogRow>
): AmbientCandidate[] {
  const rows = readContinueWatching(playlistId)
  const out: AmbientCandidate[] = []
  for (const row of rows) {
    if (row.kind === "vod") {
      const catalogRow = vodById.get(String(row.id))
      const title = row.name || catalogRowTitle(catalogRow)
      if (!title) continue
      out.push({
        kind: "vod",
        id: String(row.id),
        title,
        posterUrl: row.logo || catalogRowPoster(catalogRow),
        backdropUrl: null,
        logoUrl: null,
      })
    } else if (row.kind === "episode" && row.seriesId != null) {
      const seriesId = String(row.seriesId)
      const catalogRow = seriesById.get(seriesId)
      const title = row.seriesName || catalogRowTitle(catalogRow)
      if (!title) continue
      out.push({
        kind: "series",
        id: seriesId,
        title,
        posterUrl: row.seriesLogo || catalogRowPoster(catalogRow),
        backdropUrl: null,
        logoUrl: null,
      })
    }
  }
  return out
}

function collectRecentCandidates(
  playlistId: string,
  vodById: Map<string, CatalogRow>,
  seriesById: Map<string, CatalogRow>
): AmbientCandidate[] {
  const out: AmbientCandidate[] = []
  for (const kind of ["vod", "series"] as const) {
    const catalogById = kind === "vod" ? vodById : seriesById

    for (const row of readRecents(playlistId, kind)) {
      const catalogRow = catalogById.get(String(row.id))
      const title = row.name || catalogRowTitle(catalogRow)
      if (!title) continue
      out.push({
        kind,
        id: String(row.id),
        title,
        posterUrl: row.logo || catalogRowPoster(catalogRow),
        backdropUrl: null,
        logoUrl: null,
      })
    }

    for (const [id, meta] of Object.entries(readWatchlist(playlistId, kind))) {
      const catalogRow = catalogById.get(id)
      const title = meta?.name || catalogRowTitle(catalogRow)
      if (!title) continue
      out.push({
        kind,
        id,
        title,
        posterUrl: meta?.logo || catalogRowPoster(catalogRow),
        backdropUrl: null,
        logoUrl: null,
      })
    }
  }
  return out
}

async function collectRecommendedCandidates(
  playlistId: string,
  vodRows: CatalogRow[],
  seriesRows: CatalogRow[]
): Promise<AmbientCandidate[]> {
  const pool = pickBecauseSeedPool(getWatchedSignals(playlistId, 20), 5)
  if (!pool.length) return []
  const catalogByKind = { vod: vodRows, series: seriesRows }

  const out: AmbientCandidate[] = []
  for (const seed of pool.slice(0, RECOMMENDED_SEED_COUNT)) {
    const catalog = catalogByKind[seed.kind]
    if (!catalog.length) continue
    const picks = buildBecauseRow(seed, catalog as LocalSimilarCandidate[], {
      limit: RECOMMENDED_PICKS_PER_SEED,
    })
    for (const pick of picks) {
      out.push({
        kind: seed.kind,
        id: String(pick.id),
        title: pick.name,
        posterUrl: pick.logo || null,
        backdropUrl: null,
        logoUrl: null,
      })
    }
  }
  return out
}

function collectCatalogCandidates(vodRows: CatalogRow[], seriesRows: CatalogRow[]): AmbientCandidate[] {
  const toCandidate = (kind: "vod" | "series", row: CatalogRow): AmbientCandidate => ({
    kind,
    id: String(row.id),
    title: catalogRowTitle(row),
    posterUrl: catalogRowPoster(row),
    backdropUrl: null,
    logoUrl: null,
  })
  return [
    ...vodRows.map((row) => toCandidate("vod", row)),
    ...seriesRows.map((row) => toCandidate("series", row)),
  ]
}

/** TMDb when its key is active, else the keyless TVDB proxy - never both. */
async function fetchTrendingPool(kind: "vod" | "series"): Promise<TrendingCandidate[]> {
  if (isTmdbActive()) {
    const items = await tmdbTrending(kind)
    return items.map((item) => ({ tmdbId: item.tmdbId, name: item.name, year: item.year }))
  }
  const entries = await fetchTvdbTrending(kind === "vod" ? "movie" : "series")
  return entries.map((entry) => ({ tmdbId: entry.tmdbId ?? null, name: entry.name, year: entry.year }))
}

// Trending must never block the manifest: any failure here just yields an empty
// pool, and the caller falls through to the existing watching/recent/catalog tiers.
async function collectTrendingCandidates(
  vodRows: CatalogRow[],
  seriesRows: CatalogRow[]
): Promise<AmbientCandidate[]> {
  try {
    const [moviePool, seriesPool] = await Promise.all([fetchTrendingPool("vod"), fetchTrendingPool("series")])
    const matchedMovies = matchTrendingToCatalog(moviePool, vodRows)
    const matchedSeries = matchTrendingToCatalog(seriesPool, seriesRows)

    const toCandidate = (kind: "vod" | "series", row: CatalogRow): AmbientCandidate => ({
      kind,
      id: String(row.id),
      title: catalogRowTitle(row),
      posterUrl: catalogRowPoster(row),
      backdropUrl: null,
      logoUrl: null,
    })

    const interleaved: AmbientCandidate[] = []
    const maxLength = Math.max(matchedMovies.length, matchedSeries.length)
    for (let index = 0; index < maxLength; index++) {
      if (matchedMovies[index]) interleaved.push(toCandidate("vod", matchedMovies[index]))
      if (matchedSeries[index]) interleaved.push(toCandidate("series", matchedSeries[index]))
    }
    return interleaved
  } catch (error) {
    log.warn("[xt:ambient] trending selection failed:", error)
    return []
  }
}

// Xtream vod/series info responses both nest the real payload under `info`
// (movies also accept `movie_data`); `backdrop_path` is a string on movies,
// an array on series.
function extractProviderBackdropPath(data: unknown): unknown {
  const record = data as { info?: { backdrop_path?: unknown }; movie_data?: { backdrop_path?: unknown } } | null
  return record?.info?.backdrop_path ?? record?.movie_data?.backdrop_path ?? null
}

async function providerBackdropsFor(
  playlistId: string,
  kind: "vod" | "series",
  ids: Set<string>
): Promise<Map<string, unknown>> {
  const backdropById = new Map<string, unknown>()
  if (!ids.size) return backdropById
  const kindPrefix = kind === "vod" ? "vod_info_" : "series_info_"
  const rows = await getCachedByKindPrefix(playlistId, kindPrefix)
  for (const row of rows) {
    const id = row.kind.slice(kindPrefix.length)
    if (ids.has(id)) backdropById.set(id, extractProviderBackdropPath(row.data))
  }
  return backdropById
}

async function fetchArtwork(
  playlistId: string,
  entry: AmbientEntry,
  catalogRow: CatalogRow | undefined
): Promise<TmdbTitleEnrichment | null> {
  return resolveTitleEnrichment({
    kind: entry.kind === "series" ? "series" : "movie",
    playlistId,
    itemId: entry.id,
    name: catalogRow?.name || entry.title,
    year: catalogRowYear(catalogRow),
    providerTmdbId: catalogRow?.tmdb ?? null,
  })
}

// The cache peek only sees titles some other screen already opened, so a manifest
// built from recommendations and catalog picks comes back almost entirely bare.
async function fillMissingArtwork(
  playlistId: string,
  entries: AmbientEntry[],
  vodById: Map<string, CatalogRow>,
  seriesById: Map<string, CatalogRow>
): Promise<AmbientEntry[]> {
  if (!isEnrichmentActive()) return entries
  const pending = entries
    .filter((entry) => !entry.backdropUrl || !entry.logoUrl)
    .slice(0, MAX_ARTWORK_FETCHES)
  if (!pending.length) return entries

  const filled = new Map<AmbientEntry, { backdropUrl?: string; logoUrl?: string }>()
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const entry = pending[cursor++]
      const byId = entry.kind === "vod" ? vodById : seriesById
      const enrichment = await fetchArtwork(playlistId, entry, byId.get(entry.id))
      if (!enrichment) continue
      const patch: { backdropUrl?: string; logoUrl?: string } = {}
      if (!entry.backdropUrl && enrichment.backdropUrl) patch.backdropUrl = enrichment.backdropUrl
      if (!entry.logoUrl && enrichment.logoUrl) patch.logoUrl = enrichment.logoUrl
      if (patch.backdropUrl || patch.logoUrl) filled.set(entry, patch)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BACKDROP_FETCH_CONCURRENCY, pending.length) }, () => worker())
  )
  log.info(`[xt:ambient] artwork fetch: ${filled.size}/${pending.length} resolved`)
  return entries.map((entry) => {
    const patch = filled.get(entry)
    return patch ? { ...entry, ...patch } : entry
  })
}

async function upgradeArtwork(playlistId: string, entries: AmbientEntry[]): Promise<AmbientEntry[]> {
  const vodIds = new Set(entries.filter((entry) => entry.kind === "vod").map((entry) => entry.id))
  const seriesIds = new Set(entries.filter((entry) => entry.kind === "series").map((entry) => entry.id))
  const [vodBackdropById, seriesBackdropById] = await Promise.all([
    providerBackdropsFor(playlistId, "vod", vodIds),
    providerBackdropsFor(playlistId, "series", seriesIds),
  ])

  return Promise.all(
    entries.map(async (entry) => {
      const enrichment = await getCachedTitleEnrichment(entry.kind, playlistId, entry.id)
      const backdropById = entry.kind === "vod" ? vodBackdropById : seriesBackdropById
      const providerBackdrop = sanitizeProviderBackdropUrl(backdropById.get(entry.id), entry.posterUrl)
      return {
        ...entry,
        posterUrl: enrichment?.posterUrl || entry.posterUrl,
        backdropUrl: enrichment?.backdropUrl || providerBackdrop || entry.backdropUrl,
        logoUrl: enrichment?.logoUrl || entry.logoUrl,
      }
    })
  )
}

export async function buildAmbientManifest(
  playlistId: string,
  options: { limit?: number } = {}
): Promise<AmbientEntry[]> {
  if (!playlistId) return []
  const limit = options.limit ?? DEFAULT_LIMIT

  await ensureLoaded()

  const [vodRows, seriesRows] = await Promise.all([
    loadCatalog(playlistId, "vod"),
    loadCatalog(playlistId, "series"),
  ])
  const vodById = indexCatalogById(vodRows)
  const seriesById = indexCatalogById(seriesRows)

  const trending = await collectTrendingCandidates(vodRows, seriesRows)
  const watching = collectWatchingCandidates(playlistId, vodById, seriesById)
  const recent = collectRecentCandidates(playlistId, vodById, seriesById)
  const recommended = await collectRecommendedCandidates(playlistId, vodRows, seriesRows)
  const catalog = collectCatalogCandidates(vodRows, seriesRows)

  const assembled = assembleAmbientEntries({
    trending,
    watching,
    recent,
    recommended,
    catalog,
    limit,
    random: Math.random,
  })

  const upgraded = await upgradeArtwork(playlistId, assembled)
  return fillMissingArtwork(playlistId, upgraded, vodById, seriesById)
}
