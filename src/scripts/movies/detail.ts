// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Movie detail page (route: /movies/detail?id=<vod_id>)
import { log } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
  fmtBase,
} from "@/scripts/lib/creds.js"
import { xtreamApiFetch, resolveStreamUrl } from "@/scripts/lib/xtream-api.js"
import { getCached, setCached } from "@/scripts/lib/cache.js"
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
  listDownloads,
  isDownloadable,
  inferExt,
  getLocalPlayableSrc,
  tryAndroidIntentPlayback,
  DOWNLOADS_LIST_EVENT,
  DOWNLOAD_PROGRESS_EVENT,
} from "@/scripts/lib/downloads.js"
import {
  clearAmbient,
  setAmbient as setAmbientOn,
  paintPoster as paintPosterOn,
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
  VIDEO_SCALE_EVENT,
} from "@/scripts/lib/app-settings.js"
import { fmtImdbRating } from "@/scripts/lib/format.js"
import { setRichPresence, clearRichPresence } from "@/scripts/lib/discord-rpc.js"
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { mountPlayer, getExternalLauncher } from "@/scripts/lib/player-runtime.ts"
import { toast, toastError } from "@/scripts/lib/toast.js"
import { setupExternalPlayerButton, surfaceLaunchError } from "@/scripts/lib/external-player-button.ts"
import { createVideoScaleController } from "@/scripts/lib/video-scale.ts"
import { openVideoScaleDialog, videoScaleModeLabelKey } from "@/scripts/lib/video-scale-dialog.ts"

const VOD_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ----------------------------
// Refs
// ----------------------------
const ambientEl = document.getElementById("movie-detail-ambient")
const titleEl = document.getElementById("movie-detail-title")
const metaEl = document.getElementById("movie-detail-meta")
const plotEl = document.getElementById("movie-detail-plot")
const posterEl = document.getElementById("movie-detail-poster")
const playerWrap = document.getElementById("movie-detail-player-wrap")
const playBtn = document.getElementById("movie-detail-play")
const playLabelEl = document.getElementById("movie-detail-play-label")
const playSubEl = document.getElementById("movie-detail-play-sub")
const restartBtn = document.getElementById("movie-detail-restart")
const favBtn = document.getElementById("movie-detail-fav")
const watchBtn = document.getElementById("movie-detail-watch")
const watchLabelEl = document.getElementById("movie-detail-watch-label")
const trailerBtn = document.getElementById("movie-detail-trailer")
const downloadBtn = document.getElementById("movie-detail-download")
const downloadLabel = document.getElementById("movie-detail-download-label")
let trailerUrl = ""

// ----------------------------
// State
// ----------------------------
const urlParams = new URLSearchParams(location.search)
const movieId = Number(urlParams.get("id") || "0")
let wantsAutoplay = urlParams.get("autoplay") === "1"
let activePlaylistId = ""
let creds = { host: "", port: "", user: "", pass: "" }
let movie = null
let detailSrc = ""
let detailSrcBuilder = null

const setAmbient = (url) => setAmbientOn(ambientEl, url)
const paintPoster = (name, logo) => paintPosterOn(posterEl, name, logo)

// Xtream `youtube_trailer` can be either a bare 11-char video ID or a full
// URL. Normalize to a watchable youtube.com URL or "" if the value isn't
// shaped like either.
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

function fmtDuration(value) {
  if (value == null || value === "") return ""
  const raw = String(value).trim()
  if (!raw) return ""

  let totalMin = 0
  if (raw.includes(":")) {
    const parts = raw.split(":").map((part) => parseInt(part, 10))
    if (parts.some((part) => !Number.isFinite(part))) return raw
    let totalSec = 0
    if (parts.length === 3) totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2]
    else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1]
    else return raw
    totalMin = Math.round(totalSec / 60)
  } else {
    totalMin = parseInt(raw, 10)
  }
  if (!Number.isFinite(totalMin) || totalMin <= 0) return raw
  const h = Math.floor(totalMin / 60)
  const mm = totalMin % 60
  if (!h) return `${mm} min`
  return `${h}h ${mm.toString().padStart(2, "0")}m`
}

