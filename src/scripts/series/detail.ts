// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Series detail page (route: /series/detail?id=<series_id>).
// Cache-driven on first paint so it works offline once a series has been
// opened at least once before.
import { log } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
} from "@/scripts/lib/creds.js"
import { xtreamApiFetch, resolveStreamUrl } from "@/scripts/lib/xtream-api.js"
import { getCached, setCached } from "@/scripts/lib/cache.js"
import { ensureSeries } from "@/scripts/lib/catalog.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  pushRecent,
  getProgress,
  setProgress,
  markCompleted,
  isCompleted,
  clearProgress,
  getVideoScaleOverride,
  setVideoScaleOverride,
  clearAllVideoScaleOverrides,
  CHANNEL_VIDEO_SCALE_CHANGED_EVENT,
} from "@/scripts/lib/preferences.js"
import { openExternal } from "@/scripts/lib/external-link.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  startDownload,
  resumeDownload,
  pauseDownload,
  isDownloadable,
  inferExt,
  listDownloads,
  getLocalPlayableSrc,
  getLocalDownloadPath,
  tryAndroidIntentPlayback,
  DOWNLOADS_LIST_EVENT,
  DOWNLOAD_PROGRESS_EVENT,
} from "@/scripts/lib/downloads.js"
import {
  clearAmbient,
  setAmbient as setAmbientOn,
  paintHero as paintHeroOn,
  chooseMime,
} from "@/scripts/lib/morph-detail.js"
import { attachPlayerFocusKeeper } from "@/scripts/lib/player-focus-keeper.js"
import { togglePip } from "@/scripts/lib/pip-toggle.js"
import { bindAutoPip } from "@/scripts/lib/auto-pip.js"
import {
  androidNativePlayerAvailable,
  launchAndroidNativeVodWithProgress,
} from "@/scripts/lib/android-video-launcher.js"
import {
  getAndroidNativePlayerEnabled,
  getPlayerBackend,
  getVideoScale,
  setVideoScale,
  isTmdbActive,
  VIDEO_SCALE_EVENT,
} from "@/scripts/lib/app-settings.js"
import {
  resolveTmdbId,
  fetchSeriesEnrichment,
  fetchSeasonEnrichment,
  peekEarlyDetailData,
  peekCachedSeasonEnrichment,
} from "@/scripts/lib/tmdb-enrich.ts"
import { matchRecommendationsToCatalog, extractLangPrefix } from "@/scripts/lib/tmdb-match.ts"
import { pickLocalSimilar, parseProviderPeople } from "@/scripts/lib/similar-local.ts"
import { tmdbImageUrl, TMDB_PROFILE_SIZE } from "@/scripts/lib/tmdb.ts"
import { isGenericEpisodeTitle } from "@/scripts/lib/episode-title.ts"
import { buildEntryCard } from "@/scripts/lib/entry-card.ts"
import { dragScroll } from "@/scripts/lib/drag-scroll.ts"
import { ICON_USER } from "@/scripts/lib/icons.ts"
import { fmtImdbRating, parseHmsToSeconds } from "@/scripts/lib/format.js"
import { setRichPresence, clearRichPresence } from "@/scripts/lib/discord-rpc.js"
import { t, initI18n } from "@/scripts/lib/i18n.js"
import {
  mountPlayer,
  playWhenReady,
  getExternalLauncher,
  subscribeExternalPlayerExit,
  desktopPlatform,
  isWindows,
} from "@/scripts/lib/player-runtime.ts"
import { prepareVodPlayback, prepareLocalVodPlayback } from "@/scripts/lib/vod-proxy.ts"
import { vodAudioRemuxAvailable } from "@/scripts/lib/vod-audio-proxy.ts"
import { createVodAudioSwitcher, discoverVodAudioTracks } from "@/scripts/lib/vod-audio-switch.ts"
import {
  planVodContainerPlayback,
  planLocalVodContainerPlayback,
  detectVodContainer,
  detectVodContainerFromLocalPath,
  isUpstreamHttpFailure,
} from "@/scripts/lib/vod-container-plan.ts"
import { probeVodContainerAlternative, swapUrlExtension } from "@/scripts/lib/vod-container-probe.ts"
import {
  buildRemuxContentKey,
  isRemuxPinnedContent,
  rememberRemuxPinnedContent,
} from "@/scripts/lib/vod-remux-memory.ts"
import { deviceSupportsHevc, hasHevcNameHint, classifyStartFailure, describeAudioCodec } from "@/scripts/lib/codec-hints.ts"
import { toast, toastError } from "@/scripts/lib/toast.js"
import {
  setupExternalPlayerButton,
  surfaceLaunchError,
  hasAvailableExternalPlayer,
} from "@/scripts/lib/external-player-button.ts"
import { createVideoScaleController } from "@/scripts/lib/video-scale.ts"
import { openVideoScaleDialog, videoScaleModeLabelKey } from "@/scripts/lib/video-scale-dialog.ts"
import { createSubtitleDelayController } from "@/scripts/lib/subtitle-delay-dialog.ts"
import { buildSeriesStreamUrl } from "@/scripts/lib/stream-urls.ts"
import { attachPosterContextMenu } from "@/scripts/lib/poster-menu.ts"
import { attachPlayerInsights } from "@/scripts/lib/player-stats.ts"

const SERIES_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ----------------------------
// Refs
// ----------------------------
const backLink = document.getElementById("series-detail-back")
const ambientEl = document.getElementById("series-detail-ambient")
const titleEl = document.getElementById("series-detail-title")
const nowPlayingEl = document.getElementById("series-now-playing")
const metaEl = document.getElementById("series-detail-meta")
const plotEl = document.getElementById("series-detail-plot")
const posterEl = document.getElementById("series-detail-poster")
const playerWrap = document.getElementById("series-detail-player-wrap")
const favBtn = document.getElementById("series-detail-fav")
const watchBtn = document.getElementById("series-detail-watch")
const watchLabelEl = document.getElementById("series-detail-watch-label")
const trailerBtn = document.getElementById("series-detail-trailer")
const taglineEl = document.getElementById("series-detail-tagline")
const directorEl = document.getElementById("series-detail-director")
const castSection = document.getElementById("series-detail-cast")
const castListEl = document.getElementById("series-detail-cast-list")
const similarSection = document.getElementById("series-detail-similar")
const similarListEl = document.getElementById("series-detail-similar-list")
if (castListEl) dragScroll(castListEl)
if (similarListEl) dragScroll(similarListEl)
let trailerUrl = ""
const seasonTabs = document.getElementById("series-season-tabs")
const episodeList = document.getElementById("series-episode-list")

// Real back() instead of a push navigation, so bfcache and the grid's own
// back-navigation restore both work. Falls through to the plain href for
// deep links or when the referrer isn't the series grid.
backLink?.addEventListener("click", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  if (history.length <= 1) return
  let referrerUrl
  try {
    referrerUrl = new URL(document.referrer)
  } catch {
    return
  }
  if (referrerUrl.origin !== location.origin || referrerUrl.pathname !== "/series") return
  event.preventDefault()
  history.back()
})

// ----------------------------
// State
// ----------------------------
const urlParams = new URLSearchParams(location.search)
const seriesId = Number(urlParams.get("id") || "0")
const autoplayEpisodeId = urlParams.get("autoplay") === "1"
  ? Number(urlParams.get("episode") || "0") || null
  : null
let autoplayPending = !!autoplayEpisodeId
let activePlaylistId = ""
let creds = { host: "", port: "", user: "", pass: "" }
let series = null
let seriesInfoRaw = null
let episodesByKey = null
let currentSeason = ""
let currentPlayingEpisodeId = null
let tabsStaggered = false
let episodesStaggered = false
let externalPresenceActive = false
let resolvedTmdbId = null
let enrichRequestId = 0
let seriesCatalogPromise = null
let seasonEnrichRequestId = 0
let metaYearText = ""
let metaGenreText = ""
let metaRatingText = ""
let metaSeasonsText = ""
let heroPosterUrl = null
let heroTmdbBackdropUrl = null
let heroProviderBackdropUrl = null
let heroSettled = false
let earlyEnrichmentHandled = false
let earlyEnrichmentPopulatedSimilar = false

const setAmbient = (url) => setAmbientOn(ambientEl, url)

// Paints the hero exactly once per boot, at whichever point the caller has decided
// enough is known: immediately when TMDb is inactive or already cache-warm, or after
// the TMDb enrichment attempt settles (resolved, resolved-null, or failed) otherwise.
function settleHero() {
  if (heroSettled) return
  heroSettled = true
  posterEl?.classList.remove("skel")
  paintHeroOn(posterEl, {
    name: series?.name || "",
    posterUrl: heroPosterUrl,
    backdropUrls: [heroTmdbBackdropUrl, heroProviderBackdropUrl],
  })
}

function buildEpisodeStreamUrl(ep, c = creds) {
  if (ep?._directUrl) return ep._directUrl
  if (!c.host || !c.user || !c.pass) return ""
  return buildSeriesStreamUrl(c, ep.id, ep.container_extension)
}

// ----------------------------
// Right-click / long-press menu: "Test stream" / "Copy stream URL" per episode. Reuses
// attachPosterContextMenu's wiring, but built locally since episodes don't fit openPosterMenu's shape.
// ----------------------------
let episodeMenuEl = null

function closeEpisodeMenu() {
  if (!episodeMenuEl) return
  episodeMenuEl.remove()
  episodeMenuEl = null
  document.removeEventListener("pointerdown", onEpisodeMenuOutside, true)
  document.removeEventListener("keydown", onEpisodeMenuKey, true)
  window.removeEventListener("blur", closeEpisodeMenu)
  window.removeEventListener("resize", closeEpisodeMenu)
}

function onEpisodeMenuOutside(event) {
  if (!episodeMenuEl) return
  if (episodeMenuEl.contains(event.target)) return
  closeEpisodeMenu()
}

function onEpisodeMenuKey(event) {
  if (event.key === "Escape") {
    event.preventDefault()
    closeEpisodeMenu()
  }
}

function makeEpisodeMenuItem(label, handler) {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.setAttribute("role", "menuitem")
  btn.className =
    "w-full text-left px-3 py-2.5 min-h-11 rounded-lg text-sm " +
    "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-accent " +
    "outline-none transition-colors"
  btn.textContent = label
  btn.addEventListener("click", () => {
    closeEpisodeMenu()
    try {
      handler()
    } catch (error) {
      log.warn("[xt:series-detail] episode menu handler threw:", error)
    }
  })
  return btn
}

function episodeMenuTitle(ep) {
  return ep.title || t("series.episode.fallback", { n: ep.episode_num || "" })
}

