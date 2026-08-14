// Groups VOD/series catalog rows by title across language variants, keyed by TMDb id with a title fallback.
import { cleanProviderTitle } from "./tmdb-match"
import { normalize } from "./text"
import { parseNamePrefix, prefixQualityTokens } from "./language-tags"

export interface GroupableEntry {
  id: number
  name: string
  year?: string
  tmdb?: number | null
}

export interface GroupInfo {
  key: string
  entryIds: number[]
  tags: string[]
  multiVariant: boolean
}

export interface CatalogGroupingIndex {
  keyByEntryId: Map<number, string>
  tagByEntryId: Map<number, string | null>
  groupsByKey: Map<string, GroupInfo>
  qualityRankByEntryId: Map<number, number>
}

interface EntryMeta {
  tag: string | null
  tmdbKey: string | null
  titleKey: string
}

function computeTitleKey(entry: GroupableEntry): string {
  // Strip the prefix via parseNamePrefix first: it handles compound prefixes ("4K-FR - ") that cleanProviderTitle's regex does not.
  const { tag, rest } = parseNamePrefix(entry.name)
  const { variants, year } = cleanProviderTitle(tag != null ? rest : entry.name)
  const normalizedTitle = normalize(variants[0] || "")
  if (!normalizedTitle) return `e:${entry.id}`
  const resolvedYear = year != null ? String(year) : entry.year || ""
  return `${normalizedTitle}|${resolvedYear}`
}

