// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Live TV channel list, search, category picker, EPG and Video.js player.
import { log, redactUrl } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
  getEntries,
  safeHttpUrl,
  isLikelyM3USource,
  isLocalM3UHost,
  isCustomHost,
  readLocalM3UContent,
} from "@/scripts/lib/creds.js"
import { xtreamApiFetch, resolveStreamUrl } from "@/scripts/lib/xtream-api.js"
import { normalize, scoreNormMatch } from "@/scripts/lib/text.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { t, initI18n, getActiveLocale } from "@/scripts/lib/i18n.js"
import { cachedFetch, getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  getFavorites,
  pushRecent,
  getRecents,
  getViewSort,
  setViewSort,
  getVideoScaleOverride,
  setVideoScaleOverride,
  clearAllVideoScaleOverrides,
  CHANNEL_VIDEO_SCALE_CHANGED_EVENT,
} from "@/scripts/lib/preferences.js"
import { mountCategoryPicker } from "@/scripts/lib/category-picker.ts"
import { sortChannelsForView } from "@/scripts/lib/channel-sort.ts"
import { fmtChannelIdentity, formatBehindLive } from "@/scripts/lib/format.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { buildLiveStreamUrl } from "@/scripts/lib/stream-urls.ts"
import { attachPlayerFocusKeeper } from "@/scripts/lib/player-focus-keeper.js"
import { attachPopoverSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { togglePip } from "@/scripts/lib/pip-toggle.js"
import { bindAutoPip } from "@/scripts/lib/auto-pip.js"
import {
  androidNativePlayerAvailable,
  launchAndroidNativeLive,
  subscribeAndroidNativeEvents,
} from "@/scripts/lib/android-video-launcher.js"
import { getAndroidNativePlayerEnabled, getAudioTranscodeAuto } from "@/scripts/lib/app-settings.js"
import {
  audioTranscodeAvailable,
  refreshAudioTranscodeAvailability,
  startAudioTranscode,
  stopAudioTranscode,
  onAudioTranscodeError,
  rememberAudioTranscodeChannel,
  forgetAudioTranscodeChannel,
  isAudioTranscodeChannel,
} from "@/scripts/lib/audio-proxy.ts"
import { parseM3U as parseSharedM3U } from "@/scripts/lib/m3u-parser.ts"
import { stepChannelIndex, channelKeyDirection } from "@/scripts/lib/channel-step.ts"
import {
  hasHevcNameHint,
  deviceSupportsHevc,
  classifyStartFailure,
  describeAudioCodec,
  isUnsupportedAudioCodec,
  isDroppingEveryFrame,
  DROPPED_FRAME_MIN_SAMPLE,
  chooseBlackFrameRecovery,
  isParseFailureDetail,
  isMseAudioClockWedge,
  chromiumMajorFromUserAgent,
  isMpegAudioCodecString,
} from "@/scripts/lib/codec-hints.ts"
import { ensureHevcDecodable, isWindowsDesktop } from "@/scripts/lib/hevc-extension.ts"
import { applyStreamHeaders } from "@/scripts/lib/stream-headers.ts"
import { renderProviderError } from "@/scripts/lib/provider-error.js"
import { toast, toastError } from "@/scripts/lib/toast.js"
import { requestLogoFallback } from "@/scripts/lib/logo-fallback.ts"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import {
  mountPlayer,
  externalPlayersAvailable,
  androidExternalAvailable,
  getExternalLauncher,
  isMacOS,
  isTauri,
  subscribeExternalPlayerExit,
} from "@/scripts/lib/player-runtime.ts"
import {
  getPlayerBackend,
  getPlayerPath,
  getUserAgent,
  getExternalPlayerPref,
  EXTERNAL_PLAYER_BACKENDS,
  getVideoScale,
  setVideoScale,
  VIDEO_SCALE_EVENT,
  SETTINGS_EVENT,
  getMonoAudioEnabled,
  setMonoAudioEnabled,
  getDensityFactor,
} from "@/scripts/lib/app-settings.js"
import { createVideoScaleController } from "@/scripts/lib/video-scale.ts"
import { openVideoScaleDialog, videoScaleModeLabelKey } from "@/scripts/lib/video-scale-dialog.ts"
import {
  setupExternalPlayerButton,
  surfaceLaunchError,
  type ExternalPlayerButtonHandle,
} from "@/scripts/lib/external-player-button.js"
import { ICON_EXTERNAL_LINK, ICON_ALERT_TRIANGLE, ICON_DOTS, ICON_CHECK } from "@/scripts/lib/icons.js"
import { openAddToCustomDialog } from "@/scripts/lib/add-to-custom-dialog.ts"
import {
  loadProgrammes,
  getProgrammesSync,
  getNowNext,
  getNowNextForChannel,
  shiftChannelProgrammes,
  effectiveTvgId,
  displayedToUtcMs,
  utcToDisplayedMs,
  EPG_LOADED_EVENT,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"
import { setRichPresence, clearRichPresence } from "@/scripts/lib/discord-rpc.js"
import { maybeB64ToUtf8, escapeHtml } from "@/scripts/lib/b64-utf8.ts"
import {
  channelSupportsCatchup,
  catchupWindowDays,
  isCatchupPlayable,
  streamProfileFor,
  XTREAM_STREAM_PROFILE,
} from "@/scripts/lib/catchup.ts"
import { resolveCatchupSrc } from "@/scripts/lib/catchup-resolve.ts"
import {
  clampSeekTarget,
  adjustTargetForGranularity,
  shouldIgnoreSeek,
  applySeekStep,
  resumeAction,
  autoAdvanceDecision,
  minDistanceFromLiveMs,
  type StreamProfile,
} from "@/scripts/lib/timeshift-math.ts"
import { decodedFrameCount, droppedFrameCount } from "@/scripts/lib/player-telemetry.js"
import { attachPlayerInsights } from "@/scripts/lib/player-stats.ts"
import { isAutomaticRetuneReason } from "@/scripts/lib/stream-health.ts"
import { attachQualityChip } from "@/scripts/lib/quality-badge.ts"

const CHANNELS_TTL_MS = 24 * 60 * 60 * 1000
// One "page" of the side EPG panel's past window; the "Load earlier" button loads another, up to a 7-day cap.
const EPG_SIDE_PANEL_PAST_WINDOW_MS = 24 * 60 * 60 * 1000
const EPG_SIDE_PANEL_MAX_PAST_DAYS = 7

let currentlyPlayingId = null
// Tracks the channel that was playing before the current one, so `\` can flip back to it.
let previousPlayingId = null

function setNowPlaying(id) {
  if (id !== currentlyPlayingId) previousPlayingId = currentlyPlayingId
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
  const container = isM3u8ContainerFallbackChannel(id) ? "m3u8" : c?.liveContainer
  return buildLiveStreamUrl(c, id, container)
}

// ----------------------------
// M3U support
// ----------------------------
let directUrlById = new Map()
let streamHeadersById = new Map()
let streamDrmById = new Map()
// Comma-joined, matching the format catalog.js writes to xt_m3u_epg:<id>.
let m3uEpgUrls = []

function parseM3U(text) {
  /** @type {Array<{ id:number, name:string, tvgId?:string, chno?:number, category?:string, categories?:string[], logo?:string|null, url:string, norm:string, userAgent?:string|null, referer?:string|null, tvgShift?:number|null }>} */
  const out = []
  const { entries, epgUrls } = parseSharedM3U(text)
  m3uEpgUrls = epgUrls || []
  const fallbackCategory = t("stream.uncategorized") || "Uncategorized"
  let idSeq = 1
  for (const entry of entries) {
    const url = safeHttpUrl(entry.url)
    if (!url) continue
    if (!entry.name) continue
    const category = entry.category || fallbackCategory
    const categories = entry.categories && entry.categories.length ? entry.categories : [category]
    out.push({
      id: idSeq++,
      name: entry.name,
      category,
      categories,
      logo: entry.logo,
      tvgId: entry.tvgId || undefined,
      chno: entry.chno ?? undefined,
      tvgShift: entry.tvgShift ?? null,
      norm: normalize(`${entry.name} ${category} ${entry.tvgId || ""}`),
      url,
      userAgent: entry.userAgent,
      referer: entry.referer,
      manifestType: entry.manifestType,
      drmScheme: entry.drmScheme,
      licenseKey: entry.licenseKey,
      catchup: entry.catchup ?? null,
      catchupDays: entry.catchupDays ?? null,
      catchupSource: entry.catchupSource ?? null,
      catchupCorrection: entry.catchupCorrection ?? null,
    })
  }
  return out
}

const indexDirectUrls = (items) => {
  directUrlById = new Map()
  streamHeadersById = new Map()
  streamDrmById = new Map()
  for (const channel of items) {
    if (channel.url) directUrlById.set(channel.id, channel.url)
    if (channel.userAgent || channel.referer) {
      streamHeadersById.set(channel.id, {
        userAgent: channel.userAgent || null,
        referer: channel.referer || null,
      })
    }
    if (channel.manifestType || channel.licenseKey) {
      streamDrmById.set(channel.id, {
        manifestType: channel.manifestType || null,
        drmScheme: channel.drmScheme || null,
        licenseKey: channel.licenseKey || null,
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
const epgPanel = document.getElementById("epg")
const epgDayIndicator = document.getElementById("epg-day-indicator")

let activePlaylistId = ""
let activePlaylistTitle = ""
let activeTuningTransition: any = null
let externalPresenceActive = false

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
  externalPresenceActive = false
  reconcileFirstRun()
  loadChannels()
})

document.addEventListener("xt:cache-revalidated", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.entryId !== activePlaylistId) return
  if (detail.kind !== "live" && detail.kind !== "m3u") return
  loadChannels()
})

subscribeExternalPlayerExit(() => {
  if (!externalPresenceActive) return
  externalPresenceActive = false
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

const videoScaleController = createVideoScaleController(() => (vjs ? vjs.el() : null))

function resolveVideoScaleMode() {
  if (activePlaylistId && currentlyPlayingId != null) {
    const override = getVideoScaleOverride(activePlaylistId, "live", currentlyPlayingId)
    if (override) return override
  }
  return getVideoScale()
}

function applyVideoScale() {
  videoScaleController.apply(resolveVideoScaleMode())
}

document.addEventListener(VIDEO_SCALE_EVENT, () => {
  if (currentlyPlayingId != null) applyVideoScale()
})

document.addEventListener(CHANNEL_VIDEO_SCALE_CHANGED_EVENT, (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "live") return
  if (currentlyPlayingId == null) return
  // itemId is null for a bulk clear (e.g. "apply to all channels").
  if (detail.itemId === null || detail.itemId === currentlyPlayingId) applyVideoScale()
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
  return Math.max(48, Math.round(base * 4.25 * getDensityFactor()))
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
  const { current, next } = getNowNextForChannel(state.programmes, ch, activePlaylistId)
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

function shouldWarnHevc(name) {
  return hasHevcNameHint(name) && !deviceSupportsHevc()
}

function buildHevcBadge() {
  const badge = document.createElement("span")
  badge.className =
    "hevc-badge inline-flex shrink-0 items-center rounded-md border border-line bg-surface-2 px-1.5 text-2xs font-medium text-fg-3"
  badge.textContent = "HEVC"
  const hint = t("livetv.hevcBadge.tooltip")
  badge.title = hint
  badge.setAttribute("aria-label", hint)
  return badge
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
    if (ch.unresolved) {
      row.dataset.unresolved = "true"
    }

    const playBtn = document.createElement("button")
    playBtn.type = "button"
    playBtn.dataset.role = "play"
    playBtn.className =
      "play-btn flex flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-left h-full min-w-0 hover:bg-surface-2 focus:bg-surface-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
    playBtn.title = ch.unresolved
      ? `${ch.name || ""} (${t("editor.unresolvedBadge")})`
      : ch.name || ""
    if (ch.unresolved) {
      playBtn.setAttribute("aria-disabled", "true")
    }
    playBtn.onclick = () => play(ch.id, ch.name)

    const logo = document.createElement("div")
    logo.className =
      "h-9 w-9 shrink-0 rounded-md overflow-hidden ring-1 ring-inset ring-line logo-skel"
    if (ch.logo) {
      const safeLogo = safeHttpUrl(ch.logo)
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
          requestLogoFallback(logo, ch)
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
          requestLogoFallback(logo, ch)
        }
        logo.appendChild(img)
        mountCachedImage(img, safeLogo, "logo")
      } else {
        logo.setAttribute("data-loaded", "true")
        requestLogoFallback(logo, ch)
      }
    } else {
      logo.setAttribute("data-loaded", "true")
      requestLogoFallback(logo, ch)
    }
    playBtn.appendChild(logo)

    const wrap = document.createElement("div")
    wrap.className = "min-w-0 flex-1"
    const nameRow = document.createElement("div")
    nameRow.className = "flex min-w-0 items-center gap-1.5"
    const nameEl = document.createElement("div")
    nameEl.className = "truncate text-sm font-medium"
    nameEl.textContent = ch.name
    nameRow.appendChild(nameEl)
    if (shouldWarnHevc(ch.name)) nameRow.appendChild(buildHevcBadge())
    const meta = document.createElement("div")
    meta.className = "truncate text-xs text-fg-3 tabular-nums"
    meta.textContent = `${fmtChannelIdentity(ch.chno, ch.id)}${ch.category ? ` · ${ch.category}` : ""}`
    wrap.append(nameRow, meta)
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
      "star-btn flex shrink-0 h-11 w-11 items-center justify-center rounded-lg text-base outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent " +
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

  // Rows are fully rebuilt each render; cancel outgoing rows' pending logo-fallback timers before they're discarded.
  for (const staleImg of viewport.querySelectorAll("img")) {
    const timer = (staleImg as HTMLImageElement & { logoFallbackTimer?: ReturnType<typeof setTimeout> })
      .logoFallbackTimer
    if (timer) clearTimeout(timer)
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

/** CustomSource for "Add to custom playlist"; null when the active entry is itself custom or the channel has no usable URL. */
function buildCustomSourceForChannel(channel) {
  if (!activePlaylistId || isCustomHost(creds.host)) return null
  if (isLikelyM3USource(creds.host, creds.user, creds.pass)) {
    if (!channel.url) return null
    return { kind: "m3u", entryId: activePlaylistId, url: channel.url, name: channel.name || "" }
  }
  return { kind: "xtream", entryId: activePlaylistId, streamId: channel.id }
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

  const customSource = buildCustomSourceForChannel(channel)
  let addToCustomItem = null
  if (customSource) {
    addToCustomItem = document.createElement("button")
    addToCustomItem.type = "button"
    addToCustomItem.setAttribute("role", "menuitem")
    addToCustomItem.className =
      "w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-surface-2 focus:bg-surface-2 outline-none"
    addToCustomItem.textContent = t("stream.menu.addToCustom")
    addToCustomItem.addEventListener("click", () => {
      closeChannelMenu()
      void openAddToCustomDialog(customSource, {
        name: channel.name || "",
        logo: channel.logo ?? null,
        group: channel.category ?? null,
        tvgId: channel.tvgId ?? null,
      })
    })
  }

  menu.append(playItem, testItem, copyItem, ...(addToCustomItem ? [addToCustomItem] : []))
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

function tuneRelativeChannel(e, delta, reason) {
  if (!filtered.length) return
  const currentIdx = currentlyPlayingId != null
    ? filtered.findIndex((channel) => channel.id === currentlyPlayingId)
    : -1
  const nextIdx = stepChannelIndex(currentIdx, filtered.length, delta)
  if (nextIdx == null) return
  const channel = filtered[nextIdx]
  if (!channel) return
  e.preventDefault()
  focusByIdx(nextIdx)
  play(channel.id, channel.name, reason)
}

document.addEventListener("keydown", (e) => {
  // AltGr reports as Ctrl+Alt on Windows; `\` needs AltGr on many layouts (e.g. German AltGr+ß).
  const isAltGrBackslash = e.ctrlKey && e.altKey && !e.metaKey && e.key === "\\"
  if ((e.ctrlKey || e.altKey || e.metaKey) && !isAltGrBackslash) return
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
    tuneRelativeChannel(e, e.key === "]" ? 1 : -1, "user")
    return
  }

  const channelKeyDelta = channelKeyDirection(e.key, e.keyCode)
  if (channelKeyDelta != null) {
    tuneRelativeChannel(e, channelKeyDelta, "channel-key")
    return
  }

  if (e.key === "\\") {
    if (!filtered.length || previousPlayingId == null) return
    const lastIdx = filtered.findIndex((channel) => channel.id === previousPlayingId)
    if (lastIdx === -1) return
    const channel = filtered[lastIdx]
    e.preventDefault()
    focusByIdx(lastIdx)
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
      if (vjs.isFullscreen?.()) vjs.exitFullscreen?.()
      else vjs.requestFullscreen?.()
      return
    }
    case "j":
    case "l":
    case "MediaRewind":
    case "MediaFastForward": {
      e.preventDefault()
      const isRewind = lower === "j" || lower === "MediaRewind"
      const deltaMs = isRewind ? -10_000 : 10_000
      const channel = all.find((entry) => entry.id === currentlyPlayingId)
      const isArchiveChannel = channel ? channelSupportsCatchup(channel) : false
      if (catchupSession || isArchiveChannel) {
        // Fast-forward at the live edge with nothing pending must not start a session.
        if (!catchupSession && deltaMs > 0 && pendingSeekTargetUtcMs == null) return
        const nowUtcMs = Date.now()
        const currentAbsoluteMs = catchupSession
          ? catchupSession.timelineStartUtcMs + (vjs.currentTime() || 0) * 1000
          : nowUtcMs
        const profile = catchupSession?.profile ?? provisionalStreamProfile(channel)
        const catchupWindowMs = catchupWindowDays(channel) * 24 * 60 * 60 * 1000
        pendingSeekTargetUtcMs = applySeekStep(pendingSeekTargetUtcMs, currentAbsoluteMs, deltaMs, {
          nowUtcMs,
          catchupWindowMs,
          profile,
        })
        renderPendingSeekHint(pendingSeekTargetUtcMs)
        commitPendingSeek()
        return
      }
      const delta = isRewind ? -10 : 10
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

/** Shows the D-pad rewind/forward target while presses accumulate before the debounced commit; falls back to the session readout once cleared. */
function renderPendingSeekHint(targetUtcMs: number | null): void {
  if (targetUtcMs != null) {
    showTimeshiftChip([t("timeshift.seekingTo", { time: formatWallClock(targetUtcMs) })])
    return
  }
  renderTimeshiftChip()
}

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
  // Rows print "Ch 27329 (#1467807)", so digits-only queries also match chno and id.
  const numericQuery = /^\d+$/.test((searchEl.value || "").trim())
    ? (searchEl.value || "").trim()
    : null

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
      const categories = Array.isArray(ch.categories) && ch.categories.length ? ch.categories : [ch.category || ""]
      if (activeCat && !categories.includes(activeCat)) return false
      return categories.some((category) => picker.categoryPassesFilter(category))
    })
  }

  /** @type {Map<number, number> | null} */
  let scoreById = null
  if (tokens.length) {
    scoreById = new Map()
    const scored = []
    for (const channel of out) {
      let score = scoreNormMatch(channel.norm, tokens)
      if (numericQuery) {
        const idText = String(channel.id)
        const chnoText = channel.chno != null ? String(channel.chno) : ""
        if (idText === numericQuery || chnoText === numericQuery) {
          // Exact number hit outranks any name match.
          score = Math.max(score, 1000)
        } else if (
          idText.startsWith(numericQuery) ||
          (chnoText && chnoText.startsWith(numericQuery))
        ) {
          score = Math.max(score, 500)
        }
      }
      if (score > 0) {
        scored.push(channel)
        scoreById.set(channel.id, score)
      }
    }
    out = scored
  }

  const sortMode = activePlaylistId
    ? getViewSort(activePlaylistId, "live")
    : "default"
  out = sortChannelsForView(out, sortMode, scoreById)

  listStatus.textContent = `${out.length.toLocaleString()} of ${all.length.toLocaleString()} channels`
  mountVirtualList(out)
}

searchEl?.addEventListener("input", debounce(applyFilter, 160))

const sortEl = /** @type {HTMLSelectElement|null} */ (
  document.getElementById("channel-sort")
)
function syncSortControl() {
  if (!sortEl || !activePlaylistId) return
  sortEl.value = getViewSort(activePlaylistId, "live")
}
sortEl?.addEventListener("change", () => {
  if (!activePlaylistId || !sortEl) return
  setViewSort(activePlaylistId, "live", sortEl.value)
  applyFilter()
})

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
  let catchupStartUtcMs = null
  let catchupStopUtcMs = null
  let catchupTitle = ""
  let catchupId = null
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get("channel")
    if (raw) id = Number(raw)
    const rawStart = params.get("cstart")
    const rawStop = params.get("cstop")
    if (rawStart && rawStop) {
      const start = Number(rawStart)
      const stop = Number(rawStop)
      if (Number.isFinite(start) && Number.isFinite(stop) && stop > start) {
        catchupStartUtcMs = start
        catchupStopUtcMs = stop
      }
    }
    catchupTitle = params.get("ctitle") || ""
    catchupId = params.get("cid") || null
  } catch {}
  if (!Number.isFinite(id) || id == null) return
  autoplayConsumed = true
  const ch = all.find((c) => c.id === id)
  if (!ch) return
  // Strip the deep-link params so refresh doesn't re-trigger.
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete("channel")
    url.searchParams.delete("cstart")
    url.searchParams.delete("cstop")
    url.searchParams.delete("ctitle")
    url.searchParams.delete("cid")
    window.history.replaceState({}, "", url.toString())
  } catch {}

  if (!filtered.some((channel) => channel.id === id)) {
    picker.setActiveCat("", { silent: true })
    if (searchEl && searchEl.value) searchEl.value = ""
    applyFilter()
  }

  if (
    catchupStartUtcMs != null &&
    catchupStopUtcMs != null &&
    isCatchupPlayable(ch, catchupStartUtcMs, Date.now())
  ) {
    void playCatchup(ch, {
      startUtcMs: catchupStartUtcMs,
      stopUtcMs: catchupStopUtcMs,
      title: catchupTitle,
      catchupId,
    })
  } else {
    play(ch.id, ch.name)
  }
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
  syncSortControl()
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
      if (isCustomHost(creds.host)) {
        const { ensureLive } = await import("@/scripts/lib/catalog.js")
        const data = await ensureLive(creds, active._id)
        indexDirectUrls(data)
        categoryMap = null
        paintChannels(data, false, 0)
        return
      }
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
          return parseM3U(text).filter((x) => x.url && x.name)
        }
      )
      indexDirectUrls(data)
      categoryMap = null
      if (m3uEpgUrls.length) {
        try {
          localStorage.setItem(`xt_m3u_epg:${active._id}`, m3uEpgUrls.join(","))
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
              chno: Number(ch.num) || undefined,
              norm: normalize(name + " " + category),
              tvArchive: Number(ch.tv_archive) || 0,
              tvArchiveDuration: Number(ch.tv_archive_duration) || 0,
            }
          })
          .filter((x) => x.id && x.name)
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
let embeddedPlayerBackend = null
let playSeq = 0
let lastPlayContext = null
let playerInsights = null
// Detach for the auto-hiding quality chip overlaid on the player edge - rebuilt every tune.
let qualityChipDetach = null

