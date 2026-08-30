import { takeLastOpenedEntry, type TvView, type TvViewContext } from "@/scripts/tv/router"
import { navigate } from "astro:transitions/client"
import { t, LOCALE_EVENT, getActiveLocale } from "@/scripts/lib/i18n"
import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  getContinueWatching,
  getGlobalFavorites,
  getFavoriteMeta,
  getWatchlist,
  clearProgress,
  getRecents,
} from "@/scripts/lib/preferences.js"
import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels, ensureOverridesReady } from "@/scripts/lib/live-catalog.ts"
import {
  getHubStrips,
  HUB_STRIPS_EVENT,
  getLanguageGroupingEnabled,
  LANGUAGE_GROUPING_EVENT,
  CONTENT_LANGUAGE_EVENT,
} from "@/scripts/lib/app-settings.js"
import { kindLabel } from "@/scripts/lib/kinds.ts"
import {
  createGroupingIndexMemo,
  isLanguageGroupingExplicitlyEnabled,
  type CatalogGroupingIndex,
} from "@/scripts/lib/language-groups.ts"
import { buildLanguageChips, setLanguageChipsOffset } from "@/scripts/lib/entry-card.ts"
import {
  loadProgrammes,
  getProgrammesSync,
  getNowNextForChannel,
  EPG_LOADED_EVENT,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"
import {
  tvEpgSource,
  toXtreamCreds,
  tvShortEpgCache,
  shortEpgNowNextSlot,
  TV_EPG_SOURCE_CHANGED_EVENT,
  type TvEpgSource,
} from "@/scripts/tv/epg-source"
import type { XtreamCreds, ShortEpgNowNext } from "@/scripts/lib/short-epg.ts"
import { debounce } from "@/scripts/lib/debounce.ts"
import { formatTimeRange } from "@/scripts/lib/now-next"
import { keepFocusedInView } from "@/scripts/tv/focus"
import { createHero, HERO_FOCUS_KEY, type HeroItem, type HeroHandle } from "@/scripts/tv/ui/hero"
import { createRail, type RailHandle } from "@/scripts/tv/ui/rail"
import {
  cardFocusKey,
  formatCardMeta,
  nameReturningCard,
  type CardItem,
  type CardKind,
  type PosterCardItem,
  type LiveCardItem,
} from "@/scripts/tv/ui/card"
import { resumeContinueWatchingRow, type ContinueWatchingRow } from "@/scripts/tv/resume-playback.ts"
import { neighboursOf, warmImageUrl } from "@/scripts/tv/prefetch"
import {
  heavyEffectsAllowed,
  memoryConservative,
  epgLoadWindow,
  epgLoadMode,
  EPG_NOW_NEXT_REFRESH_MS,
} from "@/scripts/tv/motion"
import { createActionSheet, type ActionSheetHandle, type ActionSheetItem } from "@/scripts/tv/ui/action-sheet.ts"
import { buildCatalogMenuActions } from "@/scripts/tv/rail-card-menu.ts"
import { backdropFromInfoPayload } from "@/scripts/lib/backdrop.ts"
import { requestVodInfo } from "@/scripts/lib/vod-info.ts"
import { requestSeriesInfo } from "@/scripts/lib/series-seasons.ts"

// Literal so this cache-only page never statically imports catalog.js
const CATALOG_WARMED_EVENT = "xt:catalog-warmed"
const CATALOG_WARMING_START_EVENT = "xt:catalog-warming-start"
const CATALOG_WARMING_PROGRESS_EVENT = "xt:catalog-warming-progress"

const RAIL_ITEM_LIMIT = 20
const HERO_FOCUS_DEBOUNCE_MS = 80
const VERTICAL_OFFSET_RATIO = 0.4
const CONTINUE_WATCHING_LIVE_CHANNEL_LIMIT = 5
const CONTINUE_WATCHING_LIVE_CHANNEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const HERO_ROTATION_INTERVAL_MS = 10000
const HERO_BACKDROP_PREFETCH_RADIUS = 1
const RAIL_IMAGE_WARM_COUNT = 8
const RAIL_EAGER_CARD_COUNT = 8
const RAIL_EAGER_FOLD_VIEWPORTS = 1.5

interface HubStrip {
  id: string
  type: string
  kind: string
}

interface CatalogRow {
  id: number | string
  name?: string
  logo?: string | null
  rating?: unknown
  year?: string | number | null
  added?: number
  tmdb?: number | null
}

interface LiveChannelRow {
  id: number | string
  name?: string
  logo?: string | null
  tvgId?: string
  tvgShift?: number
}

interface WatchlistRowMeta {
  ts?: number
  name?: string
  logo?: string | null
}

const RAIL_TITLE_KEY: Record<string, string> = {
  "continue-watching": "hub.strip.continueWatching",
  favorites: "hub.strip.favorites.all",
  "favorites:live": "hub.strip.favorites.live",
  "favorites:vod": "hub.strip.favorites.vod",
  "favorites:series": "hub.strip.favorites.series",
  watchlist: "hub.strip.watchlist.all",
  "watchlist:vod": "hub.strip.watchlist.vod",
  "watchlist:series": "hub.strip.watchlist.series",
  "recently-added": "hub.strip.recentlyAdded.all",
  "recently-added:vod": "hub.strip.recentlyAdded.vod",
  "recently-added:series": "hub.strip.recentlyAdded.series",
}

function metaForCatalogEntry(entry: CatalogRow | undefined): string {
  return entry ? formatCardMeta(entry.year, entry.rating) : ""
}

interface ChipInfoRecord {
  tags: string[]
  variantCount: number
  displayTag: string | null
}

const getVodGroupingIndexFor = createGroupingIndexMemo()
const getSeriesGroupingIndexFor = createGroupingIndexMemo()

// Lite tier skips the multi-map grouping index unless the user explicitly opted in.
function languageGroupingAllowed(): boolean {
  return memoryConservative() ? isLanguageGroupingExplicitlyEnabled() : getLanguageGroupingEnabled()
}

/** One pass over a catalog collecting only the ids a rail needs, instead of indexing all of it. */
function pickRowsById<T extends { id: number | string }>(rows: T[], wanted: Set<number>): Map<number, T> {
  const picked = new Map<number, T>()
  if (!wanted.size) return picked
  for (const row of rows) {
    const id = Number(row.id)
    if (wanted.has(id) && !picked.has(id)) picked.set(id, row)
    if (picked.size === wanted.size) break
  }
  return picked
}

function chipInfoForEntry(
  kind: "vod" | "series",
  entryId: number,
  playlistId: string,
  catalog: CatalogRow[]
): ChipInfoRecord | undefined {
  if (!languageGroupingAllowed() || !catalog.length) return undefined
  // The raw cached rows are already GroupableRow-shaped; mapping them made a second full copy
  // of the catalog and a second index, both keyed off that copy.
  const groupingIndex: CatalogGroupingIndex =
    kind === "vod" ? getVodGroupingIndexFor(playlistId, catalog) : getSeriesGroupingIndexFor(playlistId, catalog)
  const groupKey = groupingIndex.keyByEntryId.get(entryId)
  const groupInfo = groupKey ? groupingIndex.groupsByKey.get(groupKey) : null
  if (!groupInfo || groupInfo.entryIds.length < 2) return undefined
  return {
    tags: groupInfo.tags,
    variantCount: groupInfo.entryIds.length,
    displayTag: groupingIndex.tagByEntryId.get(entryId) ?? null,
  }
}

// The home rails render synchronously (no row-windowing), so decorating after setItems is a one-shot pass.
function decorateRailChips(
  rail: RailHandle,
  items: CardItem[],
  chipInfoByFocusKey: Map<string, ChipInfoRecord>
): void {
  const cards = rail.el.querySelectorAll<HTMLElement>("[data-focus-key]")
  cards.forEach((card, index) => {
    const item = items[index]
    const info = item && chipInfoByFocusKey.get(cardFocusKey(item.railId, item.kind as CardKind, item.id))
    if (!info) return
    const posterWrap = card.querySelector<HTMLElement>("[data-poster-wrap]")
    if (!posterWrap) return
    const chip = buildLanguageChips(info.tags, info.variantCount, getActiveLocale(), info.displayTag)
    if (!chip) return
    posterWrap.appendChild(chip)
    setLanguageChipsOffset(posterWrap, false)
  })
}

function currentProgrammeFor(
  channel: LiveChannelRow,
  playlistId: string
): { title: string; start: number; stop: number } | null {
  if (liveEpgSource === "short-epg") {
    return shortEpgNowNextSlot(liveNowNextCache.get(liveNowNextCacheKey(playlistId, channel.id)) ?? null).current
  }
  const state = getProgrammesSync(playlistId)
  if (!state) return null
  const { current } = getNowNextForChannel(state.programmes, channel, playlistId)
  return current
}

function buildLiveHeroItem(
  railTitle: string,
  item: LiveCardItem,
  channel: LiveChannelRow | undefined,
  playlistId: string
): HeroItem {
  const current = channel ? currentProgrammeFor(channel, playlistId) : null
  if (!current) {
    return {
      eyebrow: railTitle,
      title: item.name,
      meta: kindLabel("live"),
      imageUrl: item.logoUrl,
      imageKind: "logo",
      onActivate: item.onActivate,
    }
  }
  const percent =
    current.stop > current.start
      ? Math.max(0, Math.min(100, ((Date.now() - current.start) / (current.stop - current.start)) * 100))
      : 0
  return {
    eyebrow: railTitle,
    title: item.name,
    meta: t("tv.home.liveNow", { title: current.title, range: formatTimeRange(current.start, current.stop) }),
    progressPercent: percent,
    imageUrl: item.logoUrl,
    imageKind: "logo",
    onActivate: item.onActivate,
  }
}

function resumeHeroMeta(percent: number): string {
  return percent < 1 ? t("hub.strip.continueWatching") : t("tv.home.resumeAt", { percent: Math.round(percent) })
}

function resumeOrNavigate(playlistId: string, row: ContinueWatchingRow, href: string): void {
  void resumeContinueWatchingRow(playlistId, row).then((started) => {
    if (!started) void navigate(href)
  })
}

function continueWatchingMenuActions(
  playlistId: string,
  progressKind: "vod" | "episode",
  progressId: string | number,
  resumeRow: ContinueWatchingRow,
  href: string
): ActionSheetItem[] {
  return [
  // "Open" should not autoplay, unlike the row's own tap-to-resume href.
  const openHref = href.replace(/[?&]autoplay=1\b/, "")
    { label: t("detail.action.continue"), onSelect: () => resumeOrNavigate(playlistId, resumeRow, href) },
    { label: t("list.menu.open"), onSelect: () => { void navigate(openHref) } },
    {
      label: t("list.menu.removeContinueWatching"),
      onSelect: () => clearProgress(playlistId, progressKind, progressId),
    },
  ]
}

type BackdropKind = "vod" | "series"
type BackdropRef = { kind: BackdropKind; id: string | number }

function backdropCacheKind(kind: BackdropKind, id: string | number): string {
  return kind === "vod" ? `vod_info_${id}` : `series_info_${id}`
}

function cachedBackdropUrl(playlistId: string, kind: BackdropKind, id: string | number): string | null {
  const hit = getCached(playlistId, backdropCacheKind(kind, id))
  return hit ? backdropFromInfoPayload(hit.data) : null
}

function requestBackdropInfo(playlistId: string, kind: BackdropKind, id: string | number): Promise<any> {
  return kind === "vod" ? requestVodInfo(playlistId, id) : requestSeriesInfo(playlistId, id)
}

/**
 * Cache-first hero image: a real backdrop when the vod_info/series_info entry is
 * already cached, poster otherwise. On a cache miss this also kicks off a lazy,
 * throttled info fetch and calls onResolved(focusKey) once it lands so the caller
 * can re-show the hero - guarded by comparing focusKey against whatever the hero
 * is showing at that moment, so a stale resolve after the hero moved on is a no-op.
 */
function heroBackdropImage(
  playlistId: string,
  kind: BackdropKind,
  id: string | number,
  posterUrl: string | null,
  focusKey: string,
  onResolved: (focusKey: string) => void
): { imageUrl: string | null; imageKind: "backdrop" | "poster" } {
  const cachedUrl = cachedBackdropUrl(playlistId, kind, id)
  if (cachedUrl) return { imageUrl: cachedUrl, imageKind: "backdrop" }
  void requestBackdropInfo(playlistId, kind, id).then((data) => {
    if (data && backdropFromInfoPayload(data)) onResolved(focusKey)
  })
  return { imageUrl: posterUrl, imageKind: "poster" }
}

interface LiveRecentEntry {
  id: number
  name?: string
  logo?: string | null
  ts?: number
}

type MergedContinueWatchingRow =
  | { source: "progress"; row: any; ts: number }
  | { source: "live"; row: LiveRecentEntry; ts: number }

/**
 * Continue-watching rows (`updatedAt`) and live recents (`ts`) both carry a real
 * epoch-ms timestamp, so the merge is a plain recency sort across all three kinds.
 * Live channels get their own tighter retention (last 5, max 7 days old) before
 * merging in - movies/episodes keep whatever the progress-retention setting allows.
 */
function mergeContinueWatchingRows(progressRows: any[], liveRecents: LiveRecentEntry[]): MergedContinueWatchingRow[] {
  const cutoffMs = Date.now() - CONTINUE_WATCHING_LIVE_CHANNEL_MAX_AGE_MS
  const recentLiveChannels = liveRecents
    .filter((row) => (row.ts || 0) >= cutoffMs)
    .slice(0, CONTINUE_WATCHING_LIVE_CHANNEL_LIMIT)

  const merged: MergedContinueWatchingRow[] = [
    ...progressRows.map((row) => ({ source: "progress" as const, row, ts: row.updatedAt || 0 })),
    ...recentLiveChannels.map((row) => ({ source: "live" as const, row, ts: row.ts || 0 })),
  ]
  merged.sort((a, b) => b.ts - a.ts)
  return merged.slice(0, RAIL_ITEM_LIMIT)
}

function buildContinueWatchingItems(
  railId: string,
  railTitle: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>,
  backdropRefs: Map<string, BackdropRef>,
  actionSheet: ActionSheetHandle,
  onBackdropResolved: (focusKey: string) => void,
  onLiveNowNextResolved: (focusKey: string) => void
): CardItem[] {
  const progressRows = getContinueWatching(playlistId, RAIL_ITEM_LIMIT) as any[]
  const liveRecents = getRecents(playlistId, "live") as LiveRecentEntry[]
  const merged = mergeContinueWatchingRows(progressRows, liveRecents)

  const wantedVodIds = new Set<number>(
    merged.filter((entry) => entry.source === "progress" && entry.row.kind === "vod").map((entry) => Number(entry.row.id))
  )
  const vodById = pickRowsById((getCached(playlistId, "vod")?.data || []) as CatalogRow[], wantedVodIds)
  const wantedLiveIds = new Set<number>(
    merged.filter((entry): entry is { source: "live"; row: LiveRecentEntry; ts: number } => entry.source === "live")
      .map((entry) => Number(entry.row.id))
  )
  const liveById = wantedLiveIds.size
    ? pickRowsById(readCachedLiveChannels(playlistId) as LiveChannelRow[], wantedLiveIds)
    : new Map<number, LiveChannelRow>()
  const items: CardItem[] = []

  for (const entry of merged) {
    if (entry.source === "live") {
      const recent = entry.row
      const channel = liveById.get(Number(recent.id))
      const name = channel?.name || recent.name || kindLabel("live")
      const logoUrl = channel?.logo ?? recent.logo ?? null
      const href = `/tv/live?channel=${encodeURIComponent(String(recent.id))}`
      const item: LiveCardItem = {
        railId,
        kind: "live",
        id: recent.id,
        name,
        logoUrl,
        nowTitle: channel ? currentProgrammeFor(channel, playlistId)?.title || "" : "",
        ariaLabel: t("tv.aria.watch", { name }),
        onActivate: () => {
          void navigate(href)
        },
        onLongPress: () =>
          actionSheet.open(
            name,
            buildCatalogMenuActions({ kind: "live", id: recent.id, name, logo: logoUrl, playlistId, href })
          ),
      }
      items.push(item)
      const liveFocusKey = cardFocusKey(railId, "live", recent.id)
      heroBuilders.set(liveFocusKey, () => buildLiveHeroItem(railTitle, item, channel, playlistId))
      if (channel && liveEpgSource === "short-epg") {
        requestLiveNowNext(channel, playlistId, liveFocusKey, onLiveNowNextResolved)
      }
      continue
    }

    const row = entry.row
    const percent = row.duration > 0 ? Math.max(0, Math.min(100, (row.position / row.duration) * 100)) : 0

    if (row.kind === "vod") {
      const movie = vodById.get(Number(row.id))
      const name = row.name || movie?.name || t("list.movieFallback", { id: row.id })
      const posterUrl = row.logo || movie?.logo || null
      const href = `/tv/movies/detail?id=${encodeURIComponent(String(row.id))}&autoplay=1`
      const resumeRow: ContinueWatchingRow = { kind: "vod", id: row.id, position: row.position, name, logo: posterUrl }
      const openMenu = () =>
        actionSheet.open(name, continueWatchingMenuActions(playlistId, "vod", row.id, resumeRow, href))
      const item: PosterCardItem = {
        railId,
        kind: "vod",
        id: row.id,
        name,
        href,
        posterUrl,
        meta: kindLabel("vod"),
        ariaLabel: t("tv.aria.resume", { name }),
        progressPercent: percent,
        onActivate: () => resumeOrNavigate(playlistId, resumeRow, href),
        onLongPress: openMenu,
      }
      items.push(item)
      const vodFocusKey = cardFocusKey(railId, "vod", row.id)
      backdropRefs.set(vodFocusKey, { kind: "vod", id: row.id })
      heroBuilders.set(vodFocusKey, () => {
        const backdrop = heroBackdropImage(playlistId, "vod", row.id, posterUrl, vodFocusKey, onBackdropResolved)
        return {
          eyebrow: railTitle,
          title: name,
          meta: resumeHeroMeta(percent),
          progressPercent: percent,
          imageUrl: backdrop.imageUrl,
          imageKind: backdrop.imageKind,
          ariaLabel: t("tv.aria.resume", { name }),
          onActivate: () => resumeOrNavigate(playlistId, resumeRow, href),
        }
      })
      continue
    }

    const seasonLabel = row.season != null ? `S${row.season}` : ""
    const episodeLabel = row.episodeNum != null ? `E${row.episodeNum}` : ""
    const tag = seasonLabel + episodeLabel || kindLabel("series")
    const name = row.episodeTitle || row.seriesName || t("list.seriesFallback", { id: row.id })
    const posterUrl = row.seriesLogo || null
    const href =
      row.seriesId != null
        ? `/tv/series/detail?id=${encodeURIComponent(String(row.seriesId))}` +
          `&season=${encodeURIComponent(String(row.season ?? ""))}` +
          `&episode=${encodeURIComponent(String(row.episodeNum ?? ""))}`
        : "#"
    const resumeRow: ContinueWatchingRow = {
      kind: "episode",
      id: row.id,
      seriesId: row.seriesId,
      seriesName: row.seriesName,
      seriesLogo: posterUrl,
      name: row.episodeTitle,
    }
    const openMenu = () =>
      actionSheet.open(name, continueWatchingMenuActions(playlistId, "episode", row.id, resumeRow, href))
    const item: PosterCardItem = {
      railId,
      kind: "episode",
      id: row.id,
      name,
      href,
      posterUrl,
      meta: row.seriesName ? `${row.seriesName} · ${tag}` : tag,
      ariaLabel: t("tv.aria.resume", { name }),
      progressPercent: percent,
      onActivate: () => resumeOrNavigate(playlistId, resumeRow, href),
      onLongPress: openMenu,
    }
    items.push(item)
    const episodeFocusKey = cardFocusKey(railId, "episode", row.id)
    if (row.seriesId != null) backdropRefs.set(episodeFocusKey, { kind: "series", id: row.seriesId })
    heroBuilders.set(episodeFocusKey, () => {
      const backdrop =
        row.seriesId != null
          ? heroBackdropImage(playlistId, "series", row.seriesId, posterUrl, episodeFocusKey, onBackdropResolved)
          : { imageUrl: posterUrl, imageKind: "poster" as const }
      return {
        eyebrow: railTitle,
        title: name,
        meta: resumeHeroMeta(percent),
        progressPercent: percent,
        imageUrl: backdrop.imageUrl,
        imageKind: backdrop.imageKind,
        ariaLabel: t("tv.aria.resume", { name }),
        onActivate: () => resumeOrNavigate(playlistId, resumeRow, href),
      }
    })
  }

  return items
}

function buildFavoritesItems(
  railId: string,
  railTitle: string,
  filterKind: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>,
  backdropRefs: Map<string, BackdropRef>,
  chipInfoByFocusKey: Map<string, ChipInfoRecord>,
  actionSheet: ActionSheetHandle,
  onBackdropResolved: (focusKey: string) => void,
  onLiveNowNextResolved: (focusKey: string) => void
): CardItem[] {
  const raw = (getGlobalFavorites(playlistId) as Array<{ kind: "live" | "vod" | "series"; id: number }>).filter(
    (entry) => filterKind === "all" || entry.kind === filterKind
  )
  const shown = raw.slice(0, RAIL_ITEM_LIMIT)
  const wantedIds = (wantedKind: string) =>
    new Set<number>(shown.filter((entry) => entry.kind === wantedKind).map((entry) => Number(entry.id)))
  const vodRows = (getCached(playlistId, "vod")?.data || []) as CatalogRow[]
  const seriesRows = (getCached(playlistId, "series")?.data || []) as CatalogRow[]
  const liveWanted = wantedIds("live")
  const liveById = liveWanted.size
    ? pickRowsById(readCachedLiveChannels(playlistId) as LiveChannelRow[], liveWanted)
    : new Map<number, LiveChannelRow>()
  const vodById = pickRowsById(vodRows, wantedIds("vod"))
  const seriesById = pickRowsById(seriesRows, wantedIds("series"))

  const items: CardItem[] = []
  for (const fav of shown) {
    if (fav.kind === "live") {
      const channel = liveById.get(Number(fav.id))
      const meta = getFavoriteMeta(playlistId, "live", fav.id)
      const name = meta?.name || channel?.name || kindLabel("live")
      const logoUrl = meta?.logo ?? channel?.logo ?? null
      const href = `/tv/live?channel=${encodeURIComponent(String(fav.id))}`
      const item: LiveCardItem = {
        railId,
        kind: "live",
        id: fav.id,
        name,
        logoUrl,
        nowTitle: channel ? currentProgrammeFor(channel, playlistId)?.title || "" : "",
        ariaLabel: t("tv.aria.watch", { name }),
        onActivate: () => {
          void navigate(href)
        },
        onLongPress: () =>
          actionSheet.open(
            name,
            buildCatalogMenuActions({ kind: "live", id: fav.id, name, logo: logoUrl, playlistId, href })
          ),
      }
      items.push(item)
      const liveFocusKey = cardFocusKey(railId, "live", fav.id)
      heroBuilders.set(liveFocusKey, () => buildLiveHeroItem(railTitle, item, channel, playlistId))
      if (channel && liveEpgSource === "short-epg") {
        requestLiveNowNext(channel, playlistId, liveFocusKey, onLiveNowNextResolved)
      }
      continue
    }

    const lookup = fav.kind === "vod" ? vodById.get(Number(fav.id)) : seriesById.get(Number(fav.id))
    const meta = getFavoriteMeta(playlistId, fav.kind, fav.id)
    const fallbackKey = fav.kind === "vod" ? "list.movieFallback" : "list.seriesFallback"
    const name = meta?.name || lookup?.name || t(fallbackKey, { id: fav.id })
    const posterUrl = meta?.logo ?? lookup?.logo ?? null
    const href =
      fav.kind === "vod"
        ? `/tv/movies/detail?id=${encodeURIComponent(String(fav.id))}`
        : `/tv/series/detail?id=${encodeURIComponent(String(fav.id))}`
    const item: PosterCardItem = {
      railId,
      kind: fav.kind,
      id: fav.id,
      name,
      href,
      posterUrl,
      meta: metaForCatalogEntry(lookup),
      ariaLabel: t("tv.aria.open", { name }),
      onLongPress: () =>
        actionSheet.open(
          name,
          buildCatalogMenuActions({ kind: fav.kind, id: fav.id, name, logo: posterUrl, playlistId, href })
        ),
    }
    items.push(item)
    const favFocusKey = cardFocusKey(railId, fav.kind as CardKind, fav.id)
    backdropRefs.set(favFocusKey, { kind: fav.kind, id: fav.id })
    heroBuilders.set(favFocusKey, () => {
      const backdrop = heroBackdropImage(playlistId, fav.kind, fav.id, posterUrl, favFocusKey, onBackdropResolved)
      return {
        eyebrow: railTitle,
        title: name,
        meta: metaForCatalogEntry(lookup),
        imageUrl: backdrop.imageUrl,
        imageKind: backdrop.imageKind,
        onActivate: () => {
          void navigate(href)
        },
      }
    })
    const chipInfo = chipInfoForEntry(fav.kind, Number(fav.id), playlistId, fav.kind === "vod" ? vodRows : seriesRows)
    if (chipInfo) chipInfoByFocusKey.set(cardFocusKey(railId, fav.kind as CardKind, fav.id), chipInfo)
  }
  return items
}

function buildWatchlistItems(
  railId: string,
  railTitle: string,
  filterKind: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>,
  backdropRefs: Map<string, BackdropRef>,
  chipInfoByFocusKey: Map<string, ChipInfoRecord>,
  actionSheet: ActionSheetHandle,
  onBackdropResolved: (focusKey: string) => void
): CardItem[] {
  const kinds: Array<"vod" | "series"> = filterKind === "all" ? ["vod", "series"] : [filterKind as "vod" | "series"]
  const vodRows = (getCached(playlistId, "vod")?.data || []) as CatalogRow[]
  const seriesRows = (getCached(playlistId, "series")?.data || []) as CatalogRow[]

  const rows: Array<{ kind: "vod" | "series"; id: number; ts: number; meta: WatchlistRowMeta }> = []
  for (const kind of kinds) {
    const bag = getWatchlist(playlistId, kind) as Record<string, WatchlistRowMeta>
    for (const [stringId, meta] of Object.entries(bag)) {
      rows.push({ kind, id: Number(stringId), ts: meta?.ts || 0, meta })
    }
  }
  rows.sort((left, right) => right.ts - left.ts)

  const shown = rows.slice(0, RAIL_ITEM_LIMIT)
  const wantedIds = (wantedKind: "vod" | "series") =>
    new Set<number>(shown.filter((row) => row.kind === wantedKind).map((row) => row.id))
  const vodById = pickRowsById(vodRows, wantedIds("vod"))
  const seriesById = pickRowsById(seriesRows, wantedIds("series"))

  const items: CardItem[] = []
  for (const row of shown) {
    const lookup = row.kind === "vod" ? vodById.get(row.id) : seriesById.get(row.id)
    const fallbackKey = row.kind === "vod" ? "list.movieFallback" : "list.seriesFallback"
    const name = row.meta?.name || lookup?.name || t(fallbackKey, { id: row.id })
    const posterUrl = row.meta?.logo ?? lookup?.logo ?? null
    const href =
      row.kind === "vod"
        ? `/tv/movies/detail?id=${encodeURIComponent(String(row.id))}`
        : `/tv/series/detail?id=${encodeURIComponent(String(row.id))}`
    const item: PosterCardItem = {
      railId,
      kind: row.kind,
      id: row.id,
      name,
      href,
      posterUrl,
      meta: metaForCatalogEntry(lookup),
      ariaLabel: t("tv.aria.open", { name }),
      onLongPress: () =>
        actionSheet.open(
          name,
          buildCatalogMenuActions({ kind: row.kind, id: row.id, name, logo: posterUrl, playlistId, href, includeWatchlist: true })
        ),
    }
    items.push(item)
    const watchlistFocusKey = cardFocusKey(railId, row.kind, row.id)
    backdropRefs.set(watchlistFocusKey, { kind: row.kind, id: row.id })
    heroBuilders.set(watchlistFocusKey, () => {
      const backdrop = heroBackdropImage(playlistId, row.kind, row.id, posterUrl, watchlistFocusKey, onBackdropResolved)
      return {
        eyebrow: railTitle,
        title: name,
        meta: metaForCatalogEntry(lookup),
        imageUrl: backdrop.imageUrl,
        imageKind: backdrop.imageKind,
        onActivate: () => {
          void navigate(href)
        },
      }
    })
    const chipInfo = chipInfoForEntry(row.kind, row.id, playlistId, row.kind === "vod" ? vodRows : seriesRows)
    if (chipInfo) chipInfoByFocusKey.set(cardFocusKey(railId, row.kind, row.id), chipInfo)
  }
  return items
}

interface NewestEntry {
  kind: "vod" | "series"
  row: CatalogRow
  ts: number
}

/** Keeps the RAIL_ITEM_LIMIT newest rows in one pass; sorting a 20k catalog for 20 cards was the mount cost. */
function collectNewest(rows: CatalogRow[], kind: "vod" | "series", newest: NewestEntry[]): void {
  for (const row of rows) {
    const ts = row?.added || 0
    if (!row?.id || ts <= 0) continue
    if (newest.length === RAIL_ITEM_LIMIT && ts <= newest[newest.length - 1].ts) continue
    let index = newest.length
    while (index > 0 && newest[index - 1].ts < ts) index--
    newest.splice(index, 0, { kind, row, ts })
    if (newest.length > RAIL_ITEM_LIMIT) newest.pop()
  }
}

function buildRecentlyAddedItems(
  railId: string,
  railTitle: string,
  filterKind: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>,
  backdropRefs: Map<string, BackdropRef>,
  chipInfoByFocusKey: Map<string, ChipInfoRecord>,
  actionSheet: ActionSheetHandle,
  onBackdropResolved: (focusKey: string) => void
): CardItem[] {
  const wantVod = filterKind === "all" || filterKind === "vod"
  const wantSeries = filterKind === "all" || filterKind === "series"
  const vodRows = wantVod ? ((getCached(playlistId, "vod")?.data || []) as CatalogRow[]) : []
  const seriesRows = wantSeries ? ((getCached(playlistId, "series")?.data || []) as CatalogRow[]) : []

  const newest: Array<{ kind: "vod" | "series"; row: CatalogRow; ts: number }> = []
  collectNewest(vodRows, "vod", newest)
  collectNewest(seriesRows, "series", newest)

  const items: CardItem[] = []
  for (const entry of newest) {
    const fallbackKey = entry.kind === "vod" ? "list.movieFallback" : "list.seriesFallback"
    const name = entry.row.name || t(fallbackKey, { id: entry.row.id })
    const posterUrl = entry.row.logo || null
    const href =
      entry.kind === "vod"
        ? `/tv/movies/detail?id=${encodeURIComponent(String(entry.row.id))}`
        : `/tv/series/detail?id=${encodeURIComponent(String(entry.row.id))}`
    const item: PosterCardItem = {
      railId,
      kind: entry.kind,
      id: entry.row.id,
      name,
      href,
      posterUrl,
      meta: metaForCatalogEntry(entry.row),
      ariaLabel: t("tv.aria.open", { name }),
      onLongPress: () =>
        actionSheet.open(
          name,
          buildCatalogMenuActions({
            kind: entry.kind,
            id: entry.row.id,
            name,
            logo: posterUrl,
            playlistId,
            href,
            includeWatchlist: true,
          })
        ),
    }
    items.push(item)
    const recentFocusKey = cardFocusKey(railId, entry.kind, entry.row.id)
    backdropRefs.set(recentFocusKey, { kind: entry.kind, id: entry.row.id })
    heroBuilders.set(recentFocusKey, () => {
      const backdrop = heroBackdropImage(playlistId, entry.kind, entry.row.id, posterUrl, recentFocusKey, onBackdropResolved)
      return {
        eyebrow: railTitle,
        title: name,
        meta: metaForCatalogEntry(entry.row),
        imageUrl: backdrop.imageUrl,
        imageKind: backdrop.imageKind,
        onActivate: () => {
          void navigate(href)
        },
      }
    })
    const chipInfo = chipInfoForEntry(
      entry.kind,
      Number(entry.row.id),
      playlistId,
      entry.kind === "vod" ? vodRows : seriesRows
    )
    if (chipInfo) chipInfoByFocusKey.set(cardFocusKey(railId, entry.kind, entry.row.id), chipInfo)
  }
  return items
}

function buildItemsForStrip(
  strip: HubStrip,
  railTitle: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>,
  backdropRefs: Map<string, BackdropRef>,
  chipInfoByFocusKey: Map<string, ChipInfoRecord>,
  actionSheet: ActionSheetHandle,
  onBackdropResolved: (focusKey: string) => void,
  onLiveNowNextResolved: (focusKey: string) => void
): CardItem[] {
  switch (strip.type) {
    case "continue-watching":
      return buildContinueWatchingItems(
        strip.id, railTitle, playlistId, heroBuilders, backdropRefs, actionSheet, onBackdropResolved,
        onLiveNowNextResolved
      )
    case "favorites":
      return buildFavoritesItems(
        strip.id, railTitle, strip.kind, playlistId, heroBuilders, backdropRefs, chipInfoByFocusKey, actionSheet,
        onBackdropResolved, onLiveNowNextResolved
      )
    case "watchlist":
      return buildWatchlistItems(
        strip.id, railTitle, strip.kind, playlistId, heroBuilders, backdropRefs, chipInfoByFocusKey, actionSheet,
        onBackdropResolved
      )
    case "recently-added":
      return buildRecentlyAddedItems(
        strip.id, railTitle, strip.kind, playlistId, heroBuilders, backdropRefs, chipInfoByFocusKey, actionSheet,
        onBackdropResolved
      )
    default:
      return []
  }
}

function computeStrips(): HubStrip[] {
  return (getHubStrips() as HubStrip[]).filter((strip) => strip.type !== "because-watched")
}

// Fisher-Yates, matching the because-watched strip's "randomize once, then cycle" pool philosophy.
function shuffle<T>(items: T[]): T[] {
  const shuffled = items.slice()
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }
  return shuffled
}

