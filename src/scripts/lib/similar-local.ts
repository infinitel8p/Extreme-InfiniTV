// Local "more like this" heuristic used when TMDb is inactive, unresolved, or has no matches.
import { parseNamePrefix, pickByTagPreference } from "@/scripts/lib/language-tags.ts"

export interface LocalSimilarCurrent {
  id: number
  category: string | null
  castNames: string[]
  directorName: string | null
}

export interface LocalSimilarCandidate {
  id: number | string
  name: string
  year?: number | string | null
  category?: string | null
  rating?: unknown
  logo?: string | null
}

export interface LocalSimilarInfo {
  castNames: string[]
  directorName: string | null
}

export interface PickLocalSimilarOptions {
  limit?: number
  infoLookup?: (id: number | string) => LocalSimilarInfo | null
  sourcePrefix?: string | null
  preferredTags?: string[]
  groupKeyForEntry?: (candidate: LocalSimilarCandidate) => string
}

const CAST_OVERLAP_CAP = 3 // 2 points each, so this caps the cast bonus at 6

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

// Prefers sourcePrefix's language, then each preferredTags entry in order, then the unprefixed variant.
function pickBestVariant(
  group: LocalSimilarCandidate[],
  sourcePrefix: string | null | undefined,
  preferredTags: string[]
): LocalSimilarCandidate {
  if (group.length === 1) return group[0]
  const getTag = (candidate: LocalSimilarCandidate) => parseNamePrefix(candidate.name).tag
  return pickByTagPreference(group, getTag, { sourcePrefix, preferredTags }) || group[0]
}

function dedupeByGroupKey(
  candidates: LocalSimilarCandidate[],
  groupKeyForEntry: (candidate: LocalSimilarCandidate) => string,
  sourcePrefix: string | null | undefined,
  preferredTags: string[]
): LocalSimilarCandidate[] {
  const groups = new Map<string, LocalSimilarCandidate[]>()
  for (const candidate of candidates) {
    const key = groupKeyForEntry(candidate)
    const bucket = groups.get(key)
    if (bucket) bucket.push(candidate)
    else groups.set(key, [candidate])
  }
  return [...groups.values()].map((group) => pickBestVariant(group, sourcePrefix, preferredTags))
}

export function pickLocalSimilar(
  current: LocalSimilarCurrent,
  candidates: LocalSimilarCandidate[],
  options: PickLocalSimilarOptions = {}
): LocalSimilarCandidate[] {
  const { limit = 12, infoLookup, sourcePrefix, preferredTags = [], groupKeyForEntry } = options
  const currentCategory = current.category?.trim() || ""
  const currentDirector = current.directorName ? normalizeName(current.directorName) : ""
  const currentCastNames = new Set(current.castNames.map(normalizeName).filter(Boolean))

  const eligibleCandidates = candidates.filter((candidate) => Number(candidate.id) !== current.id)
  const pool = groupKeyForEntry
    ? dedupeByGroupKey(eligibleCandidates, groupKeyForEntry, sourcePrefix, preferredTags)
    : eligibleCandidates

  const scored: Array<{ candidate: LocalSimilarCandidate; score: number }> = []

  for (const candidate of pool) {
    const candidateCategory = candidate.category?.trim() || ""
    const info = infoLookup ? infoLookup(candidate.id) : null
    const candidateDirector = info?.directorName ? normalizeName(info.directorName) : ""
    const candidateCastNames = info?.castNames?.map(normalizeName).filter(Boolean) || []

    const sameCategory = !!currentCategory && currentCategory === candidateCategory
    const directorMatch = !!currentDirector && currentDirector === candidateDirector
    let castOverlap = 0
    for (const castName of candidateCastNames) {
      if (currentCastNames.has(castName)) castOverlap++
    }
    const cappedCastOverlap = Math.min(castOverlap, CAST_OVERLAP_CAP)

    if (!sameCategory && !directorMatch && cappedCastOverlap === 0) continue

    const score = (sameCategory ? 1 : 0) + (directorMatch ? 3 : 0) + cappedCastOverlap * 2
    scored.push({ candidate, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ratingA = Number(a.candidate.rating) || 0
    const ratingB = Number(b.candidate.rating) || 0
    if (ratingB !== ratingA) return ratingB - ratingA
    return (a.candidate.name || "").localeCompare(b.candidate.name || "")
  })

  return scored.slice(0, limit).map((entry) => entry.candidate)
}

export interface ProviderPeopleInfo {
  cast?: string
  actors?: string
  director?: string
}

export function parseProviderPeople(
  info: ProviderPeopleInfo | null | undefined
): LocalSimilarInfo {
  if (!info) return { castNames: [], directorName: null }
  const castField = info.cast || info.actors || ""
  const castNames = castField
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  const directorName = (info.director || "").split(",")[0]?.trim() || null
  return { castNames, directorName }
}
