// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Movies / VOD listing page (route: /movies). Detail/playback lives on
// /movies/detail?id=<id> via src/scripts/movies/detail.ts.
import { log } from "@/scripts/lib/log.js"
import {
  getActiveEntry,
  getMergedEntries,
  entryToCreds,
  isTauri,
  MERGED_CHANGED_EVENT,
} from "@/scripts/lib/creds.js"
import { parseSearchQuery, scoreNormMatch } from "@/scripts/lib/text.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { t, initI18n, getActiveLocale } from "@/scripts/lib/i18n.js"
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
  getProgress,
} from "@/scripts/lib/preferences.js"
import { mountCategoryPicker, genreLabelForCategory } from "@/scripts/lib/category-picker.ts"
import { GENRE_CAT_PREFIX, GENRE_INDEX_EVENT, getGenreIndex, ensureGenreBoost } from "@/scripts/lib/genre-index.ts"
import { mountSurprisePicker } from "@/scripts/lib/surprise-picker.ts"
import { mountPersonSuggestStrip } from "@/scripts/lib/person-suggest.ts"
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
import { castXtreamVodToTv } from "@/scripts/lib/tv-cast.ts"
import {
  buildGroupingIndexesByPlaylist,
  pickPreferredEntryId,
  groupPassesLanguageFilter,
} from "@/scripts/lib/language-groups.ts"
import { parseNamePrefix, languageTagLabel, effectivePreferredTags } from "@/scripts/lib/language-tags.ts"
import { getContentLanguage, getLanguageGroupingEnabled } from "@/scripts/lib/app-settings.js"
import {
  fmtAge,
  posterSkeletonCount,
  renderPosterSkeletons,
  groupHasFavorite,
  groupHasWatchlist,
  toggleGroupFavorite,
  toggleGroupWatchlist,
  createPersonFilterController,
  createGridRestoreController,
  createGridSecondaryControls,
  personFilterGridSignature,
} from "@/scripts/lib/grid-view.ts"
import { detailHrefFor } from "@/scripts/lib/detail-href.ts"
import { selectRowsForCategory } from "@/scripts/lib/grid-filter.ts"
import { rowKey, parseMergedCategoryKey, categoryLabel } from "@/scripts/lib/merged-catalog-core.ts"
import { ensureMergedRows, hydrateMergedRows, readMergedRows, isMergedView } from "@/scripts/lib/merged-catalog.ts"
import { createMergedLoadIndicator } from "@/scripts/lib/merged-load-indicator.ts"
import { toastWarn } from "@/scripts/lib/toast.ts"

if (typeof history !== "undefined") history.scrollRestoration = "manual"

// ----------------------------
// UI refs
// ----------------------------
const gridEl = document.getElementById("movie-grid")
const listStatus = document.getElementById("movie-list-status")
const mergeStatusEl = document.getElementById("movie-merge-status")
const mergeIndicator = mergeStatusEl
  ? createMergedLoadIndicator({
      host: mergeStatusEl,
      getTitle: (playlistId) => playlistTitleById.get(playlistId) || "",
      t,
    })
  : null

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
let groupingIndexByPlaylist = new Map()

let activePlaylistId = ""
let mergedPlaylistIds = []
let mergedPlaylistIdSet = new Set()
let playlistTitleById = new Map()
let credsByPlaylistId = new Map()
let loadRunToken = 0

// Genre index is async and rebuilt local-only; per-playlist snapshots avoid races on quick switches.
const genreSetsByPlaylist = new Map()
const genreSetsLoading = new Set()

async function refreshGenreSets(playlistId) {
  if (!playlistId) return
  genreSetsLoading.add(playlistId)
  try {
    const index = await getGenreIndex(playlistId, "vod")
    if (!mergedPlaylistIdSet.has(playlistId)) return
    genreSetsByPlaylist.set(playlistId, index.sets)
    applyFilter()
  } finally {
    genreSetsLoading.delete(playlistId)
  }
}