function getPlayerInsights() {
  if (!playerInsights) {
    playerInsights = attachPlayerInsights({
      getHandle: () => vjs,
      getContainer: () => getPlayerWrap(),
      backendLabel: () => embeddedPlayerBackend || getPlayerBackend(),
      sessionKind: "live",
      isSuppressed: () => getPlayerWrap()?.dataset.radioMode === "on",
    })
  }
  return playerInsights
}
// ffmpeg audio-transcode proxy state - desktop only, cached at boot.
let audioProxyAvailable = false
// Streams queued to remount through the proxy once (watchdog / failure-panel fix), consumed on the next play().
const audioProxyOneShotFixSet = new Set()
// Streams that hit a mid-play proxy error this session - never retried through the proxy again, to avoid a fallback loop.
const audioProxyBypassSet = new Set()
// Streams already auto-attempted through the proxy on a start failure this session - a start failure is a one-shot try, not a retry loop.
const audioProxyAutoAttemptedSet = new Set()

// Per-channel budget for black-screen native re-tunes (macOS GDR latch retries).
const nativeRelatchAttempts = new Map()

// Channels hls.js can't serve in this WebView (AC-3 audio, or a container its demuxer can't read)
// remount on native AVFoundation. Persisted per playlist: the cause is stable, and module state
// dies on every page navigation, so a plain Set would re-pay the hls.js detour.
const NATIVE_HLS_FALLBACK_KEY = "xt_native_hls_fallback"
const LEGACY_NATIVE_AUDIO_FALLBACK_KEY = "xt_native_audio_fallback"
let nativeHlsFallbackCache = null

function loadNativeHlsFallbackSet() {
  if (nativeHlsFallbackCache && nativeHlsFallbackCache.playlistId === activePlaylistId) {
    return nativeHlsFallbackCache.ids
  }
  let ids = new Set()
  try {
    const raw =
      localStorage.getItem(`${NATIVE_HLS_FALLBACK_KEY}:${activePlaylistId}`) ??
      localStorage.getItem(`${LEGACY_NATIVE_AUDIO_FALLBACK_KEY}:${activePlaylistId}`)
    if (raw) ids = new Set(JSON.parse(raw))
  } catch {}
  nativeHlsFallbackCache = { playlistId: activePlaylistId, ids }
  return ids
}

function isNativeHlsFallbackChannel(id) {
  return loadNativeHlsFallbackSet().has(id)
}

function rememberNativeHlsFallbackChannel(id) {
  const ids = loadNativeHlsFallbackSet()
  if (ids.has(id)) return
  ids.add(id)
  try {
    localStorage.setItem(`${NATIVE_HLS_FALLBACK_KEY}:${activePlaylistId}`, JSON.stringify([...ids]))
  } catch {}
}

// Channels whose raw-TS audio can't decode are pinned to the m3u8 container instead (where the
// HLS audio fallbacks apply); persisted per playlist like the native-HLS-fallback set above.
let m3u8ContainerFallbackCache = null

function loadM3u8ContainerFallbackSet() {
  if (m3u8ContainerFallbackCache && m3u8ContainerFallbackCache.playlistId === activePlaylistId) {
    return m3u8ContainerFallbackCache.ids
  }
  let ids = new Set()
  try {
    const raw = localStorage.getItem(`xt_m3u8_container_fallback:${activePlaylistId}`)
    if (raw) ids = new Set(JSON.parse(raw))
  } catch {}
  m3u8ContainerFallbackCache = { playlistId: activePlaylistId, ids }
  return ids
}

function isM3u8ContainerFallbackChannel(id) {
  return loadM3u8ContainerFallbackSet().has(id)
}

function rememberM3u8ContainerFallbackChannel(id) {
  const ids = loadM3u8ContainerFallbackSet()
  if (ids.has(id)) return
  ids.add(id)
  try {
    localStorage.setItem(`xt_m3u8_container_fallback:${activePlaylistId}`, JSON.stringify([...ids]))
  } catch {}
}
// Capped so a channel that keeps stalling right after retune bypasses the proxy instead of retuning forever.
const audioProxyStallRetuneCounts = new Map()
const AUDIO_PROXY_MAX_STALL_RETUNES = 2
audioTranscodeAvailable()
  .then((available) => {
    audioProxyAvailable = available
    log.log("[xt:livetv] audio transcode proxy available:", available)
  })
  .catch(() => {})
onAudioTranscodeError((payload) => handleAudioProxyError(payload))
// A custom ffmpeg path saved in Settings should take effect on Live TV without a restart.
document.addEventListener(SETTINGS_EVENT, (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail
  if (!detail || detail.key !== "ffmpegPath") return
  refreshAudioTranscodeAvailability()
    .then((available) => {
      audioProxyAvailable = available
      log.log("[xt:livetv] audio transcode proxy availability refreshed:", available)
    })
    .catch(() => {})
})
let tuningOverlaySentinel = null
let stallSentinel = null
let bufferingShownAt = 0
let bufferingHideTimer = null
let timeshiftChipLastUpdateAt = 0
let timeshiftChipControlsActive = true
let timeshiftChipIdleTimer: ReturnType<typeof setTimeout> | null = null
let timeshiftActivityTrackingArmed = false
let embeddedPlayerLiveUi = true
let focusKeeperCleanup: (() => void) | null = null
/** Active catch-up/timeshift (replay) session, or null when tuned to live. */
let catchupSession: {
  kind: "programme" | "timeshift"
  channelId: number
  channelName: string
  title: string
  startUtcMs: number
  stopUtcMs: number
  /** resolution.effectiveStartUtcMs - where the mounted stream actually begins. */
  mountedStartUtcMs: number
  /** Media-timeline zero. For programme replays this stays at the programme start across mid-programme remounts, so position N seconds = timelineStartUtcMs + N*1000. */
  timelineStartUtcMs: number
  /** Full-programme-span timeline end (non-terminating streams on a still-airing window only); null keeps the elapsed-so-far bar. */
  timelineStopUtcMs: number | null
  /** Programme-specific `catchup-id` from XMLTV, when the provider needs one. */
  catchupId: string | null
  /** Terminates/granularity shape for this session's stream; gates seek/resume/auto-advance thresholds. */
  profile: StreamProfile
} | null = null
/** Bumped by every play()/playCatchup() call so a slow-resolving catch-up probe can detect it's been superseded and bail without clobbering whatever the user tuned to since. */
let catchupRequestSeq = 0
// The embedded player handle is reused across catchup->catchup remounts, so one-shot listeners from a superseded mount are tracked and cleared.
let catchupLoadedMetadataHandler: (() => void) | null = null
let catchupEndedHandler: (() => void) | null = null
// Consecutive short auto-advanced segments trip a no-Range-server remount loop back to live.
let catchupConsecutiveShortAdvances = 0
// Where the previous catch-up mount ended; a repeat at the same instant means the archive is exhausted there.
let catchupLastEndedAbsUtcMs: number | null = null
// Archive files often stop a few seconds short of the EPG stop time.
const CATCHUP_PROGRAMME_END_SLACK_MS = 10_000
// Drives the ghost-region CSS var + programme rollover for a full-span session; cleared/recreated with the session.
let liveEdgeTickTimer: ReturnType<typeof setInterval> | null = null
// How far past a full-span timeline's stop the live playhead can drift before rolling over to the next programme.
const TIMELINE_ROLLOVER_SLACK_MS = 2000
// Caps automatic (error/stall) session re-mounts so a persistently failing archive URL still escalates to the failure panel.
let catchupAutoRetryCount = 0
const CATCHUP_MAX_AUTO_RETRIES = 2
// Retry budget refills only after sustained playback; an instant reset on "playing" lets a plays-briefly-then-dies source loop forever.
let catchupRetryResetTimer: ReturnType<typeof setTimeout> | null = null
const CATCHUP_RETRY_RESET_AFTER_MS = 30_000
// Native-bar seeks outside the buffer re-request the stream; these track the interceptor.
let catchupSeekingEl: HTMLVideoElement | null = null
let catchupSeekingHandler: (() => void) | null = null
let catchupProgrammaticSeekUntilMs = 0
// Caps seek-triggered remounts so a seek landing outside the buffer on every attempt can't loop forever.
let catchupSeekRemountCount = 0
const CATCHUP_MAX_SEEK_REMOUNTS = 3
// Accumulated J/L archive rewind/forward taps; committed to a seek after a short pause.
let pendingSeekTargetUtcMs: number | null = null
const commitPendingSeek = debounce(() => {
  const target = pendingSeekTargetUtcMs
  pendingSeekTargetUtcMs = null
  // Clear the readout even when the committed seek gets swallowed, or it sticks on live.
  renderPendingSeekHint(null)
  if (target != null) void seekToAbsolute(target)
}, 800)
// Recorded on pause so resume can decide whether to re-seek or retune.
let pausedAtAbsUtcMs: number | null = null
let pausedWasLive = false
// HTMLMediaElement pause() queues its event as a task, so a boolean flag would already be reset when the listener runs.
let suppressPauseTrackingUntilMs = 0
const TUNING_MAX_MS = 8000
// Catch-up resolve can probe several timeshift URL variants in sequence; give it room to finish before the overlay gives up.
const CATCHUP_TUNING_MAX_MS = 22_000
const STALL_AUTO_TUNE_MS = 30_000
const BUFFERING_GRACE_MS = 350
const ERROR_AUTO_RETRY_MS = 1500
const TIMESHIFT_CHIP_UPDATE_MS = 1000
const TIMESHIFT_CHIP_LIVE_THRESHOLD_MS = 15_000
const TIMESHIFT_CHIP_IDLE_MS = 3000

// Per-stream diagnostic cooldown
const AUTO_DIAGNOSTIC_COOLDOWN_MS = 30_000
const lastAutoDiagnosticAt = new Map()

async function runAutoDiagnostic(ctx, dismissGenericToast) {
  if (!ctx?.streamId || !ctx.src) return

  // Media info arrived, so the stream was reachable - a decode failure isn't a network problem.
  const info = vjs?.codecInfo?.()
  if (info?.videoCodec || info?.audioCodec) {
    try { dismissGenericToast?.() } catch {}
    return
  }

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
    if (applyDiagnosticToFailurePanel(ctx.seq, verdict, reason)) return
    try { dismissGenericToast?.() } catch {}
    toastError(
      t("stream.error.cantPlay", { channel: ctx.name || `#${ctx.streamId}` }),
      { description: reason, duration: 8000 }
    )
  } catch (e) {
    log.warn("[xt:livetv] auto-diagnostic failed:", e)
  }
}

// Video.js's dispose() removes the whole `#player` element rather than restoring it; keep a pristine clone to reinsert on remount.
let playerElementTemplate: HTMLElement | null = null

function ensurePlayerElement(): HTMLElement | null {
  const existing = document.getElementById("player")
  if (existing) {
    if (!playerElementTemplate) playerElementTemplate = existing.cloneNode(true) as HTMLElement
    return existing
  }
  if (!playerElementTemplate) return null
  const wrap = document.getElementById("player-wrap")
  if (!wrap) return null
  const fresh = playerElementTemplate.cloneNode(true) as HTMLElement
  const radioDisplay = document.getElementById("radio-display")
  if (radioDisplay) wrap.insertBefore(fresh, radioDisplay)
  else wrap.appendChild(fresh)
  return fresh
}

// Serializes ensureEmbeddedPlayer() calls so a superseded caller can't dispose+remount over a mount a newer caller already started.
let ensureEmbeddedPlayerInFlight = null

const ensureEmbeddedPlayer = async (backend, opts = {}) => {
  for (;;) {
    const inFlight = ensureEmbeddedPlayerInFlight
    if (!inFlight) break
    await inFlight.catch(() => {})
  }
  const attempt = (async () => {
    const wantLiveUi = opts.liveui ?? true
    if (vjs) {
      if (embeddedPlayerLiveUi === wantLiveUi) return vjs
      // Mode changed (live <-> catch-up needs a different control bar) - dispose and remount fresh below;
      // awaited because Shaka restores the original #player element asynchronously.
      try { await vjs.dispose?.() } catch {}
      vjs = null
      if (focusKeeperCleanup) {
        focusKeeperCleanup()
        focusKeeperCleanup = null
      }
    }
    return mountEmbeddedPlayer(backend, opts)
  })()
  ensureEmbeddedPlayerInFlight = attempt
  try {
    return await attempt
  } finally {
    if (ensureEmbeddedPlayerInFlight === attempt) ensureEmbeddedPlayerInFlight = null
  }
}

/** Shared "nothing left to try" path for a play attempt: native handoff, failure panel, or a generic toast, depending on how far playback got. */
function giveUpOnPlayback(ctx) {
  hideTuningOverlay()
  hideBufferingChip()
  clearStallSentinel()
  clearDeadVideoWatchdog()
  clearDeadAudioWatchdog()
  clearStartWedgeWatch()
  // "playing" can fire before an undecodable audio track kills the mount, so classify every terminal path.
  const info = vjs?.codecInfo?.() || { videoCodec: null, audioCodec: null, errorDetail: null }
  const failure = classifyStartFailure({
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec,
    errorDetail: info.errorDetail,
    nameHint: hasHevcNameHint(ctx.name),
    deviceHevc: deviceSupportsHevc(),
    audioClockWedge: !!ctx.audioClockWedge,
  })
  log.info("[xt:livetv] start-failure verdict", { kind: failure.kind, codec: failure.codec, streamId: ctx.streamId })
  getPlayerInsights().record("giveup", failure.kind)
  // Bypasses getAndroidNativePlayerEnabled() on purpose: one-shot recovery, not the opt-in setting.
  if (!ctx.started && !ctx.nativeFallbackTried && androidNativePlayerAvailable) {
    ctx.nativeFallbackTried = true
    if (
      failure.kind === "hevc" ||
      failure.kind === "codec" ||
      failure.kind === "audio" ||
      failure.kind === "parse"
    ) {
      toast({ title: t("stream.failure.nativeFallback") })
      launchNativeLiveSession(ctx.streamId, ctx.name).then((launched) => {
        if (launched) return
        showPlaybackFailurePanel(ctx)
        runAutoDiagnostic(ctx, null)
      })
      return
    }
  }
  // MSE lacks a decoder here and the native fallbacks can't demux bare TS; Xtream serves the
  // same channel as m3u8, so retune there instead.
  if (
    failure.kind === "audio" &&
    ctx.isLive &&
    creds?.liveContainer === "ts" &&
    /\.ts(\?|$)/i.test(String(ctx.src || "")) &&
    !isM3u8ContainerFallbackChannel(ctx.streamId)
  ) {
    rememberM3u8ContainerFallbackChannel(ctx.streamId)
    log.warn("[xt:livetv] raw-TS stream failed with undecodable audio - retuning with the m3u8 container", {
      streamId: ctx.streamId,
      codec: failure.codec,
    })
    void play(ctx.streamId, ctx.name, "auto:m3u8-container-fallback")
    return
  }
  // WKWebView MSE has no AC-3 decoder and its demuxer gives up on mid-stream container
  // changes; AVFoundation handles both. The ffmpeg proxy is no answer for HLS sources.
  if (
    // AVFoundation needs a manifest, so a bare-TS parse failure has nothing to hand it.
    (failure.kind === "audio" || (failure.kind === "parse" && isHlsSource(ctx.src))) &&
    isMacOS &&
    isTauri &&
    ctx.isLive &&
    !ctx.audioProxied &&
    !isNativeHlsFallbackChannel(ctx.streamId)
  ) {
    rememberNativeHlsFallbackChannel(ctx.streamId)
    log.warn(
      failure.kind === "parse"
        ? "[xt:livetv] hls.js cannot demux this stream - remounting on native AVFoundation"
        : "[xt:livetv] AC-3 audio cannot decode in this WebView's MSE - remounting on native AVFoundation",
      { streamId: ctx.streamId, codec: failure.codec }
    )
    void play(ctx.streamId, ctx.name, "auto:native-hls-fallback")
    return
  }
  // Independent of getAudioTranscodeAuto(), which only gates the mid-play watchdog.
  if (
    failure.kind === "audio" &&
    canUseAudioProxy(ctx) &&
    !ctx.audioProxied &&
    !audioProxyAutoAttemptedSet.has(ctx.streamId)
  ) {
    audioProxyAutoAttemptedSet.add(ctx.streamId)
    toast({ title: t("stream.audioFix.fixing"), duration: 4000 })
    fixAudioNow(ctx)
    return
  }
  // Proxied mount itself failed - bypass it so the panel/diagnostic doesn't offer Fix audio again.
  if (failure.kind === "audio" && ctx.audioProxied) {
    audioProxyBypassSet.add(ctx.streamId)
  }
  if (!ctx.started) {
    showPlaybackFailurePanel(ctx)
    runAutoDiagnostic(ctx, null)
    return
  }
  const dismissGeneric = toastError(
    t("stream.error.cantPlay", { channel: ctx.name || `#${ctx.streamId}` }),
    {
      description: shouldWarnHevc(ctx.name)
        ? t("stream.error.hevcHint")
        : t("stream.error.checkConnection"),
    }
  )
  // Background diagnostic: turn the generic "couldn't play" toast into an
  // actionable one ("HLS playlist returned 403", "Server unreachable",
  // "Top variant manifest empty", etc.) once we have a verdict. Cooldown
  // per stream-id so a flapping channel doesn't fire repeated probes.
  runAutoDiagnostic(ctx, dismissGeneric)
}

