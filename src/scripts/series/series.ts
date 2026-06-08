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
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { cachedFetch, getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  isOnWatchlist,
  getFavorites,
  getRecents,
  getViewSort,
  setViewSort,
  getSeriesProgressSummary,
} from "@/scripts/lib/preferences.js"
import { mountCategoryPicker } from "@/scripts/lib/category-picker.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import { fmtImdbRating } from "@/scripts/lib/format.js"
import {
  buildEntryCard,
  STAR_OUTLINE,
  STAR_FILLED,
} from "@/scripts/lib/entry-card.js"
import {
  getCachedSeasonCount,
  observeSeasonCount,
  seasonsLabel,
} from "@/scripts/lib/series-seasons.ts"

const SERIES_TTL_MS = 24 * 60 * 60 * 1000

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
let filtered = []

/** @type {Map<string,string> | null} */
let categoryMap = null

let activePlaylistId = ""
let activePlaylistTitle = ""

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

document.addEventListener("xt:progress-changed", (event) => {
  const detail = /** @type {CustomEvent} */ (event).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "episode") return
  const seriesId = Number(detail.seriesId ?? 0)
  if (!seriesId) {
    refreshSeriesProgressBadges()
    return
  }
  refreshSeriesProgressBadges(seriesId)
})

function refreshSeriesProgressBadges(specificSeriesId) {
  if (!gridEl) return
  const cards = gridEl.querySelectorAll("[data-idx]")
  for (const card of cards) {
    const idx = Number(card.dataset.idx)
    const series = filtered[idx]
    if (!series) continue
    if (specificSeriesId && series.id !== specificSeriesId) continue
    const wrap = card.querySelector("[data-poster-wrap]")
    if (!wrap) continue
    const old = wrap.querySelector(".series-progress-badge")
    if (old) old.remove()
    const next = makeSeriesProgressBadge(series)
    if (next) wrap.appendChild(next)
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

function makeSeriesProgressBadge(series) {
  if (!activePlaylistId) return null
  const summary = getSeriesProgressSummary(activePlaylistId, series.id)
  if (!summary) return null

  const season = summary.lastSeason
  const episodeNum = summary.lastEpisodeNum
  const epId = summary.lastEpisodeId

  const seasonLabel = season != null && season !== "" ? `S${season}` : ""
  const total = season != null ? seasonEpisodeCount(series.id, season) : 0

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
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
    "transition-[filter,transform] duration-150 active:scale-[0.97]"
  if (epId) {
    badge.href = `/series/detail?id=${encodeURIComponent(series.id)}&autoplay=1&episode=${encodeURIComponent(epId)}`
  } else {
    badge.href = `/series/detail?id=${encodeURIComponent(series.id)}`
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

function makeCard(s, idx) {
  const card = buildEntryCard({
    entry: s,
    idx,
    kind: "series",
    activePlaylistId,
    detailHref: (entry) =>
      `/series/detail?id=${encodeURIComponent(entry.id)}`,
    fallbackTitle: (entry) => t("list.seriesFallback", { id: entry.id }),
    metaText: (entry) =>
      seriesMetaText(entry, getCachedSeasonCount(activePlaylistId, entry.id)),
    decoratePoster: (posterWrap, entry) => {
      const progressBadge = makeSeriesProgressBadge(entry)
      if (progressBadge) posterWrap.appendChild(progressBadge)
    },
    starLabel: (entry, fav) =>
      fav
        ? `Remove ${entry.name || "series"} from favorites`
        : `Add ${entry.name || "series"} to favorites`,
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
        })
      })
    },
  })

  if (activePlaylistId) {
    const metaEl = card.querySelector('[data-role="meta"]')
    if (metaEl) {
      observeSeasonCount(card, activePlaylistId, s.id, (count) => {
        metaEl.textContent = seriesMetaText(s, count)
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
  }
}

function renderGrid() {
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

function updateGridStarFor(seriesId) {
  if (!gridEl) return
  const idx = filtered.findIndex((s) => s.id === seriesId)
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const s = filtered[idx]
  const fav = activePlaylistId
    ? isFavorite(activePlaylistId, "series", s.id)
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

function updateGridWatchBadgeFor(seriesId) {
  if (!gridEl) return
  const idx = filtered.findIndex((s) => s.id === seriesId)
  if (idx < 0) return
  const card = gridEl.querySelector(`[data-idx="${idx}"]`)
  if (!card) return
  const onWatchlist = activePlaylistId
    ? isOnWatchlist(activePlaylistId, "series", seriesId)
    : false
  const badge = /** @type {HTMLElement|null} */ (
    card.querySelector('[data-role="watch-badge"]')
  )
  if (!badge) return
  badge.hidden = !onWatchlist
}

// ----------------------------
// Search + filter
// ----------------------------
function applyFilter() {
  if (!listStatus) return
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

  const mode = activePlaylistId
    ? getViewSort(activePlaylistId, "series")
    : "default"
  if (mode === "default" && scoreById) {
    out = out
      .slice()
      .sort((firstSeries, secondSeries) =>
        (scoreById.get(secondSeries.id) || 0) - (scoreById.get(firstSeries.id) || 0)
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
  listStatus.textContent = t("series.ofSeries", { shown: out.length.toLocaleString(), total: all.length.toLocaleString() })
  const heroCount = document.getElementById("series-hero-count")
  if (heroCount) heroCount.textContent = out.length.toLocaleString()
  const heroCat = document.getElementById("series-hero-cat")
  if (heroCat) {
    heroCat.textContent =
      activeCat === CAT_FAVORITES
        ? t("list.heroFavorites")
        : activeCat === CAT_RECENTS
          ? t("list.heroRecents")
          : (activeCat as string) || t("list.allCategories")
  }
  renderGrid()
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

function paintSeries(data, fromCache, age) {
  all = data
  if (listStatus) {
    listStatus.textContent =
      t("series.totalSeries", { count: all.length.toLocaleString() }) +
      (fromCache ? ` · ${fmtAge(age)}` : "")
  }
  picker.rerender()
  applyFilter()
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
  await ensurePrefsLoaded()
  syncSortControl()
  await hydrateCache(active._id, "series")

  const hit = getCached(active._id, "series")
  if (hit) {
    paintSeries(hit.data, true, hit.age)
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
      async () => {
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
          .map((s) => {
            const name = String(s.name || s.title || "")
            const id = Number(s.series_id || s.id)
            const logo = s.cover || s.stream_icon || null
            const year = String(
              s.year || s.releaseDate || s.release_date || ""
            ).trim()
            const rating = s.rating || s.rating_5based || ""
            const categoryId =
              (Array.isArray(s.category_ids) &&
                s.category_ids.length &&
                s.category_ids[0]) ||
              s.category_id
            let category = String(s.category_name || "").trim()
            if (!category && categoryId != null && catMap?.size) {
              category = catMap.get(String(categoryId)) || ""
            }
            const added =
              Number(s.last_modified) ||
              Number(s.added) ||
              Number(s.releaseDate ? Date.parse(s.releaseDate) / 1000 : 0) ||
              0
            return {
              id,
              name,
              logo: logo || null,
              year: year || "",
              rating: rating ? String(rating) : "",
              category,
              plot: s.plot || "",
              added,
              norm: normalize(`${name} ${category} ${year}`),
            }
          })
          .filter((s) => s.id && s.name)
          .sort((a, b) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
          )
      }
    )
    paintSeries(data, fromCache, age)
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

document.addEventListener("xt:active-changed", () => loadSeries())

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
  creds = await loadCreds()
  if (creds.host && creds.user && creds.pass) {
    loadSeries()
  } else {
    showEmptyState()
  }
})()
