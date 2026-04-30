// Live TV channel list, search, category picker, EPG and Video.js player.
import {
  loadCreds,
  getActiveEntry,
  fmtBase,
  safeHttpUrl,
  buildApiUrl,
  isLikelyM3USource,
  normalize,
  debounce,
} from "@/scripts/lib/creds.js"
import { cachedFetch, getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  getFavorites,
  pushRecent,
  getRecents,
  getHiddenCategories,
  setCategoryHidden,
} from "@/scripts/lib/preferences.js"
import { toast } from "@/scripts/lib/toast.js"
import { ICON_X } from "@/scripts/lib/icons.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { attachPlayerFocusKeeper } from "@/scripts/lib/player-focus-keeper.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import {
  loadProgrammes,
  getProgrammesSync,
  getNowNext,
  EPG_LOADED_EVENT,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"

const CHANNELS_TTL_MS = 24 * 60 * 60 * 1000

let currentlyPlayingId = null

function setNowPlaying(id) {
  currentlyPlayingId = id
  if (!viewport) return
  for (const row of viewport.querySelectorAll(".channel-row")) {
    const idx = Number(row.dataset.idx)
    const ch = filtered[idx]
    if (ch && ch.id === id) row.dataset.nowPlaying = "true"
    else delete row.dataset.nowPlaying
  }
}

/** @type {{host:string,port:string,user:string,pass:string}} */
let creds = { host: "", port: "", user: "", pass: "" }

function buildDirectM3U8(id) {
  const { host, port, user, pass } = creds
  return (
    fmtBase(host, port) +
    "/live/" +
    encodeURIComponent(user) +
    "/" +
    encodeURIComponent(pass) +
    "/" +
    encodeURIComponent(id) +
    ".m3u8"
  )
}

// ----------------------------
// M3U support
// ----------------------------
let directUrlById = new Map()
export let m3uEpgUrl = ""

function parseM3U(text) {
  /** @type {Array<{ id:number, name:string, tvgId?:string, chno?:number, category?:string, logo?:string|null, url:string, norm:string }>} */
  const out = []
  const lines = text.split(/\r?\n/)
  let pending = null
  m3uEpgUrl = ""

  const readAttr = (s, key) =>
    s.match(new RegExp(`\\b${key}="([^"]*)"`, "i"))?.[1] ||
    s.match(new RegExp(`\\b${key}=([^\\s,]+)`, "i"))?.[1] ||
    ""

  const stripAttrs = (s) =>
    s
      .replace(/\b[\w-]+="[^"]*"/g, "")
      .replace(/\b(tvg-[\w-]+|group-title|channel-id|channel-number)=[^\s,]+/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim()

  let idSeq = 1
  for (let raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith("#EXTM3U")) {
      // Header: `#EXTM3U x-tvg-url="https://provider/epg.xml.gz"` or `tvg-url="…"`.
      const url =
        readAttr(line, "x-tvg-url") ||
        readAttr(line, "tvg-url") ||
        readAttr(line, "url-tvg")
      if (url) m3uEpgUrl = url
      continue
    }

    if (line.startsWith("#EXTINF")) {
      const commaIdx = line.indexOf(",")
      const afterComma = commaIdx >= 0 ? line.slice(commaIdx + 1) : ""

      let name = stripAttrs(afterComma) || `Channel ${idSeq}`
      const logo = readAttr(line, "tvg-logo")
      const group = readAttr(line, "group-title") || "Uncategorized"
      const tvgId = readAttr(line, "tvg-id") || readAttr(line, "channel-id")
      const chnoStr =
        readAttr(line, "tvg-chno") || readAttr(line, "channel-number")
      const chno = chnoStr ? Number(chnoStr) : undefined
      pending = {
        name,
        logo,
        category: group,
        tvgId: tvgId || "",
        chno: Number.isFinite(chno) ? chno : undefined,
      }
      continue
    }

    if (line.startsWith("#")) continue

    if (pending) {
      const url = safeHttpUrl(line)
      if (url) {
        out.push({
          id: idSeq++,
          name: pending.name,
          category: pending.category,
          logo: pending.logo || null,
          tvgId: pending.tvgId || undefined,
          chno: pending.chno,
          norm: normalize(
            `${pending.name} ${pending.category} ${pending.tvgId || ""}`
          ),
          url,
        })
      }
      pending = null
    }
  }
  return out
}

const indexDirectUrls = (items) => {
  directUrlById = new Map()
  for (const ch of items) if (ch.url) directUrlById.set(ch.id, ch.url)
}
const hasDirectUrl = (id) => directUrlById.has(id)
const getDirectUrl = (id) => directUrlById.get(id) || ""

// ----------------------------
// UI refs
// ----------------------------
const listEl = document.getElementById("list")
const spacer = document.getElementById("spacer")
const viewport = document.getElementById("viewport")
const listStatus = document.getElementById("list-status")

const categoryListEl = document.getElementById("category-list")
const categoryListStatus = document.getElementById("category-list-status")
const categorySearchEl = document.getElementById("category-search")

const searchEl = document.getElementById("search")
const currentEl = document.getElementById("current")
const epgList = document.getElementById("epg-list")

let activeCat = ""
try {
  activeCat = localStorage.getItem("xt_active_cat") || ""
} catch {}

let activePlaylistId = ""
let activePlaylistTitle = ""

document.addEventListener("xt:active-changed", () => {
  loadChannels()
})

document.addEventListener(EPG_LOADED_EVENT, (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  refreshNowSlots()
})

document.addEventListener(EPG_OFFSET_EVENT, (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  ensureEpgLoaded()
})

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (activeCat === CAT_FAVORITES) scheduleApplyFilter()
  else renderVirtual()
  syncPseudoCategoryRows()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (activeCat === CAT_RECENTS) scheduleApplyFilter()
  syncPseudoCategoryRows()
})