async function mountEmbeddedPlayer(backend, opts) {
  const wantLiveUi = opts.liveui ?? true
  const videoEl = ensurePlayerElement()
  if (!videoEl) return null
  // Hide Video.js's built-in PiP toggle on Tauri Android - the WebView
  // doesn't expose Web PiP so the button always renders disabled. Native
  // PiP goes through the in-page button + AndroidPip bridge instead.
  const hasNativePipBridge = !!window.AndroidPip
  const mounted = await mountPlayer(videoEl, backend, {
    liveui: wantLiveUi,
    fluid: true,
    preload: "auto",
    autoplay: false,
    aspectRatio: "16:9",
    pictureInPictureToggle: !hasNativePipBridge,
    controlBar: {
      volumePanel: { inline: false },
      pictureInPictureToggle: !hasNativePipBridge,
      playbackRateMenuButton: !wantLiveUi,
      fullscreenToggle: true,
    },
  })
  if (mounted.kind !== "embedded") return null
  vjs = mounted.handle
  embeddedPlayerBackend = mounted.backend
  embeddedPlayerLiveUi = wantLiveUi

  if (mounted.backend === "videojs") {
    focusKeeperCleanup = attachPlayerFocusKeeper(vjs)
  }
  bindAutoPip(vjs)
  attachAudioOnlyDetection(vjs)

  vjs.on("playing", () => {
    {
      const mediaEl = vjs.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
      log.info("[xt:livetv] playing", {
        streamId: lastPlayContext?.streamId ?? null,
        t: Math.round((mediaEl?.currentTime || 0) * 10) / 10,
        videoWidth: mediaEl?.videoWidth ?? null,
        frames: mediaEl ? decodedFrameCount(mediaEl) : null,
        dropped: mediaEl ? droppedFrameCount(mediaEl) : null,
        proxied: !!lastPlayContext?.audioProxied,
      })
    }
    ensureProgressWatch()
    if (lastPlayContext) {
      lastPlayContext.started = true
      if (lastPlayContext.audioProxied) {
        rememberAudioTranscodeChannel(activePlaylistId, String(lastPlayContext.streamId))
      }
    }
    if (catchupRetryResetTimer) clearTimeout(catchupRetryResetTimer)
    const streamIdAtPlaying = lastPlayContext?.streamId
    catchupRetryResetTimer = setTimeout(() => {
      catchupAutoRetryCount = 0
      catchupSeekRemountCount = 0
      if (streamIdAtPlaying != null) audioProxyStallRetuneCounts.delete(streamIdAtPlaying)
      if (streamIdAtPlaying != null) liveStallRetuneCounts.delete(streamIdAtPlaying)
    }, CATCHUP_RETRY_RESET_AFTER_MS)
    hideTuningOverlay()
    hideBufferingChip()
    clearStallSentinel()
    hidePlaybackFailurePanel()
    armDeadVideoWatchdog()
    armDeadAudioWatchdog()
  })
  vjs.on("waiting", () => {
    log.info("[xt:livetv] waiting (buffer underrun)", { streamId: lastPlayContext?.streamId ?? null })
    showBufferingChip()
    armStallSentinel()
  })
  vjs.on("timeupdate", () => {
    if (!catchupSession || pendingSeekTargetUtcMs != null) return
    const now = Date.now()
    if (now - timeshiftChipLastUpdateAt < TIMESHIFT_CHIP_UPDATE_MS) return
    timeshiftChipLastUpdateAt = now
    renderTimeshiftChip()
  })
  ensureTimeshiftActivityTracking()
  vjs.on("stalled", () => {
    log.info("[xt:livetv] stalled (no data arriving)", { streamId: lastPlayContext?.streamId ?? null })
    showBufferingChip()
    armStallSentinel()
  })
  vjs.on("pause", () => {
    if (Date.now() < suppressPauseTrackingUntilMs) return
    if (!lastPlayContext?.started) return
    const mediaEl = vjs.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
    // The browser fires pause right before ended - don't record that as a user pause.
    if (mediaEl?.ended) return
    pausedWasLive = !catchupSession
    pausedAtAbsUtcMs = catchupSession
      ? catchupSession.timelineStartUtcMs + (vjs.currentTime() || 0) * 1000
      : Date.now()
  })
  vjs.on("play", () => {
    if (pausedAtAbsUtcMs == null) return
    const pausedAbsUtcMs = pausedAtAbsUtcMs
    pausedAtAbsUtcMs = null
    const channel = all.find((entry) => entry.id === (catchupSession?.channelId ?? currentlyPlayingId))
    if (!channel) return
    const mediaEl = vjs.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
    const currentTimeSeconds = vjs.currentTime?.() || 0
    let bufferedAheadMs = 0
    const buffered = mediaEl?.buffered
    if (buffered) {
      for (let i = 0; i < buffered.length; i++) {
        if (currentTimeSeconds >= buffered.start(i) - 1 && currentTimeSeconds <= buffered.end(i) + 1) {
          bufferedAheadMs = Math.max(0, (buffered.end(i) - currentTimeSeconds) * 1000)
          break
        }
      }
    }
    const action = resumeAction({
      pausedAbsUtcMs,
      nowUtcMs: Date.now(),
      bufferedEndAbsUtcMs: pausedAbsUtcMs + bufferedAheadMs,
      wasLive: pausedWasLive,
      archiveCapable: channelSupportsCatchup(channel),
      profile: catchupSession?.profile ?? provisionalStreamProfile(channel),
    })
    if (action === "reseek") {
      void seekToAbsolute(pausedAbsUtcMs, { forceRemount: true })
    } else if (action === "live") {
      void play(channel.id, channel.name)
    }
  })
  vjs.on("error", () => {
    const ctx = lastPlayContext
    if (!ctx) return
    if (catchupRetryResetTimer) {
      clearTimeout(catchupRetryResetTimer)
      catchupRetryResetTimer = null
    }
    const err = vjs.error?.()
    log.error("[xt:livetv] player error", {
      code: err?.code,
      message: err?.message,
      streamId: ctx.streamId,
    })
    getPlayerInsights().record("error", `${err?.code ?? "?"} ${err?.message ?? ""}`.trim())
    // Stops a timer armed by an earlier "playing" from firing against the mount we're replacing.
    clearDeadVideoWatchdog()
    clearDeadAudioWatchdog()
    if (!ctx.retried) {
      ctx.retried = true
      const seqAtRetry = ctx.seq
      setTimeout(() => {
        if (seqAtRetry !== playSeq) return
        if (retryCatchupSession(ctx, { automatic: true })) return
        if (!ctx.isLive) {
          // Retry budget exhausted (or no session to resume) - the archive URL is now stale, so escalate instead of replaying it.
          giveUpOnPlayback(ctx)
          return
        }
        if (ctx.audioProxied) {
          retuneProxiedAudioMount(ctx)
          return
        }
        // The same demuxer on the same container fails the same way; escalate to the verdict instead.
        if (isParseFailureDetail(vjs?.codecInfo?.()?.errorDetail)) {
          giveUpOnPlayback(ctx)
          return
        }
        try {
          vjs.reset?.()
          vjs.src({
            src: ctx.src,
            type: ctx.mime || "application/x-mpegURL",
            isLive: ctx.isLive ?? true,
            preferNativeHls: isNativeHlsFallbackChannel(ctx.streamId),
          })
          vjs.play().catch(() => {})
        } catch {}
      }, ERROR_AUTO_RETRY_MS)
      return
    }
    giveUpOnPlayback(ctx)
  })

  return vjs
}

/** Channel ID currently rendered in radio mode (-1 = none). */
let radioModeChannelId: number | null = null
let radioElapsedTimer: ReturnType<typeof setInterval> | null = null
let radioIcyAbort: AbortController | null = null

function getPlayerWrap(): HTMLElement | null {
  return document.getElementById("player-wrap")
}

function fmtElapsed(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

const RADIO_CHIP_CLASS =
  "inline-flex items-center rounded-md bg-surface-2 ring-1 ring-line px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-fg-2"

function radioCodecFromUrl(url: string): string | null {
  const lower = url.toLowerCase()
  if (/\b(aac|m4a)\b/.test(lower)) return "AAC"
  if (/\bopus\b/.test(lower)) return "Opus"
  if (/\b(ogg|vorbis)\b/.test(lower)) return "OGG"
  if (/\bflac\b/.test(lower)) return "FLAC"
  if (/\b(mp3|mpeg)\b/.test(lower)) return "MP3"
  return null
}

function renderRadioTags(wrap: HTMLElement, genre: string | null, quality: string | null) {
  const tags = wrap.querySelector<HTMLElement>("[data-radio-tags]")
  const row = wrap.querySelector<HTMLElement>("[data-radio-metarow]")
  if (!tags || !row) return
  const chips: string[] = []
  if (genre) chips.push(`<span class="${RADIO_CHIP_CLASS}">${escapeHtml(genre)}</span>`)
  if (quality) chips.push(`<span class="${RADIO_CHIP_CLASS}">${escapeHtml(quality)}</span>`)
  tags.innerHTML = chips.join("")
  row.hidden = false
}

function startRadioElapsed(wrap: HTMLElement) {
  if (radioElapsedTimer) clearInterval(radioElapsedTimer)
  const elapsedWrap = wrap.querySelector<HTMLElement>("[data-radio-elapsed]")
  const timeEl = wrap.querySelector<HTMLElement>("[data-radio-elapsed-time]")
  if (!elapsedWrap || !timeEl) return
  const startedAt = Date.now()
  const tick = () => { timeEl.textContent = fmtElapsed((Date.now() - startedAt) / 1000) }
  tick()
  elapsedWrap.hidden = false
  wrap.querySelector<HTMLElement>("[data-radio-metarow]")?.removeAttribute("hidden")
  radioElapsedTimer = setInterval(tick, 1000)
}

// ICY response headers carry the real station metadata; browser fetch hides them, tauri-plugin-http does not.
async function fetchRadioIcy(wrap: HTMLElement, channelId: number, url: string, genreFallback: string | null) {
  if (!/^https?:\/\//i.test(url)) return
  radioIcyAbort?.abort()
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null
  radioIcyAbort = controller
  const timer = controller ? setTimeout(() => controller.abort(), 5000) : null
  try {
    const response = await providerFetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      signal: controller?.signal,
    })
    if (radioModeChannelId !== channelId) {
      void response.body?.cancel?.()?.catch?.(() => {})
      return
    }
    const header = (name: string) => (response.headers.get(name) || "").trim() || null
    const contentType = (response.headers.get("content-type") || "").toLowerCase()
    const codec = contentType.includes("aac")
      ? "AAC"
      : contentType.includes("opus")
      ? "Opus"
      : contentType.includes("ogg")
      ? "OGG"
      : contentType.includes("mpeg")
      ? "MP3"
      : radioCodecFromUrl(url)
    const bitrate = header("icy-br")
    const quality = codec ? (bitrate ? `${codec} · ${bitrate}k` : codec) : bitrate ? `${bitrate}k` : null
    renderRadioTags(wrap, header("icy-genre") || genreFallback, quality)
    const description = header("icy-description")
    const descEl = wrap.querySelector<HTMLElement>("[data-radio-desc]")
    if (descEl && description && description.toLowerCase() !== (header("icy-name") || "").toLowerCase()) {
      descEl.textContent = description
      descEl.hidden = false
    }
    void response.body?.cancel?.()?.catch?.(() => {})
  } catch {
    // Offline / probe rejected: keep the client-derived tags.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** opts.probeIcy fetches ICY station tags; only genuine radio entries pay that stream GET. */
function setRadioMode(
  channel: { id: number; name?: string; logo?: string | null; category?: string | null; url?: string | null },
  opts: { probeIcy?: boolean } = {}
) {
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

  const genre = channel.category && channel.category !== t("stream.uncategorized") ? channel.category : null
  const descEl = wrap.querySelector<HTMLElement>("[data-radio-desc]")
  if (descEl) { descEl.textContent = ""; descEl.hidden = true }
  renderRadioTags(wrap, genre, channel.url ? radioCodecFromUrl(channel.url) : null)
  startRadioElapsed(wrap)
  if (channel.url && opts.probeIcy) fetchRadioIcy(wrap, channel.id, channel.url, genre)

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
  if (radioElapsedTimer) { clearInterval(radioElapsedTimer); radioElapsedTimer = null }
  radioIcyAbort?.abort()
  radioIcyAbort = null
  const tags = wrap.querySelector<HTMLElement>("[data-radio-tags]")
  if (tags) tags.innerHTML = ""
  wrap.querySelector<HTMLElement>("[data-radio-metarow]")?.setAttribute("hidden", "")
  wrap.querySelector<HTMLElement>("[data-radio-elapsed]")?.setAttribute("hidden", "")
  const descEl = wrap.querySelector<HTMLElement>("[data-radio-desc]")
  if (descEl) { descEl.textContent = ""; descEl.hidden = true }
  radioModeChannelId = null
}

// Keyed by playlist so an override on one provider can't suppress auto-promotion on another.
const manualAudioOnlyOff = new Set<string>()

function manualAudioOnlyOffKey(streamId: number): string {
  return `${activePlaylistId}:${streamId}`
}

let audioOnlySetCache: { playlistId: string; ids: Set<number> } | null = null

function loadAudioOnlySet(): Set<number> {
  if (audioOnlySetCache && audioOnlySetCache.playlistId === activePlaylistId) {
    return audioOnlySetCache.ids
  }
  let ids = new Set<number>()
  try {
    const raw = localStorage.getItem(`xt_audio_only:${activePlaylistId}`)
    if (raw) ids = new Set(JSON.parse(raw))
  } catch {}
  audioOnlySetCache = { playlistId: activePlaylistId, ids }
  return ids
}

function saveAudioOnlySet(ids: Set<number>) {
  audioOnlySetCache = { playlistId: activePlaylistId, ids }
  try {
    localStorage.setItem(`xt_audio_only:${activePlaylistId}`, JSON.stringify([...ids]))
  } catch {}
}

function isAudioOnlyChannel(id: number): boolean {
  return loadAudioOnlySet().has(id)
}

const CURRENT_ROW_ICON_BTN_CLASS =
  "shrink-0 inline-flex items-center justify-center min-h-11 min-w-11 px-3.5 rounded-xl border border-line bg-surface text-base text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors"

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
  const state = getProgrammesSync(activePlaylistId)
  const { current } = getNowNextForChannel(state?.programmes, channel, activePlaylistId)
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
  const resolveTarget = () => {
    const ctx = lastPlayContext
    if (!ctx) return null
    const wrap = getPlayerWrap()
    if (!wrap || wrap.dataset.radioMode === "on") return null
    const videoEl = wrap.querySelector("video") as HTMLVideoElement | null
    if (!videoEl) return null
    return { ctx, wrap, videoEl }
  }
  const promote = (ctx: NonNullable<typeof lastPlayContext>, videoEl?: HTMLVideoElement) => {
    if (manualAudioOnlyOff.has(manualAudioOnlyOffKey(ctx.streamId))) return
    const channel = all.find((entry) => entry.id === ctx.streamId)
    if (!channel) return
    // Radio mode hides the video element, so a wrong promotion looks like "audio only". Leave a trace.
    log.warn("[xt:livetv] auto-promoting channel to audio-only (radio) mode", {
      streamId: ctx.streamId,
      videoWidth: videoEl?.videoWidth ?? null,
      videoHeight: videoEl?.videoHeight ?? null,
      readyState: videoEl?.readyState ?? null,
      videoTracks:
        videoEl && (videoEl as any).videoTracks
          ? (videoEl as any).videoTracks.length
          : null,
    })
    // Auto-promotion is a guess; never spend a stream request on ICY tags for it.
    setRadioMode(channel, { probeIcy: false })
  }

  // HAVE_FUTURE_DATA proves a zero videoWidth is real: on macOS native HLS,
  // readyState hits 1 seconds before dimensions land, so looser checks hide
  // working video. Audio-only streams still reach readyState 4 with width 0.
  const canActuallyPlay = (videoEl: HTMLVideoElement) => videoEl.readyState >= 3

  if (!isMacOS) {
    const detect = () => {
      const target = resolveTarget()
      if (!target) return
      if (!canActuallyPlay(target.videoEl)) return
      if (target.videoEl.videoWidth === 0 && target.videoEl.videoHeight === 0) {
        promote(target.ctx, target.videoEl)
      }
    }
    handle.on("loadedmetadata", detect)
    handle.on("playing", detect)
    return
  }

  const RADIO_GRACE_MS = 2500
  let pending: ReturnType<typeof setTimeout> | null = null
  const detect = () => {
    const target = resolveTarget()
    if (!target) return
    const { ctx, wrap, videoEl } = target
    if (videoEl.videoWidth > 0 || videoEl.videoHeight > 0) {
      if (pending) { clearTimeout(pending); pending = null }
      return
    }
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      if (wrap.dataset.radioMode === "on") return
      if (videoEl.videoWidth > 0 || videoEl.videoHeight > 0) return
      if (!canActuallyPlay(videoEl)) return
      const tracks = (videoEl as any).videoTracks
      if (tracks && typeof tracks.length === "number" && tracks.length > 0) return
      promote(ctx, videoEl)
    }, RADIO_GRACE_MS)
  }
  handle.on("loadedmetadata", detect)
  handle.on("playing", detect)
  handle.on("resize", detect)
}

// Mirrors openChannelMenu's dismissal + spatial-nav wiring for the now-playing row.
const CURRENT_MORE_MENU_ID = "current-more-menu"
let currentMoreMenuEl: HTMLElement | null = null
let currentMoreMenuTrigger: HTMLButtonElement | null = null
const currentMoreMenuSpatialNav = attachPopoverSpatialNav({
  id: `${CURRENT_MORE_MENU_ID}-section`,
  selector: `#${CURRENT_MORE_MENU_ID} [role^="menuitem"]`,
})

function closeCurrentMoreMenu(restoreFocus = true) {
  if (!currentMoreMenuEl) return
  currentMoreMenuSpatialNav.close()
  currentMoreMenuEl.remove()
  currentMoreMenuEl = null
  document.removeEventListener("pointerdown", onCurrentMoreMenuOutside, true)
  document.removeEventListener("keydown", onCurrentMoreMenuKey, true)
  window.removeEventListener("blur", closeCurrentMoreMenuOnBlur)
  window.removeEventListener("resize", closeCurrentMoreMenuOnBlur)
  const trigger = currentMoreMenuTrigger
  currentMoreMenuTrigger = null
  trigger?.setAttribute("aria-expanded", "false")
  if (restoreFocus) trigger?.focus({ preventScroll: true })
}
function closeCurrentMoreMenuOnBlur() {
  closeCurrentMoreMenu(false)
}
function onCurrentMoreMenuOutside(event: PointerEvent) {
  if (!currentMoreMenuEl) return
  if (currentMoreMenuEl.contains(event.target as Node)) return
  if (currentMoreMenuTrigger?.contains(event.target as Node)) return
  closeCurrentMoreMenu(false)
}
function onCurrentMoreMenuKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault()
    closeCurrentMoreMenu(true)
  }
}

