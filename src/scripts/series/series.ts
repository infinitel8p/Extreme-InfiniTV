// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Series listing page (route: /series).
import { log } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
} from "@/scripts/lib/creds.js"
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import { normalize, scoreNormMatch } from "@/scripts/lib/text.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { t, initI18n, getActiveLocale } from "@/scripts/lib/i18n.js"
import {
  cachedFetch,
  getCached,
  hydrate as hydrateCache,
} from "@/scripts/lib/cache.js"
import { rowsNeedTmdbBackfill, rowsNeedGenreBackfill } from "@/scripts/lib/catalog-mappers.js"
import { triggerTmdbBackfillOnce } from "@/scripts/lib/tmdb-backfill.ts"
import {
  ensureLoaded as ensurePrefsLoaded,
  getSeriesEpisodeProgress,
  getFavorites,
  getRecents,
  getViewSort,
  setViewSort,
  getSeriesProgressSummary,
  getHideWatched,
  hasSeriesWatchedOverride,
  setSeriesWatchedOverride,
  getLanguageFilter,
  getGroupLanguages,
} from "@/scripts/lib/preferences.js"
import { mountCategoryPicker, genreLabelForCategory } from "@/scripts/lib/category-picker.ts"
import { GENRE_CAT_PREFIX, GENRE_INDEX_EVENT, getGenreIndex, ensureGenreBoost } from "@/scripts/lib/genre-index.ts"
import { mountSurprisePicker } from "@/scripts/lib/surprise-picker.ts"
import { mountPersonSuggestStrip } from "@/scripts/lib/person-suggest.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import { fmtImdbRating, ratingSortValue } from "@/scripts/lib/format.js"
import {
  buildEntryCard,
  buildWatchedBadge,
  buildLanguageChips,
  setLanguageChipsOffset,
  WATCHED_BADGE_CLASS,
  STAR_OUTLINE,
  STAR_FILLED,
} from "@/scripts/lib/entry-card.js"
import {
  getCachedSeasonCount,
  getCachedEpisodeIds,
  requestEpisodeIds,
  observeSeasonCount,
  seasonsLabel,
} from "@/scripts/lib/series-seasons.ts"
import { buildGroupingIndex, pickPreferredEntryId, groupPassesLanguageFilter } from "@/scripts/lib/language-groups.ts"
import { parseNamePrefix, languageTagLabel, effectivePreferredTags } from "@/scripts/lib/language-tags.ts"
import { getContentLanguage, getLanguageGroupingEnabled } from "@/scripts/lib/app-settings.js"
import {
  fmtAge,
  posterSkeletonCount,
  renderPosterSkeletons,
  fetchCategoryMap,
  groupHasFavorite,
  groupHasWatchlist,
  toggleGroupFavorite,
  toggleGroupWatchlist,
  createPersonFilterController,
  createGridRestoreController,
  createGridSecondaryControls,
  personFilterGridSignature,
} from "@/scripts/lib/grid-view.ts"

const SERIES_TTL_MS = 24 * 60 * 60 * 1000

if (typeof history !== "undefined") history.scrollRestoration = "manual"

let creds = { host: "", port: "", user: "", pass: "" }

// ----------------------------
// UI refs
// ----------------------------
const gridEl = document.getElementById("series-grid")
const listStatus = document.getElementById("series-list-status")

const searchEl = /** @type {HTMLInputElement|null} */ (
  document.getElementById("series-search")
)

// ----------------------------
// State
// ----------------------------
let all = []
// filtered is an array of display groups: { key, entries, tags, globalEntryIds, displayEntry }.
let filtered = []

// Rebuilt whenever `all` is reassigned; independent of the group-languages toggle.
let groupingIndex = buildGroupingIndex([])

/** @type {Map<string,string> | null} */
let categoryMap = null

let activePlaylistId = ""
let activePlaylistTitle = ""

// Series fully watched against their real episode list, not just recorded
// progress entries. Recomputed whenever progress/hide-watched state changes.
let fullyWatchedSeriesIds = new Set()
let recomputeRunToken = 0

async function recomputeFullyWatched() {
  const runToken = ++recomputeRunToken
  const playlistId = activePlaylistId
  if (!playlistId) {
    fullyWatchedSeriesIds = new Set()
    return
  }

  const next = new Set()
  const candidates = []
  for (const series of all) {
    if (hasSeriesWatchedOverride(playlistId, series.id)) {
      next.add(series.id)
      continue
    }
    const progress = getSeriesEpisodeProgress(playlistId, series.id)
    if (progress.completedIds.length > 0 && !progress.hasIncompleteEpisode) {
      candidates.push(series)
    }
  }

  for (const series of candidates) {
    if (runToken !== recomputeRunToken || activePlaylistId !== playlistId) return
    const episodeIds =
      getCachedEpisodeIds(playlistId, series.id) ??
      (await requestEpisodeIds(playlistId, series.id))
    if (runToken !== recomputeRunToken || activePlaylistId !== playlistId) return
    if (!episodeIds || !episodeIds.length) continue
    const completedIds = new Set(
      getSeriesEpisodeProgress(playlistId, series.id).completedIds
    )
    if (episodeIds.every((episodeId) => completedIds.has(episodeId))) {
      next.add(series.id)
    }
  }

  if (runToken !== recomputeRunToken || activePlaylistId !== playlistId) return
  fullyWatchedSeriesIds = next
}