document.addEventListener("xt:hidden-categories-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  renderCategoryPicker(all)
  scheduleApplyFilter()
})

const STAR_OUTLINE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'
const STAR_FILLED =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'

// ----------------------------
// Channels (virtualised)
// ----------------------------
/** @type {Array<{ id: number, name: string, category?: string, logo?: string | null, norm:string }>} */
let all = []
/** @type {Array<typeof all[number]>} */
let filtered = []
let showHidden = false
function hiddenSet() {
  return activePlaylistId
    ? getHiddenCategories(activePlaylistId, "live")
    : new Set()
}

/** @type {Map<string,string> | null} */
let categoryMap = null

const ROW_H = 68
const OVERSCAN = 6
let renderScheduled = false

let pendingFocusIdx = -1

function mountVirtualList(items) {
  if (!spacer || !viewport || !listEl) return
  filtered = items || []
  spacer.style.height = `${filtered.length * ROW_H}px`

  if (listEl.scrollTop > filtered.length * ROW_H) listEl.scrollTop = 0

  pendingFocusIdx = -1
  renderVirtual()
}

function fmtNowTimeRange(start, stop) {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })
    return `${fmt.format(start)}–${fmt.format(stop)}`
  } catch {
    return ""
  }
}

function paintNowSlot(slot, playBtn, ch) {
  if (!slot) return
  slot.replaceChildren()
  const state = activePlaylistId ? getProgrammesSync(activePlaylistId) : null
  if (!state || !ch.tvgId) return
  const { current, next } = getNowNext(state.programmes, ch.tvgId)
  if (!current && !next) return

  if (current) {
    const line = document.createElement("div")
    line.className = "channel-now"
    line.textContent = current.title
    slot.appendChild(line)

    const bar = document.createElement("div")
    bar.className = "channel-now-bar"
    bar.setAttribute("aria-hidden", "true")
    const fill = document.createElement("i")
    const span = current.stop - current.start
    const pct =
      span > 0
        ? Math.max(0, Math.min(100, ((Date.now() - current.start) / span) * 100))
        : 0
    fill.style.width = `${pct}%`
    bar.appendChild(fill)
    slot.appendChild(bar)
  } else if (next) {
    const line = document.createElement("div")
    line.className = "channel-now channel-now--upcoming"
    line.textContent = `Next: ${next.title}`
    slot.appendChild(line)
  }

  if (playBtn) {
    const parts = [ch.name || ""]
    if (current) {
      parts.push(`Now: ${current.title} (${fmtNowTimeRange(current.start, current.stop)})`)
    }
    if (next) {
      parts.push(`Next: ${next.title} (${fmtNowTimeRange(next.start, next.stop)})`)
    }
    playBtn.title = parts.filter(Boolean).join("\n")
  }
}

