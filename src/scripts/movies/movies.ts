// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Movies / VOD listing page (route: /movies). Detail/playback lives on
// /movies/detail?id=<id> via src/scripts/movies/detail.ts.
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
import { rowsNeedTmdbBackfill } from "@/scripts/lib/catalog-mappers.js"
import { triggerTmdbBackfillOnce } from "@/scripts/lib/tmdb-backfill.ts"
import {
  ensureLoaded as ensurePrefsLoaded,
  isCompleted,
  markCompleted,
  clearProgress,
  getFavorites,
  getRecents,
  getViewSort,
  setViewSort,
  getHideWatched,
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
import { buildMovieStreamUrl } from "@/scripts/lib/stream-urls.ts"
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

const VOD_TTL_MS = 24 * 60 * 60 * 1000

if (typeof history !== "undefined") history.scrollRestoration = "manual"

let creds = { host: "", port: "", user: "", pass: "" }

// ----------------------------
// UI refs
// ----------------------------
const gridEl = document.getElementById("movie-grid")
const listStatus = document.getElementById("movie-list-status")

const searchEl = /** @type {HTMLInputElement|null} */ (
  document.getElementById("movie-search")
)
const clearSearchBtn = document.getElementById("movie-clear-search")

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

// Genre index is async and rebuilt local-only; snapshot + playlist guard avoid races on quick playlist switches.
let genreSets = null
let genreSetsPlaylistId = ""
let genreSetsLoadingId = ""

async function refreshGenreSets(playlistId) {
  if (!playlistId) return
  genreSetsLoadingId = playlistId
  try {
    const index = await getGenreIndex(playlistId, "vod")
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
  if (!detail || detail.kind !== "vod") return
  if (detail.playlistId !== activePlaylistId) return
  refreshGenreSets(activePlaylistId)
})

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const picker = mountCategoryPicker({
  kind: "vod",
  idPrefix: "movie-category-picker",
  activeCatStorageKey: "xt_vod_active_cat",
  activeCatChangedEvent: "xt:movie-cat-changed",
  getActivePlaylistId: () => activePlaylistId,
  getItems: () => all,
})
document.addEventListener("xt:movie-cat-changed", (ev) => {
  const activeCat = /** @type {CustomEvent} */ (ev).detail
  if (activePlaylistId && typeof activeCat === "string" && activeCat.startsWith(GENRE_CAT_PREFIX)) {
    ensureGenreBoost(activePlaylistId, "vod", activeCat.slice(GENRE_CAT_PREFIX.length)).catch(() => {})
  }
  applyFilter()
})

mountSurprisePicker({
  kind: "vod",
  triggerId: "movie-surprise",
  getPool: () => filtered.map((group) => group.displayEntry),
  getPlaylistId: () => activePlaylistId,
})

// STAR_OUTLINE / STAR_FILLED / BOOKMARK_FILLED are imported from entry-card.

document.addEventListener("xt:favorites-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (picker.getActiveCat() === CAT_FAVORITES) applyFilter()
  else updateGridStarFor(detail.id)
  picker.refreshPseudoRows()
})

document.addEventListener("xt:watchlist-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  updateGridWatchBadgeFor(detail.id)
})

document.addEventListener("xt:recents-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (picker.getActiveCat() === CAT_RECENTS) applyFilter()
  picker.refreshPseudoRows()
})

document.addEventListener("xt:progress-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (getHideWatched(activePlaylistId, "vod")) {
    applyFilter()
    return
  }
  updateGridWatchedBadgeFor(detail.id)
})

const onMovieFilterChange = (ev: Event) => {
  const detail = /** @type {CustomEvent} */ (ev as any).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  applyFilter()
}
document.addEventListener("xt:hidden-categories-changed", onMovieFilterChange)
document.addEventListener("xt:allowed-categories-changed", onMovieFilterChange)
document.addEventListener("xt:category-mode-changed", onMovieFilterChange)

