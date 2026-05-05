// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// EPG schedule grid view.
import { log } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
  buildApiUrl,
  isLikelyM3USource,
} from "@/scripts/lib/creds.js"
import { normalize } from "@/scripts/lib/text.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { getCached } from "@/scripts/lib/cache.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import {
  loadProgrammes,
  invalidateEpgPlaylist,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"
import { openProgrammeDialog } from "@/scripts/lib/programme-dialog.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  getFavorites,
  getRecents,
} from "@/scripts/lib/preferences.js"

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const PX_PER_HOUR = 200
const HOURS_VISIBLE = 6
const ROW_HEIGHT = 64
const CHANNEL_COL_WIDTH = 240
const MAX_CHANNELS = 150

// ----------------------------
// UI refs
// ----------------------------
const statusEl = document.getElementById("epg-status")
const gridEl = document.getElementById("epg-grid")
const headerInner = document.getElementById("epg-time-header-inner")
const bodyEl = document.getElementById("epg-body")
const titleEl = document.getElementById("epg-title")
const refreshBtn = document.getElementById("epg-refresh")
const nowBtn = document.getElementById("epg-now")
const categoryLabelEl = document.getElementById("epg-category-label")
const categoryListEl = document.getElementById("epg-category-list")
const categoryListStatus = document.getElementById("epg-category-list-status")
const categorySearchEl = /** @type {HTMLInputElement|null} */ (
  document.getElementById("epg-category-search")
)
const categoryDialog = /** @type {HTMLDialogElement|null} */ (
  document.getElementById("epg-category-dialog")
)

// ----------------------------
// State
// ----------------------------
/** @type {{host:string,port:string,user:string,pass:string}} */
let creds = { host: "", port: "", user: "", pass: "" }
let activePlaylistId = ""
let activePlaylistTitle = ""
let activeCat = ""
/** @type {Array<{id:number,name:string,logo?:string|null,tvgId?:string,category?:string}>} */
let channels = []
/** @type {Array<{id:number,name:string,logo?:string|null,tvgId?:string,category?:string}>} */
let allChannels = []
/** @type {Map<string, Array<{start:number,stop:number,title:string,desc:string}>>} channel id (tvg-id, lower-cased) → sorted programmes */
const programmes = new Map()
let viewStart = 0

function setStatus(text) {
  if (statusEl) statusEl.textContent = text
}

function showStatus(text) {
  if (statusEl) {
    statusEl.classList.remove("hidden", "epg-status-skeleton")
    statusEl.classList.add("epg-status-text")
    statusEl.textContent = text
  }
  if (gridEl) gridEl.classList.add("hidden")
}

function showLoadingSkeleton(label = t("epg.loadingSkeleton")) {
  if (!statusEl) return
  statusEl.classList.remove("hidden", "epg-status-text")
  statusEl.classList.add("epg-status-skeleton")
  statusEl.textContent = ""
  if (gridEl) gridEl.classList.add("hidden")
  renderEpgSkeletonInto(statusEl, label)
}

