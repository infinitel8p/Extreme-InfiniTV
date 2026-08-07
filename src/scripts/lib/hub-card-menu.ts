// Svelte action wiring the shared poster context menu (poster-menu.ts) onto
// hub strip cards. Episode entries resolve to their parent series; live and
// entries without a playlist attach nothing.

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
  kind: "vod" | "series"
  id: string | number
  name?: string | null
  logo?: string | null
}

function effectiveTarget(params: HubCardMenuParams): EffectiveTarget | null {
  if (params.kind === "vod" || params.kind === "series") {
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
    const target = effectiveTarget(current)
    const playlistId = current.playlistId
    if (!target || !playlistId) return

    import("@/scripts/lib/poster-menu").then(async ({ openPosterMenu }) => {
      if (destroyed) return

      let buildStreamUrl: (() => string | null) | undefined
      let onDownload: (() => void) | undefined

      if (target.kind === "vod") {
        const [{ loadCreds }, { buildMovieStreamUrl }, { getCached }] = await Promise.all([
          import("@/scripts/lib/creds.js"),
          import("@/scripts/lib/stream-urls.ts"),
          import("@/scripts/lib/cache.js"),
        ])
        const creds = await loadCreds()
        const vodEntry = (getCached(playlistId, "vod")?.data || []).find(
          (item: any) => String(item?.id) === String(target.id)
        )
        onDownload = () => {
          window.location.href = `/movies/detail?id=${encodeURIComponent(String(target.id))}&download=1`
        }
        buildStreamUrl = () => {
          if (!creds.host || !creds.user || !creds.pass) return null
          return buildMovieStreamUrl(creds, target.id, vodEntry?.container_extension || null)
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
              : `/series/detail?id=${encodeURIComponent(String(target.id))}`
        },
        onDownload,
        buildStreamUrl,
      })
    })
  }

  function attach() {
    if (attached || destroyed) return
    if (current.kind === "live" || !current.playlistId) return
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
