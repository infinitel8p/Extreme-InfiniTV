import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT, getActiveLocale } from "@/scripts/lib/i18n"
import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  getContinueWatching,
  getGlobalFavorites,
  getFavoriteMeta,
  getWatchlist,
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
import { createGroupingIndexMemo, type CatalogGroupingIndex } from "@/scripts/lib/language-groups.ts"
import { buildLanguageChips, setLanguageChipsOffset } from "@/scripts/lib/entry-card.ts"
import {
  loadProgrammes,
  getProgrammesSync,
  getNowNextForChannel,
  EPG_LOADED_EVENT,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"
import { debounce } from "@/scripts/lib/debounce.ts"
import { formatTimeRange } from "@/scripts/lib/now-next"
import { keepFocusedInView } from "@/scripts/tv/focus"
import { createHero, HERO_FOCUS_KEY, type HeroItem } from "@/scripts/tv/ui/hero"
import { createRail, type RailHandle } from "@/scripts/tv/ui/rail"
import {
  cardFocusKey,
  formatCardMeta,
  type CardItem,
  type CardKind,
  type PosterCardItem,
  type LiveCardItem,
} from "@/scripts/tv/ui/card"

// Literal so this cache-only page never statically imports catalog.js
const CATALOG_WARMED_EVENT = "xt:catalog-warmed"

const RAIL_ITEM_LIMIT = 20
const HERO_FOCUS_DEBOUNCE_MS = 80
const VERTICAL_OFFSET_RATIO = 0.4

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

type GroupableRow = { id: number; name: string; year?: string; tmdb?: number | null }

const getVodGroupingIndexFor = createGroupingIndexMemo()
const getSeriesGroupingIndexFor = createGroupingIndexMemo()

function toGroupableEntries(rows: CatalogRow[]): GroupableRow[] {
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name || "",
    year: row.year != null ? String(row.year) : undefined,
    tmdb: row.tmdb ?? null,
  }))
}

// Keyed by the raw catalog array's own reference, so repeated calls within one rebuild
// (and across rebuilds until the cache updates) reuse the same mapped array the memo keys on.
let vodGroupableCacheRef: CatalogRow[] | null = null
let vodGroupableCache: GroupableRow[] = []
let seriesGroupableCacheRef: CatalogRow[] | null = null
let seriesGroupableCache: GroupableRow[] = []

function groupableEntriesFor(kind: "vod" | "series", rows: CatalogRow[]): GroupableRow[] {
  if (kind === "vod") {
    if (vodGroupableCacheRef !== rows) {
      vodGroupableCacheRef = rows
      vodGroupableCache = toGroupableEntries(rows)
    }
    return vodGroupableCache
  }
  if (seriesGroupableCacheRef !== rows) {
    seriesGroupableCacheRef = rows
    seriesGroupableCache = toGroupableEntries(rows)
  }
  return seriesGroupableCache
}

function chipInfoForEntry(
  kind: "vod" | "series",
  entryId: number,
  playlistId: string,
  catalog: CatalogRow[]
): ChipInfoRecord | undefined {
  if (!getLanguageGroupingEnabled() || !catalog.length) return undefined
  const groupable = groupableEntriesFor(kind, catalog)
  const groupingIndex: CatalogGroupingIndex =
    kind === "vod" ? getVodGroupingIndexFor(playlistId, groupable) : getSeriesGroupingIndexFor(playlistId, groupable)
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

function buildContinueWatchingItems(
  railId: string,
  railTitle: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>
): CardItem[] {
  const vodById = new Map<number, CatalogRow>(
    ((getCached(playlistId, "vod")?.data || []) as CatalogRow[]).map((movie) => [Number(movie.id), movie])
  )
  const rows = getContinueWatching(playlistId, RAIL_ITEM_LIMIT) as any[]
  const items: CardItem[] = []

  for (const row of rows) {
    const percent = row.duration > 0 ? Math.max(0, Math.min(100, (row.position / row.duration) * 100)) : 0

    if (row.kind === "vod") {
      const movie = vodById.get(Number(row.id))
      const name = row.name || movie?.name || t("list.movieFallback", { id: row.id })
      const posterUrl = row.logo || movie?.logo || null
      const href = `/tv/movies/detail?id=${encodeURIComponent(String(row.id))}&autoplay=1`
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
      }
      items.push(item)
      heroBuilders.set(cardFocusKey(railId, "vod", row.id), () => ({
        eyebrow: railTitle,
        title: name,
        meta: resumeHeroMeta(percent),
        progressPercent: percent,
        imageUrl: posterUrl,
        imageKind: "poster",
        onActivate: () => {
          window.location.href = href
        },
      }))
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
    }
    items.push(item)
    heroBuilders.set(cardFocusKey(railId, "episode", row.id), () => ({
      eyebrow: railTitle,
      title: name,
      meta: resumeHeroMeta(percent),
      progressPercent: percent,
      imageUrl: posterUrl,
      imageKind: "poster",
      onActivate: () => {
        window.location.href = href
      },
    }))
  }

  return items
}

