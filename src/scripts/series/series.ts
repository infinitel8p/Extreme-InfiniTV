// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Series listing page (route: /series).
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
import { getCached } from "@/scripts/lib/cache.js"
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
  PROGRESS_CHANGED_EVENT,
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
import {
  getCachedSeasonCount,
  getCachedEpisodeIds,
  requestEpisodeIds,
  observeSeasonCount,
  seasonsLabel,
} from "@/scripts/lib/series-seasons.ts"
import { resolveSeriesNextUp } from "@/scripts/lib/tv-cast-next.ts"
import { castXtreamEpisodeToTv } from "@/scripts/lib/tv-cast.ts"
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
const gridEl = document.getElementById("series-grid")
const listStatus = document.getElementById("series-list-status")
const mergeStatusEl = document.getElementById("series-merge-status")
const mergeIndicator = mergeStatusEl
  ? createMergedLoadIndicator({
      host: mergeStatusEl,
      getTitle: (playlistId) => playlistTitleById.get(playlistId) || "",
      t,
    })
  : null

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
let groupingIndexByPlaylist = new Map()

let activePlaylistId = ""
let mergedPlaylistIds = []
let mergedPlaylistIdSet = new Set()
let playlistTitleById = new Map()
let credsByPlaylistId = new Map()
let loadRunToken = 0

// Series fully watched against their real episode list, not just recorded
// progress entries, as rowKey values. Recomputed whenever progress/hide-watched state changes.
let fullyWatchedSeriesKeys = new Set()
let recomputeRunToken = 0

// Last computed id set per playlist, so a recompute skips the O(series x episodes)
// scan for playlists already done. Invalidated on xt:progress-changed.
const fullyWatchedCacheByPlaylistId = new Map()

function isSeriesFullyWatched(playlistId, seriesId) {
  return fullyWatchedSeriesKeys.has(rowKey({ playlistId, id: seriesId }))
}

function mergeFullyWatchedKeys() {
  const keys = new Set()
  for (const playlistId of mergedPlaylistIds) {
    for (const seriesId of fullyWatchedCacheByPlaylistId.get(playlistId) || []) {
      keys.add(rowKey({ playlistId, id: seriesId }))
    }
  }
  fullyWatchedSeriesKeys = keys
}

function scheduleIdle(callback) {
  const requestIdle =
    typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback
      : (fn) => setTimeout(fn, 0)
  return requestIdle(callback)
}

async function recomputeFullyWatched() {
  const runToken = ++recomputeRunToken
  const idsKey = mergedPlaylistIds.join("|")
  const isCurrent = () => runToken === recomputeRunToken && idsKey === mergedPlaylistIds.join("|")
  if (!mergedPlaylistIds.length) {
    fullyWatchedSeriesKeys = new Set()
    return
  }

  for (const playlistId of mergedPlaylistIds) {
    if (fullyWatchedCacheByPlaylistId.has(playlistId)) continue

    const next = new Set()
    const candidates = []
    for (const series of all) {
      if (series.playlistId !== playlistId) continue
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
      if (!isCurrent()) return
      const episodeIds =
        getCachedEpisodeIds(playlistId, series.id) ??
        (await requestEpisodeIds(playlistId, series.id))
      if (!isCurrent()) return
      if (!episodeIds || !episodeIds.length) continue
      const completedIds = new Set(
        getSeriesEpisodeProgress(playlistId, series.id).completedIds
      )
      if (episodeIds.every((episodeId) => completedIds.has(episodeId))) {
        next.add(series.id)
      }
    }

    if (!isCurrent()) return
    fullyWatchedCacheByPlaylistId.set(playlistId, next)
  }

  if (!isCurrent()) return
  mergeFullyWatchedKeys()
}