function makeMoreMenuItem(label: string, checked?: boolean): HTMLButtonElement {
  const item = document.createElement("button")
  item.type = "button"
  item.setAttribute("role", checked === undefined ? "menuitem" : "menuitemcheckbox")
  if (checked !== undefined) item.setAttribute("aria-checked", String(checked))
  item.className =
    "w-full flex items-center justify-between gap-3 text-left px-3 py-2.5 min-h-11 rounded-lg text-sm " +
    "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-accent outline-none transition-colors"
  const labelSpan = document.createElement("span")
  labelSpan.textContent = label
  item.appendChild(labelSpan)
  if (checked) {
    const check = document.createElement("span")
    check.className = "shrink-0 inline-flex text-accent"
    check.setAttribute("aria-hidden", "true")
    check.innerHTML = ICON_CHECK
    item.appendChild(check)
  }
  return item
}

function setMoreMenuItemChecked(item: HTMLButtonElement, checked: boolean) {
  item.setAttribute("aria-checked", String(checked))
  item.querySelector("[aria-hidden='true']")?.remove()
  if (checked) {
    const check = document.createElement("span")
    check.className = "shrink-0 inline-flex text-accent"
    check.setAttribute("aria-hidden", "true")
    check.innerHTML = ICON_CHECK
    item.appendChild(check)
  }
}

function buildCurrentMoreMenuItems(streamId, channel, src, name): HTMLButtonElement[] {
  const items: HTMLButtonElement[] = []

  const pipSupported = !!window.AndroidPip || document.pictureInPictureEnabled === true
  if (pipSupported) {
    const pipItem = makeMoreMenuItem(t("detail.action.pip"))
    pipItem.addEventListener("click", () => {
      closeCurrentMoreMenu()
      if (vjs) togglePip(vjs)
    })
    items.push(pipItem)
  }

  const scaleItem = makeMoreMenuItem(t("stream.scale.button"))
  scaleItem.addEventListener("click", () => {
    closeCurrentMoreMenu()
    openDisplayModeDialog(streamId)
  })
  items.push(scaleItem)

  if (!channel?.isRadio) {
    const audioOnlyEffective = isAudioOnlyChannel(streamId) || radioModeChannelId === streamId
    const audioItem = makeMoreMenuItem(t("livetv.audioOnly"), audioOnlyEffective)
    audioItem.addEventListener("click", () => {
      closeCurrentMoreMenu()
      const nowOn = !audioOnlyEffective
      const ids = new Set(loadAudioOnlySet())
      if (nowOn) ids.add(streamId)
      else ids.delete(streamId)
      saveAudioOnlySet(ids)
      if (nowOn) {
        manualAudioOnlyOff.delete(manualAudioOnlyOffKey(streamId))
        setRadioMode(
          { id: streamId, name, logo: channel?.logo ?? null, category: channel?.category ?? null, url: src },
          { probeIcy: !!channel?.isRadio }
        )
        // Audio-only hides the video preview - the quality chip has nothing to report.
        if (qualityChipDetach) {
          qualityChipDetach()
          qualityChipDetach = null
        }
      } else {
        manualAudioOnlyOff.add(manualAudioOnlyOffKey(streamId))
        clearRadioMode()
        // Same mount, just un-hidden - re-attach the overlay chip to the player edge.
        const playerWrap = document.getElementById("player")?.parentElement
        if (playerWrap && vjs) qualityChipDetach = attachQualityChip(playerWrap, vjs)
      }
    })
    items.push(audioItem)
  }

  // Kept open on toggle so users can A/B the effect by ear.
  const monoItem = makeMoreMenuItem(t("settings.monoAudio.title"), getMonoAudioEnabled())
  monoItem.addEventListener("click", () => {
    const nowOn = !getMonoAudioEnabled()
    setMonoAudioEnabled(nowOn)
    setMoreMenuItemChecked(monoItem, nowOn)
  })
  items.push(monoItem)

  const insights = getPlayerInsights()
  const statsItem = makeMoreMenuItem(t("player.stats.title"), insights.isOverlayVisible())
  statsItem.addEventListener("click", () => {
    closeCurrentMoreMenu()
    insights.toggleOverlay()
  })
  items.push(statsItem)

  const healthItem = makeMoreMenuItem(t("stream.health.menu"))
  healthItem.addEventListener("click", () => {
    closeCurrentMoreMenu()
    insights.openHealthDialog()
  })
  items.push(healthItem)

  return items
}

function openCurrentMoreMenu(trigger: HTMLButtonElement, streamId, channel, src, name) {
  closeCurrentMoreMenu(false)

  const menu = document.createElement("div")
  menu.id = CURRENT_MORE_MENU_ID
  menu.className =
    "fixed z-50 min-w-[12rem] rounded-xl border border-line bg-surface text-fg shadow-2xl p-1 flex flex-col gap-0.5 poster-menu-enter"
  menu.setAttribute("role", "menu")
  menu.setAttribute("aria-label", t("livetv.moreActions"))
  menu.append(...buildCurrentMoreMenuItems(streamId, channel, src, name))
  document.body.appendChild(menu)

  const margin = 8
  const rect = menu.getBoundingClientRect()
  const anchorRect = trigger.getBoundingClientRect()
  const left = Math.min(anchorRect.right - rect.width, window.innerWidth - rect.width - margin)
  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - rect.height - margin)
  menu.style.left = `${Math.max(margin, left)}px`
  menu.style.top = `${Math.max(margin, top)}px`

  currentMoreMenuEl = menu
  currentMoreMenuTrigger = trigger
  trigger.setAttribute("aria-expanded", "true")
  currentMoreMenuSpatialNav.open()
  document.addEventListener("pointerdown", onCurrentMoreMenuOutside, true)
  document.addEventListener("keydown", onCurrentMoreMenuKey, true)
  window.addEventListener("blur", closeCurrentMoreMenuOnBlur)
  window.addEventListener("resize", closeCurrentMoreMenuOnBlur)

  menu.querySelector<HTMLButtonElement>("[role^='menuitem']")?.focus({ preventScroll: true })
}

