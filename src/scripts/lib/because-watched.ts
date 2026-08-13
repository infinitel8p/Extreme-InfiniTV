import { parseNamePrefix, effectivePreferredTags } from "@/scripts/lib/language-tags.ts"
import { getContentLanguage } from "@/scripts/lib/app-settings.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { normalize } from "@/scripts/lib/text.ts"
import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"
import {
  pickLocalSimilar,
  type LocalSimilarCandidate,
  type LocalSimilarCurrent,
  type LocalSimilarInfo,
} from "@/scripts/lib/similar-local.ts"

export interface WatchedSignal {
  kind: "vod" | "episode"
  id: string | number
  name?: string | null
  seriesId?: string | number | null
  seriesName?: string | null
  updatedAt?: number
  completed?: boolean
}

export interface BecauseSeed {
  kind: "vod" | "series"
  id: number
  name: string
  updatedAt: number
}

function normalizeSignal(signal: WatchedSignal): BecauseSeed | null {
  const updatedAt = signal.updatedAt ?? 0
  if (signal.kind === "vod") {
    const id = Number(signal.id)
    if (!Number.isFinite(id)) return null
    const name = signal.name?.trim()
    if (!name) return null
    return { kind: "vod", id, name, updatedAt }
  }
  if (signal.kind === "episode") {
    const id = Number(signal.seriesId)
    if (!Number.isFinite(id)) return null
    const name = signal.seriesName?.trim()
    if (!name) return null
    return { kind: "series", id, name, updatedAt }
  }
  return null
}

export function seedKey(seed: BecauseSeed): string {
  return `${seed.kind}:${seed.id}`
}

export function pickBecauseSeedPool(signals: WatchedSignal[], poolSize = 5): BecauseSeed[] {
  const bestByKey = new Map<string, BecauseSeed>()

  for (const signal of signals) {
    const seed = normalizeSignal(signal)
    if (!seed) continue
    const key = seedKey(seed)
    const existing = bestByKey.get(key)
    if (!existing || seed.updatedAt > existing.updatedAt) bestByKey.set(key, seed)
  }

  return [...bestByKey.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, poolSize)
}

export function pickNextSeed(pool: BecauseSeed[], lastShownKey: string | null): BecauseSeed | null {
  if (!pool.length) return null
  const lastIndex = lastShownKey ? pool.findIndex((seed) => seedKey(seed) === lastShownKey) : -1
  if (lastIndex === -1) return pool[0]
  return pool[(lastIndex + 1) % pool.length]
}

export interface BecauseRowOptions {
  limit?: number
  infoLookup?: (id: number | string) => LocalSimilarInfo | null
  isWatched?: (id: number | string) => boolean
}

// Groups language-prefixed variants of the same title so they dedupe together.
function groupKeyForEntry(candidate: LocalSimilarCandidate): string {
  const cleaned = cleanProviderTitle(candidate.name)
  const titleKey = normalize(cleaned.variants[0] || candidate.name)
  if (!titleKey) return `id:${candidate.id}`
  const year = candidate.year ?? cleaned.year
  return `${titleKey}|${year ?? ""}`
}

export function buildBecauseRow(
  seed: BecauseSeed,
  catalog: LocalSimilarCandidate[],
  options: BecauseRowOptions = {}
): LocalSimilarCandidate[] {
  const { limit, infoLookup, isWatched } = options
  const seedEntry = catalog.find((entry) => String(entry.id) === String(seed.id))
  if (!seedEntry) return []

  const seedInfo = infoLookup?.(seed.id)
  const current: LocalSimilarCurrent = {
    id: seed.id,
    category: seedEntry.category ?? null,
    castNames: seedInfo?.castNames ?? [],
    directorName: seedInfo?.directorName ?? null,
  }

  const candidates = catalog.filter((entry) => {
    if (String(entry.id) === String(seed.id)) return false
    if (isWatched?.(entry.id)) return false
    return true
  })

  return pickLocalSimilar(current, candidates, {
    limit,
    infoLookup,
    sourcePrefix: parseNamePrefix(seed.name).tag,
    preferredTags: effectivePreferredTags(getContentLanguage(), getActiveLocale()),
    groupKeyForEntry,
  })
}