function refreshNowSlots() {
  if (!viewport) return
  for (const row of viewport.querySelectorAll(".channel-row")) {
    const idx = Number(row.dataset.idx)
    const ch = filtered[idx]
    if (!ch) continue
    const slot = row.querySelector(".channel-now-slot")
    const playBtn = row.querySelector("[data-role='play']")
    paintNowSlot(slot, playBtn, ch)
  }
}

function renderVirtual() {
  if (!listEl || !viewport) return
  const scrollTop = listEl.scrollTop
  // Cap at viewport height: prevents runaway render if listEl ever loses its bounded layout.
  const visibleH = Math.max(
    0,
    Math.min(listEl.clientHeight, window.innerHeight || listEl.clientHeight)
  )
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const endIdx = Math.min(
    filtered.length,
    Math.ceil((scrollTop + visibleH) / ROW_H) + OVERSCAN
  )

  const frag = document.createDocumentFragment()
  for (let i = startIdx; i < endIdx; i++) {
    const ch = filtered[i]

    const row = document.createElement("div")
    row.dataset.idx = String(i)
    row.style.height = `${ROW_H}px`
    row.className = "channel-row flex w-full items-center gap-1"
    if (ch.id === currentlyPlayingId) row.dataset.nowPlaying = "true"

    const playBtn = document.createElement("button")
    playBtn.type = "button"
    playBtn.dataset.role = "play"
    playBtn.className =
      "play-btn flex flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-left h-full min-w-0 hover:bg-surface-2 focus:bg-surface-2 outline-none"
    playBtn.title = ch.name || ""
    playBtn.onclick = () => play(ch.id, ch.name)

    const logo = document.createElement("div")
    logo.className =
      "h-9 w-9 shrink-0 rounded-md bg-surface-2 overflow-hidden ring-1 ring-inset ring-line"
    if (ch.logo) {
      const safeLogo = safeHttpUrl(ch.logo)
      if (safeLogo) {
        const img = document.createElement("img")
        img.src = safeLogo
        img.alt = ""
        img.loading = "lazy"
        img.decoding = "async"
        img.referrerPolicy = "no-referrer"
        img.className = "h-full w-full object-contain"
        img.onerror = () => img.remove()
        logo.appendChild(img)
      }
    }
    playBtn.appendChild(logo)

    const wrap = document.createElement("div")
    wrap.className = "min-w-0 flex-1"
    const nameEl = document.createElement("div")
    nameEl.className = "truncate text-sm font-medium"
    nameEl.textContent = ch.name
    const meta = document.createElement("div")
    meta.className = "truncate text-xs text-fg-3 tabular-nums"
    meta.textContent = `#${ch.id}${ch.category ? ` · ${ch.category}` : ""}`
    wrap.append(nameEl, meta)
    const nowSlot = document.createElement("div")
    nowSlot.className = "channel-now-slot"
    wrap.appendChild(nowSlot)
    paintNowSlot(nowSlot, playBtn, ch)
    playBtn.appendChild(wrap)

    const fav = activePlaylistId
      ? isFavorite(activePlaylistId, "live", ch.id)
      : false
    const starBtn = document.createElement("button")
    starBtn.type = "button"
    starBtn.dataset.role = "star"
    starBtn.className =
      "star-btn flex shrink-0 h-11 w-11 items-center justify-center rounded-lg text-base outline-none transition-colors " +
      (fav
        ? "text-accent hover:bg-surface-2 focus:bg-surface-2"
        : "text-fg-3 hover:text-fg hover:bg-surface-2 focus:text-fg focus:bg-surface-2")
    starBtn.setAttribute(
      "aria-label",
      fav
        ? `Remove ${ch.name || "channel"} from favorites`
        : `Add ${ch.name || "channel"} to favorites`
    )
    starBtn.setAttribute("aria-pressed", String(fav))
    starBtn.innerHTML = fav ? STAR_FILLED : STAR_OUTLINE
    starBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      if (!activePlaylistId) return
      toggleFavorite(activePlaylistId, "live", ch.id, {
        name: ch.name || "",
        logo: ch.logo || null,
      })
      starBtn.classList.remove("star-pulse")
      void starBtn.offsetWidth
      starBtn.classList.add("star-pulse")
    })
    starBtn.addEventListener("animationend", () => {
      starBtn.classList.remove("star-pulse")
    })

    row.append(playBtn, starBtn)
    frag.appendChild(row)
  }

  viewport.replaceChildren(frag)
  viewport.style.transform = `translateY(${startIdx * ROW_H}px)`

  if (pendingFocusIdx >= startIdx && pendingFocusIdx < endIdx) {
    const target = /** @type {HTMLElement|null} */ (
      viewport.querySelector(`[data-idx="${pendingFocusIdx}"] .play-btn`)
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

  pendingFocusIdx = idx

  const present = /** @type {HTMLElement|null} */ (
    viewport?.querySelector(`[data-idx="${idx}"] .play-btn`)
  )
  if (present) present.focus({ preventScroll: true })
}

listEl?.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "PageDown" && e.key !== "PageUp" && e.key !== "Home" && e.key !== "End") return
    const target = /** @type {HTMLElement|null} */ (document.activeElement)
    const row = target?.closest?.("[data-idx]")
    const idxStr = /** @type {HTMLElement|null} */ (row)?.dataset?.idx
    if (idxStr == null) return
    const idx = Number(idxStr)
    if (!Number.isFinite(idx)) return
    const pageSize = Math.max(
      1,
      Math.floor((listEl?.clientHeight || ROW_H) / ROW_H) - 1
    )
    let next = idx
    switch (e.key) {
      case "ArrowDown": next = idx + 1; break
      case "ArrowUp":   next = idx - 1; break
      case "PageDown":  next = idx + pageSize; break
      case "PageUp":    next = idx - pageSize; break
      case "Home":      next = 0; break
      case "End":       next = filtered.length - 1; break
    }
    next = Math.max(0, Math.min(filtered.length - 1, next))
    if (next === idx) return
    e.preventDefault()
    e.stopPropagation()
    focusByIdx(next)
  },
  true
)

