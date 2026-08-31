// Tunes one series episode on the device an existing cast session is already using.
// Shared by the remote's prev/next episode walk and its episode picker, mirroring
// tv-cast-live.ts for live channels.
import { log } from "@/scripts/lib/log.js"
import { getCastSession, sessionAsDevice, castPlay, updateCastSession, type CastSession } from "@/scripts/lib/tv-cast.js"
import { isCastableSrc, buildVodCastDescriptor } from "@/scripts/lib/tv-cast-descriptor.js"
import { resolvePlaylistCreds } from "@/scripts/lib/tv-cast-live.js"
import { flattenSeriesEpisodes, type SeriesEpisodeEntry } from "@/scripts/lib/tv-cast-next.js"

/** Season/episode list for a series, ordered and deduped. Empty when the provider has nothing. */
export async function loadSeriesEpisodes(playlistId: string, seriesId: string | number): Promise<SeriesEpisodeEntry[]> {
  try {
    const { requestSeriesInfo } = await import("@/scripts/lib/series-seasons.js")
    const data = await requestSeriesInfo(playlistId, seriesId)
    return flattenSeriesEpisodes(data).sort((first, second) => first.season - second.season || first.episodeNum - second.episodeNum)
  } catch (err) {
    log.warn("[xt:tv-cast-episode] episode list load failed:", err)
    return []
  }
}

export interface CastSeriesEpisodeOptions {
  /** Already-resolved entry, when the caller has the episode list in hand. */
  entry?: SeriesEpisodeEntry | null
  resumeSeconds?: number
}

/**
 * Casts one episode of the session's series on its current device. Never throws; false on any failure.
 * The receiver swaps streams in place, so this holds no extra provider connection.
 */
export async function castSeriesEpisode(
  playlistId: string,
  seriesId: string,
  season: number,
  episodeNum: number,
  options: CastSeriesEpisodeOptions = {}
): Promise<boolean> {
  const session: CastSession | null = getCastSession()
  if (!session) return false

  try {
    let entry = options.entry ?? null
    if (!entry) {
      const episodes = await loadSeriesEpisodes(playlistId, seriesId)
      entry = episodes.find((episode) => episode.season === season && episode.episodeNum === episodeNum) ?? null
    }
    if (!entry) return false

    const creds = await resolvePlaylistCreds(playlistId)
    if (!creds?.host || !creds.user || !creds.pass) return false

    const { buildSeriesStreamUrl } = await import("@/scripts/lib/stream-urls.js")
    const src = buildSeriesStreamUrl(creds, entry.id, entry.containerExt)
    if (!isCastableSrc(src)) return false

    const title = entry.title || `S${season}E${episodeNum}`
    const descriptor = buildVodCastDescriptor({
      src,
      title,
      logo: session.logo,
      resumeSeconds: options.resumeSeconds || 0,
    })
    await castPlay(sessionAsDevice(session), descriptor, {
      seriesContext: { playlistId, seriesId, season, episodeNum },
    })
    if (session.contentHref) updateCastSession({ contentHref: session.contentHref })
    return true
  } catch (err) {
    log.warn("[xt:tv-cast-episode] castSeriesEpisode failed:", err)
    return false
  }
}
