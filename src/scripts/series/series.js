import {
  loadCreds,
  getActiveEntry,
  fmtBase,
  buildApiUrl,
  normalize,
  debounce,
} from "@/scripts/lib/creds.js"
import { cachedFetch, getCached } from "@/scripts/lib/cache.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  getFavorites,
  pushRecent,
  getRecents,
} from "@/scripts/lib/preferences.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  startDownload,
  resumeDownload,
  pauseDownload,
  isDownloadable,
  inferExt,
  listDownloads,
  DOWNLOADS_LIST_EVENT,
  DOWNLOAD_PROGRESS_EVENT,
} from "@/scripts/lib/downloads.js"
import { morphIntoDetail, clearAmbient } from "@/scripts/lib/morph-detail.js"
import { attachPlayerFocusKeeper } from "@/scripts/lib/player-focus-keeper.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"

const detailAmbient = document.getElementById("series-detail-ambient")

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

/** @type {{host:string,port:string,user:string,pass:string}} */
let creds = { host: "", port: "", user: "", pass: "" }

// ----------------------------
// UI refs
// ----------------------------
const gridEl = document.getElementById("series-grid")
const listStatus = document.getElementById("series-list-status")

const categoryListEl = document.getElementById("series-category-list")
const categoryListStatus = document.getElementById(
  "series-category-list-status"
)
const categorySearchEl = document.getElementById("series-category-search")

const searchEl = /** @type {HTMLInputElement|null} */ (
  document.getElementById("series-search")
)

// Detail dialog refs
const detailDlg = /** @type {HTMLDialogElement|null} */ (
  document.getElementById("series-detail-dialog")
)
const detailTitle = document.getElementById("series-detail-title")
const detailPoster = document.getElementById("series-detail-poster")
const detailMeta = document.getElementById("series-detail-meta")
const detailPlot = document.getElementById("series-detail-plot")
const detailFav = document.getElementById("series-detail-fav")
const detailClose = document.getElementById("series-detail-close")
const detailPlayerWrap = document.getElementById("series-detail-player-wrap")
const seasonTabs = document.getElementById("series-season-tabs")
const episodeList = document.getElementById("series-episode-list")
const nowPlayingLabel = document.getElementById("series-now-playing")

// ----------------------------
// State
// ----------------------------
/** @type {Array<{id:number,name:string,category?:string,logo?:string|null,year?:string,rating?:string,plot?:string,norm:string}>} */
let all = []
/** @type {typeof all} */
let filtered = []

/** @type {Map<string,string> | null} */
let categoryMap = null

let activeCat = ""
try {
  activeCat = localStorage.getItem("xt_series_active_cat") || ""
} catch {}

let activePlaylistId = ""
let activePlaylistTitle = ""

const hiddenCats = new Set()

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const STAR_OUTLINE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'
const STAR_FILLED =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  if (activeCat === CAT_FAVORITES) applyFilter()
  else updateGridStarFor(detail.id)
  syncPseudoCategoryRows()
  if (currentDetailSeries?.id === detail.id) syncDetailFavButton()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  if (activeCat === CAT_RECENTS) applyFilter()
  syncPseudoCategoryRows()
})

