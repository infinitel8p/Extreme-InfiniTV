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
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { cachedFetch, getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  isOnWatchlist,
  isCompleted,
  getFavorites,
  getRecents,
  getViewSort,
  setViewSort,
  getHideWatched,
  setHideWatched,
} from "@/scripts/lib/preferences.js"
import { mountCategoryPicker } from "@/scripts/lib/category-picker.ts"
import { mountSurprisePicker } from "@/scripts/lib/surprise-picker.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import { fmtImdbRating } from "@/scripts/lib/format.js"
import {
  buildEntryCard,
  buildWatchedBadge,
  WATCHED_BADGE_CLASS,
  STAR_OUTLINE,
  STAR_FILLED,
} from "@/scripts/lib/entry-card.js"
import { buildMovieStreamUrl } from "@/scripts/lib/stream-urls.ts"
import { resolvePersonTitleIds } from "@/scripts/lib/person-filter.ts"
import { saveGridState, takeGridState, gridStateMatchesLocation } from "@/scripts/lib/grid-state.ts"

const VOD_TTL_MS = 24 * 60 * 60 * 1000

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
let filtered = []

/** @type {Map<string,string> | null} */
let categoryMap = null

let activePlaylistId = ""
let activePlaylistTitle = ""

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
document.addEventListener("xt:movie-cat-changed", () => applyFilter())

mountSurprisePicker({
  kind: "vod",
  triggerId: "movie-surprise",
  getPool: () => filtered,
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
  const r = await xtreamApiFetch("get_vod_categories")
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

function makeCard(m, idx) {
  return buildEntryCard({
    entry: m,
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
    decoratePoster: (posterWrap, entry) => {
      if (activePlaylistId && isCompleted(activePlaylistId, "vod", entry.id)) {
        posterWrap.appendChild(buildWatchedBadge())
      }
    },
    starLabel: (entry, fav) =>
      fav
        ? `Remove ${entry.name || "movie"} from favorites`
        : `Add ${entry.name || "movie"} to favorites`,
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
        })
      })
    },
  })
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
    // Diagonal wave
    const waveDelay = ((col * 90) + (row * 140)) % 1600
    // Soft entrance stagger - cap at 8 cards
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
  }
}

function renderGrid() {
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
  const run = () => renderGridInner()
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
        }
      },
      { root: gridEl, rootMargin: "600px 0px" }
    )
    infiniteObs.observe(sentinel)
  } else {
    swapSentinelToButton(sentinel)
  }
}

function updateGridStarFor(movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex((m) => m.id === movieId)
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const m = filtered[idx]
  const fav = activePlaylistId
    ? isFavorite(activePlaylistId, "vod", m.id)
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
      ? `Remove ${m.name || "movie"} from favorites`
      : `Add ${m.name || "movie"} to favorites`
  )
}

function updateGridWatchBadgeFor(movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex((m) => m.id === movieId)
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const onWatchlist = activePlaylistId
    ? isOnWatchlist(activePlaylistId, "vod", movieId)
    : false
  const badge = /** @type {HTMLElement|null} */ (
    card.querySelector('[data-role="watch-badge"]')
  )
  if (!badge) return
  badge.hidden = !onWatchlist
}