// Genre index is async and rebuilt local-only; snapshot + playlist guard avoid races on quick playlist switches.
let genreSets = null
let genreSetsPlaylistId = ""
let genreSetsLoadingId = ""

async function refreshGenreSets(playlistId) {
  if (!playlistId) return
  genreSetsLoadingId = playlistId
  try {
    const index = await getGenreIndex(playlistId, "series")
    if (playlistId !== activePlaylistId) return
    genreSets = index.sets
    genreSetsPlaylistId = playlistId
    applyFilter()
  } finally {
    if (genreSetsLoadingId === playlistId) genreSetsLoadingId = ""
  }
}

// applyFilter can hit a genre category before any paint loaded the snapshot (back-nav, bfcache, playlist switch).
function ensureGenreSets() {
  if (!activePlaylistId || genreSetsLoadingId === activePlaylistId) return
  refreshGenreSets(activePlaylistId).catch(() => {})
}

document.addEventListener(GENRE_INDEX_EVENT, (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.kind !== "series") return
  if (detail.playlistId !== activePlaylistId) return
  refreshGenreSets(activePlaylistId)
})

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const picker = mountCategoryPicker({
  kind: "series",
  idPrefix: "series-category-picker",
  activeCatStorageKey: "xt_series_active_cat",
  activeCatChangedEvent: "xt:series-cat-changed",
  getActivePlaylistId: () => activePlaylistId,
  getItems: () => all,
})
document.addEventListener("xt:series-cat-changed", (ev) => {
  const activeCat = /** @type {CustomEvent} */ (ev).detail
  if (activePlaylistId && typeof activeCat === "string" && activeCat.startsWith(GENRE_CAT_PREFIX)) {
    ensureGenreBoost(activePlaylistId, "series", activeCat.slice(GENRE_CAT_PREFIX.length)).catch(() => {})
  }
  applyFilter()
})

mountSurprisePicker({
  kind: "series",
  triggerId: "series-surprise",
  getPool: () => filtered.map((group) => group.displayEntry),
  getPlaylistId: () => activePlaylistId,
})

// STAR_OUTLINE / STAR_FILLED / BOOKMARK_FILLED are imported from entry-card.

document.addEventListener("xt:favorites-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  if (picker.getActiveCat() === CAT_FAVORITES) applyFilter()
  else updateGridStarFor(detail.id)
  picker.refreshPseudoRows()
})

document.addEventListener("xt:watchlist-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  updateGridWatchBadgeFor(detail.id)
})

document.addEventListener("xt:recents-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  if (picker.getActiveCat() === CAT_RECENTS) applyFilter()
  picker.refreshPseudoRows()
})

const onSeriesFilterChange = (ev: Event) => {
  const detail = /** @type {CustomEvent} */ (ev as any).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  applyFilter()
}
document.addEventListener("xt:hidden-categories-changed", onSeriesFilterChange)
document.addEventListener("xt:allowed-categories-changed", onSeriesFilterChange)
document.addEventListener("xt:category-mode-changed", onSeriesFilterChange)

document.addEventListener("xt:progress-changed", async (event) => {
  const detail = /** @type {CustomEvent} */ (event).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "episode") return
  await recomputeFullyWatched()
  if (detail.playlistId !== activePlaylistId) return
  if (getHideWatched(activePlaylistId, "series")) {
    applyFilter()
    return
  }
  const seriesId = Number(detail.seriesId ?? 0)
  if (!seriesId) {
    refreshSeriesProgressBadges()
    return
  }
  refreshSeriesProgressBadges(seriesId)
})

// specificSeriesId may be any variant id in the group, not just the displayed one.
function refreshSeriesProgressBadges(specificSeriesId) {
  if (!gridEl) return
  const cards = gridEl.querySelectorAll("[data-idx]")
  for (const card of cards) {
    const idx = Number(card.dataset.idx)
    const group = filtered[idx]
    if (!group) continue
    if (specificSeriesId && !group.globalEntryIds.includes(specificSeriesId)) continue
    const wrap = card.querySelector("[data-poster-wrap]")
    if (!wrap) continue
    wrap.querySelector(".series-progress-badge")?.remove()
    wrap.querySelector(`.${WATCHED_BADGE_CLASS}`)?.remove()
    const anyWatched = group.globalEntryIds.some((id) => fullyWatchedSeriesIds.has(id))
    let badgePresent = false
    if (anyWatched) {
      wrap.appendChild(buildWatchedBadge())
      badgePresent = true
    } else {
      const next = makeSeriesProgressBadge(displayCardEntry(group), group)
      if (next) {
        wrap.appendChild(next)
        badgePresent = true
      }
    }
    setLanguageChipsOffset(wrap, badgePresent)
  }
}