// ----------------------------
// Categories
// ----------------------------
async function ensureSeriesCategoryMap() {
  if (categoryMap) return categoryMap
  const r = await providerFetch(buildApiUrl(creds, "get_series_categories"))
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

function computeCategoryCounts(items) {
  const map = new Map()
  for (const s of items) {
    const k = (s.category || "").trim() || "Uncategorized"
    map.set(k, (map.get(k) || 0) + 1)
  }
  return map
}

function renderCategoryPicker(items) {
  if (!categoryListEl) return
  const counts = computeCategoryCounts(items)
  const names = Array.from(counts.keys()).sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base" })
  )

  const frag = document.createDocumentFragment()

  const highlightActiveInList = () => {
    for (const el of categoryListEl.querySelectorAll('button[role="option"]')) {
      el.classList.toggle("bg-surface-2", (el.dataset.val || "") === activeCat)
    }
  }

  const addRow = (val, label, count = null, extraClass = "") => {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.setAttribute("role", "option")
    btn.dataset.val = val
    btn.className =
      "w-full px-3 py-2 text-sm flex items-center justify-between hover:bg-surface-2 focus:bg-surface-2 outline-none text-fg" +
      (extraClass ? " " + extraClass : "")
    const left = document.createElement("span")
    left.className = "truncate"
    left.textContent = label
    const right = document.createElement("span")
    right.className =
      "category-count ml-3 shrink-0 text-xs text-fg-3 tabular-nums"
    right.textContent = count != null ? String(count) : ""
    btn.append(left, right)
    btn.addEventListener("click", () => {
      setActiveCat(val)
      highlightActiveInList()
    })
    frag.appendChild(btn)
    return btn
  }

  const favs = activePlaylistId
    ? getFavorites(activePlaylistId, "series")
    : new Set()
  const recs = activePlaylistId ? getRecents(activePlaylistId, "series") : []
  const favRow = addRow(CAT_FAVORITES, "★ Favorites", favs.size, "text-accent")
  if (favs.size === 0) favRow.style.display = "none"
  const recRow = addRow(CAT_RECENTS, "🕒 Recently watched", recs.length)
  if (recs.length === 0) recRow.style.display = "none"

  addRow("", "All categories")
  for (const name of names) addRow(name, name, counts.get(name))

  categoryListEl.innerHTML = ""
  categoryListEl.appendChild(frag)
  if (categoryListStatus) {
    categoryListStatus.textContent = `${names.length.toLocaleString()} categories`
  }
  highlightActiveInList()
}

function syncPseudoCategoryRows() {
  if (!categoryListEl || !activePlaylistId) return
  const favs = getFavorites(activePlaylistId, "series")
  const recs = getRecents(activePlaylistId, "series")
  for (const [val, n] of [
    [CAT_FAVORITES, favs.size],
    [CAT_RECENTS, recs.length],
  ]) {
    const btn = /** @type {HTMLButtonElement|null} */ (
      categoryListEl.querySelector(`button[role="option"][data-val="${val}"]`)
    )
    if (!btn) continue
    const countEl = btn.querySelector(".category-count")
    if (countEl) countEl.textContent = String(n)
    btn.style.display = n > 0 ? "" : "none"
  }
}

function filterCategories() {
  if (!categoryListEl || !categoryListStatus || !categorySearchEl) return
  const qnorm = normalize(categorySearchEl.value || "")
  const tokens = qnorm.length ? qnorm.split(" ") : []

  let visibleCount = 0
  let totalCount = 0

  for (const btn of categoryListEl.querySelectorAll('button[role="option"]')) {
    const isAll = btn.dataset.val === ""
    if (!isAll) totalCount++
    const label = normalize(btn.dataset.val || btn.textContent || "")
    const matches = !tokens.length || tokens.every((t) => label.includes(t))
    btn.style.display = matches ? "" : "none"
    if (matches && !isAll) visibleCount++
  }

  categoryListStatus.textContent = `${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()} categories`
}

categorySearchEl?.addEventListener("input", debounce(filterCategories, 120))

function setActiveCat(next) {
  activeCat = next || ""
  try {
    if (activeCat) localStorage.setItem("xt_series_active_cat", activeCat)
    else localStorage.removeItem("xt_series_active_cat")
  } catch {}
  applyFilter()
  document.dispatchEvent(
    new CustomEvent("xt:series-cat-changed", { detail: activeCat })
  )
}

// ----------------------------
// Poster grid (paged via IntersectionObserver, see movies.js for rationale)
// ----------------------------
const PAGE_SIZE = 200
let renderToken = 0
/** @type {IntersectionObserver|null} */
let infiniteObs = null
let renderedCount = 0

function makeFallback(name) {
  const fb = document.createElement("div")
  fb.className =
    "h-full w-full flex items-center justify-center text-center px-3 " +
    "text-fg-3 text-xs tracking-wide bg-gradient-to-br from-surface-2 to-surface-3"
  fb.textContent = name || "No poster"
  return fb
}

