// Contextual next/prev for the cast remote: pure neighbor math plus impure resolvers
// that reuse the session's stashed live/series context to cast a new item on the same device.
import { log } from "@/scripts/lib/log.js"
import {
  getCastSession,
  sessionAsDevice,
  castPlay,
  updateCastSession,
  type CastSession,
} from "@/scripts/lib/tv-cast.js"
import { isCastableSrc, buildLiveCastDescriptor, buildVodCastDescriptor } from "@/scripts/lib/tv-cast-descriptor.js"

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

async function resolveXtreamCreds(playlistId: string) {
  const { getState, entryToCreds } = await import("@/scripts/lib/creds.js")
  const state = await getState()
  const entry = (state.entries || []).find((candidate: any) => candidate?._id === playlistId)
  return entry ? entryToCreds(entry) : null
}

async function castLiveNeighbor(session: CastSession, direction: 1 | -1): Promise<boolean> {
  const liveContext = session.liveContext
  if (!liveContext) return false
  const nextIndex = neighborChannelIndex(liveContext, direction)
  if (nextIndex == null) return false
  const channelId = liveContext.channelIds[nextIndex]

  const { getCached } = await import("@/scripts/lib/cache.js")
  const liveList = getCached(liveContext.playlistId, "live")?.data || []
  const channel = liveList.find((item: any) => String(item?.id) === String(channelId))
  if (!channel) return false

  const creds = await resolveXtreamCreds(liveContext.playlistId)
  const hasXtreamCreds = !!(creds?.host && creds.user && creds.pass)
  let src: string | null = channel.url || null
  if (!src && hasXtreamCreds) {
    const { buildLiveStreamUrl } = await import("@/scripts/lib/stream-urls.js")
    src = buildLiveStreamUrl(creds!, channelId, creds!.liveContainer || null)
  }
  if (!src || !isCastableSrc(src)) return false

  const headers =
    channel.userAgent || channel.referer
      ? { userAgent: channel.userAgent || null, referer: channel.referer || null }
      : undefined
  const drm =
    channel.manifestType || channel.licenseKey
      ? {
          manifestType: channel.manifestType || null,
          drmScheme: channel.drmScheme || null,
          licenseKey: channel.licenseKey || null,
        }
      : undefined

  const descriptor = buildLiveCastDescriptor({
    src,
    title: channel.name || "",
    logo: channel.logo || undefined,
    drm,
    headers,
  })
  await castPlay(sessionAsDevice(session), descriptor, { liveContext: { ...liveContext, index: nextIndex } })
  updateCastSession({ contentHref: `/livetv?channel=${channelId}` })
  return true
}

async function castSeriesNeighbor(session: CastSession, direction: 1 | -1): Promise<boolean> {
  const seriesContext = session.seriesContext
  if (!seriesContext) return false

  const { requestSeriesInfo } = await import("@/scripts/lib/series-seasons.js")
  const data = await requestSeriesInfo(seriesContext.playlistId, seriesContext.seriesId)
  const episodes = flattenSeriesEpisodes(data)
  const current = { season: seriesContext.season, episodeNum: seriesContext.episodeNum }
  const neighbor = neighborEpisode(episodes, current, direction)
  if (!neighbor) return false
  const episodeEntry = episodes.find(
    (episode) => episode.season === neighbor.season && episode.episodeNum === neighbor.episodeNum
  )
  if (!episodeEntry) return false

  const creds = await resolveXtreamCreds(seriesContext.playlistId)
  if (!creds?.host || !creds.user || !creds.pass) return false

  const { buildSeriesStreamUrl } = await import("@/scripts/lib/stream-urls.js")
  const src = buildSeriesStreamUrl(creds, episodeEntry.id, episodeEntry.containerExt)
  if (!isCastableSrc(src)) return false

  const title = episodeEntry.title || `S${neighbor.season}E${neighbor.episodeNum}`
  const descriptor = buildVodCastDescriptor({ src, title, logo: session.logo, resumeSeconds: 0 })
  await castPlay(sessionAsDevice(session), descriptor, {
    seriesContext: { ...seriesContext, season: neighbor.season, episodeNum: neighbor.episodeNum },
  })
  if (session.contentHref) updateCastSession({ contentHref: session.contentHref })
  return true
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
