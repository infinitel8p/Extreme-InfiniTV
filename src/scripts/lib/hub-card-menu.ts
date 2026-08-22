// Svelte action wiring the shared poster context menu (poster-menu.ts) onto
// hub strip cards. Episode entries resolve to their parent series; entries
// without a playlist attach nothing.

import { isTauri } from "@/scripts/lib/creds.js"

// Matches the resume threshold on the movie/series detail pages.
const RESUME_MIN_SECONDS = 30

export type HubCardMenuKind = "vod" | "series" | "episode" | "live"

export interface HubCardMenuParams {
  kind: HubCardMenuKind
  id: string | number
  name?: string | null
  logo?: string | null
  seriesId?: string | number | null
  seriesName?: string | null
  playlistId: string
}

interface EffectiveTarget {
  kind: "vod" | "series" | "live"
  id: string | number
  name?: string | null
  logo?: string | null
}

function effectiveTarget(params: HubCardMenuParams): EffectiveTarget | null {
  if (params.kind === "vod" || params.kind === "series" || params.kind === "live") {
    return { kind: params.kind, id: params.id, name: params.name, logo: params.logo }
  }
  if (params.kind === "episode") {
    if (params.seriesId == null || params.seriesId === "") return null
    return {
      kind: "series",
      id: params.seriesId,
      name: params.seriesName || params.name,
      logo: params.logo,
    }
  }
  return null
}