function openEpisodeMenu(ep, anchor, point) {
  closeEpisodeMenu()
  const url = buildEpisodeStreamUrl(ep)
  if (!url) return

  const menu = document.createElement("div")
  menu.id = "xt-episode-menu"
  menu.className =
    "fixed z-50 min-w-[12rem] rounded-xl border border-line bg-surface text-fg shadow-2xl " +
    "p-1 flex flex-col gap-0.5 poster-menu-enter"
  menu.setAttribute("role", "menu")
  menu.setAttribute(
    "aria-label",
    t("list.menu.ariaFor", { name: episodeMenuTitle(ep) || t("list.fallbackTitle") })
  )

  menu.appendChild(
    makeEpisodeMenuItem(t("stream.menu.test"), () => {
      import("@/scripts/lib/stream-diagnostic-dialog.js").then(({ openStreamDiagnostic }) => {
        openStreamDiagnostic({ url, title: episodeMenuTitle(ep) })
      })
    })
  )
  menu.appendChild(
    makeEpisodeMenuItem(t("stream.menu.copy"), async () => {
      try {
        const { writeClipboardText } = await import("@/scripts/lib/clipboard")
        await writeClipboardText(url)
        toast({ title: t("stream.toast.copied"), duration: 2200 })
      } catch (error) {
        log.warn("[xt:series-detail] copy stream URL failed:", error)
        toast({ title: t("toast.copyError"), variant: "warn", duration: 2800 })
      }
    })
  )

  document.body.appendChild(menu)

  const margin = 8
  const rect = menu.getBoundingClientRect()
  let left
  let top
  if (point) {
    left = Math.min(point.x, window.innerWidth - rect.width - margin)
    top = Math.min(point.y, window.innerHeight - rect.height - margin)
  } else {
    const anchorRect = anchor.getBoundingClientRect()
    left = Math.min(anchorRect.right + 6, window.innerWidth - rect.width - margin)
    top = Math.min(anchorRect.top, window.innerHeight - rect.height - margin)
  }
  menu.style.left = `${Math.max(margin, left)}px`
  menu.style.top = `${Math.max(margin, top)}px`

  episodeMenuEl = menu
  document.addEventListener("pointerdown", onEpisodeMenuOutside, true)
  document.addEventListener("keydown", onEpisodeMenuKey, true)
  window.addEventListener("blur", closeEpisodeMenu)
  window.addEventListener("resize", closeEpisodeMenu)

  const first = menu.querySelector("button[role='menuitem']")
  first?.focus({ preventScroll: true })
}

function syncFavButton() {
  if (!favBtn || !series || !activePlaylistId) return
  const fav = isFavorite(activePlaylistId, "series", series.id)
  favBtn.textContent = fav ? t("detail.action.removeFavorite") : t("detail.action.addFavorite")
  favBtn.classList.toggle("text-accent", fav)
  favBtn.setAttribute("aria-pressed", String(fav))
}

function syncWatchButton() {
  if (!watchBtn || !series || !activePlaylistId) return
  const onWatchlist = isOnWatchlist(activePlaylistId, "series", series.id)
  if (watchLabelEl) {
    watchLabelEl.textContent = onWatchlist ? t("detail.watchlist.on") : t("detail.action.watchLater")
  }
  watchBtn.classList.toggle("text-accent", onWatchlist)
  watchBtn.setAttribute("aria-pressed", String(onWatchlist))
}

// Xtream `youtube_trailer` can be either a bare 11-char video ID or a full
// URL. Normalize to a watchable youtube.com URL or "" if unrecognised.
function youtubeUrlFromTrailer(trailer) {
  if (!trailer) return ""
  const value = String(trailer).trim()
  if (!value) return ""
  if (/^https?:\/\//i.test(value)) return value
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return `https://www.youtube.com/watch?v=${value}`
  }
  return ""
}

// Providers sometimes send a full release date instead of a bare year; show year-only.
function extractDisplayYear(value) {
  const raw = String(value).trim()
  const match = raw.match(/(19|20)\d{2}/)
  return match ? match[0] : raw
}

// ----------------------------
// Episode list rendering
// ----------------------------
function findDownloadByUrl(url) {
  return listDownloads().find((d) => d.url === url) || null
}

function downloadButtonState(d) {
  if (!d) return { label: t("detail.action.download"), disabled: false, title: t("series.download.tooltip") }
  switch (d.status) {
    case "downloading": {
      const pct = d.bytesTotal > 0 ? Math.floor((d.bytesDone / d.bytesTotal) * 100) : null
      return { label: pct !== null ? `${pct}%` : "…", disabled: false, title: t("detail.download.tapPause") }
    }
    case "queued":    return { label: t("detail.download.queued"), disabled: false, title: t("detail.download.waitingSlot") }
    case "done":      return { label: t("detail.download.saved"), disabled: true, title: d.path ? t("detail.download.savedTo", { path: d.path }) : t("detail.download.saved") }
    case "paused":    return { label: t("detail.download.resume"), disabled: false, title: t("detail.download.tapResume") }
    case "stalled":   return { label: t("detail.download.retry"), disabled: false, title: t("detail.download.tapRetry") }
    case "error":     return { label: t("detail.download.retry"), disabled: false, title: d.error || t("detail.download.failedRetry") }
    case "cancelled": return { label: t("detail.action.download"), disabled: false, title: t("series.download.reDownload") }
    default:          return { label: t("detail.action.download"), disabled: false }
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

function renderSeasonTabs(seasonKeys) {
  if (!seasonTabs) return
  seasonTabs.replaceChildren()
  if (!seasonKeys.length) {
    seasonTabs.style.display = "none"
    return
  }
  seasonTabs.style.display = ""
  for (const [tabIndex, key] of seasonKeys.entries()) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.dataset.season = key
    btn.className =
      "rounded-lg px-3 py-1.5 text-sm border outline-none transition-colors " +
      (key === currentSeason
        ? "border-accent bg-accent-soft text-fg"
        : "border-line text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg")
    if (!tabsStaggered) {
      btn.classList.add("dt-child-enter")
      btn.style.animationDelay = `${340 + tabIndex * 50}ms`
    }
    btn.textContent = t("series.season", { n: key })
    btn.addEventListener("click", () => {
      if (currentSeason === key) return
      const oldKey = currentSeason
      const direction = (Number(key) || 0) > (Number(oldKey) || 0) ? 1 : -1
      currentSeason = key
      renderSeasonTabs(seasonKeys)
      slotMachineEpisodes(direction)
    })
    seasonTabs.appendChild(btn)
  }
  if (seasonKeys.length) tabsStaggered = true
}

function slotMachineEpisodes(direction) {
  if (!episodeList) return
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  if (reduceMotion) {
    renderEpisodes()
    return
  }
  const dy = direction >= 0 ? -16 : 16
  const dyIn = direction >= 0 ? 16 : -16
  const easing = "cubic-bezier(0.16, 1, 0.3, 1)"
  episodeList.animate(
    [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: `translateY(${dy}px)` },
    ],
    { duration: 180, easing, fill: "forwards" }
  ).onfinish = () => {
    renderEpisodes()
    episodeList.animate(
      [
        { opacity: 0, transform: `translateY(${dyIn}px)` },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 280, easing, fill: "forwards" }
    )
  }
}

// Number("") is 0, which Kodi reads as the Specials season
function toIndex(value) {
  if (value == null || value === "") return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function renderEpisodes() {
  if (!episodeList) return
  closeEpisodeMenu()
  episodeList.replaceChildren()
  const eps = episodesByKey?.[currentSeason] || []
  if (!eps.length) {
    const empty = document.createElement("div")
    empty.className = "text-fg-3 text-sm py-3"
    empty.textContent = t("series.episodes.empty")
    episodeList.appendChild(empty)
    return
  }
  for (const [rowIndex, ep] of eps.entries()) {
    const row = document.createElement("div")
    row.className =
      "episode-row flex items-center gap-3 p-3 rounded-xl bg-surface-2/40 " +
      "transition-colors hover:bg-surface-2 focus-within:bg-surface-2"
    row.dataset.epId = String(ep.id)
    row.dataset.epNum = String(ep.episode_num ?? "")
    if (!episodesStaggered) {
      row.classList.add("dt-child-enter")
      row.style.animationDelay = `${400 + Math.min(rowIndex, 9) * 40}ms`
    }
    if (currentPlayingEpisodeId != null && Number(ep.id) === currentPlayingEpisodeId) {
      row.dataset.nowPlaying = "true"
    }
    if (
      activePlaylistId &&
      isCompleted(activePlaylistId, "episode", ep.id)
    ) {
      row.dataset.watched = "true"
    }

    const playBtn = document.createElement("button")
    playBtn.type = "button"
    playBtn.className =
      "flex flex-1 min-w-0 items-center gap-3 text-left outline-none rounded-lg " +
      "focus-visible:ring-1 focus-visible:ring-accent"
    playBtn.addEventListener("click", () => playEpisode(ep))

    const num = document.createElement("div")
    num.dataset.role = "ep-num"
    num.className =
      "episode-num shrink-0 size-10 rounded-md bg-surface-3 flex items-center justify-center text-sm font-semibold tabular-nums text-fg-2"
    num.textContent = `E${ep.episode_num || "?"}`
    playBtn.appendChild(num)

    const wrap = document.createElement("div")
    wrap.className = "min-w-0 flex-1"
    const title = document.createElement("div")
    title.dataset.role = "ep-title"
    title.className = "truncate text-sm font-medium text-fg"
    title.textContent = ep.title || t("series.episode.fallback", { n: ep.episode_num || "" })
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

    const overview = document.createElement("div")
    overview.dataset.role = "ep-overview"
    overview.className = "text-xs text-fg-3 line-clamp-2 empty:hidden mt-0.5"
    wrap.appendChild(overview)

    playBtn.appendChild(wrap)

    const epProgress = activePlaylistId
      ? getProgress(activePlaylistId, "episode", ep.id)
      : null
    const canResume =
      epProgress && !epProgress.completed && epProgress.position > RESUME_MIN_SECONDS

    const arrow = document.createElement("span")
    arrow.className = "shrink-0 text-fg-3 text-base"
    arrow.textContent = "▶"
    playBtn.appendChild(arrow)

    row.appendChild(playBtn)

    if (canResume) {
      const restartBtn = document.createElement("button")
      restartBtn.type = "button"
      restartBtn.className =
        "shrink-0 rounded-lg border border-line min-h-11 min-w-11 inline-flex items-center justify-center text-fg-3 " +
        "hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg focus-visible:border-accent " +
        "outline-none transition-colors"
      restartBtn.title = t("detail.action.startBeginning")
      restartBtn.setAttribute(
        "aria-label",
        t("series.episode.startBeginningAria", { title: ep.title || t("series.episode.fallback", { n: ep.episode_num || "" }) })
      )
      restartBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>'
      restartBtn.addEventListener("click", (e) => {
        e.stopPropagation()
        if (!activePlaylistId) return
        clearProgress(activePlaylistId, "episode", ep.id)
        playEpisode(ep)
      })
      row.appendChild(restartBtn)

      const fraction =
        epProgress.duration > 0
          ? Math.max(0, Math.min(1, epProgress.position / epProgress.duration))
          : 0
      const progressEl = document.createElement("div")
      progressEl.className =
        "absolute left-3 right-3 bottom-1 h-0.5 rounded-full bg-line/40 overflow-hidden pointer-events-none"
      const progressFill = document.createElement("div")
      progressFill.className = "h-full bg-accent"
      progressFill.style.width = `${fraction * 100}%`
      progressEl.appendChild(progressFill)
      row.appendChild(progressEl)
      row.classList.add("relative")
    }

    if (isDownloadable()) {
      const epUrl = buildEpisodeStreamUrl(ep)
      if (epUrl) {
        const dlBtn = document.createElement("button")
        dlBtn.type = "button"
        dlBtn.className =
          "shrink-0 rounded-lg border border-line min-h-11 min-w-24 px-3 text-xs text-fg-2 tabular-nums " +
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
          if (existing?.status === "downloading" || existing?.status === "queued") {
            pauseDownload(existing.id)
            return
          }
          if (
            existing &&
            (existing.status === "paused" ||
              existing.status === "stalled" ||
              existing.status === "error")
          ) {
            dlBtn.setAttribute("disabled", "")
            if (dlLabel) dlLabel.textContent = t("series.download.resuming")
            resumeDownload(existing.id)
            return
          }
          try {
            dlBtn.setAttribute("disabled", "")
            if (dlLabel) dlLabel.textContent = t("detail.download.starting")
            const epTitle =
              (series?.name ? `${series.name} - ` : "") +
              `S${currentSeason || "?"}E${ep.episode_num || "?"}` +
              (ep.title ? ` - ${ep.title}` : "")
            const seriesInfo = seriesInfoRaw?.info || {}
            const epInfo = ep.info || {}
            const epDurationSecs = Number(epInfo.duration_secs || 0)
            await startDownload({
              url: epUrl,
              title: epTitle,
              ext: ep.container_extension || inferExt(epUrl, "mp4"),
              source: {
                kind: "episode",
                playlistId: activePlaylistId,
                id: ep.id,
                seriesId: series?.id ?? null,
                seriesName: series?.name || "",
                season: ep.season ?? currentSeason ?? null,
                episode: ep.episode_num ?? null,
                logo: series?.logo || null,
              },
              nfo: {
                type: "episode",
                showTitle: series?.name || seriesInfo.name || seriesInfo.title || "",
                title: ep.title || "",
                season: toIndex(ep.season) ?? toIndex(currentSeason),
                episode: toIndex(ep.episode_num),
                aired: epInfo.release_date || epInfo.releaseDate || "",
                plot: epInfo.plot || seriesInfo.plot || seriesInfo.description || series?.plot || "",
                genre: seriesInfo.genre || seriesInfo.category || "",
                rating: epInfo.rating || seriesInfo.rating || seriesInfo.rating_5based || series?.rating || "",
                runtimeMinutes: epDurationSecs > 0 ? Math.round(epDurationSecs / 60) : 0,
                poster: epInfo.movie_image || seriesInfo.cover || seriesInfo.cover_big || series?.logo || "",
              },
            })
          } catch (err) {
            log.error("Episode download failed:", err)
            dlBtn.removeAttribute("disabled")
            if (dlLabel) dlLabel.textContent = t("detail.download.failed")
            dlBtn.title = String(err?.message || err)
          }
        })
        row.appendChild(dlBtn)
      }
    }

    attachPosterContextMenu(row, (anchor, point) => openEpisodeMenu(ep, anchor, point))

    episodeList.appendChild(row)
  }
  if (eps.length) episodesStaggered = true
  try { window.SpatialNavigation?.makeFocusable?.() } catch {}
  refreshSeasonEnrichment().catch((err) => {
    log.warn("[xt:series-detail] season tmdb enrichment failed:", err)
  })
}

