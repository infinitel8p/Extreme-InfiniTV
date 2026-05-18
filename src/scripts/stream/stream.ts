// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Live TV channel list, search, category picker, EPG and Video.js player.
import { log, redactUrl } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
  getEntries,
  fmtBase,
  safeHttpUrl,
  isLikelyM3USource,
  isLocalM3UHost,
  readLocalM3UContent,
} from "@/scripts/lib/creds.js"
import { xtreamApiFetch, resolveStreamUrl } from "@/scripts/lib/xtream-api.js"
import { normalize, scoreNormMatch } from "@/scripts/lib/text.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { cachedFetch, getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  getFavorites,
  pushRecent,
  getRecents,
} from "@/scripts/lib/preferences.js"
import { mountCategoryPicker } from "@/scripts/lib/category-picker.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { attachPlayerFocusKeeper } from "@/scripts/lib/player-focus-keeper.js"
import { attachPopoverSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { togglePip } from "@/scripts/lib/pip-toggle.js"
import { bindAutoPip } from "@/scripts/lib/auto-pip.js"
import {
  androidNativePlayerAvailable,
  launchAndroidNativeLive,
  subscribeAndroidNativeEvents,
} from "@/scripts/lib/android-video-launcher.js"
import { getAndroidNativePlayerEnabled } from "@/scripts/lib/app-settings.js"
import { parseM3U as parseSharedM3U } from "@/scripts/lib/m3u-parser.ts"
import { applyStreamHeaders } from "@/scripts/lib/stream-headers.ts"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import { toast, toastError } from "@/scripts/lib/toast.js"
import {
  mountPlayer,
  externalPlayersAvailable,
  androidExternalAvailable,
  getExternalLauncher,
} from "@/scripts/lib/player-runtime.ts"
import {
  getPlayerBackend,
  getPlayerPath,
  getUserAgent,
  EXTERNAL_PLAYER_BACKENDS,
} from "@/scripts/lib/app-settings.js"
import {
  setupExternalPlayerButton,
  surfaceLaunchError,
  type ExternalPlayerButtonHandle,
} from "@/scripts/lib/external-player-button.js"
import { ICON_EXTERNAL_LINK } from "@/scripts/lib/icons.js"
import {
  loadProgrammes,
  getProgrammesSync,
  getNowNext,
  effectiveTvgId,
  EPG_LOADED_EVENT,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"
import { setRichPresence, clearRichPresence } from "@/scripts/lib/discord-rpc.js"
import { maybeB64ToUtf8, escapeHtml } from "@/scripts/lib/b64-utf8.ts"

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

function buildDirectLiveUrl(id, c = creds) {
  const { host, port, user, pass } = c
  const ext = c?.liveContainer === "ts" ? ".ts" : ".m3u8"
  return (
    fmtBase(host, port) +
    "/live/" +
    encodeURIComponent(user) +
    "/" +
    encodeURIComponent(pass) +
    "/" +
    encodeURIComponent(id) +
    ext
  )
}

// ----------------------------
// M3U support
// ----------------------------
let directUrlById = new Map()
let streamHeadersById = new Map()
export let m3uEpgUrl = ""

function parseM3U(text) {
  /** @type {Array<{ id:number, name:string, tvgId?:string, chno?:number, category?:string, logo?:string|null, url:string, norm:string, userAgent?:string|null, referer?:string|null }>} */
  const out = []
  const { entries, epgUrl } = parseSharedM3U(text)
  m3uEpgUrl = epgUrl || ""
  const fallbackCategory = t("stream.uncategorized") || "Uncategorized"
  let idSeq = 1
  for (const entry of entries) {
    const url = safeHttpUrl(entry.url)
    if (!url) continue
    if (!entry.name) continue
    const category = entry.category || fallbackCategory
    out.push({
      id: idSeq++,
      name: entry.name,
      category,
      logo: entry.logo,
      tvgId: entry.tvgId || undefined,
      chno: entry.chno ?? undefined,
      norm: normalize(`${entry.name} ${category} ${entry.tvgId || ""}`),
      url,
      userAgent: entry.userAgent,
      referer: entry.referer,
    })
  }
  return out
}

const indexDirectUrls = (items) => {
  directUrlById = new Map()
  streamHeadersById = new Map()
  for (const channel of items) {
    if (channel.url) directUrlById.set(channel.id, channel.url)
    if (channel.userAgent || channel.referer) {
      streamHeadersById.set(channel.id, {
        userAgent: channel.userAgent || null,
        referer: channel.referer || null,
      })
    }
  }
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

const searchEl = document.getElementById("search")
const currentEl = document.getElementById("current")
const epgList = document.getElementById("epg-list")

let activePlaylistId = ""
let activePlaylistTitle = ""
let activeTuningTransition: any = null

// The inline script in livetv.astro sets data-first-run optimistically from
// localStorage["xt_playlists"]. On Tauri builds the real entry list lives in
// the plugin-store (.xtream.creds.json), so localStorage is empty and the
// welcome card stays up over the actual channels. Reconcile against the
// authoritative source whenever the page boots or the entry list changes.
async function reconcileFirstRun() {
  try {
    const entries = await getEntries()
    document.documentElement.toggleAttribute(
      "data-first-run",
      entries.length === 0
    )
  } catch (err) {
    log.warn("[xt:livetv] reconcileFirstRun failed:", err)
  }
}

document.addEventListener("xt:entries-updated", () => {
  reconcileFirstRun()
})

document.addEventListener("xt:active-changed", () => {
  clearRichPresence().catch(() => {})
  reconcileFirstRun()
  loadChannels()
})

document.addEventListener("xt:cache-revalidated", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.entryId !== activePlaylistId) return
  if (detail.kind !== "live" && detail.kind !== "m3u") return
  loadChannels()
})

document.addEventListener("xt:channel-epg-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e as any).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  ensureEpgLoaded()
  refreshNowSlots()
  if (
    currentlyPlayingId &&
    detail.channelId != null &&
    detail.channelId === currentlyPlayingId &&
    hasDirectUrl(currentlyPlayingId)
  ) {
    paintSidePanelFromXmltv(currentlyPlayingId)
  }
  if (radioModeChannelId != null) paintRadioNowPlaying(radioModeChannelId)
})

document.addEventListener(EPG_LOADED_EVENT, (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  refreshNowSlots()
  // For M3U sources the side panel can't use get_short_epg; it pulls from
  // the just-loaded XMLTV state. Refresh it now that data is available.
  if (currentlyPlayingId && hasDirectUrl(currentlyPlayingId)) {
    paintSidePanelFromXmltv(currentlyPlayingId)
  }
  if (radioModeChannelId != null) paintRadioNowPlaying(radioModeChannelId)
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
  if (picker.getActiveCat() === CAT_FAVORITES) scheduleApplyFilter()
  else renderVirtual()
  picker.refreshPseudoRows()
})

document.addEventListener("xt:recents-changed", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  if (picker.getActiveCat() === CAT_RECENTS) scheduleApplyFilter()
  picker.refreshPseudoRows()
})

