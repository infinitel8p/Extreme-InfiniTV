// Movies / VOD listing, virtualised list, search, category picker and player.
import {
  loadCreds,
  getActiveEntry,
  fmtBase,
  buildApiUrl,
  normalize,
  debounce,
} from "@/scripts/lib/creds.js"
import { cachedFetch, getCached } from "@/scripts/lib/cache.js"

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

/** @type {{host:string,port:string,user:string,pass:string}} */
let creds = { host: "", port: "", user: "", pass: "" }

// ----------------------------
// UI refs
// ----------------------------
const listEl = document.getElementById("movie-list")
const spacer = document.getElementById("movie-spacer")
const viewport = document.getElementById("movie-viewport")
const listStatus = document.getElementById("movie-list-status")

const categoryListEl = document.getElementById("movie-category-list")
const categoryListStatus = document.getElementById("movie-category-list-status")
const categorySearchEl = document.getElementById("movie-category-search")

const searchEl = document.getElementById("movie-search")
const clearSearchBtn = document.getElementById("movie-clear-search")

const currentEl = document.getElementById("movie-current")
const metaEl = document.getElementById("movie-meta")
const plotEl = document.getElementById("movie-plot")

if (spacer) spacer.style.height = "0px"

// ----------------------------
// State
// ----------------------------
/** @type {Array<{id:number,name:string,category?:string,logo?:string|null,year?:string,rating?:string,duration?:string,plot?:string,norm:string}>} */
let all = []
let filtered = []

/** @type {Map<string,string> | null} */
let categoryMap = null

let activeCat = ""
try {
  activeCat = localStorage.getItem("xt_vod_active_cat") || ""
} catch {}

const hiddenCats = new Set()

// Virtual list config
const ROW_H = 70
const OVERSCAN = 8
let renderScheduled = false
// Index of the row that should hold focus after the next render. Keeps
// keyboard / D-pad focus pinned to a logical row even when the underlying DOM
// nodes are recycled by the virtualiser.
let pendingFocusIdx = -1