function renderEpgSkeletonInto(target, label) {
  const HOURS = 6
  const HEADER_H = 40
  const ROW_H = 64
  const CHANNEL_W = 240
  const HOUR_W = 200
  // Calculate rows needed to fill the viewport. Falls back to a generous
  // default for hidden/zero-height containers (initial paint, TV).
  const viewportH =
    typeof window !== "undefined" ? window.innerHeight || 720 : 720
  const targetH = Math.max(target.clientHeight || 0, viewportH * 0.85)
  const ROWS = Math.max(12, Math.ceil(targetH / ROW_H) + 4)

  // Repeatable but uneven programme widths so the grid breathes.
  const PROGRAMME_PATTERNS = [
    [180, 240, 320, 280, 220],
    [120, 360, 200, 280, 240],
    [220, 180, 300, 240, 260],
    [400, 200, 180, 320, 100],
    [240, 220, 160, 380, 200],
    [160, 280, 220, 240, 300],
    [320, 200, 280, 180, 220],
    [200, 240, 300, 160, 300],
    [180, 220, 260, 320, 220],
    [240, 180, 220, 280, 280],
  ]

  const root = document.createElement("div")
  root.className = "epg-sk"
  root.setAttribute("aria-busy", "true")
  root.setAttribute("aria-label", label)

  // Status chip (top-right). Breathing dots, no spinner.
  const chip = document.createElement("div")
  chip.className = "epg-sk-chip"
  chip.innerHTML =
    `<span class="epg-sk-chip-dots" aria-hidden="true"><span></span><span></span><span></span></span>` +
    `<span>${label}</span>`
  root.appendChild(chip)

  // Time header strip - matches the real grid's tick rhythm.
  const header = document.createElement("div")
  header.className = "epg-sk-head"
  header.style.setProperty("--ch", `${CHANNEL_W}px`)
  header.style.setProperty("--h", `${HEADER_H}px`)
  const headerTrack = document.createElement("div")
  headerTrack.className = "epg-sk-head-track"
  headerTrack.style.width = `${HOURS * HOUR_W}px`
  for (let i = 0; i <= HOURS * 2; i++) {
    const tick = document.createElement("span")
    tick.className = i % 2 === 0 ? "epg-sk-tick epg-sk-tick--hour" : "epg-sk-tick"
    tick.style.left = `${i * (HOUR_W / 2)}px`
    headerTrack.appendChild(tick)
    if (i % 2 === 0 && i < HOURS * 2) {
      const lbl = document.createElement("span")
      lbl.className = "skel epg-sk-tick-label"
      lbl.style.left = `${i * (HOUR_W / 2) + 8}px`
      headerTrack.appendChild(lbl)
    }
  }
  header.appendChild(headerTrack)
  root.appendChild(header)

  // Body rows - structural mirror of the real grid.
  const body = document.createElement("div")
  body.className = "epg-sk-body"
  body.style.setProperty("--row", `${ROW_H}px`)
  body.style.setProperty("--ch", `${CHANNEL_W}px`)
  for (let r = 0; r < ROWS; r++) {
    const row = document.createElement("div")
    row.className = "epg-sk-row"
    row.style.setProperty("--delay", `${r * 60}ms`)
    // Wave shimmer travels diagonally down + right across the grid.
    const rowWave = (r * 130) % 1600

    const info = document.createElement("div")
    info.className = "epg-sk-info"
    const logo = document.createElement("div")
    logo.className = "skel epg-sk-logo"
    logo.style.setProperty("--skel-delay", `${rowWave}ms`)
    info.appendChild(logo)
    const meta = document.createElement("div")
    meta.className = "epg-sk-meta"
    const name = document.createElement("div")
    name.className = "skel epg-sk-line"
    name.style.width = `${56 + ((r * 9) % 30)}%`
    name.style.setProperty("--skel-delay", `${rowWave + 80}ms`)
    const sub = document.createElement("div")
    sub.className = "skel epg-sk-line epg-sk-line--sub"
    sub.style.width = `${28 + ((r * 7) % 24)}%`
    sub.style.setProperty("--skel-delay", `${rowWave + 160}ms`)
    meta.append(name, sub)
    info.appendChild(meta)
    row.appendChild(info)

    const track = document.createElement("div")
    track.className = "epg-sk-track"
    track.style.width = `${HOURS * HOUR_W}px`
    let cursor = -((r * 47) % 80) // small negative offset so blocks don't all align
    const widths = PROGRAMME_PATTERNS[r % PROGRAMME_PATTERNS.length]
    let cellIdx = 0
    for (const w of widths) {
      const cell = document.createElement("div")
      cell.className = "skel epg-sk-cell"
      cell.style.left = `${Math.max(0, cursor)}px`
      const visW = Math.min(w, HOURS * HOUR_W - Math.max(0, cursor))
      if (visW <= 24) break
      cell.style.width = `${visW}px`
      // Each cell trails the row's lead by ~120ms
      cell.style.setProperty("--skel-delay", `${(rowWave + 240 + cellIdx * 120) % 1600}ms`)
      track.appendChild(cell)
      cursor += w + 4
      cellIdx++
      if (cursor >= HOURS * HOUR_W) break
    }
    row.appendChild(track)
    body.appendChild(row)
  }
  root.appendChild(body)

  // Now-line accent - quiet fuchsia hint about a third in.
  const now = document.createElement("div")
  now.className = "epg-sk-now"
  now.style.left = `${CHANNEL_W + HOUR_W * 1.8}px`
  root.appendChild(now)

  target.replaceChildren(root)
}

