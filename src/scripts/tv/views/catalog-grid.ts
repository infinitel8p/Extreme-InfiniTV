// Shared TV grid view for /tv/movies and /tv/series: cache-first catalog paint,
// category/genre + query + hide-watched + sort filtering, row-windowed grid.

import { nextPaint, takeLastOpenedEntry, type TvView, type TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT, getActiveLocale } from "@/scripts/lib/i18n"
import { getActiveEntry, getMergedEntries, entryToCreds, loadCreds } from "@/scripts/lib/creds.js"
import { ensureVod, ensureSeries, CATALOG_WARMED_EVENT } from "@/scripts/lib/catalog.js"
import {
  hydrateMergedRows,
  readMergedRows,
  ensureMergedRows,
  isMergedView,
  type MergedReadResult,
} from "@/scripts/lib/merged-catalog.ts"
import {
  rowKey,
  categoryLabel as mergedCategoryLabel,
  mergedCategoryKey,
  parseMergedCategoryKey,
} from "@/scripts/lib/merged-catalog-core.ts"
import { detailHrefFor } from "@/scripts/lib/detail-href.ts"
import { toast } from "@/scripts/lib/toast"
import { remountOnMergedChange } from "@/scripts/tv/merged-remount"
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
  getSeriesWatchedMap,
  getHiddenCategories,
  getAllowedCategories,
  getCategoryMode,
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
import { filterAndSortEntries, gridEntryKey, type GridFilterState } from "@/scripts/lib/tv-grid-filter"
import { filterCatalog } from "@/scripts/tv/catalog-filter-client"
import {
  getSharedGroupingIndex,
  buildGroupingIndexesByPlaylist,
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
  playlistId?: string
  key?: string
  rawCategory?: string
}