function makeCard(s, idx) {
  const card = document.createElement("div")
  card.dataset.idx = String(idx)
  card.className =
    "movie-card group relative rounded-xl overflow-hidden bg-surface-2 " +
    "ring-1 ring-line " +
    "transition-[transform,box-shadow] duration-150 " +
    "hover:ring-2 hover:ring-accent hover:[transform:translateY(-2px)] " +
    "focus-within:ring-2 focus-within:ring-accent focus-within:[transform:translateY(-2px)]"
  card.style.contentVisibility = "auto"
  card.style.containIntrinsicSize = "260px"

  const playBtn = document.createElement("button")
  playBtn.type = "button"
  playBtn.dataset.role = "play"
  playBtn.className =
    "play-btn block w-full text-left outline-none cursor-pointer"
  playBtn.title = s.name || ""
  playBtn.addEventListener("click", () => openDetail(s, card))

  const posterWrap = document.createElement("div")
  posterWrap.className =
    "aspect-[2/3] w-full bg-surface-2 overflow-hidden relative"

  if (s.logo) {
    const img = document.createElement("img")
    img.src = s.logo
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.referrerPolicy = "no-referrer"
    img.className =
      "h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
    img.onerror = () => {
      img.remove()
      posterWrap.appendChild(makeFallback(s.name))
    }
    posterWrap.appendChild(img)
  } else {
    posterWrap.appendChild(makeFallback(s.name))
  }
  playBtn.appendChild(posterWrap)

  const info = document.createElement("div")
  info.className = "px-2 py-2 min-w-0"
  const nameEl = document.createElement("div")
  nameEl.className = "truncate text-sm font-medium text-fg"
  nameEl.textContent = s.name || `Series ${s.id}`
  const meta = document.createElement("div")
  meta.className = "truncate text-2xs text-fg-3 tabular-nums"
  const parts = []
  if (s.year) parts.push(s.year)
  if (s.category) parts.push(s.category)
  meta.textContent = parts.join(" • ")
  info.append(nameEl, meta)
  playBtn.appendChild(info)

  card.appendChild(playBtn)

  const fav = activePlaylistId
    ? isFavorite(activePlaylistId, "series", s.id)
    : false
  const starBtn = document.createElement("button")
  starBtn.type = "button"
  starBtn.dataset.role = "star"
  starBtn.className =
    "star-btn absolute top-2 right-2 h-8 w-8 rounded-lg outline-none " +
    "flex items-center justify-center text-base " +
    "bg-black/45 backdrop-blur-sm ring-1 ring-white/10 " +
    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 " +
    "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent " +
    "transition-opacity " +
    (fav ? "text-accent" : "text-white/85")
  if (fav) starBtn.classList.add("!opacity-100")
  starBtn.setAttribute(
    "aria-label",
    fav
      ? `Remove ${s.name || "series"} from favorites`
      : `Add ${s.name || "series"} to favorites`
  )
  starBtn.setAttribute("aria-pressed", String(fav))
  starBtn.innerHTML = fav ? STAR_FILLED : STAR_OUTLINE
  starBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!activePlaylistId) return
    toggleFavorite(activePlaylistId, "series", s.id)
  })
  card.appendChild(starBtn)

  return card
}

