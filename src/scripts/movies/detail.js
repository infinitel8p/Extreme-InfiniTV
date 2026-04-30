// Movie detail page (route: /movies/detail?id=<vod_id>).
// Entirely cache-driven on first paint so it works offline once the user
// has opened the same movie at least once before.
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
  pushRecent,
} from "@/scripts/lib/preferences.js"
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
import { clearAmbient } from "@/scripts/lib/morph-detail.js"
import { attachPlayerFocusKeeper } from "@/scripts/lib/player-focus-keeper.js"

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
const favBtn = document.getElementById("movie-detail-fav")
const downloadBtn = document.getElementById("movie-detail-download")
const downloadLabel = document.getElementById("movie-detail-download-label")

// ----------------------------
// State
// ----------------------------
const urlParams = new URLSearchParams(location.search)
const movieId = Number(urlParams.get("id") || "0")
const wantsAutoplay = urlParams.get("autoplay") === "1"
let activePlaylistId = ""
let creds = { host: "", port: "", user: "", pass: "" }
let movie = null
let detailSrc = ""

function setAmbient(url) {
  if (!ambientEl) return
  if (url) {
    const safe = String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    ambientEl.style.backgroundImage = `url("${safe}")`
    ambientEl.setAttribute("data-ready", "true")
  } else {
    ambientEl.removeAttribute("data-ready")
    ambientEl.style.backgroundImage = ""
  }
}

function makeFallback(name) {
  const fb = document.createElement("div")
  fb.className =
    "h-full w-full flex items-center justify-center text-center px-3 " +
    "text-fg-3 text-xs tracking-wide bg-gradient-to-br from-surface-2 to-surface-3"
  fb.textContent = name || "No poster"
  return fb
}

function paintPoster(name, logo) {
  if (!posterEl) return
  posterEl.replaceChildren()
  if (logo) {
    const img = document.createElement("img")
    img.src = logo
    img.alt = ""
    img.loading = "eager"
    img.decoding = "async"
    img.fetchPriority = "high"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-cover"
    img.onerror = () => {
      img.remove()
      posterEl.appendChild(makeFallback(name))
    }
    posterEl.appendChild(img)
  } else {
    posterEl.appendChild(makeFallback(name))
  }
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

function chooseMime(url) {
  if (!url) return "video/mp4"
  const lower = url.split("?")[0].toLowerCase()
  if (lower.endsWith(".m3u8")) return "application/x-mpegURL"
  if (lower.endsWith(".mpd")) return "application/dash+xml"
  if (lower.endsWith(".webm")) return "video/webm"
  if (lower.endsWith(".mkv")) return "video/x-matroska"
  if (lower.endsWith(".ts")) return "video/MP2T"
  if (lower.endsWith(".avi")) return "video/x-msvideo"
  return "video/mp4"
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
    if (year) bits.push(String(year))
    const humanDur = fmtDuration(duration)
    if (humanDur) bits.push(humanDur)
    if (genre) bits.push(genre)
    if (rating) bits.push(`Rating: ${String(rating).slice(0, 4)}`)
    metaEl.textContent = bits.join(" • ")
  }
  if (plotEl) plotEl.textContent = plot || "No description available."
}

function syncFavButton() {
  if (!favBtn || !movie || !activePlaylistId) return
  const fav = isFavorite(activePlaylistId, "vod", movie.id)
  favBtn.textContent = fav ? "Remove from favorites" : "Add to favorites"
  favBtn.classList.toggle("text-accent", fav)
  favBtn.setAttribute("aria-pressed", String(fav))
}

// ----------------------------
// Playback
// ----------------------------
let vjs = null
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
    if (plotEl) plotEl.textContent = "Couldn't get a stream URL for this movie."
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
    console.error("[xt:movie-detail] video.js error", {
      code: e?.code,
      message: e?.message,
      src: playSrc,
    })
  })
  player.src({ src: playSrc, type: mime })
  player.play().catch((err) =>
    console.warn("[xt:movie-detail] play() rejected:", err?.message || err)
  )
}

playBtn?.addEventListener("click", startPlayback)

window.addEventListener("pagehide", () => {
  try {
    vjs?.pause?.()
    vjs?.dispose?.()
  } catch {}
  clearAmbient(ambientEl)
})