function syncEpisodeDownloadButtons() {
  if (!episodeList) return
  const buttons = episodeList.querySelectorAll("button[data-dl-url]")
  if (!buttons.length) return
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

function renderDownloadedEpisodes(downloads) {
  const byKey = {}
  for (const dl of downloads) {
    const src = dl.source || {}
    const seasonKey = String(src.season ?? "1")
    const seriesName = src.seriesName || ""
    const cleanedTitle = seriesName
      ? String(dl.title || "")
          .replace(`${seriesName} - `, "")
          .replace(/^S\d+E\d+\s*-\s*/, "")
      : (dl.title || "")
    const extMatch = String(dl.url || "").match(/\.([a-z0-9]{2,5})(?:\?|$)/i)
    const ep = {
      id: src.id ?? null,
      season: src.season ?? "1",
      episode_num: src.episode ?? null,
      title: cleanedTitle,
      container_extension: extMatch?.[1] || "mp4",
      _directUrl: dl.url,
    }
    ;(byKey[seasonKey] = byKey[seasonKey] || []).push(ep)
  }
  for (const k of Object.keys(byKey)) {
    byKey[k].sort(
      (a, b) => (Number(a.episode_num) || 0) - (Number(b.episode_num) || 0)
    )
  }
  episodesByKey = byKey
  const seasonKeys = Object.keys(byKey).sort((a, b) => Number(a) - Number(b))
  if (!seasonKeys.includes(currentSeason)) {
    currentSeason = seasonKeys[0] || ""
  }
  renderSeasonTabs(seasonKeys)
  renderEpisodes()
}

function applySeriesInfo(data) {
  seriesInfoRaw = data
  const info = data?.info || {}
  const seasons = Array.isArray(data?.seasons) ? data.seasons : []

  // Poster: prefer the per-item API fields when the list-cache logo is
  // missing. info.cover is the standard Xtream key for series art.
  const apiName = info.name || info.title || ""
  const fallbackName = t("list.seriesFallback", { id: seriesId })
  if (apiName && series && (!series.name || series.name === fallbackName)) {
    series.name = apiName
    if (titleEl) titleEl.textContent = apiName
  }

  const apiPoster = info.cover || info.cover_big || info.movie_image || null
  const apiBackdropPath = Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : null
  const apiLogo = apiPoster || apiBackdropPath || null
  if (apiLogo && (!series || !series.logo)) {
    if (series) series.logo = apiLogo
    heroPosterUrl = apiLogo
    setAmbient(apiLogo)
  }
  if (apiBackdropPath) heroProviderBackdropUrl = apiBackdropPath
  // Hero stays in its skeleton state - settleHero() at the call site decides when to paint it once.
  let byKey = {}
  if (data?.episodes && typeof data.episodes === "object") {
    if (Array.isArray(data.episodes)) {
      for (const ep of data.episodes) {
        const k = String(ep?.season ?? "1")
        ;(byKey[k] = byKey[k] || []).push(ep)
      }
    } else {
      byKey = data.episodes
    }
  }

  const year = info.releaseDate || info.releasedate || info.year || series?.year || ""
  const rating = info.rating || info.rating_5based || series?.rating || ""
  const genre = info.genre || info.category || ""
  const cast = info.cast || ""
  const plot = info.plot || info.description || series?.plot || ""

  metaYearText = year ? extractDisplayYear(year) : ""
  metaGenreText = genre || ""
  metaRatingText = fmtImdbRating(rating)
  metaSeasonsText = seasons.length ? `${seasons.length} season${seasons.length > 1 ? "s" : ""}` : ""
  renderMetaLine()
  if (plotEl) {
    plotEl.textContent = plot || (cast ? t("series.castPrefix", { cast }) : t("detail.noDescription"))
  }

  trailerUrl = youtubeUrlFromTrailer(info.youtube_trailer || "")
  if (trailerBtn) {
    if (trailerUrl) trailerBtn.removeAttribute("hidden")
    else trailerBtn.setAttribute("hidden", "")
  }

  if (!isTmdbActive()) {
    renderProviderPeopleChips(providerPeopleNames(parseProviderPeople(info)))
  }

  episodesByKey = byKey
  const seasonKeys = Object.keys(byKey).sort((a, b) => Number(a) - Number(b))
  if (!seasonKeys.includes(currentSeason)) {
    currentSeason = seasonKeys[0] || ""
  }

  // Autoplay handoff from /downloads: find the requested episode, switch
  // to its season, then trigger playback.
  if (autoplayPending && autoplayEpisodeId) {
    let targetEp = null
    let targetSeason = ""
    for (const key of seasonKeys) {
      const ep = (byKey[key] || []).find((e) => Number(e.id) === autoplayEpisodeId)
      if (ep) {
        targetEp = ep
        targetSeason = key
        break
      }
    }
    if (targetEp) {
      currentSeason = targetSeason
      currentPlayingEpisodeId = autoplayEpisodeId
    }

    renderSeasonTabs(seasonKeys)
    renderEpisodes()

    if (targetEp) {
      autoplayPending = false
      try {
        urlParams.delete("autoplay")
        urlParams.delete("episode")
        const next = urlParams.toString()
        history.replaceState(
          null,
          "",
          location.pathname + (next ? `?${next}` : "")
        )
      } catch {}
      playEpisode(targetEp)
    }
    return
  }

  renderSeasonTabs(seasonKeys)
  renderEpisodes()
}

function escapeRatingText(text) {
  const div = document.createElement("div")
  div.textContent = String(text)
  return div.innerHTML
}

// Genre/rating repeat in the facts column at lg+, so the compact strip hides its own copies there.
function renderMetaLine() {
  if (!metaEl) return
  const bits = []
  if (metaYearText) bits.push(`<span class="meta-item">${escapeRatingText(metaYearText)}</span>`)
  if (metaSeasonsText) bits.push(`<span class="meta-item">${metaSeasonsText}</span>`)
  if (metaGenreText) bits.push(`<span class="meta-item lg:hidden">${escapeRatingText(metaGenreText)}</span>`)
  if (metaRatingText) {
    bits.push(
      '<span class="meta-item inline-flex items-center gap-1 text-fg-2 lg:hidden" aria-label="IMDB rating ' +
        metaRatingText +
        ' out of 10">' +
        '<svg viewBox="0 0 24 24" width="0.95em" height="0.95em" fill="currentColor" aria-hidden="true" class="text-accent">' +
        '<path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/>' +
        "</svg>" +
        `<span class="font-medium tabular-nums">${metaRatingText}</span>` +
        '<span class="text-fg-3">/10</span>' +
        "</span>"
    )
  }
  metaEl.innerHTML = bits.join("")
  renderFactsColumn()
}

function setFactRow(id, value) {
  const row = document.getElementById(id)
  if (!row) return
  if (!value) {
    row.setAttribute("hidden", "")
    return
  }
  const valueEl = row.querySelector('[data-role="fact-value"]')
  if (valueEl) valueEl.textContent = value
  row.removeAttribute("hidden")
}

// Facts column at lg+: same module state as the compact meta strip, no extra data reads.
// Year/seasons stay in the strip only - the strip keeps them visible at lg+ too.
function renderFactsColumn() {
  setFactRow("series-detail-fact-genre", metaGenreText)
  setFactRow("series-detail-fact-rating", metaRatingText)
}

// ----------------------------
// TMDb enrichment
// ----------------------------
function resetTmdbEnrichmentUI() {
  resolvedTmdbId = null
  if (directorEl) {
    directorEl.textContent = ""
    directorEl.setAttribute("hidden", "")
  }
  if (taglineEl) {
    taglineEl.textContent = ""
    taglineEl.setAttribute("hidden", "")
  }
  metaGenreText = ""
  metaRatingText = ""
  metaYearText = ""
  document.getElementById("series-detail-fact-genre")?.setAttribute("hidden", "")
  document.getElementById("series-detail-fact-rating")?.setAttribute("hidden", "")
  if (castSection) castSection.setAttribute("hidden", "")
  castListEl?.replaceChildren()
  if (similarSection) similarSection.setAttribute("hidden", "")
  similarListEl?.replaceChildren()
  document.getElementById("series-detail-provider-people")?.setAttribute("hidden", "")
}

function patchDirector(director, tmdbPersonId) {
  if (!directorEl || !director) return
  directorEl.textContent = ""
  directorEl.append(`${t("detail.director")}: `)
  if (tmdbPersonId) {
    const link = document.createElement("a")
    link.href = personFilterHref(director, tmdbPersonId)
    link.textContent = director
    link.className =
      "text-fg-2 hover:text-accent focus-visible:text-accent outline-none " +
      "rounded focus-visible:ring-1 focus-visible:ring-accent"
    directorEl.appendChild(link)
  } else {
    directorEl.append(director)
  }
  directorEl.removeAttribute("hidden")
}

function patchTagline(tagline) {
  if (!taglineEl || !tagline) return
  taglineEl.textContent = tagline
  taglineEl.removeAttribute("hidden")
}

function patchGenreFromEnrichment(genres) {
  if (!genres?.length || metaGenreText) return
  metaGenreText = genres.join(", ")
  renderMetaLine()
}

function patchYearFromEnrichment(year) {
  if (metaYearText || !year) return
  metaYearText = String(year)
  renderMetaLine()
}

function patchRatingFromEnrichment(voteAverage) {
  if (metaRatingText || !voteAverage) return
  const ratingText = fmtImdbRating(voteAverage)
  if (!ratingText) return
  metaRatingText = ratingText
  renderMetaLine()
}

// Defensive: profilePath may be a raw TMDb path rather than an already-mapped full URL.
function castProfileUrl(profilePath) {
  if (!profilePath) return null
  return profilePath.startsWith("http") ? profilePath : tmdbImageUrl(profilePath, TMDB_PROFILE_SIZE)
}

// tmdbPersonId is omitted for the provider-only chip row (no TMDb id to carry).
function personFilterHref(name, tmdbPersonId) {
  const params = new URLSearchParams({ person: name })
  if (tmdbPersonId) params.set("personId", String(tmdbPersonId))
  return `/series?${params.toString()}`
}

function renderCast(cast) {
  if (!castSection || !castListEl || !cast.length) return
  castListEl.replaceChildren()
  for (const member of cast) {
    const interactive = !!member.tmdbPersonId
    const card = document.createElement(interactive ? "a" : "div")
    card.className = "flex flex-col items-center gap-1.5 w-20 sm:w-24 shrink-0 snap-start text-center rounded-lg outline-none"
    if (interactive) {
      card.href = personFilterHref(member.name, member.tmdbPersonId)
      card.classList.add("group", "cursor-pointer", "focus-visible:ring-1", "focus-visible:ring-accent")
    }

    const photoWrap = document.createElement("div")
    photoWrap.className =
      "size-16 sm:size-20 rounded-full overflow-hidden bg-surface-2 ring-1 ring-line flex items-center justify-center text-fg-3"
    const profileUrl = castProfileUrl(member.profilePath)
    if (profileUrl) {
      const img = document.createElement("img")
      img.src = profileUrl
      img.alt = ""
      img.loading = "lazy"
      img.decoding = "async"
      img.referrerPolicy = "no-referrer"
      img.className = "h-full w-full object-cover"
      img.onerror = () => {
        img.remove()
        photoWrap.innerHTML = ICON_USER
      }
      photoWrap.appendChild(img)
    } else {
      photoWrap.innerHTML = ICON_USER
    }

    const info = document.createElement("div")
    info.className = "w-full"
    const nameEl = document.createElement("div")
    nameEl.className =
      "truncate text-sm font-medium text-fg" +
      (interactive ? " group-hover:text-accent group-focus-visible:text-accent transition-colors" : "")
    nameEl.textContent = member.name
    const characterEl = document.createElement("div")
    characterEl.className = "truncate text-xs text-fg-3"
    characterEl.textContent = member.character
    info.append(nameEl, characterEl)

    card.append(photoWrap, info)
    castListEl.appendChild(card)
  }
  castSection.removeAttribute("hidden")
}

// Dedup preserving order, director first, since IPTV provider casts often repeat a name.
function providerPeopleNames(peopleInfo) {
  const names = []
  const seen = new Set()
  const add = (name) => {
    const trimmed = (name || "").trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    names.push(trimmed)
  }
  add(peopleInfo.directorName)
  for (const name of peopleInfo.castNames) add(name)
  return names
}

function renderProviderPeopleChips(names) {
  const row = document.getElementById("series-detail-provider-people")
  const listEl = document.getElementById("series-detail-provider-people-list")
  if (!row || !listEl) return
  if (!names.length) {
    row.setAttribute("hidden", "")
    listEl.replaceChildren()
    return
  }
  listEl.replaceChildren()
  for (const name of names.slice(0, 8)) {
    const chip = document.createElement("a")
    chip.href = personFilterHref(name, null)
    chip.className =
      "rounded-full border border-line px-2 py-0.5 text-xs text-fg-2 " +
      "hover:text-accent hover:border-accent focus-visible:text-accent focus-visible:border-accent outline-none transition-colors"
    chip.textContent = name
    listEl.appendChild(chip)
  }
  row.removeAttribute("hidden")
}

function renderSimilar(matches) {
  if (!similarSection || !similarListEl || !matches.length) return
  similarListEl.replaceChildren()
  matches.forEach((entry, idx) => {
    const card = buildEntryCard({
      entry,
      idx,
      kind: "series",
      activePlaylistId,
      detailHref: (e) => `/series/detail?id=${encodeURIComponent(e.id)}`,
      fallbackTitle: (e) => t("list.seriesFallback", { id: e.id }),
      metaText: (e) => {
        const parts = []
        if (e.year) parts.push(e.year)
        if (e.category) parts.push(e.category)
        return parts.join(" • ")
      },
    })
    const cardWrap = document.createElement("div")
    cardWrap.className = "w-32 sm:w-36 lg:w-40 shrink-0 snap-start"
    cardWrap.appendChild(card)
    similarListEl.appendChild(cardWrap)
  })
  similarSection.removeAttribute("hidden")
}

function patchEpisodeRow(row, tmdbEpisode) {
  const titleEl = row.querySelector('[data-role="ep-title"]')
  const fallbackTitle = t("series.episode.fallback", { n: row.dataset.epNum || "" })
  if (
    titleEl &&
    tmdbEpisode.name &&
    isGenericEpisodeTitle(titleEl.textContent, { seriesName: series?.name, fallbackTitle })
  ) {
    titleEl.textContent = tmdbEpisode.name
  }
  const overviewEl = row.querySelector('[data-role="ep-overview"]')
  if (overviewEl && !overviewEl.textContent && tmdbEpisode.overview) {
    overviewEl.textContent = tmdbEpisode.overview
  }
  const numEl = row.querySelector('[data-role="ep-num"]')
  if (numEl && tmdbEpisode.stillUrl) {
    const safeUrl = String(tmdbEpisode.stillUrl).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    numEl.style.backgroundImage = `url("${safeUrl}")`
    numEl.classList.add("bg-cover", "bg-center", "text-white")
  }
}

function patchSeasonEpisodes(episodes) {
  if (!episodeList || !episodes.length) return
  const byNumber = new Map(episodes.map((episode) => [episode.episodeNumber, episode]))
  for (const row of episodeList.querySelectorAll(".episode-row")) {
    const tmdbEpisode = byNumber.get(Number(row.dataset.epNum))
    if (tmdbEpisode) patchEpisodeRow(row, tmdbEpisode)
  }
}

// Re-run on every episode render (initial paint, season switch, up-next), since rows are rebuilt each time.
async function refreshSeasonEnrichment() {
  const requestId = ++seasonEnrichRequestId
  if (!isTmdbActive() || !resolvedTmdbId || !activePlaylistId) return
  const seasonNumber = toIndex(currentSeason)
  if (seasonNumber == null) return
  const season = await fetchSeasonEnrichment(activePlaylistId, resolvedTmdbId, seasonNumber)
  if (requestId !== seasonEnrichRequestId || !season?.episodes?.length) return
  patchSeasonEpisodes(season.episodes)
}

// A deep link boots from a stub series, so take the fields only the catalog row carries.
function adoptCatalogRow(catalog) {
  if (!series) return
  const row = catalog.find((entry) => Number(entry.id) === seriesId)
  if (!row) return
  if (!series.category) series.category = row.category || null
  if (!series.year) series.year = row.year || ""
}

// The in-memory catalog is empty on a deep link, so load it instead of giving up on the rail.
function loadSeriesCatalog() {
  if (!activePlaylistId) return Promise.resolve([])
  const cached = getCached(activePlaylistId, "series")?.data
  if (cached?.length) return Promise.resolve(cached)
  if (!seriesCatalogPromise) {
    seriesCatalogPromise = ensureSeries(creds, activePlaylistId)
      .then((catalog) => {
        adoptCatalogRow(catalog)
        return catalog
      })
      .catch((err) => {
        log.warn("[xt:series-detail] series catalog load failed:", err)
        return []
      })
  }
  return seriesCatalogPromise
}

// Shared by the async patch-in and the cache-warm early merge in boot().
function applyEnrichmentPatch(enrichment) {
  if (enrichment.posterUrl) heroPosterUrl = enrichment.posterUrl
  if (enrichment.backdropUrl) {
    heroTmdbBackdropUrl = enrichment.backdropUrl
    setAmbient(enrichment.backdropUrl)
  }
  if (enrichment.overview && plotEl) plotEl.textContent = enrichment.overview
  if (enrichment.director) patchDirector(enrichment.director, enrichment.directorPersonId)
  if (enrichment.tagline) patchTagline(enrichment.tagline)
  patchGenreFromEnrichment(enrichment.genres)
  patchRatingFromEnrichment(enrichment.voteAverage)
  patchYearFromEnrichment(enrichment.year)
  if (!trailerUrl && enrichment.trailerYoutubeKey) {
    trailerUrl = `https://www.youtube.com/watch?v=${enrichment.trailerYoutubeKey}`
    trailerBtn?.removeAttribute("hidden")
  }
  if (enrichment.cast?.length) renderCast(enrichment.cast)
}

// Returns whether the similar rail was populated from TMDb recommendations.
async function enrichSeriesDetailFromTmdb(requestId) {
  if (!isTmdbActive() || !series || !activePlaylistId) {
    settleHero()
    return false
  }

  if (series.name === t("list.seriesFallback", { id: seriesId })) {
    settleHero()
    return false
  }

  const info = seriesInfoRaw?.info || {}
  const providerTmdbId = Number(info.tmdb || info.tmdb_id) || null

  const tmdbId = await resolveTmdbId(activePlaylistId, "series", {
    id: series.id,
    name: series.name,
    year: series.year || info.releaseDate || info.releasedate || info.year || null,
    providerTmdbId,
  })
  if (requestId !== enrichRequestId) return false
  if (tmdbId == null) {
    settleHero()
    return false
  }

  resolvedTmdbId = tmdbId
  // The current season already rendered without a tmdbId, so back-fill it now.
  refreshSeasonEnrichment()

  const enrichment = await fetchSeriesEnrichment(activePlaylistId, tmdbId)
  if (requestId !== enrichRequestId) return false
  if (!enrichment) {
    settleHero()
    return false
  }

  applyEnrichmentPatch(enrichment)
  settleHero()

  if (enrichment.recommendations?.length) {
    const catalog = await loadSeriesCatalog()
    if (requestId !== enrichRequestId) return false
    const matches = matchRecommendationsToCatalog(enrichment.recommendations, catalog, {
      mediaType: "tv",
      limit: 12,
      sourcePrefix: extractLangPrefix(series.name),
    })
    if (matches.length) {
      renderSimilar(matches)
      return true
    }
  }
  return false
}

async function populateLocalSimilarRail(requestId) {
  if (!series || !activePlaylistId) return
  const catalog = await loadSeriesCatalog()
  if (requestId !== enrichRequestId) return
  const people = parseProviderPeople(seriesInfoRaw?.info)
  const matches = pickLocalSimilar(
    {
      id: series.id,
      category: series.category || null,
      castNames: people.castNames,
      directorName: people.directorName,
    },
    catalog,
    {
      limit: 12,
      infoLookup: (id) => {
        const cached = getCached(activePlaylistId, `series_info_${id}`)?.data
        return cached ? parseProviderPeople(cached.info) : null
      },
      sourcePrefix: extractLangPrefix(series.name),
    }
  )
  if (matches.length) renderSimilar(matches)
}

async function populateSimilarRail(requestId) {
  // boot() already merged a cache-warm enrichment into the first paint; only the
  // local-similar fallback (when TMDb had no catalog-matching recommendations) is left.
  if (earlyEnrichmentHandled) {
    if (!earlyEnrichmentPopulatedSimilar) await populateLocalSimilarRail(requestId)
    return
  }
  const populatedFromTmdb = await enrichSeriesDetailFromTmdb(requestId)
  if (requestId !== enrichRequestId) return
  if (!populatedFromTmdb) await populateLocalSimilarRail(requestId)
}

// ----------------------------
// Playback
// ----------------------------
let vjs = null
let seriesInsights = null

function getSeriesInsights() {
  if (!seriesInsights) {
    seriesInsights = attachPlayerInsights({
      getHandle: () => vjs,
      getContainer: () => playerWrap,
      backendLabel: () => getPlayerBackend(),
      sessionKind: "series",
    })
  }
  return seriesInsights
}
let progressListenersBound = false
let currentEpisode = null
let pipBtnBound = false
let scaleBtnBound = false
let statsBtnBound = false
let healthBtnBound = false
let playRequestId = 0
let audioSwitcher = null
let audioDiscoveryController = null
/** Tee-proxy session behind the mount that is currently playing, so a later episode can stop it. */
let activeMkvSession = null
const RESUME_MIN_SECONDS = 30
const RESUME_MAX_FRACTION = 0.95
const PROGRESS_WRITE_INTERVAL_MS = 5000

/** WebKit desktop can't demux this container and there is no remux path available for it. */
function showContainerUnsupportedToast(container) {
  const descriptionKey = hasAvailableExternalPlayer()
    ? "detail.error.containerUnsupportedHint"
    : "detail.error.containerUnsupportedHintNoPlayer"
  toastError(t("detail.error.containerUnsupported", { container: container.toUpperCase() }), {
    description: t(descriptionKey),
  })
  externalBtnHandle?.refresh()
}

/** The remux failed because the provider itself rejected/failed the request, not because of the container. */
function showSourceUnavailableToast() {
  toastError(t("detail.error.sourceUnavailable"))
  externalBtnHandle?.refresh()
}

/** The container opened fine (remux worked); this device just has no HEVC decoder (e.g. Linux WebKitGTK). */
function showHevcUnsupportedToast() {
  toastError(t("detail.error.hevcUnsupported"), {
    description: t("detail.error.containerUnsupportedHint"),
  })
  externalBtnHandle?.refresh()
}

/** The container opened fine; this platform has no decoder for the audio codec (e.g. DTS on WebKitGTK/WebView2). */
function showAudioUnsupportedToast(codec) {
  toastError(t("detail.error.audioUnsupported", { codec: describeAudioCodec(codec) }), {
    description: t("detail.error.containerUnsupportedHint"),
  })
  externalBtnHandle?.refresh()
}

function setupPipButton(player) {
  const pipBtn = document.getElementById("series-detail-pip")
  if (!pipBtn) return
  const supported =
    !!window.AndroidPip ||
    (document.pictureInPictureEnabled === true)
  if (!supported) return
  pipBtn.removeAttribute("hidden")
  if (pipBtnBound) return
  pipBtnBound = true
  pipBtn.addEventListener("click", () => togglePip(player))
}

// One display-mode override per series (not per episode) - same mounted
// player and container across episode changes.
const videoScaleController = createVideoScaleController(() => (vjs ? vjs.el() : null))

function resolveVideoScaleMode() {
  if (activePlaylistId && series) {
    const override = getVideoScaleOverride(activePlaylistId, "series", series.id)
    if (override) return override
  }
  return getVideoScale()
}

function applyVideoScale() {
  videoScaleController.apply(resolveVideoScaleMode())
}

document.addEventListener(VIDEO_SCALE_EVENT, () => {
  if (series) applyVideoScale()
})

document.addEventListener(CHANNEL_VIDEO_SCALE_CHANGED_EVENT, (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "series") return
  if (!series) return
  if (detail.itemId === null || detail.itemId === series.id) applyVideoScale()
})