// ----------------------------
// Categories
// ----------------------------
async function ensureSeriesCategoryMap() {
  if (categoryMap) return categoryMap
  categoryMap = await fetchCategoryMap("get_series_categories")
  return categoryMap
}


// ----------------------------
// Poster grid
// ----------------------------
const PAGE_SIZE = 200
const AUTO_LOAD_CAP = 1500
/** @type {IntersectionObserver|null} */
let infiniteObs = null
let renderedCount = 0

// makeFallback is imported from entry-card.

function seasonEpisodeCount(seriesId, season) {
  if (!activePlaylistId || !seriesId || season == null) return 0
  const cached = getCached(activePlaylistId, `series_info_${seriesId}`)
  const eps = cached?.data?.episodes
  if (!eps || typeof eps !== "object") return 0
  const bucket = Array.isArray(eps) ? null : eps[String(season)]
  if (Array.isArray(bucket)) return bucket.length
  if (Array.isArray(eps)) {
    let n = 0
    for (const ep of eps) if (String(ep?.season ?? "") === String(season)) n++
    return n
  }
  return 0
}

// Scans every variant in the group since progress may be recorded against a non-preferred one.
function findGroupProgress(group) {
  for (const entryId of group.globalEntryIds) {
    const summary = getSeriesProgressSummary(activePlaylistId, entryId)
    if (summary) return { seriesId: entryId, summary }
  }
  return null
}

function makeSeriesProgressBadge(series, group) {
  if (!activePlaylistId) return null
  const progress = findGroupProgress(group)
  if (!progress) return null
  const { seriesId, summary } = progress

  const season = summary.lastSeason
  const episodeNum = summary.lastEpisodeNum
  const epId = summary.lastEpisodeId

  const seasonLabel = season != null && season !== "" ? `S${season}` : ""
  const total = season != null ? seasonEpisodeCount(seriesId, season) : 0

  let body
  if (seasonLabel && episodeNum != null && total > 0) {
    body = `${seasonLabel} ${episodeNum}/${total}`
  } else if (seasonLabel && episodeNum != null) {
    body = `${seasonLabel} E${episodeNum}`
  } else if (seasonLabel) {
    body = `${seasonLabel} · ${summary.watchedCount} watched`
  } else {
    body = `${summary.watchedCount} watched`
  }

  const badge = document.createElement("a")
  badge.className =
    "series-progress-badge absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 " +
    "rounded-md px-1.5 py-0.5 bg-accent text-bg text-2xs font-semibold tabular-nums " +
    "ring-1 ring-black/10 hover:brightness-110 focus-visible:brightness-110 " +
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent " +
    "transition-[filter,transform] duration-150 active:scale-[0.97]"
  if (epId) {
    badge.href = `/series/detail?id=${encodeURIComponent(seriesId)}&autoplay=1&episode=${encodeURIComponent(epId)}`
  } else {
    badge.href = `/series/detail?id=${encodeURIComponent(seriesId)}`
  }
  badge.title = t("series.resumeNextEpisode")
  badge.setAttribute("aria-label", t("series.resumeAria", { name: series.name || t("page.series.title"), body }))
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 5v14l11-7z"/></svg>' +
    `<span>${body}</span>`
  badge.addEventListener("click", (event) => {
    event.stopPropagation()
  })
  return badge
}

function seriesMetaText(entry, seasonCount) {
  const parts = []
  if (entry.year) parts.push(entry.year)
  if (seasonCount) parts.push(seasonsLabel(seasonCount))
  if (entry.category) parts.push(entry.category)
  return parts.join(" \u2022 ")
}

// Strip the tag prefix (redundant once the language shows as a chip) only when 2+ languages are grouped.
function displayCardEntry(group) {
  const displayEntry = group.displayEntry
  const stripPrefix = group.tags.length >= 2 && groupingIndex.tagByEntryId.get(displayEntry.id)
  return stripPrefix ? { ...displayEntry, name: parseNamePrefix(displayEntry.name).rest } : displayEntry
}