function showProviderError(kind) {
  if (statusEl) {
    statusEl.classList.remove("hidden", "epg-status-skeleton", "epg-status-text")
    statusEl.textContent = ""
    renderProviderError(statusEl, {
      providerName: activePlaylistTitle,
      kind,
      onRetry: () => init(),
    })
  }
  if (gridEl) gridEl.classList.add("hidden")
}

function hideStatus() {
  if (statusEl) {
    statusEl.classList.add("hidden")
    statusEl.classList.remove("epg-status-skeleton", "epg-status-text")
    statusEl.textContent = ""
  }
  if (gridEl) gridEl.classList.remove("hidden")
}

// ----------------------------
// Render
// ----------------------------
function roundHalfHourFloor(ts) {
  const half = 30 * 60 * 1000
  return Math.floor(ts / half) * half
}

function fmtTime(ts) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts))
}

function timeToX(ts) {
  return ((ts - viewStart) / (60 * 60 * 1000)) * PX_PER_HOUR
}

function renderTimeHeader() {
  if (!headerInner) return
  headerInner.replaceChildren()
  headerInner.style.width = `${HOURS_VISIBLE * PX_PER_HOUR}px`

  // Half-hour ticks across the visible window.
  for (let i = 0; i <= HOURS_VISIBLE * 2; i++) {
    const ts = viewStart + i * 30 * 60 * 1000
    const tick = document.createElement("div")
    const isHour = i % 2 === 0
    tick.className =
      "absolute top-0 bottom-0 flex items-end pb-1 select-none " +
      (isHour
        ? "border-l border-line text-fg-2 text-xs tabular-nums px-1.5 font-medium"
        : "border-l border-line/40 text-fg-3 text-2xs tabular-nums px-1.5")
    tick.style.left = `${(i * 30 * PX_PER_HOUR) / 60}px`
    tick.textContent = fmtTime(ts)
    headerInner.appendChild(tick)
  }
}