function applyVodInfo(data) {
  const movieData = data?.movie_data || data?.info || data || {}
  const info = data?.info || data?.movie_data || {}

  // Poster: prefer the per-item API fields when the list-cache logo is
  // missing (e.g. user landed straight on this URL without /movies having
  // been loaded yet). cover_big / movie_image / cover are the standard
  // Xtream keys.
  const apiName = movieData.name || info.name || ""
  const fallbackName = t("list.movieFallback", { id: movieId })
  if (apiName && movie && (!movie.name || movie.name === fallbackName)) {
    movie.name = apiName
    if (titleEl) titleEl.textContent = apiName
  }

  const apiLogo =
    info.cover_big ||
    info.movie_image ||
    info.cover ||
    movieData.cover ||
    movieData.stream_icon ||
    null
  if (apiLogo && (!movie || !movie.logo)) {
    if (movie) movie.logo = apiLogo
    paintPoster(movie?.name, apiLogo)
    setAmbient(apiLogo)
  }

  let src = ""
  let builder = null
  if (movieData.stream_url && /^https?:\/\//i.test(movieData.stream_url)) {
    src = movieData.stream_url
  } else if (movieData.stream_url) {
    const relPath = movieData.stream_url.replace(/^\/+/, "")
    builder = (c) => `${fmtBase(c.host, c.port).replace(/\/+$/, "")}/${relPath}`
    src = builder(creds)
  } else if (creds.host && creds.user && creds.pass) {
    const rawExt =
      movieData.container_extension || info.container_extension || "mp4"
    const ext = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"
    builder = (c) =>
      fmtBase(c.host, c.port) +
      "/movie/" +
      encodeURIComponent(c.user) +
      "/" +
      encodeURIComponent(c.pass) +
      "/" +
      encodeURIComponent(movieId) +
      "." +
      ext
    src = builder(creds)
  }

  detailSrc = src
  detailSrcBuilder = builder
  applyDownloadState()
  externalBtnHandle?.refresh()

  const year = movieData.releasedate || movieData.year || info.year || ""
  const durationSecs = Number(movieData.duration_secs || info.duration_secs || 0)
  const duration =
    movieData.duration ||
    info.duration ||
    (durationSecs > 0 ? Math.round(durationSecs / 60) : "")
  const rating =
    movieData.rating || info.rating || movieData.rating_5based || ""
  const genre = movieData.genre || info.genre || movieData.category || ""
  const plot =
    movieData.plot ||
    movieData.description ||
    info.plot ||
    info.description ||
    ""

  if (metaEl) {
    const bits = []
    if (year) bits.push(`<span>${escapeText(String(year))}</span>`)
    const humanDur = fmtDuration(duration)
    if (humanDur) bits.push(`<span>${escapeText(humanDur)}</span>`)
    if (genre) bits.push(`<span>${escapeText(genre)}</span>`)
    const ratingText = fmtImdbRating(rating)
    if (ratingText) {
      bits.push(
        '<span class="inline-flex items-center gap-1 text-fg-2" aria-label="' +
          escapeText(t("detail.imdbRatingAria", { rating: ratingText })) +
          '">' +
          '<svg viewBox="0 0 24 24" width="0.95em" height="0.95em" fill="currentColor" aria-hidden="true" class="text-accent">' +
          '<path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/>' +
          "</svg>" +
          `<span class="font-medium tabular-nums">${ratingText}</span>` +
          '<span class="text-fg-3">/10</span>' +
          "</span>"
      )
    }
    metaEl.innerHTML = bits.join(' <span aria-hidden="true">·</span> ')
  }
  if (plotEl) plotEl.textContent = plot || t("detail.noDescription")

  trailerUrl = youtubeUrlFromTrailer(
    movieData.youtube_trailer || info.youtube_trailer || ""
  )
  if (trailerBtn) {
    if (trailerUrl) trailerBtn.removeAttribute("hidden")
    else trailerBtn.setAttribute("hidden", "")
  }
}

