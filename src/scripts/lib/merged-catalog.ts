import {
  entryToCreds,
  getEntryDnsOverride,
  getMergedEntries,
  getMergedEntriesSync,
  isMergedModeSync,
} from "@/scripts/lib/creds.js"
import { getCached, hydrate } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
import {
  concatInPlaylistOrder,
  stampRowsWithPlaylist,
  type CatalogKind,
  type MergedPlaylistSource,
} from "@/scripts/lib/merged-catalog-core.ts"

export interface MergedReadResult {
  rows: any[]
  byPlaylist: Map<string, any[]>
  sources: MergedPlaylistSource[]
  isMerged: boolean
  newestFetchedAt: number | null
  anyStale: boolean
}

export interface MergedEnsureResult extends MergedReadResult {
  errors: Map<string, unknown>
}

export interface MergedEnsureOptions {
  force?: boolean
  includeHidden?: boolean
  onPlaylistSettled?: (
    playlistId: string,
    status: "done" | "error",
    info: { count?: number; error?: unknown },
  ) => void
}

export function getMergedSources(): MergedPlaylistSource[] {
  return getMergedEntriesSync().map((entry: any) => ({
    playlistId: entry._id,
    title: entry.title || "",
  }))
}

export function isMergedView(): boolean {
  return isMergedModeSync()
}

export function isMergedPlaylistId(playlistId: string): boolean {
  return getMergedSources().some((source) => source.playlistId === playlistId)
}

export function mergedEntryTitle(playlistId: string): string {
  return getMergedSources().find((source) => source.playlistId === playlistId)?.title || ""
}

export function readMergedRows(
  kind: CatalogKind,
  opts: { includeHidden?: boolean } = {},
): MergedReadResult {
  const sources = getMergedSources()
  const byPlaylist = new Map<string, any[]>()
  let newestFetchedAt: number | null = null
  let anyStale = false
  for (const source of sources) {
    const hits =
      kind === "live"
        ? [getCached(source.playlistId, "live"), getCached(source.playlistId, "m3u")]
        : [getCached(source.playlistId, kind)]
    for (const hit of hits) {
      if (!hit) continue
      if (newestFetchedAt === null || hit.fetchedAt > newestFetchedAt) newestFetchedAt = hit.fetchedAt
      if (hit.stale) anyStale = true
    }
    const rows =
      kind === "live"
        ? readCachedLiveChannels(source.playlistId, opts)
        : (getCached(source.playlistId, kind)?.data ?? [])
    byPlaylist.set(
      source.playlistId,
      stampRowsWithPlaylist(Array.isArray(rows) ? rows : [], source.playlistId),
    )
  }
  return {
    rows: concatInPlaylistOrder(
      sources.map((source) => ({
        playlistId: source.playlistId,
        rows: byPlaylist.get(source.playlistId) || [],
      })),
    ),
    byPlaylist,
    sources,
    isMerged: sources.length >= 2,
    newestFetchedAt,
    anyStale,
  }
}

export async function hydrateMergedRows(kind: CatalogKind): Promise<void> {
  const kinds = kind === "live" ? ["live", "m3u"] : [kind]
  const jobs: Promise<unknown>[] = []
  for (const source of getMergedSources()) {
    for (const cacheKind of kinds) jobs.push(hydrate(source.playlistId, cacheKind))
  }
  await Promise.allSettled(jobs)
}

export async function ensureMergedRows(
  kind: CatalogKind,
  opts: MergedEnsureOptions = {},
): Promise<MergedEnsureResult> {
  const entries = await getMergedEntries()
  const catalog = await import("@/scripts/lib/catalog.js")
  const ensure =
    kind === "live" ? catalog.ensureLive : kind === "vod" ? catalog.ensureVod : catalog.ensureSeries
  const errors = new Map<string, unknown>()
  await Promise.allSettled(
    entries.map(async (entry: any) => {
      try {
        const rows = await ensure(entryToCreds(entry), entry._id, {
          force: opts.force,
          includeHidden: opts.includeHidden,
          dns: getEntryDnsOverride(entry),
        })
        opts.onPlaylistSettled?.(entry._id, "done", {
          count: Array.isArray(rows) ? rows.length : 0,
        })
      } catch (error) {
        errors.set(entry._id, error)
        opts.onPlaylistSettled?.(entry._id, "error", { error })
      }
    }),
  )
  return { ...readMergedRows(kind, { includeHidden: opts.includeHidden }), errors }
}