function teardownInfiniteObs() {
  if (infiniteObs) {
    infiniteObs.disconnect()
    infiniteObs = null
  }
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
  ++renderToken
  teardownInfiniteObs()
  gridEl.replaceChildren()
  renderedCount = 0

  if (!filtered.length) {
    const empty = document.createElement("div")
    empty.className = "col-span-full text-fg-3 text-sm py-8 text-center"
    empty.textContent = activeCat
      ? "No series in this category."
      : "No series."
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
  sentinel.textContent = `Showing ${renderedCount.toLocaleString()} of ${filtered.length.toLocaleString()}`
  gridEl.appendChild(sentinel)

  if (typeof IntersectionObserver === "function") {
    infiniteObs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        appendNextPage()
        const s = gridEl.querySelector("[data-grid-sentinel]")
        if (s)
          s.textContent = `Showing ${renderedCount.toLocaleString()} of ${filtered.length.toLocaleString()}`
      },
      { root: gridEl, rootMargin: "600px 0px" }
    )
    infiniteObs.observe(sentinel)
  } else {
    sentinel.textContent = ""
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className =
      "rounded-xl border border-line px-4 py-2 text-sm hover:bg-surface-2 focus-visible:bg-surface-2"
    btn.textContent = `Load more (${(filtered.length - renderedCount).toLocaleString()} left)`
    btn.addEventListener("click", () => {
      appendNextPage()
      btn.textContent =
        renderedCount < filtered.length
          ? `Load more (${(filtered.length - renderedCount).toLocaleString()} left)`
          : ""
    })
    sentinel.appendChild(btn)
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

// ----------------------------
// Search + filter
// ----------------------------
function applyFilter() {
  if (!listStatus) return
  const qnorm = normalize(searchEl?.value || "")
  const tokens = qnorm.length ? qnorm.split(" ") : []

  /** @type {typeof all} */
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
      const cat = (s.category || "").toString()
      if (cat && hiddenCats.has(cat)) return false
      return true
    })
  }

  if (tokens.length) {
    out = out.filter((s) => tokens.every((t) => s.norm.includes(t)))
  }

  filtered = out
  listStatus.textContent = `${out.length.toLocaleString()} of ${all.length.toLocaleString()} series`
  renderGrid()
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
    listStatus.innerHTML = `No playlist selected. <a href="/login" class="text-accent underline">Add one</a>.`
  }
  if (categoryListStatus) {
    categoryListStatus.innerHTML = `<a href="/login" class="text-accent underline">Add a playlist</a> first.`
  }
  filtered = []
  renderGrid()
}