function escapeText(text) {
  const div = document.createElement("div")
  div.textContent = String(text)
  return div.innerHTML
}

function syncFavButton() {
  if (!favBtn || !movie || !activePlaylistId) return
  const fav = isFavorite(activePlaylistId, "vod", movie.id)
  favBtn.textContent = fav ? t("detail.action.removeFavorite") : t("detail.action.addFavorite")
  favBtn.classList.toggle("text-accent", fav)
  favBtn.setAttribute("aria-pressed", String(fav))
}

function syncWatchButton() {
  if (!watchBtn || !movie || !activePlaylistId) return
  const onWatchlist = isOnWatchlist(activePlaylistId, "vod", movie.id)
  if (watchLabelEl) {
    watchLabelEl.textContent = onWatchlist ? t("detail.watchlist.on") : t("detail.action.watchLater")
  }
  watchBtn.classList.toggle("text-accent", onWatchlist)
  watchBtn.setAttribute("aria-pressed", String(onWatchlist))
}

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
  return `${m}:${String(ss).padStart(2, "0")}`
}

function syncResumeUI() {
  if (!playBtn || !movie) return
  const saved = activePlaylistId
    ? getProgress(activePlaylistId, "vod", movie.id)
    : null
  const canResume =
    saved && !saved.completed && saved.position > RESUME_MIN_SECONDS
  if (canResume) {
    if (playLabelEl) playLabelEl.textContent = t("detail.action.continue")
    if (playSubEl) playSubEl.textContent = t("detail.action.continueFrom", { time: fmtClock(saved.position) })
    playBtn.setAttribute("aria-label", t("detail.action.continueAria", { time: fmtClock(saved.position) }))
    if (restartBtn) restartBtn.removeAttribute("hidden")
  } else {
    if (playLabelEl) playLabelEl.textContent = t("detail.action.play")
    if (playSubEl) playSubEl.textContent = ""
    playBtn.setAttribute("aria-label", t("detail.action.playAria"))
    if (restartBtn) restartBtn.setAttribute("hidden", "")
  }
}

// ----------------------------
// Playback
// ----------------------------
let vjs = null
let progressListenersBound = false
let pipBtnBound = false
let scaleBtnBound = false
const RESUME_MIN_SECONDS = 30
const RESUME_MAX_FRACTION = 0.95
const PROGRESS_WRITE_INTERVAL_MS = 5000

function setupPipButton(player) {
  const pipBtn = document.getElementById("movie-detail-pip")
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

const videoScaleController = createVideoScaleController(() => (vjs ? vjs.el() : null))

function resolveVideoScaleMode() {
  if (activePlaylistId && movie) {
    const override = getVideoScaleOverride(activePlaylistId, "vod", movie.id)
    if (override) return override
  }
  return getVideoScale()
}

function applyVideoScale() {
  videoScaleController.apply(resolveVideoScaleMode())
}

document.addEventListener(VIDEO_SCALE_EVENT, () => {
  if (movie) applyVideoScale()
})

document.addEventListener(CHANNEL_VIDEO_SCALE_CHANGED_EVENT, (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "vod") return
  if (!movie) return
  if (detail.itemId === null || detail.itemId === movie.id) applyVideoScale()
})

function setupScaleButton() {
  const scaleBtn = document.getElementById("movie-detail-scale")
  if (!scaleBtn) return
  scaleBtn.removeAttribute("hidden")
  if (scaleBtnBound) return
  scaleBtnBound = true
  scaleBtn.addEventListener("click", () => openDisplayModeDialog())
}