function renderChannelRow(channel, programmesForRow) {
  const row = document.createElement("div")
  row.className = "epg-row flex items-stretch border-b border-line"
  row.style.height = `${ROW_HEIGHT}px`

  // Sticky channel info column.
  const info = document.createElement("div")
  info.className =
    "shrink-0 sticky left-0 z-10 bg-bg flex items-center gap-2 px-3 border-r border-line"
  info.style.width = `${CHANNEL_COL_WIDTH}px`

  const logo = document.createElement("div")
  logo.className =
    "h-9 w-9 shrink-0 rounded-md overflow-hidden ring-1 ring-inset ring-line logo-skel"
  if (channel.logo) {
    const img = document.createElement("img")
    img.src = channel.logo
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    ;(img as any).fetchPriority = "low"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-contain"
    img.onload = () => logo.setAttribute("data-loaded", "true")
    img.onerror = () => {
      img.remove()
      logo.setAttribute("data-loaded", "true")
    }
    if (img.complete && img.naturalWidth > 0) {
      logo.setAttribute("data-loaded", "true")
    }
    logo.appendChild(img)
  } else {
    logo.setAttribute("data-loaded", "true")
  }
  info.appendChild(logo)

  const nameWrap = document.createElement("div")
  nameWrap.className = "min-w-0 flex-1"
  const nameEl = document.createElement("div")
  nameEl.className = "truncate text-sm font-medium text-fg"
  nameEl.textContent = channel.name
  const sub = document.createElement("div")
  sub.className = "truncate text-2xs text-fg-3 tabular-nums"
  sub.textContent = channel.tvgId || ""
  nameWrap.append(nameEl, sub)
  info.appendChild(nameWrap)

  row.appendChild(info)

  // Programme track - relative-positioned host for absolute cells.
  const track = document.createElement("div")
  track.className = "epg-track relative shrink-0"
  track.style.width = `${HOURS_VISIBLE * PX_PER_HOUR}px`

  // Background grid (half-hour stripes) for visual rhythm.
  for (let i = 1; i <= HOURS_VISIBLE * 2; i++) {
    const line = document.createElement("div")
    line.className =
      "absolute top-0 bottom-0 w-px " +
      (i % 2 === 0 ? "bg-line" : "bg-line/40")
    line.style.left = `${(i * 30 * PX_PER_HOUR) / 60}px`
    track.appendChild(line)
  }

  const visEnd = viewStart + HOURS_VISIBLE * 60 * 60 * 1000

  for (const p of programmesForRow) {
    if (p.stop <= viewStart || p.start >= visEnd) continue
    const left = Math.max(0, timeToX(p.start))
    const right = Math.min(timeToX(p.stop), HOURS_VISIBLE * PX_PER_HOUR)
    const width = Math.max(2, right - left)
    const isLive = p.start <= Date.now() && p.stop > Date.now()

    const cell = document.createElement("button")
    cell.type = "button"
    cell.className =
      "epg-cell absolute top-1 bottom-1 rounded-lg px-2 py-1 text-left outline-none " +
      "border transition-[background-color,color,border-color,transform] duration-150 ease-out overflow-hidden " +
      "active:scale-[0.97] " +
      (isLive
        ? "border-accent bg-accent-soft text-fg hover:bg-accent/20 focus-visible:bg-accent/20"
        : "border-line bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg") +
      " focus-visible:ring-2 focus-visible:ring-accent"
    cell.style.left = `${left}px`
    cell.style.width = `${width}px`
    cell.title = `${fmtTime(p.start)}–${fmtTime(p.stop)} · ${p.title}${p.desc ? "\n\n" + p.desc : ""}`
    cell.addEventListener("click", () => {
      openProgrammeDialog({
        title: p.title,
        desc: p.desc,
        start: p.start,
        stop: p.stop,
        channelName: channel.name,
        channelId: channel.id,
      })
    })

    const titleLine = document.createElement("div")
    titleLine.className = "truncate text-xs font-medium"
    titleLine.textContent = p.title
    const timeLine = document.createElement("div")
    timeLine.className = "truncate text-2xs text-fg-3 tabular-nums"
    timeLine.textContent = `${fmtTime(p.start)}–${fmtTime(p.stop)}`
    cell.append(titleLine, timeLine)

    track.appendChild(cell)
  }

  row.appendChild(track)
  return row
}

function renderNowLine() {
  if (!bodyEl) return
  // Remove old indicator if any.
  bodyEl.querySelector("[data-now-line]")?.remove()
  const x = timeToX(Date.now())
  if (x < 0 || x > HOURS_VISIBLE * PX_PER_HOUR) return
  const line = document.createElement("div")
  line.dataset.nowLine = ""
  line.className =
    "epg-now-line absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-20"
  line.style.left = `${CHANNEL_COL_WIDTH + x}px`
  bodyEl.appendChild(line)
}