// applyFilter can hit a genre category before any paint loaded the snapshot (back-nav, bfcache, playlist switch).
function ensureGenreSets() {
  for (const playlistId of mergedPlaylistIds) {
    if (genreSetsByPlaylist.has(playlistId) || genreSetsLoading.has(playlistId)) continue
    refreshGenreSets(playlistId).catch(() => {})
  }
}

document.addEventListener(GENRE_INDEX_EVENT, (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || detail.kind !== "vod") return
  if (!mergedPlaylistIdSet.has(detail.playlistId)) return
  refreshGenreSets(detail.playlistId)
})

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const picker = mountCategoryPicker({
  kind: "vod",
  idPrefix: "movie-category-picker",
  activeCatStorageKey: "xt_vod_active_cat",
  activeCatChangedEvent: "xt:movie-cat-changed",
  getActivePlaylistId: () => activePlaylistId,
  getSources: () =>
    mergedPlaylistIds.map((playlistId) => ({
      playlistId,
      title: playlistTitleById.get(playlistId) || "",
    })),
  getItems: () => all,
})
document.addEventListener("xt:movie-cat-changed", (ev) => {
  const activeCat = /** @type {CustomEvent} */ (ev).detail
  if (typeof activeCat === "string" && activeCat.startsWith(GENRE_CAT_PREFIX)) {
    for (const playlistId of mergedPlaylistIds) {
      ensureGenreBoost(playlistId, "vod", activeCat.slice(GENRE_CAT_PREFIX.length)).catch(() => {})
    }
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
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "vod") return
  if (picker.getActiveCat() === CAT_FAVORITES) applyFilter()
  else updateGridStarFor(detail.playlistId, detail.id)
  picker.refreshPseudoRows()
})

document.addEventListener("xt:watchlist-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "vod") return
  updateGridWatchBadgeFor(detail.playlistId, detail.id)
})

document.addEventListener("xt:recents-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "vod") return
  if (picker.getActiveCat() === CAT_RECENTS) applyFilter()
  picker.refreshPseudoRows()
})

document.addEventListener("xt:progress-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "vod") return
  if (getHideWatched(activePlaylistId, "vod")) {
    applyFilter()
    return
  }
  updateGridWatchedBadgeFor(detail.playlistId, detail.id)
})

const onMovieFilterChange = (ev: Event) => {
  const detail = /** @type {CustomEvent} */ (ev as any).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "vod") return
  applyFilter()
}
document.addEventListener("xt:hidden-categories-changed", onMovieFilterChange)
document.addEventListener("xt:allowed-categories-changed", onMovieFilterChange)
document.addEventListener("xt:category-mode-changed", onMovieFilterChange)

// ----------------------------
// Poster grid
// ----------------------------
const PAGE_SIZE = 200
const AUTO_LOAD_CAP = 1500
// Matches the resume threshold on /movies/detail.
const RESUME_MIN_SECONDS = 30

/** Resume/duration for a cast descriptor, from saved progress. */
function vodCastResume(playlistId, vodId) {
  const saved = playlistId ? getProgress(playlistId, "vod", vodId) : null
  if (!saved || saved.completed) return {}
  return {
    resumeSeconds: saved.position > RESUME_MIN_SECONDS ? saved.position : 0,
    durationSeconds: saved.duration > 0 ? saved.duration : undefined,
  }
}
/** @type {IntersectionObserver|null} */
let infiniteObs = null
let renderedCount = 0

