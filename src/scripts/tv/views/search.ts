// TV search: one input feeding three ranked rails (channels, movies, series).
import { nextPaint, type TvView, type TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  getRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
  EVT_SEARCH_RECENT_CHANGED,
} from "@/scripts/lib/preferences.js"
import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels, ensureOverridesReady } from "@/scripts/lib/live-catalog.ts"
import { normalize } from "@/scripts/lib/text.js"
import { searchCatalog, SYNC_THRESHOLD } from "@/scripts/tv/catalog-filter-client"
import { kindLabel } from "@/scripts/lib/kinds.ts"
import { ICON_SEARCH } from "@/scripts/lib/icons.js"
import { getActiveLocale } from "@/scripts/lib/i18n"
import { getLanguageGroupingEnabled, getContentLanguage, LANGUAGE_GROUPING_EVENT, CONTENT_LANGUAGE_EVENT } from "@/scripts/lib/app-settings.js"
import {
  getSharedGroupingIndex,
  collapseIntoDisplayGroups,
  isLanguageGroupingExplicitlyEnabled,
  type CatalogGroupingIndex,
} from "@/scripts/lib/language-groups.ts"
import { memoryConservative } from "@/scripts/tv/motion"
import { effectivePreferredTags } from "@/scripts/lib/language-tags.ts"
import { buildLanguageChips, setLanguageChipsOffset } from "@/scripts/lib/entry-card.ts"
import { registerFocusSection, keepFocusedInView } from "@/scripts/tv/focus"
import { createRail, type RailHandle } from "@/scripts/tv/ui/rail"
import { formatCardMeta, type CardItem, type LiveCardItem, type PosterCardItem } from "@/scripts/tv/ui/card"
import { playLive, type TvLiveChannel } from "@/scripts/tv/playback"

// Matches catalog.js's CATALOG_WARMED_EVENT - kept as a string so this view doesn't
// statically import the whole fetch stack just to know when it's stale.
const CATALOG_WARMED_EVENT = "xt:catalog-warmed"

const SEARCH_DEBOUNCE_MS = 120
const MIN_QUERY_LENGTH = 2
const RESULT_CAP = 30

// Lite tier skips the multi-map grouping index unless the user explicitly opted in.
function languageGroupingAllowed(): boolean {
  return memoryConservative() ? isLanguageGroupingExplicitlyEnabled() : getLanguageGroupingEnabled()
}

interface CatalogRow {
  id: number | string
  name?: string
  logo?: string | null
  category?: string | null
  rating?: unknown
  year?: string | number | null
  norm?: string
  tmdb?: number | null
}

interface ChipInfoRecord {
  tags: string[]
  variantCount: number
  displayTag: string | null
}

// Collapses ranked matches down to one card per title group, keeping rank order; chip info keyed by display row id.
// The index is resolved lazily so a grouping-off run never pays for building one.
function collapseRankedMatches<T extends CatalogRow & { norm: string }>(
  matches: T[],
  resolveGroupingIndex: () => CatalogGroupingIndex,
  preferredTags: string[]
): { rows: T[]; chipInfoById: Map<number, ChipInfoRecord> } {
  if (!languageGroupingAllowed()) return { rows: matches, chipInfoById: new Map() }
  const groupingIndex = resolveGroupingIndex()
  const groups = collapseIntoDisplayGroups(
    matches.map((row) => ({ ...row, id: Number(row.id) })),
    groupingIndex,
    preferredTags
  )
  const rows = groups.map((group) => matches.find((row) => Number(row.id) === group.displayEntry.id) || group.displayEntry) as T[]
  const chipInfoById = new Map<number, ChipInfoRecord>()
  for (const group of groups) {
    if (group.tags.length < 2 && group.globalEntryIds.length < 2) continue
    chipInfoById.set(group.displayEntry.id, {
      tags: group.tags,
      variantCount: group.globalEntryIds.length,
      displayTag: groupingIndex.tagByEntryId.get(group.displayEntry.id) ?? null,
    })
  }
  return { rows, chipInfoById }
}