function setupScaleButton() {
  const scaleBtn = document.getElementById("series-detail-scale")
  if (!scaleBtn) return
  scaleBtn.removeAttribute("hidden")
  if (scaleBtnBound) return
  scaleBtnBound = true
  scaleBtn.addEventListener("click", () => openDisplayModeDialog())
}

function setupStatsButton() {
  const statsBtn = document.getElementById("series-detail-stats")
  if (!statsBtn) return
  statsBtn.removeAttribute("hidden")
  if (statsBtnBound) return
  statsBtnBound = true
  statsBtn.addEventListener("click", () => {
    const visible = getSeriesInsights().toggleOverlay()
    statsBtn.setAttribute("aria-pressed", String(visible))
  })
}

function setupHealthButton() {
  const healthBtn = document.getElementById("series-detail-health")
  if (!healthBtn) return
  healthBtn.removeAttribute("hidden")
  if (healthBtnBound) return
  healthBtnBound = true
  healthBtn.addEventListener("click", () => getSeriesInsights().openHealthDialog())
}

async function openDisplayModeDialog() {
  if (!series) return
  const currentMode = resolveVideoScaleMode()
  const result = await openVideoScaleDialog({
    currentMode,
    applyAllLabelKey: "stream.scale.applyAllDefault",
    onPreview: (mode) => videoScaleController.apply(mode),
  })
  applyVideoScale()
  if (!result) return
  if (result.applyToAll) {
    if (activePlaylistId) clearAllVideoScaleOverrides(activePlaylistId, "series")
    setVideoScale(result.mode)
    toast({
      title: t("stream.scale.toastDefault", { mode: t(videoScaleModeLabelKey(result.mode)) }),
      duration: 2200,
    })
  } else if (activePlaylistId) {
    setVideoScaleOverride(activePlaylistId, "series", series.id, result.mode)
  }
}