function makeCard(group, idx) {
  const displayEntry = group.displayEntry
  const cardEntry = displayCardEntry(group)

  const card = buildEntryCard({
    entry: cardEntry,
    idx,
    kind: "series",
    activePlaylistId,
    detailHref: (entry) =>
      `/series/detail?id=${encodeURIComponent(entry.id)}`,
    fallbackTitle: (entry) => t("list.seriesFallback", { id: entry.id }),
    metaText: (entry) =>
      seriesMetaText(entry, getCachedSeasonCount(activePlaylistId, entry.id)),
    decoratePoster: (posterWrap, entry) => {
      const anyWatched = group.globalEntryIds.some((id) => fullyWatchedSeriesIds.has(id))
      let badgePresent = false
      if (anyWatched) {
        posterWrap.appendChild(buildWatchedBadge())
        badgePresent = true
      } else {
        const progressBadge = makeSeriesProgressBadge(entry, group)
        if (progressBadge) {
          posterWrap.appendChild(progressBadge)
          badgePresent = true
        }
      }
      const chips = buildLanguageChips(
        group.tags,
        group.globalEntryIds.length,
        getActiveLocale(),
        groupingIndex.tagByEntryId.get(displayEntry.id)
      )
      if (chips) {
        posterWrap.appendChild(chips)
        setLanguageChipsOffset(posterWrap, badgePresent)
      }
    },
    starLabel: (entry, fav) =>
      fav
        ? `Remove ${entry.name || "series"} from favorites`
        : `Add ${entry.name || "series"} to favorites`,
    favoriteState: () => groupHasFavorite(activePlaylistId, "series", group),
    onToggleFavorite: (entry, currentlyFavorited) => {
      toggleGroupFavorite(activePlaylistId, "series", group, entry, currentlyFavorited)
    },
    watchlistState: () => groupHasWatchlist(activePlaylistId, "series", group),
    onContextMenu: (entry, anchor, point) => {
      import("@/scripts/lib/poster-menu").then(({ openPosterMenu }) => {
        openPosterMenu({
          kind: "series",
          entry,
          activePlaylistId,
          anchor,
          point,
          onOpen: () => {
            window.location.href = `/series/detail?id=${encodeURIComponent(entry.id)}`
          },
          // omit single stream URL or download for series
          favoriteActive: () => groupHasFavorite(activePlaylistId, "series", group),
          onToggleFavorite: (currentlyFavorited) => {
            toggleGroupFavorite(activePlaylistId, "series", group, entry, currentlyFavorited)
          },
          watchlistActive: () => groupHasWatchlist(activePlaylistId, "series", group),
          onToggleWatchlist: (currentlyOnWatchlist) => {
            toggleGroupWatchlist(activePlaylistId, "series", group, entry, currentlyOnWatchlist)
          },
          // Mirrors fullyWatchedSeriesIds, the same group-derived set the grid badge reads.
          watchedActive: () => group.globalEntryIds.some((id) => fullyWatchedSeriesIds.has(id)),
          onToggleWatched: (currentlyWatched) => {
            if (!activePlaylistId) return
            if (!currentlyWatched) {
              for (const variantId of group.globalEntryIds) {
                if (fullyWatchedSeriesIds.has(variantId)) continue
                setSeriesWatchedOverride(activePlaylistId, variantId, true)
              }
              return
            }
            for (const variantId of group.globalEntryIds) {
              if (fullyWatchedSeriesIds.has(variantId)) {
                setSeriesWatchedOverride(activePlaylistId, variantId, false)
              }
            }
          },
        })
      })
    },
  })

  if (activePlaylistId) {
    const metaEl = card.querySelector('[data-role="meta"]')
    if (metaEl) {
      observeSeasonCount(card, activePlaylistId, displayEntry.id, (count) => {
        metaEl.textContent = seriesMetaText(displayEntry, count)
      })
    }
  }

  return card
}

function teardownInfiniteObs() {
  if (infiniteObs) {
    infiniteObs.disconnect()
    infiniteObs = null
  }
}

function swapSentinelToButton(sentinel: HTMLElement) {
  sentinel.replaceChildren()
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className =
    "rounded-xl border border-line px-4 py-2 text-sm hover:bg-surface-2 focus-visible:bg-surface-2"
  const updateLabel = () => {
    btn.textContent = t("movies.loadMore", {
      remaining: (filtered.length - renderedCount).toLocaleString(),
    })
  }
  updateLabel()
  btn.addEventListener("click", () => {
    appendNextPage()
    if (renderedCount < filtered.length) updateLabel()
  })
  sentinel.appendChild(btn)
  try { window.SpatialNavigation?.makeFocusable?.() } catch {}
}

function appendNextPage() {
  if (!gridEl) return
  const total = filtered.length
  if (renderedCount >= total) {
    teardownInfiniteObs()
    gridEl.querySelector("[data-grid-sentinel]")?.remove()
    return
  }
  const start = renderedCount
  const end = Math.min(start + PAGE_SIZE, total)
  const frag = document.createDocumentFragment()
  for (let i = start; i < end; i++) {
    frag.appendChild(makeCard(filtered[i], i))
  }
  const sentinel = gridEl.querySelector("[data-grid-sentinel]")
  if (sentinel) gridEl.insertBefore(frag, sentinel)
  else gridEl.appendChild(frag)
  renderedCount = end
  try { window.SpatialNavigation?.makeFocusable?.() } catch {}
  if (renderedCount >= total) {
    teardownInfiniteObs()
    sentinel?.remove()
  } else if (sentinel && !sentinel.querySelector("button")) {
    sentinel.textContent = t("movies.showingOf", {
      shown: renderedCount.toLocaleString(),
      total: filtered.length.toLocaleString(),
    })
  }
}

