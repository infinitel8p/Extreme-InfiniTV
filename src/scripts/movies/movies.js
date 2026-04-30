// Movies / VOD listing page (route: /movies). Detail/playback lives on
// /movies/detail?id=<id> via src/scripts/movies/detail.js.
import {
  loadCreds,
  getActiveEntry,
  buildApiUrl,
  normalize,
  debounce,
} from "@/scripts/lib/creds.js"
import { cachedFetch, getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  getFavorites,
  getRecents,
  getHiddenCategories,
  setCategoryHidden,
  getViewSort,
  setViewSort,
} from "@/scripts/lib/preferences.js"
import { toast } from "@/scripts/lib/toast.js"
import { ICON_X } from "@/scripts/lib/icons.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"

const VOD_TTL_MS = 24 * 60 * 60 * 1000

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

const categoryListEl = document.getElementById("movie-category-list")
const categoryListStatus = document.getElementById("movie-category-list-status")
const categorySearchEl = document.getElementById("movie-category-search")

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

let activeCat = ""
try {
  activeCat = localStorage.getItem("xt_vod_active_cat") || ""
} catch {}

let activePlaylistId = ""
let activePlaylistTitle = ""

let showHidden = false

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

function hiddenSet() {
  return activePlaylistId
    ? getHiddenCategories(activePlaylistId, "vod")
    : new Set()
}

const STAR_OUTLINE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'
const STAR_FILLED =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (activeCat === CAT_FAVORITES) applyFilter()
  else updateGridStarFor(detail.id)
  syncPseudoCategoryRows()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (activeCat === CAT_RECENTS) applyFilter()
  syncPseudoCategoryRows()
})

document.addEventListener("xt:hidden-categories-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  renderCategoryPicker(all)
  applyFilter()
})

// ----------------------------
// Categories
// ----------------------------
async function ensureVodCategoryMap() {
  if (categoryMap) return categoryMap
  const r = await providerFetch(buildApiUrl(creds, "get_vod_categories"))
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
  for (const m of items) {
    const k = (m.category || "").trim() || "Uncategorized"
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
  const hidden = hiddenSet()
  const visibleNames = names.filter((n) => !hidden.has(n))
  const hiddenNames = names.filter((n) => hidden.has(n))

  const frag = document.createDocumentFragment()

  const highlightActiveInList = () => {
    for (const el of categoryListEl.querySelectorAll('button[role="option"]')) {
      el.classList.toggle("bg-surface-2", (el.dataset.val || "") === activeCat)
    }
  }

  const addRow = (val, label, count = null, extraClass = "", opts = {}) => {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.setAttribute("role", "option")
    btn.dataset.val = val
    btn.className =
      "group/cat relative w-full px-3 py-2 text-sm flex items-center justify-between hover:bg-surface-2 focus:bg-surface-2 outline-none text-fg" +
      (extraClass ? " " + extraClass : "") +
      (opts.dim ? " opacity-60" : "")
    const left = document.createElement("span")
    left.className = "truncate"
    left.textContent = label
    btn.appendChild(left)

    const right = document.createElement("span")
    right.className = "ml-3 shrink-0 flex items-center gap-1.5"

    let rightAction = null
    if (opts.hideAction === "hide" || opts.hideAction === "unhide") {
      rightAction = document.createElement("button")
      rightAction.type = "button"
      rightAction.tabIndex = 0
      rightAction.className =
        "category-hide-btn shrink-0 size-6 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:text-fg outline-none opacity-0 group-hover/cat:opacity-100 group-focus-within/cat:opacity-100 focus-visible:opacity-100 transition-opacity"
      rightAction.setAttribute(
        "aria-label",
        opts.hideAction === "hide"
          ? `Hide category "${label}"`
          : `Unhide category "${label}"`
      )
      rightAction.title = opts.hideAction === "hide" ? "Hide category" : "Unhide category"
      rightAction.innerHTML =
        opts.hideAction === "hide"
          ? ICON_X
          : '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7"/><circle cx="12" cy="12" r="3"/></svg>'
      rightAction.addEventListener("click", (ev) => {
        ev.stopPropagation()
        ev.preventDefault()
        if (!activePlaylistId) return
        const willHide = opts.hideAction === "hide"
        setCategoryHidden(activePlaylistId, "vod", val, willHide)
        if (willHide) {
          toast({
            title: `Hid "${label}"`,
            description: "Manage hidden categories in Settings.",
            duration: 4000,
          })
          if (activeCat === val) {
            setActiveCat("")
          }
        }
      })
    }

    const countEl = document.createElement("span")
    countEl.className = "category-count text-xs text-fg-3 tabular-nums min-w-8 text-right"
    countEl.textContent = count != null ? String(count) : ""
    right.appendChild(countEl)
    if (rightAction) {
      right.appendChild(rightAction)
    } else {
      const spacer = document.createElement("span")
      spacer.className = "category-hide-btn shrink-0 size-6"
      spacer.setAttribute("aria-hidden", "true")
      right.appendChild(spacer)
    }

    btn.appendChild(right)
    btn.addEventListener("click", () => {
      setActiveCat(val)
      highlightActiveInList()
    })
    frag.appendChild(btn)
    return btn
  }

  const favs = activePlaylistId
    ? getFavorites(activePlaylistId, "vod")
    : new Set()
  const recs = activePlaylistId ? getRecents(activePlaylistId, "vod") : []
  const favRow = addRow(CAT_FAVORITES, "★ Favorites", favs.size, "text-accent")
  if (favs.size === 0) favRow.style.display = "none"
  const recRow = addRow(CAT_RECENTS, "🕒 Recently watched", recs.length)
  if (recs.length === 0) recRow.style.display = "none"

  addRow("", "All categories")
  for (const name of visibleNames) {
    addRow(name, name, counts.get(name), "", { hideAction: "hide" })
  }

  if (hiddenNames.length) {
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className =
      "w-full px-3 py-2 text-xs text-fg-3 hover:text-fg hover:bg-surface-2 focus:bg-surface-2 outline-none flex items-center justify-between"
    toggle.innerHTML =
      `<span class="truncate">${showHidden ? "Hide" : "Show"} ${hiddenNames.length} hidden ${hiddenNames.length === 1 ? "category" : "categories"}</span>` +
      `<span class="ml-3 shrink-0 tabular-nums">${showHidden ? "▴" : "▾"}</span>`
    toggle.addEventListener("click", () => {
      showHidden = !showHidden
      renderCategoryPicker(items)
    })
    frag.appendChild(toggle)
    if (showHidden) {
      for (const name of hiddenNames) {
        addRow(name, name, counts.get(name), "", {
          hideAction: "unhide",
          dim: true,
        })
      }
    }
  }

  categoryListEl.innerHTML = ""
  categoryListEl.appendChild(frag)
  if (categoryListStatus) {
    const total = visibleNames.length
    categoryListStatus.textContent = `${total.toLocaleString()} ${total === 1 ? "category" : "categories"}${hiddenNames.length ? ` · ${hiddenNames.length} hidden` : ""}`
  }
  highlightActiveInList()
}

function syncPseudoCategoryRows() {
  if (!categoryListEl || !activePlaylistId) return
  const favs = getFavorites(activePlaylistId, "vod")
  const recs = getRecents(activePlaylistId, "vod")
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
    if (activeCat) localStorage.setItem("xt_vod_active_cat", activeCat)
    else localStorage.removeItem("xt_vod_active_cat")
  } catch {}
  applyFilter()
  document.dispatchEvent(
    new CustomEvent("xt:movie-cat-changed", { detail: activeCat })
  )
}