async function openDisplayModeDialog() {
  if (!movie) return
  const currentMode = resolveVideoScaleMode()
  const result = await openVideoScaleDialog({
    currentMode,
    applyAllLabelKey: "stream.scale.applyAllDefault",
    onPreview: (mode) => videoScaleController.apply(mode),
  })
  applyVideoScale()
  if (!result) return
  if (result.applyToAll) {
    if (activePlaylistId) clearAllVideoScaleOverrides(activePlaylistId, "vod")
    setVideoScale(result.mode)
    toast({
      title: t("stream.scale.toastDefault", { mode: t(videoScaleModeLabelKey(result.mode)) }),
      duration: 2200,
    })
  } else if (activePlaylistId) {
    setVideoScaleOverride(activePlaylistId, "vod", movie.id, result.mode)
  }
}

async function ensureEmbeddedPlayer(backend) {
  if (vjs) return vjs
  const videoEl = document.getElementById("movie-player")
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

async function startPlayback() {
  if (!movie) return

  // detailSrc may not be ready yet if the network fetch is in flight.
  let waited = 0
  while (!detailSrc && waited < 4000) {
    await new Promise((r) => setTimeout(r, 100))
    waited += 100
  }
  if (!detailSrc) {
    if (plotEl) plotEl.textContent = t("detail.error.noStream")
    return
  }

  // Probe the URL against the configured backup domains
  if (detailSrcBuilder) {
    const resolved = await resolveStreamUrl(detailSrcBuilder)
    if (resolved) detailSrc = resolved
  }

  if (activePlaylistId) {
    pushRecent(activePlaylistId, "vod", movie.id, movie.name, movie.logo || null)
  }

  if (await tryAndroidIntentPlayback(detailSrc)) return

  const localSrc = await getLocalPlayableSrc(detailSrc)
  const playSrc = localSrc || detailSrc
  const saved = activePlaylistId
    ? getProgress(activePlaylistId, "vod", movie.id)
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
      contentKey: `vod:${movie.id}`,
      kind: "vod",
      id: movie.id,
      url: playSrc,
      title: movie.name,
      posterUrl: movie.logo || "",
      startMs: Math.max(0, resumePos) * 1000,
      progressExtras: { title: movie.name, logo: movie.logo || null },
    })
    if (launched) return
  }

  const backend = getPlayerBackend()

  if (backend === "mpv" || backend === "vlc") {
    try {
      await launchExternalPlayback(backend, playSrc, resumePos)
      pushMoviePresence()
    } catch (err) {
      surfaceLaunchError(err, backend)
    }
    return
  }

  if (posterEl) posterEl.classList.add("hidden")
  if (playerWrap) playerWrap.classList.remove("hidden")
  const videoEl = document.getElementById("movie-player")
  videoEl?.removeAttribute("hidden")

  let player
  try {
    player = await ensureEmbeddedPlayer(backend)
  } catch (err) {
    log.error("[xt:movie-detail] failed to mount player:", err)
    toastError("Couldn't start playback.")
    if (posterEl) posterEl.classList.remove("hidden")
    if (playerWrap) playerWrap.classList.add("hidden")
    return
  }
  if (!player) return
  setupPipButton(player)
  setupScaleButton()
  const mime = chooseMime(detailSrc)
  player.one("error", () => {
    const e = player.error()
    log.error("[xt:movie-detail] player error", {
      code: e?.code,
      message: e?.message,
    })
  })

  if (resumePos > 0) {
    player.one("loadedmetadata", () => {
      const dur = player.duration?.() || saved?.duration || 0
      if (dur === 0 || resumePos / dur < RESUME_MAX_FRACTION) {
        try { player.currentTime?.(resumePos) } catch {}
      }
    })
  }

  player.src({ src: playSrc, type: mime })
  applyVideoScale()

  if (!progressListenersBound) {
    progressListenersBound = true
    let lastWriteAt = 0
    player.on("timeupdate", () => {
      if (!activePlaylistId || !movie) return
      const now = Date.now()
      if (now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return
      const pos = player.currentTime?.() || 0
      const dur = player.duration?.() || 0
      if (pos < 1) return
      lastWriteAt = now
      setProgress(activePlaylistId, "vod", movie.id, pos, dur, {
        name: movie.name,
        logo: movie.logo || null,
      })
    })
    player.on("ended", () => {
      if (!activePlaylistId || !movie) return
      const dur = player.duration?.() || 0
      markCompleted(activePlaylistId, "vod", movie.id, { duration: dur })
    })
  }

  const playResult = player.play?.()
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) =>
      log.warn("[xt:movie-detail] play() rejected:", err?.message || err)
    )
  }

  pushMoviePresence()
}