const onPickerFilterChange = (e: Event) => {
  const detail = /** @type {CustomEvent} */ (e as any).detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "live") return
  scheduleApplyFilter()
}
document.addEventListener("xt:hidden-categories-changed", onPickerFilterChange)
document.addEventListener("xt:allowed-categories-changed", onPickerFilterChange)
document.addEventListener("xt:category-mode-changed", onPickerFilterChange)

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

const picker = mountCategoryPicker({
  kind: "live",
  idPrefix: "category-picker",
  activeCatStorageKey: "xt_active_cat",
  activeCatChangedEvent: "xt:cat-changed",
  getActivePlaylistId: () => activePlaylistId,
  getItems: () => all,
})
document.addEventListener("xt:cat-changed", () => scheduleApplyFilter())

function computeRowH() {
  if (typeof window === "undefined") return 68
  const rootPx = parseFloat(
    getComputedStyle(document.documentElement).fontSize || "16"
  )
  const base = Number.isFinite(rootPx) && rootPx > 0 ? rootPx : 16
  return Math.max(56, Math.round(base * 4.25))
}
let ROW_H = computeRowH()

function channelSkeletonCount() {
  // Fill the channel list pane regardless of viewport size.
  const containerH = listEl?.clientHeight || 0
  const fallback =
    typeof window !== "undefined" ? (window.innerHeight || 720) - 120 : 720
  return Math.max(14, Math.ceil(Math.max(containerH, fallback) / ROW_H) + 4)
}

function renderChannelSkeletons(count) {
  if (!viewport || !spacer) return
  const total = Number.isFinite(count) && count > 0 ? count : channelSkeletonCount()
  spacer.style.height = `${total * ROW_H}px`
  const frag = document.createDocumentFragment()
  // Vary widths so the placeholder looks like a list, not a striped pattern.
  const nameWidths = [62, 78, 54, 70, 86, 60, 72, 50, 80, 64, 76, 58]
  const metaWidths = [38, 46, 30, 52, 34, 44, 28, 48, 36, 42, 32, 50]
  for (let i = 0; i < total; i++) {
    // Cascade the shimmer down
    const waveDelay = (i * 110) % 1600
    const enterDelay = Math.min(i, 10) * 24

    const row = document.createElement("div")
    row.className = "channel-row flex w-full items-center gap-1"
    row.style.height = `${ROW_H}px`
    row.dataset.idx = String(i)
    row.dataset.skeleton = "true"
    row.style.setProperty("--skel-enter-delay", `${enterDelay}ms`)
    row.innerHTML =
      `<div class="flex flex-1 items-center gap-3 px-2.5 py-2 h-full min-w-0">
        <div class="h-9 w-9 shrink-0 rounded-md ring-1 ring-inset ring-line skel" style="--skel-delay:${waveDelay}ms;"></div>
        <div class="flex flex-col gap-1.5 flex-1 min-w-0">
          <div class="h-3 rounded skel" style="width:${nameWidths[i % nameWidths.length]}%; --skel-delay:${waveDelay + 60}ms;"></div>
          <div class="h-2.5 rounded skel" style="width:${metaWidths[i % metaWidths.length]}%; --skel-delay:${waveDelay + 140}ms;"></div>
        </div>
      </div>
      <div class="size-10 shrink-0 rounded-md skel opacity-60" style="--skel-delay:${waveDelay + 220}ms;"></div>`
    frag.appendChild(row)
  }
  viewport.replaceChildren(frag)
  viewport.style.transform = "translateY(0)"
}

/** @type {Map<string,string> | null} */
let categoryMap = null

const OVERSCAN_DEFAULT = 6
const OVERSCAN_PERF = 2
const isPerfMode = () =>
  typeof document !== "undefined" &&
  document.documentElement.getAttribute("data-perf-mode") === "on"