function progressExtrasFor(ep) {
  return {
    seriesId: series?.id ?? null,
    season: ep.season ?? currentSeason ?? null,
    episodeNum: ep.episode_num ?? null,
    episodeTitle: ep.title || "",
    seriesName: series?.name || "",
    seriesLogo: series?.logo || null,
  }
}

async function ensureEmbeddedPlayer(backend) {
  if (vjs) return vjs
  const videoEl = document.getElementById("series-player")
  if (!videoEl) return null
  const hasNativePipBridge = !!window.AndroidPip
  const mounted = await mountPlayer(videoEl, backend, {
    liveui: false,
    fluid: true,
    preload: "auto",
    autoplay: false,
    aspectRatio: "16:9",
    pictureInPictureToggle: !hasNativePipBridge,
  })
  if (mounted.kind !== "embedded") return null
  vjs = mounted.handle
  if (mounted.backend === "videojs") {
    attachPlayerFocusKeeper(vjs)
  }
  bindAutoPip(vjs)
  return vjs
}

function markNowPlayingEpisode(epId) {
  currentPlayingEpisodeId = epId == null ? null : Number(epId)
  if (!episodeList) return
  for (const row of episodeList.querySelectorAll(".episode-row")) {
    const rowId = Number(row.dataset.epId)
    if (currentPlayingEpisodeId != null && rowId === currentPlayingEpisodeId) {
      row.dataset.nowPlaying = "true"
    } else {
      delete row.dataset.nowPlaying
    }
  }
}

// The remuxed TS pipe has no intrinsic duration; get_series_info's episode.info.duration_secs is
// the source of truth, with episode.info.duration ("HH:MM:SS") as fallback.
function episodeDurationSeconds(episode) {
  const info = episode?.info || {}
  const durationSecs = Number(info.duration_secs || 0)
  if (durationSecs > 0) return durationSecs
  return parseHmsToSeconds(info.duration)
}

// Must run before a new episode's pipeline touches the player: the old switcher's listeners
// still sit on the shared media element and can re-register its own remux (one session at a time) or remount over the new one.
function retirePreviousPlayback() {
  audioSwitcher?.dispose()
  audioSwitcher = null
  audioDiscoveryController?.abort()
  audioDiscoveryController = null
  activeMkvSession?.stop()
  activeMkvSession = null
}

