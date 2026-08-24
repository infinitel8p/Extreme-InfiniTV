// Contextual next/prev for the cast remote: pure neighbor math plus impure resolvers
// that reuse the session's stashed live/series context to cast a new item on the same device.
import { log } from "@/scripts/lib/log.js"
import { getCastSession, type CastSession } from "@/scripts/lib/tv-cast.js"

export interface SeriesEpisodeEntry {
  season: number
  episodeNum: number
  id: string | number
  containerExt?: string | null
  title?: string | null
}

/** Wraps around a live-channel context; null when the list is too short to have a neighbor. */
export function neighborChannelIndex(
  context: { channelIds: string[]; index: number },
  direction: 1 | -1
): number | null {
  const total = context.channelIds.length
  if (total < 2) return null
  return (context.index + direction + total) % total
}

/** Ordered season/episode traversal, no wrap; null once past either end. */
export function neighborEpisode(
  episodes: Array<{ season: number; episodeNum: number }>,
  current: { season: number; episodeNum: number },
  direction: 1 | -1
): { season: number; episodeNum: number } | null {
  const ordered = [...episodes].sort((a, b) => a.season - b.season || a.episodeNum - b.episodeNum)
  const currentIndex = ordered.findIndex(
    (episode) => episode.season === current.season && episode.episodeNum === current.episodeNum
  )
  if (currentIndex === -1) return null
  const neighbor = ordered[currentIndex + direction]
  return neighbor ? { season: neighbor.season, episodeNum: neighbor.episodeNum } : null
}

/** Cheap enable/disable signal for the remote's prev/next buttons; series is optimistic until the episode list loads. */
export function neighborAvailability(session: CastSession | null): { previous: boolean; next: boolean } {
  if (!session) return { previous: false, next: false }
  if (session.liveContext) {
    const hasNeighbor = session.liveContext.channelIds.length >= 2
    return { previous: hasNeighbor, next: hasNeighbor }
  }
  if (session.seriesContext) return { previous: true, next: true }
  return { previous: false, next: false }
}

/** Flattens a get_series_info payload's `episodes` field (array or season-keyed object) into a season/episode list. */
export function flattenSeriesEpisodes(seriesInfo: unknown): SeriesEpisodeEntry[] {
  const episodes = (seriesInfo as { episodes?: unknown } | null)?.episodes
  const entries: SeriesEpisodeEntry[] = []
  const pushEntry = (episode: any, seasonFallback: string) => {
    const season = Number(episode?.season ?? seasonFallback)
    const episodeNum = Number(episode?.episode_num)
    if (!Number.isFinite(season) || !Number.isFinite(episodeNum)) return
    entries.push({
      season,
      episodeNum,
      id: episode.id,
      containerExt: episode.container_extension ?? null,
      title: episode.title ?? null,
    })
  }
  if (Array.isArray(episodes)) {
    for (const episode of episodes) pushEntry(episode, "1")
  } else if (episodes && typeof episodes === "object") {
    for (const [seasonKey, seasonEpisodes] of Object.entries(episodes as Record<string, unknown>)) {
      if (!Array.isArray(seasonEpisodes)) continue
      for (const episode of seasonEpisodes) pushEntry(episode, seasonKey)
    }
  }
  return entries
}

export interface SeriesNextUpResult {
  episodeId: string | number
  containerExt: string | null
  season: number
  episodeNum: number
  title: string | null
  resumeSeconds: number
}

function findEpisodeEntry(
  episodes: SeriesEpisodeEntry[],
  season: number,
  episodeNum: number
): SeriesEpisodeEntry | null {
  return episodes.find((episode) => episode.season === season && episode.episodeNum === episodeNum) ?? null
}

function toNextUpResult(entry: SeriesEpisodeEntry, resumeSeconds: number): SeriesNextUpResult {
  return {
    episodeId: entry.id,
    containerExt: entry.containerExt ?? null,
    season: entry.season,
    episodeNum: entry.episodeNum,
    title: entry.title ?? null,
    resumeSeconds,
  }
}

/**
 * Resolves the episode a series should resume from: the first episode when nothing is watched yet,
 * the in-progress episode at its saved position, or the episode following a completed one.
 */
