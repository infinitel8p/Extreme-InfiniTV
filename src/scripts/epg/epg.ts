// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// EPG schedule grid view.
import { log } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
  isLikelyM3USource,
  safeHttpUrl,
} from "@/scripts/lib/creds.js"
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import { t, initI18n, getActiveLocale } from "@/scripts/lib/i18n.js"
import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import {
  loadProgrammes,
  invalidateEpgPlaylist,
  effectiveTvgId,
  getAvailableEpgChannels,
  displayedToUtcMs,
  shiftChannelProgrammes,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"
import { openProgrammeDialog } from "@/scripts/lib/programme-dialog.js"
import { channelSupportsCatchup, isCatchupPlayable } from "@/scripts/lib/catchup.ts"
import {
  ensureLoaded as ensurePrefsLoaded,
  getFavorites,
  getRecents,
  getChannelEpgOverride,
  setChannelEpgOverride,
  clearChannelEpgOverride,
  getViewSort,
  CHANNEL_EPG_CHANGED_EVENT,
} from "@/scripts/lib/preferences.js"
import { sortChannelsForView } from "@/scripts/lib/channel-sort.ts"
import { mountCategoryPicker } from "@/scripts/lib/category-picker.ts"
import { requestLogoFallback } from "@/scripts/lib/logo-fallback.ts"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { getDensityFactor } from "@/scripts/lib/app-settings.js"

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const PX_PER_HOUR = 200
const HOURS_VISIBLE = 6
const ROW_HEIGHT = Math.max(44, Math.round(64 * getDensityFactor()))
const CHANNEL_COL_WIDTH = 240
const MAX_CHANNELS = 150
const DAY_MS = 24 * 60 * 60 * 1000
const CATCHUP_LOOKBACK_DAYS = 7

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
const prevDayBtn = document.getElementById("epg-prev-day")
const nextDayBtn = document.getElementById("epg-next-day")
const dayLabelEl = document.getElementById("epg-day-label")

// ----------------------------
// State
// ----------------------------
/** @type {{host:string,port:string,user:string,pass:string}} */
let creds = { host: "", port: "", user: "", pass: "" }
let activePlaylistId = ""
let activePlaylistTitle = ""
/** @type {Array<{id:number,name:string,logo?:string|null,tvgId?:string,category?:string}>} */
let channels = []
/** @type {Array<{id:number,name:string,logo?:string|null,tvgId?:string,category?:string}>} */
let allChannels = []
/** @type {Map<string, Array<{start:number,stop:number,title:string,desc:string}>>} channel id (tvg-id, lower-cased) → sorted programmes */
const programmes = new Map()
let viewStart = 0

const picker = mountCategoryPicker({
  kind: "epg",
  idPrefix: "epg-category-picker",
  activeCatStorageKey: "xt_epg_active_cat",
  activeCatChangedEvent: "xt:epg-cat-changed",
  getActivePlaylistId: () => activePlaylistId,
  // pickChannels filters allChannels (live-channel shape), so the picker
  // counts every entry — not just ones with a tvg-id. The schedule grid
  // continues to drop tvg-id-less rows downstream.
  getItems: () => allChannels,
})

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
  const ROW_H = Math.max(44, Math.round(64 * getDensityFactor()))
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

function startOfHour(ts) {
  const hour = 60 * 60 * 1000
  return Math.floor(ts / hour) * hour
}

// Bounds match the catch-up window: up to 7 days back, up to 12h of upcoming
// schedule ahead of now.
function clampViewStart(ts) {
  const now = Date.now()
  const min = startOfHour(now - CATCHUP_LOOKBACK_DAYS * DAY_MS)
  const max = now + 12 * 60 * 60 * 1000
  return Math.max(min, Math.min(max, ts))
}

function isViewingToday() {
  const now = new Date()
  const viewed = new Date(viewStart)
  return (
    now.getFullYear() === viewed.getFullYear() &&
    now.getMonth() === viewed.getMonth() &&
    now.getDate() === viewed.getDate()
  )
}

function updateDayLabel() {
  if (!dayLabelEl) return
  dayLabelEl.textContent = isViewingToday()
    ? t("epg.today")
    : new Intl.DateTimeFormat(getActiveLocale(), {
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(new Date(viewStart))
}

function navigateToCatchup(channelId, startDisplayMs, stopDisplayMs, title, catchupId) {
  const startUtc = displayedToUtcMs(activePlaylistId, startDisplayMs)
  const stopUtc = displayedToUtcMs(activePlaylistId, stopDisplayMs)
  window.location.href =
    `/livetv?channel=${encodeURIComponent(String(channelId))}` +
    `&cstart=${startUtc}` +
    `&cstop=${stopUtc}` +
    `&ctitle=${encodeURIComponent(title || "")}` +
    (catchupId ? `&cid=${encodeURIComponent(catchupId)}` : "")
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
  const safeLogo = channel.logo ? safeHttpUrl(channel.logo) : null
  if (safeLogo) {
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    ;(img as any).fetchPriority = "low"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-contain"
    // Provider logo requests can hang without firing onerror (Tauri WebView); force the fallback after a grace period.
    const slowLogoTimer = setTimeout(() => {
      img.remove()
      logo.setAttribute("data-loaded", "true")
      requestLogoFallback(logo, channel)
    }, 8000)
    ;(img as HTMLImageElement & { logoFallbackTimer?: ReturnType<typeof setTimeout> }).logoFallbackTimer = slowLogoTimer
    img.onload = () => {
      clearTimeout(slowLogoTimer)
      logo.setAttribute("data-loaded", "true")
    }
    img.onerror = () => {
      clearTimeout(slowLogoTimer)
      img.remove()
      logo.setAttribute("data-loaded", "true")
      requestLogoFallback(logo, channel)
    }
    logo.appendChild(img)
    mountCachedImage(img, safeLogo, "logo")
  } else {
    logo.setAttribute("data-loaded", "true")
    requestLogoFallback(logo, channel)
  }
  info.appendChild(logo)

  const nameWrap = document.createElement("div")
  nameWrap.className = "min-w-0 flex-1"
  const nameEl = document.createElement("div")
  nameEl.className = "truncate text-sm font-medium text-fg"
  nameEl.textContent = channel.name
  const sub = document.createElement("div")
  sub.className = "truncate text-2xs text-fg-3 tabular-nums"
  const resolved = effectiveTvgId(channel, activePlaylistId)
  const isOverridden = !!(
    activePlaylistId &&
    getChannelEpgOverride(activePlaylistId, channel.id)
  )
  if (isOverridden) {
    sub.classList.add("text-accent")
    sub.textContent = `↪ ${resolved}`
  } else {
    sub.textContent = resolved || channel.tvgId || ""
  }
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

  const nowMs = Date.now()
  const canChannelCatchup = channelSupportsCatchup(channel)

  for (const p of programmesForRow) {
    if (p.stop <= viewStart || p.start >= visEnd) continue
    const left = Math.max(0, timeToX(p.start))
    const right = Math.min(timeToX(p.stop), HOURS_VISIBLE * PX_PER_HOUR)
    const width = Math.max(2, right - left)
    const isLive = p.start <= nowMs && p.stop > nowMs
    const isPast = p.stop <= nowMs
    // rawStart/rawStop recover true XMLTV time so catch-up never sees the guide-display tvg-shift.
    const rawStart = p.rawStart ?? p.start
    const rawStop = p.rawStop ?? p.stop
    const canReplay = isPast && canChannelCatchup && isCatchupPlayable(channel, rawStart, nowMs)

    const cell = document.createElement("button")
    cell.type = "button"
    cell.className =
      "epg-cell absolute top-1 bottom-1 rounded-lg px-2 py-1 text-left outline-none " +
      "border transition-[background-color,color,border-color,transform] duration-150 ease-out overflow-hidden " +
      "active:scale-[0.97] " +
      (isLive
        ? "border-accent bg-accent-soft text-fg hover:bg-accent/20 focus-visible:bg-accent/20"
        : canReplay
        ? "epg-cell-replay border-line bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg"
        : isPast
        ? "epg-cell-past border-line bg-surface text-fg-3 hover:bg-surface-2 hover:text-fg-2 focus-visible:bg-surface-2 focus-visible:text-fg-2"
        : "border-line bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg") +
      " focus-visible:ring-1 focus-visible:ring-accent"
    cell.style.left = `${left}px`
    cell.style.width = `${width}px`
    cell.title = `${fmtTime(p.start)}–${fmtTime(p.stop)} · ${p.title}${p.desc ? "\n\n" + p.desc : ""}`
    cell.addEventListener("click", () => {
      const dialogOpts = {
        title: p.title,
        desc: p.desc,
        start: p.start,
        stop: p.stop,
        channelName: channel.name,
        channelId: channel.id,
      }
      if (canReplay) {
        dialogOpts.onCatchup = () =>
          navigateToCatchup(channel.id, rawStart, rawStop, p.title, p.catchupId)
      } else if (isLive && canChannelCatchup && isCatchupPlayable(channel, rawStart, nowMs)) {
        dialogOpts.onWatchFromStart = () =>
          navigateToCatchup(channel.id, rawStart, rawStop, p.title, p.catchupId)
      }
      openProgrammeDialog(dialogOpts)
    })

    const titleLine = document.createElement("div")
    titleLine.className = "truncate text-xs font-medium"
    if (canReplay) {
      const replayDot = document.createElement("span")
      replayDot.className = "epg-cell-replay-dot"
      replayDot.title = t("catchup.badge")
      titleLine.appendChild(replayDot)
      titleLine.appendChild(document.createTextNode(p.title))
    } else {
      titleLine.textContent = p.title
    }
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

// ----------------------------
// Row virtualization
// ----------------------------
const OVERSCAN_ROWS = 4

function clearRowLogoFallbackTimer(row: HTMLElement) {
  const img = row.querySelector("img") as (HTMLImageElement & { logoFallbackTimer?: ReturnType<typeof setTimeout> }) | null
  if (img?.logoFallbackTimer) clearTimeout(img.logoFallbackTimer)
}

/** @type {Map<number, HTMLElement>} */
const renderedRows = new Map()
let virtualizedRangeStart = -1
let virtualizedRangeEnd = -1
let virtualScrollAttached = false
let virtualScrollPending = false

function renderVirtualWindow() {
  if (!gridEl || !bodyEl) return
  const total = channels.length
  if (!total) return

  const scrollTop = gridEl.scrollTop || 0
  const viewportH = gridEl.clientHeight || 0
  const startIdx = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS
  )
  const endIdx = Math.min(
    total,
    Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN_ROWS
  )

  if (
    startIdx === virtualizedRangeStart &&
    endIdx === virtualizedRangeEnd
  ) {
    return
  }

  for (const [idx, row] of renderedRows) {
    if (idx < startIdx || idx >= endIdx) {
      clearRowLogoFallbackTimer(row)
      row.remove()
      renderedRows.delete(idx)
    }
  }

  let added = false
  for (let idx = startIdx; idx < endIdx; idx++) {
    if (renderedRows.has(idx)) continue
    const channel = channels[idx]
    const key = effectiveTvgId(channel, activePlaylistId)
    // shiftChannelProgrammes stashes rawStart/rawStop so catch-up navigation can bypass tvg-shift.
    const list = key ? shiftChannelProgrammes(programmes.get(key) || [], channel.tvgShift) : []
    const row = renderChannelRow(channel, list)
    row.style.position = "absolute"
    row.style.top = `${idx * ROW_HEIGHT}px`
    row.style.left = "0"
    row.style.right = "0"
    row.dataset.rowIdx = String(idx)
    for (const cell of row.querySelectorAll(".epg-cell")) {
      ;(cell as HTMLElement).dataset.rowIdx = String(idx)
    }
    bodyEl.appendChild(row)
    renderedRows.set(idx, row)
    added = true
  }

  virtualizedRangeStart = startIdx
  virtualizedRangeEnd = endIdx

  if (added) {
    try {
      window.SpatialNavigation?.makeFocusable?.()
    } catch {}
  }
}

function onVirtualScroll() {
  if (virtualScrollPending) return
  virtualScrollPending = true
  requestAnimationFrame(() => {
    virtualScrollPending = false
    renderVirtualWindow()
  })
}

function attachVirtualScrollListener() {
  if (virtualScrollAttached || !gridEl) return
  gridEl.addEventListener("scroll", onVirtualScroll, { passive: true })
  virtualScrollAttached = true
}

// Vertical D-pad past the rendered window. Spatial-nav can't find rows
// that aren't mounted (only ±OVERSCAN_ROWS are present), so Up/Down at the
// edge dead-ends and PgUp/PgDn/Home/End don't move at all. Mirrors the
// /livetv channel-list handler in stream.ts.
function focusCellInRow(rowIdx, anchorX) {
  const row = renderedRows.get(rowIdx)
  if (!row) return false
  const cells = Array.from(row.querySelectorAll(".epg-cell")) as HTMLElement[]
  if (!cells.length) return false
  let pick = cells[0]
  if (Number.isFinite(anchorX)) {
    let bestDist = Infinity
    for (const cell of cells) {
      const left = cell.offsetLeft
      const right = left + cell.offsetWidth
      const dist =
        anchorX < left
          ? left - anchorX
          : anchorX > right
          ? anchorX - right
          : 0
      if (dist < bestDist) {
        bestDist = dist
        pick = cell
      }
    }
  }
  pick.focus({ preventScroll: true })
  return true
}

function ensureRowVisible(rowIdx) {
  if (!gridEl) return
  const top = rowIdx * ROW_HEIGHT
  const visTop = gridEl.scrollTop
  const visBottom = visTop + gridEl.clientHeight
  if (top < visTop) {
    gridEl.scrollTop = Math.max(0, top - ROW_HEIGHT * 2)
  } else if (top + ROW_HEIGHT > visBottom) {
    gridEl.scrollTop = top + ROW_HEIGHT - gridEl.clientHeight + ROW_HEIGHT * 2
  }
}

gridEl?.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "PageDown" &&
      event.key !== "PageUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const focused = document.activeElement as HTMLElement | null
    const cell = focused?.closest?.(".epg-cell") as HTMLElement | null
    if (!cell) return
    const fromIdx = Number(cell.dataset.rowIdx)
    if (!Number.isFinite(fromIdx)) return
    const total = channels.length
    if (!total) return
    const pageRows = Math.max(
      1,
      Math.floor((gridEl?.clientHeight || ROW_HEIGHT) / ROW_HEIGHT) - 1
    )
    let next = fromIdx
    switch (event.key) {
      case "ArrowDown":
        next = fromIdx + 1
        break
      case "ArrowUp":
        next = fromIdx - 1
        break
      case "PageDown":
        next = fromIdx + pageRows
        break
      case "PageUp":
        next = fromIdx - pageRows
        break
      case "Home":
        next = 0
        break
      case "End":
        next = total - 1
        break
    }
    next = Math.max(0, Math.min(total - 1, next))
    if (next === fromIdx) return
    event.preventDefault()
    event.stopPropagation()
    const anchorX = cell.offsetLeft + cell.offsetWidth / 2
    ensureRowVisible(next)
    renderVirtualWindow()
    if (!focusCellInRow(next, anchorX)) {
      requestAnimationFrame(() => {
        renderVirtualWindow()
        focusCellInRow(next, anchorX)
      })
    }
  },
  true
)

function render() {
  if (!gridEl || !bodyEl || !headerInner) return
  hideStatus()

  // Width of the grid content (channel col + visible time)
  const totalWidth = CHANNEL_COL_WIDTH + HOURS_VISIBLE * PX_PER_HOUR
  // Apply width to the inner sliding rail in case CSS hasn't.
  bodyEl.style.minWidth = `${totalWidth}px`
  headerInner.parentElement.style.minWidth = `${totalWidth}px`

  renderTimeHeader()

  // Reset windowed render state
  for (const row of renderedRows.values()) clearRowLogoFallbackTimer(row)
  bodyEl.replaceChildren()
  renderedRows.clear()
  virtualizedRangeStart = -1
  virtualizedRangeEnd = -1

  const tailH = channels.length === MAX_CHANNELS ? 32 : 0
  bodyEl.style.height = `${channels.length * ROW_HEIGHT + tailH}px`

  renderVirtualWindow()
  renderNowLine()

  if (channels.length === MAX_CHANNELS) {
    const tail = document.createElement("div")
    tail.className =
      "p-3 text-fg-3 text-xs text-center absolute left-0 right-0"
    tail.style.top = `${channels.length * ROW_HEIGHT}px`
    tail.textContent = t("epg.showingFirst", { n: MAX_CHANNELS })
    bodyEl.appendChild(tail)
  }

  attachVirtualScrollListener()

  try {
    window.SpatialNavigation?.makeFocusable?.()
  } catch {}
}

// ----------------------------
// Loaders
// ----------------------------
function pickChannels(cachedChannels) {
  const activeCat = picker.getActiveCat()
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
    // Honor the resolved hide / allow filter (issue #62). Sync defaults on
    // so EPG starts out aligned with Live TV's category choices.
    filtered = cachedChannels.filter((channel) =>
      picker.categoryPassesFilter((channel.category || "").toString())
    )
  }
  // Drop channels with no resolvable tvg-id - they have no EPG match. A
  // user-supplied per-channel override (Jellyfin-style) counts as resolvable
  // even when channel.tvgId is empty.
  const withEpg = filtered.filter((channel) =>
    !!effectiveTvgId(channel, activePlaylistId)
  )
  // Mirror Live TV's saved sort
  const sortMode = activePlaylistId
    ? getViewSort(activePlaylistId, "live")
    : "default"
  return sortChannelsForView(withEpg, sortMode).slice(0, MAX_CHANNELS)
}

async function fetchXtreamChannels() {
  // Categories first so we can resolve `category_id → name` for streams.
  const catRes = await xtreamApiFetch("get_live_categories")
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

  const r = await xtreamApiFetch("get_live_streams")
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
        chno: Number(ch.num) || undefined,
        tvArchive: Number(ch.tv_archive) || 0,
        tvArchiveDuration: Number(ch.tv_archive_duration) || 0,
      }
    })
    .filter((x) => x.id && x.name)
}

