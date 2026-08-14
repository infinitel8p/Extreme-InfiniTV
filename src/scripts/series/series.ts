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
import { rowsNeedTmdbBackfill } from "@/scripts/lib/catalog-mappers.js"
import { triggerTmdbBackfillOnce } from "@/scripts/lib/tmdb-backfill.ts"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  getSeriesEpisodeProgress,
  getFavorites,
  getRecents,
  getViewSort,
  setViewSort,
  getSeriesProgressSummary,
  getHideWatched,
  setHideWatched,
  hasSeriesWatchedOverride,
  setSeriesWatchedOverride,
  getLanguageFilter,
  setLanguageFilter,
  getGroupLanguages,
  setGroupLanguages,
} from "@/scripts/lib/preferences.js"
import { mountCategoryPicker } from "@/scripts/lib/category-picker.ts"
import { mountSurprisePicker } from "@/scripts/lib/surprise-picker.ts"
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
import { resolvePersonTitleIds } from "@/scripts/lib/person-filter.ts"
import { saveGridState, takeGridState, gridStateMatchesLocation } from "@/scripts/lib/grid-state.ts"
import { buildGroupingIndex, pickPreferredEntryId, groupPassesLanguageFilter } from "@/scripts/lib/language-groups.ts"
import { parseNamePrefix, languageTagLabel, effectivePreferredTags } from "@/scripts/lib/language-tags.ts"
import { getContentLanguage, getLanguageGroupingEnabled } from "@/scripts/lib/app-settings.js"

const SERIES_TTL_MS = 24 * 60 * 60 * 1000

if (typeof history !== "undefined") history.scrollRestoration = "manual"