function render() {
  if (!gridEl || !bodyEl || !headerInner) return
  hideStatus()

  // Width of the grid content (channel col + visible time)
  const totalWidth = CHANNEL_COL_WIDTH + HOURS_VISIBLE * PX_PER_HOUR
  // Apply width to the inner sliding rail in case CSS hasn't.
  bodyEl.style.minWidth = `${totalWidth}px`
  headerInner.parentElement.style.minWidth = `${totalWidth}px`

  renderTimeHeader()

  const frag = document.createDocumentFragment()
  for (const ch of channels) {
    const key = (ch.tvgId || "").toLowerCase()
    const list = key ? programmes.get(key) || [] : []
    frag.appendChild(renderChannelRow(ch, list))
  }
  bodyEl.replaceChildren(frag)
  renderNowLine()

  if (channels.length === MAX_CHANNELS) {
    const tail = document.createElement("div")
    tail.className = "p-3 text-fg-3 text-xs text-center"
    tail.textContent = t("epg.showingFirst", { n: MAX_CHANNELS })
    bodyEl.appendChild(tail)
  }

  try {
    window.SpatialNavigation?.makeFocusable?.()
  } catch {}
}

// ----------------------------
// Loaders
// ----------------------------
function pickChannels(cachedChannels) {
  let filtered
  if (activeCat === CAT_FAVORITES && activePlaylistId) {
    const favs = getFavorites(activePlaylistId, "live")
    filtered = cachedChannels.filter((channel) => favs.has(channel.id))
  } else if (activeCat === CAT_RECENTS && activePlaylistId) {
    const byId = new Map(cachedChannels.map((channel) => [channel.id, channel]))
    const recents = getRecents(activePlaylistId, "live")
    filtered = []
    for (const recent of recents) {
      const channel = byId.get(recent.id)
      if (channel) filtered.push(channel)
    }
  } else if (activeCat) {
    filtered = cachedChannels.filter((channel) => (channel.category || "") === activeCat)
  } else {
    filtered = cachedChannels.slice()
  }
  // Drop channels with no tvg-id - they have no EPG match in XMLTV anyway.
  const withEpg = filtered.filter((channel) => channel.tvgId)
  return withEpg.slice(0, MAX_CHANNELS)
}

async function fetchXtreamChannels() {
  // Categories first so we can resolve `category_id → name` for streams.
  const catRes = await providerFetch(buildApiUrl(creds, "get_live_categories"))
  if (!catRes.ok) throw new Error(`HTTP ${catRes.status}`)
  const catData = await catRes.json().catch(() => [])
  const catArr = Array.isArray(catData)
    ? catData
    : Array.isArray(catData?.categories)
    ? catData.categories
    : []
  const catMap = new Map(
    catArr
      .filter((c) => c && c.category_id != null)
      .map((c) => [
        String(c.category_id),
        String(c.category_name || "").trim(),
      ])
  )

  const r = await providerFetch(buildApiUrl(creds, "get_live_streams"))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json().catch(() => [])
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.streams)
    ? data.streams
    : []
  return arr
    .map((ch) => {
      const ids =
        (Array.isArray(ch.category_ids) &&
          ch.category_ids.length &&
          ch.category_ids) ||
        (ch.category_id != null ? [ch.category_id] : [])
      let category = String(ch.category_name || "").trim()
      if (!category && ids.length && catMap.size) {
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
        name: String(ch.name || ""),
        category,
        logo: ch.stream_icon || null,
        tvgId: String(ch.epg_channel_id || "") || undefined,
      }
    })
    .filter((x) => x.id && x.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    )
}

// ----------------------------
// Category picker
// ----------------------------
function syncCategoryUI() {
  const display =
    activeCat === "__favorites__"
      ? t("list.specialFavorites")
      : activeCat === "__recents__"
        ? t("list.specialRecents")
        : activeCat
  if (titleEl) {
    titleEl.textContent = display
      ? t("epg.subtitleWith", { category: display })
      : t("epg.subtitleAll")
  }
  if (categoryLabelEl) {
    categoryLabelEl.textContent = display || t("list.allCategories")
  }
  if (categoryListEl) {
    for (const el of categoryListEl.querySelectorAll('button[role="option"]')) {
      el.classList.toggle("bg-surface-2", (el.dataset.val || "") === activeCat)
    }
  }
}