const getOverscan = () => (isPerfMode() ? OVERSCAN_PERF : OVERSCAN_DEFAULT)
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
  if (!state) return
  const tvgId = effectiveTvgId(ch, activePlaylistId)
  if (!tvgId) return
  const { current, next } = getNowNext(state.programmes, tvgId)
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
  const overscan = getOverscan()
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan)
  const endIdx = Math.min(
    filtered.length,
    Math.ceil((scrollTop + visibleH) / ROW_H) + overscan
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
      "h-9 w-9 shrink-0 rounded-md overflow-hidden ring-1 ring-inset ring-line logo-skel"
    if (ch.logo) {
      const safeLogo = safeHttpUrl(ch.logo)
      if (safeLogo) {
        const img = document.createElement("img")
        img.src = safeLogo
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
    } else {
      logo.setAttribute("data-loaded", "true")
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

    attachChannelContextMenu(row, ch)

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

// ---------------------------------------------------------------------------
// Right-click / long-press: "Test stream" context menu
// ---------------------------------------------------------------------------
function buildChannelStreamUrl(channel) {
  if (!channel) return ""
  if (hasDirectUrl(channel.id)) return getDirectUrl(channel.id)
  return buildDirectLiveUrl(channel.id)
}

function openChannelDiagnostic(channel) {
  if (!channel) return
  const url = buildChannelStreamUrl(channel)
  if (!url) return
  import("@/scripts/lib/stream-diagnostic-dialog.js").then(
    ({ openStreamDiagnostic }) => {
      openStreamDiagnostic({ url, title: channel.name || `Channel ${channel.id}` })
    }
  )
}

let channelMenuEl = null
const CHANNEL_MENU_ID = "xt-channel-menu"
const channelMenuSpatialNav = attachPopoverSpatialNav({
  id: `${CHANNEL_MENU_ID}-section`,
  selector: `#${CHANNEL_MENU_ID} [role="menuitem"]`,
})
function closeChannelMenu() {
  if (!channelMenuEl) return
  channelMenuSpatialNav.close()
  channelMenuEl.remove()
  channelMenuEl = null
  document.removeEventListener("pointerdown", onChannelMenuOutside, true)
  document.removeEventListener("keydown", onChannelMenuKey, true)
  window.removeEventListener("blur", closeChannelMenu)
  window.removeEventListener("resize", closeChannelMenu)
  listEl?.removeEventListener("scroll", closeChannelMenu)
}
function onChannelMenuOutside(event) {
  if (!channelMenuEl) return
  if (channelMenuEl.contains(/** @type {Node} */ (event.target))) return
  closeChannelMenu()
}
function onChannelMenuKey(event) {
  if (event.key === "Escape") {
    event.preventDefault()
    closeChannelMenu()
  }
}

function openChannelMenu(channel, anchor, point) {
  closeChannelMenu()
  const menu = document.createElement("div")
  menu.id = CHANNEL_MENU_ID
  menu.className =
    "fixed z-50 min-w-[12rem] rounded-xl border border-line bg-surface text-fg shadow-2xl " +
    "p-1 flex flex-col gap-0.5"
  menu.setAttribute("role", "menu")
  menu.setAttribute("aria-label", `Actions for ${channel.name || "channel"}`)

  const playItem = document.createElement("button")
  playItem.type = "button"
  playItem.setAttribute("role", "menuitem")
  playItem.className =
    "w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-surface-2 focus:bg-surface-2 outline-none"
  playItem.textContent = t("stream.menu.play")
  playItem.addEventListener("click", () => {
    closeChannelMenu()
    play(channel.id, channel.name)
  })

  const testItem = document.createElement("button")
  testItem.type = "button"
  testItem.setAttribute("role", "menuitem")
  testItem.className =
    "w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-surface-2 focus:bg-surface-2 outline-none"
  testItem.textContent = t("stream.menu.test")
  testItem.addEventListener("click", () => {
    closeChannelMenu()
    openChannelDiagnostic(channel)
  })

  const copyItem = document.createElement("button")
  copyItem.type = "button"
  copyItem.setAttribute("role", "menuitem")
  copyItem.className =
    "w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-surface-2 focus:bg-surface-2 outline-none"
  copyItem.textContent = t("stream.menu.copy")
  copyItem.addEventListener("click", async () => {
    const url = buildChannelStreamUrl(channel)
    closeChannelMenu()
    if (!url) return
    try {
      const { writeClipboardText } = await import("@/scripts/lib/clipboard")
      await writeClipboardText(url)
      toast({ title: t("stream.toast.copied"), duration: 2200 })
    } catch (error) {
      log.warn("[xt:livetv] copy stream URL failed:", error)
    }
  })

  menu.append(playItem, testItem, copyItem)
  document.body.appendChild(menu)

  const margin = 8
  const rect = menu.getBoundingClientRect()
  let left
  let top
  if (point) {
    left = Math.min(point.x, window.innerWidth - rect.width - margin)
    top = Math.min(point.y, window.innerHeight - rect.height - margin)
  } else if (anchor) {
    const anchorRect = anchor.getBoundingClientRect()
    left = Math.min(anchorRect.right + 6, window.innerWidth - rect.width - margin)
    top = Math.min(anchorRect.top, window.innerHeight - rect.height - margin)
  } else {
    left = (window.innerWidth - rect.width) / 2
    top = (window.innerHeight - rect.height) / 2
  }
  menu.style.left = `${Math.max(margin, left)}px`
  menu.style.top = `${Math.max(margin, top)}px`

  channelMenuEl = menu
  channelMenuSpatialNav.open()
  document.addEventListener("pointerdown", onChannelMenuOutside, true)
  document.addEventListener("keydown", onChannelMenuKey, true)
  window.addEventListener("blur", closeChannelMenu)
  window.addEventListener("resize", closeChannelMenu)
  listEl?.addEventListener("scroll", closeChannelMenu, { passive: true })

  testItem.focus({ preventScroll: true })
}

const LONG_PRESS_MS = 500
function attachChannelContextMenu(row, channel) {
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    openChannelMenu(channel, row, { x: event.clientX, y: event.clientY })
  })

  let pressTimer = null
  let pressX = 0
  let pressY = 0
  let triggered = false
  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  row.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return
    triggered = false
    pressX = event.clientX
    pressY = event.clientY
    cancelPress()
    pressTimer = setTimeout(() => {
      triggered = true
      openChannelMenu(channel, row, { x: pressX, y: pressY })
    }, LONG_PRESS_MS)
  })
  row.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") return
    const dx = Math.abs(event.clientX - pressX)
    const dy = Math.abs(event.clientY - pressY)
    if (dx > 8 || dy > 8) cancelPress()
  })
  row.addEventListener("pointerup", () => cancelPress())
  row.addEventListener("pointercancel", () => cancelPress())
  row.addEventListener("click", (event) => {
    if (triggered) {
      event.preventDefault()
      event.stopPropagation()
      triggered = false
    }
  }, true)
}

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

/** Scroll the virtualized list so row `idx` is in view, without grabbing focus. */
function scrollIntoViewByIdx(idx) {
  if (!listEl || idx < 0 || idx >= filtered.length) return
  const top = idx * ROW_H
  const visTop = listEl.scrollTop
  const visBottom = visTop + listEl.clientHeight
  if (top < visTop) {
    listEl.scrollTop = Math.max(0, top - ROW_H * 2)
  } else if (top + ROW_H > visBottom) {
    listEl.scrollTop = top + ROW_H - listEl.clientHeight + ROW_H * 2
  }
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

let digitBuffer = ""
let digitTimer = null
let digitOverlayEl = null

function showDigitOverlay(text) {
  if (!digitOverlayEl) {
    digitOverlayEl = document.createElement("div")
    digitOverlayEl.setAttribute("aria-live", "polite")
    digitOverlayEl.setAttribute("role", "status")
    digitOverlayEl.className =
      "fixed top-6 left-1/2 -translate-x-1/2 z-50 " +
      "px-5 py-2.5 rounded-2xl bg-surface ring-1 ring-line shadow-xl " +
      "text-fg font-semibold text-3xl tabular-nums tracking-[0.04em] " +
      "pointer-events-none select-none"
    document.body.appendChild(digitOverlayEl)
  }
  digitOverlayEl.textContent = text
}

function hideDigitOverlay() {
  if (digitOverlayEl) {
    digitOverlayEl.remove()
    digitOverlayEl = null
  }
}

function commitDigitBuffer() {
  if (digitTimer) {
    clearTimeout(digitTimer)
    digitTimer = null
  }
  const num = parseInt(digitBuffer, 10)
  digitBuffer = ""
  hideDigitOverlay()
  if (!Number.isFinite(num) || num < 1) return
  const idx = num - 1
  if (idx >= filtered.length) return
  const ch = filtered[idx]
  if (!ch) return
  focusByIdx(idx)
  play(ch.id, ch.name)
}

function isTypingTarget(target) {
  if (!target) return false
  const el = /** @type {HTMLElement} */ (target)
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (typeof el.closest === "function" && el.closest("dialog[open]")) return true
  return false
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return
  if (isTypingTarget(e.target)) return

  if (/^\d$/.test(e.key)) {
    digitBuffer = (digitBuffer + e.key).slice(0, 4)
    showDigitOverlay(digitBuffer)
    if (digitTimer) clearTimeout(digitTimer)
    digitTimer = setTimeout(commitDigitBuffer, 1100)
    e.preventDefault()
    return
  }

  if (digitBuffer && e.key === "Enter") {
    e.preventDefault()
    commitDigitBuffer()
    return
  }

  if (digitBuffer && e.key === "Escape") {
    if (digitTimer) clearTimeout(digitTimer)
    digitTimer = null
    digitBuffer = ""
    hideDigitOverlay()
    e.preventDefault()
    return
  }

  if (e.key === "[" || e.key === "]") {
    if (!filtered.length) return
    const currentIdx = currentlyPlayingId != null
      ? filtered.findIndex((channel) => channel.id === currentlyPlayingId)
      : -1
    let nextIdx
    if (currentIdx === -1) {
      nextIdx = e.key === "]" ? 0 : filtered.length - 1
    } else {
      nextIdx = e.key === "[" ? currentIdx - 1 : currentIdx + 1
      if (nextIdx < 0) nextIdx = filtered.length - 1
      if (nextIdx >= filtered.length) nextIdx = 0
    }
    const channel = filtered[nextIdx]
    if (!channel) return
    e.preventDefault()
    focusByIdx(nextIdx)
    play(channel.id, channel.name)
    return
  }

  // Player shortcuts
  if (!vjs) return
  const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key
  switch (lower) {
    case " ":
    case "spacebar": {
      e.preventDefault()
      if (vjs.paused()) vjs.play()?.catch(() => {})
      else vjs.pause()
      return
    }
    case "m": {
      e.preventDefault()
      vjs.muted(!vjs.muted())
      return
    }
    case "f": {
      e.preventDefault()
      if (vjs.isFullscreen()) vjs.exitFullscreen()
      else vjs.requestFullscreen()
      return
    }
    case "j":
    case "l": {
      e.preventDefault()
      const delta = lower === "j" ? -10 : 10
      const dur = vjs.duration()
      const next = (vjs.currentTime() || 0) + delta
      const clamped = Number.isFinite(dur) && dur > 0
        ? Math.max(0, Math.min(dur, next))
        : Math.max(0, next)
      try { vjs.currentTime(clamped) } catch {}
      return
    }
  }
})

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

  const activeCat = picker.getActiveCat()
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
      return picker.categoryPassesFilter((ch.category || "").toString())
    })
  }

  if (tokens.length) {
    const scored = []
    for (const channel of out) {
      const score = scoreNormMatch(channel.norm, tokens)
      if (score > 0) scored.push({ channel, score })
    }
    scored.sort((first, second) => second.score - first.score)
    out = scored.map((row) => row.channel)
  }

  listStatus.textContent = `${out.length.toLocaleString()} of ${all.length.toLocaleString()} channels`
  mountVirtualList(out)
}

