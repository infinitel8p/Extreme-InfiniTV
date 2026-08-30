// Pure trending-to-library matcher: intersects TMDb/TVDB trending picks with the provider catalog.
import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"

export interface TrendingCandidate {
  tmdbId: number | null
  name: string
  year: number | null
}

export interface TrendingCatalogRow {
  id: number | string
  name?: string
  year?: number | string | null
  tmdb?: number | null
}

function canonicalNameYearKey(name: string, explicitYear: number | null): string | null {
  const { variants, year: parsedYear } = cleanProviderTitle(name || "")
  const cleanedName = variants[0]?.toLowerCase()
  if (!cleanedName) return null
  const year = explicitYear ?? parsedYear
  return year ? `${cleanedName}:${year}` : cleanedName
}

/** Id match first, then cleaned name+year (no off-by-one year tolerance); trending order, deduped. */
export function matchTrendingToCatalog(
  trendingEntries: TrendingCandidate[],
  catalogRows: TrendingCatalogRow[]
): TrendingCatalogRow[] {
  const rowByTmdbId = new Map<number, TrendingCatalogRow>()
  const rowByNameYearKey = new Map<string, TrendingCatalogRow>()
  for (const row of catalogRows) {
    const tmdbId = Number(row.tmdb)
    if (Number.isInteger(tmdbId) && tmdbId > 0 && !rowByTmdbId.has(tmdbId)) {
      rowByTmdbId.set(tmdbId, row)
    }
    const key = canonicalNameYearKey(row.name || "", row.year != null ? Number(row.year) : null)
    if (key && !rowByNameYearKey.has(key)) rowByNameYearKey.set(key, row)
  }

  const matched: TrendingCatalogRow[] = []
  const seenRowIds = new Set<string>()
  for (const trending of trendingEntries) {
    let row = trending.tmdbId != null ? rowByTmdbId.get(trending.tmdbId) : undefined
    if (!row) {
      const key = canonicalNameYearKey(trending.name, trending.year)
      row = key ? rowByNameYearKey.get(key) : undefined
    }
    if (!row) continue
    const rowId = String(row.id)
    if (seenRowIds.has(rowId)) continue
    seenRowIds.add(rowId)
    matched.push(row)
  }
  return matched
}
