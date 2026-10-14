// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// EPG schedule grid view.
import { log } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
  getMergedEntries,
  entryToCreds,
  isLikelyM3USource,
  safeHttpUrl,
  MERGED_CHANGED_EVENT,
} from "@/scripts/lib/creds.js"
import {
  rowKey,
  stampRowsWithPlaylist,
  parseMergedCategoryKey,
  mergeOrderedFavorites,
  mergeRecents,
  categoryLabel,
} from "@/scripts/lib/merged-catalog-core.ts"
import {
  getMergedSources,
  hydrateMergedRows,
  readMergedRows,
  ensureMergedRows,
} from "@/scripts/lib/merged-catalog.ts"
import { hasCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
import { channelMatchesCategory, channelPassesCategoryFilter } from "@/scripts/lib/merged-live.ts"
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import { mapXtreamLiveRows, parseCategoriesToMap } from "@/scripts/lib/catalog-mappers.js"
import { t, initI18n, getActiveLocale, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
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
  getFavoritesOrdered,
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
import { createTimeline } from "@/scripts/lib/epg-timeline.ts"

const CAT_FAVORITES = "__favorites__"
const CAT_RECENTS = "__recents__"

const PX_PER_HOUR = 200
const ROW_HEIGHT = Math.max(44, Math.round(64 * getDensityFactor()))
const CHANNEL_COL_WIDTH = 240
const MAX_CHANNELS = 150
const HOUR_MS = 60 * 60 * 1000
const HALF_HOUR_MS = 30 * 60 * 1000
const DAY_APPROX_MS = 24 * HOUR_MS
const CATCHUP_LOOKBACK_DAYS = 7
const SCRUB_HOURS = 3
const TICK_STEP_MINUTES = 30
const FALLBACK_VIEWPORT_WIDTH = 1200

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
const earlierBtn = document.getElementById("epg-earlier")
const laterBtn = document.getElementById("epg-later")
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
let mergedMode = false
let mergedPlaylistIds = []
let titleById = new Map()
/** @type {Array<{id:number,playlistId:string,name:string,logo?:string|null,tvgId?:string,category?:string}>} */
let channels = []
/** @type {Array<{id:number,playlistId:string,name:string,logo?:string|null,tvgId?:string,category?:string}>} */
let allChannels = []
/** @type {Map<string, Map<string, Array<{start:number,stop:number,title:string,desc:string}>>>} playlist id → tvg-id (lower-cased) → sorted programmes */
let programmesByPlaylist = new Map()

const programmesFor = (playlistId) => programmesByPlaylist.get(playlistId)
const programmesSize = () => {
  let total = 0
  for (const map of programmesByPlaylist.values()) total += map.size
  return total
}
const inMergedSet = (playlistId) =>
  !!playlistId && (mergedMode ? mergedPlaylistIds.includes(playlistId) : playlistId === activePlaylistId)
/** @type {ReturnType<typeof createTimeline> | null} */
let timeline = null
/** @type {{fromX:number,toX:number} | null} */
let cellRange = null

const picker = mountCategoryPicker({
  kind: "epg",
  idPrefix: "epg-category-picker",
  activeCatStorageKey: "xt_epg_active_cat",
  activeCatChangedEvent: "xt:epg-cat-changed",
  getActivePlaylistId: () => activePlaylistId,
  getSources: () => getMergedSources(),
  // pickChannels filters allChannels (live-channel shape), so the picker
  // counts every entry — not just ones with a tvg-id. The schedule grid
  // continues to drop tvg-id-less rows downstream.
  getItems: () => allChannels,
  onSyncToggle: () => {
    syncCategoryTitle()
    applyCategory()
  },
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
function startOfDay(ts) {
  const day = new Date(ts)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

// Calendar-day arithmetic (not +/- 86400000ms) so DST-shifted 23h/25h days land right.
function addDays(dayStart, delta) {
  const day = new Date(dayStart)
  day.setDate(day.getDate() + delta)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function buildTimeline() {
  const now = Date.now()
  return createTimeline({
    railStart: addDays(startOfDay(now), -CATCHUP_LOOKBACK_DAYS),
    railEnd: addDays(startOfDay(now + 36 * HOUR_MS), 1),
    pxPerHour: PX_PER_HOUR,
  })
}

function trackViewportWidth() {
  const width = (gridEl?.clientWidth || 0) - CHANNEL_COL_WIDTH
  return width > 0 ? width : FALLBACK_VIEWPORT_WIDTH
}

let shownDayStart = 0

function updateDayLabel() {
  if (!dayLabelEl || !timeline || !gridEl) return
  const dayStart = timeline.dayLabelForScroll(gridEl.scrollLeft)
  if (dayStart === shownDayStart) return
  shownDayStart = dayStart
  const offset = Math.round((dayStart - startOfDay(Date.now())) / DAY_APPROX_MS)
  dayLabelEl.textContent =
    offset === 0
      ? t("epg.today")
      : offset === -1
      ? t("epg.yesterday")
      : offset === 1
      ? t("epg.tomorrow")
      : fmtDayLabel(dayStart)
}

function updateDayNavState() {
  if (!timeline || !gridEl) return
  const maxScroll = timeline.clampScroll(Infinity, trackViewportWidth())
  const atMin = gridEl.scrollLeft <= 0
  const atMax = gridEl.scrollLeft >= maxScroll - 1
  if (prevDayBtn instanceof HTMLButtonElement && prevDayBtn.disabled !== atMin) {
    prevDayBtn.disabled = atMin
    prevDayBtn.setAttribute("aria-disabled", String(atMin))
  }
  if (nextDayBtn instanceof HTMLButtonElement && nextDayBtn.disabled !== atMax) {
    nextDayBtn.disabled = atMax
    nextDayBtn.setAttribute("aria-disabled", String(atMax))
  }
}

function livetvHref(channel) {
  return (
    `/livetv?channel=${encodeURIComponent(String(channel.id))}` +
    (mergedMode ? `&pl=${encodeURIComponent(channel.playlistId)}` : "")
  )
}

function navigateToLive(channel) {
  window.location.href = livetvHref(channel)
}

function navigateToCatchup(channel, startDisplayMs, stopDisplayMs, title, catchupId) {
  const startUtc = displayedToUtcMs(channel.playlistId, startDisplayMs)
  const stopUtc = displayedToUtcMs(channel.playlistId, stopDisplayMs)
  window.location.href =
    livetvHref(channel) +
    `&cstart=${startUtc}` +
    `&cstop=${stopUtc}` +
    `&ctitle=${encodeURIComponent(title || "")}` +
    (catchupId ? `&cid=${encodeURIComponent(catchupId)}` : "")
}

let timeFormat = null
let dayFormat = null

function fmtTime(ts) {
  timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
  return timeFormat.format(new Date(ts))
}

function fmtDayLabel(ts) {
  dayFormat ??= new Intl.DateTimeFormat(getActiveLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
  return dayFormat.format(new Date(ts))
}

document.addEventListener(LOCALE_EVENT, () => {
  timeFormat = null
  dayFormat = null
  shownDayStart = 0
  if (timeline) {
    updateDayLabel()
    renderTimeHeader()
  }
})

function renderTimeHeader() {
  if (!headerInner || !timeline) return
  headerInner.replaceChildren()
  headerInner.style.width = `${timeline.width}px`
  const range = cellRange ?? { fromX: 0, toX: timeline.width }
  const ticks = timeline.rulerTicks(
    timeline.xToTime(range.fromX),
    timeline.xToTime(range.toX),
    TICK_STEP_MINUTES
  )
  const fragment = document.createDocumentFragment()
  for (const { ts, x, isMidnight } of ticks) {
    const tick = document.createElement("div")
    const isHour = new Date(ts).getMinutes() === 0
    tick.className =
      "absolute top-0 bottom-0 flex items-end pb-1 select-none whitespace-nowrap " +
      (isMidnight
        ? "border-l border-accent text-accent text-xs tabular-nums px-1.5 font-semibold"
        : isHour
        ? "border-l border-line text-fg-2 text-xs tabular-nums px-1.5 font-medium"
        : "border-l border-line/40 text-fg-3 text-2xs tabular-nums px-1.5")
    tick.style.left = `${x}px`
    tick.textContent = isMidnight ? fmtDayLabel(ts) : fmtTime(ts)
    fragment.appendChild(tick)
  }
  headerInner.appendChild(fragment)
}

const trackStripes =
  `repeating-linear-gradient(to right, var(--color-line) 0 1px, transparent 1px ${PX_PER_HOUR}px),` +
  `repeating-linear-gradient(to right, transparent 0 ${PX_PER_HOUR / 2}px, ` +
  `color-mix(in oklab, var(--color-line) 40%, transparent) ${PX_PER_HOUR / 2}px ${PX_PER_HOUR / 2 + 1}px, ` +
  `transparent ${PX_PER_HOUR / 2 + 1}px ${PX_PER_HOUR}px)`

function renderChannelRow(channel) {
  const row = document.createElement("div")
  row.className = "epg-row flex items-stretch border-b border-line"
  row.style.height = `${ROW_HEIGHT}px`

  // Sticky channel info column.
  const info = document.createElement("button")
  info.type = "button"
  info.className =
    "shrink-0 sticky left-0 z-10 bg-bg flex items-center gap-2 px-3 border-r border-line " +
    "text-left cursor-pointer outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-accent"
  info.style.width = `${CHANNEL_COL_WIDTH}px`
  info.title = channel.name
  info.setAttribute("aria-label", `${channel.name} - ${t("epg.watchNow")}`)
  info.addEventListener("click", () => navigateToLive(channel))

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
  const resolved = effectiveTvgId(channel, channel.playlistId)
  const isOverridden = !!(
    channel.playlistId &&
    getChannelEpgOverride(channel.playlistId, channel.id)
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

  const track = document.createElement("div")
  track.className = "epg-track relative shrink-0"
  track.style.width = `${timeline.width}px`
  track.style.backgroundImage = trackStripes

  row.appendChild(track)
  return { row, track }
}

function buildProgrammeCell(channel, rowIdx, cellInfo, nowMs, canChannelCatchup) {
  const p = cellInfo.programme
  const isLive = p.start <= nowMs && p.stop > nowMs
  const isPast = p.stop <= nowMs
  // rawStart/rawStop recover true XMLTV time so catch-up never sees the guide-display tvg-shift.
  const rawStart = p.rawStart ?? p.start
  const rawStop = p.rawStop ?? p.stop
  const canReplay = isPast && canChannelCatchup && isCatchupPlayable(channel, rawStart, nowMs)

  const cell = document.createElement("button")
  cell.type = "button"
  cell.dataset.rowIdx = String(rowIdx)
  cell.className =
    "epg-cell absolute top-1 bottom-1 rounded-lg px-2 " +
    (ROW_HEIGHT <= 44 ? "py-0.5 " : "py-1 ") +
    "flex flex-col justify-center gap-0.5 leading-tight text-left outline-none " +
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
  cell.style.left = `${cellInfo.x}px`
  cell.style.width = `${cellInfo.width}px`
  cell.title = `${fmtTime(p.start)}–${fmtTime(p.stop)} · ${p.title}${p.desc ? "\n\n" + p.desc : ""}`
  cell.addEventListener("click", () => {
    const dialogOpts = {
      title: p.title,
      desc: p.desc,
      start: p.start,
      stop: p.stop,
      channelName: channel.name,
      channelId: channel.id,
      onWatch: () => navigateToLive(channel),
    }
    if (canReplay) {
      dialogOpts.onCatchup = () =>
        navigateToCatchup(channel, rawStart, rawStop, p.title, p.catchupId)
    } else if (isLive && canChannelCatchup && isCatchupPlayable(channel, rawStart, nowMs)) {
      dialogOpts.onWatchFromStart = () =>
        navigateToCatchup(channel, rawStart, rawStop, p.title, p.catchupId)
    }
    openProgrammeDialog(dialogOpts)
  })

  const titleLine = document.createElement("div")
  titleLine.className = "truncate w-full min-w-0 leading-tight text-xs font-medium"
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
  timeLine.className = "truncate w-full min-w-0 leading-tight text-2xs text-fg-3 tabular-nums"
  timeLine.textContent = `${fmtTime(p.start)}–${fmtTime(p.stop)}`
  cell.append(titleLine, timeLine)
  return cell
}

/** @type {Map<number, {channel:any,list:any[],track:HTMLElement,cells:Map<number,HTMLElement>}>} */
const rowStates = new Map()

function syncRowCells(rowIdx) {
  const state = rowStates.get(rowIdx)
  if (!state || !timeline || !cellRange) return
  const wanted = timeline.programmeCellsInWindow(
    state.list,
    timeline.xToTime(cellRange.fromX),
    timeline.xToTime(cellRange.toX)
  )
  const seenKeys = new Map()
  const wantedKeys = wanted.map((cellInfo) => {
    const baseKey = `${cellInfo.start}:${cellInfo.stop}`
    const duplicates = seenKeys.get(baseKey) ?? 0
    seenKeys.set(baseKey, duplicates + 1)
    return duplicates ? `${baseKey}#${duplicates}` : baseKey
  })
  const wantedKeySet = new Set(wantedKeys)
  for (const [key, cell] of state.cells) {
    if (wantedKeySet.has(key) || cell === document.activeElement) continue
    cell.remove()
    state.cells.delete(key)
  }
  const nowMs = Date.now()
  const canChannelCatchup = channelSupportsCatchup(state.channel)
  const ordered = wanted.map(
    (cellInfo, i) =>
      state.cells.get(wantedKeys[i]) ??
      buildProgrammeCell(state.channel, rowIdx, cellInfo, nowMs, canChannelCatchup)
  )
  let reference = null
  for (let i = ordered.length - 1; i >= 0; i--) {
    const cell = ordered[i]
    if (cell.parentNode !== state.track || cell.nextSibling !== reference) {
      state.track.insertBefore(cell, reference)
    }
    state.cells.set(wantedKeys[i], cell)
    reference = cell
  }
}

function computeCellRange() {
  const viewportWidth = trackViewportWidth()
  const { fromX, toX } = timeline.visibleWindow(
    gridEl?.scrollLeft || 0,
    viewportWidth,
    viewportWidth
  )
  return { fromX, toX }
}

function refreshHorizontalWindow(force) {
  if (!timeline || !gridEl) return
  if (!force && cellRange) {
    const viewportWidth = trackViewportWidth()
    const visible = timeline.visibleWindow(gridEl.scrollLeft, viewportWidth)
    const margin = viewportWidth / 2
    const nearLeft = cellRange.fromX > 0 && visible.fromX < cellRange.fromX + margin
    const nearRight = cellRange.toX < timeline.width && visible.toX > cellRange.toX - margin
    if (!nearLeft && !nearRight) return
  }
  cellRange = computeCellRange()
  for (const rowIdx of rowStates.keys()) syncRowCells(rowIdx)
  renderTimeHeader()
}

function renderNowLine() {
  if (!bodyEl || !timeline) return
  bodyEl.querySelector("[data-now-line]")?.remove()
  const x = timeline.timeToX(Date.now())
  if (x < 0 || x > timeline.width) return
  const line = document.createElement("div")
  line.dataset.nowLine = ""
  line.className =
    "epg-now-line absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-[9]"
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
      rowStates.delete(idx)
    }
  }

  let added = false
  for (let idx = startIdx; idx < endIdx; idx++) {
    if (renderedRows.has(idx)) continue
    const channel = channels[idx]
    const key = effectiveTvgId(channel, channel.playlistId)
    // shiftChannelProgrammes stashes rawStart/rawStop so catch-up navigation can bypass tvg-shift.
    const list = key
      ? shiftChannelProgrammes(programmesFor(channel.playlistId)?.get(key) || [], channel.tvgShift)
      : []
    const { row, track } = renderChannelRow(channel)
    row.style.position = "absolute"
    row.style.top = `${idx * ROW_HEIGHT}px`
    row.style.left = "0"
    row.style.right = "0"
    row.dataset.rowIdx = String(idx)
    bodyEl.appendChild(row)
    renderedRows.set(idx, row)
    rowStates.set(idx, { channel, list, track, cells: new Map() })
    syncRowCells(idx)
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
    refreshHorizontalWindow(false)
    updateDayLabel()
    updateDayNavState()
    if (
      pendingScrollTarget !== null &&
      Math.abs(gridEl.scrollLeft - pendingScrollTarget) < 1
    ) {
      pendingScrollTarget = null
    }
  })
}

function attachVirtualScrollListener() {
  if (virtualScrollAttached || !gridEl) return
  gridEl.addEventListener("scroll", onVirtualScroll, { passive: true })
  const dropPendingScroll = () => {
    pendingScrollTarget = null
  }
  gridEl.addEventListener("scrollend", dropPendingScroll, { passive: true })
  gridEl.addEventListener("wheel", dropPendingScroll, { passive: true })
  gridEl.addEventListener("touchstart", dropPendingScroll, { passive: true })
  gridEl.addEventListener("pointerdown", dropPendingScroll, { passive: true })
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

  timeline = timeline ?? buildTimeline()
  const totalWidth = CHANNEL_COL_WIDTH + timeline.width
  // Apply width to the inner sliding rail in case CSS hasn't.
  bodyEl.style.minWidth = `${totalWidth}px`
  headerInner.parentElement.style.minWidth = `${totalWidth}px`

  // Reset windowed render state
  for (const row of renderedRows.values()) clearRowLogoFallbackTimer(row)
  bodyEl.replaceChildren()
  renderedRows.clear()
  rowStates.clear()
  cellRange = computeCellRange()
  renderTimeHeader()
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
  const uncategorized = t("stream.uncategorized") || "Uncategorized"
  const listedPlaylistIds = mergedMode ? mergedPlaylistIds : [activePlaylistId]
  const rowsByKey = new Map(cachedChannels.map((channel) => [rowKey(channel), channel]))
  const selection = parseMergedCategoryKey(activeCat, activePlaylistId)
  if (activeCat === CAT_FAVORITES && activePlaylistId) {
    filtered = mergeOrderedFavorites(
      listedPlaylistIds,
      (playlistId) => getFavoritesOrdered(playlistId, "live"),
      rowsByKey
    )
  } else if (activeCat === CAT_RECENTS && activePlaylistId) {
    filtered = mergeRecents(listedPlaylistIds, (playlistId) => getRecents(playlistId, "live"), rowsByKey)
  } else if (selection) {
    filtered = cachedChannels.filter((channel) => channelMatchesCategory(channel, selection, uncategorized))
  } else {
    // Honor the resolved hide / allow filter (issue #62). Sync defaults on
    // so EPG starts out aligned with Live TV's category choices.
    filtered = cachedChannels.filter((channel) =>
      channelPassesCategoryFilter(channel, (key) => picker.categoryPassesFilter(key), uncategorized)
    )
  }
  // Drop channels with no resolvable tvg-id - they have no EPG match. A
  // user-supplied per-channel override (Jellyfin-style) counts as resolvable
  // even when channel.tvgId is empty.
  const withEpg = filtered.filter((channel) =>
    !!effectiveTvgId(channel, channel.playlistId)
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
  const catMap = parseCategoriesToMap(catData)

  const r = await xtreamApiFetch("get_live_streams")
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json().catch(() => [])
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.streams)
    ? data.streams
    : []
  return mapXtreamLiveRows(arr, catMap, t("stream.uncategorized") || "Uncategorized")
}

// ----------------------------
// Category picker
// ----------------------------
function syncCategoryTitle() {
  if (!titleEl) return
  const activeCat = picker.getActiveCat()
  const selection = picker.getActiveSelection()
  const display =
    activeCat === CAT_FAVORITES
      ? t("list.specialFavorites")
      : activeCat === CAT_RECENTS
        ? t("list.specialRecents")
        : selection
          ? categoryLabel(selection.name, titleById.get(selection.playlistId) || "", mergedMode)
          : ""
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
  if (!programmesSize()) {
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
  if (!detail || !inMergedSet(detail.playlistId)) return
  // Picker module already filters internally; we just need to re-pick.
  applyCategory()
}
document.addEventListener("xt:hidden-categories-changed", onEpgPrefChange)
document.addEventListener("xt:allowed-categories-changed", onEpgPrefChange)
document.addEventListener("xt:category-mode-changed", onEpgPrefChange)
document.addEventListener("xt:epg-sync-changed", onEpgPrefChange)
document.addEventListener(CHANNEL_EPG_CHANGED_EVENT, (event) => {
  const detail = (event as CustomEvent).detail
  if (!detail || !inMergedSet(detail.playlistId)) return
  applyCategory()
})

let initGeneration = 0

async function loadMergedChannelRows(entries, generation) {
  mergedMode = true
  mergedPlaylistIds = entries.map((entry) => entry._id)
  titleById = new Map(entries.map((entry) => [entry._id, entry.title || ""]))
  const active = await getActiveEntry()
  if (generation !== initGeneration) return null
  activePlaylistId = active?._id || mergedPlaylistIds[0]
  activePlaylistTitle = titleById.get(activePlaylistId) || ""
  creds = entryToCreds(entries.find((entry) => entry._id === activePlaylistId))
  await ensurePrefsLoaded()
  if (generation !== initGeneration) return null
  syncCategoryTitle()

  await hydrateMergedRows("live")
  if (generation !== initGeneration) return null
  let rows = readMergedRows("live").rows
  if (!rows.length || !mergedPlaylistIds.every((playlistId) => hasCachedLiveChannels(playlistId))) {
    showLoadingSkeleton(t("epg.loadingChannels"))
    const result = await ensureMergedRows("live")
    if (generation !== initGeneration) return null
    rows = result.rows
    if (!rows.length && result.errors.size) {
      showProviderError("channels")
      return null
    }
  }
  return rows.filter((row) => !row.isHeader)
}

async function loadAllProgrammes(sources, generation) {
  const results = await Promise.allSettled(
    sources.map((source) => loadProgrammes(source.playlistId, source.creds))
  )
  if (generation !== initGeneration) return
  programmesByPlaylist = new Map()
  let anyLoaded = false
  results.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) return
    programmesByPlaylist.set(sources[index].playlistId, new Map(result.value.programmes))
    anyLoaded = true
  })
  if (!anyLoaded) throw new Error("EPG fetch failed")
}

async function init() {
  const generation = ++initGeneration
  // Wait for the locale JSON to resolve before any t() call so the page
  // never flashes an English string that gets replaced 100ms later.
  await initI18n()
  if (generation !== initGeneration) return
  showLoadingSkeleton(t("epg.loadingSkeleton"))

  const mergedEntries = await getMergedEntries()
  if (generation !== initGeneration) return
  if (mergedEntries.length >= 2) {
    const mergedRows = await loadMergedChannelRows(mergedEntries, generation)
    if (!mergedRows || generation !== initGeneration) return
    await finishInit(
      mergedRows,
      mergedEntries.map((entry) => ({ playlistId: entry._id, creds: entryToCreds(entry) })),
      generation
    )
    return
  }
  mergedMode = false

  const loadedCreds = await loadCreds()
  if (generation !== initGeneration) return
  creds = loadedCreds
  if (!creds.host) {
    showStatus(t("epg.noPlaylistSelected"))
    return
  }

  const active = await getActiveEntry()
  if (generation !== initGeneration) return
  if (!active) {
    showStatus(t("epg.noPlaylistSelected"))
    return
  }
  activePlaylistId = active._id
  activePlaylistTitle = active.title || ""
  mergedPlaylistIds = [active._id]
  titleById = new Map([[active._id, activePlaylistTitle]])
  await ensurePrefsLoaded()
  if (generation !== initGeneration) return
  syncCategoryTitle()

  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  // Hydrate from IDB before reading
  await hydrateCache(activePlaylistId, isM3U ? "m3u" : "live")
  if (generation !== initGeneration) return
  let cached = readCachedLiveChannels(activePlaylistId)
  if (!cached.length) cached = null

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
      if (generation !== initGeneration) return
    } catch (e) {
      if (generation !== initGeneration) return
      log.error("[epg] channel re-fetch failed:", e)
      showProviderError("channels")
      return
    }
  }

  await finishInit(stampRowsWithPlaylist(cached, activePlaylistId), [
    { playlistId: activePlaylistId, creds },
  ], generation)
}

async function finishInit(channelRows, programmeSources, generation) {
  allChannels = channelRows
  picker.rerender()

  timeline = buildTimeline()
  shownDayStart = 0
  updateDayLabel()
  updateDayNavState()
  showLoadingSkeleton(t("epg.loadingFull"))
  try {
    await loadAllProgrammes(programmeSources, generation)
  } catch (e) {
    if (generation !== initGeneration) return
    log.error("[epg] load failed:", e)
    showProviderError("EPG")
    return
  }
  if (generation !== initGeneration) return

  if (!programmesSize()) {
    showStatus(t("epg.noProgrammesMatched"))
    return
  }

  channels = pickChannels(channelRows)
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
  scrollToNow(false)
  syncViewToScroll()
}

// ----------------------------
// Rail scrolling
// ----------------------------
function shouldReduceMotion() {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  const perfMode = document.documentElement.getAttribute("data-perf-mode") === "on"
  return !!reduce || perfMode
}

function clampScrollLeft(x) {
  if (!timeline) return Math.max(0, x)
  return timeline.clampScroll(x, trackViewportWidth())
}

let pendingScrollTarget = null

function scrollGridTo(x, smooth) {
  if (!gridEl) return
  const target = clampScrollLeft(x)
  const farJump = Math.abs(target - gridEl.scrollLeft) > trackViewportWidth() * 3
  if (smooth && !farJump && !shouldReduceMotion()) {
    try {
      gridEl.scrollTo({ left: target, behavior: "smooth" })
      pendingScrollTarget = target
      return
    } catch {}
  }
  pendingScrollTarget = null
  gridEl.scrollLeft = target
  syncViewToScroll()
}

function syncViewToScroll() {
  renderVirtualWindow()
  refreshHorizontalWindow(false)
  updateDayLabel()
  updateDayNavState()
}

function scrollToNow(smooth) {
  if (!timeline) return
  scrollGridTo(timeline.timeToX(Date.now() - HALF_HOUR_MS), smooth)
}

function scrollGridBy(deltaPx) {
  if (!gridEl) return
  scrollGridTo((pendingScrollTarget ?? gridEl.scrollLeft) + deltaPx, true)
}

refreshBtn?.addEventListener("click", () => {
  for (const playlistId of mergedPlaylistIds) invalidateEpgPlaylist(playlistId)
  programmesByPlaylist = new Map()
  init()
})

nowBtn?.addEventListener("click", () => scrollToNow(true))

prevDayBtn?.addEventListener("click", () => {
  if ((prevDayBtn as HTMLButtonElement).disabled) return
  scrollGridBy(-24 * PX_PER_HOUR)
})

nextDayBtn?.addEventListener("click", () => {
  if ((nextDayBtn as HTMLButtonElement).disabled) return
  scrollGridBy(24 * PX_PER_HOUR)
})

earlierBtn?.addEventListener("click", () => scrollGridBy(-SCRUB_HOURS * PX_PER_HOUR))

laterBtn?.addEventListener("click", () => scrollGridBy(SCRUB_HOURS * PX_PER_HOUR))

document.addEventListener(EPG_OFFSET_EVENT, (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || !inMergedSet(detail.playlistId)) return
  programmesByPlaylist = new Map()
  init()
})

setInterval(() => {
  if (programmesSize() && channels.length) renderNowLine()
}, 60 * 1000)

document.addEventListener("xt:active-changed", () => {
  programmesByPlaylist = new Map()
  allChannels = []
  init()
})

document.addEventListener(MERGED_CHANGED_EVENT, () => {
  programmesByPlaylist = new Map()
  allChannels = []
  init()
})

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || !inMergedSet(detail.playlistId)) return
  if (detail.kind !== "live") return
  if (allChannels.length) picker.refreshPseudoRows()
  if (picker.getActiveCat() === CAT_FAVORITES) applyCategory()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || !inMergedSet(detail.playlistId)) return
  if (detail.kind !== "live") return
  if (allChannels.length) picker.refreshPseudoRows()
  if (picker.getActiveCat() === CAT_RECENTS) applyCategory()
})

init()