function pushMoviePresence() {
  if (!activePlaylistId || !movie) return
  setRichPresence({
    playlistId: activePlaylistId,
    details: movie.name || t("detail.discord.watchingMovie") || "Watching a movie",
    state: movie.year ? `Released ${movie.year}` : "Movie",
    largeImage: movie.logo || "logo",
    largeText: movie.name || "Extreme InfiniTV",
    smallImage: "movie",
    smallText: "Movie",
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

playBtn?.addEventListener("click", startPlayback)

restartBtn?.addEventListener("click", () => {
  if (!movie || !activePlaylistId) return
  clearProgress(activePlaylistId, "vod", movie.id)
  startPlayback()
})

const externalBtnHandle = setupExternalPlayerButton(
  /** @type {HTMLButtonElement|null} */ (document.getElementById("movie-detail-open-external")),
  {
    getSrc() {
      return detailSrc || null
    },
    getResumeSeconds() {
      if (!activePlaylistId || !movie) return 0
      const saved = getProgress(activePlaylistId, "vod", movie.id)
      if (!saved || saved.completed) return 0
      return saved.position > RESUME_MIN_SECONDS ? saved.position : 0
    },
    getTitle() {
      return movie?.name || null
    },
    beforeLaunch() {
      try { vjs?.pause?.() } catch {}
    },
    afterLaunch() {
      pushMoviePresence()
    },
  }
)

document.addEventListener("xt:progress-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (movie?.id !== detail.id) return
  syncResumeUI()
})

window.addEventListener("pagehide", () => {
  try {
    if (activePlaylistId && movie && vjs) {
      const pos = vjs.currentTime?.() || 0
      const dur = vjs.duration?.() || 0
      if (pos > 1) {
        setProgress(activePlaylistId, "vod", movie.id, pos, dur, {
          name: movie.name,
          logo: movie.logo || null,
        })
      }
    }
    vjs?.pause?.()
    vjs?.dispose?.()
  } catch {}
  clearAmbient(ambientEl)
  clearRichPresence().catch(() => {})
})

// ----------------------------
// Favorites
// ----------------------------
favBtn?.addEventListener("click", () => {
  if (!movie || !activePlaylistId) return
  toggleFavorite(activePlaylistId, "vod", movie.id, {
    name: movie.name || movie.title || "",
    logo: movie.logo || movie.cover || movie.stream_icon || null,
  })
})

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (movie?.id === detail.id) syncFavButton()
})

// ----------------------------
// Watchlist
// ----------------------------
watchBtn?.addEventListener("click", () => {
  if (!movie || !activePlaylistId) return
  toggleWatchlist(activePlaylistId, "vod", movie.id, {
    name: movie.name || movie.title || "",
    logo: movie.logo || movie.cover || movie.stream_icon || null,
  })
})

document.addEventListener("xt:watchlist-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (movie?.id === detail.id) syncWatchButton()
})

// ----------------------------
// Trailer
// ----------------------------
trailerBtn?.addEventListener("click", () => {
  if (!trailerUrl) return
  openExternal(trailerUrl)
})

// ----------------------------
// Downloads
// ----------------------------
function findMovieDownload() {
  if (!detailSrc) return null
  return listDownloads().find((d) => d.url === detailSrc) || null
}