// Result rails render synchronously (no row-windowing), so decorating after setItems is a one-shot pass.
function decorateRailChips(rail: RailHandle, items: CardItem[], chipInfoById: Map<number, ChipInfoRecord>): void {
  const cards = rail.el.querySelectorAll<HTMLElement>("[data-focus-key]")
  cards.forEach((card, index) => {
    const item = items[index]
    const info = item && chipInfoById.get(Number(item.id))
    if (!info) return
    const posterWrap = card.querySelector<HTMLElement>("[data-poster-wrap]")
    if (!posterWrap) return
    const chip = buildLanguageChips(info.tags, info.variantCount, getActiveLocale(), info.displayTag)
    if (!chip) return
    posterWrap.appendChild(chip)
    setLanguageChipsOffset(posterWrap, false)
  })
}

interface LiveRow extends CatalogRow {
  url?: string | null
  userAgent?: string | null
  referer?: string | null
  tvgId?: string | null
  tvgShift?: number | null
}

function toTvLiveChannel(row: LiveRow & { norm: string }): TvLiveChannel {
  return {
    id: row.id,
    name: row.name || "",
    logo: row.logo ?? null,
    url: row.url ?? null,
    userAgent: row.userAgent ?? null,
    referer: row.referer ?? null,
    tvgId: row.tvgId ?? null,
    tvgShift: row.tvgShift ?? null,
  }
}

// Cached rows already carry `norm`; fill the odd gap in place rather than copying a whole catalog.
function withNorms<T extends { name?: string; category?: string | null; norm?: string }>(
  rows: T[]
): Array<T & { norm: string }> {
  for (const row of rows) {
    if (!row.norm) row.norm = normalize(`${row.name || ""} ${row.category || ""}`)
  }
  return rows as Array<T & { norm: string }>
}

function metaForCatalogRow(row: CatalogRow): string {
  return formatCardMeta(row.year, row.rating)
}