// ----------------------------
// Poster grid
// ----------------------------
const PAGE_SIZE = 200
let renderToken = 0
/** @type {IntersectionObserver|null} */
let infiniteObs = null
let renderedCount = 0

function makeCard(m, idx) {
  const card = document.createElement("div")
  card.dataset.idx = String(idx)
  const stagger = idx < 12
  card.className =
    "movie-card group relative rounded-xl overflow-hidden bg-surface-2 " +
    "ring-1 ring-line " +
    "transition-[transform,box-shadow] duration-150 " +
    "hover:ring-2 hover:ring-accent hover:[transform:translateY(-2px)] " +
    "focus-within:ring-2 focus-within:ring-accent focus-within:[transform:translateY(-2px)]" +
    (stagger ? " grid-card-enter" : "")
  if (stagger) card.style.animationDelay = `${idx * 28}ms`
  card.style.contentVisibility = "auto"
  card.style.containIntrinsicSize = "260px"

  const link = document.createElement("a")
  link.href = `/movies/detail?id=${encodeURIComponent(m.id)}`
  link.dataset.role = "play"
  link.className =
    "play-btn block w-full text-left outline-none cursor-pointer no-underline"
  link.title = m.name || ""
  link.setAttribute("aria-label", `Open ${m.name || `Movie ${m.id}`}`)

  // Set the cross-document VT name on the source poster image just before
  // navigation - the browser snapshots elements with matching names on
  // both ends and animates between them.
  link.addEventListener("click", () => {
    const img = link.querySelector("img")
    if (img) /** @type {HTMLElement} */ (img).style.viewTransitionName = "active-poster"
  })

  const posterWrap = document.createElement("div")
  posterWrap.className = "aspect-[2/3] w-full bg-surface-2 overflow-hidden relative"

  if (m.logo) {
    const img = document.createElement("img")
    img.src = m.logo
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.referrerPolicy = "no-referrer"
    img.className =
      "h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
    img.onerror = () => {
      img.remove()
      posterWrap.appendChild(makeFallback(m.name))
    }
    posterWrap.appendChild(img)
  } else {
    posterWrap.appendChild(makeFallback(m.name))
  }

  link.appendChild(posterWrap)

  const info = document.createElement("div")
  info.className = "px-2 py-2 min-w-0"
  const nameEl = document.createElement("div")
  nameEl.className = "truncate text-sm font-medium text-fg"
  nameEl.textContent = m.name || `Movie ${m.id}`
  const meta = document.createElement("div")
  meta.className = "truncate text-2xs text-fg-3 tabular-nums"
  const parts = []
  if (m.year) parts.push(m.year)
  if (m.duration) parts.push(m.duration)
  if (m.category) parts.push(m.category)
  meta.textContent = parts.join(" • ")
  info.append(nameEl, meta)
  link.appendChild(info)

  card.appendChild(link)

  const fav = activePlaylistId
    ? isFavorite(activePlaylistId, "vod", m.id)
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
      ? `Remove ${m.name || "movie"} from favorites`
      : `Add ${m.name || "movie"} to favorites`
  )
  starBtn.setAttribute("aria-pressed", String(fav))
  starBtn.innerHTML = fav ? STAR_FILLED : STAR_OUTLINE
  starBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!activePlaylistId) return
    toggleFavorite(activePlaylistId, "vod", m.id, {
      name: m.name || "",
      logo: m.logo || null,
    })
  })
  card.appendChild(starBtn)

  return card
}