// ----------------------------
// Favorites
// ----------------------------
favBtn?.addEventListener("click", () => {
  if (!movie || !activePlaylistId) return
  toggleFavorite(activePlaylistId, "vod", movie.id)
})

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "vod") return
  if (movie?.id === detail.id) syncFavButton()
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
    if (downloadLabel) downloadLabel.textContent = "Download"
    downloadBtn.title = isDownloadable()
      ? "Download to your chosen folder"
      : "Open the source URL in a new tab (desktop app saves to disk)"
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
      downloadBtn.title = "Tap to pause"
      break
    }
    case "queued":
      if (downloadLabel) downloadLabel.textContent = "Queued"
      downloadBtn.title = "Waiting for a slot - tap to cancel"
      break
    case "paused":
      if (downloadLabel) downloadLabel.textContent = "Resume"
      downloadBtn.title = "Paused - tap to resume"
      break
    case "stalled":
      if (downloadLabel) downloadLabel.textContent = "Retry"
      downloadBtn.title = "Stalled - tap to retry"
      break
    case "error":
      if (downloadLabel) downloadLabel.textContent = "Retry"
      downloadBtn.title = d.error || "Failed - tap to retry"
      break
    case "done":
      if (downloadLabel) downloadLabel.textContent = "Saved"
      downloadBtn.setAttribute("disabled", "")
      downloadBtn.title = d.path ? `Saved to ${d.path}` : "Saved"
      break
    default:
      if (downloadLabel) downloadLabel.textContent = "Download"
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
    if (downloadLabel) downloadLabel.textContent = "No URL"
    return
  }
  if (!isDownloadable()) {
    window.open(detailSrc, "_blank", "noopener,noreferrer")
    if (downloadLabel) downloadLabel.textContent = "Opened"
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
    if (downloadLabel) downloadLabel.textContent = "Starting…"
    downloadBtn.setAttribute("disabled", "")
    downloadBtn.title = ""
    await startDownload({
      url: detailSrc,
      title: movie.name || `Movie ${movie.id}`,
      ext: inferExt(detailSrc, "mp4"),
      source: {
        kind: "vod",
        playlistId: activePlaylistId,
        id: movie.id,
        logo: movie.logo || null,
      },
    })
  } catch (e) {
    const msg = String(e?.message || e || "Failed")
    console.error("Download failed:", e)
    if (downloadLabel) downloadLabel.textContent = "Failed"
    downloadBtn.removeAttribute("disabled")
    downloadBtn.title = msg
  }
})

// ----------------------------
// Boot
// ----------------------------
function showError(msg) {
  if (titleEl) titleEl.textContent = "Couldn't load this movie"
  if (plotEl) plotEl.textContent = msg
  if (downloadBtn) downloadBtn.setAttribute("hidden", "")
  if (playBtn) playBtn.setAttribute("disabled", "")
}

async function boot() {
  if (!movieId) {
    showError("No movie ID was given.")
    return
  }
  const active = await getActiveEntry()
  if (!active) {
    showError("No playlist is selected. Add one in Settings.")
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
      name: dl?.title || `Movie ${movieId}`,
      logo: dl?.source?.logo || null,
    }
  }

  if (titleEl) titleEl.textContent = movie.name || `Movie ${movieId}`
  paintPoster(movie.name, movie.logo || null)
  setAmbient(movie.logo || null)
  syncFavButton()

  if (dl?.url) {
    detailSrc = dl.url
    applyDownloadState()
  }

  // Per-item cache: paint immediately if available so offline opens work.
  const cached = getCached(active._id, `vod_info_${movieId}`)
  if (cached) applyVodInfo(cached.data)
  else if (plotEl) plotEl.textContent = "Loading details…"

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
      console.error("[xt:movie-detail] info fetch failed:", e)
      if (!cached && plotEl) {
        plotEl.textContent = dl
          ? "Couldn't reach the provider. Local copy is available - tap Play."
          : "Failed to load movie info. Try Play anyway."
      }
    }
  } else if (!cached && plotEl) {
    plotEl.textContent = dl
      ? "Local copy is available - tap Play."
      : "Movie details require an Xtream playlist. Switch playlists from the sidebar."
  }

  if (downloadBtn && isDownloadable()) downloadBtn.removeAttribute("hidden")
  applyDownloadState()
  if (wantsAutoplay) {
    // Strip the flag so a refresh doesn't re-trigger and the back-forward
    // cache doesn't replay it.
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