const view: TvView = {
  mount(root: HTMLElement, ctx: TvViewContext) {
    const scroller = document.createElement("div")
    scroller.className = "h-full overflow-hidden"
    const track = document.createElement("div")
    track.className = "flex flex-col gap-6 pt-2 pb-10"
    scroller.appendChild(track)
    root.appendChild(scroller)

    const inputWrap = document.createElement("div")
    const inputBox = document.createElement("div")
    inputBox.className = "flex min-h-11 items-center gap-3 rounded-2xl bg-surface-2 px-5 tv-focus-inset-within"
    const searchIcon = document.createElement("span")
    searchIcon.setAttribute("aria-hidden", "true")
    searchIcon.className = "shrink-0 text-fg-3"
    searchIcon.innerHTML = ICON_SEARCH
    const inputEl = document.createElement("input")
    inputEl.type = "search"
    inputEl.autocomplete = "off"
    inputEl.spellcheck = false
    inputEl.dataset.tvAutofocus = ""
    inputEl.dataset.focusKey = "search:input"
    inputEl.className =
      "h-full min-w-0 flex-1 rounded-2xl bg-transparent text-base text-fg outline-none placeholder:text-fg-3"
    inputBox.append(searchIcon, inputEl)
    inputWrap.appendChild(inputBox)

    const recentWrap = document.createElement("div")
    recentWrap.className = "flex flex-col gap-2"
    recentWrap.hidden = true
    const recentHead = document.createElement("div")
    recentHead.className = "flex items-center justify-between gap-3"
    const recentHeading = document.createElement("span")
    recentHeading.className = "text-eyebrow font-medium uppercase tracking-wide text-fg-3"
    const recentClear = document.createElement("button")
    recentClear.type = "button"
    recentClear.dataset.focusKey = "search:recent:clear"
    recentClear.className =
      "rounded-lg px-2 py-1 text-sm text-fg-3 outline-none transition-colors hover:text-fg focus-visible:text-fg tv-focus-inset"
    recentHead.append(recentHeading, recentClear)
    const recentTrack = document.createElement("div")
    recentTrack.className = "flex flex-wrap gap-2"
    recentWrap.append(recentHead, recentTrack)

    const statusEl = document.createElement("p")
    statusEl.className = "text-fg-3"
    statusEl.hidden = true

    track.append(inputWrap, recentWrap, statusEl)

    let channelsRail: RailHandle | null = null
    let moviesRail: RailHandle | null = null
    let seriesRail: RailHandle | null = null

    function createRails(): void {
      channelsRail = createRail({ title: t("search.results.live"), focusSectionId: "tv-search-channels" })
      moviesRail = createRail({ title: t("search.results.vod"), focusSectionId: "tv-search-movies" })
      seriesRail = createRail({ title: t("search.results.series"), focusSectionId: "tv-search-series" })
      track.append(channelsRail.el, moviesRail.el, seriesRail.el)
      channelsRail.el.addEventListener("click", commitCurrentSearch)
      moviesRail.el.addEventListener("click", commitCurrentSearch)
      seriesRail.el.addEventListener("click", commitCurrentSearch)
    }

    const offsetPx = Math.round(root.clientHeight * 0.4) || 240
    const unregisterKeepInView = keepFocusedInView(scroller, "y", offsetPx)
    const unregisterInputSection = registerFocusSection("tv-search-input", inputWrap)
    const unregisterRecentSection = registerFocusSection("tv-search-recent", recentWrap, {
      enterTo: "last-focused",
      restrict: "self-first",
    })

    let destroyed = false
    let activePlaylistId = ""
    let channels: Array<LiveRow & { norm: string }> = []
    let movies: Array<CatalogRow & { norm: string }> = []
    let series: Array<CatalogRow & { norm: string }> = []
    let recentSearches: Array<{ text: string; ts: number }> = []
    let indexReady = false
    let isWarming = false
    let warmupRequested = false
    let currentQuery = ""
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
    let searchGeneration = 0
    let sessionStarted = false

    function commitCurrentSearch(): void {
      if (currentQuery) pushRecentSearch(activePlaylistId, currentQuery)
    }

    function setStatus(text: string): void {
      statusEl.hidden = !text
      statusEl.textContent = text
    }

    function refreshRecentSearches(): void {
      recentSearches = activePlaylistId ? getRecentSearches(activePlaylistId) : []
    }

    function renderRecentChips(): void {
      recentTrack.replaceChildren()
      for (const recent of recentSearches) {
        const chip = document.createElement("button")
        chip.type = "button"
        chip.dataset.focusKey = `search:recent:${recent.text}`
        chip.className =
          "inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-sm text-fg-2 outline-none " +
          "transition-colors hover:bg-surface-2 tv-focus-inset"
        chip.textContent = recent.text
        chip.addEventListener("click", () => selectRecentChip(recent.text))
        recentTrack.appendChild(chip)
      }
    }

    function selectRecentChip(text: string): void {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer)
        searchDebounceTimer = null
      }
      inputEl.value = text
      syncUrlQuery(text)
      void runSearch(text)
    }

    function syncUrlQuery(value: string): void {
      try {
        const url = new URL(window.location.href)
        if (value) url.searchParams.set("q", value)
        else url.searchParams.delete("q")
        window.history.replaceState(window.history.state, "", url.toString())
      } catch {}
    }

    function toLiveCardItem(channel: LiveRow & { norm: string }, siblings: Array<LiveRow & { norm: string }>): LiveCardItem {
      const name = channel.name || ""
      return {
        railId: "tv-search-channels",
        kind: "live",
        id: channel.id,
        name,
        logoUrl: channel.logo || null,
        nowTitle: channel.category || kindLabel("live"),
        ariaLabel: t("tv.aria.watch", { name }),
        onActivate: () => {
          commitCurrentSearch()
          void playLive(
            {
              playlistId: activePlaylistId,
              channel: toTvLiveChannel(channel),
              siblings: siblings.map(toTvLiveChannel),
            },
            {}
          )
        },
      }
    }

    function toPosterCardItem(row: CatalogRow & { norm: string }, kind: "vod" | "series"): PosterCardItem {
      const fallbackKey = kind === "vod" ? "list.movieFallback" : "list.seriesFallback"
      const name = row.name || t(fallbackKey, { id: row.id })
      const href =
        kind === "vod"
          ? `/tv/movies/detail?id=${encodeURIComponent(String(row.id))}`
          : `/tv/series/detail?id=${encodeURIComponent(String(row.id))}`
      return {
        railId: kind === "vod" ? "tv-search-movies" : "tv-search-series",
        kind,
        id: row.id,
        name,
        href,
        posterUrl: row.logo || null,
        meta: metaForCatalogRow(row),
        ariaLabel: t("tv.aria.open", { name }),
      }
    }

    function isSmallCatalog(): boolean {
      return channels.length < SYNC_THRESHOLD && movies.length < SYNC_THRESHOLD && series.length < SYNC_THRESHOLD
    }

    // Fires all three kinds in parallel and lets each rail update as its own result lands,
    // rather than waiting for the slowest; a generation guard drops stale replies.
    async function runSearch(rawValue: string): Promise<void> {
      if (!channelsRail || !moviesRail || !seriesRail) return
      const trimmed = rawValue.trim()
      currentQuery = trimmed

      const showRecent = !trimmed && recentSearches.length > 0
      recentWrap.hidden = !showRecent
      if (showRecent) renderRecentChips()

      if (trimmed.length < MIN_QUERY_LENGTH) {
        searchGeneration++
        channelsRail.setItems([])
        moviesRail.setItems([])
        seriesRail.setItems([])
        setStatus(showRecent ? "" : t("search.helpHeading"))
        return
      }

      if (!indexReady) {
        searchGeneration++
        channelsRail.setLoading()
        moviesRail.setLoading()
        seriesRail.setLoading()
        setStatus(t("search.loadingCatalog"))
        return
      }

      const generation = ++searchGeneration
      const preferredTags = effectivePreferredTags(getContentLanguage(), getActiveLocale())
      const catalogPrefix = `search:${activePlaylistId}`
      const resolvedKinds = new Set<"live" | "vod" | "series">()
      let totalMatches = 0

      const noteResolved = (kind: "live" | "vod" | "series", count: number): void => {
        if (generation !== searchGeneration) return
        resolvedKinds.add(kind)
        totalMatches += count
        if (totalMatches > 0) setStatus("")
        else if (resolvedKinds.size === 3) {
          setStatus(isWarming ? t("search.loadingCatalog") : t("search.noResults", { query: trimmed }))
        }
      }

      searchCatalog(`${catalogPrefix}:live`, channels, trimmed, RESULT_CAP).then((indexes) => {
        if (generation !== searchGeneration || indexes === null) return
        const channelMatches = Array.from(indexes, (index) => channels[index])
        channelsRail!.setItems(channelMatches.map((channel) => toLiveCardItem(channel, channelMatches)))
        noteResolved("live", channelMatches.length)
      })

      searchCatalog(`${catalogPrefix}:vod`, movies, trimmed, RESULT_CAP).then((indexes) => {
        if (generation !== searchGeneration || indexes === null) return
        const rankedMovies = Array.from(indexes, (index) => movies[index])
        const movieCollapsed = collapseRankedMatches(rankedMovies, () => getSharedGroupingIndex(movies), preferredTags)
        const movieItems = movieCollapsed.rows.map((movie) => toPosterCardItem(movie, "vod"))
        moviesRail!.setItems(movieItems)
        decorateRailChips(moviesRail!, movieItems, movieCollapsed.chipInfoById)
        noteResolved("vod", movieCollapsed.rows.length)
      })

      searchCatalog(`${catalogPrefix}:series`, series, trimmed, RESULT_CAP).then((indexes) => {
        if (generation !== searchGeneration || indexes === null) return
        const rankedSeries = Array.from(indexes, (index) => series[index])
        const seriesCollapsed = collapseRankedMatches(rankedSeries, () => getSharedGroupingIndex(series), preferredTags)
        const seriesItems = seriesCollapsed.rows.map((row) => toPosterCardItem(row, "series"))
        seriesRail!.setItems(seriesItems)
        decorateRailChips(seriesRail!, seriesItems, seriesCollapsed.chipInfoById)
        noteResolved("series", seriesCollapsed.rows.length)
      })
    }

    function scheduleSearch(value: string): void {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null
        syncUrlQuery(value)
        void runSearch(value)
      }, SEARCH_DEBOUNCE_MS)
    }

    // First keystroke of a session skips the debounce when catalogs are small enough that a
    // worker round trip isn't needed; later keystrokes in the same session still debounce.
    function onInputChanged(value: string): void {
      const trimmed = value.trim()
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer)
        searchDebounceTimer = null
      }
      if (trimmed.length < MIN_QUERY_LENGTH) {
        sessionStarted = false
        syncUrlQuery(value)
        void runSearch(value)
        return
      }
      if (!sessionStarted && isSmallCatalog()) {
        sessionStarted = true
        syncUrlQuery(value)
        void runSearch(value)
        return
      }
      sessionStarted = true
      scheduleSearch(value)
    }

    function rebuildIndex(): void {
      channels = withNorms(readCachedLiveChannels(activePlaylistId) as LiveRow[])
      movies = withNorms((getCached(activePlaylistId, "vod")?.data || []) as CatalogRow[])
      series = withNorms((getCached(activePlaylistId, "series")?.data || []) as CatalogRow[])
      indexReady = true
    }

    // Grouping a full catalog is a multi-second task on a TV; do it while idle so the first query doesn't wait.
    function prewarmGroupingIndexes(): void {
      if (!languageGroupingAllowed()) return
      const schedule =
        typeof window.requestIdleCallback === "function"
          ? (fn: () => void) => window.requestIdleCallback(fn, { timeout: 6000 })
          : (fn: () => void) => setTimeout(fn, 1200)
      const pending = [movies, series]
      const warmNext = (): void => {
        const rows = pending.shift()
        if (destroyed || !rows) return
        if (rows.length) getSharedGroupingIndex(rows)
        schedule(warmNext)
      }
      schedule(warmNext)
    }

    function scheduleWarmupIfCold(): void {
      if (warmupRequested || !activePlaylistId) return
      if (channels.length || movies.length || series.length) return
      warmupRequested = true
      isWarming = true
      import("@/scripts/lib/catalog.js")
        .then((mod) => mod.warmupActive(activePlaylistId))
        .catch(() => {})
    }

    function onCatalogWarmed(): void {
      isWarming = false
      if (!activePlaylistId) return
      rebuildIndex()
      void runSearch(inputEl.value)
    }

    function renderCentered(message: string, linkHref?: string, linkLabel?: string): void {
      inputWrap.remove()
      recentWrap.remove()
      statusEl.remove()
      channelsRail?.destroy()
      moviesRail?.destroy()
      seriesRail?.destroy()
      const wrap = document.createElement("div")
      wrap.className = "flex h-full flex-col items-center justify-center gap-3 text-center"
      const text = document.createElement("p")
      text.className = "text-fg-3"
      text.textContent = message
      wrap.appendChild(text)
      if (linkHref && linkLabel) {
        const link = document.createElement("a")
        link.href = linkHref
        link.dataset.tvAutofocus = ""
        link.className = "btn"
        link.textContent = linkLabel
        wrap.appendChild(link)
      } else {
        wrap.tabIndex = 0
        wrap.dataset.tvAutofocus = ""
      }
      track.appendChild(wrap)
    }

    function updateStaticText(): void {
      inputEl.placeholder = t("search.placeholderFull")
      inputEl.setAttribute("aria-label", t("common.search"))
      recentHeading.textContent = t("search.recentHeading")
      recentClear.textContent = t("search.recentClear")
    }

    function onLocaleChanged(): void {
      updateStaticText()
      if (!channelsRail || !moviesRail || !seriesRail) return
      channelsRail.destroy()
      moviesRail.destroy()
      seriesRail.destroy()
      channelsRail = null
      moviesRail = null
      seriesRail = null
      createRails()
      void runSearch(inputEl.value)
    }

    function onRecentChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (detail?.playlistId !== activePlaylistId) return
      refreshRecentSearches()
      void runSearch(inputEl.value)
    }

    function onLanguageSettingsChanged(): void {
      void runSearch(inputEl.value)
    }

    async function onActiveChanged(): Promise<void> {
      const active = await getActiveEntry()
      if (destroyed) return
      activePlaylistId = active?._id || ""
      refreshRecentSearches()
      rebuildIndex()
      void runSearch(inputEl.value)
    }

    async function init(): Promise<void> {
      const initialQuery = ctx.url.searchParams.get("q") || ""
      inputEl.value = initialQuery

      const active = await getActiveEntry()
      if (destroyed) return
      if (!active) {
        renderCentered(t("list.noPlaylistSelected"), "/tv/login", t("playlist.addCta"))
        return
      }
      activePlaylistId = active._id

      createRails()
      updateStaticText()

      await ensurePrefsLoaded()
      if (destroyed) return
      refreshRecentSearches()
      void runSearch(inputEl.value)

      // The input has to be usable before the catalog read; both resolve from memory otherwise.
      await nextPaint()
      if (destroyed) return

      await Promise.allSettled([
        hydrateCache(activePlaylistId, "live"),
        hydrateCache(activePlaylistId, "m3u"),
        hydrateCache(activePlaylistId, "vod"),
        hydrateCache(activePlaylistId, "series"),
      ])
      if (destroyed) return
      await ensureOverridesReady()
      if (destroyed) return

      rebuildIndex()
      scheduleWarmupIfCold()
      void runSearch(inputEl.value)
      prewarmGroupingIndexes()
    }

    inputEl.addEventListener("input", () => onInputChanged(inputEl.value))
    recentClear.addEventListener("click", () => clearRecentSearches(activePlaylistId))

    document.addEventListener(CATALOG_WARMED_EVENT, onCatalogWarmed)
    document.addEventListener(EVT_SEARCH_RECENT_CHANGED, onRecentChanged)
    document.addEventListener(LOCALE_EVENT, onLocaleChanged)
    document.addEventListener("xt:active-changed", onActiveChanged)
    document.addEventListener(LANGUAGE_GROUPING_EVENT, onLanguageSettingsChanged)
    document.addEventListener(CONTENT_LANGUAGE_EVENT, onLanguageSettingsChanged)

    void init()

    return () => {
      destroyed = true
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
      document.removeEventListener(CATALOG_WARMED_EVENT, onCatalogWarmed)
      document.removeEventListener(EVT_SEARCH_RECENT_CHANGED, onRecentChanged)
      document.removeEventListener(LOCALE_EVENT, onLocaleChanged)
      document.removeEventListener("xt:active-changed", onActiveChanged)
      document.removeEventListener(LANGUAGE_GROUPING_EVENT, onLanguageSettingsChanged)
      document.removeEventListener(CONTENT_LANGUAGE_EVENT, onLanguageSettingsChanged)
      channelsRail?.destroy()
      moviesRail?.destroy()
      seriesRail?.destroy()
      unregisterInputSection()
      unregisterRecentSection()
      unregisterKeepInView()
      scroller.remove()
    }
  },
}

export default view