async function playEpisode(episode, options = {}) {
  if (!series || !episode) return
  const requestId = ++playRequestId
  let src = episode?._directUrl
    ? buildEpisodeStreamUrl(episode)
    : await resolveStreamUrl((c) => buildEpisodeStreamUrl(episode, c))
  if (!src) return
  if (requestId !== playRequestId) return
  // Ahead of every await that can register a proxy/remux session for this run.
  retirePreviousPlayback()
  dismissUpNext()

  if (activePlaylistId) {
    pushRecent(
      activePlaylistId,
      "series",
      series.id,
      series.name,
      series.logo || null
    )
  }

  // Mark before the Android intent handoff so the marker is in place if
  // the user comes back to the page from the system player.
  markNowPlayingEpisode(episode.id)

  if (await tryAndroidIntentPlayback(src)) return
  if (requestId !== playRequestId) return

  if (nowPlayingEl) {
    nowPlayingEl.textContent =
      `S${episode.season || currentSeason}E${episode.episode_num || "?"} · ${episode.title || ""}`
  }

  currentEpisode = episode
  externalBtnHandle?.refresh()

  const localSrc = await getLocalPlayableSrc(src)
  let playSrc = localSrc || src
  // The asset.localhost/asset:// mount URL doesn't reliably parse as http(s), so the container
  // decision for a local download uses the download's on-disk path instead.
  const localDownloadPath = localSrc ? await getLocalDownloadPath(src) : null
  if (requestId !== playRequestId) return
  const saved = activePlaylistId
    ? getProgress(activePlaylistId, "episode", episode.id)
    : null
  const resumePos =
    saved && !saved.completed && saved.position > RESUME_MIN_SECONDS
      ? (() => {
          const dur = saved.duration || 0
          if (dur === 0) return saved.position
          return saved.position / dur < RESUME_MAX_FRACTION ? saved.position : 0
        })()
      : 0

  // Native ExoPlayer Activity path
  if (
    androidNativePlayerAvailable &&
    getAndroidNativePlayerEnabled() &&
    activePlaylistId
  ) {
    const launched = launchAndroidNativeVodWithProgress({
      playlistId: activePlaylistId,
      contentKey: `ep:${episode.id}`,
      kind: "episode",
      id: episode.id,
      url: playSrc,
      title: `${series?.name || ""} - S${episode.season || currentSeason}E${episode.episode_num || "?"}`,
      posterUrl: series?.logo || "",
      startMs: Math.max(0, resumePos) * 1000,
      progressExtras: progressExtrasFor(episode),
      onCompleted: () => {
        // Trigger the same Up Next overlay the WebView player path uses.
        document.dispatchEvent(new CustomEvent("xt:series-episode-ended", {
          detail: { episodeId: episode.id },
        }))
      },
    })
    if (launched) return
  }

  const backend = getPlayerBackend()

  if (backend === "mpv" || backend === "vlc") {
    try {
      const externalSrc = (await getLocalDownloadPath(src)) || playSrc
      await launchExternalPlayback(backend, externalSrc, resumePos)
      pushEpisodePresence(episode)
      externalPresenceActive = true
    } catch (err) {
      surfaceLaunchError(err, backend)
    }
    return
  }

  const mountStartedAt = Date.now()
  const remuxAvailable = await vodAudioRemuxAvailable()
  const forceRemux = activePlaylistId
    ? isRemuxPinnedContent(activePlaylistId, buildRemuxContentKey("episode", episode.id))
    : false
  const containerPlanEnv = { isTauriDesktop: desktopPlatform, isWindows, remuxAvailable, forceRemux }
  let containerPlan = localDownloadPath
    ? planLocalVodContainerPlayback(localDownloadPath, containerPlanEnv)
    : planVodContainerPlayback(playSrc, containerPlanEnv)
  let resolvedContainer: "mkv" | "mp4" | null = null

  if (containerPlan.mode === "unsupported" && containerPlan.container === "avi" && !localDownloadPath) {
    const alternative = await probeVodContainerAlternative(playSrc)
    if (requestId !== playRequestId) return
    if (alternative) {
      log.info("[xt:series-detail] avi source has a playable alternative container", {
        container: alternative.container,
      })
      src = alternative.url
      playSrc = alternative.url
      resolvedContainer = alternative.container
      const planningUrl = swapUrlExtension(alternative.url, alternative.container) || alternative.url
      containerPlan = planVodContainerPlayback(planningUrl, containerPlanEnv)
    }
  }

  const detectedContainer = containerPlan.mode === "unsupported"
    ? containerPlan.container
    : localDownloadPath
      ? detectVodContainerFromLocalPath(localDownloadPath)
      : resolvedContainer || detectVodContainer(playSrc)
  log.info("[xt:vod-mount] plan decided", {
    mode: containerPlan.mode,
    container: detectedContainer,
    isTauriDesktop: desktopPlatform,
    isWindows,
    remuxAvailable,
    forceRemux,
    isLocalDownload: !!localDownloadPath,
  })
  if (containerPlan.mode === "unsupported") {
    showContainerUnsupportedToast(containerPlan.container)
    return
  }
  // In remux mode the audio switcher owns the mount (starts + seeks it itself); this function
  // must not touch src/playhead here, or it would re-register the remux.
  const remuxOwnsInitialMount = containerPlan.mode === "remux"

  if (posterEl) posterEl.classList.add("hidden")
  if (playerWrap) playerWrap.classList.remove("hidden")
  const videoEl = document.getElementById("series-player")
  videoEl?.removeAttribute("hidden")

  let player
  try {
    player = await ensureEmbeddedPlayer(backend)
  } catch (err) {
    log.error("[xt:series-detail] failed to mount player:", err)
    toastError("Couldn't start playback.")
    if (posterEl) posterEl.classList.remove("hidden")
    if (playerWrap) playerWrap.classList.add("hidden")
    return
  }
  if (!player) return
  if (requestId !== playRequestId) return
  setupPipButton(player)
  setupScaleButton()
  setupStatsButton()
  setupHealthButton()
  subtitleDelayController.setup()
  const mime = resolvedContainer === "mkv"
    ? "video/x-matroska"
    : resolvedContainer === "mp4"
      ? "video/mp4"
      : chooseMime(src)

  // Shared by a genuine post-mount decode failure (a plain player "error" in remux mode) and a
  // remux session dying mid-play (reported by the audio switcher): same classification, same teardown.
  function handleRemuxFailure(detail) {
    ownAudioSwitcher?.dispose()
    if (audioSwitcher === ownAudioSwitcher) audioSwitcher = null
    prepared?.mkvSession?.stop()
    if (activeMkvSession === prepared?.mkvSession) activeMkvSession = null
    if (posterEl) posterEl.classList.remove("hidden")
    if (playerWrap) playerWrap.classList.add("hidden")
    const upstreamFailure = isUpstreamHttpFailure(detail)
    const codecInfo = upstreamFailure ? null : player.codecInfo?.()
    const failure = upstreamFailure
      ? null
      : classifyStartFailure({
          videoCodec: codecInfo?.videoCodec,
          audioCodec: codecInfo?.audioCodec,
          errorDetail: detail,
          nameHint: hasHevcNameHint(episode.title || series?.name),
          deviceHevc: deviceSupportsHevc(),
        })
    const toastPath = upstreamFailure
      ? "upstream-http"
      : failure?.kind === "hevc"
        ? "hevc"
        // Without a known codec we can't name it in the toast, so fall back to the container message.
        : failure?.kind === "audio" && failure.codec
          ? "audio"
          : "container"
    log.info("[xt:vod-mount] start-failure verdict", {
      kind: failure?.kind ?? null,
      codec: failure?.codec ?? null,
      toastPath,
      contentKey: buildRemuxContentKey("episode", episode.id),
    })
    getSeriesInsights().record("giveup", failure?.kind ?? toastPath)
    // No automatic retry follows this failure - close the session now, not on the next play.
    getSeriesInsights().endSession("giveup")
    if (toastPath === "upstream-http") showSourceUnavailableToast()
    else if (toastPath === "hevc") showHevcUnsupportedToast()
    else if (toastPath === "audio") showAudioUnsupportedToast(failure.codec)
    else showContainerUnsupportedToast(resolvedContainer || detectVodContainer(playSrc) || "mkv")
  }

  // The player is shared across episodes, so a superseded run must not report (or seek) for the one that did play.
  player.one("error", () => {
    if (requestId !== playRequestId) return
    const e = player.error()
    log.error("[xt:series-detail] player error", {
      code: e?.code,
      message: e?.message,
    })
    if (containerPlan.mode === "remux") {
      // Any fatal code besides 4 downstream of an otherwise-successful remux mount is a genuine decode failure.
      if (e?.code !== 4) handleRemuxFailure(e?.message || "")
      return
    }
    if (desktopPlatform && e?.code === 4) {
      const unsupportedContainer = localDownloadPath
        ? detectVodContainerFromLocalPath(localDownloadPath)
        : resolvedContainer || detectVodContainer(playSrc)
      // Pinning forces the retuned attempt's plan to "remux", so this branch cannot re-fire for the same content.
      if (
        unsupportedContainer === "mkv" &&
        containerPlan.mode !== "remux" &&
        remuxAvailable &&
        activePlaylistId
      ) {
        const contentKey = buildRemuxContentKey("episode", episode.id)
        rememberRemuxPinnedContent(activePlaylistId, contentKey)
        log.warn("[xt:series-detail] WebView could not demux this MKV directly - remuxing with ffmpeg instead", {
          contentKey,
          container: unsupportedContainer,
        })
        retirePreviousPlayback()
        playEpisode(currentEpisode, { isAutomaticRetry: true })
        return
      }
      showContainerUnsupportedToast(unsupportedContainer || "mkv")
    }
  })
  player.one("loadedmetadata", () => {
    if (requestId !== playRequestId) return
    log.info("[xt:vod-mount] first loadedmetadata", { elapsedMs: Date.now() - mountStartedAt })
  })

  if (resumePos > 0 && !remuxOwnsInitialMount) {
    player.one("loadedmetadata", () => {
      if (requestId !== playRequestId) return
      const dur = player.duration?.() || saved?.duration || 0
      if (dur === 0 || resumePos / dur < RESUME_MAX_FRACTION) {
        try { player.currentTime?.(resumePos) } catch {}
      }
    })
  }

  // A local .mkv goes through the same tee proxy as a remote one, fed from its on-disk path
  // instead of a URL, since the ffmpeg sidecar only speaks http/pipe/tcp.
  let prepared
  if (remuxOwnsInitialMount && localDownloadPath) {
    prepared = await prepareLocalVodPlayback(localDownloadPath)
    if (requestId !== playRequestId) {
      prepared?.mkvSession?.stop()
      return
    }
    if (!prepared) {
      log.warn("[xt:series-detail] local vod proxy failed to register, cannot remux this download", {
        contentKey: buildRemuxContentKey("episode", episode.id),
        container: detectVodContainerFromLocalPath(localDownloadPath),
      })
      if (posterEl) posterEl.classList.remove("hidden")
      if (playerWrap) playerWrap.classList.add("hidden")
      showContainerUnsupportedToast("mkv")
      return
    }
  } else {
    prepared = await prepareVodPlayback(playSrc)
    if (requestId !== playRequestId) {
      prepared.mkvSession?.stop()
      return
    }
  }

  // The previous pipeline was already retired at the top of this run.
  audioDiscoveryController = new AbortController()
  const discoverySignal = audioDiscoveryController.signal
  let initialAudioSource = null
  // Only this pipeline's switcher, so a superseded pipeline tears down its own sessions and never the live one's.
  let ownAudioSwitcher = null

  function buildAudioSwitcher(tracks) {
    return createVodAudioSwitcher({
      handle: player,
      originalSrc: prepared.playbackUrl,
      originalMime: mime,
      originalSubtitles: { sourceUrl: playSrc, mkvSession: prepared.mkvSession },
      sourceUrl: playSrc,
      remuxInputUrl: prepared.mkvSession ? prepared.playbackUrl : null,
      getKnownDurationSeconds: () => episodeDurationSeconds(episode) || saved?.duration || player.duration?.() || 0,
      tracks,
      mountRemuxImmediately: remuxOwnsInitialMount,
      initialStartSeconds: resumePos,
      onRemuxUnrecoverable: (detail) => {
        log.warn("[xt:series-detail] remux playback unavailable for this source:", detail)
        handleRemuxFailure(detail)
      },
    })
  }

  if (remuxOwnsInitialMount) {
    // Registers against the synthetic default track right away; the real list arrives via
    // setTracks once the container-head discovery below resolves, with no remount in between.
    ownAudioSwitcher = buildAudioSwitcher([])
    audioSwitcher = ownAudioSwitcher
    initialAudioSource = ownAudioSwitcher.source
  }

  if (requestId !== playRequestId) {
    // Dispose first: stops any remux session before the tee that feeds it goes away.
    ownAudioSwitcher?.dispose()
    if (audioSwitcher === ownAudioSwitcher) audioSwitcher = null
    prepared.mkvSession?.stop()
    return
  }

  // This pipeline owns the mount from here on, so its tee session is the one the next episode must stop.
  activeMkvSession = prepared.mkvSession
  // An automatic remux retry continues the same tune's session instead of opening a new one.
  if (options.isAutomaticRetry) {
    getSeriesInsights().record("fallback", "auto:mkv-remux-fallback")
  } else {
    getSeriesInsights().startSession({
      label: [series?.name, episode.title].filter(Boolean).join(" - "),
    })
  }
  if (!remuxOwnsInitialMount) {
    player.src({
      src: prepared.playbackUrl,
      type: mime,
      subtitles: { sourceUrl: playSrc, mkvSession: prepared.mkvSession },
      audio: initialAudioSource,
    })
  }
  applyVideoScale()

  if (!progressListenersBound) {
    progressListenersBound = true
    let lastWriteAt = 0
    player.on("timeupdate", () => {
      if (!activePlaylistId || !currentEpisode) return
      const now = Date.now()
      if (now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return
      const pos = player.currentTime?.() || 0
      const dur = player.duration?.() || 0
      if (pos < 1) return
      lastWriteAt = now
      setProgress(
        activePlaylistId,
        "episode",
        currentEpisode.id,
        pos,
        dur,
        progressExtrasFor(currentEpisode)
      )
    })
    player.on("ended", () => {
      getSeriesInsights().endSession("ended")
      if (!activePlaylistId || !currentEpisode) return
      const dur = player.duration?.() || 0
      markCompleted(activePlaylistId, "episode", currentEpisode.id, {
        duration: dur,
        ...progressExtrasFor(currentEpisode),
      })
      const nextEp = findNextEpisode(currentEpisode)
      if (nextEp) showUpNextOverlay(nextEp)
    })
  }

  // The switcher-owned mount plays itself once its remux session is up.
  if (!remuxOwnsInitialMount) {
    playWhenReady(player, {
      isStale: () => requestId !== playRequestId,
      onReject: (err) =>
        log.info("[xt:series-detail] play() rejected - re-arming on canplay", {
          error: err?.name || err?.message || String(err),
        }),
      onRetryReject: (err) =>
        log.warn("[xt:series-detail] retry play() rejected:", err?.name || err?.message || err),
    })
  }

  // Fire-and-forget network probe that must never sit ahead of the mount above.
  if (remuxAvailable) {
    discoverVodAudioTracks(prepared.mkvSession, playSrc, discoverySignal).then((audioTracks) => {
      if (requestId !== playRequestId) return
      if (remuxOwnsInitialMount) {
        if (audioTracks.length > 0) ownAudioSwitcher?.setTracks(audioTracks)
        return
      }
      if (audioTracks.length < 2) return
      ownAudioSwitcher = buildAudioSwitcher(audioTracks)
      audioSwitcher = ownAudioSwitcher
      player.setAudioSource?.(ownAudioSwitcher.source)
    })
  }

  pushEpisodePresence(episode)
  externalPresenceActive = false
}

function pushEpisodePresence(episode) {
  if (!activePlaylistId || !series || !episode) return
  setRichPresence({
    playlistId: activePlaylistId,
    details: series.name || "Watching a series",
    state: `S${episode.season || currentSeason || "?"}E${episode.episode_num || "?"} · ${episode.title || ""}`.trim(),
    largeImage: series.logo || "logo",
    largeText: series.name || "Extreme InfiniTV",
    smallImage: "series",
    smallText: "Series",
    startTimestamp: Date.now(),
  })
}

async function launchExternalPlayback(backend, src, resumeSeconds) {
  const launcher = getExternalLauncher(backend)
  toast({
    title: t("settings.playback.launching", { player: backend.toUpperCase() })
      || `Launching ${backend.toUpperCase()}…`,
    duration: 2000,
  })
  await launcher.launch(src, { resumeSeconds })
}

// ----------------------------
// Subtitle delay
// ----------------------------
const subtitleDelayController = createSubtitleDelayController({
  dialogId: "series-subtitle-delay-dialog",
  button: document.getElementById("series-subtitle-delay-btn"),
  nudge: (deltaSeconds) => vjs?.subtitleDelay?.(deltaSeconds),
  getMediaElement: () => vjs?.getMediaElement?.() ?? null,
})

document.addEventListener("keydown", (event) => subtitleDelayController.handleKeydown(event))

const externalBtnHandle = setupExternalPlayerButton(
  /** @type {HTMLButtonElement|null} */ (document.getElementById("series-detail-open-external")),
  {
    getSrc() {
      if (!currentEpisode) return null
      return buildEpisodeStreamUrl(currentEpisode) || null
    },
    getResumeSeconds() {
      if (!activePlaylistId || !currentEpisode) return 0
      const saved = getProgress(activePlaylistId, "episode", currentEpisode.id)
      if (!saved || saved.completed) return 0
      return saved.position > RESUME_MIN_SECONDS ? saved.position : 0
    },
    getTitle() {
      if (!currentEpisode) return series?.name || null
      const seasonNum = currentEpisode.season || currentSeason
      const epNum = currentEpisode.episode_num
      const episodeTitle = currentEpisode.title || ""
      const seriesName = series?.name || ""
      const sxe = seasonNum && epNum ? `S${seasonNum}E${epNum}` : ""
      return [seriesName, sxe, episodeTitle].filter(Boolean).join(" · ") || null
    },
    beforeLaunch() {
      try { vjs?.pause?.() } catch {}
    },
    afterLaunch() {
      pushEpisodePresence(currentEpisode)
      externalPresenceActive = true
    },
  }
)

subscribeExternalPlayerExit(() => {
  if (!externalPresenceActive) return
  externalPresenceActive = false
})

window.addEventListener("pagehide", () => {
  closeEpisodeMenu()
  try {
    if (activePlaylistId && currentEpisode && vjs) {
      const pos = vjs.currentTime?.() || 0
      const dur = vjs.duration?.() || 0
      if (pos > 1) {
        setProgress(
          activePlaylistId,
          "episode",
          currentEpisode.id,
          pos,
          dur,
          progressExtrasFor(currentEpisode)
        )
      }
    }
    vjs?.pause?.()
    vjs?.dispose?.()
    retirePreviousPlayback()
    subtitleDelayController.teardown()
  } catch {}
  clearAmbient(ambientEl)
  externalPresenceActive = false
  clearRichPresence().catch(() => {})
})

// ----------------------------
// Up-next overlay (10s countdown after an episode ends)
// ----------------------------
const UPNEXT_SECONDS = 10
let upNextEl = null
let upNextTimer = null
let upNextKeyHandler = null
let upNextActive = false

function findNextEpisode(currentEp) {
  if (!episodesByKey || !currentEp) return null
  const seasonKeys = Object.keys(episodesByKey).sort(
    (a, b) => Number(a) - Number(b)
  )
  const currentSeasonKey = String(currentEp.season ?? currentSeason ?? "")
  const inSeason = episodesByKey[currentSeasonKey] || []
  const idx = inSeason.findIndex((ep) => Number(ep.id) === Number(currentEp.id))
  if (idx >= 0 && idx + 1 < inSeason.length) {
    return { season: currentSeasonKey, episode: inSeason[idx + 1] }
  }
  const seasonIdx = seasonKeys.indexOf(currentSeasonKey)
  for (let cursor = seasonIdx + 1; cursor < seasonKeys.length; cursor++) {
    const eps = episodesByKey[seasonKeys[cursor]] || []
    if (eps.length) return { season: seasonKeys[cursor], episode: eps[0] }
  }
  return null
}

function dismissUpNext() {
  if (upNextTimer) {
    clearInterval(upNextTimer)
    upNextTimer = null
  }
  if (upNextKeyHandler) {
    document.removeEventListener("keydown", upNextKeyHandler, true)
    upNextKeyHandler = null
  }
  if (upNextEl) {
    upNextEl.remove()
    upNextEl = null
  }
  upNextActive = false
}

function getUpNextHost() {
  // Prefer the Video.js root element so the card travels with the player
  // into fullscreen. Fall back to the outer wrap if Video.js hasn't mounted
  // yet (e.g. user hit the Restart-from-beginning path).
  const vjsRoot = vjs?.el?.()
  return vjsRoot || playerWrap || null
}

function showUpNextOverlay(next) {
  const host = getUpNextHost()
  if (!host || upNextActive) return
  dismissUpNext()
  upNextActive = true

  const seasonLabel = next.season || next.episode.season || ""
  const epNum = next.episode.episode_num || "?"
  const epTitle = next.episode.title || t("series.episode.fallback", { n: epNum })

  upNextEl = document.createElement("div")
  upNextEl.className =
    "up-next-card absolute right-3 bottom-3 z-30 max-w-sm w-[min(22rem,calc(100%-1.5rem))] " +
    "rounded-2xl border border-line bg-surface/95 backdrop-blur-md shadow-2xl " +
    "p-4 flex flex-col gap-3 ring-1 ring-accent/30"
  upNextEl.setAttribute("role", "dialog")
  upNextEl.setAttribute("aria-live", "polite")
  upNextEl.setAttribute("aria-label", t("detail.upNext"))

  const eyebrow = document.createElement("div")
  eyebrow.className =
    "text-eyebrow font-semibold uppercase text-accent tracking-widest"
  eyebrow.textContent = t("detail.upNext")
  upNextEl.appendChild(eyebrow)

  const titleRow = document.createElement("div")
  titleRow.className = "flex flex-col gap-0.5 min-w-0"
  const seasonEl = document.createElement("div")
  seasonEl.className = "text-2xs text-fg-3 tabular-nums"
  seasonEl.textContent = seasonLabel
    ? `S${seasonLabel} · E${epNum}`
    : t("series.episode.fallback", { n: epNum })
  const epTitleEl = document.createElement("div")
  epTitleEl.className = "text-sm font-semibold text-fg truncate"
  epTitleEl.textContent = epTitle
  titleRow.append(seasonEl, epTitleEl)
  upNextEl.appendChild(titleRow)

  const progressTrack = document.createElement("div")
  progressTrack.className = "h-1 rounded-full bg-line/50 overflow-hidden"
  const progressFill = document.createElement("div")
  progressFill.className = "h-full bg-accent transition-[width] duration-200"
  progressFill.style.width = "0%"
  progressTrack.appendChild(progressFill)
  upNextEl.appendChild(progressTrack)

  const actions = document.createElement("div")
  actions.className = "flex items-center justify-between gap-2"
  const countdownEl = document.createElement("span")
  countdownEl.className = "text-xs text-fg-3 tabular-nums"
  const skipBtn = document.createElement("button")
  skipBtn.type = "button"
  skipBtn.className =
    "rounded-lg border border-line px-3 min-h-9 text-xs text-fg-2 " +
    "hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg " +
    "focus-visible:border-accent outline-none transition-colors"
  skipBtn.textContent = t("common.cancel")
  skipBtn.addEventListener("click", () => dismissUpNext())
  const playNowBtn = document.createElement("button")
  playNowBtn.type = "button"
  playNowBtn.className =
    "rounded-lg bg-accent text-bg px-3 min-h-9 text-xs font-semibold " +
    "hover:brightness-110 focus-visible:brightness-110 outline-none transition-[filter,transform] " +
    "active:scale-[0.97]"
  playNowBtn.textContent = t("detail.action.playNow")
  playNowBtn.addEventListener("click", () => {
    dismissUpNext()
    currentSeason = next.season
    renderSeasonTabs(Object.keys(episodesByKey || {}).sort((a, b) => Number(a) - Number(b)))
    renderEpisodes()
    playEpisode(next.episode)
  })
  actions.append(countdownEl, skipBtn, playNowBtn)
  upNextEl.appendChild(actions)

  if (host === playerWrap) host.classList.add("relative")
  host.appendChild(upNextEl)

  let remaining = UPNEXT_SECONDS
  const tick = () => {
    countdownEl.textContent = t("series.upNext.playingIn", { seconds: remaining })
    progressFill.style.width = `${((UPNEXT_SECONDS - remaining) / UPNEXT_SECONDS) * 100}%`
  }
  tick()
  upNextTimer = setInterval(() => {
    remaining--
    tick()
    if (remaining <= 0) {
      dismissUpNext()
      currentSeason = next.season
      renderSeasonTabs(
        Object.keys(episodesByKey || {}).sort((a, b) => Number(a) - Number(b))
      )
      renderEpisodes()
      playEpisode(next.episode)
    }
  }, 1000)

  upNextKeyHandler = (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === "Enter") {
      event.preventDefault()
      playNowBtn.click()
      return
    }
    // Any other key cancels - matches Plex/Netflix UX.
    dismissUpNext()
  }
  document.addEventListener("keydown", upNextKeyHandler, true)
}