/** Eager posters are resident decoded bitmaps; lite never eager-loads any. */
function eagerCardCount(): number {
  return memoryConservative() ? 0 : RAIL_EAGER_CARD_COUNT
}

/** New cards get an eager poster load when the rail sits within RAIL_EAGER_FOLD_VIEWPORTS of the top. */
function railEagerCount(rail: RailHandle, viewportHeight: number): number {
  if (memoryConservative()) return 0
  const top = rail.el.getBoundingClientRect().top
  return top <= viewportHeight * RAIL_EAGER_FOLD_VIEWPORTS ? eagerCardCount() : 0
}

function scheduleIdle(fn: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout: 2000 })
  } else {
    setTimeout(fn, 500)
  }
}

const PREPAINT_RAIL_LIMIT = 2

// Set once init() finishes a rail build; lets prepaint read the cache synchronously on a later visit.
let lastWarmPlaylistId = ""

// Memory-conservative TVs on an Xtream playlist resolve live-card now/next off the
// per-channel short-EPG client instead of the bulk XMLTV feed; set once per init().
let liveEpgSource: TvEpgSource = "xmltv-full"
let liveEpgCreds: XtreamCreds | null = null
const liveNowNextCache = new Map<string, ShortEpgNowNext>()

function liveNowNextCacheKey(playlistId: string, channelId: number | string): string {
  return `${playlistId}:${channelId}`
}