function distinctTagsInOrder(entryIds: number[], tagByEntryId: Map<number, string | null>): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const entryId of entryIds) {
    const tag = tagByEntryId.get(entryId)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

export function buildGroupingIndex(entries: GroupableEntry[]): CatalogGroupingIndex {
  const keyByEntryId = new Map<number, string>()
  const tagByEntryId = new Map<number, string | null>()
  const groupsByKey = new Map<string, GroupInfo>()
  const qualityRankByEntryId = new Map<number, number>()

  const metaByEntryId = new Map<number, EntryMeta>()
  const tmdbGroupEntryIds = new Map<string, number[]>()
  const titleKeyToTmdbKeys = new Map<string, Set<string>>()

  for (const entry of entries) {
    const tag = parseNamePrefix(entry.name).tag
    const tmdbNumber = Number(entry.tmdb)
    const tmdbKey = tmdbNumber > 0 ? `t:${tmdbNumber}` : null
    const titleKey = computeTitleKey(entry)
    metaByEntryId.set(entry.id, { tag, tmdbKey, titleKey })
    tagByEntryId.set(entry.id, tag)
    qualityRankByEntryId.set(entry.id, prefixQualityTokens(entry.name).length)

    if (!tmdbKey) continue
    const tmdbBucket = tmdbGroupEntryIds.get(tmdbKey)
    if (tmdbBucket) tmdbBucket.push(entry.id)
    else tmdbGroupEntryIds.set(tmdbKey, [entry.id])

    const bridgedTmdbKeys = titleKeyToTmdbKeys.get(titleKey)
    if (bridgedTmdbKeys) bridgedTmdbKeys.add(tmdbKey)
    else titleKeyToTmdbKeys.set(titleKey, new Set([tmdbKey]))
  }

  // Merge non-tmdb entries into a tmdb group only when their title key bridges to exactly one tmdb id.
  const remainingEntryIds: number[] = []
  for (const [entryId, meta] of metaByEntryId) {
    if (meta.tmdbKey) continue
    const bridgedTmdbKeys = titleKeyToTmdbKeys.get(meta.titleKey)
    if (bridgedTmdbKeys && bridgedTmdbKeys.size === 1) {
      const [onlyTmdbKey] = bridgedTmdbKeys
      tmdbGroupEntryIds.get(onlyTmdbKey)!.push(entryId)
      continue
    }
    remainingEntryIds.push(entryId)
  }

  for (const [tmdbKey, entryIds] of tmdbGroupEntryIds) {
    const tags = distinctTagsInOrder(entryIds, tagByEntryId)
    groupsByKey.set(tmdbKey, { key: tmdbKey, entryIds, tags, multiVariant: entryIds.length > 1 })
    for (const entryId of entryIds) keyByEntryId.set(entryId, tmdbKey)
  }

  const titleBuckets = new Map<string, number[]>()
  for (const entryId of remainingEntryIds) {
    const titleKey = metaByEntryId.get(entryId)!.titleKey
    const bucket = titleBuckets.get(titleKey)
    if (bucket) bucket.push(entryId)
    else titleBuckets.set(titleKey, [entryId])
  }

  for (const [titleKey, entryIds] of titleBuckets) {
    const untaggedEntryIds = entryIds.filter((entryId) => tagByEntryId.get(entryId) == null)
    for (const entryId of untaggedEntryIds) {
      const key = `e:${entryId}`
      groupsByKey.set(key, { key, entryIds: [entryId], tags: [], multiVariant: false })
      keyByEntryId.set(entryId, key)
    }

    // Require 2+ DISTINCT tags (not just 2+ members) so same-language dupes don't merge.
    const taggedEntryIds = entryIds.filter((entryId) => tagByEntryId.get(entryId) != null)
    const distinctTags = distinctTagsInOrder(taggedEntryIds, tagByEntryId)
    if (distinctTags.length >= 2) {
      const key = `n:${titleKey}`
      groupsByKey.set(key, { key, entryIds: taggedEntryIds, tags: distinctTags, multiVariant: true })
      for (const entryId of taggedEntryIds) keyByEntryId.set(entryId, key)
    } else {
      for (const entryId of taggedEntryIds) {
        const key = `e:${entryId}`
        const tag = tagByEntryId.get(entryId) ?? null
        groupsByKey.set(key, { key, entryIds: [entryId], tags: tag ? [tag] : [], multiVariant: false })
        keyByEntryId.set(entryId, key)
      }
    }
  }

  return { keyByEntryId, tagByEntryId, groupsByKey, qualityRankByEntryId }
}

// Lowest quality rank (fewest quality tokens, so plain beats "4K") wins within a bucket.
function pickLowestQualityInBucket(
  bucket: number[],
  qualityRankByEntryId?: Map<number, number>
): number {
  if (!qualityRankByEntryId || bucket.length <= 1) return bucket[0]
  let best = bucket[0]
  let bestRank = qualityRankByEntryId.get(best) ?? 0
  for (let index = 1; index < bucket.length; index++) {
    const candidateId = bucket[index]
    const candidateRank = qualityRankByEntryId.get(candidateId) ?? 0
    if (candidateRank < bestRank) {
      best = candidateId
      bestRank = candidateRank
    }
  }
  return best
}

export function pickPreferredEntryId(
  entryIds: number[],
  tagByEntryId: Map<number, string | null>,
  preferredTags: string[],
  qualityRankByEntryId?: Map<number, number>
): number {
  for (const preferredTag of preferredTags) {
    const bucket = entryIds.filter((entryId) => tagByEntryId.get(entryId) === preferredTag)
    if (bucket.length) return pickLowestQualityInBucket(bucket, qualityRankByEntryId)
  }
  const untaggedBucket = entryIds.filter((entryId) => tagByEntryId.get(entryId) == null)
  if (untaggedBucket.length) return pickLowestQualityInBucket(untaggedBucket, qualityRankByEntryId)
  return pickLowestQualityInBucket(entryIds, qualityRankByEntryId)
}

export function groupPassesLanguageFilter(tags: string[], selected: string): boolean {
  if (!selected) return true
  if (!tags.length) return true
  return tags.includes(selected)
}

// Grouping a catalog is expensive (~800ms at 176k rows), so memoize per playlist and catalog reference.
export function createGroupingIndexMemo() {
  let cache: { playlistId: string | null; catalogRef: GroupableEntry[]; index: CatalogGroupingIndex } | null = null

  return function getGroupingIndexFor(playlistId: string | null, catalog: GroupableEntry[]): CatalogGroupingIndex {
    if (cache && cache.playlistId === playlistId && cache.catalogRef === catalog) {
      return cache.index
    }
    const index = buildGroupingIndex(catalog)
    cache = { playlistId, catalogRef: catalog, index }
    return index
  }
}