function setActiveCat(next) {
  const cleaned = next || ""
  if (cleaned === activeCat) {
    syncCategoryUI()
    return
  }
  activeCat = cleaned
  try {
    if (activeCat) localStorage.setItem("xt_active_cat", activeCat)
    else localStorage.removeItem("xt_active_cat")
  } catch {}
  syncCategoryUI()
  document.dispatchEvent(
    new CustomEvent("xt:cat-changed", { detail: activeCat })
  )
  applyCategory()
}

function applyCategory() {
  if (!allChannels.length) return
  channels = pickChannels(allChannels)
  if (!channels.length) {
    if (activeCat === CAT_FAVORITES) {
      showStatus(t("epg.noFavoritesEpg"))
    } else if (activeCat === CAT_RECENTS) {
      showStatus(t("epg.noRecentsEpg"))
    } else {
      showStatus(t("epg.noCategoryEpg"))
    }
    return
  }
  if (!programmes.size) {
    showStatus(
      "EPG loaded, but no programmes matched any channel id. Provider might use different `tvg-id`s than the playlist."
    )
    return
  }
  render()
}

function renderCategoryPicker(items) {
  if (!categoryListEl) return
  const counts = new Map()
  for (const channel of items) {
    if (!channel.tvgId) continue
    const key = (channel.category || "").trim() || t("list.uncategorized")
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const names = Array.from(counts.keys()).sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base" })
  )
  const frag = document.createDocumentFragment()

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
    right.className =
      "category-count ml-3 shrink-0 text-xs text-fg-3 tabular-nums"
    right.textContent = count != null ? String(count) : ""
    btn.append(left, right)
    btn.addEventListener("click", () => setActiveCat(val))
    frag.appendChild(btn)
    return btn
  }

  // Favorites + Recents pseudo-rows. Only counted against channels that have a
  // tvg-id, since the EPG grid drops the rest anyway.
  const favSet = activePlaylistId
    ? getFavorites(activePlaylistId, "live")
    : new Set()
  const recents = activePlaylistId
    ? getRecents(activePlaylistId, "live")
    : []
  const favEpgCount = items.reduce(
    (acc, channel) =>
      channel.tvgId && favSet.has(channel.id) ? acc + 1 : acc,
    0
  )
  const recentIds = new Set(recents.map((entry) => entry.id))
  const recEpgCount = items.reduce(
    (acc, channel) =>
      channel.tvgId && recentIds.has(channel.id) ? acc + 1 : acc,
    0
  )
  const favRow = addRow(CAT_FAVORITES, "★ Favorites", favEpgCount, "text-accent")
  if (favEpgCount === 0) favRow.style.display = "none"
  const recRow = addRow(CAT_RECENTS, "🕒 Recently watched", recEpgCount)
  if (recEpgCount === 0) recRow.style.display = "none"

  addRow("", t("list.allCategories"))
  for (const name of names) addRow(name, name, counts.get(name))

  categoryListEl.replaceChildren(frag)
  if (categoryListStatus) {
    categoryListStatus.textContent = `${names.length.toLocaleString()} categories`
  }
  syncCategoryUI()
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