function paintSeries(data, fromCache, age) {
  all = data
  if (listStatus) {
    listStatus.textContent =
      `${all.length.toLocaleString()} series` +
      (fromCache ? ` · cached, ${fmtAge(age)}` : "")
  }
  renderCategoryPicker(all)
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

  const hit = getCached(active._id, "series")
  if (hit) {
    paintSeries(hit.data, true, hit.age)
  } else {
    listStatus.textContent = "Loading series…"
    if (gridEl) gridEl.replaceChildren()
  }

  creds = await loadCreds()
  if (!creds.host) {
    if (!hit) showEmptyState()
    return
  }
  if (!creds.user || !creds.pass) {
    listStatus.textContent =
      "Series require an Xtream playlist. Switch playlists from the header."
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
        const r = await providerFetch(buildApiUrl(creds, "get_series"))
        const body = await r.text()
        if (!r.ok) {
          console.error("Upstream error body:", body)
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
            return {
              id,
              name,
              logo: logo || null,
              year: year || "",
              rating: rating ? String(rating) : "",
              category,
              plot: s.plot || "",
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
    console.error(e)
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
// Detail dialog (seasons + episodes)
// ----------------------------
let vjs = null

const ensurePlayer = async () => {
  if (vjs) return vjs
  const [{ default: videojs }] = await Promise.all([
    import("video.js"),
    import("video.js/dist/video-js.css"),
  ])
  vjs = videojs("series-player", {
    liveui: false,
    fluid: true,
    preload: "auto",
    autoplay: false,
    aspectRatio: "16:9",
    controlBar: {
      volumePanel: { inline: false },
      pictureInPictureToggle: true,
      playbackRateMenuButton: true,
      fullscreenToggle: true,
    },
    html5: {
      vhs: {
        overrideNative: true,
        limitRenditionByPlayerDimensions: true,
        smoothQualityChange: true,
      },
    },
  })
  attachPlayerFocusKeeper(vjs)
  return vjs
}

function fmtDuration(minsOrStr) {
  if (!minsOrStr) return ""
  const s = String(minsOrStr)
  const m = parseInt(s, 10)
  if (!isFinite(m) || m <= 0) return s
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (!h) return `${mm} min`
  return `${h}h ${mm.toString().padStart(2, "0")}m`
}

function chooseMime(url) {
  if (!url) return "video/mp4"
  const lower = url.split("?")[0].toLowerCase()
  if (lower.endsWith(".m3u8")) return "application/x-mpegURL"
  if (lower.endsWith(".mpd")) return "application/dash+xml"
  if (lower.endsWith(".webm")) return "video/webm"
  if (lower.endsWith(".mkv")) return "video/x-matroska"
  if (lower.endsWith(".ts")) return "video/MP2T"
  if (lower.endsWith(".avi")) return "video/x-msvideo"
  return "video/mp4"
}

let currentDetailSeries = null
/** @type {Record<string, any[]>|null} seasonNumber → episode array */
let currentDetailEpisodes = null
let currentSeason = ""

function syncDetailFavButton() {
  if (!detailFav || !currentDetailSeries || !activePlaylistId) return
  const fav = isFavorite(activePlaylistId, "series", currentDetailSeries.id)
  detailFav.textContent = fav ? "Remove from favorites" : "Add to favorites"
  detailFav.classList.toggle("text-accent", fav)
  detailFav.setAttribute("aria-pressed", String(fav))
}

function buildEpisodeStreamUrl(episode) {
  const rawExt = episode.container_extension || "mp4"
  const ext = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"
  return (
    fmtBase(creds.host, creds.port) +
    "/series/" +
    encodeURIComponent(creds.user) +
    "/" +
    encodeURIComponent(creds.pass) +
    "/" +
    encodeURIComponent(episode.id) +
    "." +
    ext
  )
}

function renderSeasonTabs(seasonKeys) {
  if (!seasonTabs) return
  seasonTabs.replaceChildren()
  if (!seasonKeys.length) {
    seasonTabs.style.display = "none"
    return
  }
  seasonTabs.style.display = ""
  for (const key of seasonKeys) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.dataset.season = key
    btn.className =
      "rounded-lg px-3 py-1.5 text-sm border outline-none transition-colors " +
      (key === currentSeason
        ? "border-accent bg-accent-soft text-fg"
        : "border-line text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg")
    btn.textContent = `Season ${key}`
    btn.addEventListener("click", () => {
      if (currentSeason === key) return
      currentSeason = key
      renderSeasonTabs(seasonKeys)
      renderEpisodes()
    })
    seasonTabs.appendChild(btn)
  }
}

function findDownloadByUrl(url) {
  return listDownloads().find((d) => d.url === url) || null
}

function downloadButtonState(d) {
  if (!d) return { label: "Download", disabled: false, title: "Save this episode to your downloads folder" }
  switch (d.status) {
    case "downloading": {
      const pct = d.bytesTotal > 0 ? Math.floor((d.bytesDone / d.bytesTotal) * 100) : null
      return { label: pct !== null ? `${pct}%` : "…", disabled: false, title: "Tap to pause" }
    }
    case "queued":    return { label: "Queued", disabled: false, title: "Waiting for a slot - tap to cancel" }
    case "done":      return { label: "Saved", disabled: true, title: d.path ? `Saved to ${d.path}` : "Saved" }
    case "paused":    return { label: "Resume", disabled: false, title: "Paused - tap to resume" }
    case "stalled":   return { label: "Retry", disabled: false, title: "Stalled - tap to retry" }
    case "error":     return { label: "Retry", disabled: false, title: d.error || "Failed - tap to retry" }
    case "cancelled": return { label: "Download", disabled: false, title: "Re-download" }
    default:          return { label: "Download", disabled: false }
  }
}

function applyDownloadButtonState(btn, d) {
  const labelEl = btn.querySelector("[data-dl-label]")
  const s = downloadButtonState(d)
  if (labelEl) labelEl.textContent = s.label
  if (s.disabled) btn.setAttribute("disabled", "")
  else btn.removeAttribute("disabled")
  if (s.title) btn.title = s.title
  else btn.removeAttribute("title")
  btn.dataset.dlStatus = d?.status || "idle"
}

function renderEpisodes() {
  if (!episodeList) return
  episodeList.replaceChildren()
  const eps = currentDetailEpisodes?.[currentSeason] || []
  if (!eps.length) {
    const empty = document.createElement("div")
    empty.className = "text-fg-3 text-sm py-3"
    empty.textContent = "No episodes in this season."
    episodeList.appendChild(empty)
    return
  }
  for (const ep of eps) {
    const row = document.createElement("div")
    row.className =
      "episode-row flex items-center gap-3 p-3 rounded-xl bg-surface-2/40 " +
      "transition-colors hover:bg-surface-2 focus-within:bg-surface-2"

    const playBtn = document.createElement("button")
    playBtn.type = "button"
    playBtn.className =
      "flex flex-1 min-w-0 items-center gap-3 text-left outline-none rounded-lg " +
      "focus-visible:ring-2 focus-visible:ring-accent"
    playBtn.addEventListener("click", () => playEpisode(ep))

    const num = document.createElement("div")
    num.className =
      "shrink-0 size-10 rounded-md bg-surface-3 flex items-center justify-center text-sm font-semibold tabular-nums text-fg-2"
    num.textContent = `E${ep.episode_num || "?"}`
    playBtn.appendChild(num)

    const wrap = document.createElement("div")
    wrap.className = "min-w-0 flex-1"
    const title = document.createElement("div")
    title.className = "truncate text-sm font-medium text-fg"
    title.textContent = ep.title || `Episode ${ep.episode_num || ""}`
    wrap.appendChild(title)

    const meta = document.createElement("div")
    meta.className = "truncate text-xs text-fg-3 tabular-nums"
    const bits = []
    const dur = ep.info?.duration || ""
    if (dur) bits.push(dur)
    const released = ep.info?.release_date || ep.info?.releaseDate || ""
    if (released) bits.push(released)
    meta.textContent = bits.join(" • ")
    wrap.appendChild(meta)

    playBtn.appendChild(wrap)

    const arrow = document.createElement("span")
    arrow.className = "shrink-0 text-fg-3 text-base"
    arrow.textContent = "▶"
    playBtn.appendChild(arrow)

    row.appendChild(playBtn)

    if (isDownloadable()) {
      const epUrl = buildEpisodeStreamUrl(ep)
      const dlBtn = document.createElement("button")
      dlBtn.type = "button"
      dlBtn.className =
        "shrink-0 rounded-lg border border-line min-h-11 px-3 text-xs text-fg-2 tabular-nums " +
        "hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg focus-visible:border-accent " +
        "outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      dlBtn.dataset.dlUrl = epUrl
      const dlLabel = document.createElement("span")
      dlLabel.dataset.dlLabel = "1"
      dlBtn.appendChild(dlLabel)
      applyDownloadButtonState(dlBtn, findDownloadByUrl(epUrl))
      dlBtn.addEventListener("click", async (e) => {
        e.stopPropagation()
        const existing = findDownloadByUrl(epUrl)
        // Active or queued: clicking pauses / cancels in place.
        if (existing?.status === "downloading" || existing?.status === "queued") {
          pauseDownload(existing.id)
          return
        }
        // Resume the existing entry if it's just paused / stalled / errored
        // - starting a fresh download would orphan the partial file.
        if (
          existing &&
          (existing.status === "paused" ||
            existing.status === "stalled" ||
            existing.status === "error")
        ) {
          dlBtn.setAttribute("disabled", "")
          if (dlLabel) dlLabel.textContent = "Resuming…"
          resumeDownload(existing.id)
          return
        }
        try {
          dlBtn.setAttribute("disabled", "")
          if (dlLabel) dlLabel.textContent = "Starting…"
          const epTitle =
            (currentDetailSeries?.name ? `${currentDetailSeries.name} - ` : "") +
            `S${currentSeason || "?"}E${ep.episode_num || "?"}` +
            (ep.title ? ` - ${ep.title}` : "")
          await startDownload({
            url: epUrl,
            title: epTitle,
            ext: ep.container_extension || inferExt(epUrl, "mp4"),
          })
        } catch (err) {
          console.error("Episode download failed:", err)
          dlBtn.removeAttribute("disabled")
          if (dlLabel) dlLabel.textContent = "Failed"
          dlBtn.title = String(err?.message || err)
        }
      })
      row.appendChild(dlBtn)
    }

    episodeList.appendChild(row)
  }
  try { window.SpatialNavigation?.makeFocusable?.() } catch {}
}

function syncEpisodeDownloadButtons() {
  if (!episodeList) return
  const buttons = episodeList.querySelectorAll("button[data-dl-url]")
  if (!buttons.length) return
  // Read the downloads snapshot once per sync, index by url. Without this,
  // every progress event fires `listDownloads()` (a localStorage read +
  // JSON.parse) once per button = O(buttons x downloads) per tick, which
  // janks on long episode lists.
  const byUrl = new Map()
  for (const d of listDownloads()) {
    if (d?.url) byUrl.set(d.url, d)
  }
  for (const btn of buttons) {
    const url = btn.dataset.dlUrl
    if (!url) continue
    applyDownloadButtonState(btn, byUrl.get(url) || null)
  }
}

document.addEventListener(DOWNLOAD_PROGRESS_EVENT, syncEpisodeDownloadButtons)
document.addEventListener(DOWNLOADS_LIST_EVENT, syncEpisodeDownloadButtons)

function prepareAndShowDetail(series) {
  currentDetailSeries = series
  currentDetailEpisodes = null
  currentSeason = ""

  if (detailTitle) detailTitle.textContent = series.name || `Series ${series.id}`
  if (detailMeta) detailMeta.textContent = ""
  if (detailPlot) detailPlot.textContent = "Loading details…"

  if (detailPoster) {
    detailPoster.replaceChildren()
    if (series.logo) {
      const img = document.createElement("img")
      img.src = series.logo
      img.alt = ""
      img.loading = "eager"
      img.decoding = "async"
      img.fetchPriority = "high"
      img.referrerPolicy = "no-referrer"
      img.className = "h-full w-full object-cover"
      img.onerror = () => {
        img.remove()
        detailPoster.appendChild(makeFallback(series.name))
      }
      detailPoster.appendChild(img)
    } else {
      detailPoster.appendChild(makeFallback(series.name))
    }
  }

  // Reset hero state.
  if (detailPoster) detailPoster.classList.remove("hidden")
  if (detailPlayerWrap) detailPlayerWrap.classList.add("hidden")
  if (nowPlayingLabel) nowPlayingLabel.textContent = ""
  const videoEl = document.getElementById("series-player")
  videoEl?.setAttribute("hidden", "")
  try {
    vjs?.pause?.()
    vjs?.reset?.()
  } catch {}

  if (seasonTabs) seasonTabs.replaceChildren()
  if (episodeList) {
    episodeList.replaceChildren()
    const loading = document.createElement("div")
    loading.className = "text-fg-3 text-sm py-3"
    loading.textContent = "Loading seasons…"
    episodeList.appendChild(loading)
  }

  syncDetailFavButton()

  if (typeof detailDlg.showModal === "function") detailDlg.showModal()
  else detailDlg.setAttribute("open", "")

  try { window.SpatialNavigation?.makeFocusable?.() } catch {}
  /** @type {HTMLButtonElement|null} */ (detailFav)?.focus?.()
}

/** @type {HTMLElement|null} - card element clicked to open the detail dialog. */
let lastDetailTrigger = null

async function openDetail(series, fromCard) {
  if (!detailDlg || !series) return

  lastDetailTrigger = fromCard || null

  morphIntoDetail({
    fromCard,
    toHero: detailPoster,
    ambient: detailAmbient,
    posterUrl: series.logo || null,
    openDialog: () => prepareAndShowDetail(series),
  })

  try {
    const r = await providerFetch(
      buildApiUrl(creds, "get_series_info", {
        series_id: String(series.id),
        series: String(series.id),
      })
    )
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()
    const info = data?.info || {}
    const seasons = Array.isArray(data?.seasons) ? data.seasons : []
    let episodesByKey = {}
    if (data?.episodes && typeof data.episodes === "object") {
      if (Array.isArray(data.episodes)) {
        // Array of episodes, group by `season` field.
        for (const ep of data.episodes) {
          const k = String(ep?.season ?? "1")
          ;(episodesByKey[k] = episodesByKey[k] || []).push(ep)
        }
      } else {
        episodesByKey = data.episodes
      }
    }

    if (currentDetailSeries?.id !== series.id) return

    if (!Object.keys(episodesByKey).length) {
      console.warn(
        "[series] get_series_info returned no episodes for",
        series.id,
        data
      )
    }

    const year = info.releaseDate || info.releasedate || info.year || series.year || ""
    const rating = info.rating || info.rating_5based || series.rating || ""
    const genre = info.genre || info.category || ""
    const cast = info.cast || ""
    const plot = info.plot || info.description || series.plot || ""

    if (detailMeta) {
      const bits = []
      if (year) bits.push(year)
      if (genre) bits.push(genre)
      if (rating) bits.push(`Rating: ${String(rating).slice(0, 4)}`)
      if (seasons.length) bits.push(`${seasons.length} season${seasons.length > 1 ? "s" : ""}`)
      detailMeta.textContent = bits.join(" • ")
    }
    if (detailPlot) {
      detailPlot.textContent = plot || (cast ? `Cast: ${cast}` : "No description available.")
    }

    currentDetailEpisodes = episodesByKey
    const seasonKeys = Object.keys(episodesByKey).sort(
      (a, b) => Number(a) - Number(b)
    )
    currentSeason = seasonKeys[0] || ""
    renderSeasonTabs(seasonKeys)
    renderEpisodes()
  } catch (e) {
    console.error(e)
    if (detailPlot)
      detailPlot.textContent = "Failed to load series details."
    if (episodeList) {
      episodeList.replaceChildren()
      const fail = document.createElement("div")
      fail.className = "text-bad text-sm py-3"
      fail.textContent = "Couldn't load episodes."
      episodeList.appendChild(fail)
    }
  }
}

async function playEpisode(episode) {
  if (!currentDetailSeries || !episode) return
  const src = buildEpisodeStreamUrl(episode)

  if (activePlaylistId) {
    pushRecent(
      activePlaylistId,
      "series",
      currentDetailSeries.id,
      currentDetailSeries.name,
      currentDetailSeries.logo || null
    )
  }

  if (nowPlayingLabel) {
    nowPlayingLabel.textContent =
      `S${episode.season || currentSeason}E${episode.episode_num || "?"} · ${episode.title || ""}`
  }

  if (detailPoster) detailPoster.classList.add("hidden")
  if (detailPlayerWrap) detailPlayerWrap.classList.remove("hidden")
  const videoEl = document.getElementById("series-player")
  videoEl?.removeAttribute("hidden")

  const player = await ensurePlayer()
  player.src({ src, type: chooseMime(src) })
  player.play().catch(() => {})
}

detailFav?.addEventListener("click", () => {
  if (!currentDetailSeries || !activePlaylistId) return
  toggleFavorite(activePlaylistId, "series", currentDetailSeries.id)
})

detailClose?.addEventListener("click", () => detailDlg?.close?.())

detailDlg?.addEventListener("click", (e) => {
  if (e.target === detailDlg) detailDlg.close()
})

detailDlg?.addEventListener("close", () => {
  try {
    vjs?.pause?.()
    vjs?.reset?.()
  } catch {}
  if (detailPlayerWrap) detailPlayerWrap.classList.add("hidden")
  if (detailPoster) detailPoster.classList.remove("hidden")
  if (nowPlayingLabel) nowPlayingLabel.textContent = ""
  const videoEl = document.getElementById("series-player")
  videoEl?.setAttribute("hidden", "")
  clearAmbient(detailAmbient)
  currentDetailSeries = null
  currentDetailEpisodes = null
  currentSeason = ""

  const trigger = lastDetailTrigger
  lastDetailTrigger = null
  if (trigger && trigger.isConnected) {
    const focusable =
      /** @type {HTMLElement|null} */ (trigger.querySelector("button.play-btn")) ||
      (trigger instanceof HTMLElement ? trigger : null)
    queueMicrotask(() => focusable?.focus?.())
  }
})

// ----------------------------
// Boot
// ----------------------------
document.addEventListener("xt:active-changed", () => {
  loadSeries()
})

;(async () => {
  creds = await loadCreds()
  if (creds.host && creds.user && creds.pass) loadSeries()
})()
