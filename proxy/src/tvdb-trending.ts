// Pure merge/normalize for /v1/trending: two score-desc filter pages -> ranked entries.
import type { TvdbTrendingEntry } from "@/scripts/lib/tvdb-contract"
import type { TvdbFilterRecord } from "./tvdb"

const ARTWORK_HOST = "https://artworks.thetvdb.com"
const TRENDING_CAP = 40

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function imageUrl(value: unknown): string | null {
  const raw = cleanText(value)
  if (/^https:\/\//i.test(raw)) return raw
  return /^\/[^/]/.test(raw) ? `${ARTWORK_HOST}${raw}` : null
}

function parseYear(value: TvdbFilterRecord["year"]): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 1800 && parsed < 2200 ? parsed : null
}

// Base filter records carry no remoteIds today; kept in case upstream ever adds them.
function tmdbIdFromRemoteIds(remoteIds: TvdbFilterRecord["remoteIds"]): number | undefined {
  const match = (remoteIds || []).find((remote) =>
    cleanText(remote?.sourceName).toLowerCase().includes("themoviedb")
  )
  const parsed = Number(match?.id)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function normalizeTrendingRecord(record: TvdbFilterRecord): TvdbTrendingEntry | null {
  const tvdbId = Number(record?.id)
  const name = cleanText(record?.name)
  if (!Number.isInteger(tvdbId) || tvdbId <= 0 || !name) return null
  const tmdbId = tmdbIdFromRemoteIds(record.remoteIds)
  return {
    tvdbId,
    ...(tmdbId != null ? { tmdbId } : {}),
    name,
    year: parseYear(record.year),
    posterUrl: imageUrl(record.image),
    score: Number(record?.score ?? 0),
  }
}

/** Union of this-year + last-year score-desc pages, deduped by id, capped. */
export function mergeTrendingRecords(
  currentYearRecords: TvdbFilterRecord[] | null,
  previousYearRecords: TvdbFilterRecord[] | null
): TvdbTrendingEntry[] {
  const byTvdbId = new Map<number, TvdbTrendingEntry>()
  for (const record of [...(currentYearRecords || []), ...(previousYearRecords || [])]) {
    const normalized = normalizeTrendingRecord(record)
    if (!normalized) continue
    const existing = byTvdbId.get(normalized.tvdbId)
    if (!existing || normalized.score > existing.score) byTvdbId.set(normalized.tvdbId, normalized)
  }
  return Array.from(byTvdbId.values())
    .sort((first, second) => second.score - first.score)
    .slice(0, TRENDING_CAP)
}