function showTuningOverlay(logoUrl, maxMs = TUNING_MAX_MS) {
  const playerWrap = document.getElementById("player")?.parentElement
  if (!playerWrap) return
  playerWrap.querySelector("[data-tuning-overlay]")?.remove()
  const overlay = document.createElement("div")
  overlay.dataset.tuningOverlay = ""
  overlay.className = "tuning-overlay"
  const plate = document.createElement("div")
  plate.className = "tuning-overlay__plate"
  plate.style.viewTransitionName = "tuning-logo"
  if (logoUrl) {
    const img = document.createElement("img")
    img.src = logoUrl
    img.alt = ""
    img.referrerPolicy = "no-referrer"
    img.decoding = "async"
    plate.appendChild(img)
  }
  overlay.appendChild(plate)
  playerWrap.appendChild(overlay)
  // Cap visibility so we never get stuck on the overlay if `playing` never
  // fires (dead provider, codec issue, render-process crash on Android).
  if (tuningOverlaySentinel) clearTimeout(tuningOverlaySentinel)
  tuningOverlaySentinel = setTimeout(hideTuningOverlay, maxMs)
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
  // Timeshift chip already communicates state; on a narrow player the two pills overlap.
  const timeshiftChip = playerWrap.querySelector("[data-timeshift-chip]")
  if (timeshiftChip && !timeshiftChip.classList.contains("is-hidden")) return
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

function formatWallClock(utcMs: number): string {
  return fmtTime(utcMs / 1000)
}

function showTimeshiftChip(lines: string[]) {
  const playerWrap = document.getElementById("player")?.parentElement
  if (!playerWrap) return
  let chip = playerWrap.querySelector("[data-timeshift-chip]")
  const created = !chip
  if (!chip) {
    chip = document.createElement("div")
    chip.dataset.timeshiftChip = ""
    chip.className = "timeshift-chip"
    chip.setAttribute("role", "status")
    chip.setAttribute("aria-live", "polite")
    playerWrap.appendChild(chip)
  }
  chip.replaceChildren()
  for (const line of lines) {
    const lineEl = document.createElement("div")
    lineEl.className = "timeshift-chip-line"
    lineEl.textContent = line
    chip.appendChild(lineEl)
  }
  if (created) bumpTimeshiftChipActivity()
  else applyTimeshiftChipVisibility()
}

function hideTimeshiftChip() {
  const playerWrap = document.getElementById("player")?.parentElement
  playerWrap?.querySelector("[data-timeshift-chip]")?.remove()
}

function applyTimeshiftChipVisibility() {
  const playerWrap = document.getElementById("player")?.parentElement
  const chip = playerWrap?.querySelector("[data-timeshift-chip]")
  if (!chip) return
  const visible = timeshiftChipControlsActive || pendingSeekTargetUtcMs != null
  chip.classList.toggle("is-hidden", !visible)
}

function bumpTimeshiftChipActivity() {
  timeshiftChipControlsActive = true
  applyTimeshiftChipVisibility()
  if (timeshiftChipIdleTimer) clearTimeout(timeshiftChipIdleTimer)
  timeshiftChipIdleTimer = setTimeout(() => {
    timeshiftChipControlsActive = false
    applyTimeshiftChipVisibility()
  }, TIMESHIFT_CHIP_IDLE_MS)
}

function ensureTimeshiftActivityTracking() {
  if (timeshiftActivityTrackingArmed) return
  const playerWrap = document.getElementById("player")?.parentElement
  if (!playerWrap) return
  timeshiftActivityTrackingArmed = true
  const onActivity = () => bumpTimeshiftChipActivity()
  playerWrap.addEventListener("pointermove", onActivity)
  playerWrap.addEventListener("pointerdown", onActivity)
  playerWrap.addEventListener("wheel", onActivity, { passive: true })
  document.addEventListener("keydown", onActivity)
  bumpTimeshiftChipActivity()
}

/** Wall-clock playhead + behind-live readout for the active catch-up/timeshift session. */
function renderTimeshiftChip() {
  if (!catchupSession || !vjs) {
    hideTimeshiftChip()
    return
  }
  const playheadAbsUtcMs = catchupSession.timelineStartUtcMs + (vjs.currentTime() || 0) * 1000
  const behindMs = Date.now() - playheadAbsUtcMs
  if (behindMs < TIMESHIFT_CHIP_LIVE_THRESHOLD_MS) {
    hideTimeshiftChip()
    return
  }
  showTimeshiftChip([
    formatWallClock(playheadAbsUtcMs),
    t("timeshift.behindLive", { time: formatBehindLive(behindMs) }),
  ])
}

// Off-air feeds stall forever without erroring; bound the re-tune loop.
const LIVE_STALL_RETUNE_MAX = 3
const liveStallRetuneCounts = new Map()

// Shared by the stall sentinel (event-driven) and the progress watch (frozen currentTime).
function performStallRetune(trigger) {
  const ctx = lastPlayContext
  if (!ctx || !vjs) return
  log.warn("[xt:livetv] stalled - re-tuning", { streamId: ctx.streamId, trigger })
  if (retryCatchupSession(ctx, { automatic: true })) return
  if (!ctx.isLive) {
    // Retry budget exhausted (or no session to resume) - the archive URL is now stale, so escalate instead of replaying it.
    giveUpOnPlayback(ctx)
    return
  }
  if (ctx.audioProxied) {
    retuneProxiedAudioMount(ctx)
    return
  }
  const stallAttempts = (liveStallRetuneCounts.get(ctx.streamId) || 0) + 1
  liveStallRetuneCounts.set(ctx.streamId, stallAttempts)
  if (stallAttempts > LIVE_STALL_RETUNE_MAX) {
    log.warn("[xt:livetv] still no data after repeated re-tunes - the feed appears to be down", {
      streamId: ctx.streamId,
      retunes: stallAttempts - 1,
    })
    giveUpOnPlayback(ctx)
    return
  }
  try {
    vjs.reset?.()
    vjs.src({
      src: ctx.src,
      type: ctx.mime || "application/x-mpegURL",
      isLive: ctx.isLive ?? true,
      preferNativeHls: isNativeHlsFallbackChannel(ctx.streamId),
    })
    vjs.play().catch((err) => {
      log.info("[xt:livetv] stall-retune play() rejected", { streamId: ctx.streamId, error: err?.name || String(err) })
    })
  } catch {}
}

function armStallSentinel() {
  if (stallSentinel) clearTimeout(stallSentinel)
  stallSentinel = setTimeout(() => performStallRetune("stall-sentinel"), STALL_AUTO_TUNE_MS)
}

function clearStallSentinel() {
  if (stallSentinel) {
    clearTimeout(stallSentinel)
    stallSentinel = null
  }
}

// ----------------------------
// Playback progress watch
// ----------------------------
// AVFoundation can freeze live playback with no waiting/stalled/error event, so
// the event-armed stall sentinel never sees it. This samples currentTime and
// re-tunes when it stops moving; doubles as the log-file playback heartbeat.
const PROGRESS_WATCH_INTERVAL_MS = 5000
const PROGRESS_FROZEN_TICKS = 2
const PROGRESS_HEARTBEAT_EVERY_TICKS = 6
const FREEZE_RETUNE_MAX_PER_CHANNEL = 3
const freezeRetuneCounts = new Map()
let progressWatchTimer = null
let progressLastTime = -1
let progressLastSeq = -1
let progressFrozenTicks = 0
let progressTickCount = 0

function progressWatchTick() {
  const ctx = lastPlayContext
  if (!ctx || !ctx.isLive || catchupSession || !vjs) {
    progressFrozenTicks = 0
    return
  }
  const wrap = getPlayerWrap()
  if (!wrap || wrap.dataset.radioMode === "on") {
    progressFrozenTicks = 0
    return
  }
  const mediaEl = vjs.getMediaElement?.() ?? wrap.querySelector("video")
  if (!mediaEl || mediaEl.paused || mediaEl.ended || mediaEl.readyState < 2) {
    progressFrozenTicks = 0
    return
  }
  const currentTime = mediaEl.currentTime || 0
  progressTickCount++
  if (progressTickCount % PROGRESS_HEARTBEAT_EVERY_TICKS === 0) {
    log.info("[xt:livetv] heartbeat", {
      streamId: ctx.streamId,
      t: Math.round(currentTime * 10) / 10,
      readyState: mediaEl.readyState,
      frames: decodedFrameCount(mediaEl),
      dropped: droppedFrameCount(mediaEl),
      proxied: !!ctx.audioProxied,
    })
  }
  if (progressLastSeq === playSeq && currentTime === progressLastTime) {
    progressFrozenTicks++
  } else {
    progressFrozenTicks = 0
  }
  progressLastSeq = playSeq
  progressLastTime = currentTime
  if (progressFrozenTicks < PROGRESS_FROZEN_TICKS) return
  progressFrozenTicks = 0
  const attempts = (freezeRetuneCounts.get(ctx.streamId) || 0) + 1
  freezeRetuneCounts.set(ctx.streamId, attempts)
  log.warn("[xt:livetv] playback frozen (currentTime stuck, no stall event fired)", {
    streamId: ctx.streamId,
    t: Math.round(currentTime * 10) / 10,
    readyState: mediaEl.readyState,
    attempt: attempts,
  })
  if (attempts > FREEZE_RETUNE_MAX_PER_CHANNEL) {
    giveUpOnPlayback(ctx)
    return
  }
  performStallRetune("progress-watch")
}

function ensureProgressWatch() {
  if (progressWatchTimer) return
  progressWatchTimer = setInterval(progressWatchTick, PROGRESS_WATCH_INTERVAL_MS)
}

// ----------------------------
// Start-wedge watchdog
// ----------------------------
// Chromium majors where the audio/mpeg wedge was already confirmed once.
const WEDGE_ENGINE_KEY = "xt_mpeg_wedge_engine"
const START_WEDGE_WATCH_INTERVAL_MS = 500
const START_WEDGE_WATCH_MAX_TICKS = 80
const START_WEDGE_CONFIRM_HITS = 8
let startWedgeWatchTimer = null
let startWedgeWatchTicks = 0
let startWedgeWatchHits = 0

function currentChromiumMajor() {
  return chromiumMajorFromUserAgent(typeof navigator !== "undefined" ? navigator.userAgent : null)
}

function isKnownWedgedEngine() {
  const major = currentChromiumMajor()
  if (major == null) return false
  try {
    return localStorage.getItem(WEDGE_ENGINE_KEY) === String(major)
  } catch {
    return false
  }
}

function rememberWedgedEngine() {
  const major = currentChromiumMajor()
  if (major == null) return
  try {
    localStorage.setItem(WEDGE_ENGINE_KEY, String(major))
  } catch {}
}

function clearStartWedgeWatch() {
  if (startWedgeWatchTimer) {
    clearInterval(startWedgeWatchTimer)
    startWedgeWatchTimer = null
  }
}

function armStartWedgeWatch() {
  clearStartWedgeWatch()
  const ctx = lastPlayContext
  if (!ctx || !ctx.isLive || ctx.audioProxied) return
  const seqAtArm = ctx.seq
  startWedgeWatchTicks = 0
  startWedgeWatchHits = 0
  startWedgeWatchTimer = setInterval(() => {
    const current = lastPlayContext
    if (!current || current.seq !== seqAtArm || current.started || !vjs) {
      clearStartWedgeWatch()
      return
    }
    startWedgeWatchTicks++
    if (startWedgeWatchTicks > START_WEDGE_WATCH_MAX_TICKS) {
      clearStartWedgeWatch()
      return
    }
    const mediaEl = vjs.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
    if (!mediaEl || mediaEl.paused || mediaEl.ended) return
    const audioCodec = vjs?.codecInfo?.()?.audioCodec
    // A flagged engine wedges MPEG audio deterministically - codec alone convicts.
    const knownEngine =
      isKnownWedgedEngine() &&
      isMpegAudioCodecString(audioCodec) &&
      mediaEl.readyState < 2 &&
      startWedgeWatchTicks >= 2
    if (!knownEngine) {
      const wedged = isMseAudioClockWedge({
        readyState: mediaEl.readyState,
        currentTime: mediaEl.currentTime || 0,
        bufferedEndSeconds: bufferedEndSeconds(mediaEl),
        audioCodec,
      })
      if (!wedged) {
        startWedgeWatchHits = 0
        return
      }
      startWedgeWatchHits++
      if (startWedgeWatchHits < START_WEDGE_CONFIRM_HITS) return
    }
    clearStartWedgeWatch()
    rememberWedgedEngine()
    current.audioClockWedge = true
    log.warn("[xt:livetv] clock never started despite buffered MPEG audio - convicting the audio track", {
      streamId: current.streamId,
      readyState: mediaEl.readyState,
      knownEngine,
    })
    giveUpOnPlayback(current)
  }, START_WEDGE_WATCH_INTERVAL_MS)
}

// ----------------------------
// Dead-video watchdog
// ----------------------------
// WebView2 sometimes accepts an HEVC stream. `playing` fires, so the
// error path never engages. Catch it by counting decoded frames a few
// seconds into playback. Radio / audio-only channels (videoWidth 0) are
// the audio-only detector's territory and are skipped here.
const DEAD_VIDEO_CHECK_MS = 4000
const DEAD_VIDEO_MAX_CHECKS = 3
const DEAD_VIDEO_MIN_PLAYED_S = 2
let deadVideoTimer = null

function clearDeadVideoWatchdog() {
  if (deadVideoTimer) {
    clearTimeout(deadVideoTimer)
    deadVideoTimer = null
  }
}

function armDeadVideoWatchdog() {
  clearDeadVideoWatchdog()
  const ctx = lastPlayContext
  if (!ctx) return
  const seqAtArm = ctx.seq
  const wrap = getPlayerWrap()
  const videoAtArm = wrap?.querySelector("video")
  if (!videoAtArm) return
  const baselineTime = videoAtArm.currentTime || 0
  let attempts = 0
  const schedule = () => {
    deadVideoTimer = setTimeout(check, DEAD_VIDEO_CHECK_MS)
  }
  const check = () => {
    deadVideoTimer = null
    if (seqAtArm !== playSeq) return
    const currentWrap = getPlayerWrap()
    if (!currentWrap || currentWrap.dataset.radioMode === "on") return
    const video = currentWrap.querySelector("video")
    if (!video || video.paused) return
    const frames = decodedFrameCount(video)
    const dropped = droppedFrameCount(video)
    // Black can mean zero decodes, or a GDR stream decoding and discarding every frame.
    const everyFrameDropped = isDroppingEveryFrame(frames, dropped)
    if (frames === null) return
    if (frames > 0 && !everyFrameDropped) {
      // Too few frames to judge the dropped ratio yet - look again while attempts remain.
      if (frames < DROPPED_FRAME_MIN_SAMPLE && attempts < DEAD_VIDEO_MAX_CHECKS) {
        attempts++
        schedule()
        return
      }
      // Conclusively healthy: restore this channel's re-latch budget.
      nativeRelatchAttempts.delete(ctx.streamId)
      return
    }
    if (video.videoWidth === 0 && video.videoHeight === 0) return
    attempts++
    const playedEnough =
      (video.currentTime || 0) - baselineTime >= DEAD_VIDEO_MIN_PLAYED_S
    if (!playedEnough) {
      if (attempts < DEAD_VIDEO_MAX_CHECKS) schedule()
      return
    }
    log.warn(
      everyFrameDropped
        ? "[xt:livetv] every decoded video frame is being dropped (GDR stream failed to latch) - recovering"
        : "[xt:livetv] video track decoded zero frames - treating as start failure",
      {
        streamId: ctx.streamId,
        totalVideoFrames: frames,
        droppedVideoFrames: dropped,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      }
    )
    if (everyFrameDropped) {
      const relatchAttempts = nativeRelatchAttempts.get(ctx.streamId) || 0
      const recovery = chooseBlackFrameRecovery({
        // Native mounts re-tune (a fresh chance to latch); see chooseBlackFrameRecovery.
        isMacOSNativeHls:
          isMacOS && !ctx.audioProxied && (!isTauri || isNativeHlsFallbackChannel(ctx.streamId)),
        relatchAttempts,
        proxyUsable:
          canUseAudioProxy(ctx) &&
          !ctx.audioProxied &&
          !audioProxyAutoAttemptedSet.has(ctx.streamId),
      })
      if (recovery === "native-retune") {
        nativeRelatchAttempts.set(ctx.streamId, relatchAttempts + 1)
        log.warn("[xt:livetv] re-tuning the native mount to re-attempt GDR latch", {
          streamId: ctx.streamId,
          attempt: relatchAttempts + 1,
        })
        toast({ title: t("stream.videoFix.retuning"), duration: 4000 })
        void play(ctx.streamId, ctx.name, "auto:gdr-relatch")
        return
      }
      if (recovery === "proxy") {
        audioProxyAutoAttemptedSet.add(ctx.streamId)
        log.warn("[xt:livetv] retrying through the ffmpeg remux proxy", {
          streamId: ctx.streamId,
        })
        toast({ title: t("stream.videoFix.remuxing"), duration: 4000 })
        fixAudioNow(ctx)
        return
      }
    }
    suppressPauseTrackingUntilMs = Date.now() + 500
    try { vjs?.pause?.() } catch {}
    hideTuningOverlay()
    hideBufferingChip()
    clearStallSentinel()
    showPlaybackFailurePanel(ctx, { decodeFailure: true })
  }
  schedule()
}

// ----------------------------
// Dead-audio watchdog
// ----------------------------
// AC-3/E-AC-3 can enter a SourceBuffer and fire `playing` yet never decode; advisory only.
const DEAD_AUDIO_CHECK_MS = 5000
const DEAD_AUDIO_MAX_CHECKS = 6
const DEAD_AUDIO_MIN_PLAYED_S = 3
const DEAD_AUDIO_MIN_FRAMES = 25
let deadAudioTimer = null
let deadAudioNotifiedSeq = -1

function clearDeadAudioWatchdog() {
  if (deadAudioTimer) {
    clearTimeout(deadAudioTimer)
    deadAudioTimer = null
  }
}

// Blink-only despite the prefix - WebKit never shipped it, hence the codec-string fallback below.
function audioDecodedByteCount(videoEl) {
  const bytes = videoEl.webkitAudioDecodedByteCount
  return typeof bytes === "number" ? bytes : null
}

function bufferedEndSeconds(videoEl) {
  try {
    const ranges = videoEl.buffered
    if (!ranges || ranges.length === 0) return 0
    return ranges.end(ranges.length - 1)
  } catch {
    return 0
  }
}

function isHlsSource(src) {
  return /\.m3u8?(\?|$)/i.test(String(src || ""))
}

// A channel that already fell back to direct play this session must not be re-routed.
function canUseAudioProxy(ctx) {
  return (
    audioProxyAvailable &&
    !!ctx?.isLive &&
    !catchupSession &&
    !audioProxyBypassSet.has(ctx.streamId) &&
    // The proxy pipes the fetched body into ffmpeg's mpegts demuxer; an HLS
    // playlist URL feeds it playlist text and dies instantly. Raw TS only.
    !isHlsSource(ctx?.src)
  )
}

function fixAudioNow(ctx) {
  audioProxyOneShotFixSet.add(ctx.streamId)
  void play(ctx.streamId, ctx.name, "auto:audio-fix")
}

// A proxied mount's local URL is single-consumer: a same-src reconnect 409s and leaves a dead player.
function retuneProxiedAudioMount(ctx) {
  const attempts = (audioProxyStallRetuneCounts.get(ctx.streamId) || 0) + 1
  audioProxyStallRetuneCounts.set(ctx.streamId, attempts)
  if (attempts > AUDIO_PROXY_MAX_STALL_RETUNES) {
    audioProxyBypassSet.add(ctx.streamId)
  } else if (!isAudioTranscodeChannel(activePlaylistId, String(ctx.streamId))) {
    audioProxyOneShotFixSet.add(ctx.streamId)
  }
  void play(ctx.streamId, ctx.name, "auto:proxy-stall-retune")
}

// The Rust side has already torn the session down by the time this fires.
function handleAudioProxyError(payload) {
  const ctx = lastPlayContext
  if (!ctx || !ctx.audioProxied) return
  if (!payload || payload.sessionId !== ctx.audioProxySessionId) return
  audioProxyBypassSet.add(ctx.streamId)
  // Never reached playing state - this channel's proxy path is broken, not a transient blip. Don't keep re-attempting it every session.
  if (!ctx.started) {
    forgetAudioTranscodeChannel(activePlaylistId, String(ctx.streamId))
  }
  log.warn("[xt:livetv] audio transcode proxy failed mid-play, falling back to direct:", payload.detail)
  toast({ title: t("stream.audioFix.fallback"), duration: 7000 })
  void play(ctx.streamId, ctx.name, "auto:proxy-error-fallback")
}

function armDeadAudioWatchdog() {
  clearDeadAudioWatchdog()
  const ctx = lastPlayContext
  if (!ctx) return
  if (ctx.audioProxied) return
  if (deadAudioNotifiedSeq === ctx.seq) return
  const seqAtArm = ctx.seq
  const wrap = getPlayerWrap()
  const videoAtArm = wrap?.querySelector("video")
  if (!videoAtArm) return
  const baselineTime = videoAtArm.currentTime || 0
  let attempts = 0
  const schedule = () => {
    deadAudioTimer = setTimeout(check, DEAD_AUDIO_CHECK_MS)
  }
  const check = () => {
    deadAudioTimer = null
    if (seqAtArm !== playSeq) return
    const currentWrap = getPlayerWrap()
    if (!currentWrap || currentWrap.dataset.radioMode === "on") return
    const video = currentWrap.querySelector("video")
    if (!video || video.paused) return
    if (video.muted || video.volume === 0) return
    const audioBytes = audioDecodedByteCount(video)
    const codecInfo = vjs?.codecInfo?.() || null
    // Without a byte counter the codec string is the only evidence; a decodable one stays innocent.
    const audioDead =
      audioBytes === null ? isUnsupportedAudioCodec(codecInfo?.audioCodec) : audioBytes === 0
    log.info("[xt:livetv] dead-audio check", {
      audioBytes,
      audioCodec: codecInfo?.audioCodec ?? null,
      frames: decodedFrameCount(video),
      videoWidth: video.videoWidth,
      played: (video.currentTime || 0) - baselineTime,
    })
    if (!audioDead) return
    const frames = decodedFrameCount(video)
    if (frames === null || frames === 0) return
    if (video.videoWidth === 0) return
    attempts++
    // Frame count also qualifies so a stuttering stream (slow currentTime) still gets verdicts.
    const playedEnough =
      (video.currentTime || 0) - baselineTime >= DEAD_AUDIO_MIN_PLAYED_S ||
      frames >= DEAD_AUDIO_MIN_FRAMES
    if (!playedEnough) {
      if (attempts < DEAD_AUDIO_MAX_CHECKS) schedule()
      return
    }
    deadAudioNotifiedSeq = seqAtArm
    const info = codecInfo || {}
    log.warn("[xt:livetv] video decoding but no audio decoded - audio codec likely undecodable", {
      streamId: ctx.streamId,
      audioBytes,
      audioCodec: info.audioCodec,
    })
    const audioUnsupported = isUnsupportedAudioCodec(info.audioCodec)
    // AVFoundation has the decoders MSE lacks, so remount rather than just warn.
    if (
      isMacOS &&
      isTauri &&
      ctx.isLive &&
      isHlsSource(ctx.src) &&
      !ctx.audioProxied &&
      !isNativeHlsFallbackChannel(ctx.streamId)
    ) {
      rememberNativeHlsFallbackChannel(ctx.streamId)
      log.warn("[xt:livetv] silent audio in MSE - remounting on native AVFoundation", {
        streamId: ctx.streamId,
        audioCodec: info.audioCodec,
      })
      void play(ctx.streamId, ctx.name, "auto:native-hls-fallback")
      return
    }
    if (canUseAudioProxy(ctx)) {
      if (getAudioTranscodeAuto()) {
        toast({ title: t("stream.audioFix.fixing"), duration: 4000 })
        fixAudioNow(ctx)
      } else {
        const title = audioUnsupported
          ? t("stream.failure.audioUnsupportedFixable", { codec: describeAudioCodec(info.audioCodec) })
          : t("stream.failure.audioSilentFixable")
        toast({
          title,
          duration: 12000,
          action: { label: t("stream.audioFix.action"), onClick: () => fixAudioNow(ctx) },
        })
      }
    } else {
      const title = audioUnsupported
        ? t("stream.failure.audioUnsupported", { codec: describeAudioCodec(info.audioCodec) })
        : t("stream.failure.audioSilent")
      toast({ title, duration: 7000 })
    }
  }
  schedule()
}

// ----------------------------
// Playback failure panel
// ----------------------------
// In-player explanation for streams that never reached `playing`
// Only shown after the auto-retry failed, removed on the next tune
// or when playback recovers.
let failurePanelSeq = -1
let failurePanelReasonKind = "unknown"
let failurePanelExternalHandle: ExternalPlayerButtonHandle | null = null

function hidePlaybackFailurePanel() {
  failurePanelSeq = -1
  failurePanelReasonKind = "unknown"
  failurePanelExternalHandle?.dispose()
  failurePanelExternalHandle = null
  const playerWrap = document.getElementById("player")?.parentElement
  playerWrap?.querySelector("[data-playback-failure]")?.remove()
}

/**
 * Returns true when the panel owns messaging for this tune attempt, so the
 * auto-diagnostic must not toast on top of it. Generic and name-guessed
 * reasons get upgraded in place; codec verdicts backed by engine evidence
 * are more specific than anything the network probe can find, and stay.
 */
function applyDiagnosticToFailurePanel(seq, verdict, reason) {
  if (failurePanelSeq !== seq) return false
  if (failurePanelReasonKind !== "unknown" && failurePanelReasonKind !== "hevc-likely") {
    return true
  }
  if (verdict !== "fail" && verdict !== "warn") return true
  const playerWrap = document.getElementById("player")?.parentElement
  const reasonEl = playerWrap?.querySelector(
    "[data-playback-failure] [data-failure-reason]"
  )
  if (reasonEl) reasonEl.textContent = reason
  return true
}

function showPlaybackFailurePanel(ctx, opts = {}) {
  if (failurePanelSeq === ctx.seq) return
  hidePlaybackFailurePanel()
  // No automatic retune follows this panel - close the session now, not on the next tune.
  getPlayerInsights().endSession("giveup")
  log.warn("[xt:livetv] playback failure panel shown", {
    streamId: ctx.streamId,
    decodeFailure: !!opts.decodeFailure,
  })
  const playerWrap = document.getElementById("player")?.parentElement
  if (!playerWrap) return

  const info = vjs?.codecInfo?.() || { videoCodec: null, audioCodec: null, errorDetail: null }
  const failure = classifyStartFailure({
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec,
    errorDetail:
      info.errorDetail || (opts.decodeFailure ? "videoDecodeFailure" : null),
    nameHint: hasHevcNameHint(ctx.name),
    deviceHevc: deviceSupportsHevc(),
    audioClockWedge: !!ctx.audioClockWedge,
  })
  log.log("[xt:livetv] start failure classified:", failure.kind, {
    videoCodec: info.videoCodec,
    errorDetail: info.errorDetail,
  })
  let reason
  if (failure.kind === "hevc") {
    reason = failure.codec
      ? t("stream.failure.hevcConfirmed")
      : t("stream.error.hevcHint")
  } else if (failure.kind === "codec") {
    reason = t("stream.failure.codecUnsupported", {
      codec: failure.codec || info.errorDetail || "?",
    })
  } else if (failure.kind === "audio") {
    reason = t("stream.failure.audioUnsupported", {
      codec: describeAudioCodec(failure.codec),
    })
  } else if (failure.kind === "parse") {
    reason = t("stream.failure.parseFailed")
  } else {
    reason = t("stream.error.checkConnection")
  }
  failurePanelSeq = ctx.seq
  failurePanelReasonKind =
    failure.kind === "hevc" && !failure.codec ? "hevc-likely" : failure.kind

  const panel = document.createElement("div")
  panel.dataset.playbackFailure = ""
  panel.setAttribute("role", "alert")
  // gap/size scale down on a short mobile player (overflow-hidden), overflow-y-auto is the safety valve when it still doesn't fit.
  panel.className =
    "absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 sm:gap-5 bg-black/85 px-6 py-4 text-center overflow-y-auto"

  // The panel sits on an always-dark bg-black/85 surface, so its chrome is styled light-on-dark in both themes (not theme-flipping tokens).
  const icon = document.createElement("span")
  icon.className = "inline-flex text-4xl sm:text-5xl leading-none text-white/40"
  icon.setAttribute("aria-hidden", "true")
  icon.innerHTML = ICON_ALERT_TRIANGLE
  panel.appendChild(icon)

  const headGroup = document.createElement("div")
  headGroup.className = "flex flex-col items-center gap-1.5"

  const title = document.createElement("p")
  title.className = "m-0 text-white font-semibold text-lg sm:text-2xl tracking-tight"
  title.textContent = t("stream.error.cantPlayTitle")
  headGroup.appendChild(title)

  const channelLine = document.createElement("p")
  channelLine.className = "m-0 text-white/70 text-sm sm:text-base font-medium"
  channelLine.textContent = ctx.name || `#${ctx.streamId}`
  headGroup.appendChild(channelLine)
  panel.appendChild(headGroup)

  const reasonEl = document.createElement("p")
  reasonEl.dataset.failureReason = ""
  reasonEl.className = "m-0 max-w-sm text-white/70 text-xs sm:text-sm leading-relaxed"
  reasonEl.textContent = reason
  panel.appendChild(reasonEl)

  const actions = document.createElement("div")
  actions.className = "mt-1 flex flex-wrap items-center justify-center gap-3"

  // Promote the action that actually recovers this failure kind to primary;
  // a decode failure needs the external player, a network blip needs retry.
  const builtinCantDecode =
    failure.kind === "hevc" || failure.kind === "codec" || failure.kind === "audio"
  const hevcInstall = failure.kind === "hevc" && isWindowsDesktop()
  const audioProxyEligible = failure.kind === "audio" && canUseAudioProxy(ctx)
  const externalAvailable = externalPlayersAvailable || androidExternalAvailable
  let primaryKind = "retry"
  if (hevcInstall) primaryKind = "hevc"
  else if (audioProxyEligible) primaryKind = "audioFix"
  else if (builtinCantDecode && externalAvailable) primaryKind = "external"

  const primaryClass =
    "shrink-0 inline-flex items-center justify-center gap-2 min-h-11 px-5 rounded-xl bg-white text-black text-sm font-semibold transition duration-150 hover:bg-white/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/70"
  const secondaryClass =
    "shrink-0 inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl border border-white/25 text-white text-sm transition duration-150 hover:bg-white/10 hover:border-white/40 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"

  const retryBtn = document.createElement("button")
  retryBtn.type = "button"
  retryBtn.className = primaryKind === "retry" ? primaryClass : secondaryClass
  retryBtn.textContent = t("common.retry")
  retryBtn.addEventListener("click", () => {
    hidePlaybackFailurePanel()
    if (retryCatchupSession(ctx)) return
    play(ctx.streamId, ctx.name)
  })

  let hevcBtn = null
  if (hevcInstall) {
    hevcBtn = document.createElement("button")
    hevcBtn.type = "button"
    hevcBtn.className = primaryKind === "hevc" ? primaryClass : secondaryClass
    hevcBtn.textContent = t("hevc.enable") || "Enable HEVC playback"
    hevcBtn.addEventListener("click", async () => {
      if (await ensureHevcDecodable()) {
        hidePlaybackFailurePanel()
        play(ctx.streamId, ctx.name)
      }
    })
  }

  let audioFixBtn = null
  if (audioProxyEligible) {
    audioFixBtn = document.createElement("button")
    audioFixBtn.type = "button"
    audioFixBtn.className = primaryKind === "audioFix" ? primaryClass : secondaryClass
    audioFixBtn.textContent = t("stream.audioFix.action")
    audioFixBtn.addEventListener("click", () => {
      hidePlaybackFailurePanel()
      fixAudioNow(ctx)
    })
  }

  let extBtn = null
  if (externalAvailable) {
    extBtn = document.createElement("button")
    extBtn.type = "button"
    extBtn.hidden = true
    extBtn.className = primaryKind === "external" ? primaryClass : secondaryClass
    const extIcon = document.createElement("span")
    extIcon.className = "shrink-0 inline-flex text-xl leading-none"
    extIcon.setAttribute("aria-hidden", "true")
    extIcon.innerHTML = ICON_EXTERNAL_LINK
    const extLabel = document.createElement("span")
    extLabel.dataset.label = ""
    extBtn.append(extIcon, extLabel)
    failurePanelExternalHandle = setupExternalPlayerButton(extBtn, {
      getSrc: () => ctx.src,
      getHeaders: () => {
        const channelHeaders = streamHeadersById.get(ctx.streamId) || null
        return {
          userAgent: channelHeaders?.userAgent || getUserAgent() || null,
          referer: channelHeaders?.referer || null,
        }
      },
      getTitle: () => ctx.name || null,
      beforeLaunch: () => {
        hidePlaybackFailurePanel()
      },
      afterLaunch: () => {
        const channel = all.find((entry) => entry.id === ctx.streamId)
        pushDiscordPresence(channel || { id: ctx.streamId, name: ctx.name }, "live")
        externalPresenceActive = true
      },
    })
  }

  // Primary leads; retry is always offered as the fallback.
  const orderedButtons = []
  if (primaryKind === "hevc" && hevcBtn) orderedButtons.push(hevcBtn)
  else if (primaryKind === "audioFix" && audioFixBtn) orderedButtons.push(audioFixBtn)
  else if (primaryKind === "external" && extBtn) orderedButtons.push(extBtn)
  else orderedButtons.push(retryBtn)
  for (const btn of [hevcBtn, audioFixBtn, extBtn, retryBtn]) {
    if (btn && !orderedButtons.includes(btn)) orderedButtons.push(btn)
  }
  for (const btn of orderedButtons) actions.appendChild(btn)

  panel.appendChild(actions)
  playerWrap.appendChild(panel)
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
  externalPresenceActive = false
  void stopAudioTranscode()
})

