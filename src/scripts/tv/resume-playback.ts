// Resolves and starts playback directly for a Continue Watching row, so the home
// rail/hero resumes in place instead of routing through the detail page first.
import { playVod, playEpisode, type TvPlaybackEvents } from "@/scripts/tv/playback"
import { resolveSeriesNextUp } from "@/scripts/lib/tv-cast-next.ts"
import { getCached } from "@/scripts/lib/cache.js"
import { log } from "@/scripts/lib/log.js"

export interface ContinueWatchingRow {
  kind: "vod" | "episode"
  id: string | number
  position?: number
  name?: string
  logo?: string | null
  seriesId?: string | number
  seriesName?: string
  seriesLogo?: string | null
}

function cachedVodContainerExt(playlistId: string, movieId: string | number): string | null {
  const data = getCached(playlistId, `vod_info_${movieId}`)?.data as any
  const ext = data?.movie_data?.container_extension || data?.info?.container_extension
  return typeof ext === "string" && ext ? ext : null
}

async function resumeVod(playlistId: string, row: ContinueWatchingRow, events: TvPlaybackEvents): Promise<boolean> {
  const catalog = (getCached(playlistId, "vod")?.data || []) as Array<{
    id: number | string
    name?: string
    logo?: string | null
  }>
  const movie = catalog.find((entry) => String(entry.id) === String(row.id))
  return playVod(
    {
      playlistId,
      movieId: row.id,
      title: row.name || movie?.name || String(row.id),
      logo: row.logo ?? movie?.logo ?? null,
      containerExt: cachedVodContainerExt(playlistId, row.id),
      resumeSeconds: row.position || 0,
    },
    events
  )
}

async function resumeEpisode(playlistId: string, row: ContinueWatchingRow, events: TvPlaybackEvents): Promise<boolean> {
  if (row.seriesId == null) return false
  const nextUp = await resolveSeriesNextUp(playlistId, row.seriesId)
  if (!nextUp) return false
  return playEpisode(
    {
      playlistId,
      seriesId: row.seriesId,
      season: nextUp.season,
      episodeNum: nextUp.episodeNum,
      episodeId: nextUp.episodeId,
      title: nextUp.title || row.name || "",
      seriesName: row.seriesName || "",
      logo: row.seriesLogo ?? null,
      containerExt: nextUp.containerExt,
      resumeSeconds: nextUp.resumeSeconds,
    },
    events
  )
}

/** Resumes a Continue Watching row directly; false on any resolution failure (caller falls back to the detail href). */
export async function resumeContinueWatchingRow(
  playlistId: string,
  row: ContinueWatchingRow,
  events: TvPlaybackEvents = {}
): Promise<boolean> {
  try {
    return row.kind === "vod" ? await resumeVod(playlistId, row, events) : await resumeEpisode(playlistId, row, events)
  } catch (err) {
    log.warn("[xt:tv-resume] resume playback failed:", err)
    return false
  }
}
