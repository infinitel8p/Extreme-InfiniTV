// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Movie detail page (route: /movies/detail?id=<vod_id>)
import { log } from "@/scripts/lib/log.js"
import {
  loadCreds,
  getActiveEntry,
  fmtBase,
  buildApiUrl,
} from "@/scripts/lib/creds.js"
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
import { fmtImdbRating } from "@/scripts/lib/format.js"
import { setRichPresence, clearRichPresence } from "@/scripts/lib/discord-rpc.js"
import { t, initI18n } from "@/scripts/lib/i18n.js"

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

function applyVodInfo(data) {
  const movieData = data?.movie_data || data?.info || data || {}
  const info = data?.info || data?.movie_data || {}

  // Poster: prefer the per-item API fields when the list-cache logo is
  // missing (e.g. user landed straight on this URL without /movies having
  // been loaded yet). cover_big / movie_image / cover are the standard
  // Xtream keys.
  const apiName = movieData.name || info.name || ""
  if (apiName && movie && (!movie.name || /^Movie \d+$/.test(movie.name))) {
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
  if (movieData.stream_url && /^https?:\/\//i.test(movieData.stream_url)) {
    src = movieData.stream_url
  } else if (movieData.stream_url) {
    const base = fmtBase(creds.host, creds.port).replace(/\/+$/, "")
    src = `${base}/${movieData.stream_url.replace(/^\/+/, "")}`
  } else if (creds.host && creds.user && creds.pass) {
    const rawExt =
      movieData.container_extension || info.container_extension || "mp4"
    const ext = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"
    src =
      fmtBase(creds.host, creds.port) +
      "/movie/" +
      encodeURIComponent(creds.user) +
      "/" +
      encodeURIComponent(creds.pass) +
      "/" +
      encodeURIComponent(movieId) +
      "." +
      ext
  }

  detailSrc = src
  applyDownloadState()

  const year = movieData.releasedate || movieData.year || info.year || ""
  const duration =
    movieData.duration || info.duration || movieData.duration_secs || ""
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
    if (year) bits.push(`<span>${String(year)}</span>`)
    const humanDur = fmtDuration(duration)
    if (humanDur) bits.push(`<span>${humanDur}</span>`)
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
const RESUME_MIN_SECONDS = 30
const RESUME_MAX_FRACTION = 0.95
const PROGRESS_WRITE_INTERVAL_MS = 5000

async function ensurePlayer() {
  if (vjs) return vjs
  const [{ default: videojs }] = await Promise.all([
    import("video.js"),
    import("video.js/dist/video-js.css"),
  ])
  const hasNativePipBridge = !!window.AndroidPip
  vjs = videojs("movie-player", {
    liveui: false,
    fluid: true,
    preload: "auto",
    autoplay: false,
    aspectRatio: "16:9",
    controlBar: {
      volumePanel: { inline: false },
      pictureInPictureToggle: !hasNativePipBridge,
      playbackRateMenuButton: true,
      subsCapsButton: true,
      audioTrackButton: true,
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

  if (activePlaylistId) {
    pushRecent(activePlaylistId, "vod", movie.id, movie.name, movie.logo || null)
  }

  if (await tryAndroidIntentPlayback(detailSrc)) return

  if (posterEl) posterEl.classList.add("hidden")
  if (playerWrap) playerWrap.classList.remove("hidden")
  const videoEl = document.getElementById("movie-player")
  videoEl?.removeAttribute("hidden")

  const player = await ensurePlayer()
  const localSrc = await getLocalPlayableSrc(detailSrc)
  const playSrc = localSrc || detailSrc
  const mime = chooseMime(detailSrc)
  player.one("error", () => {
    const e = player.error()
    log.error("[xt:movie-detail] video.js error", {
      code: e?.code,
      message: e?.message,
      src: playSrc,
    })
  })

  const saved = activePlaylistId
    ? getProgress(activePlaylistId, "vod", movie.id)
    : null
  if (saved && !saved.completed && saved.position > RESUME_MIN_SECONDS) {
    player.one("loadedmetadata", () => {
      const dur = player.duration() || saved.duration || 0
      const pos = saved.position
      if (dur === 0 || pos / dur < RESUME_MAX_FRACTION) {
        try { player.currentTime(pos) } catch {}
      }
    })
  }

  player.src({ src: playSrc, type: mime })

  if (!progressListenersBound) {
    progressListenersBound = true
    let lastWriteAt = 0
    player.on("timeupdate", () => {
      if (!activePlaylistId || !movie) return
      const now = Date.now()
      if (now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return
      const pos = player.currentTime() || 0
      const dur = player.duration() || 0
      if (pos < 1) return
      lastWriteAt = now
      setProgress(activePlaylistId, "vod", movie.id, pos, dur, {
        name: movie.name,
        logo: movie.logo || null,
      })
    })
    player.on("ended", () => {
      if (!activePlaylistId || !movie) return
      const dur = player.duration() || 0
      markCompleted(activePlaylistId, "vod", movie.id, { duration: dur })
    })
  }

  player.play().catch((err) =>
    log.warn("[xt:movie-detail] play() rejected:", err?.message || err)
  )

  if (activePlaylistId && movie) {
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
}

playBtn?.addEventListener("click", startPlayback)

restartBtn?.addEventListener("click", () => {
  if (!movie || !activePlaylistId) return
  clearProgress(activePlaylistId, "vod", movie.id)
  startPlayback()
})

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

  movie = null
  detailSrc = ""
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
  }

  // Per-item cache: paint immediately if available so offline opens work.
  const cached = getCached(active._id, `vod_info_${movieId}`)
  if (cached) applyVodInfo(cached.data)
  else if (plotEl) plotEl.textContent = t("detail.loading")

  // Refresh from network when reachable.
  if (creds.host && creds.user && creds.pass) {
    try {
      const r = await providerFetch(
        buildApiUrl(creds, "get_vod_info", { vod_id: String(movieId) })
      )
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
