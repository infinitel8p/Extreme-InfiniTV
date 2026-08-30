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

// Cached catalog rows go in as-is (ids and years arrive as strings or numbers), so no view has to copy them.
export interface GroupableRow {
  id: number | string
  name?: string | null
  year?: string | number | null
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

function computeTitleKey(
  entry: GroupableRow,
  entryId: number,
  name: string,
  prefix: { tag: string | null; rest: string }
): string {
  // Strip the prefix via parseNamePrefix first: it handles compound prefixes ("4K-FR - ") that cleanProviderTitle's regex does not.
  const { tag, rest } = prefix
  const { variants, year } = cleanProviderTitle(tag != null ? rest : name)
  const normalizedTitle = normalize(variants[0] || "")
  if (!normalizedTitle) return `e:${entryId}`
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

export function buildGroupingIndex(entries: GroupableRow[]): CatalogGroupingIndex {
  const keyByEntryId = new Map<number, string>()
  const tagByEntryId = new Map<number, string | null>()
  const groupsByKey = new Map<string, GroupInfo>()
  const qualityRankByEntryId = new Map<number, number>()

  const metaByEntryId = new Map<number, EntryMeta>()
  const tmdbGroupEntryIds = new Map<string, number[]>()
  const titleKeyToTmdbKeys = new Map<string, Set<string>>()

  for (const entry of entries) {
    const entryId = Number(entry.id)
    const name = entry.name || ""
    const prefix = parseNamePrefix(name)
    const tag = prefix.tag
    const tmdbNumber = Number(entry.tmdb)
    const tmdbKey = tmdbNumber > 0 ? `t:${tmdbNumber}` : null
    const titleKey = computeTitleKey(entry, entryId, name, prefix)
    metaByEntryId.set(entryId, { tag, tmdbKey, titleKey })
    tagByEntryId.set(entryId, tag)
    qualityRankByEntryId.set(entryId, prefixQualityTokens(name).length)

    if (!tmdbKey) continue
    const tmdbBucket = tmdbGroupEntryIds.get(tmdbKey)
    if (tmdbBucket) tmdbBucket.push(entryId)
    else tmdbGroupEntryIds.set(tmdbKey, [entryId])

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

export interface DisplayGroup<T> {
  key: string
  entries: T[]
  tags: string[]
  globalEntryIds: number[]
  displayEntry: T
}

/** Collapses grouped entries down to one display entry per group, picking the variant matching preferredTags. */
export function collapseIntoDisplayGroups<T extends { id: number }>(
  entries: T[],
  groupingIndex: CatalogGroupingIndex,
  preferredTags: string[]
): DisplayGroup<T>[] {
  const groupOrder: string[] = []
  const survivorsByKey = new Map<string, T[]>()
  for (const entry of entries) {
    const groupKey = groupingIndex.keyByEntryId.get(entry.id) ?? `e:${entry.id}`
    let survivors = survivorsByKey.get(groupKey)
    if (!survivors) {
      survivors = []
      survivorsByKey.set(groupKey, survivors)
      groupOrder.push(groupKey)
    }
    survivors.push(entry)
  }

  const displayGroups: DisplayGroup<T>[] = []
  for (const groupKey of groupOrder) {
    const survivors = survivorsByKey.get(groupKey)!
    const globalInfo = groupingIndex.groupsByKey.get(groupKey)
    const ownTag = groupingIndex.tagByEntryId.get(survivors[0].id) ?? null
    const tags = globalInfo ? globalInfo.tags : ownTag ? [ownTag] : []
    const globalEntryIds = globalInfo ? globalInfo.entryIds : [survivors[0].id]

    const survivorIds = survivors.map((entry) => entry.id)
    const displayEntryId = pickPreferredEntryId(
      survivorIds,
      groupingIndex.tagByEntryId,
      preferredTags,
      groupingIndex.qualityRankByEntryId
    )
    const displayEntry = survivors.find((entry) => entry.id === displayEntryId) || survivors[0]

    displayGroups.push({ key: groupKey, entries: survivors, tags, globalEntryIds, displayEntry })
  }

  return displayGroups
}

export function groupPassesLanguageFilter(tags: string[], selected: string): boolean {
  if (!selected) return true
  if (!tags.length) return true
  return tags.includes(selected)
}

// Grouping a catalog is expensive (~800ms at 176k rows), so memoize per playlist and catalog reference.
export function createGroupingIndexMemo() {
  let cache: { playlistId: string | null; catalogRef: GroupableRow[]; index: CatalogGroupingIndex } | null = null

  return function getGroupingIndexFor(playlistId: string | null, catalog: GroupableRow[]): CatalogGroupingIndex {
    if (cache && cache.playlistId === playlistId && cache.catalogRef === catalog) {
      return cache.index
    }
    const index = getSharedGroupingIndex(catalog)
    cache = { playlistId, catalogRef: catalog, index }
    return index
  }
}

const LANGUAGE_GROUPING_KEY = "xt_lang_grouping"

/** True only when the user explicitly opted in, distinct from the feature's default-on state. */
export function isLanguageGroupingExplicitlyEnabled(): boolean {
  try {
    return localStorage.getItem(LANGUAGE_GROUPING_KEY) === "1"
  } catch {
    return false
  }
}

const sharedIndexByRows = new WeakMap<object, CatalogGroupingIndex>()

/**
 * One index per catalog array identity, shared across views and navigations. The cached catalog
 * array is the key, so a refresh that replaces it drops the stale index with it.
 */
export function getSharedGroupingIndex(rows: GroupableRow[]): CatalogGroupingIndex {
  const cached = sharedIndexByRows.get(rows)
  if (cached) return cached
  const index = buildGroupingIndex(rows)
  sharedIndexByRows.set(rows, index)
  return index
}