export async function resolveSeriesNextUp(
  playlistId: string,
  seriesId: string | number
): Promise<SeriesNextUpResult | null> {
  const { requestSeriesInfo } = await import("@/scripts/lib/series-seasons.js")
  const data = await requestSeriesInfo(playlistId, seriesId)
  const episodes = flattenSeriesEpisodes(data)
  if (!episodes.length) return null
  const ordered = [...episodes].sort((a, b) => a.season - b.season || a.episodeNum - b.episodeNum)

  const { getSeriesProgressSummary } = await import("@/scripts/lib/preferences.js")
  const summary = getSeriesProgressSummary(playlistId, seriesId)
  const lastSeason = summary?.lastSeason
  const lastEpisodeNum = summary?.lastEpisodeNum
  if (!summary || !Number.isFinite(lastSeason) || !Number.isFinite(lastEpisodeNum)) {
    return toNextUpResult(ordered[0], 0)
  }

  const lastEntry = findEpisodeEntry(ordered, lastSeason as number, lastEpisodeNum as number)
  if (!summary.lastWatched.completed) {
    return lastEntry ? toNextUpResult(lastEntry, summary.lastWatched.position || 0) : toNextUpResult(ordered[0], 0)
  }

  const neighbor = neighborEpisode(ordered, { season: lastSeason as number, episodeNum: lastEpisodeNum as number }, 1)
  const neighborEntry = neighbor ? findEpisodeEntry(ordered, neighbor.season, neighbor.episodeNum) : null
  if (neighborEntry) return toNextUpResult(neighborEntry, 0)

  return lastEntry ? toNextUpResult(lastEntry, 0) : toNextUpResult(ordered[0], 0)
}

async function castLiveNeighbor(session: CastSession, direction: 1 | -1): Promise<boolean> {
  const liveContext = session.liveContext
  if (!liveContext) return false
  const nextIndex = neighborChannelIndex(liveContext, direction)
  if (nextIndex == null) return false
  const { castLiveChannel } = await import("@/scripts/lib/tv-cast-live.js")
  return castLiveChannel(liveContext.playlistId, liveContext.channelIds[nextIndex], {
    liveContext: { ...liveContext, index: nextIndex },
  })
}

async function castSeriesNeighbor(session: CastSession, direction: 1 | -1): Promise<boolean> {
  const seriesContext = session.seriesContext
  if (!seriesContext) return false

  const { loadSeriesEpisodes, castSeriesEpisode } = await import("@/scripts/lib/tv-cast-episode.js")
  const episodes = await loadSeriesEpisodes(seriesContext.playlistId, seriesContext.seriesId)
  const current = { season: seriesContext.season, episodeNum: seriesContext.episodeNum }
  const neighbor = neighborEpisode(episodes, current, direction)
  if (!neighbor) return false
  const entry = episodes.find(
    (episode) => episode.season === neighbor.season && episode.episodeNum === neighbor.episodeNum
  )
  if (!entry) return false

  return castSeriesEpisode(seriesContext.playlistId, seriesContext.seriesId, neighbor.season, neighbor.episodeNum, {
    entry,
  })
}

/** Casts the contextual next/prev item on the session's device. Never throws; false on any failure. */
export async function castNeighbor(direction: 1 | -1): Promise<boolean> {
  const session = getCastSession()
  if (!session) return false
  try {
    if (session.liveContext) return await castLiveNeighbor(session, direction)
    if (session.seriesContext) return await castSeriesNeighbor(session, direction)
    return false
  } catch (err) {
    log.warn("[xt:tv-cast-next] castNeighbor failed:", err)
    return false
  }
}

/**
 * Pure decision: auto-advance only for a non-live series session moving into "ended", after real
 * playback ("playing"/"paused") was already observed earlier in the same feed subscription - guards
 * against the stale "ended" snapshot a freshly (re)connected feed can push as its first frame.
 */
export function shouldAutoAdvance(
  session: CastSession | null,
  nextStateValue: string,
  sawPlaybackInSubscription: boolean
): boolean {
  if (!session?.seriesContext || session.isLive) return false
  return nextStateValue === "ended" && sawPlaybackInSubscription
}

export interface AutoAdvanceTracker {
  /** Feed each cast-state frame; returns true at most once per "ended" run. */
  observe(session: CastSession | null, stateValue: string): boolean
}

/** Tracks "saw playback" across a feed subscription and dedupes repeats of the same "ended" run. */
export function createAutoAdvanceTracker(): AutoAdvanceTracker {
  let sawPlayback = false
  let advancedForCurrentEnded = false
  return {
    observe(session, stateValue) {
      if (stateValue === "playing" || stateValue === "paused") {
        sawPlayback = true
        advancedForCurrentEnded = false
        return false
      }
      if (advancedForCurrentEnded) return false
      const advance = shouldAutoAdvance(session, stateValue, sawPlayback)
      if (advance) advancedForCurrentEnded = true
      return advance
    },
  }
}

/** Async refinement of neighborAvailability for series, once the episode list is known. */
export async function resolveNeighborAvailability(
  session: CastSession | null
): Promise<{ previous: boolean; next: boolean }> {
  if (!session) return { previous: false, next: false }
  if (!session.seriesContext) return neighborAvailability(session)
  try {
    const { requestSeriesInfo } = await import("@/scripts/lib/series-seasons.js")
    const data = await requestSeriesInfo(session.seriesContext.playlistId, session.seriesContext.seriesId)
    const episodes = flattenSeriesEpisodes(data)
    const current = { season: session.seriesContext.season, episodeNum: session.seriesContext.episodeNum }
    return {
      previous: neighborEpisode(episodes, current, -1) !== null,
      next: neighborEpisode(episodes, current, 1) !== null,
    }
  } catch {
    return neighborAvailability(session)
  }
}