// ----------------------------
// Categories
// ----------------------------
async function ensureVodCategoryMap() {
  if (categoryMap) return categoryMap
  categoryMap = await fetchCategoryMap("get_vod_categories")
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

function makeCard(group, idx) {
  const displayEntry = group.displayEntry
  // Strip the tag prefix (redundant once the language shows as a chip) only when 2+ languages are grouped.
  const stripPrefix = group.tags.length >= 2 && groupingIndex.tagByEntryId.get(displayEntry.id)
  const cardEntry = stripPrefix
    ? { ...displayEntry, name: parseNamePrefix(displayEntry.name).rest }
    : displayEntry

  return buildEntryCard({
    entry: cardEntry,
    idx,
    kind: "vod",
    activePlaylistId,
    detailHref: (entry) =>
      `/movies/detail?id=${encodeURIComponent(entry.id)}`,
    fallbackTitle: (entry) => t("list.movieFallback", { id: entry.id }),
    metaText: (entry) => {
      const parts = []
      if (entry.year) parts.push(entry.year)
      if ((entry as any).duration) parts.push((entry as any).duration)
      if (entry.category) parts.push(entry.category)
      return parts.join(" \u2022 ")
    },
    decoratePoster: (posterWrap, _entry) => {
      let badgePresent = false
      if (activePlaylistId && group.globalEntryIds.some((id) => isCompleted(activePlaylistId, "vod", id))) {
        posterWrap.appendChild(buildWatchedBadge())
        badgePresent = true
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
        ? `Remove ${entry.name || "movie"} from favorites`
        : `Add ${entry.name || "movie"} to favorites`,
    favoriteState: () => groupHasFavorite(activePlaylistId, "vod", group),
    onToggleFavorite: (entry, currentlyFavorited) => {
      toggleGroupFavorite(activePlaylistId, "vod", group, entry, currentlyFavorited)
    },
    watchlistState: () => groupHasWatchlist(activePlaylistId, "vod", group),
    onContextMenu: (entry, anchor, point) => {
      import("@/scripts/lib/poster-menu").then(({ openPosterMenu }) => {
        openPosterMenu({
          kind: "vod",
          entry,
          activePlaylistId,
          anchor,
          point,
          onOpen: () => {
            window.location.href = `/movies/detail?id=${encodeURIComponent(entry.id)}`
          },
          onDownload: () => {
            window.location.href = `/movies/detail?id=${encodeURIComponent(entry.id)}&download=1`
          },
          buildStreamUrl: () => {
            if (!creds.host || !creds.user || !creds.pass) return null
            const containerExt = (entry as any).container_extension || null
            return buildMovieStreamUrl(creds, entry.id, containerExt)
          },
          favoriteActive: () => groupHasFavorite(activePlaylistId, "vod", group),
          onToggleFavorite: (currentlyFavorited) => {
            toggleGroupFavorite(activePlaylistId, "vod", group, entry, currentlyFavorited)
          },
          watchlistActive: () => groupHasWatchlist(activePlaylistId, "vod", group),
          onToggleWatchlist: (currentlyOnWatchlist) => {
            toggleGroupWatchlist(activePlaylistId, "vod", group, entry, currentlyOnWatchlist)
          },
          watchedActive: () =>
            activePlaylistId
              ? group.globalEntryIds.some((id) => isCompleted(activePlaylistId, "vod", id))
              : false,
          onToggleWatched: (currentlyWatched) => {
            if (!activePlaylistId) return
            if (!currentlyWatched) {
              for (const variantId of group.globalEntryIds) {
                if (isCompleted(activePlaylistId, "vod", variantId)) continue
                const variantEntry = group.entries.find((movie) => movie.id === variantId) || entry
                markCompleted(activePlaylistId, "vod", variantId, {
                  name: variantEntry.name || "",
                  logo: variantEntry.logo || null,
                })
              }
              return
            }
            for (const variantId of group.globalEntryIds) {
              if (isCompleted(activePlaylistId, "vod", variantId)) {
                clearProgress(activePlaylistId, "vod", variantId)
              }
            }
          },
        })
      })
    },
  })
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
  window.SpatialNavigation?.makeFocusable?.()
}

function appendNextPage() {
  if (!gridEl) return
  const total = filtered.length
  if (renderedCount >= total) {
    teardownInfiniteObs()
    const sentinel = gridEl.querySelector("[data-grid-sentinel]")
    sentinel?.remove()
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
  window.SpatialNavigation?.makeFocusable?.()

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
  // If we're going from skeletons to real cards, run the swap inside a
  // View Transition so the placeholders cinematically cross-fade into the
  // real posters instead of snapping. Filter / sort / category changes
  // (skeleton-less swaps) stay snappy and uninstrumented.
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
      ? t("movies.noResultsCategory")
      : t("movies.empty.simple")
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
  window.SpatialNavigation?.makeFocusable?.()

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

// movieId may be any variant id in the group, not just the displayed one.
function updateGridStarFor(movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex((group) => group.globalEntryIds.includes(movieId))
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const displayEntry = group.displayEntry
  const fav = groupHasFavorite(activePlaylistId, "vod", group)
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
      ? `Remove ${displayEntry.name || "movie"} from favorites`
      : `Add ${displayEntry.name || "movie"} to favorites`
  )
}

// movieId may be any variant id in the group; see updateGridStarFor.
function updateGridWatchBadgeFor(movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex((group) => group.globalEntryIds.includes(movieId))
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const onWatchlist = groupHasWatchlist(activePlaylistId, "vod", group)
  const badge = /** @type {HTMLElement|null} */ (
    card.querySelector('[data-role="watch-badge"]')
  )
  if (!badge) return
  badge.hidden = !onWatchlist
}

// movieId may be any variant id in the group, not just the displayed one.
function updateGridWatchedBadgeFor(movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex((group) => group.globalEntryIds.includes(movieId))
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const wrap = card.querySelector("[data-poster-wrap]")
  if (!wrap) return
  wrap.querySelector(`.${WATCHED_BADGE_CLASS}`)?.remove()
  const group = filtered[idx]
  const anyWatched =
    activePlaylistId && group.globalEntryIds.some((id) => isCompleted(activePlaylistId, "vod", id))
  if (anyWatched) wrap.appendChild(buildWatchedBadge())
  setLanguageChipsOffset(wrap, !!anyWatched)
}

// ----------------------------
// Grid state restore (back-navigation from a detail page)
// ----------------------------
const gridRestore = createGridRestoreController({
  routeKind: "movies",
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
  contentKind: "vod",
  rowId: "movie-person-filter-row",
  labelId: "movie-person-filter-label",
  clearButtonId: "movie-person-filter-clear",
  logTag: "xt:movies",
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
  basePath: "/movies",
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
    const favs = getFavorites(activePlaylistId, "vod")
    out = all.filter((m) => favs.has(m.id))
  } else if (activeCat === CAT_RECENTS && activePlaylistId) {
    const byId = new Map(all.map((m) => [m.id, m]))
    const recs = getRecents(activePlaylistId, "vod")
    out = []
    for (const r of recs) {
      const m = byId.get(r.id)
      if (m) out.push(m)
    }
  } else if (activeCat.startsWith(GENRE_CAT_PREFIX)) {
    const genreId = activeCat.slice(GENRE_CAT_PREFIX.length)
    const snapshotReady = !!genreSets && genreSetsPlaylistId === activePlaylistId
    if (!snapshotReady) ensureGenreSets()
    const idsForGenre = snapshotReady ? genreSets.get(genreId) : null
    out = idsForGenre ? all.filter((m) => idsForGenre.has(m.id)) : []
  } else {
    out = all.filter((m) => {
      if (activeCat && (m.category || "") !== activeCat) return false
      return picker.categoryPassesFilter((m.category || "").toString())
    })
  }

  const personTitleIds = personFilter.getTitleIds()
  if (personFilter.isActive() && personTitleIds) {
    out = out.filter((movie) => personTitleIds.has(movie.id))
  }

  /** @type {Map<number, number> | null} */
  let scoreById = null
  if (tokens.length) {
    scoreById = new Map()
    const scored = []
    for (const movie of out) {
      const score = scoreNormMatch(movie.norm, tokens)
      if (score > 0) {
        scored.push(movie)
        scoreById.set(movie.id, score)
      }
    }
    out = scored
  }

  // Hide-watched and the language filter apply at the group level, so a mismatched variant hides the whole group.
  // The global setting is a master switch: when off, grouping and the language filter both read as fully absent.
  const languageGroupingEnabled = getLanguageGroupingEnabled()
  const groupingEnabled = languageGroupingEnabled && (activePlaylistId ? getGroupLanguages(activePlaylistId, "vod") : true)
  const selectedLang = languageGroupingEnabled && activePlaylistId ? getLanguageFilter(activePlaylistId, "vod") : ""
  const hideWatched = activePlaylistId && getHideWatched(activePlaylistId, "vod")
  // A non-empty language filter takes priority for which variant is displayed.
  const preferredTags = selectedLang
    ? [selectedLang, ...effectivePreferredTags(getContentLanguage(), getActiveLocale())].filter(
        (tag, index, tags) => tags.indexOf(tag) === index
      )
    : effectivePreferredTags(getContentLanguage(), getActiveLocale())

  const groupOrder = []
  const survivorsByKey = new Map()
  for (const movie of out) {
    const groupKey = groupingEnabled ? groupingIndex.keyByEntryId.get(movie.id) ?? `e:${movie.id}` : `e:${movie.id}`
    let survivors = survivorsByKey.get(groupKey)
    if (!survivors) {
      survivors = []
      survivorsByKey.set(groupKey, survivors)
      groupOrder.push(groupKey)
    }
    survivors.push(movie)
  }

  const displayGroups = []
  for (const groupKey of groupOrder) {
    const survivors = survivorsByKey.get(groupKey)
    const globalInfo = groupingEnabled ? groupingIndex.groupsByKey.get(groupKey) : null
    const ownTag = groupingIndex.tagByEntryId.get(survivors[0].id) ?? null
    const tags = globalInfo ? globalInfo.tags : (ownTag ? [ownTag] : [])
    const globalEntryIds = globalInfo ? globalInfo.entryIds : [survivors[0].id]

    if (!groupPassesLanguageFilter(tags, selectedLang)) continue
    if (hideWatched && globalEntryIds.some((id) => isCompleted(activePlaylistId, "vod", id))) continue

    const survivorIds = survivors.map((movie) => movie.id)
    const displayEntryId = pickPreferredEntryId(survivorIds, groupingIndex.tagByEntryId, preferredTags, groupingIndex.qualityRankByEntryId)
    const displayEntry = survivors.find((movie) => movie.id === displayEntryId) || survivors[0]
    const maxScore = scoreById ? Math.max(...survivors.map((movie) => scoreById.get(movie.id) || 0)) : 0
    const maxAdded = Math.max(...survivors.map((movie) => Number(movie.added) || 0))

    displayGroups.push({ key: groupKey, entries: survivors, tags, globalEntryIds, displayEntry, maxScore, maxAdded })
  }

  const mode = activePlaylistId
    ? getViewSort(activePlaylistId, "vod")
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
  listStatus.textContent = t("movies.ofMovies", {
    shown: filtered.length.toLocaleString(),
    total: totalGroups.toLocaleString(),
  })
  const heroCount = document.getElementById("movie-hero-count")
  if (heroCount) heroCount.textContent = filtered.length.toLocaleString()
  const heroCat = document.getElementById("movie-hero-cat")
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
  document.getElementById("movie-sort")
)
function syncSortControl() {
  if (!sortEl || !activePlaylistId) return
  sortEl.value = getViewSort(activePlaylistId, "vod")
}
sortEl?.addEventListener("change", () => {
  if (!activePlaylistId || !sortEl) return
  setViewSort(activePlaylistId, "vod", sortEl.value)
  applyFilter()
})

const { langFilterEl, syncHideWatchedControl, syncGroupLangsControl, syncLangFilterControl } =
  createGridSecondaryControls({
    contentKind: "vod",
    hideWatchedButtonId: "movie-hide-watched",
    groupLangsButtonId: "movie-group-langs",
    langFilterSelectId: "movie-lang",
    getActivePlaylistId: () => activePlaylistId,
    applyFilter,
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

  const currentValue = languageGroupingEnabled && activePlaylistId ? getLanguageFilter(activePlaylistId, "vod") : ""
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
  debounce(() => {
    applyFilter()
    clearSearchBtn?.classList.toggle("hidden", !searchEl.value)
  }, 160)
)

clearSearchBtn?.addEventListener("click", () => {
  if (!searchEl) return
  searchEl.value = ""
  clearSearchBtn.classList.add("hidden")
  personSuggest.clear()
  applyFilter()
})

// ----------------------------
// Load movies
// ----------------------------
function showEmptyState() {
  if (listStatus) {
    listStatus.innerHTML = `${t("list.noPlaylistAddOne")} <a href="/login" class="text-accent underline">${t("list.addOne")}</a>.`
  }
  filtered = []
  renderGrid()
}

function paintMovies(data, fromCache, age) {
  all = data
  groupingIndex = buildGroupingIndex(all)
  if (listStatus) {
    listStatus.textContent =
      t("movies.totalMovies", { count: all.length.toLocaleString() }) +
      (fromCache ? ` · ${fmtAge(age)}` : "")
  }
  picker.rerender()
  populateLanguageFilterOptions()
  refreshGenreSets(activePlaylistId)
  applyFilter()
}

async function fetchMovieRows() {
  const catMap = await ensureVodCategoryMap()
  const r = await xtreamApiFetch("get_vod_streams")
  const body = await r.text()
  if (!r.ok) {
    log.error("Upstream error body:", body)
    throw new Error(`API ${r.status}: ${body}`)
  }
  const parsed = JSON.parse(body)
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed?.movies || parsed?.results || []
  return (arr || [])
    .map((movie) => {
      const name = String(movie.name || movie.title || "")
      const id = Number(movie.stream_id || movie.id)
      const logo = movie.stream_icon || movie.cover || null
      const year = String(movie.year || movie.releaseDate || "").trim() || ""
      const rating = movie.rating || movie.rating_5based || movie.vote_average || ""
      const duration = movie.duration || movie.runtime || movie.duration_secs || ""
      const categoryId =
        (Array.isArray(movie.category_ids) &&
          movie.category_ids.length &&
          movie.category_ids[0]) ||
        movie.category_id
      let category = String(movie.category_name || "").trim()
      if (!category && categoryId != null && catMap?.size) {
        category = catMap.get(String(categoryId)) || ""
      }
      const added = Number(movie.added) || 0
      const tmdb = Number(movie.tmdb) || Number(movie.tmdb_id) || null
      return {
        id,
        name,
        logo: logo || null,
        year,
        rating: rating ? String(rating) : "",
        duration: duration ? String(duration) : "",
        category,
        plot: "",
        added,
        norm: normalize(`${name} ${category} ${year}`),
        tmdb,
      }
    })
    .filter((movie) => movie.id && movie.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    )
}

async function loadMovies() {
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
  await hydrateCache(active._id, "vod")

  const hit = getCached(active._id, "vod")
  if (hit) {
    paintMovies(hit.data, true, hit.age)
    if (rowsNeedTmdbBackfill(hit.data)) {
      triggerTmdbBackfillOnce(active._id, "vod", VOD_TTL_MS, fetchMovieRows)
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
    listStatus.textContent = t("movies.requiresXtream")
    return
  }
  if (hit) return

  try {
    const { data, fromCache, age } = await cachedFetch(
      active._id,
      "vod",
      VOD_TTL_MS,
      fetchMovieRows
    )

    paintMovies(data, fromCache, age)
  } catch (e) {
    log.error("[xt:movies] loadMovies threw:", e)
    filtered = []
    renderGrid()
    renderProviderError(listStatus, {
      providerName: activePlaylistTitle,
      kind: "movies",
      onRetry: loadMovies,
    })
  }
}

// ----------------------------
// Boot
// ----------------------------
// First-paint skeleton
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
  loadMovies()
})

document.addEventListener("xt:cache-revalidated", (ev) => {
  const detail = (ev as CustomEvent).detail
  if (!detail || detail.entryId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  loadMovies()
})

// Re-paint the skeleton wave when the user kicks off a manual catalog
// re-warm (Refresh active in /settings). Only when the grid is currently
// empty or already showing skeletons - never wipe real content.
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
    loadMovies()
  } else {
    showEmptyState()
  }
})()