function renderGrid(afterRender?: () => void) {
  if (!gridEl) return
  // Skeleton -> real swap goes through View Transitions for a cinematic
  // cross-fade. Filter / sort / category swaps stay snappy.
  const wasSkeleton = !!gridEl.querySelector("[data-skeleton]")
  const willShowReal = filtered.length > 0
  const useVT =
    wasSkeleton &&
    willShowReal &&
    typeof (document as any).startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const run = () => {
    renderGridInner()
    afterRender?.()
  }
  if (useVT) {
    ;(document as any).startViewTransition(run)
  } else {
    run()
  }
}

function renderGridInner() {
  if (!gridEl) return
  teardownInfiniteObs()
  gridEl.replaceChildren()
  renderedCount = 0

  if (!filtered.length) {
    const empty = document.createElement("div")
    empty.className = "col-span-full text-fg-3 text-sm py-8 text-center"
    empty.textContent = picker.getActiveCat()
      ? t("series.noResultsCategory")
      : t("series.empty.simple")
    gridEl.appendChild(empty)
    return
  }

  gridEl.scrollTop = 0

  const initialEnd = Math.min(PAGE_SIZE, filtered.length)
  const frag = document.createDocumentFragment()
  for (let i = 0; i < initialEnd; i++) {
    frag.appendChild(makeCard(filtered[i], i))
  }
  gridEl.appendChild(frag)
  renderedCount = initialEnd
  try { window.SpatialNavigation?.makeFocusable?.() } catch {}

  if (renderedCount >= filtered.length) return

  const sentinel = document.createElement("div")
  sentinel.dataset.gridSentinel = ""
  sentinel.className =
    "col-span-full text-fg-3 text-xs py-3 text-center tabular-nums"
  sentinel.style.overflowAnchor = "none"
  sentinel.textContent = t("movies.showingOf", { shown: renderedCount.toLocaleString(), total: filtered.length.toLocaleString() })
  gridEl.appendChild(sentinel)

  if (typeof IntersectionObserver === "function") {
    infiniteObs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        appendNextPage()
        const s = gridEl.querySelector("[data-grid-sentinel]") as HTMLElement | null
        if (!s) return
        if (renderedCount >= AUTO_LOAD_CAP && renderedCount < filtered.length) {
          teardownInfiniteObs()
          swapSentinelToButton(s)
        } else {
          s.textContent = t("movies.showingOf", {
            shown: renderedCount.toLocaleString(),
            total: filtered.length.toLocaleString(),
          })
          infiniteObs?.unobserve(s)
          infiniteObs?.observe(s)
        }
      },
      { root: gridEl, rootMargin: "600px 0px" }
    )
    infiniteObs.observe(sentinel)
  } else {
    swapSentinelToButton(sentinel)
  }
}

// seriesId may be any variant id in the group, not just the displayed one.
function updateGridStarFor(seriesId) {
  if (!gridEl) return
  const idx = filtered.findIndex((group) => group.globalEntryIds.includes(seriesId))
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const displayEntry = group.displayEntry
  const fav = groupHasFavorite(activePlaylistId, "series", group)
  const star = /** @type {HTMLButtonElement|null} */ (
    card.querySelector(".star-btn")
  )
  if (!star) return
  star.innerHTML = fav ? STAR_FILLED : STAR_OUTLINE
  star.classList.toggle("text-accent", fav)
  star.classList.toggle("text-white/85", !fav)
  star.classList.toggle("!opacity-100", fav)
  star.setAttribute("aria-pressed", String(fav))
  star.setAttribute(
    "aria-label",
    fav
      ? `Remove ${displayEntry.name || "series"} from favorites`
      : `Add ${displayEntry.name || "series"} to favorites`
  )
}

// seriesId may be any variant id in the group; see updateGridStarFor.
function updateGridWatchBadgeFor(seriesId) {
  if (!gridEl) return
  const idx = filtered.findIndex((group) => group.globalEntryIds.includes(seriesId))
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const onWatchlist = groupHasWatchlist(activePlaylistId, "series", group)
  const badge = /** @type {HTMLElement|null} */ (
    card.querySelector('[data-role="watch-badge"]')
  )
  if (!badge) return
  badge.hidden = !onWatchlist
}

// ----------------------------
// Grid state restore (back-navigation from a detail page)
// ----------------------------
const gridRestore = createGridRestoreController({
  routeKind: "series",
  pageSize: PAGE_SIZE,
  getActivePlaylistId: () => activePlaylistId,
  getGridEl: () => gridEl,
  getSearchEl: () => searchEl,
  getFilteredLength: () => filtered.length,
  getRenderedCount: () => renderedCount,
  appendNextPage: () => appendNextPage(),
  getPersonSignature: () => personFilterGridSignature(location.search),
})

// ----------------------------
// Person filter (cast/crew chip from a detail page)
// ----------------------------
const personFilter = createPersonFilterController({
  contentKind: "series",
  rowId: "series-person-filter-row",
  labelId: "series-person-filter-label",
  clearButtonId: "series-person-filter-clear",
  logTag: "xt:series",
  getActivePlaylistId: () => activePlaylistId,
  getCatalogEntries: () => all,
  applyFilter: () => applyFilter(),
})