// ----------------------------
// Categories
// ----------------------------
async function ensureVodCategoryMap() {
  if (categoryMap) return categoryMap
  const r = await fetch(buildApiUrl(creds, "get_vod_categories"))
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

  const frag = document.createDocumentFragment()

  const highlightActiveInList = () => {
    for (const el of categoryListEl.querySelectorAll('button[role="option"]')) {
      el.classList.toggle("bg-surface-2", (el.dataset.val || "") === activeCat)
    }
  }

  const addRow = (val, label, count = null) => {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.setAttribute("role", "option")
    btn.dataset.val = val
    btn.className =
      "w-full px-3 py-2 text-sm flex items-center justify-between hover:bg-surface-2 focus:bg-surface-2 outline-none text-fg"
    const left = document.createElement("span")
    left.className = "truncate"
    left.textContent = label
    const right = document.createElement("span")
    right.className = "ml-3 shrink-0 text-xs text-fg-3 tabular-nums"
    right.textContent = count != null ? String(count) : ""
    btn.append(left, right)
    btn.addEventListener("click", () => {
      setActiveCat(val)
      highlightActiveInList()
    })
    frag.appendChild(btn)
  }

  addRow("", "All categories")
  for (const name of names) addRow(name, name, counts.get(name))

  categoryListEl.innerHTML = ""
  categoryListEl.appendChild(frag)
  if (categoryListStatus) {
    categoryListStatus.textContent = `${names.length.toLocaleString()} categories`
  }
  highlightActiveInList()
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
// Virtual list
// ----------------------------
function mountVirtualList(items) {
  if (!spacer || !viewport || !listEl) return
  filtered = items || []
  spacer.style.height = `${filtered.length * ROW_H}px`
  if (listEl.scrollTop > filtered.length * ROW_H) listEl.scrollTop = 0
  pendingFocusIdx = -1
  renderVirtual()
}

function renderVirtual() {
  if (!listEl || !viewport) return
  const scrollTop = listEl.scrollTop
  const height = listEl.clientHeight

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const endIdx = Math.min(
    filtered.length,
    Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN
  )

  const frag = document.createDocumentFragment()
  for (let i = startIdx; i < endIdx; i++) {
    const m = filtered[i]
    const row = document.createElement("button")
    row.type = "button"
    row.dataset.idx = String(i)
    row.style.height = ROW_H + "px"
    row.className =
      "group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-surface-2 focus:bg-surface-2"
    row.onclick = () => playMovie(m.id, m.name)
    row.title = m.name || ""

    const poster = document.createElement("div")
    poster.className =
      "h-10 w-7 shrink-0 rounded-md bg-surface-2 overflow-hidden ring-1 ring-inset ring-line"
    if (m.logo) {
      const img = document.createElement("img")
      img.src = m.logo
      img.alt = ""
      img.loading = "lazy"
      img.referrerPolicy = "no-referrer"
      img.className = "h-full w-full object-cover"
      img.onerror = () => img.remove()
      poster.appendChild(img)
    }
    row.appendChild(poster)

    const wrap = document.createElement("div")
    wrap.className = "min-w-0 flex-1"
    const nameEl = document.createElement("div")
    nameEl.className = "truncate text-sm font-medium"
    nameEl.textContent = m.name || `Movie ${m.id}`
    const meta = document.createElement("div")
    meta.className = "truncate text-2xs text-fg-3 tabular-nums"
    const parts = []
    if (m.year) parts.push(m.year)
    if (m.duration) parts.push(m.duration)
    if (m.category) parts.push(m.category)
    meta.textContent = parts.join(" • ")
    wrap.append(nameEl, meta)
    row.appendChild(wrap)

    frag.appendChild(row)
  }

  viewport.replaceChildren(frag)
  viewport.style.transform = `translateY(${startIdx * ROW_H}px)`

  if (pendingFocusIdx >= startIdx && pendingFocusIdx < endIdx) {
    const target = /** @type {HTMLElement|null} */ (
      viewport.querySelector(`[data-idx="${pendingFocusIdx}"]`)
    )
    target?.focus({ preventScroll: true })
    pendingFocusIdx = -1
  }

  window.SpatialNavigation?.makeFocusable?.()
}

listEl?.addEventListener(
  "scroll",
  () => {
    if (renderScheduled) return
    renderScheduled = true
    requestAnimationFrame(() => {
      renderScheduled = false
      renderVirtual()
    })
  },
  { passive: true }
)

// Custom D-pad / arrow handling: virtualised rows aren't all in the DOM at
// once, so spatial-navigation can't walk past the visible window. We move
// focus by index, scrolling the list as needed, and pin focus across DOM
// recycles via pendingFocusIdx.
function focusByIdx(idx) {
  if (!listEl || idx < 0 || idx >= filtered.length) return
  const top = idx * ROW_H
  const visTop = listEl.scrollTop
  const visBottom = visTop + listEl.clientHeight
  if (top < visTop) {
    listEl.scrollTop = Math.max(0, top - ROW_H * 2)
  } else if (top + ROW_H > visBottom) {
    listEl.scrollTop = top + ROW_H - listEl.clientHeight + ROW_H * 2
  }
  // Always pin pendingFocusIdx — see livetv equivalent. Letting renderVirtual
  // be the only place that clears it keeps focus pinned through DOM recycles
  // even under rapid keyboard repeat.
  pendingFocusIdx = idx
  const present = /** @type {HTMLElement|null} */ (
    viewport?.querySelector(`[data-idx="${idx}"]`)
  )
  if (present) present.focus({ preventScroll: true })
}

listEl?.addEventListener(
  "keydown",
  (e) => {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "PageDown" &&
      e.key !== "PageUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    )
      return
    const target = /** @type {HTMLElement|null} */ (document.activeElement)
    const idxStr = target?.dataset?.idx
    if (idxStr == null) return
    const idx = Number(idxStr)
    if (!Number.isFinite(idx)) return
    const pageSize = Math.max(
      1,
      Math.floor((listEl?.clientHeight || ROW_H) / ROW_H) - 1
    )
    let next = idx
    switch (e.key) {
      case "ArrowDown":
        next = idx + 1
        break
      case "ArrowUp":
        next = idx - 1
        break
      case "PageDown":
        next = idx + pageSize
        break
      case "PageUp":
        next = idx - pageSize
        break
      case "Home":
        next = 0
        break
      case "End":
        next = filtered.length - 1
        break
    }
    next = Math.max(0, Math.min(filtered.length - 1, next))
    if (next === idx) return
    e.preventDefault()
    e.stopPropagation()
    focusByIdx(next)
  },
  // Capture phase so spatial-nav's window-level handler doesn't beat us.
  true
)

// ----------------------------
// Search
// ----------------------------
function applyFilter() {
  if (!listStatus) return
  const qnorm = normalize(searchEl?.value || "")
  const tokens = qnorm.length ? qnorm.split(" ") : []

  const out = all.filter((m) => {
    if (activeCat && (m.category || "") !== activeCat) return false
    const cat = (m.category || "").toString()
    if (cat && hiddenCats.has(cat)) return false
    if (!tokens.length) return true
    return tokens.every((t) => m.norm.includes(t))
  })

  listStatus.textContent = `${out.length.toLocaleString()} of ${all.length.toLocaleString()} movies`
  mountVirtualList(out)
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
  if (viewport) viewport.innerHTML = ""
  if (spacer) spacer.style.height = "0px"
}

function paintMovies(data, fromCache, age) {
  all = data
  listStatus.textContent =
    `${all.length.toLocaleString()} movies` +
    (fromCache ? ` · cached, ${fmtAge(age)}` : "")
  renderCategoryPicker(all)
  applyFilter()
}

async function loadMovies() {
  if (!listStatus) return
  const active = await getActiveEntry()
  if (!active) {
    showEmptyState()
    return
  }

  // Synchronous cache check - paint instantly if available, no loading flash.
  const hit = getCached(active._id, "vod")
  if (hit) {
    paintMovies(hit.data, true, hit.age)
  } else {
    listStatus.textContent = "Loading movies…"
    if (spacer) spacer.style.height = "0px"
    if (viewport) viewport.innerHTML = ""
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
  if (hit) return // cache already painted; no further work.

  try {
    const { data, fromCache, age } = await cachedFetch(
      active._id,
      "vod",
      VOD_TTL_MS,
      async () => {
        const catMap = await ensureVodCategoryMap()
        const r = await fetch(buildApiUrl(creds, "get_vod_streams"))
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
            return {
              id,
              name,
              logo: logo || null,
              year,
              rating: rating ? String(rating) : "",
              duration: duration ? String(duration) : "",
              category,
              plot: "",
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
    console.error(e)
    listStatus.textContent =
      "Couldn't load movies - check your login or try Refresh."
    mountVirtualList([])
  }
}

// ----------------------------
// Player (lazy)
// ----------------------------
let vjs = null

const ensurePlayer = async () => {
  if (vjs) return vjs
  const [{ default: videojs }] = await Promise.all([
    import("video.js"),
    import("video.js/dist/video-js.css"),
  ])
  vjs = videojs("movie-player", {
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
  return "video/mp4"
}

async function playMovie(vodId, name) {
  const videoEl = document.getElementById("movie-player")
  if (!videoEl || !currentEl) return

  currentEl.replaceChildren()
  const wrap = document.createElement("div")
  wrap.className = "flex items-center gap-2 max-w-[calc(100%-4rem)]"
  wrap.innerHTML =
    '<span class="status-badge status-badge--on">ON</span>'
  const label = document.createElement("span")
  label.className = "truncate w-full"
  label.textContent = `Movie ${vodId}: ${name}`
  wrap.appendChild(label)
  currentEl.appendChild(wrap)

  videoEl.removeAttribute("hidden")
  const player = await ensurePlayer()

  try {
    const r = await fetch(buildApiUrl(creds, "get_vod_info", { vod_id: String(vodId) }))
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()
    const movieData = data?.movie_data || data?.info || data || {}
    const info = data?.info || data?.movie_data || {}

    let src = ""
    if (movieData.stream_url && /^https?:\/\//i.test(movieData.stream_url)) {
      src = movieData.stream_url
    } else if (movieData.stream_url) {
      const base = fmtBase(creds.host, creds.port).replace(/\/+$/, "")
      src = `${base}/${movieData.stream_url.replace(/^\/+/, "")}`
    } else {
      src =
        fmtBase(creds.host, creds.port) +
        "/movie/" +
        encodeURIComponent(creds.user) +
        "/" +
        encodeURIComponent(creds.pass) +
        "/" +
        encodeURIComponent(vodId) +
        ".mp4"
    }

    player.src({ src, type: chooseMime(src) })
    player.play().catch(() => {})

    const year = movieData.releasedate || movieData.year || info.year || ""
    const duration =
      movieData.duration || info.duration || movieData.duration_secs || ""
    const rating =
      movieData.rating || info.rating || movieData.rating_5based || ""
    const genre = movieData.genre || info.genre || movieData.category || ""
    const plot =
      movieData.plot || movieData.description || info.plot || info.description || ""

    if (metaEl) {
      const bits = []
      if (year) bits.push(year)
      const humanDur = fmtDuration(duration)
      if (humanDur) bits.push(humanDur)
      if (genre) bits.push(genre)
      if (rating) bits.push(`Rating: ${String(rating).slice(0, 4)}`)
      metaEl.textContent = bits.join(" • ")
    }
    if (plotEl) {
      plotEl.textContent = plot || "No description available for this movie."
    }
  } catch (e) {
    console.error(e)
    if (plotEl) plotEl.textContent = "Failed to load movie info or stream URL."
  }
}

// ----------------------------
// Boot
// ----------------------------
document.addEventListener("xt:active-changed", () => {
  loadMovies()
})

;(async () => {
  creds = await loadCreds()
  if (creds.host && creds.user && creds.pass) loadMovies()
})()