function buildFavoritesItems(
  railId: string,
  railTitle: string,
  filterKind: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>,
  chipInfoByFocusKey: Map<string, ChipInfoRecord>
): CardItem[] {
  const raw = (getGlobalFavorites(playlistId) as Array<{ kind: "live" | "vod" | "series"; id: number }>).filter(
    (entry) => filterKind === "all" || entry.kind === filterKind
  )
  const liveById = new Map<number, LiveChannelRow>(
    (readCachedLiveChannels(playlistId) as LiveChannelRow[]).map((channel) => [Number(channel.id), channel])
  )
  const vodRows = (getCached(playlistId, "vod")?.data || []) as CatalogRow[]
  const seriesRows = (getCached(playlistId, "series")?.data || []) as CatalogRow[]
  const vodById = new Map<number, CatalogRow>(vodRows.map((movie) => [Number(movie.id), movie]))
  const seriesById = new Map<number, CatalogRow>(seriesRows.map((series) => [Number(series.id), series]))

  const items: CardItem[] = []
  for (const fav of raw.slice(0, RAIL_ITEM_LIMIT)) {
    if (fav.kind === "live") {
      const channel = liveById.get(Number(fav.id))
      const meta = getFavoriteMeta(playlistId, "live", fav.id)
      const name = meta?.name || channel?.name || kindLabel("live")
      const logoUrl = meta?.logo ?? channel?.logo ?? null
      const item: LiveCardItem = {
        railId,
        kind: "live",
        id: fav.id,
        name,
        logoUrl,
        nowTitle: channel ? currentProgrammeFor(channel, playlistId)?.title || "" : "",
        ariaLabel: t("tv.aria.watch", { name }),
        onActivate: () => {
          window.location.href = `/tv/live?channel=${encodeURIComponent(String(fav.id))}`
        },
      }
      items.push(item)
      heroBuilders.set(cardFocusKey(railId, "live", fav.id), () =>
        buildLiveHeroItem(railTitle, item, channel, playlistId)
      )
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
    }
    items.push(item)
    heroBuilders.set(cardFocusKey(railId, fav.kind as CardKind, fav.id), () => ({
      eyebrow: railTitle,
      title: name,
      meta: metaForCatalogEntry(lookup),
      imageUrl: posterUrl,
      imageKind: "poster",
      onActivate: () => {
        window.location.href = href
      },
    }))
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
  chipInfoByFocusKey: Map<string, ChipInfoRecord>
): CardItem[] {
  const kinds: Array<"vod" | "series"> = filterKind === "all" ? ["vod", "series"] : [filterKind as "vod" | "series"]
  const vodRows = (getCached(playlistId, "vod")?.data || []) as CatalogRow[]
  const seriesRows = (getCached(playlistId, "series")?.data || []) as CatalogRow[]
  const vodById = new Map<number, CatalogRow>(vodRows.map((movie) => [Number(movie.id), movie]))
  const seriesById = new Map<number, CatalogRow>(seriesRows.map((series) => [Number(series.id), series]))

  const rows: Array<{ kind: "vod" | "series"; id: number; ts: number; meta: WatchlistRowMeta }> = []
  for (const kind of kinds) {
    const bag = getWatchlist(playlistId, kind) as Record<string, WatchlistRowMeta>
    for (const [stringId, meta] of Object.entries(bag)) {
      rows.push({ kind, id: Number(stringId), ts: meta?.ts || 0, meta })
    }
  }
  rows.sort((left, right) => right.ts - left.ts)

  const items: CardItem[] = []
  for (const row of rows.slice(0, RAIL_ITEM_LIMIT)) {
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
    }
    items.push(item)
    heroBuilders.set(cardFocusKey(railId, row.kind, row.id), () => ({
      eyebrow: railTitle,
      title: name,
      meta: metaForCatalogEntry(lookup),
      imageUrl: posterUrl,
      imageKind: "poster",
      onActivate: () => {
        window.location.href = href
      },
    }))
    const chipInfo = chipInfoForEntry(row.kind, row.id, playlistId, row.kind === "vod" ? vodRows : seriesRows)
    if (chipInfo) chipInfoByFocusKey.set(cardFocusKey(railId, row.kind, row.id), chipInfo)
  }
  return items
}