function fmtAge(ms) {
  if (ms < 60_000) return "just now"
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

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
document.addEventListener("xt:series-cat-changed", () => applyFilter())

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
  const r = await xtreamApiFetch("get_series_categories")
  const data = await r.json().catch(() => [])
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.categories)
    ? data.categories
    : []
  categoryMap = new Map(
    arr
      .filter((c) => c && c.category_id != null)
      .map((c) => [String(c.category_id), String(c.category_name || "").trim()])
  )
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
    favoriteState: () =>
      activePlaylistId
        ? group.globalEntryIds.some((id) => isFavorite(activePlaylistId, "series", id))
        : false,
    onToggleFavorite: (entry, currentlyFavorited) => {
      if (!activePlaylistId) return
      if (!currentlyFavorited) {
        toggleFavorite(activePlaylistId, "series", entry.id, {
          name: entry.name || "",
          logo: entry.logo || null,
        })
        return
      }
      for (const variantId of group.globalEntryIds) {
        if (isFavorite(activePlaylistId, "series", variantId)) {
          toggleFavorite(activePlaylistId, "series", variantId)
        }
      }
    },
    watchlistState: () =>
      activePlaylistId
        ? group.globalEntryIds.some((id) => isOnWatchlist(activePlaylistId, "series", id))
        : false,
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
          favoriteActive: () =>
            activePlaylistId
              ? group.globalEntryIds.some((id) => isFavorite(activePlaylistId, "series", id))
              : false,
          onToggleFavorite: (currentlyFavorited) => {
            if (!activePlaylistId) return
            if (!currentlyFavorited) {
              toggleFavorite(activePlaylistId, "series", entry.id, {
                name: entry.name || "",
                logo: entry.logo || null,
              })
              return
            }
            for (const variantId of group.globalEntryIds) {
              if (isFavorite(activePlaylistId, "series", variantId)) {
                toggleFavorite(activePlaylistId, "series", variantId)
              }
            }
          },
          watchlistActive: () =>
            activePlaylistId
              ? group.globalEntryIds.some((id) => isOnWatchlist(activePlaylistId, "series", id))
              : false,
          onToggleWatchlist: (currentlyOnWatchlist) => {
            if (!activePlaylistId) return
            if (!currentlyOnWatchlist) {
              toggleWatchlist(activePlaylistId, "series", entry.id, {
                name: entry.name || "",
                logo: entry.logo || null,
              })
              return
            }
            for (const variantId of group.globalEntryIds) {
              if (isOnWatchlist(activePlaylistId, "series", variantId)) {
                toggleWatchlist(activePlaylistId, "series", variantId)
              }
            }
          },
          // Mirrors fullyWatchedSeriesIds, the same group-derived set the grid badge reads.
          watchedActive: () => group.globalEntryIds.some((id) => fullyWatchedSeriesIds.has(id)),
          onToggleWatched: (currentlyWatched) => {
            if (!activePlaylistId) return
            if (!currentlyWatched) {
              setSeriesWatchedOverride(activePlaylistId, entry.id, true)
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

function posterSkeletonGeometry() {
  const w = typeof window !== "undefined" ? window.innerWidth || 1280 : 1280
  const h = typeof window !== "undefined" ? window.innerHeight || 720 : 720
  const cardW = w >= 1024 ? 176 : w >= 640 ? 160 : 128
  const cardH = cardW * 1.7
  const cols = Math.max(2, Math.floor((w - 48) / (cardW + 16)))
  const rows = Math.max(2, Math.ceil(h / cardH) + 1)
  const count = Math.min(48, cols * rows)
  return { cols, count }
}

function posterSkeletonCount() {
  return posterSkeletonGeometry().count
}

function renderPosterSkeletons(target, count) {
  if (!target) return
  const geom = posterSkeletonGeometry()
  const total = Number.isFinite(count) && count > 0 ? count : geom.count
  const cols = geom.cols || 4
  const frag = document.createDocumentFragment()
  for (let i = 0; i < total; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const waveDelay = ((col * 90) + (row * 140)) % 1600
    const enterDelay = Math.min(i, 8) * 28

    const card = document.createElement("div")
    card.dataset.skeleton = "true"
    card.className =
      "rounded-xl overflow-hidden ring-1 ring-line bg-surface-2"
    card.style.setProperty("--skel-delay", `${waveDelay}ms`)
    card.style.setProperty("--skel-enter-delay", `${enterDelay}ms`)
    card.innerHTML =
      `<div class="aspect-2/3 w-full skel" style="--skel-delay:${waveDelay}ms;"></div>
       <div class="px-2 py-2 flex flex-col gap-1.5">
         <div class="h-3 rounded skel" style="width:${60 + ((i * 7) % 35)}%; --skel-delay:${waveDelay + 80}ms;"></div>
         <div class="h-2.5 rounded skel" style="width:${30 + ((i * 5) % 30)}%; --skel-delay:${waveDelay + 160}ms;"></div>
       </div>`
    frag.appendChild(card)
  }
  target.replaceChildren(frag)
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
  const s = group.displayEntry
  const fav = activePlaylistId
    ? group.globalEntryIds.some((id) => isFavorite(activePlaylistId, "series", id))
    : false
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
      ? `Remove ${s.name || "series"} from favorites`
      : `Add ${s.name || "series"} to favorites`
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
  const onWatchlist = activePlaylistId
    ? group.globalEntryIds.some((id) => isOnWatchlist(activePlaylistId, "series", id))
    : false
  const badge = /** @type {HTMLElement|null} */ (
    card.querySelector('[data-role="watch-badge"]')
  )
  if (!badge) return
  badge.hidden = !onWatchlist
}

// ----------------------------
// Grid state restore (back-navigation from a detail page)
// ----------------------------
/** @type {import("@/scripts/lib/grid-state.ts").GridState | null} */
let pendingGridState = null
let gridRestoreAttempted = false

function isRestoreNavigation() {
  try {
    const navigationType = performance.getEntriesByType("navigation")[0]?.type
    return navigationType === "back_forward" || navigationType === "reload"
  } catch {
    return false
  }
}

function attemptGridRestore() {
  if (gridRestoreAttempted) return
  gridRestoreAttempted = true
  if (!isRestoreNavigation()) return
  const candidate = takeGridState("series", activePlaylistId)
  if (!candidate || !gridStateMatchesLocation(candidate, location.search)) return
  pendingGridState = candidate
  if (searchEl) searchEl.value = candidate.search
}

function extendRenderedCountTo(target) {
  const cappedTarget = Math.min(target, filtered.length)
  while (renderedCount < cappedTarget) {
    const before = renderedCount
    appendNextPage()
    if (renderedCount === before) break
  }
}

function captureScrollY() {
  const windowY = typeof window !== "undefined" ? window.scrollY || 0 : 0
  const gridY = gridEl ? gridEl.scrollTop || 0 : 0
  return Math.max(windowY, gridY)
}

// The grid section owns its own overflow-auto scroll; restore both it and
// the window in case a layout has the page itself scrolling instead.
function restoreScrollY(scrollY) {
  window.scrollTo(0, scrollY)
  if (gridEl) gridEl.scrollTop = scrollY
}

function scheduleScrollRestore(scrollY) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      restoreScrollY(scrollY)
    })
  })
}