function requestLiveNowNext(
  channel: LiveChannelRow,
  playlistId: string,
  focusKey: string,
  onResolved: (focusKey: string) => void
): void {
  if (!liveEpgCreds) return
  void tvShortEpgCache().getNowNext(liveEpgCreds, channel.id).then((nowNext) => {
    if (!nowNext) return
    liveNowNextCache.set(liveNowNextCacheKey(playlistId, channel.id), nowNext)
    onResolved(focusKey)
  })
}

interface PrepaintedHome {
  root: HTMLElement
  scroller: HTMLElement
  track: HTMLElement
  hero: HeroHandle
  actionSheet: ActionSheetHandle
  railHandles: Map<string, RailHandle>
}
let prepaintedHome: PrepaintedHome | null = null

function discardPrepaintedHome(): void {
  const stale = prepaintedHome
  if (!stale) return
  prepaintedHome = null
  for (const rail of stale.railHandles.values()) rail.destroy()
  stale.railHandles.clear()
  stale.hero.destroy()
  stale.actionSheet.destroy()
  stale.scroller.remove()
}

const view: TvView = {
  releasePrepaint: discardPrepaintedHome,
  prepaint(root: HTMLElement): boolean {
    if (!lastWarmPlaylistId) return false
    const playlistId = lastWarmPlaylistId
    const strips = computeStrips().filter((strip) => RAIL_TITLE_KEY[strip.id])
    if (!strips.length) return false

    const scroller = document.createElement("div")
    scroller.className = "h-full overflow-hidden px-[var(--tv-focus-pad)] -mx-[var(--tv-focus-pad)]"
    const track = document.createElement("div")
    track.className = "flex flex-col gap-10 pb-20"
    scroller.appendChild(track)

    const hero = createHero(track)
    const actionSheet: ActionSheetHandle = createActionSheet("tv-home-actions-dialog")
    const railHandles = new Map<string, RailHandle>()
    const openedEntry = takeLastOpenedEntry()
    let openedEntryHandled = false
    let firstHeroItem: HeroItem | null = null

    for (const strip of strips.slice(0, PREPAINT_RAIL_LIMIT)) {
      const railTitle = t(RAIL_TITLE_KEY[strip.id])
      const rail = createRail({ title: railTitle, focusSectionId: `tv-home-rail:${strip.id}` })
      const heroBuilders = new Map<string, () => HeroItem>()
      const backdropRefs = new Map<string, BackdropRef>()
      const chipInfoByFocusKey = new Map<string, ChipInfoRecord>()
      const items = buildItemsForStrip(
        strip, railTitle, playlistId, heroBuilders, backdropRefs, chipInfoByFocusKey, actionSheet, () => {}, () => {}
      )
      if (!items.length) {
        // Keep the (hidden) rail in DOM order so a later mount can unhide it in place.
        rail.setItems([])
        track.appendChild(rail.el)
        railHandles.set(strip.id, rail)
        continue
      }
      // Prepaint is always the first couple of rails, always above the fold.
      const eagerHere = !renderedRailWithItems || heavyEffectsAllowed() ? eagerCardCount() : 0
      rail.setItems(items, { eagerCount: eagerHere })
      decorateRailChips(rail, items, chipInfoByFocusKey)
      track.appendChild(rail.el)
      railHandles.set(strip.id, rail)

      if (!firstHeroItem) firstHeroItem = heroBuilders.get(cardFocusKey(strip.id, items[0].kind, items[0].id))?.() ?? null
      if (openedEntry && !openedEntryHandled && nameReturningCard(rail.el, `${openedEntry.kind}:${openedEntry.id}`)) {
        openedEntryHandled = true
      }
    }

    if (!anyItems) {
      for (const rail of railHandles.values()) rail.destroy()
      railHandles.clear()
      hero.destroy()
      actionSheet.destroy()
      return false
    let anyItems = false
    let renderedRailWithItems = false
    }
    hero.show(firstHeroItem || { eyebrow: t("welcome.eyebrow"), title: t("welcome.heading"), meta: "" })
    root.appendChild(scroller)

    prepaintedHome = { root, scroller, track, hero, actionSheet, railHandles }
    return true
  },
  mount(root: HTMLElement, _ctx: TvViewContext) {
    const prepainted = prepaintedHome && prepaintedHome.root === root ? prepaintedHome : null
    if (prepainted) prepaintedHome = null
    else discardPrepaintedHome()

    const scroller = prepainted?.scroller ?? document.createElement("div")
    scroller.className = "h-full overflow-hidden px-[var(--tv-focus-pad)] -mx-[var(--tv-focus-pad)]"
      anyItems = true
    const track = prepainted?.track ?? document.createElement("div")
    track.className = "flex flex-col gap-10 pb-20"
    if (!prepainted) {
      renderedRailWithItems = true
      scroller.appendChild(track)
      root.appendChild(scroller)
    }

    const hero = prepainted?.hero ?? createHero(track)
    const railHandles = new Map<string, RailHandle>(prepainted?.railHandles)
    const actionSheet: ActionSheetHandle = prepainted?.actionSheet ?? createActionSheet("tv-home-actions-dialog")
    let heroBuilders = new Map<string, () => HeroItem>()
    let heroBackdropRefs = new Map<string, BackdropRef>()
    let strips: HubStrip[] = []
    let heroInitialized = false
    let lastFocusKey: string | null = null
    let destroyed = false
    let activePlaylistId = ""
    let activeCreds: { host: string; port: string; user: string; pass: string } | null = null
    let epgRequested = false
    let epgRefreshTimer: ReturnType<typeof setInterval> | null = null
    let warmupScheduled = false
    let initialFocusApplied = false
    let heroRotationPool: string[] = []
    let heroRotationIndex = -1
    let heroRotationSeeded = false
    let heroRotationTimer: ReturnType<typeof setInterval> | null = null
    let isRailCardFocused = false

    // Async data lands after the shell's mount-time restoreFocus already ran; grab focus once ourselves.
    function ensureInitialFocus(): void {
      if (initialFocusApplied) return
      const activeElement = document.activeElement
      // The nav rail and open dialogs count as "the user already moved on".
      const userHasFocus =
        activeElement instanceof HTMLElement &&
        activeElement !== document.body &&
        (root.contains(activeElement) || !!activeElement.closest("#tv-nav, dialog[open]"))
      if (userHasFocus) {
        initialFocusApplied = true
        return
      }
      const target =
        root.querySelector<HTMLElement>("[data-tv-autofocus]") ||
        track.querySelector<HTMLElement>(`[data-focus-key]:not([data-focus-key="${HERO_FOCUS_KEY}"])`)
      if (!target) return
      target.focus()
      window.SpatialNavigation?.makeFocusable?.()
      initialFocusApplied = true
    }

    function updateHeroForFocusKey(focusKey: string): void {
      lastFocusKey = focusKey
      const builder = heroBuilders.get(focusKey)
      if (builder) hero.show(builder())
    }

    // A lazy backdrop fetch landing after focus moved elsewhere must not repaint the hero.
    function onBackdropResolved(focusKey: string): void {
      if (destroyed || lastFocusKey !== focusKey) return
      updateHeroForFocusKey(focusKey)
    }

    // Patches the rail card's now-playing text in place - a full rail rebuild for one
    // resolved short-EPG fetch would be the "bulk loop" this wiring is meant to avoid.
    function onLiveNowNextResolved(focusKey: string): void {
      if (destroyed) return
      const channelId = focusKey.split(":").pop()
      const meta = track.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"] [data-card-meta]`)
      if (meta && channelId) {
        const slot = shortEpgNowNextSlot(liveNowNextCache.get(liveNowNextCacheKey(activePlaylistId, channelId)) ?? null)
        meta.textContent = slot.current?.title || ""
      }
      if (lastFocusKey === focusKey) updateHeroForFocusKey(focusKey)
    }

    // Idle-content rotation: ticks only while nothing in the rails holds focus (initial
    // mount, focus on the nav rail, focus on the hero itself). A focused rail card pauses
    // it and drives the hero itself, same as before this rotation existed.
    function tickHeroRotation(): void {
      if (isRailCardFocused || heroRotationPool.length < 2) return
      for (let attempt = 0; attempt < heroRotationPool.length; attempt++) {
        heroRotationIndex = (heroRotationIndex + 1) % heroRotationPool.length
        const key = heroRotationPool[heroRotationIndex]
        if (heroBuilders.has(key)) {
          updateHeroForFocusKey(key)
          return
        }
      }
    }

    function stopHeroRotation(): void {
      if (!heroRotationTimer) return
      clearInterval(heroRotationTimer)
      heroRotationTimer = null
    }

    // Always restarts the countdown so a late focus swap can't make it fire moments later.
    // Lite skips the timer entirely - idle rotation would keep decoding full-size backdrops.
    function startHeroRotation(): void {
      stopHeroRotation()
      if (memoryConservative() || heroRotationPool.length < 2) return
      heroRotationTimer = setInterval(tickHeroRotation, HERO_ROTATION_INTERVAL_MS)
    }

    function applyHeroRotationState(): void {
      if (isRailCardFocused) stopHeroRotation()
      else startHeroRotation()
    }

    const onFocusInDebounced = debounce((focusKeyEl: HTMLElement) => {
      updateHeroForFocusKey(focusKeyEl.dataset.focusKey || "")
    }, HERO_FOCUS_DEBOUNCE_MS)

    function onFocusIn(event: FocusEvent): void {
      const target = event.target
      const focusKeyEl = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-focus-key]") : null
      // Focusing the hero itself, or anything outside the rail track (e.g. the nav rail),
      // counts as idle - only a focused rail card drives the hero directly.
      const isTrackCard = !!focusKeyEl && track.contains(focusKeyEl) && focusKeyEl.dataset.focusKey !== HERO_FOCUS_KEY
      isRailCardFocused = isTrackCard
      applyHeroRotationState()
      if (isTrackCard) {
        onFocusInDebounced(focusKeyEl!)
        // Lite tier skips backdrop warming and cross-rail warming entirely; the rail's own
        // same-rail neighbour poster warm-up (rail.ts) is cheap enough to keep either way.
        if (heavyEffectsAllowed()) {
          prefetchNeighbourHeroBackdrops(focusKeyEl!)
          warmAdjacentRailImages(focusKeyEl!)
        }
      }
    }

    // Only warms a backdrop already sitting in the vod_info/series_info cache - never a fresh fetch.
    function prefetchNeighbourHeroBackdrops(focusedCard: HTMLElement): void {
      const railTrack = focusedCard.closest<HTMLElement>("[data-rail-track]")
      if (!railTrack) return
      for (const neighbour of neighboursOf(railTrack, focusedCard, HERO_BACKDROP_PREFETCH_RADIUS)) {
        const ref = heroBackdropRefs.get(neighbour.dataset.focusKey || "")
        if (!ref) continue
        warmImageUrl(cachedBackdropUrl(activePlaylistId, ref.kind, ref.id))
      }
    }

    function stripIndexForCard(card: HTMLElement): number {
      return strips.findIndex((strip) => railHandles.get(strip.id)?.el.contains(card))
    }

    // The next ArrowDown/Up shows the rail above/below before its own images finish decoding
    // otherwise, since it only starts loading once its cards actually enter the viewport.
    function warmAdjacentRailImages(focusedCard: HTMLElement): void {
      const index = stripIndexForCard(focusedCard)
      if (index < 0) return
      for (const neighbourIndex of [index - 1, index + 1]) {
        const rail = strips[neighbourIndex] && railHandles.get(strips[neighbourIndex].id)
        if (!rail) continue
        const cards = rail.el.querySelectorAll<HTMLElement>("[data-prefetch-url]")
        for (let i = 0; i < cards.length && i < RAIL_IMAGE_WARM_COUNT; i++) warmImageUrl(cards[i].dataset.prefetchUrl)
      }
    }
    document.addEventListener("focusin", onFocusIn)

    const offsetPx = Math.round(root.clientHeight * VERTICAL_OFFSET_RATIO) || 240
    const unregisterKeepInView = keepFocusedInView(scroller, "y", offsetPx)

    function applyAutofocusMarker(focusKey: string | null): void {
      const previous = track.querySelector<HTMLElement>("[data-tv-autofocus]")
      if (previous) delete previous.dataset.tvAutofocus
      if (!focusKey) return
      const target = track.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)
      if (target) target.dataset.tvAutofocus = ""
    }

    function destroyRails(): void {
      for (const rail of railHandles.values()) rail.destroy()
      railHandles.clear()
    }

    function initRailSkeletons(preserveExisting = false): void {
      if (!preserveExisting) destroyRails()
      for (const strip of strips) {
        if (preserveExisting && railHandles.has(strip.id)) continue
        const titleKey = RAIL_TITLE_KEY[strip.id]
        if (!titleKey) continue
        const rail = createRail({ title: t(titleKey), focusSectionId: `tv-home-rail:${strip.id}` })
        rail.setLoading()
        track.appendChild(rail.el)
        railHandles.set(strip.id, rail)
      }
    }

    // now-next mode bakes "now" into the parse at load time, so unlike full mode it
    // needs an active refresh to notice a programme ending - see motion.ts.
    function startEpgRefreshTimer(): void {
      if (epgRefreshTimer || epgLoadMode() !== "now-next" || liveEpgSource === "short-epg") return
      epgRefreshTimer = setInterval(() => {
        if (!activeCreds) return
        void loadProgrammes(activePlaylistId, activeCreds, {
          force: true,
          window: epgLoadWindow(),
          epgMode: epgLoadMode(),
        }).then(() => {
          if (!destroyed) void rebuildAllRails()
        })
      }, EPG_NOW_NEXT_REFRESH_MS)
    }

    function maybeLoadEpg(): void {
      if (liveEpgSource === "short-epg" || !activeCreds || epgRequested) return
      const hasLiveCard = [...heroBuilders.keys()].some((key) => key.includes(":live:"))
      if (!hasLiveCard) return
      epgRequested = true
      void loadProgrammes(activePlaylistId, activeCreds, { window: epgLoadWindow(), epgMode: epgLoadMode() }).catch(
        () => {}
      )
      startEpgRefreshTimer()
    }

    function scheduleWarmup(): void {
      if (warmupScheduled || !activePlaylistId) return
      warmupScheduled = true
      scheduleIdle(() => {
        import("@/scripts/lib/catalog.js")
          .then((mod) => mod.warmupActive(activePlaylistId))
          .catch(() => {})
      })
    }

    async function rebuildAllRails(): Promise<void> {
      if (destroyed || !activePlaylistId) return
      const nextHeroBuilders = new Map<string, () => HeroItem>()
      const nextBackdropRefs = new Map<string, BackdropRef>()
      const rotationCandidates: string[] = []
      let firstFocusKey: string | null = null
      const viewportHeight = root.clientHeight || window.innerHeight

      for (const strip of strips) {
        const rail = railHandles.get(strip.id)
        if (!rail) continue
        const titleKey = RAIL_TITLE_KEY[strip.id]
        const railTitle = titleKey ? t(titleKey) : strip.id
        const chipInfoByFocusKey = new Map<string, ChipInfoRecord>()
        const items = buildItemsForStrip(
          strip, railTitle, activePlaylistId, nextHeroBuilders, nextBackdropRefs, chipInfoByFocusKey, actionSheet,
          onBackdropResolved, onLiveNowNextResolved
        )
        rail.setItems(items, { eagerCount: railEagerCount(rail, viewportHeight) })
        decorateRailChips(rail, items, chipInfoByFocusKey)
        if (items.length && !firstFocusKey) {
          firstFocusKey = cardFocusKey(strip.id, items[0].kind, items[0].id)
        }
        // Hero rotation pool: continue-watching's movies/episodes (its newest entry too,
        // even when that's a live channel - the "last watched channel" exception) plus
        // whatever's in the recently-added rail(s). No other live channels ever qualify.
        if (strip.type === "continue-watching") {
          items.forEach((item, index) => {
            if (item.kind !== "live" || index === 0) rotationCandidates.push(cardFocusKey(strip.id, item.kind, item.id))
          })
        } else if (strip.type === "recently-added") {
          for (const item of items) rotationCandidates.push(cardFocusKey(strip.id, item.kind, item.id))
        }
      }

      heroBuilders = nextHeroBuilders
      heroBackdropRefs = nextBackdropRefs
      applyAutofocusMarker(firstFocusKey)
      ensureInitialFocus()

      if (!heroRotationSeeded && rotationCandidates.length) {
        heroRotationPool = shuffle(rotationCandidates)
        heroRotationIndex = -1
        heroRotationSeeded = true
      }
      applyHeroRotationState()

      if (!heroInitialized) {
        heroInitialized = true
        if (firstFocusKey) updateHeroForFocusKey(firstFocusKey)
        else hero.show({ eyebrow: t("welcome.eyebrow"), title: t("welcome.heading"), meta: "" })
      } else if (lastFocusKey && heroBuilders.has(lastFocusKey)) {
        hero.show(heroBuilders.get(lastFocusKey)!())
      }

      maybeLoadEpg()
    }

    function onCatalogChanged(): void {
      void rebuildAllRails()
    }

    // The provider's short-EPG endpoint proved empirically empty - switch to the
    // streaming XMLTV path exactly as if it had won at boot.
    function onEpgSourceChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (liveEpgSource !== "short-epg" || !detail || detail.playlistId !== activePlaylistId) return
      liveEpgSource = detail.source
      maybeLoadEpg()
    }

    function onEpgOffsetChanged(event: Event): void {
      if (liveEpgSource === "short-epg") return
      const detail = (event as CustomEvent).detail
      if (!activeCreds || !detail || detail.playlistId !== activePlaylistId) return
      void loadProgrammes(activePlaylistId, activeCreds, {
        force: true,
        window: epgLoadWindow(),
        epgMode: epgLoadMode(),
      }).then(() => {
        if (!destroyed) void rebuildAllRails()
      })
    }

    function onHubStripsChanged(): void {
      strips = computeStrips()
      initRailSkeletons()
      void rebuildAllRails()
    }

    function onLocaleChanged(): void {
      initRailSkeletons()
      void rebuildAllRails()
    }

    document.addEventListener(CATALOG_WARMED_EVENT, onCatalogChanged)
    document.addEventListener("xt:favorites-changed", onCatalogChanged)
    document.addEventListener("xt:watchlist-changed", onCatalogChanged)
    document.addEventListener("xt:progress-changed", onCatalogChanged)
    document.addEventListener("xt:recents-changed", onCatalogChanged)
    document.addEventListener(LANGUAGE_GROUPING_EVENT, onCatalogChanged)
    document.addEventListener(CONTENT_LANGUAGE_EVENT, onCatalogChanged)
    document.addEventListener(EPG_LOADED_EVENT, onCatalogChanged)
    document.addEventListener(EPG_OFFSET_EVENT, onEpgOffsetChanged)
    document.addEventListener(TV_EPG_SOURCE_CHANGED_EVENT, onEpgSourceChanged)
    document.addEventListener(HUB_STRIPS_EVENT, onHubStripsChanged)
    document.addEventListener(LOCALE_EVENT, onLocaleChanged)

    async function init(): Promise<void> {
      const active = await getActiveEntry()
      if (destroyed) return

      if (!active) {
        hero.show({
          eyebrow: t("welcome.eyebrow"),
          title: "Extreme InfiniTV",
          meta: t("welcome.sub"),
          cta: { href: "/tv/login", label: t("playlist.addCta"), autofocus: true },
        })
        ensureInitialFocus()
        return
      }

      activePlaylistId = active._id
      activeCreds = await loadCreds()
      if (destroyed) return
      liveEpgCreds = activeCreds ? toXtreamCreds(activePlaylistId, activeCreds) : null
      liveEpgSource = tvEpgSource(liveEpgCreds)

      await ensurePrefsLoaded()
      if (destroyed) return

      strips = computeStrips()
      initRailSkeletons(!!prepainted)

      // catalog.js's own warmup events never cover this step: a cold-memory,
      // warm-IndexedDB reload spends its slow time right here, inside hydrateCache,
      // before warmupActive (scheduled idle, after first paint) ever runs.
      const catalogWasHot =
        !!getCached(activePlaylistId, "vod") &&
        !!getCached(activePlaylistId, "series") &&
        (!!getCached(activePlaylistId, "live") || !!getCached(activePlaylistId, "m3u"))
      if (!catalogWasHot) {
        document.dispatchEvent(
          new CustomEvent(CATALOG_WARMING_START_EVENT, {
            detail: { playlistId: activePlaylistId, kinds: ["live", "vod", "series"] },
          })
        )
      }
      const reportHydrated = (kind: string) => {
        if (catalogWasHot) return
        document.dispatchEvent(
          new CustomEvent(CATALOG_WARMING_PROGRESS_EVENT, {
            detail: { playlistId: activePlaylistId, kind, status: "done" },
          })
        )
      }

      await Promise.allSettled([
        hydrateCache(activePlaylistId, "vod").finally(() => reportHydrated("vod")),
        hydrateCache(activePlaylistId, "series").finally(() => reportHydrated("series")),
        Promise.allSettled([hydrateCache(activePlaylistId, "live"), hydrateCache(activePlaylistId, "m3u")]).finally(() =>
          reportHydrated("live")
        ),
      ])
      if (destroyed) return
      await ensureOverridesReady()
      if (destroyed) return

      await rebuildAllRails()
      lastWarmPlaylistId = activePlaylistId
      if (!catalogWasHot) document.dispatchEvent(new CustomEvent(CATALOG_WARMED_EVENT, { detail: { playlistId: activePlaylistId } }))
      scheduleWarmup()
    }

    void init()

    return () => {
      destroyed = true
      if (epgRefreshTimer) clearInterval(epgRefreshTimer)
      document.removeEventListener(CATALOG_WARMED_EVENT, onCatalogChanged)
      document.removeEventListener("xt:favorites-changed", onCatalogChanged)
      document.removeEventListener("xt:watchlist-changed", onCatalogChanged)
      document.removeEventListener("xt:progress-changed", onCatalogChanged)
      document.removeEventListener("xt:recents-changed", onCatalogChanged)
      document.removeEventListener(LANGUAGE_GROUPING_EVENT, onCatalogChanged)
      document.removeEventListener(CONTENT_LANGUAGE_EVENT, onCatalogChanged)
      document.removeEventListener(EPG_LOADED_EVENT, onCatalogChanged)
      document.removeEventListener(EPG_OFFSET_EVENT, onEpgOffsetChanged)
      document.removeEventListener(TV_EPG_SOURCE_CHANGED_EVENT, onEpgSourceChanged)
      document.removeEventListener(HUB_STRIPS_EVENT, onHubStripsChanged)
      document.removeEventListener(LOCALE_EVENT, onLocaleChanged)
      document.removeEventListener("focusin", onFocusIn)
      stopHeroRotation()
      destroyRails()
      hero.destroy()
      actionSheet.destroy()
      unregisterKeepInView()
      scroller.remove()
    }
  },
}

export default view
