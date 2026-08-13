// Shared per-tab guard for the tmdb backfill (see rowsNeedTmdbBackfill in catalog-mappers.js).
import { cachedFetch, CACHE_REVALIDATED_EVENT } from "@/scripts/lib/cache.js"
import { log } from "@/scripts/lib/log.js"

const tmdbBackfillTriggered = new Set<string>()

export function triggerTmdbBackfillOnce(
  playlistId: string,
  kind: string,
  ttlMs: number,
  fetcher: () => Promise<unknown>
): void {
  const key = `${playlistId}:${kind}`
  if (tmdbBackfillTriggered.has(key)) return
  tmdbBackfillTriggered.add(key)
  cachedFetch(playlistId, kind, ttlMs, fetcher, { force: true })
    .then(() => {
      document.dispatchEvent(new CustomEvent(CACHE_REVALIDATED_EVENT, { detail: { entryId: playlistId, kind } }))
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : err
      log.warn("[xt:tmdb-backfill] backfill fetch failed:", kind, message)
    })
}