// Runs the recompute off the critical path so the first grid paint isn't
// blocked by the series x episodes scan, then applies the result to the
// already-rendered UI once it lands.
function scheduleFullyWatchedRecompute() {
  const idsKey = mergedPlaylistIds.join("|")
  scheduleIdle(async () => {
    if (idsKey !== mergedPlaylistIds.join("|")) return
    await recomputeFullyWatched()
    if (idsKey !== mergedPlaylistIds.join("|")) return
    if (getHideWatched(activePlaylistId, "series")) {
      applyFilter()
    } else {
      refreshSeriesProgressBadges()
    }
  })
}

// Genre index is async and rebuilt local-only; per-playlist snapshots avoid races on quick switches.
const genreSetsByPlaylist = new Map()
const genreSetsLoading = new Set()

async function refreshGenreSets(playlistId) {
  if (!playlistId) return
  genreSetsLoading.add(playlistId)
  try {
    const index = await getGenreIndex(playlistId, "series")
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
  if (!detail || detail.kind !== "series") return
  if (!mergedPlaylistIdSet.has(detail.playlistId)) return
  refreshGenreSets(detail.playlistId)
})

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const picker = mountCategoryPicker({
  kind: "series",
  idPrefix: "series-category-picker",
  activeCatStorageKey: "xt_series_active_cat",
  activeCatChangedEvent: "xt:series-cat-changed",
  getActivePlaylistId: () => activePlaylistId,
  getSources: () =>
    mergedPlaylistIds.map((playlistId) => ({
      playlistId,
      title: playlistTitleById.get(playlistId) || "",
    })),
  getItems: () => all,
})
document.addEventListener("xt:series-cat-changed", (ev) => {
  const activeCat = /** @type {CustomEvent} */ (ev).detail
  if (typeof activeCat === "string" && activeCat.startsWith(GENRE_CAT_PREFIX)) {
    for (const playlistId of mergedPlaylistIds) {
      ensureGenreBoost(playlistId, "series", activeCat.slice(GENRE_CAT_PREFIX.length)).catch(() => {})
    }
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
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "series") return
  if (picker.getActiveCat() === CAT_FAVORITES) applyFilter()
  else updateGridStarFor(detail.playlistId, detail.id)
  picker.refreshPseudoRows()
})

document.addEventListener("xt:watchlist-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "series") return
  updateGridWatchBadgeFor(detail.playlistId, detail.id)
})

document.addEventListener("xt:recents-changed", (ev) => {
  const detail = /** @type {CustomEvent} */ (ev).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "series") return
  if (picker.getActiveCat() === CAT_RECENTS) applyFilter()
  picker.refreshPseudoRows()
})

const onSeriesFilterChange = (ev: Event) => {
  const detail = /** @type {CustomEvent} */ (ev as any).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "series") return
  applyFilter()
}
document.addEventListener("xt:hidden-categories-changed", onSeriesFilterChange)
document.addEventListener("xt:allowed-categories-changed", onSeriesFilterChange)
document.addEventListener("xt:category-mode-changed", onSeriesFilterChange)

document.addEventListener(PROGRESS_CHANGED_EVENT, async (event) => {
  const detail = /** @type {CustomEvent} */ (event).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.playlistId)) return
  if (detail.kind !== "episode") return
  fullyWatchedCacheByPlaylistId.delete(detail.playlistId)
  await recomputeFullyWatched()
  if (!mergedPlaylistIdSet.has(detail.playlistId)) return
  if (getHideWatched(activePlaylistId, "series")) {
    applyFilter()
    return
  }
  const seriesId = Number(detail.seriesId ?? 0)
  if (!seriesId) {
    refreshSeriesProgressBadges()
    return
  }
  refreshSeriesProgressBadges(detail.playlistId, seriesId)
})