function applyDownloadState() {
  if (!downloadBtn) return
  if (isDownloadable()) downloadBtn.removeAttribute("hidden")
  const d = findMovieDownload()
  downloadBtn.removeAttribute("disabled")
  if (!d) {
    if (downloadLabel) downloadLabel.textContent = t("detail.action.download")
    downloadBtn.title = isDownloadable()
      ? t("detail.download.tooltip")
      : t("detail.download.tooltipNoTauri")
    return
  }
  switch (d.status) {
    case "downloading": {
      const pct =
        d.bytesTotal > 0
          ? Math.floor((d.bytesDone / d.bytesTotal) * 100)
          : null
      if (downloadLabel) {
        downloadLabel.textContent = pct !== null ? `${pct}%` : "…"
      }
      downloadBtn.title = t("detail.download.tapPause")
      break
    }
    case "queued":
      if (downloadLabel) downloadLabel.textContent = t("detail.download.queued")
      downloadBtn.title = t("detail.download.waitingSlot")
      break
    case "paused":
      if (downloadLabel) downloadLabel.textContent = t("detail.download.resume")
      downloadBtn.title = t("detail.download.tapResume")
      break
    case "stalled":
      if (downloadLabel) downloadLabel.textContent = t("detail.download.retry")
      downloadBtn.title = t("detail.download.tapRetry")
      break
    case "error":
      if (downloadLabel) downloadLabel.textContent = t("detail.download.retry")
      downloadBtn.title = d.error || t("detail.download.failedRetry")
      break
    case "done":
      if (downloadLabel) downloadLabel.textContent = t("detail.download.saved")
      downloadBtn.setAttribute("disabled", "")
      downloadBtn.title = d.path ? t("detail.download.savedTo", { path: d.path }) : t("detail.download.saved")
      break
    default:
      if (downloadLabel) downloadLabel.textContent = t("detail.action.download")
      downloadBtn.title = ""
  }
}

document.addEventListener(DOWNLOADS_LIST_EVENT, applyDownloadState)
document.addEventListener(DOWNLOAD_PROGRESS_EVENT, applyDownloadState)

// The poster-grid right-click menu can deep-link here with ?download=1 to
// auto-kick the download flow
if (urlParams.get("download") === "1") {
  setTimeout(() => downloadBtn?.click(), 0)
}

downloadBtn?.addEventListener("click", async () => {
  if (!movie) return
  let waited = 0
  while (!detailSrc && waited < 4000) {
    await new Promise((r) => setTimeout(r, 100))
    waited += 100
  }
  if (!detailSrc) {
    if (downloadLabel) downloadLabel.textContent = t("detail.download.noUrl")
    return
  }
  if (!isDownloadable()) {
    window.open(detailSrc, "_blank", "noopener,noreferrer")
    if (downloadLabel) downloadLabel.textContent = t("detail.download.opened")
    return
  }
  const existing = findMovieDownload()
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
    resumeDownload(existing.id)
    return
  }
  try {
    if (downloadLabel) downloadLabel.textContent = t("detail.download.starting")
    downloadBtn.setAttribute("disabled", "")
    downloadBtn.title = ""
    await startDownload({
      url: detailSrc,
      title: movie.name || t("list.movieFallback", { id: movie.id }),
      ext: inferExt(detailSrc, "mp4"),
      source: {
        kind: "vod",
        playlistId: activePlaylistId,
        id: movie.id,
        logo: movie.logo || null,
      },
    })
  } catch (e) {
    const msg = String(e?.message || e || t("detail.download.failed"))
    log.error("Download failed:", e)
    if (downloadLabel) downloadLabel.textContent = t("detail.download.failed")
    downloadBtn.removeAttribute("disabled")
    downloadBtn.title = msg
  }
})

