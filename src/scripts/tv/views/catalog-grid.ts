// Shared TV grid view for /tv/movies and /tv/series: cache-first catalog paint,
// category/genre + query + hide-watched + sort filtering, row-windowed grid.

import { nextPaint, takeLastOpenedEntry, type TvView, type TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT, getActiveLocale } from "@/scripts/lib/i18n"
import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
import { ensureVod, ensureSeries, CATALOG_WARMED_EVENT } from "@/scripts/lib/catalog.js"
import { getCached, hydrate as hydrateCache, CACHE_REVALIDATED_EVENT } from "@/scripts/lib/cache.js"
import { normalize } from "@/scripts/lib/text.ts"
import {
  ensureLoaded as ensurePrefsLoaded,
  getViewSort,
  setViewSort,
  getHideWatched,
  setHideWatched,
  isCompleted,
  getProgress,
  getSeriesEpisodeProgress,
  hasSeriesWatchedOverride,
} from "@/scripts/lib/preferences.js"
import { GENRE_CAT_PREFIX, GENRE_INDEX_EVENT, getGenreIndex, ensureGenreBoost } from "@/scripts/lib/genre-index.ts"
import { CANONICAL_GENRES, type GenreId } from "@/scripts/lib/genres.ts"
import {
  isEnrichmentActive,
  getLanguageGroupingEnabled,
  getContentLanguage,
  LANGUAGE_GROUPING_EVENT,
  CONTENT_LANGUAGE_EVENT,
} from "@/scripts/lib/app-settings.js"
import { filterAndSortEntries, type GridFilterState } from "@/scripts/lib/tv-grid-filter"
import { filterCatalog } from "@/scripts/tv/catalog-filter-client"
import {
  getSharedGroupingIndex,
  collapseIntoDisplayGroups,
  isLanguageGroupingExplicitlyEnabled,
  type CatalogGroupingIndex,
  type DisplayGroup,
} from "@/scripts/lib/language-groups.ts"
import { memoryConservative } from "@/scripts/tv/motion"
import { parseNamePrefix, effectivePreferredTags } from "@/scripts/lib/language-tags.ts"
import { buildLanguageChips, LANGUAGE_CHIPS_CLASS } from "@/scripts/lib/entry-card.ts"
import { createFilterBar, openTvOptionsDialog, type FilterOption } from "@/scripts/tv/ui/filter-bar"
import { createGrid, EMPTY_GRID_SOURCE, type GridHandle } from "@/scripts/tv/ui/grid"
import { formatCardMeta, nameReturningCard, type PosterCardItem } from "@/scripts/tv/ui/card"
import { createActionSheet, type ActionSheetHandle } from "@/scripts/tv/ui/action-sheet.ts"
import { buildCatalogMenuActions } from "@/scripts/tv/rail-card-menu.ts"

type CatalogKind = "vod" | "series"

interface CatalogRow {
  id: number
  name: string
  logo: string | null
  year?: string | number | null
  rating?: unknown
  category?: string | null
  added?: number
  norm?: string
  tmdb?: number | null
}

interface KindConfig {
  kind: CatalogKind
  titleKey: string
  ofKey: string
  emptyKey: string
  noResultsCategoryKey: string
  requiresXtreamKey: string
  fallbackTitleKey: string
  searchPlaceholderKey: string
  ensure: (creds: Record<string, string>, playlistId: string) => Promise<CatalogRow[]>
  detailHref: (id: number | string) => string
}