function pushDiscordPresence(channel, kind) {
  if (!activePlaylistId || !channel) return
  const safeLogo = channel.logo ? safeHttpUrl(channel.logo) : null
  let stateLine = ""
  const state = getProgrammesSync(activePlaylistId)
  if (state) {
    const { current } = getNowNextForChannel(state.programmes, channel, activePlaylistId)
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
  const pref = getExternalPlayerPref()
  if ((pref === "mpv" || pref === "vlc") && getPlayerPath(pref)) return pref
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
  if (!getAndroidNativePlayerEnabled()) return false
  return launchNativeLiveSession(initialStreamId, initialName)
}

async function launchNativeLiveSession(initialStreamId, initialName) {
  if (!androidNativePlayerAvailable) return false
  if (!all.length) return false
  ensureNativeLiveSubscription()

  let initialUrl
  if (hasDirectUrl(initialStreamId)) {
    initialUrl = getDirectUrl(initialStreamId)
  } else {
    initialUrl = await resolveStreamUrl((candidate) =>
      buildDirectLiveUrl(initialStreamId, candidate),
    )
    creds = await loadCreds()
  }
  if (!initialUrl) return false

  const channelInputs = []
  for (const channel of all) {
    let streamUrl = ""
    if (channel.id === initialStreamId) {
      streamUrl = initialUrl
    } else if (hasDirectUrl(channel.id)) {
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

async function play(streamId, name, reason = "user") {
  // Every tune's trigger reaches the log file, so sessions reconstruct from it.
  log.info("[xt:livetv] tune", { streamId, name: name || null, reason })
  if (reason === "user") {
    freezeRetuneCounts.delete(streamId)
    nativeRelatchAttempts.delete(streamId)
    liveStallRetuneCounts.delete(streamId)
  }
  const targetChannel = all.find((channel) => channel.id === streamId)
  if (targetChannel?.unresolved) {
    void stopAudioTranscode()
    toastError(t("stream.error.cantPlay", { channel: name || targetChannel.name || `#${streamId}` }), {
      description: t("stream.error.checkConnection"),
    })
    return
  }
  hidePlaybackFailurePanel()
  clearDeadVideoWatchdog()
  clearDeadAudioWatchdog()
  catchupSession = null
  catchupAutoRetryCount = 0
  catchupSeekRemountCount = 0
  catchupLastEndedAbsUtcMs = null
  // Leaving catch-up without a remount (e.g. "Back to live") would otherwise strand this on a disposed <video>.
  if (catchupSeekingEl && catchupSeekingHandler) {
    try { catchupSeekingEl.removeEventListener("seeking", catchupSeekingHandler) } catch {}
    catchupSeekingEl = null
    catchupSeekingHandler = null
  }
  pendingSeekTargetUtcMs = null
  pausedAtAbsUtcMs = null
  // The old mount's teardown fires an async pause event; without this window it would re-arm the tracker mid-retune.
  suppressPauseTrackingUntilMs = Date.now() + 500
  const myRequest = ++catchupRequestSeq
  hideTimeshiftChip()
  clearLiveEdgeTracking()
  if (!currentEl) return
  // Every tune remounts the <video> below - detach the previous chip's
  // listeners first so they don't leak onto a removed element.
  if (qualityChipDetach) {
    qualityChipDetach()
    qualityChipDetach = null
  }
  // Native ExoPlayer Activity path (opt-in via Settings). Hands off the full
  // playback session including channel switching. Returns early if successful.
  if (await tryLaunchNativeLive(streamId, name)) {
    return
  }

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
      void stopAudioTranscode()
      const externalKind =
        externalPlayersAvailable ? pickConfiguredExternal() : null
      const channelHeaders = streamHeadersById.get(streamId) || null
      if (externalKind) {
        const channel = all.find((entry) => entry.id === streamId)
        try {
          await launchExternalLive(externalKind, src, channelHeaders)
          showExternalPlayerEmptyState(externalKind, name)
          pushDiscordPresence(channel || { id: streamId, name }, "live")
          externalPresenceActive = true
        } catch (err) {
          surfaceLaunchError(err, externalKind)
        }
        if (activePlaylistId) {
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
    label.append(`${fmtChannelIdentity(channel?.chno, streamId)}: `)
    const nameEl = document.createElement("span")
    nameEl.className = "text-accent"
    nameEl.textContent = name
    label.appendChild(nameEl)
    wrap.appendChild(label)
    if (shouldWarnHevc(name)) wrap.appendChild(buildHevcBadge())
    currentEl.appendChild(wrap)

    closeCurrentMoreMenu(false)
    const moreBtn = document.createElement("button")
    moreBtn.id = "current-more-btn"
    moreBtn.type = "button"
    const moreLabel = t("livetv.moreActions")
    moreBtn.title = moreLabel
    moreBtn.setAttribute("aria-label", moreLabel)
    moreBtn.setAttribute("aria-haspopup", "menu")
    moreBtn.setAttribute("aria-expanded", "false")
    moreBtn.className = CURRENT_ROW_ICON_BTN_CLASS
    moreBtn.innerHTML = ICON_DOTS
    moreBtn.addEventListener("click", () => {
      if (currentMoreMenuTrigger === moreBtn) closeCurrentMoreMenu()
      else openCurrentMoreMenu(moreBtn, streamId, channel, src, name)
    })
    currentEl.appendChild(moreBtn)

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
  const channelDrm = streamDrmById.get(streamId) || null

  if (backend === "mpv" || backend === "vlc") {
    void stopAudioTranscode()
    try {
      await launchExternalLive(backend, src, channelHeaders)
      showExternalPlayerEmptyState(backend, name)
      pushDiscordPresence(channel || { id: streamId, name }, "live")
      externalPresenceActive = true
    } catch (err) {
      surfaceLaunchError(err, backend)
    }
    paintEpgSidePanel(streamId)
    return
  }

  resetEmptyState()
  document.getElementById("player")?.removeAttribute("hidden")
  if (channel?.isRadio || isAudioOnlyChannel(streamId)) {
    // Both triggers hide the video element, so record which one fired - a stale
    // manual override is otherwise indistinguishable from a broken video track.
    log.info("[xt:livetv] starting in audio-only (radio) mode", {
      streamId,
      trigger: channel?.isRadio ? "playlist-radio-flag" : "manual-audio-only",
    })
    setRadioMode(
      { id: streamId, name, logo: channel?.logo ?? null, category: channel?.category ?? null, url: src },
      { probeIcy: !!channel?.isRadio }
    )
  } else {
    clearRadioMode()
  }

  const wantsAudioProxyFix = audioProxyOneShotFixSet.has(streamId)
  const useAudioProxy =
    audioProxyAvailable &&
    !audioProxyBypassSet.has(streamId) &&
    (wantsAudioProxyFix || isAudioTranscodeChannel(activePlaylistId, String(streamId)))

  let mountSrc = src
  let mountMime = "application/x-mpegURL"
  let audioProxied = false
  let audioProxySessionId = null

  if (useAudioProxy) {
    const proxyUserAgent = channelHeaders?.userAgent || getUserAgent() || null
    const proxySession = await startAudioTranscode(src, proxyUserAgent)
    audioProxyOneShotFixSet.delete(streamId)
    if (myRequest !== catchupRequestSeq) {
      if (proxySession) void stopAudioTranscode(proxySession.sessionId)
      return
    }
    if (proxySession) {
      mountSrc = proxySession.localUrl
      mountMime = "video/mp2t"
      audioProxied = true
      audioProxySessionId = proxySession.sessionId
    } else {
      // Registration itself failed - retrying would just loop the watchdog forever. Bypass the proxy for this channel this session.
      audioProxyBypassSet.add(streamId)
      void stopAudioTranscode()
    }
  } else {
    void stopAudioTranscode()
  }

  const player = await ensureEmbeddedPlayer(backend)
  // Re-check staleness: the ensureEmbeddedPlayer() await is another window for a newer request to take over.
  if (myRequest !== catchupRequestSeq) {
    return
  }
  if (!player) {
    return
  }
  const playerWrap = document.getElementById("player")?.parentElement
  if (playerWrap) qualityChipDetach = attachQualityChip(playerWrap, player)
  await applyStreamHeaders(channelHeaders)
  const seq = ++playSeq
  lastPlayContext = {
    streamId,
    name,
    src: mountSrc,
    seq,
    retried: false,
    started: false,
    nativeFallbackTried: false,
    audioClockWedge: false,
    mime: mountMime,
    isLive: true,
    audioProxied,
    audioProxySessionId,
  }
  // An "auto:*" reason is a recovery re-invocation of the same tune, not a new one - keep it in the same session.
  if (isAutomaticRetuneReason(reason)) {
    getPlayerInsights().record("fallback", reason)
  } else {
    getPlayerInsights().startSession({ label: name, seq })
  }
  // Armed here, not just on "playing": a wedged first tune never fires it.
  ensureProgressWatch()
  hideBufferingChip()
  clearStallSentinel()
  try { player.reset?.() } catch {}
  try {
    player.src({
      src: mountSrc,
      type: mountMime,
      drm: audioProxied ? null : channelDrm,
      preferNativeHls: isNativeHlsFallbackChannel(streamId),
    })
  } catch {}
  const playResult = player.play?.()
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) => {
      // An interrupted play() otherwise leaves the tune paused until a manual click.
      // AbortError is the expected remount-vs-autoplay race, so it stays out of the log file.
      const errorName = err?.name || String(err)
      const write = errorName === "AbortError" ? log.debug : log.info
      write("[xt:livetv] initial play() rejected - re-arming on canplay", { streamId, error: errorName })
      const mediaEl = player.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
      if (!mediaEl) return
      const resume = () => {
        mediaEl.removeEventListener("canplay", resume)
        if (lastPlayContext?.streamId !== streamId) return
        try {
          void player.play?.()?.catch?.((retryErr) => {
            log.warn("[xt:livetv] retry play() rejected", { streamId, error: retryErr?.name || String(retryErr) })
          })
        } catch {}
      }
      mediaEl.addEventListener("canplay", resume)
      setTimeout(() => mediaEl.removeEventListener("canplay", resume), 20000)
    })
  }
  armStartWedgeWatch()
  applyVideoScale()
  pushDiscordPresence(channel || { id: streamId, name }, "live")
  externalPresenceActive = false

  paintEpgSidePanel(streamId)
}

// ----------------------------
// Catch-up (archive) playback
// ----------------------------
function renderCatchupCurrentRow(channel, title) {
  if (!currentEl) return
  closeCurrentMoreMenu(false)
  currentEl.replaceChildren()

  const wrap = document.createElement("div")
  wrap.className = "flex items-center gap-2 min-w-0 flex-1"
  const badge = document.createElement("span")
  badge.className = "status-badge status-badge--catchup shrink-0"
  badge.textContent = t("catchup.watchingLabel")
  wrap.appendChild(badge)

  const label = document.createElement("span")
  label.className = "truncate min-w-0 flex-1"
  const titleEl = document.createElement("span")
  titleEl.className = "text-accent"
  titleEl.textContent = title || channel.name || ""
  label.appendChild(titleEl)
  if (channel.name && title) {
    const channelEl = document.createElement("span")
    channelEl.className = "text-fg-3"
    channelEl.textContent = ` · ${channel.name}`
    label.appendChild(channelEl)
  }
  if (catchupSession) {
    const timeEl = document.createElement("span")
    timeEl.className = "text-fg-3"
    timeEl.textContent = ` · ${
      catchupSession.kind === "programme"
        ? `${formatWallClock(catchupSession.startUtcMs)}-${formatWallClock(catchupSession.stopUtcMs)}`
        : formatWallClock(catchupSession.startUtcMs)
    }`
    label.appendChild(timeEl)
  }
  wrap.appendChild(label)
  currentEl.appendChild(wrap)

  const backBtn = document.createElement("button")
  backBtn.type = "button"
  backBtn.className =
    "shrink-0 inline-flex items-center justify-center min-h-11 px-3.5 rounded-xl border border-line bg-surface text-sm text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors"
  backBtn.textContent = t("catchup.backToLive")
  backBtn.addEventListener("click", () => backToLive(channel))
  currentEl.appendChild(backBtn)
}

function backToLive(channel) {
  hideTimeshiftChip()
  // Already tuned live on this channel (no shifted session) - avoid a pointless remount.
  if (!catchupSession && currentlyPlayingId === channel.id) return
  play(channel.id, channel.name || "")
}

/** Re-mounts the active session at the current playhead (archive URLs embed timestamps, so a stale src must not be replayed); automatic callers are capped, manual retry resets the budget. */
function retryCatchupSession(ctx, opts = {}) {
  const session = catchupSession
  if (!session || session.channelId !== ctx.streamId) return false
  const channel = all.find((entry) => entry.id === session.channelId)
  if (!channel) return false
  if (opts.automatic) {
    if (catchupAutoRetryCount >= CATCHUP_MAX_AUTO_RETRIES) return false
    catchupAutoRetryCount++
  } else {
    catchupAutoRetryCount = 0
  }
  const currentSeconds = vjs?.currentTime?.() || 0
  const resumeUtcMs = Math.min(
    Math.max(session.timelineStartUtcMs + currentSeconds * 1000, session.startUtcMs),
    session.stopUtcMs - 1000
  )
  void playCatchup(channel, {
    startUtcMs: resumeUtcMs,
    stopUtcMs: session.stopUtcMs,
    timelineStartUtcMs: session.timelineStartUtcMs,
    timelineStopUtcMs: session.timelineStopUtcMs,
    title: session.title,
    kind: session.kind,
    catchupId: session.catchupId,
    isRetryContinuation: true,
  })
  return true
}

/** Programme title under the playhead at `atUtcMs`, from XMLTV or the cached Xtream full table; "" when EPG data is missing. */
function resolveProgrammeTitleAt(channel, atUtcMs) {
  if (!channel || !activePlaylistId) return ""
  const tvgId = effectiveTvgId(channel, activePlaylistId)
  if (tvgId) {
    const state = getProgrammesSync(activePlaylistId)
    const displayedAtMs = utcToDisplayedMs(activePlaylistId, atUtcMs)
    const { current } = getNowNext(state?.programmes, tvgId, displayedAtMs)
    if (current?.title) return current.title
  }
  const xtreamEntries = peekXtreamFullEpgCache(channel)
  const listing = xtreamEntries?.find((entry) => entry.startUtcMs <= atUtcMs && atUtcMs < entry.stopUtcMs)
  return listing?.title || ""
}

/** Programme `catchup-id` under the playhead at `atUtcMs`, or null when EPG data or the field is missing. */
function resolveProgrammeCatchupIdAt(channel, atUtcMs) {
  if (!channel || !activePlaylistId) return null
  const tvgId = effectiveTvgId(channel, activePlaylistId)
  if (!tvgId) return null
  const state = getProgrammesSync(activePlaylistId)
  const displayedAtMs = utcToDisplayedMs(activePlaylistId, atUtcMs)
  const { current } = getNowNext(state?.programmes, tvgId, displayedAtMs)
  return current?.catchupId || null
}

/** Programme window under the playhead at `atUtcMs`, from XMLTV or the cached Xtream full table; null when EPG data is missing. */
function resolveProgrammeWindowAt(channel, atUtcMs) {
  if (!channel || !activePlaylistId) return null
  const tvgId = effectiveTvgId(channel, activePlaylistId)
  if (tvgId) {
    const state = getProgrammesSync(activePlaylistId)
    const displayedAtMs = utcToDisplayedMs(activePlaylistId, atUtcMs)
    const { current } = getNowNext(state?.programmes, tvgId, displayedAtMs)
    if (current) {
      return {
        startUtcMs: displayedToUtcMs(activePlaylistId, current.start),
        stopUtcMs: displayedToUtcMs(activePlaylistId, current.stop),
      }
    }
  }
  const xtreamEntries = peekXtreamFullEpgCache(channel)
  const listing = xtreamEntries?.find((entry) => entry.startUtcMs <= atUtcMs && atUtcMs < entry.stopUtcMs)
  return listing ? { startUtcMs: listing.startUtcMs, stopUtcMs: listing.stopUtcMs } : null
}

/** Resolve + mount a catch-up/timeshift source for `channel`'s programme window, optionally seeking to `seekSeconds` once metadata loads. */
async function playCatchup(channel, opts) {
  if (!currentEl || !channel || !activePlaylistId) return false
  // Catch-up remounts the <video> without a quality chip - detach the
  // live one so its listeners don't leak onto a removed element.
  if (qualityChipDetach) {
    qualityChipDetach()
    qualityChipDetach = null
  }
  if (channel.unresolved) {
    toastError(t("stream.error.cantPlay", { channel: channel.name || `#${channel.id}` }), {
      description: t("stream.error.checkConnection"),
    })
    return false
  }
  // Reachable via a stale/hand-crafted deep link - the channel itself may no longer offer catch-up.
  if (!channelSupportsCatchup(channel)) {
    toastError(t("catchup.notAvailable"))
    void play(channel.id, channel.name)
    return false
  }
  const { startUtcMs, stopUtcMs, seekSeconds = 0, kind = "programme" } = opts || {}
  let timelineStartUtcMs = opts?.timelineStartUtcMs ?? startUtcMs
  const catchupId = opts?.catchupId || resolveProgrammeCatchupIdAt(channel, startUtcMs)
  let title = opts?.title || ""
  if (!Number.isFinite(startUtcMs) || !Number.isFinite(stopUtcMs) || stopUtcMs <= startUtcMs) return false

  const backend = getPlayerBackend()
  if (backend === "mpv" || backend === "vlc") {
    toastError(kind === "timeshift" ? t("timeshift.seekFailed") : t("catchup.failed"))
    return false
  }

  hidePlaybackFailurePanel()
  clearDeadVideoWatchdog()
  clearDeadAudioWatchdog()
  clearRadioMode()

  // A different channel (or no active session) is a fresh pick, not a same-session remount/auto-advance - don't let stale strikes leak in.
  if (!catchupSession || catchupSession.channelId !== channel.id) {
    catchupLastEndedAbsUtcMs = null
    catchupConsecutiveShortAdvances = 0
  }
  // Any session start gets its own error-retry budget; only retryCatchupSession's continuation call must keep the count it just set.
  if (!opts?.isRetryContinuation) catchupAutoRetryCount = 0
  // Same rule for the seek-remount circuit breaker: preserve the count only across the seek interceptor's own remount.
  if (!opts?.preserveSeekRemountBudget) catchupSeekRemountCount = 0

  // Resolving the archive URL can take several seconds (probing candidate
  // wire formats) - give the same tuning feedback the live path shows.
  const myRequest = ++catchupRequestSeq
  showTuningOverlay(channel.logo ? safeHttpUrl(channel.logo) : null, CATCHUP_TUNING_MAX_MS)

  const resolution = await resolveCatchupSrc(activePlaylistId, creds, {
    channel,
    startUtcMs,
    stopUtcMs,
    catchupId,
  })
  // A newer play()/playCatchup() call has since taken over - bail without
  // touching whatever it's already showing.
  if (myRequest !== catchupRequestSeq) {
    return false
  }
  if (!resolution) {
    hideTuningOverlay()
    toastError(kind === "timeshift" ? t("timeshift.seekFailed") : t("catchup.failed"))
    return false
  }

  if (!title && kind === "timeshift") title = resolveProgrammeTitleAt(channel, startUtcMs)
  const mountedStartUtcMs = resolution.effectiveStartUtcMs

  // Full-programme span (TiviMate-style bar) only for non-terminating streams still mid-broadcast; terminating archives end exactly at the requested stop, so they keep the elapsed-so-far span.
  let timelineStopUtcMs = opts?.timelineStopUtcMs ?? null
  if (timelineStopUtcMs == null && !resolution.profile.terminates) {
    const anchorWindow = kind === "programme" ? { startUtcMs, stopUtcMs } : resolveProgrammeWindowAt(channel, startUtcMs)
    if (anchorWindow && anchorWindow.stopUtcMs > Date.now()) {
      if (opts?.timelineStartUtcMs == null) timelineStartUtcMs = anchorWindow.startUtcMs
      timelineStopUtcMs = anchorWindow.stopUtcMs
    }
  }

  resetEmptyState()
  document.getElementById("player")?.removeAttribute("hidden")

  const player = await ensureEmbeddedPlayer(backend, { liveui: false })
  // Re-check staleness: the ensureEmbeddedPlayer() await is another window for a newer request to take over.
  if (myRequest !== catchupRequestSeq) {
    return false
  }
  if (!player) {
    hideTuningOverlay()
    return false
  }

  pendingSeekTargetUtcMs = null
  pausedAtAbsUtcMs = null
  hideTimeshiftChip()
  timeshiftChipLastUpdateAt = 0

  pushRecent(activePlaylistId, "live", channel.id, channel.name, channel.logo || null)
  setNowPlaying(channel.id)
  catchupSession = {
    kind,
    channelId: channel.id,
    channelName: channel.name || "",
    title,
    startUtcMs,
    stopUtcMs,
    mountedStartUtcMs,
    timelineStartUtcMs,
    timelineStopUtcMs,
    catchupId,
    profile: resolution.profile,
  }
  renderCatchupCurrentRow(channel, title)
  paintEpgSidePanel(channel.id)

  const seq = ++playSeq
  const mime = resolution.kindHint === "hls" ? "application/x-mpegURL" : "video/mp2t"
  lastPlayContext = {
    streamId: channel.id,
    name: channel.name,
    src: resolution.src,
    seq,
    retried: false,
    started: false,
    // Skip the Android native-handoff escape hatch for catch-up sessions.
    nativeFallbackTried: true,
    audioClockWedge: false,
    mime,
    isLive: false,
  }
  getPlayerInsights().startSession({ label: channel.name, seq })
  hideBufferingChip()
  clearStallSentinel()
  suppressPauseTrackingUntilMs = Date.now() + 500
  try { player.reset?.() } catch {}

  // Drop one-shot listeners from a superseded mount before adding new ones (handle is reused across remounts).
  if (catchupLoadedMetadataHandler) {
    try { player.off?.("loadedmetadata", catchupLoadedMetadataHandler) } catch {}
    catchupLoadedMetadataHandler = null
  }
  if (catchupEndedHandler) {
    try { player.off?.("ended", catchupEndedHandler) } catch {}
    catchupEndedHandler = null
  }

  // Mounted stream lands at [offset, span] on the [timelineStart, stop] timeline so position/duration stay 1:1 across remounts.
  const timelineOffsetSeconds = Math.max(0, (mountedStartUtcMs - timelineStartUtcMs) / 1000)
  const timelineSpanSeconds = timelineStopUtcMs != null
    ? Math.max(1, Math.round((timelineStopUtcMs - timelineStartUtcMs) / 1000))
    : Math.max(1, Math.round((Math.min(stopUtcMs, Date.now()) - timelineStartUtcMs) / 1000))
  const initialPositionSeconds = Math.max(0, (startUtcMs - timelineStartUtcMs) / 1000 + seekSeconds)
  if (initialPositionSeconds > 0.05) {
    catchupLoadedMetadataHandler = () => {
      markProgrammaticCatchupSeek()
      try { player.currentTime?.(initialPositionSeconds) } catch {}
    }
    player.one?.("loadedmetadata", catchupLoadedMetadataHandler)
  }
  catchupEndedHandler = () => {
    if (seq !== playSeq || !catchupSession) return
    const timelineDurationSeconds = player.duration?.() || 0
    const rawSegmentSeconds = timelineDurationSeconds - timelineOffsetSeconds
    const segmentSeconds = Number.isFinite(rawSegmentSeconds) ? rawSegmentSeconds : 0
    const absoluteMs = catchupSession.timelineStartUtcMs + timelineDurationSeconds * 1000
    // Two consecutive endings at the same instant mean the archive has nothing more there; remounting again would just churn.
    if (catchupLastEndedAbsUtcMs != null && Math.abs(absoluteMs - catchupLastEndedAbsUtcMs) < 1500) {
      catchupLastEndedAbsUtcMs = null
      backToLive(channel)
      return
    }
    catchupLastEndedAbsUtcMs = absoluteMs
    // Archives routinely stop a few seconds short of the EPG stop; a replay that got this far is finished, not dropped.
    if (catchupSession.kind === "programme" && absoluteMs >= catchupSession.stopUtcMs - CATCHUP_PROGRAMME_END_SLACK_MS) {
      const nextProgramme = resolveProgrammeWindowAt(channel, catchupSession.stopUtcMs + 1000)
      const nextIsReplayable =
        nextProgramme &&
        Date.now() - nextProgramme.startUtcMs > minDistanceFromLiveMs(catchupSession.profile) &&
        isCatchupPlayable(channel, nextProgramme.startUtcMs, Date.now())
      if (nextIsReplayable) {
        void playCatchup(channel, {
          startUtcMs: nextProgramme.startUtcMs,
          stopUtcMs: nextProgramme.stopUtcMs,
          title: resolveProgrammeTitleAt(channel, nextProgramme.startUtcMs + 1000),
          kind: "programme",
        })
        return
      }
      backToLive(channel)
      return
    }
    const decision = autoAdvanceDecision({
      segmentSeconds,
      currentAbsUtcMs: absoluteMs,
      nowUtcMs: Date.now(),
      programme: resolveProgrammeWindowAt(channel, absoluteMs),
      strikes: catchupConsecutiveShortAdvances,
      profile: catchupSession.profile,
    })
    catchupConsecutiveShortAdvances = decision.action === "live" ? 0 : decision.strikes
    if (decision.action === "live") {
      backToLive(channel)
      return
    }
    // A programme replay whose stream dropped mid-programme keeps its session shape, so the episode-length bar and timeline zero survive the remount.
    if (catchupSession.kind === "programme" && absoluteMs < catchupSession.stopUtcMs - CATCHUP_PROGRAMME_END_SLACK_MS) {
      void playCatchup(channel, {
        startUtcMs: absoluteMs,
        stopUtcMs: catchupSession.stopUtcMs,
        timelineStartUtcMs: catchupSession.timelineStartUtcMs,
        timelineStopUtcMs: catchupSession.timelineStopUtcMs,
        title: catchupSession.title,
        kind: "programme",
        catchupId: catchupSession.catchupId,
      })
      return
    }
    // Bypasses seekToAbsolute deliberately: the EPG-bounded stopUtcMs must survive the remount.
    void playCatchup(channel, {
      startUtcMs: absoluteMs,
      stopUtcMs: decision.nextStopUtcMs ?? Date.now(),
      title: resolveProgrammeTitleAt(channel, absoluteMs),
      kind: "timeshift",
    })
  }
  player.one?.("ended", catchupEndedHandler)
  player.src({
    src: resolution.src,
    type: mime,
    isLive: false,
    durationSeconds: timelineSpanSeconds,
    timelineOffsetSeconds,
  })
  attachCatchupSeekInterceptor(player, seq)
  armLiveEdgeTracking(channel)
  const playResult = player.play?.()
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) => {
      // An interrupted play() otherwise leaves the tune paused until a manual click.
      // AbortError is the expected remount-vs-autoplay race, so it stays out of the log file.
      const errorName = err?.name || String(err)
      const write = errorName === "AbortError" ? log.debug : log.info
      write("[xt:livetv] initial play() rejected - re-arming on canplay", { streamId, error: errorName })
      const mediaEl = player.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
      if (!mediaEl) return
      const resume = () => {
        mediaEl.removeEventListener("canplay", resume)
        if (lastPlayContext?.streamId !== streamId) return
        try {
          void player.play?.()?.catch?.((retryErr) => {
            log.warn("[xt:livetv] retry play() rejected", { streamId, error: retryErr?.name || String(retryErr) })
          })
        } catch {}
      }
      mediaEl.addEventListener("canplay", resume)
      setTimeout(() => mediaEl.removeEventListener("canplay", resume), 20000)
    })
  }
  applyVideoScale()
  return true
}