function makeFallback(name) {
  const fb = document.createElement("div")
  fb.className =
    "h-full w-full flex items-center justify-center text-center px-3 " +
    "text-fg-3 text-xs tracking-wide bg-gradient-to-br from-surface-2 to-surface-3"
  fb.textContent = name || "No poster"
  return fb
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
  ++renderToken
  teardownInfiniteObs()
  gridEl.replaceChildren()
  renderedCount = 0

  if (!filtered.length) {
    const empty = document.createElement("div")
    empty.className = "col-span-full text-fg-3 text-sm py-8 text-center"
    empty.textContent = activeCat
      ? "No movies in this category."
      : "No movies."
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

// ----------------------------
// Search + filter
// ----------------------------
function applyFilter() {
  if (!listStatus) return
  const qnorm = normalize(searchEl?.value || "")
  const tokens = qnorm.length ? qnorm.split(" ") : []

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
      const cat = (m.category || "").toString()
      if (cat && hiddenSet().has(cat)) return false
      return true
    })
  }

  if (tokens.length) {
    out = out.filter((m) => tokens.every((t) => m.norm.includes(t)))
  }

  const mode = activePlaylistId
    ? getViewSort(activePlaylistId, "vod")
    : "default"
  if (mode === "added") {
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
  listStatus.textContent = `${out.length.toLocaleString()} of ${all.length.toLocaleString()} movies`
  const heroCount = document.getElementById("movie-hero-count")
  if (heroCount) heroCount.textContent = out.length.toLocaleString()
  const heroCat = document.getElementById("movie-hero-cat")
  if (heroCat) {
    heroCat.textContent =
      activeCat === CAT_FAVORITES
        ? "Favorites"
        : activeCat === CAT_RECENTS
          ? "Recently watched"
          : activeCat || "All categories"
  }
  renderGrid()
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
    listStatus.innerHTML = `No playlist selected. <a href="/login" class="text-accent underline">Add one</a>.`
  }
  if (categoryListStatus) {
    categoryListStatus.innerHTML = `<a href="/login" class="text-accent underline">Add a playlist</a> first.`
  }
  filtered = []
  renderGrid()
}

function paintMovies(data, fromCache, age) {
  all = data
  if (listStatus) {
    listStatus.textContent =
      `${all.length.toLocaleString()} movies` +
      (fromCache ? ` · cached, ${fmtAge(age)}` : "")
  }
  renderCategoryPicker(all)
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
  await ensurePrefsLoaded()
  syncSortControl()
  await hydrateCache(active._id, "vod")

  const hit = getCached(active._id, "vod")
  if (hit) {
    paintMovies(hit.data, true, hit.age)
  } else {
    listStatus.textContent = "Loading movies…"
    if (gridEl) gridEl.replaceChildren()
  }

  creds = await loadCreds()
  if (!creds.host) {
    if (!hit) showEmptyState()
    return
  }
  if (!creds.user || !creds.pass) {
    listStatus.textContent =
      "Movies require an Xtream playlist. Switch playlists from the header."
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
        const r = await providerFetch(buildApiUrl(creds, "get_vod_streams"))
        const body = await r.text()
        if (!r.ok) {
          console.error("Upstream error body:", body)
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
    console.error("[xt:movies] loadMovies threw:", e)
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
document.addEventListener("xt:active-changed", () => loadMovies())

;(async () => {
  creds = await loadCreds()
  if (creds.host && creds.user && creds.pass) loadMovies()
})()