// Runs once the grid has actually rendered the settled (filtered) result,
// so the extra pages append before the browser paints - no page-1-then-jump flash.
function consumePendingGridRestore() {
  if (!pendingGridState) return
  const state = pendingGridState
  pendingGridState = null
  extendRenderedCountTo(state.renderedCount)
  scheduleScrollRestore(state.scrollY)
}

function currentGridStateSnapshot() {
  const personParams = readPersonFilterParams()
  return {
    search: searchEl?.value || "",
    renderedCount,
    scrollY: captureScrollY(),
    personSignature: personParams ? { person: personParams.name, personId: personParams.tmdbId } : null,
  }
}

function isDefaultGridState(state) {
  return !state.search && state.renderedCount <= PAGE_SIZE && state.scrollY < 100
}

window.addEventListener("pagehide", () => {
  if (!activePlaylistId) return
  const state = currentGridStateSnapshot()
  if (isDefaultGridState(state)) return
  saveGridState("series", activePlaylistId, state)
})

// ----------------------------
// Person filter (cast/crew chip from a detail page)
// ----------------------------
let personFilterActive = false
let personFilterName = ""
let personFilterTmdbId = null
/** @type {Set<number>|null} null while inactive or unresolved; a resolved miss is an empty Set. */
let personTitleIds = null
let personFilterInFlight = false
let personFilterToken = 0

function readPersonFilterParams() {
  const params = new URLSearchParams(location.search)
  const name = params.get("person")
  if (!name) return null
  const tmdbId = Number(params.get("personId"))
  return { name, tmdbId: Number.isFinite(tmdbId) && tmdbId > 0 ? tmdbId : null }
}

function stripPersonFilterFromUrl() {
  const params = new URLSearchParams(location.search)
  params.delete("person")
  params.delete("personId")
  const next = params.toString()
  history.replaceState(null, "", location.pathname + (next ? `?${next}` : ""))
}

const personFilterRow = document.getElementById("series-person-filter-row")
const personFilterLabel = document.getElementById("series-person-filter-label")

function renderPersonFilterRow() {
  if (!personFilterRow || !personFilterLabel) return
  if (!personFilterActive) {
    personFilterRow.setAttribute("hidden", "")
    return
  }
  personFilterLabel.textContent = t("list.personFilter", { name: personFilterName })
  personFilterRow.removeAttribute("hidden")
}

function deactivatePersonFilter() {
  personFilterActive = false
  personFilterName = ""
  personFilterTmdbId = null
  personTitleIds = null
  stripPersonFilterFromUrl()
  renderPersonFilterRow()
}

function clearPersonFilter() {
  if (!personFilterActive) return
  personFilterToken++
  deactivatePersonFilter()
  applyFilter()
}

document.getElementById("series-person-filter-clear")?.addEventListener("click", clearPersonFilter)

// Resolved once per activation; a later paint (SWR revalidation, cache hit) is a no-op once settled.
// While unresolved, applyFilter defers rendering entirely so the grid never flashes unfiltered.
function ensurePersonFilterResolved() {
  if (!personFilterActive || personTitleIds !== null || personFilterInFlight) return
  personFilterInFlight = true
  const token = ++personFilterToken
  let resolutionFailed = false
  resolvePersonTitleIds({
    kind: "series",
    playlistId: activePlaylistId,
    personName: personFilterName,
    tmdbPersonId: personFilterTmdbId,
    catalogEntries: all,
  })
    .then((ids) => {
      if (token === personFilterToken) personTitleIds = ids
    })
    .catch((err) => {
      log.warn("[xt:series] person filter resolution failed:", err)
      resolutionFailed = true
    })
    .finally(() => {
      personFilterInFlight = false
      if (token !== personFilterToken) return
      // Both sources failed outright: degrade silently to the unfiltered grid rather
      // than getting stuck. A legitimate zero-match resolution keeps the pill + empty state.
      if (resolutionFailed) deactivatePersonFilter()
      applyFilter()
    })
}