let _applyFilterScheduled = false
function scheduleApplyFilter() {
  if (_applyFilterScheduled) return
  _applyFilterScheduled = true
  queueMicrotask(() => {
    _applyFilterScheduled = false
    applyFilter()
  })
}

const applyFilter = () => {
  if (!searchEl || !listStatus) return
  const qnorm = normalize(searchEl.value || "")
  const tokens = qnorm.length ? qnorm.split(" ") : []

  /** @type {typeof all} */
  let out
  if (activeCat === CAT_FAVORITES && activePlaylistId) {
    const favs = getFavorites(activePlaylistId, "live")
    out = all.filter((ch) => favs.has(ch.id))
  } else if (activeCat === CAT_RECENTS && activePlaylistId) {
    const byId = new Map(all.map((ch) => [ch.id, ch]))
    const recs = getRecents(activePlaylistId, "live")
    out = []
    for (const r of recs) {
      const ch = byId.get(r.id)
      if (ch) out.push(ch)
    }
  } else {
    out = all.filter((ch) => {
      if (activeCat && (ch.category || "") !== activeCat) return false
      const cat = (ch.category || "").toString()
      if (cat && hiddenSet().has(cat)) return false
      return true
    })
  }

  if (tokens.length) {
    out = out.filter((ch) => tokens.every((t) => ch.norm.includes(t)))
  }

  listStatus.textContent = `${out.length.toLocaleString()} of ${all.length.toLocaleString()} channels`
  mountVirtualList(out)
}

searchEl?.addEventListener("input", debounce(applyFilter, 160))