// specificSeriesId may be any variant id in the group, not just the displayed one.
function refreshSeriesProgressBadges(specificPlaylistId, specificSeriesId) {
  if (!gridEl) return
  const cards = gridEl.querySelectorAll("[data-idx]")
  for (const card of cards) {
    const idx = Number(card.dataset.idx)
    const group = filtered[idx]
    if (!group) continue
    if (specificSeriesId && (group.playlistId !== specificPlaylistId || !group.globalEntryIds.includes(specificSeriesId))) continue
    const wrap = card.querySelector("[data-poster-wrap]")
    if (!wrap) continue
    wrap.querySelector(".series-progress-badge")?.remove()
    wrap.querySelector(`.${WATCHED_BADGE_CLASS}`)?.remove()
    const anyWatched = group.globalEntryIds.some((id) => isSeriesFullyWatched(group.playlistId, id))
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
// Poster grid
// ----------------------------
const PAGE_SIZE = 200
const AUTO_LOAD_CAP = 1500
/** @type {IntersectionObserver|null} */
let infiniteObs = null
let renderedCount = 0

// makeFallback is imported from entry-card.

function seasonEpisodeCount(playlistId, seriesId, season) {
  if (!playlistId || !seriesId || season == null) return 0
  const cached = getCached(playlistId, `series_info_${seriesId}`)
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
    const summary = getSeriesProgressSummary(group.playlistId, entryId)
    if (summary) return { seriesId: entryId, summary }
  }
  return null
}

function makeSeriesProgressBadge(series, group) {
  const playlistId = group.playlistId
  if (!playlistId) return null
  const progress = findGroupProgress(group)
  if (!progress) return null
  const { seriesId, summary } = progress

  const season = summary.lastSeason
  const episodeNum = summary.lastEpisodeNum
  const epId = summary.lastEpisodeId

  const seasonLabel = season != null && season !== "" ? `S${season}` : ""
  const total = season != null ? seasonEpisodeCount(playlistId, seriesId, season) : 0

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
  badge.href = epId
    ? detailHrefFor("series", seriesId, { playlistId, autoplay: true, episode: epId })
    : detailHrefFor("series", seriesId, { playlistId })
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

function seriesMetaText(entry, seasonCount, playlistId) {
  const parts = []
  if (entry.year) parts.push(entry.year)
  if (seasonCount) parts.push(seasonsLabel(seasonCount))
  if (entry.category) parts.push(entry.category)
  const playlistTitle = isMergedView() ? playlistTitleById.get(playlistId) : ""
  if (playlistTitle) parts.push(playlistTitle)
  return parts.join(" \u2022 ")
}

// Strip the tag prefix (redundant once the language shows as a chip) only when 2+ languages are grouped.
function displayCardEntry(group) {
  const displayEntry = group.displayEntry
  const stripPrefix =
    group.tags.length >= 2 && groupingIndexByPlaylist.get(group.playlistId)?.tagByEntryId.get(displayEntry.id)
  return stripPrefix ? { ...displayEntry, name: parseNamePrefix(displayEntry.name).rest } : displayEntry
}

function makeCard(group, idx) {
  const playlistId = group.playlistId
  const displayEntry = group.displayEntry
  const groupingIndex = groupingIndexByPlaylist.get(playlistId)
  const creds = credsByPlaylistId.get(playlistId) || { host: "", port: "", user: "", pass: "" }
  const cardEntry = displayCardEntry(group)

  const card = buildEntryCard({
    entry: cardEntry,
    idx,
    kind: "series",
    playlistId,
    detailHref: (entry) => detailHrefFor("series", entry.id, { playlistId }),
    fallbackTitle: (entry) => t("list.seriesFallback", { id: entry.id }),
    metaText: (entry) =>
      seriesMetaText(entry, getCachedSeasonCount(playlistId, entry.id), playlistId),
    decoratePoster: (posterWrap, entry) => {
      const anyWatched = group.globalEntryIds.some((id) => isSeriesFullyWatched(playlistId, id))
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
        groupingIndex?.tagByEntryId.get(displayEntry.id)
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
    favoriteState: () => groupHasFavorite(playlistId, "series", group),
    onToggleFavorite: (entry, currentlyFavorited) => {
      toggleGroupFavorite(playlistId, "series", group, entry, currentlyFavorited)
    },
    watchlistState: () => groupHasWatchlist(playlistId, "series", group),
    onContextMenu: (entry, anchor, point) => {
      import("@/scripts/lib/poster-menu").then(({ openPosterMenu }) => {
        openPosterMenu({
          kind: "series",
          entry,
          playlistId,
          anchor,
          point,
          onOpen: () => {
            window.location.href = detailHrefFor("series", entry.id, { playlistId })
          },
          // omit single stream URL or download for series
          onPlayOnTv: isTauri && creds.host && creds.user && creds.pass
            ? () => {
                void (async () => {
                  if (!playlistId) return
                  const nextUp = await resolveSeriesNextUp(playlistId, entry.id)
                  if (!nextUp) return
                  castXtreamEpisodeToTv({
                    creds,
                    playlistId: playlistId,
                    seriesId: entry.id,
                    episodeId: nextUp.episodeId,
                    containerExt: nextUp.containerExt,
                    season: nextUp.season,
                    episodeNum: nextUp.episodeNum,
                    title: nextUp.title || entry.name || null,
                    logo: entry.logo || undefined,
                    resumeSeconds: nextUp.resumeSeconds,
                    contentHref: detailHrefFor("series", entry.id, { playlistId }),
                  })()
                })()
              }
            : undefined,
          favoriteActive: () => groupHasFavorite(playlistId, "series", group),
          onToggleFavorite: (currentlyFavorited) => {
            toggleGroupFavorite(playlistId, "series", group, entry, currentlyFavorited)
          },
          watchlistActive: () => groupHasWatchlist(playlistId, "series", group),
          onToggleWatchlist: (currentlyOnWatchlist) => {
            toggleGroupWatchlist(playlistId, "series", group, entry, currentlyOnWatchlist)
          },
          // Mirrors fullyWatchedSeriesKeys, the same group-derived set the grid badge reads.
          watchedActive: () => group.globalEntryIds.some((id) => isSeriesFullyWatched(playlistId, id)),
          onToggleWatched: (currentlyWatched) => {
            if (!playlistId) return
            if (!currentlyWatched) {
              for (const variantId of group.globalEntryIds) {
                if (isSeriesFullyWatched(playlistId, variantId)) continue
                setSeriesWatchedOverride(playlistId, variantId, true)
              }
              return
            }
            for (const variantId of group.globalEntryIds) {
              if (isSeriesFullyWatched(playlistId, variantId)) {
                setSeriesWatchedOverride(playlistId, variantId, false)
              }
            }
          },
        })
      })
    },
  })

  if (playlistId) {
    const metaEl = card.querySelector('[data-role="meta"]')
    if (metaEl) {
      observeSeasonCount(card, playlistId, displayEntry.id, (count) => {
        metaEl.textContent = seriesMetaText(displayEntry, count, playlistId)
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
function updateGridStarFor(playlistId, seriesId) {
  if (!gridEl) return
  const idx = filtered.findIndex(
    (group) => group.playlistId === playlistId && group.globalEntryIds.includes(seriesId)
  )
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const displayEntry = group.displayEntry
  const fav = groupHasFavorite(group.playlistId, "series", group)
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
function updateGridWatchBadgeFor(playlistId, seriesId) {
  if (!gridEl) return
  const idx = filtered.findIndex(
    (group) => group.playlistId === playlistId && group.globalEntryIds.includes(seriesId)
  )
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const group = filtered[idx]
  const onWatchlist = groupHasWatchlist(group.playlistId, "series", group)
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
  basePath: "/series",
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
    favoritesFor: (playlistId) => getFavorites(playlistId, "series"),
    recentsFor: (playlistId) => getRecents(playlistId, "series"),
    genreSetFor: (playlistId, genreId) => genreSetsByPlaylist.get(playlistId)?.get(genreId),
    categoryPassesFilter: picker.categoryPassesFilter,
    fallbackPlaylistId: activePlaylistId,
    fallbackCategoryName: t("stream.uncategorized"),
  })

  const personTitleIds = personFilter.getTitleIds()
  if (personFilter.isActive() && personTitleIds) {
    out = out.filter((series) => personTitleIds.has(rowKey(series)))
  }

  /** @type {Map<string, number> | null} */
  let scoreById = null
  if (tokens.length) {
    scoreById = new Map()
    const scored = []
    for (const series of out) {
      const score = scoreNormMatch(series.norm, tokens, series.name)
      if (score > 0) {
        scored.push(series)
        scoreById.set(rowKey(series), score)
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
    const groupingIndex = groupingIndexByPlaylist.get(series.playlistId)
    const innerKey = groupingEnabled ? groupingIndex?.keyByEntryId.get(series.id) ?? `e:${series.id}` : `e:${series.id}`
    const groupKey = `${series.playlistId}:${innerKey}`
    let survivors = survivorsByKey.get(groupKey)
    if (!survivors) {
      survivors = []
      survivorsByKey.set(groupKey, survivors)
      groupOrder.push({ groupKey, innerKey })
    }
    survivors.push(series)
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
    if (hideWatched && globalEntryIds.some((id) => isSeriesFullyWatched(playlistId, id))) continue

    const survivorIds = survivors.map((series) => series.id)
    const displayEntryId = pickPreferredEntryId(
      survivorIds,
      groupingIndex?.tagByEntryId ?? new Map(),
      preferredTags,
      groupingIndex?.qualityRankByEntryId ?? new Map()
    )
    const displayEntry = survivors.find((series) => series.id === displayEntryId) || survivors[0]
    const maxScore = scoreById ? Math.max(...survivors.map((series) => scoreById.get(rowKey(series)) || 0)) : 0
    const maxAdded = Math.max(...survivors.map((series) => Number(series.added) || 0))

    displayGroups.push({ key: groupKey, playlistId, entries: survivors, tags, globalEntryIds, displayEntry, maxScore, maxAdded })
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
  let totalGroups = all.length
  if (groupingEnabled) {
    totalGroups = 0
    for (const groupingIndex of groupingIndexByPlaylist.values()) totalGroups += groupingIndex.groupsByKey.size
  }
  listStatus.textContent = t("series.ofSeries", {
    shown: filtered.length.toLocaleString(),
    total: totalGroups.toLocaleString(),
  })
  const heroCount = document.getElementById("series-hero-count")
  if (heroCount) heroCount.textContent = filtered.length.toLocaleString()
  const heroCat = document.getElementById("series-hero-cat")
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
  mergeIndicator?.clear()
  filtered = []
  renderGrid()
}

async function paintSeries(read, fromCache) {
  all = read.rows
  groupingIndexByPlaylist = buildGroupingIndexesByPlaylist(all)
  if (listStatus) {
    const sourcesText = isMergedView()
      ? ` · ${t("list.merged.sources", { count: mergedPlaylistIds.length })}`
      : ""
    const ageText =
      fromCache && read.newestFetchedAt ? ` · ${fmtAge(Date.now() - read.newestFetchedAt)}` : ""
    listStatus.textContent =
      t("series.totalSeries", { count: all.length.toLocaleString() }) + sourcesText + ageText
  }
  picker.rerender()
  populateLanguageFilterOptions()
  for (const playlistId of mergedPlaylistIds) refreshGenreSets(playlistId).catch(() => {})
  // Paint immediately with whatever's cached so the fully-watched scan never
  // blocks first paint; the idle recompute below reconciles it. With hide-watched
  // on and an uncomputed playlist, await the scan so watched cards never
  // flash in and get pulled a moment later.
  const allCached = mergedPlaylistIds.every((playlistId) => fullyWatchedCacheByPlaylistId.has(playlistId))
  if (allCached) {
    mergeFullyWatchedKeys()
  } else if (getHideWatched(activePlaylistId, "series")) {
    await recomputeFullyWatched()
  } else {
    mergeFullyWatchedKeys()
  }
  applyFilter()
  scheduleFullyWatchedRecompute()
}

function sameRowSets(first, second) {
  return mergedPlaylistIds.every((playlistId) => first.byPlaylist.get(playlistId) === second.byPlaylist.get(playlistId))
}

const toastedFailures = new Set<string>()

async function loadSeries() {
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
  await hydrateMergedRows("series")
  if (runToken !== loadRunToken) return

  const credsList = [...credsByPlaylistId.values()]
  if (!credsList.some((creds) => creds.host)) {
    showEmptyState()
    return
  }
  if (!credsList.some((creds) => creds.user && creds.pass)) {
    listStatus.textContent = t("series.requiresXtream")
    mergeIndicator?.clear()
    filtered = []
    renderGrid()
    return
  }

  const cached = readMergedRows("series")
  const paintedFromCache = cached.rows.length > 0
  if (paintedFromCache) {
    await paintSeries(cached, true)
    if (runToken !== loadRunToken) return
    if (!isMergedView()) return
  } else {
    listStatus.textContent = t("common.loading")
    if (!gridEl?.querySelector("[data-skeleton]")) renderPosterSkeletons(gridEl)
  }
  for (const playlistId of mergedPlaylistIds) {
    const hasRows = (cached.byPlaylist.get(playlistId) || []).length > 0
    mergeIndicator?.setStatus(playlistId, hasRows ? "cached" : "loading")
  }

  const { rows, errors, byPlaylist, newestFetchedAt, anyStale, sources, isMerged } = await ensureMergedRows("series", {
    onPlaylistSettled: (playlistId, status, info) => {
      if (runToken !== loadRunToken) return
      if (status === "done") mergeIndicator?.setStatus(playlistId, "done", { count: info.count })
    },
  })
  if (runToken !== loadRunToken) return
  const settled = { rows, byPlaylist, newestFetchedAt, anyStale, sources, isMerged }

  const xtreamCount = credsList.filter((creds) => creds.user && creds.pass).length
  if (errors.size && errors.size >= xtreamCount && !rows.length) {
    log.error("[xt:series] loadSeries failed:", [...errors.values()])
    filtered = []
    renderGrid()
    mergeIndicator?.clear()
    renderProviderError(listStatus, {
      providerName: [...errors.keys()].map((playlistId) => playlistTitleById.get(playlistId) || "").filter(Boolean).join(", "),
      kind: "series",
      onRetry: loadSeries,
    })
    return
  }

  for (const playlistId of errors.keys()) {
    log.warn("[xt:series] playlist failed:", playlistId, errors.get(playlistId))
    mergeIndicator?.setStatus(playlistId, "error", { onRetry: () => loadSeries() })
    const hadCachedRows = (cached.byPlaylist.get(playlistId) || []).length > 0
    if (hadCachedRows || toastedFailures.has(playlistId)) continue
    toastedFailures.add(playlistId)
    toastWarn(t("list.merged.partialFailure", { title: playlistTitleById.get(playlistId) || "" }))
  }

  if (!paintedFromCache || !sameRowSets(cached, settled)) {
    // A changed catalog invalidates the cached fully-watched verdict for that playlist.
    for (const playlistId of mergedPlaylistIds) {
      if (cached.byPlaylist.get(playlistId) !== byPlaylist.get(playlistId)) {
        fullyWatchedCacheByPlaylistId.delete(playlistId)
      }
    }
    await paintSeries(settled, false)
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

document.addEventListener(MERGED_CHANGED_EVENT, () => {
  if (personFilter.isActive()) personFilter.clear()
  personSuggest.clear()
  gridRestore.reset()
  loadSeries()
})

document.addEventListener("xt:cache-revalidated", (ev) => {
  const detail = (ev as CustomEvent).detail
  if (!detail || !mergedPlaylistIdSet.has(detail.entryId)) return
  if (detail.kind !== "series") return
  // The catalog behind this playlist just changed in the background (episode
  // counts included), so the cached fully-watched verdict can no longer be trusted.
  fullyWatchedCacheByPlaylistId.delete(detail.entryId)
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
  loadSeries()
})()