function buildRecentlyAddedItems(
  railId: string,
  railTitle: string,
  filterKind: string,
  playlistId: string,
  heroBuilders: Map<string, () => HeroItem>,
  chipInfoByFocusKey: Map<string, ChipInfoRecord>
): CardItem[] {
  const wantVod = filterKind === "all" || filterKind === "vod"
  const wantSeries = filterKind === "all" || filterKind === "series"
  const vodRows = wantVod ? ((getCached(playlistId, "vod")?.data || []) as CatalogRow[]) : []
  const seriesRows = wantSeries ? ((getCached(playlistId, "series")?.data || []) as CatalogRow[]) : []

  const merged: Array<{ kind: "vod" | "series"; row: CatalogRow; ts: number }> = [
    ...vodRows.filter((row) => row?.id && (row.added || 0) > 0).map((row) => ({ kind: "vod" as const, row, ts: row.added || 0 })),
    ...seriesRows
      .filter((row) => row?.id && (row.added || 0) > 0)
      .map((row) => ({ kind: "series" as const, row, ts: row.added || 0 })),
  ]
  merged.sort((left, right) => right.ts - left.ts)

  const items: CardItem[] = []
  for (const entry of merged.slice(0, RAIL_ITEM_LIMIT)) {
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
    }
    items.push(item)
    heroBuilders.set(cardFocusKey(railId, entry.kind, entry.row.id), () => ({
      eyebrow: railTitle,
      title: name,
      meta: metaForCatalogEntry(entry.row),
      imageUrl: posterUrl,
      imageKind: "poster",
      onActivate: () => {
        window.location.href = href
      },
    }))
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
  chipInfoByFocusKey: Map<string, ChipInfoRecord>
): CardItem[] {
  switch (strip.type) {
    case "continue-watching":
      return buildContinueWatchingItems(strip.id, railTitle, playlistId, heroBuilders)
    case "favorites":
      return buildFavoritesItems(strip.id, railTitle, strip.kind, playlistId, heroBuilders, chipInfoByFocusKey)
    case "watchlist":
      return buildWatchlistItems(strip.id, railTitle, strip.kind, playlistId, heroBuilders, chipInfoByFocusKey)
    case "recently-added":
      return buildRecentlyAddedItems(strip.id, railTitle, strip.kind, playlistId, heroBuilders, chipInfoByFocusKey)
    default:
      return []
  }
}

function scheduleIdle(fn: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout: 2000 })
  } else {
    setTimeout(fn, 500)
  }
}