const KIND_CONFIG: Record<CatalogKind, KindConfig> = {
  vod: {
    kind: "vod",
    titleKey: "nav.movies",
    ofKey: "movies.ofMovies",
    emptyKey: "movies.empty",
    noResultsCategoryKey: "movies.noResultsCategory",
    requiresXtreamKey: "movies.requiresXtream",
    fallbackTitleKey: "list.movieFallback",
    searchPlaceholderKey: "list.searchMovies",
    ensure: ensureVod,
    detailHref: (id) => `/tv/movies/detail?id=${encodeURIComponent(String(id))}`,
  },
  series: {
    kind: "series",
    titleKey: "nav.series",
    ofKey: "series.ofSeries",
    emptyKey: "series.empty",
    noResultsCategoryKey: "series.noResultsCategory",
    requiresXtreamKey: "series.requiresXtream",
    fallbackTitleKey: "list.seriesFallback",
    searchPlaceholderKey: "list.searchSeries",
    ensure: ensureSeries,
    detailHref: (id) => `/tv/series/detail?id=${encodeURIComponent(String(id))}`,
  },
}

const SORT_MODES = ["default", "added", "rating", "az"] as const
const SORT_LABEL_KEYS: Record<string, string> = {
  default: "sort.default",
  added: "sort.recentlyAdded",
  rating: "sort.rating",
  az: "sort.az",
}

function storageKey(kind: CatalogKind, playlistId: string): string {
  return `xt_tv_grid:${playlistId}:${kind}`
}

// Lite tier skips the multi-map grouping index unless the user explicitly opted in.
function languageGroupingAllowed(): boolean {
  return memoryConservative() ? isLanguageGroupingExplicitlyEnabled() : getLanguageGroupingEnabled()
}

function scheduleIdle(fn: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout: 3000 })
  } else {
    setTimeout(fn, 600)
  }
}

const PREPAINT_ROW_LIMIT = 30