/** Suppresses the seek interceptor while our own code moves the playhead. */
function markProgrammaticCatchupSeek() {
  catchupProgrammaticSeekUntilMs = Date.now() + 1500
}

/** No-Range realtime archive server: intercept native-bar seeks outside the buffer and re-request the stream at the target instant. */
function attachCatchupSeekInterceptor(player, seq) {
  if (catchupSeekingEl && catchupSeekingHandler) {
    try { catchupSeekingEl.removeEventListener("seeking", catchupSeekingHandler) } catch {}
    catchupSeekingEl = null
    catchupSeekingHandler = null
  }
  const mediaEl = player.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
  if (!mediaEl) return
  catchupSeekingHandler = () => {
    if (seq !== playSeq || !catchupSession) return
    if (Date.now() < catchupProgrammaticSeekUntilMs) return
    const targetSeconds = mediaEl.currentTime
    const buffered = mediaEl.buffered
    for (let i = 0; i < buffered.length; i++) {
      if (targetSeconds >= buffered.start(i) - 1 && targetSeconds <= buffered.end(i) + 2) return
    }
    if (catchupSeekRemountCount >= CATCHUP_MAX_SEEK_REMOUNTS) {
      // Circuit breaker: a remount can take up to CATCHUP_TUNING_MAX_MS, so pin the playhead back instead of chasing another one.
      markProgrammaticCatchupSeek()
      if (buffered.length) {
        try { mediaEl.currentTime = Math.max(0, buffered.end(buffered.length - 1) - 1) } catch {}
      }
      if (lastPlayContext) showPlaybackFailurePanel(lastPlayContext)
      return
    }
    catchupSeekRemountCount++
    markProgrammaticCatchupSeek()
    void seekToAbsolute(catchupSession.timelineStartUtcMs + targetSeconds * 1000, { viaSeekInterceptor: true })
  }
  catchupSeekingEl = mediaEl
  mediaEl.addEventListener("seeking", catchupSeekingHandler)
}

/** Clears the ghost-region CSS state and its tick interval; called whenever the active session ends or is superseded. */
function clearLiveEdgeTracking() {
  if (liveEdgeTickTimer != null) {
    clearInterval(liveEdgeTickTimer)
    liveEdgeTickTimer = null
  }
  const wrap = getPlayerWrap()
  if (!wrap) return
  wrap.style.removeProperty("--xt-live-edge")
  delete wrap.dataset.timeshiftFullSpan
}

/** Drives the live-edge marker CSS var and programme rollover for a full-programme-span session; no-op for an elapsed-capped one. */
function armLiveEdgeTracking(channel) {
  clearLiveEdgeTracking()
  const session = catchupSession
  if (!session || session.timelineStopUtcMs == null) return
  const wrap = getPlayerWrap()
  if (!wrap) return
  wrap.dataset.timeshiftFullSpan = "true"

  const tick = async () => {
    const activeSession = catchupSession
    if (!activeSession || activeSession.timelineStopUtcMs == null || !vjs) return
    const spanMs = activeSession.timelineStopUtcMs - activeSession.timelineStartUtcMs
    const liveEdgeFraction = spanMs > 0
      ? Math.min(1, Math.max(0, (Date.now() - activeSession.timelineStartUtcMs) / spanMs))
      : 1
    wrap.style.setProperty("--xt-live-edge", String(liveEdgeFraction))

    const playheadAbsUtcMs = activeSession.timelineStartUtcMs + (vjs.currentTime() || 0) * 1000
    if (playheadAbsUtcMs < activeSession.timelineStopUtcMs - TIMELINE_ROLLOVER_SLACK_MS) return
    const nextProgramme = resolveProgrammeWindowAt(channel, activeSession.timelineStopUtcMs + 1000)
    // No EPG for the next slot - the stream's own duration keeps extending, leave it alone.
    if (!nextProgramme) return
    // A stale/short next slot already behind live must not force full span - let playCatchup's own derivation decide.
    const nextIsStillAiring = nextProgramme.stopUtcMs > Date.now() + TIMELINE_ROLLOVER_SLACK_MS
    clearLiveEdgeTracking()
    const remounted = await playCatchup(channel, {
      startUtcMs: playheadAbsUtcMs,
      stopUtcMs: Date.now(),
      ...(nextIsStillAiring
        ? { timelineStartUtcMs: nextProgramme.startUtcMs, timelineStopUtcMs: nextProgramme.stopUtcMs }
        : {}),
      title: resolveProgrammeTitleAt(channel, playheadAbsUtcMs),
      kind: "timeshift",
    })
    // A failed rollover remount leaves the old session stranded past its stop with no tracking left to retry it.
    if (!remounted) backToLive(channel)
  }
  void tick()
  liveEdgeTickTimer = setInterval(() => void tick(), 1000)
}

/** Best-guess stream profile before a session exists yet (e.g. tapping rewind on a live channel). */
function provisionalStreamProfile(channel): StreamProfile {
  return channel?.url ? streamProfileFor(channel) : XTREAM_STREAM_PROFILE
}

/** Committed timeshift seek: clamp against the archive window, take the buffered fast-path when possible, otherwise remount via playCatchup. */
async function seekToAbsolute(targetUtcMs, seekOpts = {}) {
  const channelId = catchupSession?.channelId ?? currentlyPlayingId
  const channel = all.find((entry) => entry.id === channelId)
  if (!channel) return

  const profile = catchupSession?.profile ?? provisionalStreamProfile(channel)
  const nowUtcMs = Date.now()
  const currentAbsoluteMs = catchupSession
    ? catchupSession.timelineStartUtcMs + (vjs?.currentTime?.() || 0) * 1000
    : nowUtcMs
  if (shouldIgnoreSeek(targetUtcMs - currentAbsoluteMs, { lastSeekWasLive: !catchupSession, profile })) return

  const catchupWindowMs = catchupWindowDays(channel) * 24 * 60 * 60 * 1000
  const clamped = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs, profile })
  if (clamped.kind === "live") {
    backToLive(channel)
    return
  }

  // forceRemount: resume-after-long-pause must rebuild the connection even when the paused position still sits at a buffered edge.
  if (!seekOpts.forceRemount && catchupSession && catchupSession.channelId === channel.id && vjs) {
    const videoEl = vjs.getMediaElement?.() ?? getPlayerWrap()?.querySelector("video")
    const buffered = videoEl?.buffered
    if (buffered) {
      const relSeconds = (clamped.targetUtcMs - catchupSession.timelineStartUtcMs) / 1000
      for (let i = 0; i < buffered.length; i++) {
        if (relSeconds >= buffered.start(i) - 1 && relSeconds <= buffered.end(i) + 1) {
          markProgrammaticCatchupSeek()
          try { vjs.currentTime(Math.max(0, relSeconds)) } catch {}
          return
        }
      }
    }
  }

  const remountTargetUtcMs = profile.granularitySeconds === 60
    ? adjustTargetForGranularity(clamped.targetUtcMs, nowUtcMs, 60_000)
    : clamped.targetUtcMs

  // A jump within a programme replay stays bounded to the programme window, so the native bar keeps its episode-like span.
  const withinProgrammeReplay =
    catchupSession &&
    catchupSession.kind === "programme" &&
    catchupSession.channelId === channel.id &&
    remountTargetUtcMs < catchupSession.stopUtcMs
  if (withinProgrammeReplay) {
    void playCatchup(channel, {
      startUtcMs: remountTargetUtcMs,
      stopUtcMs: catchupSession.stopUtcMs,
      timelineStartUtcMs: catchupSession.timelineStartUtcMs,
      timelineStopUtcMs: catchupSession.timelineStopUtcMs,
      title: catchupSession.title,
      kind: "programme",
      catchupId: catchupSession.catchupId,
      preserveSeekRemountBudget: seekOpts.viaSeekInterceptor === true,
    })
    return
  }

  // Non-terminating profiles (e.g. playseek-dialect) follow live through the current programme's end instead of stopping at "now".
  const windowAtTarget = !profile.terminates ? resolveProgrammeWindowAt(channel, remountTargetUtcMs) : null
  const remountStopUtcMs = windowAtTarget && windowAtTarget.stopUtcMs > nowUtcMs ? windowAtTarget.stopUtcMs : nowUtcMs

  void playCatchup(channel, {
    startUtcMs: remountTargetUtcMs,
    stopUtcMs: remountStopUtcMs,
    title: resolveProgrammeTitleAt(channel, remountTargetUtcMs),
    kind: "timeshift",
    preserveSeekRemountBudget: seekOpts.viaSeekInterceptor === true,
  })
}

