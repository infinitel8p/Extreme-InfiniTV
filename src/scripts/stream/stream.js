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

// Channel lists rarely change within a session; refresh once a day or when
// the user explicitly hits the refresh button (which calls invalidateEntry).
const CHANNELS_TTL_MS = 24 * 60 * 60 * 1000

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

/**
 * Parse a (possibly very large) M3U/M3U8 playlist into our normalised
 * channel shape. Handles two real-world EXTINF variants:
 *
 *   #EXTINF:-1 tvg-id="x" tvg-logo="…" group-title="Sports",Channel Name
 *   #EXTINF:-1,Channel Name tvg-id="x" tvg-logo="…" group-title="…"
 *
 * Attributes are always read with a regex over the whole line, so they're
 * picked up regardless of which side of the comma they live on. The name
 * is the substring after the first comma with any `key="…"` attribute pairs
 * stripped out (so the alternate format doesn't bake attrs into the title).
 *
 * Also pulls `x-tvg-url` (or `tvg-url`) off the `#EXTM3U` header so the EPG
 * grid view has somewhere to fetch XMLTV from.
 *
 * Returns the channel array directly (callers cache that). The EPG URL is
 * exposed via the module-level `m3uEpgUrl` because it's tiny and per-load.
 */
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

document.addEventListener("xt:active-changed", () => {
  loadChannels()
})

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (activeCat === CAT_FAVORITES) applyFilter()
  else renderVirtual()
  syncPseudoCategoryRows()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (activeCat === CAT_RECENTS) applyFilter()
  syncPseudoCategoryRows()
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
const hiddenCats = new Set()

/** @type {Map<string,string> | null} */
let categoryMap = null

const ROW_H = 56
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
    const ch = filtered[i]

    const row = document.createElement("div")
    row.dataset.idx = String(i)
    row.style.height = `${ROW_H}px`
    row.className = "channel-row flex w-full items-center gap-1"

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
      toggleFavorite(activePlaylistId, "live", ch.id)
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
      if (cat && hiddenCats.has(cat)) return false
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
      "w-full py-2 px-2 text-sm flex items-center justify-between hover:bg-surface-2 focus:bg-surface-2 outline-none text-fg" +
      (extraClass ? " " + extraClass : "")
    const left = document.createElement("span")
    left.className = "truncate"
    left.textContent = label
    const right = document.createElement("span")
    right.className = "category-count ml-3 shrink-0 text-xs text-fg-3 tabular-nums"
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
    ? getFavorites(activePlaylistId, "live")
    : new Set()
  const recs = activePlaylistId ? getRecents(activePlaylistId, "live") : []
  const favRow = addRow(CAT_FAVORITES, "★ Favorites", favs.size, "text-accent")
  if (favs.size === 0) favRow.style.display = "none"
  const recRow = addRow(CAT_RECENTS, "🕒 Recently watched", recs.length)
  if (recs.length === 0) recRow.style.display = "none"

  addRow("", "All categories")
  for (const name of names) addRow(name, name, counts.get(name))

  categoryListEl.innerHTML = ""
  if (categoryListStatus) {
    categoryListStatus.textContent = `${names.length.toLocaleString()} categories`
  }
  categoryListEl.appendChild(frag)

  setActiveCat(activeCat)
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
  activeCat = next || ""
  try {
    if (activeCat) localStorage.setItem("xt_active_cat", activeCat)
    else localStorage.removeItem("xt_active_cat")
  } catch {}
  applyFilter()
  document.dispatchEvent(
    new CustomEvent("xt:cat-changed", { detail: activeCat })
  )
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
  if (!listStatus || !categoryListStatus || !viewport) return
  const active = await getActiveEntry()
  if (!active) {
    activePlaylistId = ""
    showEmptyState()
    return
  }
  activePlaylistId = active._id

  await ensurePrefsLoaded()

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
        const body = await r.text()
        if (!r.ok) {
          console.error("Upstream error body:", body)
          throw new Error(`API ${r.status}: ${body}`)
        }
        const parsed = JSON.parse(body)
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
    paintChannels(data, fromCache, age)
  } catch (e) {
    console.error(e)
    listStatus.textContent =
      "Couldn't load channels - check your login or try Refresh."
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
  vjs = videojs("player", {
    liveui: true,
    fluid: true,
    preload: "auto",
    autoplay: false,
    aspectRatio: "16:9",
    controlBar: {
      volumePanel: { inline: false },
      pictureInPictureToggle: true,
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
  return vjs
}

async function play(streamId, name) {
  if (!currentEl) return
  const src = hasDirectUrl(streamId)
    ? getDirectUrl(streamId)
    : buildDirectM3U8(streamId)

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
  label.textContent = `Channel ${streamId}: ${name}`
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
    if (window.AndroidPip?.toggle) {
      player.requestFullscreen()
      window.AndroidPip.toggle()
      return
    }
    const el = player.el().querySelector("video")
    if (document.pictureInPictureEnabled && !el.disablePictureInPicture) {
      try {
        if (document.pictureInPictureElement === el) {
          await document.exitPictureInPicture()
        } else {
          if (el.readyState < 2) await el.play().catch(() => {})
          await el.requestPictureInPicture()
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

async function loadEPG(streamId) {
  if (!epgList) return
  const url = buildApiUrl(creds, "get_short_epg", {
    stream_id: String(streamId),
    limit: "10",
  })

  epgList.innerHTML = `<div class="text-fg-3">Loading EPG…</div>`
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

    const nowSec = Math.floor(Date.now() / 1000)
    epgList.innerHTML = items
      .map((it) => {
        const startTs = Number(it.start_timestamp || it.start)
        const endTs = Number(it.stop_timestamp || it.end)
        const isLive =
          Number.isFinite(startTs) &&
          Number.isFinite(endTs) &&
          startTs <= nowSec &&
          nowSec < endTs
        const start = fmtTime(startTs)
        const end = fmtTime(endTs)
        const title = escapeHtml(maybeB64ToUtf8(it.title || it.title_raw || ""))
        const desc = escapeHtml(
          maybeB64ToUtf8(it.description || it.description_raw || "")
        )
        return `
          <div class="rounded-lg p-2 ${isLive ? "bg-accent-soft ring-1 ring-accent/30" : "bg-surface-2"}">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                ${isLive ? '<span class="size-1.5 rounded-full bg-accent shrink-0" aria-label="Now playing"></span>' : ""}
                <div class="font-medium text-fg truncate">${title}</div>
              </div>
              <div class="text-xs text-fg-3 tabular-nums shrink-0">${start}–${end}</div>
            </div>
            ${desc ? `<div class="mt-1 text-sm text-fg-2 leading-relaxed line-clamp-3">${desc}</div>` : ""}
          </div>`
      })
      .join("")
  } catch (e) {
    console.error(e)
    epgList.innerHTML = `<div class="text-bad">Failed to load EPG.</div>`
  }
}

// ----------------------------
// Boot
// ----------------------------
;(async () => {
  creds = await loadCreds()
  if (creds.host) {
    loadChannels()
  } else {
    showEmptyState()
  }
})()
