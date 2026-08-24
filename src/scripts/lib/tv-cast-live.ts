// Tunes one live channel on the device an existing cast session is already using.
// Shared by the remote's prev/next neighbour walk and its channel-list panel, so
// src resolution, per-channel headers, and DRM passthrough live in one place.
import { log } from "@/scripts/lib/log.js"
import {
  getCastSession,
  sessionAsDevice,
  castPlay,
  updateCastSession,
  buildLiveCastContext,
  type CastSession,
} from "@/scripts/lib/tv-cast.js"
import { isCastableSrc, buildLiveCastDescriptor } from "@/scripts/lib/tv-cast-descriptor.js"

export interface CastLiveChannelOptions {
  /** Channel ids of the list the channel was picked from, used when the session context has to be rebuilt. */
  groupChannelIds?: string[]
  /** Explicit context to store instead of resolving one; the neighbour walk passes its own. */
  liveContext?: CastSession["liveContext"]
}

/** Stored creds for any playlist id, not just the active one. */
export async function resolvePlaylistCreds(playlistId: string): Promise<any | null> {
  const { getEntries, entryToCreds } = await import("@/scripts/lib/creds.js")
  const entry = (await getEntries()).find((candidate: any) => candidate?._id === playlistId)
  return entry ? entryToCreds(entry) : null
}

/**
 * Keeps the session's own channel list when it already contains the tuned channel (so prev/next
 * still walks whatever Live TV was filtered to at cast time), and only falls back to the browsed
 * group when the channel came from outside that list.
 */
export function resolveTunedLiveContext(
  existing: CastSession["liveContext"] | undefined,
  playlistId: string,
  channelId: string,
  groupChannelIds: string[]
): CastSession["liveContext"] | undefined {
  if (existing && existing.playlistId === playlistId) {
    const index = existing.channelIds.indexOf(channelId)
    if (index !== -1) return { ...existing, index }
  }
  return buildLiveCastContext(playlistId, groupChannelIds, channelId)
}

/** Resolves a playable src for a cached live-catalog row: M3U carries its own URL, Xtream builds one. */
async function resolveChannelSrc(playlistId: string, channel: any, channelId: string): Promise<string | null> {
  if (channel?.url) return channel.url
  const creds = await resolvePlaylistCreds(playlistId)
  if (!creds?.host || !creds.user || !creds.pass) return null
  const { buildLiveStreamUrl } = await import("@/scripts/lib/stream-urls.js")
  return buildLiveStreamUrl(creds, channelId, creds.liveContainer || null)
}

/**
 * Casts one live channel on the session's current device. Never throws; false on any failure.
 * The receiver swaps streams in place, so this holds no extra provider connection.
 */
export async function castLiveChannel(
  playlistId: string,
  channelId: string | number,
  options: CastLiveChannelOptions = {}
): Promise<boolean> {
  const session = getCastSession()
  if (!session) return false
  const id = String(channelId)

  try {
    const { getCached } = await import("@/scripts/lib/cache.js")
    let liveList: any[] = getCached(playlistId, "live")?.data || []
    let channel = liveList.find((entry: any) => String(entry?.id) === id)
    if (!channel) {
      const creds = await resolvePlaylistCreds(playlistId)
      if (!creds) return false
      const { ensureLive } = await import("@/scripts/lib/catalog.js")
      liveList = await ensureLive(creds, playlistId)
      channel = liveList.find((entry: any) => String(entry?.id) === id)
    }
    if (!channel) return false

    const src = await resolveChannelSrc(playlistId, channel, id)
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
    const liveContext =
      options.liveContext ??
      resolveTunedLiveContext(session.liveContext, playlistId, id, options.groupChannelIds || [id])
    await castPlay(sessionAsDevice(session), descriptor, { liveContext })
    updateCastSession({ contentHref: `/livetv?channel=${id}` })
    return true
  } catch (err) {
    log.warn("[xt:tv-cast-live] castLiveChannel failed:", err)
    return false
  }
}
