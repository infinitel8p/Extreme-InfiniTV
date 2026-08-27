// Shared TV grid view for /tv/movies and /tv/series: cache-first catalog paint,
// category/genre + query + hide-watched + sort filtering, row-windowed grid.

import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n"
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
import { isTmdbActive } from "@/scripts/lib/app-settings.js"
import { fmtImdbRating } from "@/scripts/lib/format.ts"
import { filterAndSortEntries, type GridFilterState } from "@/scripts/lib/tv-grid-filter"
import { createFilterBar, openTvOptionsDialog, type FilterOption } from "@/scripts/tv/ui/filter-bar"
import { createGrid } from "@/scripts/tv/ui/grid"
import type { PosterCardItem } from "@/scripts/tv/ui/card"

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

export function createCatalogGridView(kind: CatalogKind): TvView {
  const config = KIND_CONFIG[kind]

  return {
    mount(root: HTMLElement, _ctx: TvViewContext) {
      let destroyed = false
      let activePlaylistId = ""
      let activeCreds: Record<string, string> | null = null
      let allRows: CatalogRow[] = []
      let genreSets: Map<GenreId, Set<number>> | null = null
      let loadGeneration = 0
      let filterState: GridFilterState = { category: null, query: "", hideWatched: false, sort: "default" }

      const wrap = document.createElement("div")
      wrap.className = "flex h-full flex-col gap-6"

      const headingRow = document.createElement("div")
      headingRow.className = "flex items-baseline gap-4"
      const heading = document.createElement("h1")
      heading.className = "text-3xl font-semibold text-fg"
      const countEl = document.createElement("span")
      countEl.className = "text-base text-fg-3 tabular-nums"
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

      const grid = createGrid({
        focusSectionId: `tv-${kind}-grid`,
        railId: `tv-${kind}-grid`,
      })

      wrap.append(headingRow, filterBar.el, grid.el)
      root.appendChild(wrap)

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
        const name = row.name || t(config.fallbackTitleKey, { id: row.id })
        const metaParts: string[] = []
        if (row.year) metaParts.push(String(row.year))
        const rating = fmtImdbRating(row.rating)
        if (rating) metaParts.push(rating)
        return {
          railId: `tv-${kind}-grid`,
          kind,
          id: row.id,
          name,
          href: config.detailHref(row.id),
          posterUrl: row.logo || null,
          meta: metaParts.join(" · "),
          ariaLabel: t("tv.aria.open", { name }),
          progressPercent: vodProgressPercent(row.id),
        }
      }

      function updateHeading(shownCount: number): void {
        heading.textContent = t(config.titleKey)
        countEl.textContent = allRows.length
          ? t(config.ofKey, { shown: shownCount.toLocaleString(), total: allRows.length.toLocaleString() })
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

      function applyFilter(): void {
        if (!allRows.length) {
          const emptyMessage = !activeCreds?.user || !activeCreds?.pass
            ? t(config.requiresXtreamKey)
            : t(config.emptyKey)
          grid.setEntries([], emptyMessage)
          updateHeading(0)
          return
        }
        const filtered = filterAndSortEntries(allRows, filterState, { categoryMatcher, isWatched, normalize })
        grid.setEntries(filtered.map(toCardItem), t(config.noResultsCategoryKey))
        updateHeading(filtered.length)
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
          const tmdbActive = isTmdbActive()
          for (const genre of CANONICAL_GENRES) {
            const count = genreSets.get(genre.id)?.size || 0
            if (!tmdbActive && count === 0) continue
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

      async function refreshGenreSets(playlistId: string): Promise<void> {
        if (!playlistId) return
        try {
          const index = await getGenreIndex(playlistId, kind)
          if (destroyed || playlistId !== activePlaylistId) return
          genreSets = index.sets
        } catch {
          return
        }
        applyFilter()
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
          allRows = data
          applyFilter()
        } catch {
          // Cache-first paint already rendered whatever we had; a failed refresh stays silent.
        }
      }

      function onCatalogWarmed(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || detail.playlistId !== activePlaylistId) return
        const hit = getCached(activePlaylistId, kind)
        if (hit?.data) {
          allRows = hit.data
          applyFilter()
        }
      }

      function onCacheRevalidated(event: Event): void {
        const detail = (event as CustomEvent).detail
        if (!detail || detail.entryId !== activePlaylistId || detail.kind !== kind) return
        const hit = getCached(activePlaylistId, kind)
        if (hit?.data) {
          allRows = hit.data
          applyFilter()
        }
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

      async function init(): Promise<void> {
        heading.textContent = t(config.titleKey)
        const active = await getActiveEntry()
        if (destroyed) return

        if (!active) {
          activePlaylistId = ""
          allRows = []
          grid.setEntries([])
          updateHeading(0)
          return
        }

        activePlaylistId = active._id
        activeCreds = await loadCreds()
        if (destroyed) return

        await ensurePrefsLoaded()
        if (destroyed) return

        filterState = loadPersistedState(activePlaylistId)
        syncFilterBar()

        await loadRows()
        if (destroyed) return
        void refreshGenreSets(activePlaylistId)
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
        grid.destroy()
        filterBar.destroy()
        wrap.remove()
      }
    },
  }
}