interface ChipInfo {
  tags: string[]
  variantCount: number
  displayTag: string | null
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
  detailHref: (id: number | string, playlistId?: string) => string
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
    detailHref: (id, playlistId) => detailHrefFor("vod", id, { tv: true, playlistId }),
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
    detailHref: (id, playlistId) => detailHrefFor("series", id, { tv: true, playlistId }),
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

type MergedRow = CatalogRow & { playlistId: string }

export function createCatalogGridView(kind: CatalogKind): TvView {
  const config = KIND_CONFIG[kind]
  // Set once init() resolves a playlist; lets prepaint read the cache synchronously on a later visit.
  let lastKnownPlaylistId = ""
  let prepaintedGrid: { root: HTMLElement; wrap: HTMLElement; grid: GridHandle } | null = null
  // Indirection so both createGrid() call sites (prepaint and mount) share one hook even though
  // the decorator itself only exists once mount() builds its language-chip state.
  let onCardMountedHandler: ((cardEl: HTMLElement) => void) | null = null
  function onCardMounted(cardEl: HTMLElement): void {
    onCardMountedHandler?.(cardEl)
  }

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
      const mergedRead = isMergedView() ? readMergedRows(kind) : null
      const prepaintMerged = !!mergedRead && mergedRead.isMerged
      const rows = (prepaintMerged ? mergedRead!.rows : (getCached(lastKnownPlaylistId, kind)?.data || [])) as CatalogRow[]
      if (!rows.length) return false

      const wrap = document.createElement("div")
      wrap.className = "flex h-full flex-col gap-4"
      const grid = createGrid({ focusSectionId: `tv-${kind}-grid`, railId: `tv-${kind}-grid`, onCardMounted })
      const firstWindow = rows.slice(0, PREPAINT_ROW_LIMIT)
      grid.setEntries({
        count: firstWindow.length,
        itemAt: (rowIndex) => {
          const row = firstWindow[rowIndex]
          const name = row.name || t(config.fallbackTitleKey, { id: row.id })
          return {
            railId: `tv-${kind}-grid`,
            kind,
            id: prepaintMerged ? rowKey(row as MergedRow) : row.id,
            name,
            href: config.detailHref(row.id, prepaintMerged ? row.playlistId : undefined),
            posterUrl: row.logo || null,
            meta: formatCardMeta(row.year, row.rating),
            ariaLabel: t("tv.aria.open", { name }),
          }
        },
        keyAt: (rowIndex) =>
          `${kind}:${prepaintMerged ? rowKey(firstWindow[rowIndex] as MergedRow) : firstWindow[rowIndex].id}`,
      }, undefined, { animate: false })
      wrap.appendChild(grid.el)
      root.appendChild(wrap)

      const openedEntry = takeLastOpenedEntry()
      if (openedEntry && openedEntry.kind === kind) {
        const openedKey =
          prepaintMerged && openedEntry.playlistId ? `${openedEntry.playlistId}:${openedEntry.id}` : openedEntry.id
        nameReturningCard(grid.el, `${kind}:${openedKey}`)
      }

      prepaintedGrid = { root, wrap, grid }
      return true
    },
    mount(root: HTMLElement, _ctx: TvViewContext) {
      let destroyed = false
      let activePlaylistId = ""
      let activeCreds: Record<string, string> | null = null
      let mergedPlaylistIds: string[] = []
      let isMerged = false
      let anyXtreamSource = false
      const titleById = new Map<string, string>()
      let allRows: CatalogRow[] = []
      let genreSetsByPlaylist = new Map<string, Map<GenreId, Set<number>>>()
      let mergedPartsMemo: { parts: any[][]; rows: CatalogRow[] } | null = null
      let facadeByPart = new WeakMap<any[], CatalogRow[]>()
      const mergedGroupingMemo = new WeakMap<CatalogRow[], Map<string, CatalogGroupingIndex>>()
      let loadGeneration = 0
      let filterGeneration = 0
      // The very first render after a catalog lands must never wait on the filter worker.
      let hasRenderedOnce = false
      let filterState: GridFilterState = { category: null, query: "", hideWatched: false, sort: "default" }
      let displayedRows: CatalogRow[] = []
      let chipInfoByRowId = new Map<string, ChipInfo>()
      // Keyed by allRows identity so a dialog reopen on an unchanged catalog skips the O(n) count pass.
      const categoryOptionsCache = new WeakMap<CatalogRow[], FilterOption[]>()

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

      const grid = adopted?.grid ?? createGrid({ focusSectionId: `tv-${kind}-grid`, railId: `tv-${kind}-grid`, onCardMounted })

      const actionSheet: ActionSheetHandle = createActionSheet(`tv-${kind}-grid-actions-dialog`)

      function rowPlaylistId(row: CatalogRow): string {
        return row.playlistId ?? activePlaylistId
      }

      function entryKeyOf(row: CatalogRow): string {
        return gridEntryKey(row)
      }

      function cardIdOf(row: CatalogRow): string | number {
        return isMerged ? entryKeyOf(row) : row.id
      }

      function hrefFor(row: CatalogRow): string {
        return config.detailHref(row.id, isMerged ? rowPlaylistId(row) : undefined)
      }

      function openCardMenu(row: CatalogRow, name: string): void {
        actionSheet.open(
          name,
          buildCatalogMenuActions({
            kind,
            id: row.id,
            name,
            logo: row.logo,
            playlistId: rowPlaylistId(row),
            href: hrefFor(row),
            includeWatchlist: true,
          })
        )
      }

      function mergedFacade(read: MergedReadResult): CatalogRow[] {
        const parts = read.sources.map((source) => read.byPlaylist.get(source.playlistId) ?? [])
        const memo = mergedPartsMemo
        if (memo && memo.parts.length === parts.length && memo.parts.every((part, index) => part === parts[index])) {
          return memo.rows
        }
        const uncategorized = t("list.uncategorized")
        const rows: CatalogRow[] = []
        parts.forEach((part) => {
          let facade = facadeByPart.get(part)
          if (!facade) {
            facade = part.map((row: CatalogRow & { playlistId: string }) => {
              const rawCategory = (row.category || "").trim() || uncategorized
              return {
                ...row,
                rawCategory,
                category: mergedCategoryKey(row.playlistId, rawCategory),
                key: rowKey(row),
              }
            })
            facadeByPart.set(part, facade)
          }
          for (const row of facade) rows.push(row)
        })
        mergedPartsMemo = { parts, rows }
        return rows
      }

      function currentMergedRows(): CatalogRow[] {
        return mergedFacade(readMergedRows(kind))
      }

      function ensureMergedGroupingIndexes(): Map<string, CatalogGroupingIndex> {
        let indexes = mergedGroupingMemo.get(allRows)
        if (!indexes) {
          indexes = buildGroupingIndexesByPlaylist(allRows as Array<CatalogRow & { playlistId?: string }>)
          mergedGroupingMemo.set(allRows, indexes)
        }
        return indexes
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

      // Grid rows mount lazily (row-windowing); a chip is appended as each card mounts, via the
      // grid's own onCardMounted hook instead of a subtree MutationObserver over the whole grid.
      function decorateCardChips(cardEl: HTMLElement): void {
        const indexStr = cardEl.dataset.gridIndex
        if (indexStr == null) return
        const row = displayedRows[Number(indexStr)]
        if (!row) return
        const info = chipInfoByRowId.get(entryKeyOf(row))
        if (!info) return
        const posterWrap = cardEl.querySelector<HTMLElement>("[data-poster-wrap]")
        if (!posterWrap || posterWrap.querySelector(`.${LANGUAGE_CHIPS_CLASS}`)) return
        const chip = buildLanguageChips(info.tags, info.variantCount, getActiveLocale(), info.displayTag)
        if (chip) posterWrap.appendChild(chip)
      }
      onCardMountedHandler = decorateCardChips

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
        if (isMerged) {
          const parsed = parseMergedCategoryKey(filterState.category, "")
          if (parsed) return mergedCategoryLabel(parsed.name, titleById.get(parsed.playlistId) || "", true)
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
          return !!genreSetsByPlaylist.get(rowPlaylistId(row))?.get(genreId)?.has(Number(row.id))
        }
        const name = (row.category || "").trim() || t("list.uncategorized")
        return name === category
      }

      function isWatched(row: CatalogRow): boolean {
        const playlistId = rowPlaylistId(row)
        if (!playlistId) return false
        if (kind === "vod") return isCompleted(playlistId, "vod", row.id)
        // No total episode count here; only hide once every recorded episode is completed.
        return getSeriesWatchedMap(playlistId).has(row.id)
      }

      function vodProgressPercent(row: CatalogRow): number | undefined {
        const playlistId = rowPlaylistId(row)
        if (kind !== "vod" || !playlistId) return undefined
        const progress = getProgress(playlistId, "vod", row.id) as
          | { completed?: boolean; position?: number; duration?: number }
          | null
        if (!progress || progress.completed || !(Number(progress.duration) > 0)) return undefined
        return Math.max(0, Math.min(100, ((progress.position || 0) / (progress.duration as number)) * 100))
      }

      function toCardItem(row: CatalogRow): PosterCardItem {
        const chipInfo = chipInfoByRowId.get(entryKeyOf(row))
        // Strip the tag prefix (redundant once the language shows as a chip) only when 2+ languages are grouped.
        const stripPrefix = chipInfo && chipInfo.tags.length >= 2 && chipInfo.displayTag
        const displayName = stripPrefix ? parseNamePrefix(row.name).rest : row.name
        const name = displayName || t(config.fallbackTitleKey, { id: row.id })
        return {
          railId: `tv-${kind}-grid`,
          kind,
          id: cardIdOf(row),
          name,
          href: hrefFor(row),
          posterUrl: row.logo || null,
          meta: formatCardMeta(row.year, row.rating),
          ariaLabel: t("tv.aria.open", { name }),
          progressPercent: vodProgressPercent(row),
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
        window.SpatialNavigation?.makeFocusable?.(`tv-${kind}-grid`)
      }

      function catalogId(): string {
        return `${kind}:${mergedPlaylistIds.join("+")}`
      }

      async function applyFilter(): Promise<void> {
        const generation = ++filterGeneration
        if (!allRows.length) {
          const missingXtream = isMerged ? !anyXtreamSource : !activeCreds?.user || !activeCreds?.pass
          const emptyMessage = missingXtream ? t(config.requiresXtreamKey) : t(config.emptyKey)
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
          const genreMatchKeys = isGenreCategory
            ? genreKeysFor(filterState.category!.slice(GENRE_CAT_PREFIX.length) as GenreId)
            : undefined
          const watchedKeys = filterState.hideWatched ? allRows.filter(isWatched).map(entryKeyOf) : undefined

          const indexes = await filterCatalog(catalogId(), allRows, {
            state: filterState,
            category: { isGenreCategory, genreMatchKeys, uncategorizedLabel: t("list.uncategorized") },
            watchedKeys,
          })
          if (indexes === null || destroyed || generation !== filterGeneration) return
          filtered = new Array(indexes.length)
          for (let i = 0; i < indexes.length; i++) filtered[i] = allRows[indexes[i]]
        }

        const languageGroupingEnabled = languageGroupingAllowed()
        let rows = filtered
        let groupedTotal = allRows.length
        const nextChipInfoByRowId = new Map<string, ChipInfo>()

        if (languageGroupingEnabled) {
          const preferredTags = effectivePreferredTags(getContentLanguage(), getActiveLocale())
          let groups: DisplayGroup<CatalogRow>[] = []
          let tagForRow: (row: CatalogRow) => string | null
          if (isMerged) {
            const indexes = ensureMergedGroupingIndexes()
            const filteredByPlaylist = new Map<string, CatalogRow[]>()
            const positionByKey = new Map<string, number>()
            for (let position = 0; position < filtered.length; position++) {
              const row = filtered[position]
              positionByKey.set(entryKeyOf(row), position)
              const playlistId = rowPlaylistId(row)
              const bucket = filteredByPlaylist.get(playlistId)
              if (bucket) bucket.push(row)
              else filteredByPlaylist.set(playlistId, [row])
            }
            groupedTotal = 0
            for (const [playlistId, bucket] of filteredByPlaylist) {
              const index = indexes.get(playlistId)
              if (!index) continue
              for (const group of collapseIntoDisplayGroups(bucket, index, preferredTags)) groups.push(group)
            }
            for (const index of indexes.values()) groupedTotal += index.groupsByKey.size
            groups.sort(
              (first, second) =>
                (positionByKey.get(entryKeyOf(first.entries[0])) ?? 0) -
                (positionByKey.get(entryKeyOf(second.entries[0])) ?? 0)
            )
            tagForRow = (row) => indexes.get(rowPlaylistId(row))?.tagByEntryId.get(row.id) ?? null
          } else {
            const index = ensureGroupingIndex()
            groups = collapseIntoDisplayGroups(filtered, index, preferredTags)
            groupedTotal = index.groupsByKey.size
            tagForRow = (row) => index.tagByEntryId.get(row.id) ?? null
          }
          const groupByDisplayKey = new Map<string, DisplayGroup<CatalogRow>>(
            groups.map((group) => [entryKeyOf(group.displayEntry), group])
          )
          rows = filterAndSortEntries(
            groups.map((group) => group.displayEntry),
            { category: null, query: "", hideWatched: false, sort: filterState.sort },
            { categoryMatcher: () => true, isWatched: () => false, normalize }
          )
          for (const row of rows) {
            const group = groupByDisplayKey.get(entryKeyOf(row))
            if (!group) continue
            nextChipInfoByRowId.set(entryKeyOf(row), {
              tags: group.tags,
              variantCount: group.globalEntryIds.length,
              displayTag: tagForRow(row),
            })
          }
        }

        displayedRows = rows
        chipInfoByRowId = nextChipInfoByRowId
        // Set before grid.setEntries so the count can never lag behind a card-reconcile that fails or animates.
        updateHeading(rows.length, groupedTotal)
        grid.setEntries(
          {
            count: rows.length,
            itemAt: (rowIndex) => toCardItem(rows[rowIndex]),
            keyAt: (rowIndex) => `${kind}:${cardIdOf(rows[rowIndex])}`,
          },
          t(config.noResultsCategoryKey)
        )
        ensureInitialGridFocus()
      }

      function isCategoryVisible(playlistId: string, rawName: string): boolean {
        if (getCategoryMode(playlistId, kind) === "select") {
          const allowed = getAllowedCategories(playlistId, kind)
          return !allowed || allowed.size === 0 || allowed.has(rawName)
        }
        return !getHiddenCategories(playlistId, kind)?.has(rawName)
      }

      function genreKeysFor(genreId: GenreId): string[] {
        const keys: string[] = []
        for (const [playlistId, sets] of genreSetsByPlaylist) {
          for (const id of sets.get(genreId) || []) keys.push(isMerged ? `${playlistId}:${id}` : String(id))
        }
        return keys
      }

      function buildCategoryOptions(): FilterOption[] {
        const cached = categoryOptionsCache.get(allRows)
        if (cached) return cached

        const counts = new Map<string, number>()
        const sourceByValue = new Map<string, { playlistId: string; rawName: string }>()
        for (const row of allRows) {
          const value = (row.category || "").trim() || t("list.uncategorized")
          counts.set(value, (counts.get(value) || 0) + 1)
          if (isMerged && !sourceByValue.has(value)) {
            sourceByValue.set(value, { playlistId: rowPlaylistId(row), rawName: row.rawCategory || value })
          }
        }
        const labelOf = (value: string): string => {
          const source = sourceByValue.get(value)
          return source ? mergedCategoryLabel(source.rawName, titleById.get(source.playlistId) || "", true) : value
        }
        const values = Array.from(counts.keys())
          .filter((value) => {
            const source = sourceByValue.get(value)
            return !source || isCategoryVisible(source.playlistId, source.rawName)
          })
          .sort((first, second) => labelOf(first).localeCompare(labelOf(second), "en", { sensitivity: "base" }))

        const options: FilterOption[] = [{ value: "", label: t("list.allCategories") }]

        if (genreSetsByPlaylist.size) {
          const enrichmentActive = isEnrichmentActive()
          for (const genre of CANONICAL_GENRES) {
            let count = 0
            for (const sets of genreSetsByPlaylist.values()) count += sets.get(genre.id)?.size || 0
            if (!enrichmentActive && count === 0) continue
            options.push({ value: GENRE_CAT_PREFIX + genre.id, label: t(genre.labelKey), count })
          }
        }

        for (const value of values) options.push({ value, label: labelOf(value), count: counts.get(value) || 0 })
        categoryOptionsCache.set(allRows, options)
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
              for (const playlistId of mergedPlaylistIds) ensureGenreBoost(playlistId, kind, genreId).catch(() => {})
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
          if (destroyed || !mergedPlaylistIds.includes(playlistId)) return
          genreSetsByPlaylist.set(playlistId, index.sets)
          categoryOptionsCache.delete(allRows)
        } catch {
          return
        }
        // Only a genre category reads the sets; otherwise this would be a second full filter pass.
        if (filterState.category?.startsWith(GENRE_CAT_PREFIX)) applyFilter()
      }

      async function loadMergedRows(): Promise<void> {
        const generation = ++loadGeneration
        await hydrateMergedRows(kind)
        if (destroyed || generation !== loadGeneration) return
        const cached = currentMergedRows()
        if (cached.length) {
          allRows = cached
          applyFilter()
        } else {
          grid.setLoading()
        }

        const ensured = await ensureMergedRows(kind)
        if (destroyed || generation !== loadGeneration) return
        for (const playlistId of ensured.errors.keys()) {
          toast({
            title: t("stream.mergedPartialError", { title: titleById.get(playlistId) || "" }),
            variant: "error",
          })
        }
        const fresh = mergedFacade(ensured)
        if (!cached.length && !fresh.length) {
          allRows = []
          applyFilter()
          return
        }
        setRowsAndRender(fresh)
      }

      async function loadRows(): Promise<void> {
        if (destroyed || !activePlaylistId) return
        if (isMerged) return loadMergedRows()
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

      function refreshRowsFromCache(): void {
        if (isMerged) {
          const rows = currentMergedRows()
          if (rows.length) setRowsAndRender(rows)
          return
        }
        const hit = getCached(activePlaylistId, kind)
        if (hit?.data) setRowsAndRender(hit.data)
      }

      function onCatalogWarmed(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || !mergedPlaylistIds.includes(detail.playlistId)) return
        refreshRowsFromCache()
      }

      function onCacheRevalidated(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || !mergedPlaylistIds.includes(detail.entryId) || detail.kind !== kind) return
        refreshRowsFromCache()
      }