function updateGridWatchedBadgeFor(movieId) {
  if (!gridEl) return
  const idx = filtered.findIndex((m) => m.id === movieId)
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const wrap = card.querySelector("[data-poster-wrap]")
  if (!wrap) return
  wrap.querySelector(`.${WATCHED_BADGE_CLASS}`)?.remove()
  if (activePlaylistId && isCompleted(activePlaylistId, "vod", movieId)) {
    wrap.appendChild(buildWatchedBadge())
  }
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
  const candidate = takeGridState("movies", activePlaylistId)
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
  saveGridState("movies", activePlaylistId, state)
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

const personFilterRow = document.getElementById("movie-person-filter-row")
const personFilterLabel = document.getElementById("movie-person-filter-label")

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

document.getElementById("movie-person-filter-clear")?.addEventListener("click", clearPersonFilter)

// Resolved once per activation; a later paint (SWR revalidation, cache hit) is a no-op once settled.
// While unresolved, applyFilter defers rendering entirely so the grid never flashes unfiltered.
function ensurePersonFilterResolved() {
  if (!personFilterActive || personTitleIds !== null || personFilterInFlight) return
  personFilterInFlight = true
  const token = ++personFilterToken
  let resolutionFailed = false
  resolvePersonTitleIds({
    kind: "vod",
    playlistId: activePlaylistId,
    personName: personFilterName,
    tmdbPersonId: personFilterTmdbId,
    catalogEntries: all,
  })
    .then((ids) => {
      if (token === personFilterToken) personTitleIds = ids
    })
    .catch((err) => {
      log.warn("[xt:movies] person filter resolution failed:", err)
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
  } else {
    out = all.filter((m) => {
      if (activeCat && (m.category || "") !== activeCat) return false
      return picker.categoryPassesFilter((m.category || "").toString())
    })
  }

  if (activePlaylistId && getHideWatched(activePlaylistId, "vod")) {
    out = out.filter((m) => !isCompleted(activePlaylistId, "vod", m.id))
  }

  if (personFilterActive && personTitleIds) {
    out = out.filter((m) => personTitleIds.has(m.id))
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

  const mode = activePlaylistId
    ? getViewSort(activePlaylistId, "vod")
    : "default"
  if (mode === "default" && scoreById) {
    out = out
      .slice()
      .sort((firstMovie, secondMovie) =>
        (scoreById.get(secondMovie.id) || 0) - (scoreById.get(firstMovie.id) || 0)
      )
  } else if (mode === "added") {
    out = out
      .slice()
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0))
  } else if (mode === "az") {
    out = out
      .slice()
      .sort((a, b) =>
        (a.name || "").localeCompare(b.name || "", "en", {
          sensitivity: "base",
        })
      )
  }

  filtered = out
  listStatus.textContent = t("movies.ofMovies", { shown: out.length.toLocaleString(), total: all.length.toLocaleString() })
  const heroCount = document.getElementById("movie-hero-count")
  if (heroCount) heroCount.textContent = out.length.toLocaleString()
  const heroCat = document.getElementById("movie-hero-cat")
  if (heroCat) {
    heroCat.textContent =
      activeCat === CAT_FAVORITES
        ? t("list.heroFavorites")
        : activeCat === CAT_RECENTS
          ? t("list.heroRecents")
          : (activeCat as string) || t("list.allCategories")
  }
  renderGrid()
  consumePendingGridRestore()
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

const hideWatchedBtn = document.getElementById("movie-hide-watched")
function syncHideWatchedControl() {
  if (!hideWatchedBtn || !activePlaylistId) return
  hideWatchedBtn.setAttribute(
    "aria-checked",
    String(getHideWatched(activePlaylistId, "vod"))
  )
}
// Delegated on document so sort-menu.ts's own click handler (attached
// directly to the button) flips aria-checked before this one reads it.
document.addEventListener("click", (event) => {
  if (!hideWatchedBtn || !activePlaylistId) return
  if (!(event.target instanceof Node) || !hideWatchedBtn.contains(event.target)) return
  const next = hideWatchedBtn.getAttribute("aria-checked") === "true"
  setHideWatched(activePlaylistId, "vod", next)
  applyFilter()
})

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
  if (listStatus) {
    listStatus.textContent =
      t("movies.totalMovies", { count: all.length.toLocaleString() }) +
      (fromCache ? ` · ${fmtAge(age)}` : "")
  }
  picker.rerender()
  applyFilter()
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
  attemptGridRestore()
  await ensurePrefsLoaded()
  syncSortControl()
  syncHideWatchedControl()
  await hydrateCache(active._id, "vod")

  const hit = getCached(active._id, "vod")
  if (hit) {
    paintMovies(hit.data, true, hit.age)
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
      async () => {
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
          .map((m) => {
            const name = String(m.name || m.title || "")
            const id = Number(m.stream_id || m.id)
            const logo = m.stream_icon || m.cover || null
            const year = String(m.year || m.releaseDate || "").trim() || ""
            const rating = m.rating || m.rating_5based || m.vote_average || ""
            const duration = m.duration || m.runtime || m.duration_secs || ""
            const categoryId =
              (Array.isArray(m.category_ids) &&
                m.category_ids.length &&
                m.category_ids[0]) ||
              m.category_id
            let category = String(m.category_name || "").trim()
            if (!category && categoryId != null && catMap?.size) {
              category = catMap.get(String(categoryId)) || ""
            }
            const added = Number(m.added) || 0
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
            }
          })
          .filter((m) => m.id && m.name)
          .sort((a, b) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
          )
      }
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
  if (personFilterActive) clearPersonFilter()
  pendingGridState = null
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
  renderPersonFilterRow()
  creds = await loadCreds()
  if (creds.host && creds.user && creds.pass) {
    loadMovies()
  } else {
    showEmptyState()
  }
})()