// ----------------------------
// Boot
// ----------------------------
function showError(msg) {
  if (titleEl) titleEl.textContent = t("detail.error.cantLoad")
  if (plotEl) plotEl.textContent = msg
  if (downloadBtn) downloadBtn.setAttribute("hidden", "")
  if (playBtn) playBtn.setAttribute("disabled", "")
}

async function boot() {
  await initI18n()
  if (!movieId) {
    showError(t("detail.error.noMovieId"))
    return
  }

  // A playlist switch re-boots: dispose any player from the previous playlist
  // so its stream stops and its progress listeners stop writing.
  try {
    vjs?.pause?.()
    await vjs?.dispose?.()
  } catch {}
  vjs = null
  progressListenersBound = false

  movie = null
  detailSrc = ""
  detailSrcBuilder = null
  if (metaEl) metaEl.textContent = ""
  if (plotEl) plotEl.textContent = t("detail.loading")

  const active = await getActiveEntry()
  if (!active) {
    showError(t("detail.error.noPlaylist"))
    return
  }
  activePlaylistId = active._id
  await ensurePrefsLoaded()
  creds = await loadCreds()

  // Hydrate the basics from the cached VOD list (poster, title, etc.).
  const list = getCached(active._id, "vod")
  movie = list?.data?.find((m) => Number(m.id) === movieId) || null

  const dl = listDownloads().find(
    (d) => d.source?.kind === "vod" && Number(d.source?.id) === movieId
  )

  if (!movie) {
    movie = {
      id: movieId,
      name: dl?.title || t("list.movieFallback", { id: movieId }),
      logo: dl?.source?.logo || null,
    }
  }

  if (titleEl) titleEl.textContent = movie.name || t("list.movieFallback", { id: movieId })
  paintPoster(movie.name, movie.logo || null)
  setAmbient(movie.logo || null)
  syncFavButton()
  syncWatchButton()
  syncResumeUI()

  if (dl?.url) {
    detailSrc = dl.url
    applyDownloadState()
    externalBtnHandle?.refresh()
  }

  // Per-item cache: paint immediately if available so offline opens work.
  const cached = getCached(active._id, `vod_info_${movieId}`)
  if (cached) applyVodInfo(cached.data)
  else if (plotEl) plotEl.textContent = t("detail.loading")

  // Early autoplay handoff for downloaded movies
  if (wantsAutoplay && dl?.url) {
    wantsAutoplay = false
    try {
      urlParams.delete("autoplay")
      const next = urlParams.toString()
      history.replaceState(
        null,
        "",
        location.pathname + (next ? `?${next}` : "")
      )
    } catch {}
    startPlayback()
  }

  // Refresh from network when reachable.
  if (creds.host && creds.user && creds.pass) {
    try {
      const r = await xtreamApiFetch("get_vod_info", { vod_id: String(movieId) })
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      setCached(active._id, `vod_info_${movieId}`, data, VOD_INFO_TTL_MS)
      applyVodInfo(data)
    } catch (e) {
      log.error("[xt:movie-detail] info fetch failed:", e)
      if (!cached && plotEl) {
        plotEl.textContent = dl
          ? t("detail.error.providerLocal")
          : t("detail.error.failedTryPlay")
      }
    }
  } else if (!cached && plotEl) {
    plotEl.textContent = dl
      ? t("detail.error.localAvailable")
      : t("detail.error.noPlaylist")
  }

  if (downloadBtn && isDownloadable()) downloadBtn.removeAttribute("hidden")
  applyDownloadState()
  if (wantsAutoplay) {
    wantsAutoplay = false
    try {
      urlParams.delete("autoplay")
      const next = urlParams.toString()
      history.replaceState(
        null,
        "",
        location.pathname + (next ? `?${next}` : "")
      )
    } catch {}
    startPlayback()
  } else {
    setTimeout(() => playBtn?.focus?.(), 0)
  }
}

document.addEventListener("xt:active-changed", () => boot())

boot()