      function onLanguageSettingsChanged(): void {
        applyFilter()
      }

      function onGenreIndexChanged(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || !mergedPlaylistIds.includes(detail.playlistId) || detail.kind !== kind) return
        refreshGenreSets(detail.playlistId)
      }

      function onProgressChanged(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || !mergedPlaylistIds.includes(detail.playlistId)) return
        const relevant = kind === "vod" ? detail.kind === "vod" : detail.kind === "episode"
        if (!relevant) return
        applyFilter()
      }

      function onLocaleChanged(): void {
        if (isMerged) {
          facadeByPart = new WeakMap()
          mergedPartsMemo = null
          allRows = currentMergedRows()
        }
        categoryOptionsCache.delete(allRows)
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
        const [active, mergedEntries] = await Promise.all([getActiveEntry(), getMergedEntries()])
        if (destroyed) return

        if (!active) {
          activePlaylistId = ""
          mergedPlaylistIds = []
          isMerged = false
          allRows = []
          grid.setEntries(EMPTY_GRID_SOURCE)
          updateHeading(0, 0)
          return
        }

        activePlaylistId = active._id
        lastKnownPlaylistId = activePlaylistId
        mergedPlaylistIds = mergedEntries.length ? mergedEntries.map((entry: any) => entry._id) : [activePlaylistId]
        isMerged = mergedPlaylistIds.length >= 2
        titleById.clear()
        for (const entry of mergedEntries) titleById.set(entry._id, entry.title || "")
        anyXtreamSource = mergedEntries.some((entry: any) => {
          const entryCreds = entryToCreds(entry)
          return !!entryCreds.user && !!entryCreds.pass
        })
        genreSetsByPlaylist = new Map()
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
          if (destroyed) return
          for (const playlistId of mergedPlaylistIds) void refreshGenreSets(playlistId)
        })
      }

      void init()
      const stopRemountOnMergedChange = remountOnMergedChange()

      return () => {
        destroyed = true
        stopRemountOnMergedChange()
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
        if (onCardMountedHandler === decorateCardChips) onCardMountedHandler = null
        grid.destroy()
        filterBar.destroy()
        actionSheet.destroy()
        wrap.remove()
        allRows = []
        displayedRows = []
        genreSetsByPlaylist = new Map()
        chipInfoByRowId = new Map()
      }
    },
  }
}