// ----------------------------
// Favorites
// ----------------------------
favBtn?.addEventListener("click", () => {
  if (!series || !activePlaylistId) return
  const isStubName = series.name === t("list.seriesFallback", { id: series.id })
  toggleFavorite(activePlaylistId, "series", series.id, {
    name: isStubName ? "" : series.name || series.title || "",
    logo: series.logo || series.cover || null,
  })
})

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  if (series?.id === detail.id) syncFavButton()
})

// ----------------------------
// Watchlist
// ----------------------------
watchBtn?.addEventListener("click", () => {
  if (!series || !activePlaylistId) return
  const isStubName = series.name === t("list.seriesFallback", { id: series.id })
  toggleWatchlist(activePlaylistId, "series", series.id, {
    name: isStubName ? "" : series.name || series.title || "",
    logo: series.logo || series.cover || null,
  })
})

document.addEventListener("xt:watchlist-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  if (series?.id === detail.id) syncWatchButton()
})

// ----------------------------
// Trailer
// ----------------------------
trailerBtn?.addEventListener("click", () => {
  if (!trailerUrl) return
  openExternal(trailerUrl)
})

document.addEventListener("xt:progress-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "episode") return
  if (!episodeList) return
  const row = episodeList.querySelector(
    `.episode-row[data-ep-id="${CSS.escape(String(detail.id))}"]`
  )
  if (!row) return
  if (detail.completed) row.dataset.watched = "true"
  else delete row.dataset.watched
})