function makeCard(group, idx) {
  const playlistId = group.playlistId
  const displayEntry = group.displayEntry
  const groupingIndex = groupingIndexByPlaylist.get(playlistId)
  const creds = credsByPlaylistId.get(playlistId) || { host: "", port: "", user: "", pass: "" }
  // Strip the tag prefix (redundant once the language shows as a chip) only when 2+ languages are grouped.
  const stripPrefix = group.tags.length >= 2 && groupingIndex?.tagByEntryId.get(displayEntry.id)
  const cardEntry = stripPrefix
    ? { ...displayEntry, name: parseNamePrefix(displayEntry.name).rest }
    : displayEntry

  return buildEntryCard({
    entry: cardEntry,
    idx,
    kind: "vod",
    playlistId,
    detailHref: (entry) => detailHrefFor("vod", entry.id, { playlistId }),
    fallbackTitle: (entry) => t("list.movieFallback", { id: entry.id }),
    metaText: (entry) => {
      const parts = []
      if (entry.year) parts.push(entry.year)
      if ((entry as any).duration) parts.push((entry as any).duration)
      if (entry.category) parts.push(entry.category)
      const playlistTitle = isMergedView() ? playlistTitleById.get(playlistId) : ""
      if (playlistTitle) parts.push(playlistTitle)
      return parts.join(" \u2022 ")
    },
    decoratePoster: (posterWrap, _entry) => {
      let badgePresent = false
      if (playlistId && group.globalEntryIds.some((id) => isCompleted(playlistId, "vod", id))) {
        posterWrap.appendChild(buildWatchedBadge())
        badgePresent = true
      }
      const chips = buildLanguageChips(
        group.tags,
        group.globalEntryIds.length,
        getActiveLocale(),
        groupingIndex?.tagByEntryId.get(displayEntry.id)
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
    favoriteState: () => groupHasFavorite(playlistId, "vod", group),
    onToggleFavorite: (entry, currentlyFavorited) => {
      toggleGroupFavorite(playlistId, "vod", group, entry, currentlyFavorited)
    },
    watchlistState: () => groupHasWatchlist(playlistId, "vod", group),
    onContextMenu: (entry, anchor, point) => {
      import("@/scripts/lib/poster-menu").then(({ openPosterMenu }) => {
        openPosterMenu({
          kind: "vod",
          entry,
          playlistId,
          anchor,
          point,
          onOpen: () => {
            window.location.href = detailHrefFor("vod", entry.id, { playlistId })
          },
          onDownload: () => {
            window.location.href = detailHrefFor("vod", entry.id, { playlistId, download: true })
          },
          buildStreamUrl: () => {
            if (!creds.host || !creds.user || !creds.pass) return null
            const containerExt = (entry as any).container_extension || null
            return buildMovieStreamUrl(creds, entry.id, containerExt)
          },
          onPlayOnTv: isTauri && creds.host && creds.user && creds.pass
            ? castXtreamVodToTv({
                creds,
                playlistId: playlistId,
                vodId: entry.id,
                containerExt: (entry as any).container_extension || null,
                title: entry.name || null,
                logo: entry.logo || undefined,
                ...vodCastResume(playlistId, entry.id),
              })
            : undefined,
          favoriteActive: () => groupHasFavorite(playlistId, "vod", group),
          onToggleFavorite: (currentlyFavorited) => {
            toggleGroupFavorite(playlistId, "vod", group, entry, currentlyFavorited)
          },
          watchlistActive: () => groupHasWatchlist(playlistId, "vod", group),
          onToggleWatchlist: (currentlyOnWatchlist) => {
            toggleGroupWatchlist(playlistId, "vod", group, entry, currentlyOnWatchlist)
          },
          watchedActive: () =>
            playlistId
              ? group.globalEntryIds.some((id) => isCompleted(playlistId, "vod", id))
              : false,
          onToggleWatched: (currentlyWatched) => {
            if (!playlistId) return
            if (!currentlyWatched) {
              for (const variantId of group.globalEntryIds) {
                if (isCompleted(playlistId, "vod", variantId)) continue
                const variantEntry = group.entries.find((movie) => movie.id === variantId) || entry
                markCompleted(playlistId, "vod", variantId, {
                  name: variantEntry.name || "",
                  logo: variantEntry.logo || null,
                })
              }
              return
            }
            for (const variantId of group.globalEntryIds) {
              if (isCompleted(playlistId, "vod", variantId)) {
                clearProgress(playlistId, "vod", variantId)
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
function updateGridStarFor(playlistId, movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex(
    (group) => group.playlistId === playlistId && group.globalEntryIds.includes(movieId)
  )
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const displayEntry = group.displayEntry
  const fav = groupHasFavorite(group.playlistId, "vod", group)
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
function updateGridWatchBadgeFor(playlistId, movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex(
    (group) => group.playlistId === playlistId && group.globalEntryIds.includes(movieId)
  )
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const onWatchlist = groupHasWatchlist(group.playlistId, "vod", group)
  const badge = /** @type {HTMLElement|null} */ (
    card.querySelector('[data-role="watch-badge"]')
  )
  if (!badge) return
  badge.hidden = !onWatchlist
}

// movieId may be any variant id in the group, not just the displayed one.
function updateGridWatchedBadgeFor(playlistId, movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex(
    (group) => group.playlistId === playlistId && group.globalEntryIds.includes(movieId)
  )
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const wrap = card.querySelector("[data-poster-wrap]")
  if (!wrap) return
  wrap.querySelector(`.${WATCHED_BADGE_CLASS}`)?.remove()
  const group = filtered[idx]
  const anyWatched = group.globalEntryIds.some((id) => isCompleted(group.playlistId, "vod", id))
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
  getPlaylistIds: () => mergedPlaylistIds,
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
  getPlaylistIds: () => mergedPlaylistIds,
})

// ----------------------------
// Search + filter
// ----------------------------
function applyFilter() {
  if (!listStatus) return
  // An active-but-unresolved person filter must never paint the unfiltered grid.
  if (personFilter.guardUnresolved()) return
  const tokens = parseSearchQuery(searchEl?.value || "")

  const activeCat = picker.getActiveCat()
  if (activeCat.startsWith(GENRE_CAT_PREFIX)) ensureGenreSets()
  let out = selectRowsForCategory(all, activeCat, {
    favoritesFor: (playlistId) => getFavorites(playlistId, "vod"),
    recentsFor: (playlistId) => getRecents(playlistId, "vod"),
    genreSetFor: (playlistId, genreId) => genreSetsByPlaylist.get(playlistId)?.get(genreId),
    categoryPassesFilter: picker.categoryPassesFilter,
    fallbackPlaylistId: activePlaylistId,
    fallbackCategoryName: t("stream.uncategorized"),
  })

  const personTitleIds = personFilter.getTitleIds()
  if (personFilter.isActive() && personTitleIds) {
    out = out.filter((movie) => personTitleIds.has(rowKey(movie)))
  }

  /** @type {Map<string, number> | null} */
  let scoreById = null
  if (tokens.length) {
    scoreById = new Map()
    const scored = []
    for (const movie of out) {
      const score = scoreNormMatch(movie.norm, tokens, movie.name)
      if (score > 0) {
        scored.push(movie)
        scoreById.set(rowKey(movie), score)
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
    const groupingIndex = groupingIndexByPlaylist.get(movie.playlistId)
    const innerKey = groupingEnabled ? groupingIndex?.keyByEntryId.get(movie.id) ?? `e:${movie.id}` : `e:${movie.id}`
    const groupKey = `${movie.playlistId}:${innerKey}`
    let survivors = survivorsByKey.get(groupKey)
    if (!survivors) {
      survivors = []
      survivorsByKey.set(groupKey, survivors)
      groupOrder.push({ groupKey, innerKey })
    }
    survivors.push(movie)
  }

  const displayGroups = []
  for (const { groupKey, innerKey } of groupOrder) {
    const survivors = survivorsByKey.get(groupKey)
    const playlistId = survivors[0].playlistId
    const groupingIndex = groupingIndexByPlaylist.get(playlistId)
    const globalInfo = groupingEnabled ? groupingIndex?.groupsByKey.get(innerKey) : null
    const ownTag = groupingIndex?.tagByEntryId.get(survivors[0].id) ?? null
    const tags = globalInfo ? globalInfo.tags : (ownTag ? [ownTag] : [])
    const globalEntryIds = globalInfo ? globalInfo.entryIds : [survivors[0].id]

    if (!groupPassesLanguageFilter(tags, selectedLang)) continue
    if (hideWatched && globalEntryIds.some((id) => isCompleted(playlistId, "vod", id))) continue

    const survivorIds = survivors.map((movie) => movie.id)
    const displayEntryId = pickPreferredEntryId(
      survivorIds,
      groupingIndex?.tagByEntryId ?? new Map(),
      preferredTags,
      groupingIndex?.qualityRankByEntryId ?? new Map()
    )
    const displayEntry = survivors.find((movie) => movie.id === displayEntryId) || survivors[0]
    const maxScore = scoreById ? Math.max(...survivors.map((movie) => scoreById.get(rowKey(movie)) || 0)) : 0
    const maxAdded = Math.max(...survivors.map((movie) => Number(movie.added) || 0))

    displayGroups.push({ key: groupKey, playlistId, entries: survivors, tags, globalEntryIds, displayEntry, maxScore, maxAdded })
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
  let totalGroups = all.length
  if (groupingEnabled) {
    totalGroups = 0
    for (const groupingIndex of groupingIndexByPlaylist.values()) totalGroups += groupingIndex.groupsByKey.size
  }
  listStatus.textContent = t("movies.ofMovies", {
    shown: filtered.length.toLocaleString(),
    total: totalGroups.toLocaleString(),
  })
  const heroCount = document.getElementById("movie-hero-count")
  if (heroCount) heroCount.textContent = filtered.length.toLocaleString()
  const heroCat = document.getElementById("movie-hero-cat")
  if (heroCat) {
    const selectedCategory = parseMergedCategoryKey(activeCat, activePlaylistId)
    heroCat.textContent =
      activeCat === CAT_FAVORITES
        ? t("list.heroFavorites")
        : activeCat === CAT_RECENTS
          ? t("list.heroRecents")
          : genreLabelForCategory(activeCat) ||
            (selectedCategory
              ? categoryLabel(
                  selectedCategory.name,
                  playlistTitleById.get(selectedCategory.playlistId) || "",
                  isMergedView()
                )
              : isMergedView()
                ? t("list.allPlaylists")
                : t("list.allCategories"))
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
    for (const groupingIndex of groupingIndexByPlaylist.values()) {
      for (const tag of groupingIndex.tagByEntryId.values()) {
        if (!tag) continue
        frequencyByTag.set(tag, (frequencyByTag.get(tag) || 0) + 1)
      }
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
  mergeIndicator?.clear()
  filtered = []
  renderGrid()
}

function paintMovies(read, fromCache) {
  all = read.rows
  groupingIndexByPlaylist = buildGroupingIndexesByPlaylist(all)
  if (listStatus) {
    const sourcesText = isMergedView()
      ? ` · ${t("list.merged.sources", { count: mergedPlaylistIds.length })}`
      : ""
    const ageText =
      fromCache && read.newestFetchedAt ? ` · ${fmtAge(Date.now() - read.newestFetchedAt)}` : ""
    listStatus.textContent =
      t("movies.totalMovies", { count: all.length.toLocaleString() }) + sourcesText + ageText
  }
  picker.rerender()
  populateLanguageFilterOptions()
  for (const playlistId of mergedPlaylistIds) refreshGenreSets(playlistId).catch(() => {})
  applyFilter()
}

function sameRowSets(first, second) {
  return mergedPlaylistIds.every((playlistId) => first.byPlaylist.get(playlistId) === second.byPlaylist.get(playlistId))
}

const toastedFailures = new Set<string>()

async function loadMovies() {
  if (!listStatus) return
  const runToken = ++loadRunToken
  const entries = await getMergedEntries()
  const activeEntry = await getActiveEntry()
  if (runToken !== loadRunToken) return
  if (!entries.length || !activeEntry) {
    activePlaylistId = ""
    mergedPlaylistIds = []
    mergedPlaylistIdSet = new Set()
    all = []
    showEmptyState()
    return
  }
  activePlaylistId = activeEntry._id
  mergedPlaylistIds = entries.map((entry) => entry._id)
  mergedPlaylistIdSet = new Set(mergedPlaylistIds)
  playlistTitleById = new Map(entries.map((entry) => [entry._id, entry.title || ""]))
  credsByPlaylistId = new Map(entries.map((entry) => [entry._id, entryToCreds(entry)]))
  for (const playlistId of [...genreSetsByPlaylist.keys()]) {
    if (!mergedPlaylistIdSet.has(playlistId)) genreSetsByPlaylist.delete(playlistId)
  }
  mergeIndicator?.setPlaylists(mergedPlaylistIds)

  gridRestore.attemptRestore()
  await ensurePrefsLoaded()
  syncSortControl()
  syncHideWatchedControl()
  syncGroupLangsControl()
  syncLangFilterControl()
  await hydrateMergedRows("vod")
  if (runToken !== loadRunToken) return

  const credsList = [...credsByPlaylistId.values()]
  if (!credsList.some((creds) => creds.host)) {
    showEmptyState()
    return
  }
  if (!credsList.some((creds) => creds.user && creds.pass)) {
    listStatus.textContent = t("movies.requiresXtream")
    mergeIndicator?.clear()
    filtered = []
    renderGrid()
    return
  }

  const cached = readMergedRows("vod")
  const paintedFromCache = cached.rows.length > 0
  if (paintedFromCache) {
    paintMovies(cached, true)
    if (!isMergedView()) return
  } else {
    listStatus.textContent = t("common.loading")
    if (!gridEl?.querySelector("[data-skeleton]")) renderPosterSkeletons(gridEl)
  }
  for (const playlistId of mergedPlaylistIds) {
    const hasRows = (cached.byPlaylist.get(playlistId) || []).length > 0
    mergeIndicator?.setStatus(playlistId, hasRows ? "cached" : "loading")
  }

  const { rows, errors, byPlaylist, newestFetchedAt, anyStale, sources, isMerged } = await ensureMergedRows("vod", {
    onPlaylistSettled: (playlistId, status, info) => {
      if (runToken !== loadRunToken) return
      if (status === "done") mergeIndicator?.setStatus(playlistId, "done", { count: info.count })
    },
  })
  if (runToken !== loadRunToken) return
  const settled = { rows, byPlaylist, newestFetchedAt, anyStale, sources, isMerged }

  const xtreamCount = credsList.filter((creds) => creds.user && creds.pass).length
  if (errors.size && errors.size >= xtreamCount && !rows.length) {
    log.error("[xt:movies] loadMovies failed:", [...errors.values()])
    filtered = []
    renderGrid()
    mergeIndicator?.clear()
    renderProviderError(listStatus, {
      providerName: [...errors.keys()].map((playlistId) => playlistTitleById.get(playlistId) || "").filter(Boolean).join(", "),
      kind: "movies",
      onRetry: loadMovies,
    })
    return
  }

  for (const playlistId of errors.keys()) {
    log.warn("[xt:movies] playlist failed:", playlistId, errors.get(playlistId))
    mergeIndicator?.setStatus(playlistId, "error", { onRetry: () => loadMovies() })
    const hadCachedRows = (cached.byPlaylist.get(playlistId) || []).length > 0
    if (hadCachedRows || toastedFailures.has(playlistId)) continue
    toastedFailures.add(playlistId)
    toastWarn(t("list.merged.partialFailure", { title: playlistTitleById.get(playlistId) || "" }))
  }

  if (!paintedFromCache || !sameRowSets(cached, settled)) paintMovies(settled, false)
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

document.addEventListener(MERGED_CHANGED_EVENT, () => {
  if (personFilter.isActive()) personFilter.clear()
  personSuggest.clear()
  gridRestore.reset()
  loadMovies()
})

document.addEventListener("xt:cache-revalidated", (ev) => {
  const detail = (ev as CustomEvent).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.entryId)) return
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
  loadMovies()
})()