// ----------------------------
// Actor suggestion pills (search input -> existing person filter)
// ----------------------------
const personSuggest = mountPersonSuggestStrip({
  searchEl,
  insertBeforeEl: listStatus,
  basePath: "/series",
  getActivePlaylistId: () => activePlaylistId,
})

// ----------------------------
// Search + filter
// ----------------------------
function applyFilter() {
  if (!listStatus) return
  // An active-but-unresolved person filter must never paint the unfiltered grid.
  if (personFilter.guardUnresolved()) return
  const qnorm = normalize(searchEl?.value || "")
  const tokens = qnorm.length ? qnorm.split(" ") : []

  const activeCat = picker.getActiveCat()
  let out
  if (activeCat === CAT_FAVORITES && activePlaylistId) {
    const favs = getFavorites(activePlaylistId, "series")
    out = all.filter((s) => favs.has(s.id))
  } else if (activeCat === CAT_RECENTS && activePlaylistId) {
    const byId = new Map(all.map((s) => [s.id, s]))
    const recs = getRecents(activePlaylistId, "series")
    out = []
    for (const r of recs) {
      const s = byId.get(r.id)
      if (s) out.push(s)
    }
  } else if (activeCat.startsWith(GENRE_CAT_PREFIX)) {
    const genreId = activeCat.slice(GENRE_CAT_PREFIX.length)
    const snapshotReady = !!genreSets && genreSetsPlaylistId === activePlaylistId
    if (!snapshotReady) ensureGenreSets()
    const idsForGenre = snapshotReady ? genreSets.get(genreId) : null
    out = idsForGenre ? all.filter((s) => idsForGenre.has(s.id)) : []
  } else {
    out = all.filter((s) => {
      if (activeCat && (s.category || "") !== activeCat) return false
      return picker.categoryPassesFilter((s.category || "").toString())
    })
  }

  const personTitleIds = personFilter.getTitleIds()
  if (personFilter.isActive() && personTitleIds) {
    out = out.filter((series) => personTitleIds.has(series.id))
  }

  /** @type {Map<number, number> | null} */
  let scoreById = null
  if (tokens.length) {
    scoreById = new Map()
    const scored = []
    for (const series of out) {
      const score = scoreNormMatch(series.norm, tokens)
      if (score > 0) {
        scored.push(series)
        scoreById.set(series.id, score)
      }
    }
    out = scored
  }

  // Hide-watched and the language filter apply at the group level, so a mismatched variant hides the whole group.
  // The global setting is a master switch: when off, grouping and the language filter both read as fully absent.
  const languageGroupingEnabled = getLanguageGroupingEnabled()
  const groupingEnabled = languageGroupingEnabled && (activePlaylistId ? getGroupLanguages(activePlaylistId, "series") : true)
  const selectedLang = languageGroupingEnabled && activePlaylistId ? getLanguageFilter(activePlaylistId, "series") : ""
  const hideWatched = activePlaylistId && getHideWatched(activePlaylistId, "series")
  // A non-empty language filter takes priority for which variant is displayed.
  const preferredTags = selectedLang
    ? [selectedLang, ...effectivePreferredTags(getContentLanguage(), getActiveLocale())].filter(
        (tag, index, tags) => tags.indexOf(tag) === index
      )
    : effectivePreferredTags(getContentLanguage(), getActiveLocale())

  const groupOrder = []
  const survivorsByKey = new Map()
  for (const series of out) {
    const groupKey = groupingEnabled ? groupingIndex.keyByEntryId.get(series.id) ?? `e:${series.id}` : `e:${series.id}`
    let survivors = survivorsByKey.get(groupKey)
    if (!survivors) {
      survivors = []
      survivorsByKey.set(groupKey, survivors)
      groupOrder.push(groupKey)
    }
    survivors.push(series)
  }

  const displayGroups = []
  for (const groupKey of groupOrder) {
    const survivors = survivorsByKey.get(groupKey)
    const globalInfo = groupingEnabled ? groupingIndex.groupsByKey.get(groupKey) : null
    const ownTag = groupingIndex.tagByEntryId.get(survivors[0].id) ?? null
    const tags = globalInfo ? globalInfo.tags : (ownTag ? [ownTag] : [])
    const globalEntryIds = globalInfo ? globalInfo.entryIds : [survivors[0].id]

    if (!groupPassesLanguageFilter(tags, selectedLang)) continue
    if (hideWatched && globalEntryIds.some((id) => fullyWatchedSeriesIds.has(id))) continue

    const survivorIds = survivors.map((series) => series.id)
    const displayEntryId = pickPreferredEntryId(survivorIds, groupingIndex.tagByEntryId, preferredTags, groupingIndex.qualityRankByEntryId)
    const displayEntry = survivors.find((series) => series.id === displayEntryId) || survivors[0]
    const maxScore = scoreById ? Math.max(...survivors.map((series) => scoreById.get(series.id) || 0)) : 0
    const maxAdded = Math.max(...survivors.map((series) => Number(series.added) || 0))

    displayGroups.push({ key: groupKey, entries: survivors, tags, globalEntryIds, displayEntry, maxScore, maxAdded })
  }

  const mode = activePlaylistId
    ? getViewSort(activePlaylistId, "series")
    : "default"
  if (mode === "default" && scoreById) {
    displayGroups.sort((firstGroup, secondGroup) => secondGroup.maxScore - firstGroup.maxScore)
  } else if (mode === "added") {
    displayGroups.sort((firstGroup, secondGroup) => secondGroup.maxAdded - firstGroup.maxAdded)
  } else if (mode === "rating") {
    displayGroups.sort((firstGroup, secondGroup) => {
      const ratingDelta =
        ratingSortValue(secondGroup.displayEntry.rating) - ratingSortValue(firstGroup.displayEntry.rating)
      if (ratingDelta !== 0) return ratingDelta
      return (firstGroup.displayEntry.name || "").localeCompare(secondGroup.displayEntry.name || "", "en", {
        sensitivity: "base",
      })
    })
  } else if (mode === "az") {
    displayGroups.sort((firstGroup, secondGroup) =>
      (firstGroup.displayEntry.name || "").localeCompare(secondGroup.displayEntry.name || "", "en", {
        sensitivity: "base",
      })
    )
  }

  filtered = displayGroups
  const totalGroups = groupingEnabled ? groupingIndex.groupsByKey.size : all.length
  listStatus.textContent = t("series.ofSeries", {
    shown: filtered.length.toLocaleString(),
    total: totalGroups.toLocaleString(),
  })
  const heroCount = document.getElementById("series-hero-count")
  if (heroCount) heroCount.textContent = filtered.length.toLocaleString()
  const heroCat = document.getElementById("series-hero-cat")
  if (heroCat) {
    heroCat.textContent =
      activeCat === CAT_FAVORITES
        ? t("list.heroFavorites")
        : activeCat === CAT_RECENTS
          ? t("list.heroRecents")
          : genreLabelForCategory(activeCat) || (activeCat as string) || t("list.allCategories")
  }
  renderGrid(gridRestore.consumePending)
}