async function openDisplayModeDialog(streamId) {
  const currentMode = resolveVideoScaleMode()
  const result = await openVideoScaleDialog({
    currentMode,
    onPreview: (mode) => videoScaleController.apply(mode),
  })
  applyVideoScale()
  if (!result) return
  if (result.applyToAll) {
    if (activePlaylistId) clearAllVideoScaleOverrides(activePlaylistId, "live")
    setVideoScale(result.mode)
    toast({
      title: t("stream.scale.toastAllChannels", { mode: t(videoScaleModeLabelKey(result.mode)) }),
      duration: 2200,
    })
  } else if (activePlaylistId) {
    setVideoScaleOverride(activePlaylistId, "live", streamId, result.mode)
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
      suppressPauseTrackingUntilMs = Date.now() + 500
      try { vjs?.pause?.() } catch {}
    },
    afterLaunch: () => {
      const channel = all.find((entry) => entry.id === streamId)
      pushDiscordPresence(channel || { id: streamId, name }, "live")
      externalPresenceActive = true
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
// Number of EPG_SIDE_PANEL_PAST_WINDOW_MS pages currently shown; grows via the "Load earlier" button.
let epgSidePanelPastPages = 1
let epgSidePanelExtending = false

const epgDayKey = (ms) => new Date(ms).toDateString()

function epgDayLabel(ms) {
  const date = new Date(ms)
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const diffDays = Math.round((startOfDay(date) - startOfDay(new Date())) / (24 * 60 * 60 * 1000))
  if (diffDays === 0) return t("epg.today")
  if (diffDays === -1) return t("epg.yesterday")
  if (diffDays === 1) return t("epg.tomorrow")
  return new Intl.DateTimeFormat(getActiveLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date)
}

function renderEpgDaySeparator(ms) {
  return `<div class="epg-day-sep flex items-center gap-2 pt-2 pb-0.5 px-1 text-2xs font-semibold uppercase tracking-wide text-fg-3">${escapeHtml(epgDayLabel(ms))}</div>`
}

/** Reflects the day whose entries are scrolled under the sticky heading, since separators no longer pin there themselves. */
function updateEpgDayIndicator() {
  if (!epgDayIndicator || !epgPanel) return
  if (!epgListData.length) {
    if (epgDayIndicator.textContent) epgDayIndicator.textContent = ""
    return
  }
  const heading = epgPanel.querySelector(".sticky")
  const stickyHeadingHeight = heading instanceof HTMLElement ? heading.offsetHeight : 0
  const boundary = epgPanel.getBoundingClientRect().top + stickyHeadingHeight
  const separators = epgList ? Array.from(epgList.querySelectorAll(".epg-day-sep")) : []
  let currentLabel = ""
  for (const separator of separators) {
    if (separator.getBoundingClientRect().top <= boundary + 2) currentLabel = separator.textContent || ""
  }
  if (!currentLabel) currentLabel = epgDayLabel(epgListData[0].start)
  if (epgDayIndicator.textContent !== currentLabel) epgDayIndicator.textContent = currentLabel
}

let epgDayIndicatorScrollPending = false
epgPanel?.addEventListener(
  "scroll",
  () => {
    if (epgDayIndicatorScrollPending) return
    epgDayIndicatorScrollPending = true
    requestAnimationFrame(() => {
      epgDayIndicatorScrollPending = false
      updateEpgDayIndicator()
    })
  },
  { passive: true },
)

/** Whether the entry starting at `entryStartMs` is the one actually mounted right now, accounting for an active catch-up/timeshift session. */
function isEpgEntryPlaying(entryStartMs, entryStopMs, isLive, isM3uSource) {
  if (catchupSession) {
    if (catchupSession.channelId !== epgListChannelId) return false
    const entryStartUtcMs = isM3uSource ? displayedToUtcMs(activePlaylistId, entryStartMs) : entryStartMs
    const entryStopUtcMs = isM3uSource ? displayedToUtcMs(activePlaylistId, entryStopMs) : entryStopMs
    return entryStartUtcMs <= catchupSession.startUtcMs && catchupSession.startUtcMs < entryStopUtcMs
  }
  return isLive && currentlyPlayingId === epgListChannelId
}

async function loadEPG(streamId) {
  if (!epgList) return
  epgList.innerHTML = `<div class="text-fg-3">Loading EPG…</div>`
  epgListData = []
  if (epgDayIndicator) epgDayIndicator.textContent = ""
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
      if (epgDayIndicator) epgDayIndicator.textContent = ""
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

    let previousDayKey = epgDayKey(now)
    epgList.innerHTML = epgListData
      .map((p, idx) => {
        const isLive = p.start <= now && now < p.stop
        const isPlaying = isEpgEntryPlaying(p.start, p.stop, isLive, false)
        const start = fmtTime(p.start / 1000)
        const end = fmtTime(p.stop / 1000)
        const title = escapeHtml(p.title)
        const desc = escapeHtml(p.desc)
        const dayKey = epgDayKey(p.start)
        const daySeparator = dayKey !== previousDayKey ? renderEpgDaySeparator(p.start) : ""
        previousDayKey = dayKey
        const rowClass = isPlaying
          ? "bg-accent-soft ring-1 ring-accent/30 hover:bg-accent/20"
          : isLive
          ? "bg-surface-2 hover:bg-surface-3 ring-1 ring-accent/30"
          : "bg-surface-2 hover:bg-surface-3"
        const dot = isLive
          ? '<span class="size-1.5 rounded-full bg-accent shrink-0" aria-hidden="true"></span>'
          : ""
        return `
          ${daySeparator}
          <button type="button" data-epg-idx="${idx}"${isPlaying ? ' data-now-playing="true" aria-current="true"' : ""}
            class="epg-entry block w-full min-h-11 text-left rounded-lg px-3 py-2 outline-none transition-colors
                   ${rowClass}
                   focus-visible:ring-1 focus-visible:ring-accent">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                ${dot}
                <div class="font-medium text-fg truncate">${title}</div>
              </div>
              <div class="text-xs text-fg-3 tabular-nums shrink-0">${start}–${end}</div>
            </div>
            ${desc ? `<div class="mt-1 text-sm text-fg-2 leading-relaxed line-clamp-3">${desc}</div>` : ""}
          </button>`
      })
      .join("")
    updateEpgDayIndicator()
  } catch (e) {
    log.error(e)
    epgList.innerHTML = `<div class="text-bad">Failed to load EPG.</div>`
    if (epgDayIndicator) epgDayIndicator.textContent = ""
  }
}

/** Splits a sorted programme array into the upcoming slice (next 10) and a past slice sized by `pastPages` (page 1 shows the 8 most recent, "Load earlier" pages grow the window). */
function computeEpgSidePanelWindow(programmes, pastPages, supportsCatchup) {
  const now = Date.now()
  const upcoming = programmes.filter((programme) => programme.stop >= now).slice(0, 10)
  const pastWindowMs = pastPages * EPG_SIDE_PANEL_PAST_WINDOW_MS
  const pastWithinWindow = supportsCatchup
    ? programmes.filter((programme) => programme.stop < now && now - programme.stop <= pastWindowMs)
    : []
  const past = pastPages > 1 ? pastWithinWindow : pastWithinWindow.slice(-8)
  return { past, upcoming }
}

/** Shared side-panel renderer for past + upcoming rows; isM3uSource marks entry times as display-shifted XMLTV rather than true UTC. */
function renderEpgSidePanelRows(past, upcoming, { isM3uSource, canLoadEarlier, isNewChannelPaint }) {
  const combined = [...past, ...upcoming]
  epgListData = combined
  const now = Date.now()
  const loadEarlierHtml = canLoadEarlier
    ? `<button type="button" data-epg-load-earlier
         class="block w-full min-h-11 rounded-lg bg-surface-2 hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-accent text-sm text-fg-2 transition-colors">${escapeHtml(t("livetv.epgLoadEarlier"))}</button>`
    : ""

  let previousDayKey = epgDayKey(now)
  let playingIndex = -1
  let liveIndex = -1
  const rowsHtml = combined
    .map((programme, idx) => {
      const isLive = programme.start <= now && now < programme.stop
      const isPlaying = isEpgEntryPlaying(programme.start, programme.stop, isLive, isM3uSource)
      if (isPlaying) playingIndex = idx
      if (isLive) liveIndex = idx
      const isPast = programme.stop <= now
      const start = fmtTime(programme.start / 1000)
      const end = fmtTime(programme.stop / 1000)
      const title = escapeHtml(programme.title)
      const desc = escapeHtml(programme.desc)
      // has_archive narrows the badge/playability when the provider sends it; missing/null means "trust the channel-level catch-up window".
      const archiveKnownPlayable = programme.hasArchive == null ? true : programme.hasArchive
      const replayBadge = isPast && archiveKnownPlayable
        ? `<span class="inline-flex shrink-0 items-center rounded-md border border-line bg-surface-2 px-1.5 text-2xs font-medium text-fg-3">${escapeHtml(t("catchup.badge"))}</span>`
        : ""
      const dayKey = epgDayKey(programme.start)
      const daySeparator = dayKey !== previousDayKey ? renderEpgDaySeparator(programme.start) : ""
      previousDayKey = dayKey
      const rowClass = isPlaying
        ? "bg-accent-soft ring-1 ring-accent/30 hover:bg-accent/20"
        : isLive
        ? "bg-surface-2 hover:bg-surface-3 ring-1 ring-accent/30"
        : "bg-surface-2 hover:bg-surface-3"
      const dot = isLive
        ? '<span class="size-1.5 rounded-full bg-accent shrink-0" aria-hidden="true"></span>'
        : ""
      return `
        ${daySeparator}
        <button type="button" data-epg-idx="${idx}"${isPlaying ? ' data-now-playing="true" aria-current="true"' : ""}
          class="epg-entry block w-full min-h-11 text-left rounded-lg px-3 py-2 outline-none transition-colors
                 ${rowClass}
                 focus-visible:ring-1 focus-visible:ring-accent">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              ${dot}
              <div class="font-medium text-fg truncate">${title}</div>
              ${replayBadge}
            </div>
            <div class="text-xs text-fg-3 tabular-nums shrink-0">${start}–${end}</div>
          </div>
          ${desc ? `<div class="mt-1 text-sm text-fg-2 leading-relaxed line-clamp-3">${desc}</div>` : ""}
        </button>`
    })
    .join("")
  epgList.innerHTML = loadEarlierHtml + rowsHtml

  // Fresh channel tune lands the panel on the playing/live/upcoming entry; same-channel repaints keep position.
  if (isNewChannelPaint && epgPanel) {
    const scrollIndex = playingIndex >= 0 ? playingIndex : liveIndex >= 0 ? liveIndex : past.length
    const targetEntry = epgList.querySelector(`[data-epg-idx="${scrollIndex}"]`)
    if (targetEntry instanceof HTMLElement) {
      const panelRect = epgPanel.getBoundingClientRect()
      const targetRect = targetEntry.getBoundingClientRect()
      const heading = epgPanel.querySelector(".sticky")
      const stickyHeadingHeight = heading instanceof HTMLElement ? heading.offsetHeight : 0
      epgPanel.scrollTop = Math.max(0, epgPanel.scrollTop + (targetRect.top - panelRect.top) - stickyHeadingHeight - 8)
    }
  }
  updateEpgDayIndicator()
}

/** M3U variant of loadEPG: renders the channel's XMLTV programmes (via effective tvg-id) through the shared renderer. */
function paintSidePanelFromXmltv(streamId) {
  if (!epgList) return
  const channel = all.find((entry) => entry.id === streamId)
  if (!channel) {
    epgList.innerHTML = `<div class="text-fg-3" data-i18n="epg.sidePanelEmpty">${escapeHtml(t("epg.sidePanelEmpty"))}</div>`
    if (epgDayIndicator) epgDayIndicator.textContent = ""
    return
  }
  const isNewChannelPaint = streamId !== epgListChannelId
  if (isNewChannelPaint) epgSidePanelPastPages = 1
  epgListChannelId = streamId
  epgListChannelName = channel.name || ""

  const tvgId = effectiveTvgId(channel, activePlaylistId)
  if (!tvgId) {
    epgList.innerHTML = `<div class="text-fg-3">${escapeHtml(t("epg.sidePanelNoMapping"))}</div>`
    epgListData = []
    if (epgDayIndicator) epgDayIndicator.textContent = ""
    return
  }

  const state = getProgrammesSync(activePlaylistId)
  // rawStart/rawStop let the catch-up handler below recover true XMLTV time, bypassing tvg-shift.
  const programmes = shiftChannelProgrammes(state?.programmes?.get(tvgId) || [], channel.tvgShift)
  if (!programmes.length) {
    epgList.innerHTML = `<div class="text-fg-3">${escapeHtml(t("epg.sidePanelEmpty"))}</div>`
    epgListData = []
    if (epgDayIndicator) epgDayIndicator.textContent = ""
    return
  }

  const supportsCatchup = channelSupportsCatchup(channel)
  const { past, upcoming } = computeEpgSidePanelWindow(programmes, epgSidePanelPastPages, supportsCatchup)
  if (!past.length && !upcoming.length) {
    epgList.innerHTML = `<div class="text-fg-3" data-i18n="epg.sidePanelEmpty">${escapeHtml(t("epg.sidePanelEmpty"))}</div>`
    epgListData = []
    if (epgDayIndicator) epgDayIndicator.textContent = ""
    return
  }

  const maxPastPages = Math.min(catchupWindowDays(channel), EPG_SIDE_PANEL_MAX_PAST_DAYS)
  const canLoadEarlier = supportsCatchup && epgSidePanelPastPages < maxPastPages
  renderEpgSidePanelRows(past, upcoming, { isM3uSource: true, canLoadEarlier, isNewChannelPaint })
}

// ----------------------------
// Xtream full-table EPG (past programmes for catch-up-capable channels)
// ----------------------------
const XTREAM_FULL_EPG_CACHE_TTL_MS = 15 * 60 * 1000
// "playlistId:streamId" -> { at, entries }. The full table can span several days, so this stays in memory rather than IndexedDB.
const xtreamFullEpgCache = new Map()

function normalizeXtreamFullEpgListings(listings) {
  return listings
    .map((listing) => {
      const startUtcMs = Number(listing.start_timestamp ?? listing.start) * 1000
      const stopUtcMs = Number(listing.stop_timestamp ?? listing.end) * 1000
      if (!Number.isFinite(startUtcMs) || !Number.isFinite(stopUtcMs) || stopUtcMs <= startUtcMs) return null
      const archiveFlag = listing.has_archive
      const hasArchive = archiveFlag === undefined || archiveFlag === null ? null : Number(archiveFlag) === 1
      return {
        startUtcMs,
        stopUtcMs,
        title: maybeB64ToUtf8(listing.title || listing.title_raw || t("programme.untitled")),
        description: maybeB64ToUtf8(listing.description || listing.description_raw || ""),
        hasArchive,
      }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.startUtcMs - b.startUtcMs)
}

async function fetchXtreamFullEpgAction(action, streamId) {
  // Never throw: a 2xx non-JSON body for the first action spelling must still let the fallback spelling run.
  try {
    const response = await xtreamApiFetch(action, { stream_id: String(streamId) })
    if (!response.ok) return null
    const data = await response.json()
    const listings = Array.isArray(data?.epg_listings) ? data.epg_listings : []
    return listings.length ? listings : null
  } catch {
    return null
  }
}

/** Fresh cached full-table entries, or null (used to skip the loading placeholder on remount repaints). */
function peekXtreamFullEpgCache(channel) {
  const cached = xtreamFullEpgCache.get(`${activePlaylistId}:${channel.id}`)
  return cached && Date.now() - cached.at < XTREAM_FULL_EPG_CACHE_TTL_MS ? cached.entries : null
}

/** Full-table Xtream EPG (`get_simple_date_table`, falling back to the `get_simple_data_table` spelling), windowed and cached per playlist+channel. */
async function fetchXtreamFullEpg(channel) {
  const cacheKey = `${activePlaylistId}:${channel.id}`
  const cached = xtreamFullEpgCache.get(cacheKey)
  if (cached && Date.now() - cached.at < XTREAM_FULL_EPG_CACHE_TTL_MS) return cached.entries
  try {
    const listings =
      (await fetchXtreamFullEpgAction("get_simple_date_table", channel.id)) ||
      (await fetchXtreamFullEpgAction("get_simple_data_table", channel.id))
    if (!listings) return null
    const normalized = normalizeXtreamFullEpgListings(listings)
    const now = Date.now()
    const windowStartMs = now - catchupWindowDays(channel) * 24 * 60 * 60 * 1000
    const windowEndMs = now + 36 * 60 * 60 * 1000
    const windowed = normalized.filter(
      (entry) => entry.startUtcMs >= windowStartMs && entry.startUtcMs <= windowEndMs
    )
    for (const [existingKey, existingEntry] of xtreamFullEpgCache) {
      if (now - existingEntry.at >= XTREAM_FULL_EPG_CACHE_TTL_MS) xtreamFullEpgCache.delete(existingKey)
    }
    xtreamFullEpgCache.set(cacheKey, { at: now, entries: windowed })
    return windowed
  } catch (err) {
    log.warn("[xt:livetv] fetchXtreamFullEpg failed:", err)
    return null
  }
}

/** Maps cached full-table listings to the {start, stop, title, desc, hasArchive} shape renderEpgSidePanelRows expects. */
function xtreamListingsToProgrammes(listings) {
  return listings.map((listing) => ({
    start: listing.startUtcMs,
    stop: listing.stopUtcMs,
    title: listing.title,
    desc: listing.description,
    hasArchive: listing.hasArchive,
  }))
}

function renderXtreamEpgEntries(channel, programmes, isNewChannelPaint) {
  const { past, upcoming } = computeEpgSidePanelWindow(programmes, epgSidePanelPastPages, true)
  const maxPastPages = Math.min(catchupWindowDays(channel), EPG_SIDE_PANEL_MAX_PAST_DAYS)
  const canLoadEarlier = epgSidePanelPastPages < maxPastPages
  renderEpgSidePanelRows(past, upcoming, { isM3uSource: false, canLoadEarlier, isNewChannelPaint })
}

/** Xtream variant of paintSidePanelFromXmltv: fetches the full EPG table for catch-up-capable channels; falls back to loadEPG's short list when the table is unavailable. */
async function paintSidePanelFromXtreamEpg(streamId, channel) {
  if (!epgList) return
  const isNewChannelPaint = streamId !== epgListChannelId
  if (isNewChannelPaint) epgSidePanelPastPages = 1
  epgListChannelId = streamId
  epgListChannelName = channel.name || ""
  epgListData = []
  // Remount repaints (seek, auto-advance) hit the cache; blanking to a placeholder there just flashes the panel.
  if (!peekXtreamFullEpgCache(channel)) {
    epgList.innerHTML = `<div class="text-fg-3">${escapeHtml(t("epg.loading"))}</div>`
    if (epgDayIndicator) epgDayIndicator.textContent = ""
  }

  const listings = await fetchXtreamFullEpg(channel)
  // A different channel has since taken over the panel while the fetch was in flight.
  if (epgListChannelId !== streamId) return
  if (!listings || !listings.length) {
    loadEPG(streamId)
    return
  }
  renderXtreamEpgEntries(channel, xtreamListingsToProgrammes(listings), isNewChannelPaint)
}

/** Side-panel EPG router: XMLTV for M3U channels, full table for catch-up-capable Xtream channels, short EPG otherwise. */
function paintEpgSidePanel(streamId) {
  if (hasDirectUrl(streamId)) {
    paintSidePanelFromXmltv(streamId)
    return
  }
  const channel = all.find((entry) => entry.id === streamId)
  if (channel && channelSupportsCatchup(channel)) {
    void paintSidePanelFromXtreamEpg(streamId, channel)
    return
  }
  loadEPG(streamId)
}

/** Loads one more day of past programmes into the side panel, re-rendering while preserving scroll position. */
function extendSidePanelPastWindow() {
  if (epgSidePanelExtending) return
  const streamId = epgListChannelId
  const channel = all.find((entry) => entry.id === streamId)
  if (!channel || !channelSupportsCatchup(channel)) return
  const maxPastPages = Math.min(catchupWindowDays(channel), EPG_SIDE_PANEL_MAX_PAST_DAYS)
  if (epgSidePanelPastPages >= maxPastPages) return

  const isM3uPanel = hasDirectUrl(streamId)
  const cachedXtreamEntries = isM3uPanel ? null : peekXtreamFullEpgCache(channel)
  // No fresh cache to extend from: refetch instead of consuming a page on a no-op.
  if (!isM3uPanel && !cachedXtreamEntries) {
    void paintSidePanelFromXtreamEpg(streamId, channel)
    return
  }

  epgSidePanelExtending = true
  const focusWasInList = !!epgList && epgList.contains(document.activeElement)
  epgSidePanelPastPages = Math.min(epgSidePanelPastPages + 1, maxPastPages)
  const previousScrollHeight = epgPanel?.scrollHeight ?? 0
  const previousScrollTop = epgPanel?.scrollTop ?? 0
  if (isM3uPanel) {
    paintSidePanelFromXmltv(streamId)
  } else {
    renderXtreamEpgEntries(channel, xtreamListingsToProgrammes(cachedXtreamEntries), false)
  }
  if (epgPanel) epgPanel.scrollTop = previousScrollTop + (epgPanel.scrollHeight - previousScrollHeight)
  if (focusWasInList) {
    const nextFocusTarget = epgList?.querySelector("[data-epg-load-earlier]") ?? epgList?.querySelector("[data-epg-idx]")
    if (nextFocusTarget instanceof HTMLElement) nextFocusTarget.focus({ preventScroll: true })
  }
  epgSidePanelExtending = false
}

epgList?.addEventListener("click", async (e) => {
  const target = /** @type {HTMLElement | null} */ (e.target)
  if (target?.closest("[data-epg-load-earlier]")) {
    extendSidePanelPastWindow()
    return
  }
  const btn = target?.closest("[data-epg-idx]")
  if (!btn) return
  const idx = Number(/** @type {HTMLElement} */ (btn).dataset.epgIdx)
  const entry = epgListData[idx]
  if (!entry) return

  const channel = all.find((candidate) => candidate.id === epgListChannelId)
  const now = Date.now()
  const isLive = entry.start <= now && now < entry.stop
  const isEnded = entry.stop <= now
  // XMLTV panel entries carry display-shifted times; short-EPG and full-table entries are already UTC.
  // rawStart/rawStop recover the true XMLTV time so catch-up math never sees the tvg-shift correction.
  const isM3uSource = hasDirectUrl(epgListChannelId)
  const startUtcMs = isM3uSource ? displayedToUtcMs(activePlaylistId, entry.rawStart ?? entry.start) : entry.start
  const stopUtcMs = isM3uSource ? displayedToUtcMs(activePlaylistId, entry.rawStop ?? entry.stop) : entry.stop
  // has_archive narrows catch-up eligibility when sent; it never widens past the channel-level window check.
  const archiveKnownPlayable = entry.hasArchive == null ? true : entry.hasArchive

  let onCatchup
  let onWatchFromStart
  if (channel && channelSupportsCatchup(channel)) {
    if (isEnded && archiveKnownPlayable && isCatchupPlayable(channel, startUtcMs, now)) {
      onCatchup = () => {
        void playCatchup(channel, { startUtcMs, stopUtcMs, title: entry.title, catchupId: entry.catchupId })
      }
    }
    // has_archive is 0 while a programme is still airing, so it must not gate "Watch from start".
    if (isLive && isCatchupPlayable(channel, startUtcMs, now)) {
      onWatchFromStart = () => {
        void playCatchup(channel, { startUtcMs, stopUtcMs, title: entry.title, seekSeconds: 0, catchupId: entry.catchupId })
      }
    }
  }

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
    onCatchup,
    onWatchFromStart,
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