export function hubCardMenu(
  node: HTMLElement,
  params: HubCardMenuParams
): { update(next: HubCardMenuParams): void; destroy(): void } {
  let current = params
  let attached = false
  let destroyed = false

  function open(anchor: HTMLElement, point: { x: number; y: number } | null) {
    if (destroyed) return
    const originalKind = current.kind
    const originalId = current.id
    const originalSeriesId = current.seriesId
    const target = effectiveTarget(current)
    const playlistId = current.playlistId
    if (!target || !playlistId) return

    import("@/scripts/lib/poster-menu").then(async ({ openPosterMenu }) => {
      if (destroyed) return

      let buildStreamUrl: (() => string | null) | undefined
      let onDownload: (() => void) | undefined
      let onPlayOnTv: (() => void) | undefined

      if (target.kind !== "series" || isTauri) {
        const [{ getState, entryToCreds, loadCreds }, streamUrls, { getCached }] = await Promise.all([
          import("@/scripts/lib/creds.js"),
          import("@/scripts/lib/stream-urls.ts"),
          import("@/scripts/lib/cache.js"),
        ])
        // Hub cards can belong to non-active playlists; resolve creds per card.
        const state = await getState()
        const playlistEntry = (state.entries || []).find((entry: any) => entry?._id === playlistId)
        const creds = playlistEntry ? entryToCreds(playlistEntry) : await loadCreds()
        const hasXtreamCreds = !!(creds.host && creds.user && creds.pass)

        if (target.kind === "vod") {
          const vodEntry = (getCached(playlistId, "vod")?.data || []).find(
            (item: any) => String(item?.id) === String(target.id)
          )
          onDownload = () => {
            window.location.href = `/movies/detail?id=${encodeURIComponent(String(target.id))}&download=1`
          }
          buildStreamUrl = () => {
            if (!hasXtreamCreds) return null
            return streamUrls.buildMovieStreamUrl(creds, target.id, vodEntry?.container_extension || null)
          }
          if (isTauri && hasXtreamCreds) {
            onPlayOnTv = () => {
              void (async () => {
                const [{ castXtreamVodToTv }, { getProgress }] = await Promise.all([
                  import("@/scripts/lib/tv-cast.ts"),
                  import("@/scripts/lib/preferences.js"),
                ])
                const saved = getProgress(playlistId, "vod", target.id)
                const resumable = saved && !saved.completed
                castXtreamVodToTv({
                  creds,
                  playlistId,
                  vodId: target.id,
                  containerExt: vodEntry?.container_extension || null,
                  title: target.name || null,
                  logo: target.logo || undefined,
                  resumeSeconds:
                    resumable && saved.position > RESUME_MIN_SECONDS ? saved.position : 0,
                  durationSeconds: resumable && saved.duration > 0 ? saved.duration : undefined,
                })()
              })()
            }
          }
        } else if (target.kind === "live") {
          const liveList = getCached(playlistId, "live")?.data || []
          const liveEntry = liveList.find((item: any) => String(item?.id) === String(target.id))
          const liveUrl = () => {
            if (liveEntry?.url) return liveEntry.url as string
            if (!hasXtreamCreds) return null
            return streamUrls.buildLiveStreamUrl(creds, target.id, creds.liveContainer || null)
          }
          if (liveEntry?.url || hasXtreamCreds) buildStreamUrl = liveUrl
          if (isTauri && (liveEntry?.url || hasXtreamCreds)) {
            const headers =
              liveEntry?.userAgent || liveEntry?.referer
                ? { userAgent: liveEntry.userAgent || null, referer: liveEntry.referer || null }
                : undefined
            const drm =
              liveEntry?.manifestType || liveEntry?.licenseKey
                ? {
                    manifestType: liveEntry.manifestType || null,
                    drmScheme: liveEntry.drmScheme || null,
                    licenseKey: liveEntry.licenseKey || null,
                  }
                : undefined
            onPlayOnTv = () => {
              import("@/scripts/lib/tv-cast.ts").then(({ castLiveChannelToTv, buildLiveCastContext }) => {
                const channelIds = liveList.map((item: any) => String(item?.id))
                castLiveChannelToTv({
                  contentTitle: target.name || null,
                  title: target.name || "",
                  logo: target.logo || undefined,
                  buildSrc: liveUrl,
                  drm,
                  headers,
                  liveContext: buildLiveCastContext(playlistId, channelIds, String(target.id)),
                })()
              })
            }
          }
        } else if (isTauri && hasXtreamCreds) {
          // target.kind === "series"; an episode card casts itself, a series card casts next-up.
          const seriesId = target.id
          onPlayOnTv = () => {
            void (async () => {
              const [{ castXtreamEpisodeToTv }, { flattenSeriesEpisodes, resolveSeriesNextUp }, { requestSeriesInfo }, { getProgress }] =
                await Promise.all([
                  import("@/scripts/lib/tv-cast.ts"),
                  import("@/scripts/lib/tv-cast-next.ts"),
                  import("@/scripts/lib/series-seasons.ts"),
                  import("@/scripts/lib/preferences.js"),
                ])

              if (originalKind === "episode" && originalSeriesId != null) {
                const data = await requestSeriesInfo(playlistId, seriesId)
                const episodeEntry = flattenSeriesEpisodes(data).find(
                  (episode) => String(episode.id) === String(originalId)
                )
                if (!episodeEntry) return
                const saved = getProgress(playlistId, "episode", originalId)
                const resumeSeconds =
                  saved && !saved.completed && saved.position > RESUME_MIN_SECONDS ? saved.position : 0
                castXtreamEpisodeToTv({
                  creds,
                  playlistId,
                  seriesId,
                  episodeId: episodeEntry.id,
                  containerExt: episodeEntry.containerExt,
                  season: episodeEntry.season,
                  episodeNum: episodeEntry.episodeNum,
                  title: episodeEntry.title || target.name || null,
                  logo: target.logo || undefined,
                  resumeSeconds,
                  contentHref: `/series/detail?id=${encodeURIComponent(String(seriesId))}`,
                })()
                return
              }

              const nextUp = await resolveSeriesNextUp(playlistId, seriesId)
              if (!nextUp) return
              castXtreamEpisodeToTv({
                creds,
                playlistId,
                seriesId,
                episodeId: nextUp.episodeId,
                containerExt: nextUp.containerExt,
                season: nextUp.season,
                episodeNum: nextUp.episodeNum,
                title: nextUp.title || target.name || null,
                logo: target.logo || undefined,
                resumeSeconds: nextUp.resumeSeconds,
                contentHref: `/series/detail?id=${encodeURIComponent(String(seriesId))}`,
              })()
            })()
          }
        }
      }

      if (destroyed) return
      openPosterMenu({
        kind: target.kind,
        entry: { id: target.id, name: target.name, logo: target.logo },
        activePlaylistId: playlistId,
        anchor,
        point,
        onOpen: () => {
          window.location.href =
            target.kind === "vod"
              ? `/movies/detail?id=${encodeURIComponent(String(target.id))}`
              : target.kind === "live"
                ? `/livetv?channel=${encodeURIComponent(String(target.id))}`
                : `/series/detail?id=${encodeURIComponent(String(target.id))}`
        },
        onDownload,
        buildStreamUrl,
        onPlayOnTv,
      })
    })
  }

  function attach() {
    if (attached || destroyed) return
    if (!current.playlistId) return
    attached = true
    import("@/scripts/lib/poster-menu").then(({ attachPosterContextMenu }) => {
      if (destroyed) return
      attachPosterContextMenu(node, open)
    })
  }

  attach()

  return {
    update(next: HubCardMenuParams) {
      current = next
      attach()
    },
    destroy() {
      destroyed = true
    },
  }
}