const initialPersonFilter = readPersonFilterParams()
if (initialPersonFilter) {
  personFilterActive = true
  personFilterName = initialPersonFilter.name
  personFilterTmdbId = initialPersonFilter.tmdbId
}

// ----------------------------
// Search + filter
// ----------------------------
function applyFilter() {
  if (!listStatus) return
  // An active-but-unresolved person filter must never paint the unfiltered grid: kick off
  // resolution (idempotent) and bail. ensurePersonFilterResolved calls applyFilter once settled.
  if (personFilterActive && personTitleIds === null) {
    ensurePersonFilterResolved()
    return
  }
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
  } else {
    out = all.filter((s) => {
      if (activeCat && (s.category || "") !== activeCat) return false
      return picker.categoryPassesFilter((s.category || "").toString())
    })
  }

  if (personFilterActive && personTitleIds) {
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
          : (activeCat as string) || t("list.allCategories")
  }
  renderGrid(consumePendingGridRestore)
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

const hideWatchedBtn = document.getElementById("series-hide-watched")
function syncHideWatchedControl() {
  if (!hideWatchedBtn || !activePlaylistId) return
  hideWatchedBtn.setAttribute(
    "aria-checked",
    String(getHideWatched(activePlaylistId, "series"))
  )
}
// Delegated on document so sort-menu.ts's own click handler (attached
// directly to the button) flips aria-checked before this one reads it.
document.addEventListener("click", async (event) => {
  if (!hideWatchedBtn || !activePlaylistId) return
  if (!(event.target instanceof Node) || !hideWatchedBtn.contains(event.target)) return
  const next = hideWatchedBtn.getAttribute("aria-checked") === "true"
  setHideWatched(activePlaylistId, "series", next)
  if (next) await recomputeFullyWatched()
  applyFilter()
})

const groupLangsBtn = document.getElementById("series-group-langs")
// The global setting makes the per-playlist toggle meaningless when off, so hide it entirely.
if (groupLangsBtn) groupLangsBtn.hidden = !getLanguageGroupingEnabled()
function syncGroupLangsControl() {
  if (!groupLangsBtn) return
  groupLangsBtn.hidden = !getLanguageGroupingEnabled()
  if (!activePlaylistId) return
  groupLangsBtn.setAttribute("aria-checked", String(getGroupLanguages(activePlaylistId, "series")))
}
document.addEventListener("click", (event) => {
  if (!groupLangsBtn || !activePlaylistId) return
  if (!(event.target instanceof Node) || !groupLangsBtn.contains(event.target)) return
  const next = groupLangsBtn.getAttribute("aria-checked") === "true"
  setGroupLanguages(activePlaylistId, "series", next)
  applyFilter()
})

const langFilterEl = /** @type {HTMLSelectElement|null} */ (
  document.getElementById("series-lang")
)
function syncLangFilterControl() {
  if (!langFilterEl || !activePlaylistId) return
  langFilterEl.value = getLanguageFilter(activePlaylistId, "series")
}
langFilterEl?.addEventListener("change", () => {
  if (!activePlaylistId || !langFilterEl) return
  setLanguageFilter(activePlaylistId, "series", langFilterEl.value)
  applyFilter()
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
  attemptGridRestore()
  await ensurePrefsLoaded()
  syncSortControl()
  syncHideWatchedControl()
  syncGroupLangsControl()
  syncLangFilterControl()
  await hydrateCache(active._id, "series")

  const hit = getCached(active._id, "series")
  if (hit) {
    await paintSeries(hit.data, true, hit.age)
    if (rowsNeedTmdbBackfill(hit.data)) {
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
  if (personFilterActive) clearPersonFilter()
  pendingGridState = null
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
  renderPersonFilterRow()
  creds = await loadCreds()
  if (creds.host && creds.user && creds.pass) {
    loadSeries()
  } else {
    showEmptyState()
  }
})()