// ----------------------------
// Category picker
// ----------------------------
function syncCategoryTitle() {
  if (!titleEl) return
  const activeCat = picker.getActiveCat()
  const display =
    activeCat === CAT_FAVORITES
      ? t("list.specialFavorites")
      : activeCat === CAT_RECENTS
        ? t("list.specialRecents")
        : activeCat
  titleEl.textContent = display
    ? t("epg.subtitleWith", { category: display })
    : t("epg.subtitleAll")
}

function applyCategory() {
  if (!allChannels.length) return
  channels = pickChannels(allChannels)
  const activeCat = picker.getActiveCat()
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
    showStatus(t("epg.noProgrammesMatched"))
    return
  }
  render()
}

document.addEventListener("xt:epg-cat-changed", () => {
  syncCategoryTitle()
  applyCategory()
})

const onEpgPrefChange = (event: Event) => {
  const detail = (event as CustomEvent).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  // Picker module already filters internally; we just need to re-pick.
  applyCategory()
}
document.addEventListener("xt:hidden-categories-changed", onEpgPrefChange)
document.addEventListener("xt:allowed-categories-changed", onEpgPrefChange)
document.addEventListener("xt:category-mode-changed", onEpgPrefChange)
document.addEventListener("xt:epg-sync-changed", onEpgPrefChange)
document.addEventListener(CHANNEL_EPG_CHANGED_EVENT, (event) => {
  const detail = (event as CustomEvent).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  applyCategory()
})

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
  syncCategoryTitle()

  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  // Hydrate from IDB before reading
  await hydrateCache(activePlaylistId, isM3U ? "m3u" : "live")
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
  picker.rerender()

  viewStart = roundHalfHourFloor(Date.now() - 30 * 60 * 1000)
  updateDayLabel()
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
    showStatus(t("epg.noProgrammesMatched"))
    return
  }

  channels = pickChannels(cached)
  if (!channels.length) {
    const activeCat = picker.getActiveCat()
    if (activeCat === CAT_FAVORITES) {
      showStatus(t("epg.noFavoritesEpg"))
    } else if (activeCat === CAT_RECENTS) {
      showStatus(t("epg.noRecentsEpg"))
    } else {
      showStatus(t("epg.noChannelsMatchedHint"))
    }
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
  updateDayLabel()
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

prevDayBtn?.addEventListener("click", () => {
  viewStart = clampViewStart(viewStart - DAY_MS)
  updateDayLabel()
  if (programmes.size && channels.length) render()
})

nextDayBtn?.addEventListener("click", () => {
  viewStart = clampViewStart(viewStart + DAY_MS)
  updateDayLabel()
  if (programmes.size && channels.length) render()
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

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (allChannels.length) picker.refreshPseudoRows()
  if (picker.getActiveCat() === CAT_FAVORITES) applyCategory()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (allChannels.length) picker.refreshPseudoRows()
  if (picker.getActiveCat() === CAT_RECENTS) applyCategory()
})

init()
