// Merges a local cast/director name index with TMDb person search.
import { getCachedByKindPrefix } from "@/scripts/lib/cache.js"
import { parseProviderPeopleFor } from "@/scripts/lib/person-filter.ts"
import { tmdbSearchPerson, type TmdbPersonResult } from "@/scripts/lib/tmdb.ts"
import { isTmdbActive } from "@/scripts/lib/app-settings.js"
import { normalize } from "@/scripts/lib/text.ts"
import type { TmdbKind } from "@/scripts/lib/tmdb-enrich.ts"

export interface PersonCandidate {
  name: string
  tmdbId: number | null
  profileUrl: string | null
  knownFor: string | null
  source: "local" | "tmdb" | "both"
}

const DEFAULT_LIMIT = 8

async function collectNamesForKind(
  playlistId: string,
  kind: TmdbKind,
  kindPrefix: string,
  names: Set<string>
): Promise<void> {
  const cachedInfos = await getCachedByKindPrefix(playlistId, kindPrefix)
  for (const { data } of cachedInfos) {
    const info = parseProviderPeopleFor(kind, data)
    for (const name of info.castNames) if (name) names.add(name)
    if (info.directorName) names.add(info.directorName)
  }
}

async function buildLocalNameIndex(playlistId: string): Promise<string[]> {
  const names = new Set<string>()
  await Promise.all([
    collectNamesForKind(playlistId, "vod", "vod_info_", names),
    collectNamesForKind(playlistId, "series", "series_info_", names),
  ])
  return [...names]
}

const localNameIndexCache = new Map<string, Promise<string[]>>()

function getLocalNameIndex(playlistId: string): Promise<string[]> {
  let cached = localNameIndexCache.get(playlistId)
  if (!cached) {
    cached = buildLocalNameIndex(playlistId)
    localNameIndexCache.set(playlistId, cached)
  }
  return cached
}

export function invalidateLocalPeople(playlistId: string): void {
  localNameIndexCache.delete(playlistId)
}

interface RankedCandidate extends PersonCandidate {
  matchIndex: number
  popularity: number
}

const SOURCE_RANK: Record<PersonCandidate["source"], number> = { both: 0, local: 1, tmdb: 2 }

/** Pure merge of local names and TMDb results, ranked and deduped by normalized full name. */
export function mergePeopleCandidates(
  localNames: string[],
  tmdbResults: TmdbPersonResult[],
  query: string,
  limit = DEFAULT_LIMIT
): PersonCandidate[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return []

  const byNormalizedName = new Map<string, RankedCandidate>()

  for (const name of localNames) {
    const normalizedName = normalize(name)
    const matchIndex = normalizedName.indexOf(normalizedQuery)
    if (matchIndex === -1 || byNormalizedName.has(normalizedName)) continue
    byNormalizedName.set(normalizedName, {
      name,
      tmdbId: null,
      profileUrl: null,
      knownFor: null,
      source: "local",
      matchIndex,
      popularity: 0,
    })
  }

  for (const result of tmdbResults) {
    const normalizedName = normalize(result.name)
    const matchIndex = normalizedName.indexOf(normalizedQuery)
    if (matchIndex === -1) continue
    const existing = byNormalizedName.get(normalizedName)
    if (existing) {
      existing.tmdbId = result.id
      existing.profileUrl = result.profileUrl
      existing.knownFor = result.knownFor
      existing.popularity = result.popularity
      existing.matchIndex = Math.min(existing.matchIndex, matchIndex)
      existing.source = "both"
    } else {
      byNormalizedName.set(normalizedName, {
        name: result.name,
        tmdbId: result.id,
        profileUrl: result.profileUrl,
        knownFor: result.knownFor,
        source: "tmdb",
        matchIndex,
        popularity: result.popularity,
      })
    }
  }

  const ranked = [...byNormalizedName.values()].sort((a, b) => {
    if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
    if (b.popularity !== a.popularity) return b.popularity - a.popularity
    return a.matchIndex - b.matchIndex
  })

  return ranked.slice(0, limit).map((candidate) => ({
    name: candidate.name,
    tmdbId: candidate.tmdbId,
    profileUrl: candidate.profileUrl,
    knownFor: candidate.knownFor,
    source: candidate.source,
  }))
}

export async function searchPeople(
  playlistId: string,
  query: string,
  limit = DEFAULT_LIMIT
): Promise<PersonCandidate[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const [localNames, tmdbResults] = await Promise.all([
    getLocalNameIndex(playlistId),
    isTmdbActive() ? tmdbSearchPerson(trimmed) : Promise.resolve([] as TmdbPersonResult[]),
  ])
  return mergePeopleCandidates(localNames, tmdbResults, trimmed, limit)
}