async function ensureCategoryMap() {
  if (categoryMap) return categoryMap
  const r = await providerFetch(buildApiUrl(creds, "get_live_categories"))
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
  for (const ch of items) {
    const k = (ch.category || "").trim() || "Uncategorized"
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
      "group/cat relative w-full py-2 px-2 text-sm flex items-center justify-between hover:bg-surface-2 focus:bg-surface-2 outline-none text-fg" +
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
        setCategoryHidden(activePlaylistId, "live", val, willHide)
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
    ? getFavorites(activePlaylistId, "live")
    : new Set()
  const recs = activePlaylistId ? getRecents(activePlaylistId, "live") : []
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
      "w-full px-2 py-2 text-xs text-fg-3 hover:text-fg hover:bg-surface-2 focus:bg-surface-2 outline-none flex items-center justify-between"
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
  if (categoryListStatus) {
    const total = visibleNames.length
    categoryListStatus.textContent = `${total.toLocaleString()} ${total === 1 ? "category" : "categories"}${hiddenNames.length ? ` · ${hiddenNames.length} hidden` : ""}`
  }
  categoryListEl.appendChild(frag)

  highlightActiveInList()
}

function syncPseudoCategoryRows() {
  if (!categoryListEl || !activePlaylistId) return
  const favs = getFavorites(activePlaylistId, "live")
  const recs = getRecents(activePlaylistId, "live")
  for (const [val, n] of [
    [CAT_FAVORITES, favs.size],
    [CAT_RECENTS, recs.length],
  ]) {
    const btn = /** @type {HTMLButtonElement|null} */ (
      categoryListEl.querySelector(
        `button[role="option"][data-val="${val}"]`
      )
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
    const isAllButton = btn.dataset.val === ""
    if (!isAllButton) totalCount++
    const label = normalize(btn.dataset.val || btn.textContent || "")
    const matches = !tokens.length || tokens.every((t) => label.includes(t))
    btn.style.display = matches ? "" : "none"
    if (matches && !isAllButton) visibleCount++
  }

  categoryListStatus.textContent = `${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()} categories`
}

categorySearchEl?.addEventListener("input", debounce(filterCategories, 120))

function setActiveCat(next) {
  const prev = activeCat
  activeCat = next || ""
  try {
    if (activeCat) localStorage.setItem("xt_active_cat", activeCat)
    else localStorage.removeItem("xt_active_cat")
  } catch {}
  scheduleApplyFilter()
  if (prev !== activeCat) {
    document.dispatchEvent(
      new CustomEvent("xt:cat-changed", { detail: activeCat })
    )
  }
}

function showEmptyState() {
  if (categoryListStatus) {
    categoryListStatus.innerHTML = `<a href="/login" class="text-accent underline">Add a playlist</a> to get started.`
  }
  if (listStatus) {
    listStatus.innerHTML = `No playlist selected. <a href="/login" class="text-accent underline">Add one</a>.`
  }
  filtered = []
  if (spacer) spacer.style.height = "0px"
  if (viewport) viewport.innerHTML = ""
}

function fmtAge(ms) {
  if (ms < 60_000) return "just now"
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function paintChannels(data, fromCache, age) {
  all = data
  listStatus.textContent =
    `${all.length.toLocaleString()} channels` +
    (fromCache ? ` · cached, ${fmtAge(age)}` : "")
  renderCategoryPicker(all)
  applyFilter()
  maybeAutoplayFromUrl()
  ensureEpgLoaded()
}

function ensureEpgLoaded() {
  if (!activePlaylistId || !creds.host) return
  if (!all.some((ch) => ch.tvgId)) return
  loadProgrammes(activePlaylistId, creds).catch(() => {})
}

let autoplayConsumed = false
function maybeAutoplayFromUrl() {
  if (autoplayConsumed) return
  let id = null
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get("channel")
    if (raw) id = Number(raw)
  } catch {}
  if (!Number.isFinite(id) || id == null) return
  autoplayConsumed = true
  const ch = all.find((c) => c.id === id)
  if (!ch) return
  // Strip the ?channel= so refresh doesn't re-trigger.
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete("channel")
    window.history.replaceState({}, "", url.toString())
  } catch {}
  play(ch.id, ch.name)
}

async function loadChannels() {
  console.log("[xt:livetv] loadChannels enter")
  if (!listStatus || !categoryListStatus || !viewport) {
    console.warn("[xt:livetv] loadChannels: missing DOM nodes", {
      listStatus: !!listStatus,
      categoryListStatus: !!categoryListStatus,
      viewport: !!viewport,
    })
    return
  }
  const active = await getActiveEntry()
  console.log("[xt:livetv] loadChannels active=", active?._id || null)
  if (!active) {
    activePlaylistId = ""
    activePlaylistTitle = ""
    showEmptyState()
    return
  }
  activePlaylistId = active._id
  activePlaylistTitle = active.title || ""

  await ensurePrefsLoaded()
  await Promise.all([
    hydrateCache(active._id, "live"),
    hydrateCache(active._id, "m3u"),
  ])

  const liveHit = getCached(active._id, "live")
  const m3uHit = getCached(active._id, "m3u")
  const hit = liveHit || m3uHit
  if (hit) {
    if (m3uHit) indexDirectUrls(hit.data)
    else directUrlById = new Map()
    paintChannels(hit.data, true, hit.age)
  } else {
    categoryListStatus.textContent = "Loading categories…"
    listStatus.textContent = "Loading channels…"
    viewport.innerHTML = ""
  }

  creds = await loadCreds()
  if (!creds.host) {
    if (!hit) showEmptyState()
    return
  }
  if (hit) return // cache already painted; nothing else to do.

  try {
    if (isLikelyM3USource(creds.host, creds.user, creds.pass)) {
      const { data, fromCache, age } = await cachedFetch(
        active._id,
        "m3u",
        CHANNELS_TTL_MS,
        async () => {
          const r = await providerFetch(creds.host)
          if (!r.ok) throw new Error(`M3U ${r.status}: ${await r.text()}`)
          const text = await r.text()
          return parseM3U(text)
            .filter((x) => x.url && x.name)
            .sort((a, b) =>
              a.name.localeCompare(b.name, "en", { sensitivity: "base" })
            )
        }
      )
      indexDirectUrls(data)
      categoryMap = null
      if (m3uEpgUrl) {
        try {
          localStorage.setItem(`xt_m3u_epg:${active._id}`, m3uEpgUrl)
        } catch {}
      }
      paintChannels(data, fromCache, age)
      return
    }

    const { data, fromCache, age } = await cachedFetch(
      active._id,
      "live",
      CHANNELS_TTL_MS,
      async () => {
        const catMap = await ensureCategoryMap()
        const r = await providerFetch(buildApiUrl(creds, "get_live_streams"))
        console.log("[xt:livetv] get_live_streams resp status=", r.status, "ok=", r.ok)
        const body = await r.text()
        console.log("[xt:livetv] body bytes=", body?.length ?? 0)
        if (!r.ok) {
          console.error("Upstream error body:", body)
          throw new Error(`API ${r.status}: ${body}`)
        }
        const parsed = JSON.parse(body)
        console.log("[xt:livetv] parsed array length=", Array.isArray(parsed) ? parsed.length : "(not array)")
        const arr = Array.isArray(parsed)
          ? parsed
          : parsed?.streams || parsed?.results || []
        return (arr || [])
          .map((ch) => {
            const name = String(ch.name || "")
            const ids =
              (Array.isArray(ch.category_ids) &&
                ch.category_ids.length &&
                ch.category_ids) ||
              (ch.category_id != null ? [ch.category_id] : [])
            let category = String(ch.category_name || "").trim()
            if (!category && ids.length && catMap?.size) {
              for (const id of ids) {
                const n = catMap.get(String(id))
                if (n) {
                  category = n
                  break
                }
              }
            }
            return {
              id: Number(ch.stream_id),
              name,
              category,
              logo: ch.stream_icon || null,
              tvgId: String(ch.epg_channel_id || "") || undefined,
              norm: normalize(name + " " + category),
            }
          })
          .filter((x) => x.id && x.name)
          .sort((a, b) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
          )
      }
    )
    directUrlById = new Map()
    console.log("[xt:livetv] cachedFetch returned len=", data?.length ?? 0, "fromCache=", fromCache)
    paintChannels(data, fromCache, age)
    console.log("[xt:livetv] paintChannels done")
  } catch (e) {
    console.error("[xt:livetv] loadChannels threw:", e)
    mountVirtualList([])
    renderProviderError(listStatus, {
      providerName: activePlaylistTitle,
      kind: "channels",
      onRetry: loadChannels,
    })
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
  // Hide Video.js's built-in PiP toggle on Tauri Android - the WebView
  // doesn't expose Web PiP so the button always renders disabled. Native
  // PiP goes through the in-page button + AndroidPip bridge instead.
  const hasNativePipBridge = !!window.AndroidPip
  vjs = videojs("player", {
    liveui: true,
    fluid: true,
    preload: "auto",
    autoplay: false,
    aspectRatio: "16:9",
    controlBar: {
      volumePanel: { inline: false },
      pictureInPictureToggle: !hasNativePipBridge,
      playbackRateMenuButton: false,
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

async function play(streamId, name) {
  if (!currentEl) return
  const src = hasDirectUrl(streamId)
    ? getDirectUrl(streamId)
    : buildDirectM3U8(streamId)

  setNowPlaying(streamId)

  if (activePlaylistId) {
    const ch = all.find((c) => c.id === streamId)
    pushRecent(activePlaylistId, "live", streamId, name, ch?.logo || null)
  }

  currentEl.replaceChildren()
  const wrap = document.createElement("div")
  wrap.className = "flex items-center gap-2 max-w-[calc(100%-4rem)]"
  wrap.innerHTML =
    '<span class="status-badge status-badge--live">ON</span>'
  const label = document.createElement("span")
  label.className = "truncate w-full"
  label.append(`Channel ${streamId}: `)
  const nameEl = document.createElement("span")
  nameEl.className = "text-accent"
  nameEl.textContent = name
  label.appendChild(nameEl)
  wrap.appendChild(label)
  currentEl.appendChild(wrap)

  document.getElementById("player")?.removeAttribute("hidden")
  const player = await ensurePlayer()
  player.src({ src, type: "application/x-mpegURL" })
  player.play().catch(() => {})

  if (hasDirectUrl(streamId)) {
    if (epgList) epgList.innerHTML = `<div class="text-fg-3">No EPG available for M3U source.</div>`
  } else {
    loadEPG(streamId)
  }

  document.getElementById("pip-btn")?.remove()
  const btn = document.createElement("button")
  btn.id = "pip-btn"
  btn.className = "min-h-11 px-3.5 rounded-xl border border-line bg-surface text-sm text-fg hover:bg-surface-2"
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M19 4a3 3 0 0 1 3 3v4a1 1 0 0 1 -2 0v-4a1 1 0 0 0 -1 -1h-14a1 1 0 0 0 -1 1v10a1 1 0 0 0 1 1h6a1 1 0 0 1 0 2h-6a3 3 0 0 1 -3 -3v-10a3 3 0 0 1 3 -3z"/><path d="M20 13a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-5a2 2 0 0 1 -2 -2v-3a2 2 0 0 1 2 -2z"/></svg>`
  currentEl.appendChild(btn)
  btn.addEventListener("click", async () => {
    const videoEl = /** @type {HTMLVideoElement|null} */ (
      player.el().querySelector("video")
    )
    if (window.AndroidPip?.toggle) {
      if (window.AndroidPip.isInPip?.()) {
        window.AndroidPip.toggle()
        return
      }
      // Tap = user gesture, so requestFullscreen on the actual <video> tag
      // is allowed. Fullscreening it first means Android's WebChromeClient
      // swaps in the immersive video surface, so when AndroidPip.toggle()
      // captures the activity for PiP, only the video shows up - not the
      // page navbar. If fullscreen rejects (older WebView, denied gesture),
      // we still toggle so the click isn't dead, just degrades to page PiP.
      if (videoEl && !document.fullscreenElement) {
        try {
          await videoEl.requestFullscreen()
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r))
          )
        } catch {}
      }
      window.AndroidPip.toggle()
      return
    }
    if (
      videoEl &&
      document.pictureInPictureEnabled &&
      !videoEl.disablePictureInPicture
    ) {
      try {
        if (document.pictureInPictureElement === videoEl) {
          await document.exitPictureInPicture()
        } else {
          if (videoEl.readyState < 2) await videoEl.play().catch(() => {})
          await videoEl.requestPictureInPicture()
        }
      } catch {}
    }
  })
}

// ----------------------------
// EPG
// ----------------------------
const textDecoder = new TextDecoder("utf-8")

function maybeB64ToUtf8(str) {
  if (!str || typeof str !== "string") return str || ""
  const looksB64 =
    /^[A-Za-z0-9+/=\s]+$/.test(str) && str.replace(/\s+/g, "").length % 4 === 0
  if (!looksB64) return str
  try {
    const bin = atob(str.replace(/\s+/g, ""))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const utf8 = textDecoder.decode(bytes)
    return utf8.replace(/\s/g, "").length === 0 ? str : utf8
  } catch {
    return str
  }
}

const fmtTime = (ts) => {
  const n = Number(ts)
  if (!Number.isFinite(n)) return ""
  try {
    return new Date(n * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return ""
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c])

/** @type {Array<{ start:number, stop:number, title:string, desc:string }>} */
let epgListData = []
let epgListChannelId = 0
let epgListChannelName = ""

async function loadEPG(streamId) {
  if (!epgList) return
  const url = buildApiUrl(creds, "get_short_epg", {
    stream_id: String(streamId),
    limit: "10",
  })

  epgList.innerHTML = `<div class="text-fg-3">Loading EPG…</div>`
  epgListData = []
  epgListChannelId = streamId
  epgListChannelName = all.find((c) => c.id === streamId)?.name || ""
  try {
    const r = await providerFetch(url)
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()

    const items = Array.isArray(data?.epg_listings)
      ? data.epg_listings
      : Array.isArray(data)
      ? data
      : []
    if (!items.length) {
      epgList.innerHTML = `<div class="text-fg-3">No EPG available.</div>`
      return
    }

    const now = Date.now()
    epgListData = items
      .map((it) => ({
        start: Number(it.start_timestamp || it.start) * 1000,
        stop: Number(it.stop_timestamp || it.end) * 1000,
        title: maybeB64ToUtf8(it.title || it.title_raw || "Untitled"),
        desc: maybeB64ToUtf8(it.description || it.description_raw || ""),
      }))
      .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.stop) && p.stop > p.start)

    epgList.innerHTML = epgListData
      .map((p, idx) => {
        const isLive = p.start <= now && now < p.stop
        const start = fmtTime(p.start / 1000)
        const end = fmtTime(p.stop / 1000)
        const title = escapeHtml(p.title)
        const desc = escapeHtml(p.desc)
        return `
          <button type="button" data-epg-idx="${idx}"
            class="epg-entry block w-full min-h-11 text-left rounded-lg px-3 py-2 outline-none transition-colors
                   ${isLive ? "bg-accent-soft ring-1 ring-accent/30 hover:bg-accent/20" : "bg-surface-2 hover:bg-surface-3"}
                   focus-visible:ring-2 focus-visible:ring-accent">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                ${isLive ? '<span class="size-1.5 rounded-full bg-accent shrink-0" aria-label="Now playing"></span>' : ""}
                <div class="font-medium text-fg truncate">${title}</div>
              </div>
              <div class="text-xs text-fg-3 tabular-nums shrink-0">${start}–${end}</div>
            </div>
            ${desc ? `<div class="mt-1 text-sm text-fg-2 leading-relaxed line-clamp-3">${desc}</div>` : ""}
          </button>`
      })
      .join("")
  } catch (e) {
    console.error(e)
    epgList.innerHTML = `<div class="text-bad">Failed to load EPG.</div>`
  }
}

epgList?.addEventListener("click", async (e) => {
  const target = /** @type {HTMLElement | null} */ (e.target)
  const btn = target?.closest("[data-epg-idx]")
  if (!btn) return
  const idx = Number(/** @type {HTMLElement} */ (btn).dataset.epgIdx)
  const entry = epgListData[idx]
  if (!entry) return
  const { openProgrammeDialog } = await import("@/scripts/lib/programme-dialog.js")
  openProgrammeDialog({
    title: entry.title,
    desc: entry.desc,
    start: entry.start,
    stop: entry.stop,
    channelName: epgListChannelName,
    channelId: epgListChannelId,
    onWatch: () => {
      if (currentlyPlayingId !== epgListChannelId && epgListChannelId) {
        play(epgListChannelId, epgListChannelName)
      }
    },
  })
})

setInterval(() => {
  if (!activePlaylistId) return
  if (!getProgrammesSync(activePlaylistId)) return
  refreshNowSlots()
}, 60 * 1000)

// ----------------------------
// Boot
// ----------------------------
;(async () => {
  console.log("[xt:livetv] boot start")
  creds = await loadCreds()
  console.log("[xt:livetv] boot creds host=", !!creds.host)
  if (creds.host) {
    loadChannels()
  } else {
    showEmptyState()
  }
})()