const view: TvView = {
  mount(root: HTMLElement, _ctx: TvViewContext) {
    const scroller = document.createElement("div")
    scroller.className = "h-full overflow-hidden"
    const track = document.createElement("div")
    track.className = "flex flex-col gap-10 pb-20"
    scroller.appendChild(track)
    root.appendChild(scroller)

    const hero = createHero(track)
    const railHandles = new Map<string, RailHandle>()
    let heroBuilders = new Map<string, () => HeroItem>()
    let strips: HubStrip[] = []
    let heroInitialized = false
    let lastFocusKey: string | null = null
    let destroyed = false
    let activePlaylistId = ""
    let activeCreds: { host: string; port: string; user: string; pass: string } | null = null
    let epgRequested = false
    let warmupScheduled = false
    let initialFocusApplied = false

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

    const onFocusInDebounced = debounce((focusKeyEl: HTMLElement) => {
      updateHeroForFocusKey(focusKeyEl.dataset.focusKey || "")
    }, HERO_FOCUS_DEBOUNCE_MS)

    function onFocusIn(event: FocusEvent): void {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const focusKeyEl = target.closest<HTMLElement>("[data-focus-key]")
      // Focusing the hero itself must never change what it shows.
      if (focusKeyEl && focusKeyEl.dataset.focusKey !== HERO_FOCUS_KEY) onFocusInDebounced(focusKeyEl)
    }
    track.addEventListener("focusin", onFocusIn)

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

    function initRailSkeletons(): void {
      destroyRails()
      for (const strip of strips) {
        const titleKey = RAIL_TITLE_KEY[strip.id]
        if (!titleKey) continue
        const rail = createRail({ title: t(titleKey), focusSectionId: `tv-home-rail:${strip.id}` })
        rail.setLoading()
        track.appendChild(rail.el)
        railHandles.set(strip.id, rail)
      }
    }

    function maybeLoadEpg(): void {
      if (!activeCreds || epgRequested) return
      const hasLiveCard = [...heroBuilders.keys()].some((key) => key.includes(":live:"))
      if (!hasLiveCard) return
      epgRequested = true
      void loadProgrammes(activePlaylistId, activeCreds).catch(() => {})
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
      let firstFocusKey: string | null = null

      for (const strip of strips) {
        const rail = railHandles.get(strip.id)
        if (!rail) continue
        const titleKey = RAIL_TITLE_KEY[strip.id]
        const railTitle = titleKey ? t(titleKey) : strip.id
        const chipInfoByFocusKey = new Map<string, ChipInfoRecord>()
        const items = buildItemsForStrip(strip, railTitle, activePlaylistId, nextHeroBuilders, chipInfoByFocusKey)
        rail.setItems(items)
        decorateRailChips(rail, items, chipInfoByFocusKey)
        if (items.length && !firstFocusKey) {
          firstFocusKey = cardFocusKey(strip.id, items[0].kind, items[0].id)
        }
      }

      heroBuilders = nextHeroBuilders
      applyAutofocusMarker(firstFocusKey)
      ensureInitialFocus()

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

    function onEpgOffsetChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!activeCreds || !detail || detail.playlistId !== activePlaylistId) return
      void loadProgrammes(activePlaylistId, activeCreds, { force: true }).then(() => {
        if (!destroyed) void rebuildAllRails()
      })
    }

    function onHubStripsChanged(): void {
      strips = (getHubStrips() as HubStrip[]).filter((strip) => strip.type !== "because-watched")
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
    document.addEventListener(LANGUAGE_GROUPING_EVENT, onCatalogChanged)
    document.addEventListener(CONTENT_LANGUAGE_EVENT, onCatalogChanged)
    document.addEventListener(EPG_LOADED_EVENT, onCatalogChanged)
    document.addEventListener(EPG_OFFSET_EVENT, onEpgOffsetChanged)
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

      await ensurePrefsLoaded()
      if (destroyed) return

      strips = (getHubStrips() as HubStrip[]).filter((strip) => strip.type !== "because-watched")
      initRailSkeletons()

      await Promise.allSettled([
        hydrateCache(activePlaylistId, "vod"),
        hydrateCache(activePlaylistId, "series"),
        hydrateCache(activePlaylistId, "live"),
        hydrateCache(activePlaylistId, "m3u"),
      ])
      if (destroyed) return
      await ensureOverridesReady()
      if (destroyed) return

      await rebuildAllRails()
      scheduleWarmup()
    }

    void init()

    return () => {
      destroyed = true
      document.removeEventListener(CATALOG_WARMED_EVENT, onCatalogChanged)
      document.removeEventListener("xt:favorites-changed", onCatalogChanged)
      document.removeEventListener("xt:watchlist-changed", onCatalogChanged)
      document.removeEventListener("xt:progress-changed", onCatalogChanged)
      document.removeEventListener(LANGUAGE_GROUPING_EVENT, onCatalogChanged)
      document.removeEventListener(CONTENT_LANGUAGE_EVENT, onCatalogChanged)
      document.removeEventListener(EPG_LOADED_EVENT, onCatalogChanged)
      document.removeEventListener(EPG_OFFSET_EVENT, onEpgOffsetChanged)
      document.removeEventListener(HUB_STRIPS_EVENT, onHubStripsChanged)
      document.removeEventListener(LOCALE_EVENT, onLocaleChanged)
      track.removeEventListener("focusin", onFocusIn)
      destroyRails()
      hero.destroy()
      unregisterKeepInView()
      scroller.remove()
    }
  },
}

export default view