const sortEl = /** @type {HTMLSelectElement|null} */ (
  document.getElementById("series-sort")
)
function syncSortControl() {
  if (!sortEl || !activePlaylistId) return
  sortEl.value = getViewSort(activePlaylistId, "series")
}
sortEl?.addEventListener("change", () => {
  if (!activePlaylistId || !sortEl) return
  setViewSort(activePlaylistId, "series", sortEl.value)
  applyFilter()
})

const { langFilterEl, syncHideWatchedControl, syncGroupLangsControl, syncLangFilterControl } =
  createGridSecondaryControls({
    contentKind: "series",
    hideWatchedButtonId: "series-hide-watched",
    groupLangsButtonId: "series-group-langs",
    langFilterSelectId: "series-lang",
    getActivePlaylistId: () => activePlaylistId,
    applyFilter,
    onHideWatchedEnabled: recomputeFullyWatched,
  })

// A stored filter tag no longer in the catalog is kept as a selectable option so it stays visible and clearable.
function populateLanguageFilterOptions() {
  if (!langFilterEl) return
  const languageGroupingEnabled = getLanguageGroupingEnabled()
  const frequencyByTag = new Map()
  if (languageGroupingEnabled) {
    for (const tag of groupingIndex.tagByEntryId.values()) {
      if (!tag) continue
      frequencyByTag.set(tag, (frequencyByTag.get(tag) || 0) + 1)
    }
  }
  const tags = Array.from(frequencyByTag.keys()).sort(
    (firstTag, secondTag) => frequencyByTag.get(secondTag) - frequencyByTag.get(firstTag)
  )

  const currentValue = languageGroupingEnabled && activePlaylistId ? getLanguageFilter(activePlaylistId, "series") : ""
  if (currentValue && !tags.includes(currentValue)) tags.push(currentValue)

  const locale = getActiveLocale()
  langFilterEl.replaceChildren()
  const allOption = document.createElement("option")
  allOption.value = ""
  allOption.textContent = t("list.langFilter.all")
  langFilterEl.appendChild(allOption)
  for (const tag of tags) {
    const option = document.createElement("option")
    option.value = tag
    const label = languageTagLabel(tag, locale)
    option.textContent = label !== tag ? `${label} (${tag})` : tag
    langFilterEl.appendChild(option)
  }
  langFilterEl.value = currentValue
  langFilterEl.dispatchEvent(new CustomEvent("xt:sort-menu-refresh"))
}

searchEl?.addEventListener(
  "input",
  debounce(() => applyFilter(), 160)
)

// ----------------------------
// Load series
// ----------------------------
function showEmptyState() {
  if (listStatus) {
    listStatus.innerHTML = `${t("list.noPlaylistAddOne")} <a href="/login" class="text-accent underline">${t("list.addOne")}</a>.`
  }
  filtered = []
  renderGrid()
}