searchEl?.addEventListener("input", debounce(applyFilter, 160))

async function ensureCategoryMap() {
  if (categoryMap) return categoryMap
  const r = await xtreamApiFetch("get_live_categories")
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


function showEmptyState() {
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
  picker.rerender()
  applyFilter()
  maybeAutoplayFromUrl()
  ensureEpgLoaded()
}

function ensureEpgLoaded() {
  if (!activePlaylistId || !creds.host) return
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

  if (!filtered.some((channel) => channel.id === id)) {
    picker.setActiveCat("", { silent: true })
    if (searchEl && searchEl.value) searchEl.value = ""
    applyFilter()
  }
  play(ch.id, ch.name)
  requestAnimationFrame(() => {
    const idx = filtered.findIndex((channel) => channel.id === id)
    if (idx >= 0) scrollIntoViewByIdx(idx)
  })
}

async function loadChannels() {
  log.log("[xt:livetv] loadChannels enter")
  if (!listStatus || !viewport) {
    log.warn("[xt:livetv] loadChannels: missing DOM nodes", {
      listStatus: !!listStatus,
      viewport: !!viewport,
    })
    return
  }
  const active = await getActiveEntry()
  log.log("[xt:livetv] loadChannels active=", active?._id || null)
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
    listStatus.textContent = t("stream.loading")
    if (!viewport?.querySelector("[data-skeleton]")) renderChannelSkeletons()
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
          let text
          if (isLocalM3UHost(creds.host)) {
            text = await readLocalM3UContent(creds.host)
          } else {
            const r = await providerFetch(creds.host)
            if (!r.ok) throw new Error(`M3U ${r.status}: ${await r.text()}`)
            text = await r.text()
          }
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
        const r = await xtreamApiFetch("get_live_streams")
        log.log("[xt:livetv] get_live_streams resp status=", r.status, "ok=", r.ok)
        const body = await r.text()
        log.log("[xt:livetv] body bytes=", body?.length ?? 0)
        if (!r.ok) {
          log.error("Upstream error body:", body)
          throw new Error(`API ${r.status}: ${body}`)
        }
        const parsed = JSON.parse(body)
        log.log("[xt:livetv] parsed array length=", Array.isArray(parsed) ? parsed.length : "(not array)")
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
    log.log("[xt:livetv] cachedFetch returned len=", data?.length ?? 0, "fromCache=", fromCache)
    paintChannels(data, fromCache, age)
    log.log("[xt:livetv] paintChannels done")
  } catch (e) {
    log.error("[xt:livetv] loadChannels threw:", e)
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
let playSeq = 0
let lastPlayContext = null
let tuningOverlaySentinel = null
let stallSentinel = null
let bufferingShownAt = 0
let bufferingHideTimer = null
const TUNING_MAX_MS = 8000
const STALL_AUTO_TUNE_MS = 30_000
const BUFFERING_GRACE_MS = 350
const ERROR_AUTO_RETRY_MS = 1500

// Per-stream diagnostic cooldown
const AUTO_DIAGNOSTIC_COOLDOWN_MS = 30_000
const lastAutoDiagnosticAt = new Map()

async function runAutoDiagnostic(ctx, dismissGenericToast) {
  if (!ctx?.streamId || !ctx.src) return

  const now = Date.now()
  const last = lastAutoDiagnosticAt.get(ctx.streamId) || 0
  if (now - last < AUTO_DIAGNOSTIC_COOLDOWN_MS) return
  lastAutoDiagnosticAt.set(ctx.streamId, now)

  log.log("[xt:livetv] auto-diagnostic starting for", ctx.streamId)
  const seqAtStart = ctx.seq
  try {
    const { diagnoseStream, summarizeReport } = await import(
      "@/scripts/lib/stream-diagnostic.js"
    )
    const report = await diagnoseStream(ctx.src)

    if (seqAtStart !== playSeq) {
      log.log("[xt:livetv] auto-diagnostic dropped (stream changed)")
      return
    }
    const { verdict, reason } = summarizeReport(report)
    log.log("[xt:livetv] auto-diagnostic verdict:", verdict, reason)
    if (!reason) return
    try { dismissGenericToast?.() } catch {}
    toastError(
      t("stream.error.cantPlay", { channel: ctx.name || `#${ctx.streamId}` }),
      { description: reason, duration: 8000 }
    )
  } catch (e) {
    log.warn("[xt:livetv] auto-diagnostic failed:", e)
  }
}

const ensureEmbeddedPlayer = async (backend) => {
  if (vjs) return vjs
  const videoEl = document.getElementById("player")
  if (!videoEl) return null
  // Hide Video.js's built-in PiP toggle on Tauri Android - the WebView
  // doesn't expose Web PiP so the button always renders disabled. Native
  // PiP goes through the in-page button + AndroidPip bridge instead.
  const hasNativePipBridge = !!window.AndroidPip
  const mounted = await mountPlayer(videoEl, backend, {
    liveui: true,
    fluid: true,
    preload: "auto",
    autoplay: false,
    aspectRatio: "16:9",
    pictureInPictureToggle: !hasNativePipBridge,
    controlBar: {
      volumePanel: { inline: false },
      pictureInPictureToggle: !hasNativePipBridge,
      playbackRateMenuButton: false,
      fullscreenToggle: true,
    },
  })
  if (mounted.kind !== "embedded") return null
  vjs = mounted.handle

  if (mounted.backend === "videojs") {
    attachPlayerFocusKeeper(vjs)
  }
  if (videoEl instanceof HTMLVideoElement) {
    bindAutoPip(videoEl)
  }
  attachAudioOnlyDetection(vjs)

  vjs.on("playing", () => {
    hideTuningOverlay()
    hideBufferingChip()
    clearStallSentinel()
  })
  vjs.on("waiting", () => {
    showBufferingChip()
    armStallSentinel()
  })
  vjs.on("stalled", () => {
    showBufferingChip()
    armStallSentinel()
  })
  vjs.on("error", () => {
    const ctx = lastPlayContext
    if (!ctx) return
    const err = vjs.error?.()
    log.error("[xt:livetv] player error", {
      code: err?.code,
      message: err?.message,
      streamId: ctx.streamId,
    })
    if (!ctx.retried) {
      ctx.retried = true
      const seqAtRetry = ctx.seq
      setTimeout(() => {
        if (seqAtRetry !== playSeq) return
        try {
          vjs.reset?.()
          vjs.src({ src: ctx.src, type: "application/x-mpegURL" })
          vjs.play().catch(() => {})
        } catch {}
      }, ERROR_AUTO_RETRY_MS)
      return
    }
    hideTuningOverlay()
    hideBufferingChip()
    clearStallSentinel()
    const dismissGeneric = toastError(
      t("stream.error.cantPlay", { channel: ctx.name || `#${ctx.streamId}` }),
      { description: t("stream.error.checkConnection") }
    )
    // Background diagnostic: turn the generic "couldn't play" toast into an
    // actionable one ("HLS playlist returned 403", "Server unreachable",
    // "Top variant manifest empty", etc.) once we have a verdict. Cooldown
    // per stream-id so a flapping channel doesn't fire repeated probes.
    runAutoDiagnostic(ctx, dismissGeneric)
  })

  return vjs
}

/** Channel ID currently rendered in radio mode (-1 = none). */
let radioModeChannelId: number | null = null

function getPlayerWrap(): HTMLElement | null {
  return document.getElementById("player-wrap")
}

function setRadioMode(channel: { id: number; name?: string; logo?: string | null }) {
  const wrap = getPlayerWrap()
  if (!wrap) return
  wrap.dataset.radioMode = "on"
  const nameEl = wrap.querySelector<HTMLElement>("[data-radio-name]")
  if (nameEl) nameEl.textContent = channel.name || `Channel ${channel.id}`
  const cover = wrap.querySelector<HTMLImageElement>("[data-radio-cover]")
  if (cover) {
    cover.dataset.loaded = "false"
    const logoUrl = channel.logo ? safeHttpUrl(channel.logo) : null
    if (logoUrl) {
      cover.onload = () => { cover.dataset.loaded = "true" }
      cover.onerror = () => { cover.dataset.loaded = "false" }
      cover.src = logoUrl
    } else {
      cover.removeAttribute("src")
    }
  }
  radioModeChannelId = channel.id
  paintRadioNowPlaying(channel.id)
  wrap.setAttribute("aria-label", t("livetv.radioAriaLabel", { name: channel.name || "" }) || `Radio: ${channel.name || ""}`)
}

function clearRadioMode() {
  const wrap = getPlayerWrap()
  if (!wrap) return
  delete wrap.dataset.radioMode
  wrap.removeAttribute("aria-label")
  const nowEl = wrap.querySelector<HTMLElement>("[data-radio-nowplaying]")
  if (nowEl) {
    nowEl.textContent = ""
    nowEl.hidden = true
  }
  radioModeChannelId = null
}

function paintRadioNowPlaying(channelId: number) {
  const wrap = getPlayerWrap()
  if (!wrap) return
  const nowEl = wrap.querySelector<HTMLElement>("[data-radio-nowplaying]")
  if (!nowEl) return
  const channel = all.find((entry) => entry.id === channelId)
  if (!channel || !activePlaylistId) {
    nowEl.textContent = ""
    nowEl.hidden = true
    return
  }
  const tvgId = effectiveTvgId(channel, activePlaylistId)
  if (!tvgId) {
    nowEl.textContent = ""
    nowEl.hidden = true
    return
  }
  const state = getProgrammesSync(activePlaylistId)
  const { current } = getNowNext(state?.programmes, tvgId)
  if (!current?.title) {
    nowEl.textContent = ""
    nowEl.hidden = true
    return
  }
  nowEl.textContent = current.title
  nowEl.hidden = false
}

/** Listen for the underlying <video> exposing zero video pixels - that's an
 * audio-only stream, so promote the wrap to radio mode even when the M3U
 * didn't carry a `tvg-type` hint. Hook this once after the player mounts. */
function attachAudioOnlyDetection(handle: { on(event: string, fn: (...args: unknown[]) => void): void }) {
  const detect = () => {
    const ctx = lastPlayContext
    if (!ctx) return
    const wrap = getPlayerWrap()
    if (!wrap) return
    if (wrap.dataset.radioMode === "on") return
    const videoEl = wrap.querySelector("video") as HTMLVideoElement | null
    if (!videoEl) return
    if (videoEl.videoWidth === 0 && videoEl.videoHeight === 0) {
      const channel = all.find((entry) => entry.id === ctx.streamId)
      if (channel) setRadioMode(channel)
    }
  }
  handle.on("loadedmetadata", detect)
  handle.on("playing", detect)
}

function showTuningOverlay(logoUrl) {
  const playerWrap = document.getElementById("player")?.parentElement
  if (!playerWrap) return
  playerWrap.querySelector("[data-tuning-overlay]")?.remove()
  const overlay = document.createElement("div")
  overlay.dataset.tuningOverlay = ""
  overlay.className = "tuning-overlay"
  overlay.style.viewTransitionName = "tuning-logo"
  if (logoUrl) {
    const img = document.createElement("img")
    img.src = logoUrl
    img.alt = ""
    img.referrerPolicy = "no-referrer"
    img.decoding = "async"
    overlay.appendChild(img)
  }
  playerWrap.appendChild(overlay)
  // Cap visibility so we never get stuck on the overlay if `playing` never
  // fires (dead provider, codec issue, render-process crash on Android).
  if (tuningOverlaySentinel) clearTimeout(tuningOverlaySentinel)
  tuningOverlaySentinel = setTimeout(hideTuningOverlay, TUNING_MAX_MS)
}

function hideTuningOverlay() {
  if (tuningOverlaySentinel) {
    clearTimeout(tuningOverlaySentinel)
    tuningOverlaySentinel = null
  }
  const playerWrap = document.getElementById("player")?.parentElement
  const overlay = playerWrap?.querySelector("[data-tuning-overlay]")
  if (!overlay) return
  overlay.classList.add("tuning-overlay--leaving")
  setTimeout(() => overlay.remove(), 380)
}

function showBufferingChip() {
  const playerWrap = document.getElementById("player")?.parentElement
  if (!playerWrap) return
  if (bufferingHideTimer) {
    clearTimeout(bufferingHideTimer)
    bufferingHideTimer = null
  }
  let chip = playerWrap.querySelector("[data-buffering-chip]")
  if (!chip) {
    chip = document.createElement("div")
    chip.dataset.bufferingChip = ""
    chip.className = "buffering-chip"
    chip.setAttribute("role", "status")
    chip.setAttribute("aria-live", "polite")
    chip.textContent = t("stream.buffering")
    playerWrap.appendChild(chip)
  }
  bufferingShownAt = Date.now()
}

function hideBufferingChip() {
  const playerWrap = document.getElementById("player")?.parentElement
  const chip = playerWrap?.querySelector("[data-buffering-chip]")
  if (!chip) return
  // Avoid flicker on transient waiting -> playing toggles.
  const elapsed = Date.now() - bufferingShownAt
  const wait = Math.max(0, BUFFERING_GRACE_MS - elapsed)
  if (bufferingHideTimer) clearTimeout(bufferingHideTimer)
  bufferingHideTimer = setTimeout(() => {
    chip.remove()
    bufferingHideTimer = null
  }, wait)
}

function armStallSentinel() {
  if (stallSentinel) clearTimeout(stallSentinel)
  stallSentinel = setTimeout(() => {
    const ctx = lastPlayContext
    if (!ctx || !vjs) return
    log.warn("[xt:livetv] stall sentinel re-tuning", { streamId: ctx.streamId })
    try {
      vjs.reset?.()
      vjs.src({ src: ctx.src, type: "application/x-mpegURL" })
      vjs.play().catch(() => {})
    } catch {}
  }, STALL_AUTO_TUNE_MS)
}

function clearStallSentinel() {
  if (stallSentinel) {
    clearTimeout(stallSentinel)
    stallSentinel = null
  }
}

function runScanLineSweep() {
  const playerWrap = document.getElementById("player")?.parentElement
  if (!playerWrap) return
  playerWrap.classList.remove("scan-line-sweep")
  void playerWrap.offsetWidth
  playerWrap.classList.add("scan-line-sweep")
  setTimeout(() => playerWrap.classList.remove("scan-line-sweep"), 720)
}

window.addEventListener("pagehide", () => {
  clearRichPresence().catch(() => {})
})

function pushDiscordPresence(channel, kind) {
  if (!activePlaylistId || !channel) return
  const safeLogo = channel.logo ? safeHttpUrl(channel.logo) : null
  let stateLine = ""
  const state = getProgrammesSync(activePlaylistId)
  const tvgId = effectiveTvgId(channel, activePlaylistId)
  if (state && tvgId) {
    const { current } = getNowNext(state.programmes, tvgId)
    if (current?.title) stateLine = current.title
  }
  setRichPresence({
    playlistId: activePlaylistId,
    details: `Watching ${channel.name || `Channel ${channel.id}`}`,
    state: stateLine || (kind === "live" ? "Live TV" : ""),
    largeImage: safeLogo || "logo",
    largeText: activePlaylistTitle || "Extreme InfiniTV",
    smallImage: "live",
    smallText: "Live",
    startTimestamp: Date.now(),
  })
}

function pickConfiguredExternal() {
  for (const kind of EXTERNAL_PLAYER_BACKENDS) {
    if (getPlayerPath(kind)) return kind
  }
  return null
}

// Native ExoPlayer Activity intercept for Live TV
let _nativeLiveSubscribed = false
function ensureNativeLiveSubscription() {
  if (_nativeLiveSubscribed) return
  _nativeLiveSubscribed = true
  subscribeAndroidNativeEvents((event) => {
    if (event.type !== "xt:android-native-channel-changed") return
    const channelId = event.payload?.channelId
    if (!channelId) return
    const channel = all.find((entry) => String(entry.id) === String(channelId))
    if (!channel) return
    if (activePlaylistId) {
      pushRecent(activePlaylistId, "live", channel.id, channel.name, channel.logo || null)
    }
    setNowPlaying(channel.id)
  })
}

async function tryLaunchNativeLive(initialStreamId, initialName) {
  if (!androidNativePlayerAvailable) return false
  if (!getAndroidNativePlayerEnabled()) return false
  if (!all.length) return false
  ensureNativeLiveSubscription()

  const channelInputs = []
  for (const channel of all) {
    let streamUrl = ""
    if (hasDirectUrl(channel.id)) {
      streamUrl = getDirectUrl(channel.id)
    } else {
      const built = buildDirectLiveUrl(channel.id, creds)
      if (built) streamUrl = built
    }
    if (!streamUrl) continue
    const headers = streamHeadersById.get(channel.id) || null
    channelInputs.push({
      id: String(channel.id),
      name: channel.name || "",
      logo: channel.logo || "",
      streamUrl,
      ua: headers?.userAgent || "",
      referer: headers?.referer || "",
      tvgId: channel.tvgId || null,
    })
  }
  if (!channelInputs.length) return false

  const programmes = activePlaylistId
    ? getProgrammesSync(activePlaylistId)?.programmes ?? null
    : null
  const launched = launchAndroidNativeLive({
    contentKey: `live:${initialStreamId}`,
    channels: channelInputs,
    initialChannelId: String(initialStreamId),
    defaultUa: getUserAgent() || "",
    programmes,
  })
  if (launched && activePlaylistId) {
    pushRecent(activePlaylistId, "live", initialStreamId, initialName,
      all.find((entry) => entry.id === initialStreamId)?.logo || null)
    setNowPlaying(initialStreamId)
  }
  return launched
}

async function play(streamId, name) {
  if (!currentEl) return
  // Native ExoPlayer Activity path (opt-in via Settings). Hands off the full
  // playback session including channel switching. Returns early if successful.
  if (await tryLaunchNativeLive(streamId, name)) return

  const src = hasDirectUrl(streamId)
    ? getDirectUrl(streamId)
    : await resolveStreamUrl((c) => buildDirectLiveUrl(streamId, c))

  // Embedded players (Video.js + hls.js) only speak http(s). M3U sources can
  // ship rtsp/rtmp/udp/mms/... - those need MPV/VLC
  const isHttpSrc = /^https?:\/\//i.test(src || "")
  if (!isHttpSrc && src) {
    const selectedBackend = getPlayerBackend()
    const backendIsExternal =
      selectedBackend === "mpv" || selectedBackend === "vlc"
    if (!backendIsExternal) {
      const externalKind =
        externalPlayersAvailable ? pickConfiguredExternal() : null
      const channelHeaders = streamHeadersById.get(streamId) || null
      if (externalKind) {
        try {
          await launchExternalLive(externalKind, src, channelHeaders)
          showExternalPlayerEmptyState(externalKind, name)
        } catch (err) {
          surfaceLaunchError(err, externalKind)
        }
        if (activePlaylistId) {
          const channel = all.find((channel) => channel.id === streamId)
          pushRecent(activePlaylistId, "live", streamId, name, channel?.logo || null)
        }
        setNowPlaying(streamId)
        return
      }
      const scheme = (src.split("://")[0] || "").toLowerCase()
      toastError(
        t("stream.error.schemeUnsupported", { scheme }) ||
          `Can't play "${scheme}://" streams in the embedded player. Set up MPV or VLC in Settings → Playback.`
      )
      return
    }
    // backend is mpv/vlc - fall through to the existing external launch below.
  }

  if (activePlaylistId) {
    const ch = all.find((c) => c.id === streamId)
    pushRecent(activePlaylistId, "live", streamId, name, ch?.logo || null)
  }

  const channel = all.find((c) => c.id === streamId)
  const channelLogo = channel?.logo ? safeHttpUrl(channel.logo) : null

  const sourceLogo = viewport?.querySelector(
    `.channel-row[data-idx="${filtered.findIndex((c) => c.id === streamId)}"] .play-btn > div:first-child`
  )
  const supportsVT = typeof document.startViewTransition === "function"
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  const wantTransition =
    supportsVT && !reduceMotion && !activeTuningTransition && sourceLogo instanceof HTMLElement
  if (wantTransition) {
    for (const stale of document.querySelectorAll<HTMLElement>(
      '[style*="view-transition-name"]'
    )) {
      if (stale !== sourceLogo && stale.style.viewTransitionName === "tuning-logo") {
        stale.style.viewTransitionName = ""
      }
    }
    sourceLogo!.style.viewTransitionName = "tuning-logo"
  }

  const swapState = () => {
    setNowPlaying(streamId)

    currentEl.replaceChildren()
    const wrap = document.createElement("div")
    wrap.className = "flex items-center gap-2 min-w-0 flex-1"
    wrap.innerHTML =
      '<span class="status-badge status-badge--live shrink-0">ON</span>'
    const label = document.createElement("span")
    label.className = "truncate min-w-0 flex-1"
    label.append(`Channel ${streamId}: `)
    const nameEl = document.createElement("span")
    nameEl.className = "text-accent"
    nameEl.textContent = name
    label.appendChild(nameEl)
    wrap.appendChild(label)
    currentEl.appendChild(wrap)

    const btn = document.createElement("button")
    btn.id = "pip-btn"
    btn.type = "button"
    btn.title = "Picture-in-Picture"
    btn.setAttribute("aria-label", "Picture-in-Picture")
    btn.className = "shrink-0 inline-flex items-center justify-center min-h-11 min-w-11 px-3.5 rounded-xl border border-line bg-surface text-sm text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors"
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M19 4a3 3 0 0 1 3 3v4a1 1 0 0 1 -2 0v-4a1 1 0 0 0 -1 -1h-14a1 1 0 0 0 -1 1v10a1 1 0 0 0 1 1h6a1 1 0 0 1 0 2h-6a3 3 0 0 1 -3 -3v-10a3 3 0 0 1 3 -3z"/><path d="M20 13a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-5a2 2 0 0 1 -2 -2v-3a2 2 0 0 1 2 -2z"/></svg>`
    btn.addEventListener("click", () => { if (vjs) togglePip(vjs) })
    currentEl.appendChild(btn)

    appendExternalLaunchButton(currentEl, streamId, src, name)

    if (sourceLogo instanceof HTMLElement) sourceLogo.style.viewTransitionName = ""
    showTuningOverlay(channelLogo)
    runScanLineSweep()
  }

  if (wantTransition) {
    const transition = document.startViewTransition(() => swapState())
    activeTuningTransition = transition
    transition.ready?.catch?.(() => {})
    transition.finished
      .catch(() => {})
      .finally(() => {
        if (activeTuningTransition === transition) activeTuningTransition = null
        if (sourceLogo instanceof HTMLElement) sourceLogo.style.viewTransitionName = ""
      })
  } else {
    swapState()
  }

  const backend = getPlayerBackend()
  const channelHeaders = streamHeadersById.get(streamId) || null

  if (backend === "mpv" || backend === "vlc") {
    try {
      await launchExternalLive(backend, src, channelHeaders)
      showExternalPlayerEmptyState(backend, name)
    } catch (err) {
      surfaceLaunchError(err, backend)
    }
    if (hasDirectUrl(streamId)) {
      paintSidePanelFromXmltv(streamId)
    } else {
      loadEPG(streamId)
    }
    return
  }

  resetEmptyState()
  document.getElementById("player")?.removeAttribute("hidden")
  if (channel?.isRadio) {
    setRadioMode({ id: streamId, name, logo: channel.logo ?? null })
  } else {
    clearRadioMode()
  }
  const player = await ensureEmbeddedPlayer(backend)
  if (!player) return
  await applyStreamHeaders(channelHeaders)
  const seq = ++playSeq
  lastPlayContext = { streamId, name, src, seq, retried: false }
  hideBufferingChip()
  clearStallSentinel()
  try { player.reset?.() } catch {}
  player.src({ src, type: "application/x-mpegURL" })
  const playResult = player.play?.()
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch(() => {})
  }

  pushDiscordPresence(channel || { id: streamId, name }, "live")

  if (hasDirectUrl(streamId)) {
    paintSidePanelFromXmltv(streamId)
  } else {
    loadEPG(streamId)
  }
}

let liveExternalBtnHandle: ExternalPlayerButtonHandle | null = null

function appendExternalLaunchButton(parent, streamId, src, name) {
  liveExternalBtnHandle?.dispose()
  liveExternalBtnHandle = null

  if (!parent || (!externalPlayersAvailable && !androidExternalAvailable)) return

  const btn = document.createElement("button")
  btn.id = "external-launch-btn"
  btn.type = "button"
  btn.hidden = true
  btn.className =
    "shrink-0 inline-flex items-center justify-center gap-2 min-h-11 px-3.5 rounded-xl border border-line bg-surface text-sm text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors"

  const iconSpan = document.createElement("span")
  iconSpan.className = "shrink-0 inline-flex text-xl leading-none"
  iconSpan.setAttribute("aria-hidden", "true")
  iconSpan.innerHTML = ICON_EXTERNAL_LINK

  const labelSpan = document.createElement("span")
  labelSpan.dataset.label = ""

  btn.append(iconSpan, labelSpan)
  parent.appendChild(btn)

  liveExternalBtnHandle = setupExternalPlayerButton(btn, {
    getSrc: () => src,
    getHeaders: () => {
      const channelHeaders = streamHeadersById.get(streamId) || null
      return {
        userAgent: channelHeaders?.userAgent || getUserAgent() || null,
        referer: channelHeaders?.referer || null,
      }
    },
    getTitle: () => name || null,
    beforeLaunch: () => {
      try { vjs?.pause?.() } catch {}
    },
  })
}

function showExternalPlayerEmptyState(backend, channelName) {
  clearRadioMode()
  const empty = document.getElementById("player-empty")
  if (!empty) return
  const eyebrow = empty.querySelector("[data-i18n='livetv.idle']") as HTMLElement | null
  const title = empty.querySelector("[data-i18n='livetv.pickChannel'], [data-empty-title]") as HTMLElement | null
  const helper = empty.querySelector("[data-i18n='livetv.pickChannelHelper'], [data-empty-helper]") as HTMLElement | null
  if (eyebrow) {
    eyebrow.textContent = backend.toUpperCase()
    eyebrow.removeAttribute("data-i18n")
  }
  if (title) {
    title.textContent = `Now playing in ${backend.toUpperCase()}`
    title.removeAttribute("data-i18n")
    title.dataset.emptyTitle = "external"
  }
  if (helper) {
    helper.textContent = channelName || ""
    helper.removeAttribute("data-i18n")
    helper.dataset.emptyHelper = "external"
  }
}

function resetEmptyState() {
  const empty = document.getElementById("player-empty")
  if (!empty) return
  const eyebrow = empty.querySelector("span[data-empty-eyebrow], span:not([data-i18n])") as HTMLElement | null
  const title = empty.querySelector("[data-empty-title]") as HTMLElement | null
  const helper = empty.querySelector("[data-empty-helper]") as HTMLElement | null
  if (title) {
    title.setAttribute("data-i18n", "livetv.pickChannel")
    title.textContent = t("livetv.pickChannel") || "Pick a channel."
    delete title.dataset.emptyTitle
  }
  if (helper) {
    helper.setAttribute("data-i18n", "livetv.pickChannelHelper")
    helper.textContent = t("livetv.pickChannelHelper") || "Choose from the list, or change category."
    delete helper.dataset.emptyHelper
  }
  // Eyebrow may still hold the backend name from a previous external launch.
  const eyebrowI18n = empty.querySelector("[data-i18n='livetv.idle']") as HTMLElement | null
  if (eyebrowI18n) {
    eyebrowI18n.textContent = t("livetv.idle") || "Idle"
  } else if (eyebrow) {
    eyebrow.setAttribute("data-i18n", "livetv.idle")
    eyebrow.textContent = t("livetv.idle") || "Idle"
  }
}

async function launchExternalLive(backend, src, channelHeaders) {
  const launcher = getExternalLauncher(backend)
  const ua = channelHeaders?.userAgent || getUserAgent() || null
  const referer = channelHeaders?.referer || null
  log.log(`[xt:livetv] external launch backend=${backend} url=${redactUrl(src)}`)
  toast({
    title: t("settings.playback.launching", { player: backend.toUpperCase() })
      || `Launching ${backend.toUpperCase()}…`,
    duration: 2000,
  })
  const result = await launcher.launch(src, { userAgent: ua, referer })
  log.log(
    `[xt:livetv] external launch result backend=${backend} pid=${result?.pid} reused=${result?.reused}`
  )
}

// ----------------------------
// EPG
// ----------------------------
// maybeB64ToUtf8 + escapeHtml live in @/scripts/lib/b64-utf8.ts.

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

/** @type {Array<{ start:number, stop:number, title:string, desc:string }>} */
let epgListData = []
let epgListChannelId = 0
let epgListChannelName = ""

async function loadEPG(streamId) {
  if (!epgList) return
  epgList.innerHTML = `<div class="text-fg-3">Loading EPG…</div>`
  epgListData = []
  epgListChannelId = streamId
  epgListChannelName = all.find((c) => c.id === streamId)?.name || ""
  try {
    const r = await xtreamApiFetch("get_short_epg", {
      stream_id: String(streamId),
      limit: "10",
    })
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
        title: maybeB64ToUtf8(it.title || it.title_raw || t("programme.untitled")),
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
    log.error(e)
    epgList.innerHTML = `<div class="text-bad">Failed to load EPG.</div>`
  }
}

/**
 * M3U variant of loadEPG: there's no provider `get_short_epg` endpoint, but
 * we may have programmes loaded from the user's XMLTV sources. Resolve the
 * channel's effective tvg-id (auto or override), look up the matching
 * programmes, and render them in the same shape the Xtream path produces.
 */
function paintSidePanelFromXmltv(streamId) {
  if (!epgList) return
  const channel = all.find((entry) => entry.id === streamId)
  if (!channel) {
    epgList.innerHTML = `<div class="text-fg-3" data-i18n="epg.sidePanelEmpty">${escapeHtml(t("epg.sidePanelEmpty"))}</div>`
    return
  }
  epgListChannelId = streamId
  epgListChannelName = channel.name || ""

  const tvgId = effectiveTvgId(channel, activePlaylistId)
  if (!tvgId) {
    epgList.innerHTML = `<div class="text-fg-3">${escapeHtml(t("epg.sidePanelNoMapping"))}</div>`
    epgListData = []
    return
  }

  const state = getProgrammesSync(activePlaylistId)
  const programmes = state?.programmes?.get(tvgId) || []
  if (!programmes.length) {
    epgList.innerHTML = `<div class="text-fg-3">${escapeHtml(t("epg.sidePanelEmpty"))}</div>`
    epgListData = []
    return
  }

  const now = Date.now()
  const upcoming = programmes.filter((programme) => programme.stop >= now).slice(0, 10)
  if (!upcoming.length) {
    epgList.innerHTML = `<div class="text-fg-3" data-i18n="epg.sidePanelEmpty">${escapeHtml(t("epg.sidePanelEmpty"))}</div>`
    epgListData = []
    return
  }

  epgListData = upcoming
  epgList.innerHTML = upcoming
    .map((programme, idx) => {
      const isLive = programme.start <= now && now < programme.stop
      const start = fmtTime(programme.start / 1000)
      const end = fmtTime(programme.stop / 1000)
      const title = escapeHtml(programme.title)
      const desc = escapeHtml(programme.desc)
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

// Window resize (incl. maximize) changes the 0.84vw root font-size and
// therefore the visual height of channel-row content. Recompute the
// virtualization unit and re-render so rows still match their content box.
const handleRowHResize = debounce(() => {
  const next = computeRowH()
  if (next === ROW_H) return
  ROW_H = next
  if (spacer && filtered) {
    spacer.style.height = `${filtered.length * ROW_H}px`
  }
  if (viewport?.querySelector("[data-skeleton]")) {
    renderChannelSkeletons()
  } else {
    renderVirtual()
  }
}, 120)
window.addEventListener("resize", handleRowHResize)

// ----------------------------
// Boot
// ----------------------------
// First-paint skeleton: render placeholder channel rows synchronously so the
// list pane has structure during the brief boot async window.
if (viewport && spacer && !viewport.childElementCount) {
  renderChannelSkeletons()
}
if (listStatus && /no playlist selected/i.test(listStatus.textContent || "")) {
  listStatus.textContent = t("stream.loading")
}

;(async () => {
  log.log("[xt:livetv] boot start")
  await initI18n()
  await reconcileFirstRun()
  creds = await loadCreds()
  log.log("[xt:livetv] boot creds host=", !!creds.host)
  if (creds.host) {
    loadChannels()
  } else {
    showEmptyState()
  }
})()