async function init() {
  // Wait for the locale JSON to resolve before any t() call so the page
  // never flashes an English string that gets replaced 100ms later.
  await initI18n()
  showLoadingSkeleton(t("epg.loadingSkeleton"))

  creds = await loadCreds()
  if (!creds.host) {
    showStatus(t("epg.noPlaylistSelected"))
    return
  }

  const active = await getActiveEntry()
  if (!active) {
    showStatus(t("epg.noPlaylistSelected"))
    return
  }
  activePlaylistId = active._id
  activePlaylistTitle = active.title || ""
  await ensurePrefsLoaded()
  try {
    activeCat = localStorage.getItem("xt_active_cat") || ""
  } catch {
    activeCat = ""
  }
  syncCategoryUI()

  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  let cached =
    getCached(activePlaylistId, isM3U ? "m3u" : "live")?.data || null

  if (!cached?.length) {
    if (isM3U) {
      showStatus(
        t("epg.openLivetvFirst")
      )
      return
    }
    showLoadingSkeleton(t("epg.loadingChannels"))
    try {
      cached = await fetchXtreamChannels()
    } catch (e) {
      log.error("[epg] channel re-fetch failed:", e)
      showProviderError("channels")
      return
    }
  }

  allChannels = cached
  renderCategoryPicker(allChannels)

  channels = pickChannels(cached)
  if (!channels.length) {
    if (activeCat === CAT_FAVORITES) {
      showStatus(
        "No favorite channels with EPG ids (`tvg-id`). Star a channel on Live TV first."
      )
    } else if (activeCat === CAT_RECENTS) {
      showStatus(
        "No recently watched channels with EPG ids (`tvg-id`). Play one on Live TV first."
      )
    } else {
      showStatus(
        "No channels in this category have EPG ids (`tvg-id`). Try a different category."
      )
    }
    return
  }

  viewStart = Math.max(
    roundHalfHourFloor(Date.now() - 30 * 60 * 1000),
    roundHalfHourFloor(Date.now())
  )

  viewStart = roundHalfHourFloor(Date.now() - 30 * 60 * 1000)

  showLoadingSkeleton(t("epg.loadingFull"))

  programmes.clear()
  try {
    const state = await loadProgrammes(activePlaylistId, creds, { force: true })
    if (!state) throw new Error("EPG fetch failed")
    for (const [k, v] of state.programmes) programmes.set(k, v)
  } catch (e) {
    log.error("[epg] load failed:", e)
    showProviderError("EPG")
    return
  }

  if (!programmes.size) {
    showStatus(
      "EPG loaded, but no programmes matched any channel id. Provider might use different `tvg-id`s than the playlist."
    )
    return
  }

  render()
}

refreshBtn?.addEventListener("click", () => {
  if (activePlaylistId) invalidateEpgPlaylist(activePlaylistId)
  programmes.clear()
  init()
})

nowBtn?.addEventListener("click", () => {
  if (!gridEl) return
  viewStart = roundHalfHourFloor(Date.now() - 30 * 60 * 1000)
  if (programmes.size && channels.length) render()
  // Centre the now-line about a third in from the left of the visible width.
  const visible = gridEl.clientWidth || 0
  const target = Math.max(
    0,
    CHANNEL_COL_WIDTH + timeToX(Date.now()) - Math.max(120, visible / 3)
  )
  try {
    gridEl.scrollTo({ left: target, behavior: "smooth" })
  } catch {
    gridEl.scrollLeft = target
  }
})

document.addEventListener(EPG_OFFSET_EVENT, (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  programmes.clear()
  init()
})

setInterval(() => {
  if (programmes.size && channels.length) renderNowLine()
}, 60 * 1000)

document.addEventListener("xt:active-changed", () => {
  programmes.clear()
  allChannels = []
  init()
})

document.addEventListener("xt:cat-changed", (e) => {
  const next = /** @type {CustomEvent} */ (e).detail || ""
  if (next === activeCat) return
  activeCat = next
  syncCategoryUI()
  applyCategory()
})

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (allChannels.length) renderCategoryPicker(allChannels)
  if (activeCat === CAT_FAVORITES) applyCategory()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (allChannels.length) renderCategoryPicker(allChannels)
  if (activeCat === CAT_RECENTS) applyCategory()
})

categoryDialog?.addEventListener("close", () => {
  if (categorySearchEl) {
    categorySearchEl.value = ""
    filterCategories()
  }
})

init()