async function paintSeries(data, fromCache, age) {
  all = data
  groupingIndex = buildGroupingIndex(all)
  if (listStatus) {
    listStatus.textContent =
      t("series.totalSeries", { count: all.length.toLocaleString() }) +
      (fromCache ? ` · ${fmtAge(age)}` : "")
  }
  picker.rerender()
  populateLanguageFilterOptions()
  refreshGenreSets(activePlaylistId)
  await recomputeFullyWatched()
  applyFilter()
}

async function fetchSeriesRows() {
  const catMap = await ensureSeriesCategoryMap()
  const r = await xtreamApiFetch("get_series")
  const body = await r.text()
  if (!r.ok) {
    log.error("Upstream error body:", body)
    throw new Error(`API ${r.status}: ${body}`)
  }
  const parsed = JSON.parse(body)
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed?.series || parsed?.results || []
  return (arr || [])
    .map((series) => {
      const name = String(series.name || series.title || "")
      const id = Number(series.series_id || series.id)
      const logo = series.cover || series.stream_icon || null
      const year = String(
        series.year || series.releaseDate || series.release_date || ""
      ).trim()
      const rating = series.rating || series.rating_5based || ""
      const categoryId =
        (Array.isArray(series.category_ids) &&
          series.category_ids.length &&
          series.category_ids[0]) ||
        series.category_id
      let category = String(series.category_name || "").trim()
      if (!category && categoryId != null && catMap?.size) {
        category = catMap.get(String(categoryId)) || ""
      }
      const added =
        Number(series.last_modified) ||
        Number(series.added) ||
        Number(series.releaseDate ? Date.parse(series.releaseDate) / 1000 : 0) ||
        0
      const tmdb = Number(series.tmdb) || Number(series.tmdb_id) || null
      return {
        id,
        name,
        logo: logo || null,
        year: year || "",
        rating: rating ? String(rating) : "",
        category,
        plot: series.plot || "",
        added,
        norm: normalize(`${name} ${category} ${year}`),
        tmdb,
      }
    })
    .filter((series) => series.id && series.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    )
}

async function loadSeries() {
  if (!listStatus) return
  const active = await getActiveEntry()
  if (!active) {
    activePlaylistId = ""
    activePlaylistTitle = ""
    showEmptyState()
    return
  }
  activePlaylistId = active._id
  activePlaylistTitle = active.title || ""
  gridRestore.attemptRestore()
  await ensurePrefsLoaded()
  syncSortControl()
  syncHideWatchedControl()
  syncGroupLangsControl()
  syncLangFilterControl()
  await hydrateCache(active._id, "series")

  const hit = getCached(active._id, "series")
  if (hit) {
    await paintSeries(hit.data, true, hit.age)
    if (rowsNeedTmdbBackfill(hit.data) || rowsNeedGenreBackfill(hit.data)) {
      triggerTmdbBackfillOnce(active._id, "series", SERIES_TTL_MS, fetchSeriesRows)
    }
  } else {
    listStatus.textContent = t("common.loading")
    if (!gridEl?.querySelector("[data-skeleton]")) renderPosterSkeletons(gridEl)
  }

  creds = await loadCreds()
  if (!creds.host) {
    if (!hit) showEmptyState()
    return
  }
  if (!creds.user || !creds.pass) {
    listStatus.textContent = t("series.requiresXtream")
    return
  }
  if (hit) return

  try {
    const { data, fromCache, age } = await cachedFetch(
      active._id,
      "series",
      SERIES_TTL_MS,
      fetchSeriesRows
    )
    await paintSeries(data, fromCache, age)
  } catch (e) {
    log.error("[xt:series] loadSeries threw:", e)
    filtered = []
    renderGrid()
    renderProviderError(listStatus, {
      providerName: activePlaylistTitle,
      kind: "series",
      onRetry: loadSeries,
    })
  }
}

// ----------------------------
// Boot
// ----------------------------
if (gridEl && !gridEl.childElementCount) {
  renderPosterSkeletons(gridEl, posterSkeletonCount())
}
if (listStatus && /no playlist selected/i.test(listStatus.textContent || "")) {
  listStatus.textContent = t("common.loading")
}

document.addEventListener("xt:active-changed", () => {
  if (personFilter.isActive()) personFilter.clear()
  personSuggest.clear()
  gridRestore.reset()
  loadSeries()
})

document.addEventListener("xt:cache-revalidated", (ev) => {
  const detail = (ev as CustomEvent).detail
  if (!detail || detail.entryId !== activePlaylistId) return
  if (detail.kind !== "series") return
  loadSeries()
})

// Re-paint the skeleton wave when a manual catalog re-warm starts. Only
// when the grid currently has no real cards.
document.addEventListener("xt:catalog-warming-start", () => {
  if (!gridEl) return
  const hasReal = Array.from(gridEl.children).some(
    (child) => !(child as HTMLElement).dataset.skeleton,
  )
  if (hasReal) return
  renderPosterSkeletons(gridEl, posterSkeletonCount())
})

;(async () => {
  await initI18n()
  personFilter.render()
  creds = await loadCreds()
  if (creds.host && creds.user && creds.pass) {
    loadSeries()
  } else {
    showEmptyState()
  }
})()