export function createCatalogGridView(kind: CatalogKind): TvView {
  const config = KIND_CONFIG[kind]
  // Set once init() resolves a playlist; lets prepaint read the cache synchronously on a later visit.
  let lastKnownPlaylistId = ""
  let prepaintedGrid: { root: HTMLElement; wrap: HTMLElement; grid: GridHandle } | null = null

  function discardPrepaint(): void {
    const stale = prepaintedGrid
    if (!stale) return
    prepaintedGrid = null
    stale.grid.destroy()
    stale.wrap.remove()
  }

  return {
    releasePrepaint: discardPrepaint,
    prepaint(root: HTMLElement): boolean {
      if (!lastKnownPlaylistId) return false
      const rows = (getCached(lastKnownPlaylistId, kind)?.data || []) as CatalogRow[]
      if (!rows.length) return false

      const wrap = document.createElement("div")
      wrap.className = "flex h-full flex-col gap-4"
      const grid = createGrid({ focusSectionId: `tv-${kind}-grid`, railId: `tv-${kind}-grid` })
      const firstWindow = rows.slice(0, PREPAINT_ROW_LIMIT)
      grid.setEntries({
        count: firstWindow.length,
        itemAt: (rowIndex) => {
          const row = firstWindow[rowIndex]
          const name = row.name || t(config.fallbackTitleKey, { id: row.id })
          return {
            railId: `tv-${kind}-grid`,
            kind,
            id: row.id,
            name,
            href: config.detailHref(row.id),
            posterUrl: row.logo || null,
            meta: formatCardMeta(row.year, row.rating),
            ariaLabel: t("tv.aria.open", { name }),
          }
        },
        keyAt: (rowIndex) => `${kind}:${firstWindow[rowIndex].id}`,
      }, undefined, { animate: false })
      wrap.appendChild(grid.el)
      root.appendChild(wrap)

      const openedEntry = takeLastOpenedEntry()
      if (openedEntry && openedEntry.kind === kind) nameReturningCard(grid.el, `${kind}:${openedEntry.id}`)

      prepaintedGrid = { root, wrap, grid }
      return true
    },
    mount(root: HTMLElement, _ctx: TvViewContext) {
      let destroyed = false
      let activePlaylistId = ""
      let activeCreds: Record<string, string> | null = null
      let allRows: CatalogRow[] = []
      let genreSets: Map<GenreId, Set<number>> | null = null
      let loadGeneration = 0
      let filterGeneration = 0
      // The very first render after a catalog lands must never wait on the filter worker.
      let hasRenderedOnce = false
      let filterState: GridFilterState = { category: null, query: "", hideWatched: false, sort: "default" }
      let displayedRows: CatalogRow[] = []
      let chipInfoByRowId = new Map<number, { tags: string[]; variantCount: number; displayTag: string | null }>()

      const adopted = prepaintedGrid && prepaintedGrid.root === root ? prepaintedGrid : null
      if (adopted) prepaintedGrid = null
      else discardPrepaint()

      const wrap = adopted?.wrap ?? document.createElement("div")
      wrap.className = "flex h-full flex-col gap-4"

      const headingRow = document.createElement("div")
      headingRow.className = "flex items-baseline gap-4"
      const heading = document.createElement("h1")
      heading.className = "text-xl font-semibold text-fg"
      const countEl = document.createElement("span")
      countEl.className = "text-sm text-fg-3 tabular-nums"
      headingRow.append(heading, countEl)

      const filterBar = createFilterBar({
        focusSectionId: `tv-${kind}-filters`,
        hideWatchedLabel: t("list.hideWatched"),
        searchPlaceholder: t(config.searchPlaceholderKey),
        onCategory: () => openCategoryDialog(),
        onSort: () => openSortDialog(),
        onToggleHideWatched: () => {
          const next = !filterState.hideWatched
          filterState = { ...filterState, hideWatched: next }
          if (activePlaylistId) setHideWatched(activePlaylistId, kind, next)
          persistState()
          syncFilterBar()
          applyFilter()
        },
        onQuery: (text) => {
          filterState = { ...filterState, query: text }
          persistState()
          applyFilter()
        },
      })

      const grid = adopted?.grid ?? createGrid({ focusSectionId: `tv-${kind}-grid`, railId: `tv-${kind}-grid` })

      const actionSheet: ActionSheetHandle = createActionSheet(`tv-${kind}-grid-actions-dialog`)

      function openCardMenu(row: CatalogRow, name: string): void {
        actionSheet.open(
          name,
          buildCatalogMenuActions({
            kind,
            id: row.id,
            name,
            logo: row.logo,
            playlistId: activePlaylistId,
            href: config.detailHref(row.id),
            includeWatchlist: true,
          })
        )
      }

      if (adopted) {
        // The grid already shows real cards from prepaint - only the chrome above it is new.
        wrap.prepend(headingRow, filterBar.el)
      } else {
        wrap.append(headingRow, filterBar.el, grid.el)
        root.appendChild(wrap)
        // Skeleton from mount, not just once loadRows() reaches its first await.
        grid.setLoading()
      }

      // Grid rows mount lazily (row-windowing); a chip is appended as each card's row enters the DOM.
      function decorateCardChips(cardEl: HTMLElement): void {
        const indexStr = cardEl.dataset.gridIndex
        if (indexStr == null) return
        const row = displayedRows[Number(indexStr)]
        if (!row) return
        const info = chipInfoByRowId.get(row.id)
        if (!info) return
        const posterWrap = cardEl.querySelector<HTMLElement>("[data-poster-wrap]")
        if (!posterWrap || posterWrap.querySelector(`.${LANGUAGE_CHIPS_CLASS}`)) return
        const chip = buildLanguageChips(info.tags, info.variantCount, getActiveLocale(), info.displayTag)
        if (chip) posterWrap.appendChild(chip)
      }

      const chipObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue
            if (node.matches("[data-grid-index]")) decorateCardChips(node)
            node.querySelectorAll<HTMLElement>("[data-grid-index]").forEach(decorateCardChips)
          }
        }
      })
      chipObserver.observe(grid.el, { childList: true, subtree: true })

      function persistState(): void {
        if (!activePlaylistId) return
        try {
          sessionStorage.setItem(storageKey(kind, activePlaylistId), JSON.stringify(filterState))
        } catch {}
      }

      function loadPersistedState(playlistId: string): GridFilterState {
        let stored: Partial<GridFilterState> | null = null
        try {
          const raw = sessionStorage.getItem(storageKey(kind, playlistId))
          stored = raw ? JSON.parse(raw) : null
        } catch {}
        return {
          category: stored?.category ?? null,
          query: stored?.query ?? "",
          hideWatched: stored?.hideWatched ?? getHideWatched(playlistId, kind),
          sort: stored?.sort ?? getViewSort(playlistId, kind),
        }
      }

      function categoryLabel(): string {
        if (!filterState.category) return t("list.allCategories")
        if (filterState.category.startsWith(GENRE_CAT_PREFIX)) {
          const genreId = filterState.category.slice(GENRE_CAT_PREFIX.length) as GenreId
          const genre = CANONICAL_GENRES.find((candidate) => candidate.id === genreId)
          return genre ? t(genre.labelKey) : filterState.category
        }
        return filterState.category
      }

      function sortLabel(): string {
        return t(SORT_LABEL_KEYS[filterState.sort] || SORT_LABEL_KEYS.default)
      }

      function syncFilterBar(): void {
        filterBar.setState(
          { hideWatched: filterState.hideWatched, query: filterState.query },
          { categoryLabel: categoryLabel(), sortLabel: sortLabel() }
        )
      }

      function categoryMatcher(row: CatalogRow, category: string): boolean {
        if (category.startsWith(GENRE_CAT_PREFIX)) {
          const genreId = category.slice(GENRE_CAT_PREFIX.length) as GenreId
          return !!genreSets?.get(genreId)?.has(Number(row.id))
        }
        const name = (row.category || "").trim() || t("list.uncategorized")
        return name === category
      }

      function isWatched(row: CatalogRow): boolean {
        if (!activePlaylistId) return false
        if (kind === "vod") return isCompleted(activePlaylistId, "vod", row.id)
        if (hasSeriesWatchedOverride(activePlaylistId, row.id)) return true
        // No total episode count here; only hide once every recorded episode is completed.
        const progress = getSeriesEpisodeProgress(activePlaylistId, row.id)
        return progress.completedIds.length > 0 && !progress.hasIncompleteEpisode
      }

      function vodProgressPercent(id: number): number | undefined {
        if (kind !== "vod" || !activePlaylistId) return undefined
        const progress = getProgress(activePlaylistId, "vod", id) as
          | { completed?: boolean; position?: number; duration?: number }
          | null
        if (!progress || progress.completed || !(Number(progress.duration) > 0)) return undefined
        return Math.max(0, Math.min(100, ((progress.position || 0) / (progress.duration as number)) * 100))
      }

      function toCardItem(row: CatalogRow): PosterCardItem {
        const chipInfo = chipInfoByRowId.get(row.id)
        // Strip the tag prefix (redundant once the language shows as a chip) only when 2+ languages are grouped.
        const stripPrefix = chipInfo && chipInfo.tags.length >= 2 && chipInfo.displayTag
        const displayName = stripPrefix ? parseNamePrefix(row.name).rest : row.name
        const name = displayName || t(config.fallbackTitleKey, { id: row.id })
        return {
          railId: `tv-${kind}-grid`,
          kind,
          id: row.id,
          name,
          href: config.detailHref(row.id),
          posterUrl: row.logo || null,
          meta: formatCardMeta(row.year, row.rating),
          ariaLabel: t("tv.aria.open", { name }),
          progressPercent: vodProgressPercent(row.id),
          onLongPress: () => openCardMenu(row, name),
        }
      }

      function updateHeading(shownCount: number, totalCount: number): void {
        heading.textContent = t(config.titleKey)
        countEl.textContent = totalCount
          ? t(config.ofKey, { shown: shownCount.toLocaleString(), total: totalCount.toLocaleString() })
          : ""
      }

      let initialFocusApplied = false
      let userInteracted = false
      const noteInteraction = (): void => {
        userInteracted = true
      }
      window.addEventListener("keydown", noteInteraction, true)
      window.addEventListener("pointerdown", noteInteraction, true)

      // The catalog lands after the shell's restoreFocus parked focus on the filter bar; claim it once.
      function ensureInitialGridFocus(): void {
        if (initialFocusApplied || userInteracted) return
        const active = document.activeElement
        if (active instanceof HTMLElement && (grid.el.contains(active) || active.closest("#tv-nav, dialog[open]"))) {
          initialFocusApplied = true
          return
        }
        const target = grid.el.querySelector<HTMLElement>("[data-tv-autofocus]")
        if (!target) return
        initialFocusApplied = true
        target.focus()
        window.SpatialNavigation?.makeFocusable?.()
      }

      function catalogId(): string {
        return `${kind}:${activePlaylistId}`
      }

      async function applyFilter(): Promise<void> {
        const generation = ++filterGeneration
        if (!allRows.length) {
          const emptyMessage = !activeCreds?.user || !activeCreds?.pass
            ? t(config.requiresXtreamKey)
            : t(config.emptyKey)
          displayedRows = []
          chipInfoByRowId = new Map()
          grid.setEntries(EMPTY_GRID_SOURCE, emptyMessage)
          updateHeading(0, 0)
          return
        }

        let filtered: CatalogRow[]
        if (!hasRenderedOnce) {
          // Cache-first paint runs synchronously: nothing should wait on a worker round trip.
          filtered = filterAndSortEntries(allRows, filterState, { categoryMatcher, isWatched, normalize })
          hasRenderedOnce = true
        } else {
          const isGenreCategory = !!filterState.category?.startsWith(GENRE_CAT_PREFIX)
          const genreMatchIds = isGenreCategory
            ? Array.from(genreSets?.get(filterState.category!.slice(GENRE_CAT_PREFIX.length) as GenreId) || [])
            : undefined
          const watchedIds = filterState.hideWatched ? allRows.filter(isWatched).map((row) => row.id) : undefined

          const indexes = await filterCatalog(catalogId(), allRows, {
            state: filterState,
            category: { isGenreCategory, genreMatchIds, uncategorizedLabel: t("list.uncategorized") },
            watchedIds,
          })
          if (indexes === null || destroyed || generation !== filterGeneration) return
          filtered = new Array(indexes.length)
          for (let i = 0; i < indexes.length; i++) filtered[i] = allRows[indexes[i]]
        }

        const languageGroupingEnabled = languageGroupingAllowed()
        let rows = filtered
        const nextChipInfoByRowId = new Map<number, { tags: string[]; variantCount: number; displayTag: string | null }>()

        if (languageGroupingEnabled) {
          const index = ensureGroupingIndex()
          const preferredTags = effectivePreferredTags(getContentLanguage(), getActiveLocale())
          const groups = collapseIntoDisplayGroups(filtered, index, preferredTags)
          const groupByDisplayId = new Map<number, DisplayGroup<CatalogRow>>(
            groups.map((group) => [group.displayEntry.id, group])
          )
          rows = filterAndSortEntries(
            groups.map((group) => group.displayEntry),
            { category: null, query: "", hideWatched: false, sort: filterState.sort },
            { categoryMatcher: () => true, isWatched: () => false, normalize }
          )
          for (const row of rows) {
            const group = groupByDisplayId.get(row.id)
            if (!group) continue
            nextChipInfoByRowId.set(row.id, {
              tags: group.tags,
              variantCount: group.globalEntryIds.length,
              displayTag: index.tagByEntryId.get(row.id) ?? null,
            })
          }
        }

        displayedRows = rows
        chipInfoByRowId = nextChipInfoByRowId
        // Set before grid.setEntries so the count can never lag behind a card-reconcile that fails or animates.
        const totalCount = languageGroupingEnabled ? ensureGroupingIndex().groupsByKey.size : allRows.length
        updateHeading(rows.length, totalCount)
        grid.setEntries(
          {
            count: rows.length,
            itemAt: (rowIndex) => toCardItem(rows[rowIndex]),
            keyAt: (rowIndex) => `${kind}:${rows[rowIndex].id}`,
          },
          t(config.noResultsCategoryKey)
        )
        ensureInitialGridFocus()
      }

      function buildCategoryOptions(): FilterOption[] {
        const counts = new Map<string, number>()
        for (const row of allRows) {
          const name = (row.category || "").trim() || t("list.uncategorized")
          counts.set(name, (counts.get(name) || 0) + 1)
        }
        const names = Array.from(counts.keys()).sort((first, second) =>
          first.localeCompare(second, "en", { sensitivity: "base" })
        )

        const options: FilterOption[] = [{ value: "", label: t("list.allCategories") }]

        if (genreSets) {
          const enrichmentActive = isEnrichmentActive()
          for (const genre of CANONICAL_GENRES) {
            const count = genreSets.get(genre.id)?.size || 0
            if (!enrichmentActive && count === 0) continue
            options.push({ value: GENRE_CAT_PREFIX + genre.id, label: t(genre.labelKey), count })
          }
        }

        for (const name of names) options.push({ value: name, label: name, count: counts.get(name) || 0 })
        return options
      }

      function openCategoryDialog(): void {
        openTvOptionsDialog({
          title: t("list.category"),
          options: buildCategoryOptions(),
          selectedValue: filterState.category || "",
          onSelect: (value) => {
            const nextCategory = value || null
            filterState = { ...filterState, category: nextCategory }
            if (nextCategory?.startsWith(GENRE_CAT_PREFIX) && activePlaylistId) {
              const genreId = nextCategory.slice(GENRE_CAT_PREFIX.length) as GenreId
              ensureGenreBoost(activePlaylistId, kind, genreId).catch(() => {})
            }
            persistState()
            syncFilterBar()
            applyFilter()
          },
        })
      }

      function openSortDialog(): void {
        openTvOptionsDialog({
          title: t("list.view"),
          options: SORT_MODES.map((mode) => ({ value: mode, label: t(SORT_LABEL_KEYS[mode]) })),
          selectedValue: filterState.sort,
          onSelect: (value) => {
            filterState = { ...filterState, sort: value }
            if (activePlaylistId) setViewSort(activePlaylistId, kind, value)
            persistState()
            syncFilterBar()
            applyFilter()
          },
        })
      }

      // Re-rendering an unchanged catalog costs a full grouping pass, and every refresh
      // path (ensure, warmed, revalidated) hands back the same cached array.
      function setRowsAndRender(rows: CatalogRow[]): void {
        if (rows === allRows && displayedRows.length) return
        allRows = rows
        applyFilter()
      }

      // Shared across views and navigations, keyed by the cached catalog array itself.
      function ensureGroupingIndex(): CatalogGroupingIndex {
        return getSharedGroupingIndex(allRows)
      }

      async function refreshGenreSets(playlistId: string): Promise<void> {
        if (!playlistId) return
        try {
          const index = await getGenreIndex(playlistId, kind)
          if (destroyed || playlistId !== activePlaylistId) return
          genreSets = index.sets
        } catch {
          return
        }
        // Only a genre category reads the sets; otherwise this would be a second full filter pass.
        if (filterState.category?.startsWith(GENRE_CAT_PREFIX)) applyFilter()
      }

      async function loadRows(): Promise<void> {
        if (destroyed || !activePlaylistId) return
        const generation = ++loadGeneration
        const playlistId = activePlaylistId

        await hydrateCache(playlistId, kind)
        if (destroyed || generation !== loadGeneration) return
        const hit = getCached(playlistId, kind)
        if (hit?.data?.length) {
          allRows = hit.data
          applyFilter()
        } else {
          grid.setLoading()
        }

        if (!activeCreds?.user || !activeCreds?.pass) {
          if (!hit?.data?.length) {
            allRows = []
            applyFilter()
          }
          return
        }

        try {
          const data = await config.ensure(activeCreds, playlistId)
          if (destroyed || generation !== loadGeneration) return
          setRowsAndRender(data)
        } catch {
          // Cache-first paint already rendered whatever we had; a failed refresh stays silent.
        }
      }

      function onCatalogWarmed(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || detail.playlistId !== activePlaylistId) return
        const hit = getCached(activePlaylistId, kind)
        if (hit?.data) setRowsAndRender(hit.data)
      }

      function onCacheRevalidated(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || detail.entryId !== activePlaylistId || detail.kind !== kind) return
        const hit = getCached(activePlaylistId, kind)
        if (hit?.data) setRowsAndRender(hit.data)
      }

      function onLanguageSettingsChanged(): void {
        applyFilter()
      }

      function onGenreIndexChanged(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== kind) return
        refreshGenreSets(activePlaylistId)
      }

      function onProgressChanged(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || detail.playlistId !== activePlaylistId) return
        const relevant = kind === "vod" ? detail.kind === "vod" : detail.kind === "episode"
        if (!relevant) return
        applyFilter()
      }

      function onLocaleChanged(): void {
        filterBar.setState(
          { hideWatched: filterState.hideWatched, query: filterState.query },
          { categoryLabel: categoryLabel(), sortLabel: sortLabel() }
        )
        applyFilter()
      }

      async function onActiveChanged(): Promise<void> {
        await init()
      }

      document.addEventListener(CATALOG_WARMED_EVENT, onCatalogWarmed)
      document.addEventListener(CACHE_REVALIDATED_EVENT, onCacheRevalidated)
      document.addEventListener(GENRE_INDEX_EVENT, onGenreIndexChanged)
      document.addEventListener("xt:progress-changed", onProgressChanged)
      document.addEventListener(LOCALE_EVENT, onLocaleChanged)
      document.addEventListener("xt:active-changed", onActiveChanged)
      document.addEventListener(LANGUAGE_GROUPING_EVENT, onLanguageSettingsChanged)
      document.addEventListener(CONTENT_LANGUAGE_EVENT, onLanguageSettingsChanged)

      async function init(): Promise<void> {
        heading.textContent = t(config.titleKey)
        const active = await getActiveEntry()
        if (destroyed) return

        if (!active) {
          activePlaylistId = ""
          allRows = []
          grid.setEntries(EMPTY_GRID_SOURCE)
          updateHeading(0, 0)
          return
        }

        activePlaylistId = active._id
        lastKnownPlaylistId = activePlaylistId
        hasRenderedOnce = false
        activeCreds = await loadCreds()
        if (destroyed) return

        await ensurePrefsLoaded()
        if (destroyed) return

        filterState = loadPersistedState(activePlaylistId)
        syncFilterBar()

        // Everything above resolves from memory, so without this the skeleton never
        // reaches the screen before the catalog pass blocks the main thread.
        await nextPaint()
        if (destroyed) return

        await loadRows()
        if (destroyed) return
        // Off the mount path: indexing a full catalog by genre only matters once the category dialog opens.
        scheduleIdle(() => {
          if (!destroyed) void refreshGenreSets(activePlaylistId)
        })
      }

      void init()

      return () => {
        destroyed = true
        window.removeEventListener("keydown", noteInteraction, true)
        window.removeEventListener("pointerdown", noteInteraction, true)
        document.removeEventListener(CATALOG_WARMED_EVENT, onCatalogWarmed)
        document.removeEventListener(CACHE_REVALIDATED_EVENT, onCacheRevalidated)
        document.removeEventListener(GENRE_INDEX_EVENT, onGenreIndexChanged)
        document.removeEventListener("xt:progress-changed", onProgressChanged)
        document.removeEventListener(LOCALE_EVENT, onLocaleChanged)
        document.removeEventListener("xt:active-changed", onActiveChanged)
        document.removeEventListener(LANGUAGE_GROUPING_EVENT, onLanguageSettingsChanged)
        document.removeEventListener(CONTENT_LANGUAGE_EVENT, onLanguageSettingsChanged)
        chipObserver.disconnect()
        grid.destroy()
        filterBar.destroy()
        actionSheet.destroy()
        wrap.remove()
        allRows = []
        displayedRows = []
        genreSets = null
        chipInfoByRowId = new Map()
      }
    },
  }
}
