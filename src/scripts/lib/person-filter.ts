// Resolves a cast/crew name to the set of catalog title ids it appears in,
// so a person chip on a detail page can filter the movies/series grid.
import { getCachedByKindPrefix } from "@/scripts/lib/cache.js"
import { parseProviderPeople, type LocalSimilarInfo } from "@/scripts/lib/similar-local.ts"
import { matchAllTitlesToCatalog, type TmdbCatalogEntry } from "@/scripts/lib/tmdb-match.ts"
import { fetchPersonTitles, type TmdbKind } from "@/scripts/lib/tmdb-enrich.ts"
import { isTmdbActive } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

function idFromCacheKind(kind: string): number | null {
  const match = kind.match(/(\d+)$/)
  if (!match) return null
  const id = Number(match[1])
  return Number.isFinite(id) ? id : null
}

/**
 * Pure: scans the vod_info_/series_info_ cache prefix scan for a case-insensitive
 * name match against cast or director, returning the matching catalog ids.
 */
export function titleIdsForPersonLocal(
  personName: string,
  cachedInfos: Array<{ kind: string; data: unknown }>,
  parse: (data: unknown) => LocalSimilarInfo
): Set<number> {
  const target = personName.trim().toLowerCase()
  const ids = new Set<number>()
  if (!target) return ids
  for (const { kind, data } of cachedInfos) {
    const id = idFromCacheKind(kind)
    if (id == null) continue
    const info = parse(data)
    const castMatch = info.castNames.some((name) => name.trim().toLowerCase() === target)
    const directorMatch = (info.directorName || "").trim().toLowerCase() === target
    if (castMatch || directorMatch) ids.add(id)
  }
  return ids
}

export function parseProviderPeopleFor(kind: TmdbKind, data: unknown): LocalSimilarInfo {
  const record = data as Record<string, unknown> | null | undefined
  const info = kind === "series" ? record?.info : record?.info || record?.movie_data || record
  return parseProviderPeople(info as Parameters<typeof parseProviderPeople>[0])
}

export interface ResolvePersonTitleIdsOptions {
  kind: TmdbKind
  playlistId: string
  personName: string
  tmdbPersonId?: number | null
  catalogEntries: TmdbCatalogEntry[]
}

/**
 * Union of the local cast/director graph and, when TMDb is active and a
 * tmdbPersonId is known, that person's full TMDb filmography matched against
 * the catalog. TMDb errors degrade silently to the local-only result.
 */
export async function resolvePersonTitleIds(
  options: ResolvePersonTitleIdsOptions
): Promise<Set<number>> {
  const { kind, playlistId, personName, tmdbPersonId, catalogEntries } = options
  const kindPrefix = kind === "series" ? "series_info_" : "vod_info_"
  const cachedInfos = playlistId ? await getCachedByKindPrefix(playlistId, kindPrefix) : []
  const ids = titleIdsForPersonLocal(personName, cachedInfos, (data) => parseProviderPeopleFor(kind, data))

  if (!isTmdbActive() || !tmdbPersonId) return ids

  try {
    const titles = await fetchPersonTitles(kind, tmdbPersonId)
    if (titles.length) {
      const matches = matchAllTitlesToCatalog(
        titles.map((title) => ({ title: title.title, year: title.year })),
        catalogEntries
      )
      for (const match of matches) {
        const id = Number(match.id)
        if (Number.isFinite(id)) ids.add(id)
      }
    }
  } catch (error) {
    log.warn("[xt:person-filter] tmdb filmography merge failed:", error)
  }

  return ids
}