// ----------------------------
// Boot
// ----------------------------
function showDetailSkeleton() {
  document.querySelectorAll("[data-detail-skeleton]").forEach((el) => el.removeAttribute("hidden"))
  titleEl?.setAttribute("hidden", "")
  metaEl?.setAttribute("hidden", "")
  plotEl?.setAttribute("hidden", "")
}

// Reveals real title/meta/plot and hides the skeleton. Guarantees a non-empty
// title even if the provider gave no name at all, so the numeric-id stub never shows.
// The hero settles here too, but only when TMDb is inactive - active TMDb keeps the
// hero skeleton until the enrichment attempt settles, elsewhere.
function hideDetailSkeleton() {
  document.querySelectorAll("[data-detail-skeleton]").forEach((el) => el.setAttribute("hidden", ""))
  if (titleEl) {
    if (!titleEl.textContent) titleEl.textContent = t("series.error.cantLoad")
    titleEl.removeAttribute("hidden")
  }
  metaEl?.removeAttribute("hidden")
  plotEl?.removeAttribute("hidden")
  if (!isTmdbActive()) settleHero()
}

function showError(msg) {
  if (titleEl) titleEl.textContent = t("series.error.cantLoad")
  if (plotEl) plotEl.textContent = msg
  hideDetailSkeleton()
  settleHero()
}

async function boot() {
  await initI18n()
  if (!seriesId) {
    showError(t("detail.error.noSeriesId"))
    return
  }

  // A playlist switch re-boots: dispose any player from the previous playlist
  // and clear episode/season/up-next state so nothing leaks across.
  playRequestId++
  const enrichRequestIdForThisBoot = ++enrichRequestId
  seasonEnrichRequestId++
  try {
    vjs?.pause?.()
    await vjs?.dispose?.()
  } catch {}
  vjs = null
  retirePreviousPlayback()
  progressListenersBound = false
  currentEpisode = null
  currentPlayingEpisodeId = null
  currentSeason = ""
  dismissUpNext()
  closeEpisodeMenu()

  series = null
  episodesByKey = null
  seriesCatalogPromise = null
  heroPosterUrl = null
  heroTmdbBackdropUrl = null
  heroProviderBackdropUrl = null
  heroSettled = false
  earlyEnrichmentHandled = false
  earlyEnrichmentPopulatedSimilar = false
  showDetailSkeleton()
  if (metaEl) metaEl.textContent = ""
  if (plotEl) plotEl.textContent = ""
  if (titleEl) titleEl.textContent = ""
  resetTmdbEnrichmentUI()
  if (seasonTabs) seasonTabs.replaceChildren()
  if (episodeList) episodeList.replaceChildren()

  const active = await getActiveEntry()
  if (!active) {
    showError(t("detail.error.noPlaylist"))
    return
  }
  activePlaylistId = active._id
  await ensurePrefsLoaded()
  creds = await loadCreds()

  const list = getCached(active._id, "series")
  const catalogSeries = list?.data?.find((s) => Number(s.id) === seriesId) || null

  const seriesDownloads = listDownloads().filter(
    (d) =>
      d.source?.kind === "episode" &&
      Number(d.source?.seriesId) === seriesId
  )

  const stubName = t("list.seriesFallback", { id: seriesId })
  const sample = seriesDownloads[0]
  series = catalogSeries || {
    id: seriesId,
    name: sample?.source?.seriesName || stubName,
    logo: sample?.source?.logo || null,
  }

  // The stub id-based name never reaches the DOM - the title stays hidden behind
  // the skeleton until a real name arrives (catalog/download now, or provider below).
  if (titleEl && series.name !== stubName) titleEl.textContent = series.name
  // Hero stays in its skeleton state - settleHero() below decides when to paint it once.
  heroPosterUrl = series.logo || null
  setAmbient(series.logo || null)
  syncFavButton()
  syncWatchButton()

  // Both probes are network-free (hydrate + memory read) and run under one bound,
  // so a cold IDB read can never delay first paint past the shared timeout.
  const { enrichment: earlyEnrichment, providerInfo: earlyProviderInfo } = await peekEarlyDetailData(
    "series",
    series.id,
    active._id,
    `series_info_${seriesId}`
  )
  if (enrichRequestIdForThisBoot !== enrichRequestId) return

  let providerInfoReady = false
  if (earlyProviderInfo) {
    applySeriesInfo(earlyProviderInfo.data)
    providerInfoReady = true
  } else if (seriesDownloads.length) {
    // Optimistic render: real episode data even before provider info arrives.
    renderDownloadedEpisodes(seriesDownloads)
  }

  if (earlyEnrichment) {
    resolvedTmdbId = earlyEnrichment.tmdbId
    applyEnrichmentPatch(earlyEnrichment.enrichment)
    settleHero()
    earlyEnrichmentHandled = true
    if (earlyEnrichment.enrichment.recommendations?.length) {
      const matches = matchRecommendationsToCatalog(earlyEnrichment.enrichment.recommendations, list?.data || [], {
        mediaType: "tv",
        limit: 12,
        sourcePrefix: extractLangPrefix(series.name),
      })
      if (matches.length) {
        renderSimilar(matches)
        earlyEnrichmentPopulatedSimilar = true
      }
    }
    const seasonNumber = toIndex(currentSeason)
    if (seasonNumber != null) {
      const seasonEnrichment = await peekCachedSeasonEnrichment(earlyEnrichment.tmdbId, seasonNumber)
      if (enrichRequestIdForThisBoot === enrichRequestId && seasonEnrichment?.episodes?.length) {
        patchSeasonEpisodes(seasonEnrichment.episodes)
      }
    }
  }

  if (providerInfoReady) hideDetailSkeleton()

  // Early autoplay handoff for downloaded episodes
  if (
    autoplayPending &&
    autoplayEpisodeId &&
    !providerInfoReady &&
    seriesDownloads.length
  ) {
    const dl = seriesDownloads.find(
      (d) => Number(d.source?.id) === autoplayEpisodeId
    )
    if (dl) {
      autoplayPending = false
      try {
        urlParams.delete("autoplay")
        urlParams.delete("episode")
        const next = urlParams.toString()
        history.replaceState(
          null,
          "",
          location.pathname + (next ? `?${next}` : "")
        )
      } catch {}
      const extMatch = String(dl.url || "").match(/\.([a-z0-9]{2,5})(?:\?|$)/i)
      const synthEp = {
        id: autoplayEpisodeId,
        season: dl.source.season ?? "1",
        episode_num: dl.source.episode ?? null,
        title: dl.source.seriesName
          ? String(dl.title || "")
              .replace(`${dl.source.seriesName} - `, "")
              .replace(/^S\d+E\d+\s*-\s*/, "")
          : "",
        container_extension: extMatch?.[1] || "mp4",
        _directUrl: dl.url,
      }
      playEpisode(synthEp)
    }
  }

  let infoOk = providerInfoReady
  if (creds.host && creds.user && creds.pass) {
    try {
      const r = await xtreamApiFetch("get_series_info", {
        series_id: String(seriesId),
        series: String(seriesId),
      })
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      setCached(active._id, `series_info_${seriesId}`, data, SERIES_INFO_TTL_MS)
      if (enrichRequestIdForThisBoot === enrichRequestId) {
        applySeriesInfo(data)
        // applySeriesInfo rebuilds meta text and episode rows, wiping the merge; reassert it.
        // settleHero() is a no-op once already settled, so this never repaints with a different image.
        if (earlyEnrichmentHandled) {
          applyEnrichmentPatch(earlyEnrichment.enrichment)
          settleHero()
          const seasonNumber = toIndex(currentSeason)
          if (seasonNumber != null) {
            const seasonEnrichment = await peekCachedSeasonEnrichment(earlyEnrichment.tmdbId, seasonNumber)
            if (seasonEnrichment?.episodes?.length) patchSeasonEpisodes(seasonEnrichment.episodes)
          }
        }
        hideDetailSkeleton()
      }
      infoOk = true
    } catch (e) {
      log.error("[xt:series-detail] info fetch failed:", e)
      if (!providerInfoReady && enrichRequestIdForThisBoot === enrichRequestId) {
        if (plotEl) {
          plotEl.textContent = seriesDownloads.length
            ? t("series.error.providerLocal")
            : t("series.error.failedDetails")
        }
        if (!seriesDownloads.length && episodeList) {
          episodeList.replaceChildren()
          const fail = document.createElement("div")
          fail.className = "text-fg-3 text-sm py-3"
          fail.textContent = t("series.error.cantLoadEpisodes")
          episodeList.appendChild(fail)
        }
        hideDetailSkeleton()
      }
    }
  } else if (!providerInfoReady) {
    if (plotEl) {
      plotEl.textContent = seriesDownloads.length
        ? t("series.error.localPlayable")
        : t("detail.error.noPlaylist")
    }
    hideDetailSkeleton()
  }

  populateSimilarRail(enrichRequestIdForThisBoot).catch((err) => {
    log.warn("[xt:series-detail] similar rail population failed:", err)
  })

  if (autoplayPending && autoplayEpisodeId && !infoOk) {
    const dl = seriesDownloads.find(
      (d) => Number(d.source?.id) === autoplayEpisodeId
    )
    if (dl) {
      const extMatch = String(dl.url || "").match(/\.([a-z0-9]{2,5})(?:\?|$)/i)
      const synthEp = {
        id: autoplayEpisodeId,
        season: dl.source.season ?? "1",
        episode_num: dl.source.episode ?? null,
        title: dl.source.seriesName
          ? String(dl.title || "")
              .replace(`${dl.source.seriesName} - `, "")
              .replace(/^S\d+E\d+\s*-\s*/, "")
          : "",
        container_extension: extMatch?.[1] || "mp4",
        _directUrl: dl.url,
      }
      autoplayPending = false
      try {
        urlParams.delete("autoplay")
        urlParams.delete("episode")
        const next = urlParams.toString()
        history.replaceState(
          null,
          "",
          location.pathname + (next ? `?${next}` : "")
        )
      } catch {}
      playEpisode(synthEp)
      return
    }
  }

  setTimeout(() => favBtn?.focus?.(), 0)
}

document.addEventListener("xt:active-changed", () => boot())

boot()
