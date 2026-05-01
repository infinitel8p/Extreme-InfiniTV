// Series detail page (route: /series/detail?id=<series_id>).
// Cache-driven on first paint so it works offline once a series has been
// opened at least once before.
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
  isCompleted,
  clearProgress,
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

const SERIES_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ----------------------------
// Refs
// ----------------------------
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
let trailerUrl = ""
const seasonTabs = document.getElementById("series-season-tabs")
const episodeList = document.getElementById("series-episode-list")

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
let episodesByKey = null
let currentSeason = ""
let currentPlayingEpisodeId = null

const setAmbient = (url) => setAmbientOn(ambientEl, url)
const paintPoster = (name, logo) => paintPosterOn(posterEl, name, logo)

function buildEpisodeStreamUrl(ep) {
  if (ep?._directUrl) return ep._directUrl
  if (!creds.host || !creds.user || !creds.pass) return ""
  const rawExt = ep.container_extension || "mp4"
  const ext = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"
  return (
    fmtBase(creds.host, creds.port) +
    "/series/" +
    encodeURIComponent(creds.user) +
    "/" +
    encodeURIComponent(creds.pass) +
    "/" +
    encodeURIComponent(ep.id) +
    "." +
    ext
  )
}

function syncFavButton() {
  if (!favBtn || !series || !activePlaylistId) return
  const fav = isFavorite(activePlaylistId, "series", series.id)
  favBtn.textContent = fav ? "Remove from favorites" : "Add to favorites"
  favBtn.classList.toggle("text-accent", fav)
  favBtn.setAttribute("aria-pressed", String(fav))
}

function syncWatchButton() {
  if (!watchBtn || !series || !activePlaylistId) return
  const onWatchlist = isOnWatchlist(activePlaylistId, "series", series.id)
  if (watchLabelEl) {
    watchLabelEl.textContent = onWatchlist ? "On your watchlist" : "Watch later"
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

// ----------------------------
// Episode list rendering
// ----------------------------
function findDownloadByUrl(url) {
  return listDownloads().find((d) => d.url === url) || null
}

function downloadButtonState(d) {
  if (!d) return { label: "Download", disabled: false, title: "Save this episode to your downloads folder" }
  switch (d.status) {
    case "downloading": {
      const pct = d.bytesTotal > 0 ? Math.floor((d.bytesDone / d.bytesTotal) * 100) : null
      return { label: pct !== null ? `${pct}%` : "…", disabled: false, title: "Tap to pause" }
    }
    case "queued":    return { label: "Queued", disabled: false, title: "Waiting for a slot - tap to cancel" }
    case "done":      return { label: "Saved", disabled: true, title: d.path ? `Saved to ${d.path}` : "Saved" }
    case "paused":    return { label: "Resume", disabled: false, title: "Paused - tap to resume" }
    case "stalled":   return { label: "Retry", disabled: false, title: "Stalled - tap to retry" }
    case "error":     return { label: "Retry", disabled: false, title: d.error || "Failed - tap to retry" }
    case "cancelled": return { label: "Download", disabled: false, title: "Re-download" }
    default:          return { label: "Download", disabled: false }
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
  for (const key of seasonKeys) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.dataset.season = key
    btn.className =
      "rounded-lg px-3 py-1.5 text-sm border outline-none transition-colors " +
      (key === currentSeason
        ? "border-accent bg-accent-soft text-fg"
        : "border-line text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg")
    btn.textContent = `Season ${key}`
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

function renderEpisodes() {
  if (!episodeList) return
  episodeList.replaceChildren()
  const eps = episodesByKey?.[currentSeason] || []
  if (!eps.length) {
    const empty = document.createElement("div")
    empty.className = "text-fg-3 text-sm py-3"
    empty.textContent = "No episodes in this season."
    episodeList.appendChild(empty)
    return
  }
  for (const ep of eps) {
    const row = document.createElement("div")
    row.className =
      "episode-row flex items-center gap-3 p-3 rounded-xl bg-surface-2/40 " +
      "transition-colors hover:bg-surface-2 focus-within:bg-surface-2"
    row.dataset.epId = String(ep.id)
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
      "focus-visible:ring-2 focus-visible:ring-accent"
    playBtn.addEventListener("click", () => playEpisode(ep))

    const num = document.createElement("div")
    num.className =
      "episode-num shrink-0 size-10 rounded-md bg-surface-3 flex items-center justify-center text-sm font-semibold tabular-nums text-fg-2"
    num.textContent = `E${ep.episode_num || "?"}`
    playBtn.appendChild(num)

    const wrap = document.createElement("div")
    wrap.className = "min-w-0 flex-1"
    const title = document.createElement("div")
    title.className = "truncate text-sm font-medium text-fg"
    title.textContent = ep.title || `Episode ${ep.episode_num || ""}`
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
      restartBtn.title = "Start from beginning"
      restartBtn.setAttribute(
        "aria-label",
        `Start ${ep.title || `episode ${ep.episode_num || ""}`} from the beginning`
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
            if (dlLabel) dlLabel.textContent = "Resuming…"
            resumeDownload(existing.id)
            return
          }
          try {
            dlBtn.setAttribute("disabled", "")
            if (dlLabel) dlLabel.textContent = "Starting…"
            const epTitle =
              (series?.name ? `${series.name} - ` : "") +
              `S${currentSeason || "?"}E${ep.episode_num || "?"}` +
              (ep.title ? ` - ${ep.title}` : "")
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
            })
          } catch (err) {
            console.error("Episode download failed:", err)
            dlBtn.removeAttribute("disabled")
            if (dlLabel) dlLabel.textContent = "Failed"
            dlBtn.title = String(err?.message || err)
          }
        })
        row.appendChild(dlBtn)
      }
    }

    episodeList.appendChild(row)
  }
  try { window.SpatialNavigation?.makeFocusable?.() } catch {}
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

function applySeriesInfo(data) {
  const info = data?.info || {}
  const seasons = Array.isArray(data?.seasons) ? data.seasons : []

  // Poster: prefer the per-item API fields when the list-cache logo is
  // missing. info.cover is the standard Xtream key for series art.
  const apiName = info.name || info.title || ""
  if (apiName && series && (!series.name || /^Series \d+$/.test(series.name))) {
    series.name = apiName
    if (titleEl) titleEl.textContent = apiName
  }

  const apiLogo =
    info.cover ||
    info.cover_big ||
    info.movie_image ||
    info.backdrop_path?.[0] ||
    null
  if (apiLogo && (!series || !series.logo)) {
    if (series) series.logo = apiLogo
    paintPoster(series?.name, apiLogo)
    setAmbient(apiLogo)
  }
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

  if (metaEl) {
    const bits = []
    if (year) bits.push(`<span>${escapeRatingText(String(year))}</span>`)
    if (genre) bits.push(`<span>${escapeRatingText(genre)}</span>`)
    const ratingText = fmtImdbRating(rating)
    if (ratingText) {
      bits.push(
        '<span class="inline-flex items-center gap-1 text-fg-2" aria-label="IMDB rating ' +
          ratingText +
          ' out of 10">' +
          '<svg viewBox="0 0 24 24" width="0.95em" height="0.95em" fill="currentColor" aria-hidden="true" class="text-accent">' +
          '<path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/>' +
          "</svg>" +
          `<span class="font-medium tabular-nums">${ratingText}</span>` +
          '<span class="text-fg-3">/10</span>' +
          "</span>"
      )
    }
    if (seasons.length) {
      bits.push(
        `<span>${seasons.length} season${seasons.length > 1 ? "s" : ""}</span>`
      )
    }
    metaEl.innerHTML = bits.join(' <span aria-hidden="true">·</span> ')
  }
  if (plotEl) {
    plotEl.textContent = plot || (cast ? `Cast: ${cast}` : "No description available.")
  }

  trailerUrl = youtubeUrlFromTrailer(info.youtube_trailer || "")
  if (trailerBtn) {
    if (trailerUrl) trailerBtn.removeAttribute("hidden")
    else trailerBtn.setAttribute("hidden", "")
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

// ----------------------------
// Playback
// ----------------------------
let vjs = null
let progressListenersBound = false
let currentEpisode = null
const RESUME_MIN_SECONDS = 30
const RESUME_MAX_FRACTION = 0.95
const PROGRESS_WRITE_INTERVAL_MS = 5000

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

async function ensurePlayer() {
  if (vjs) return vjs
  const [{ default: videojs }] = await Promise.all([
    import("video.js"),
    import("video.js/dist/video-js.css"),
  ])
  const hasNativePipBridge = !!window.AndroidPip
  vjs = videojs("series-player", {
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

async function playEpisode(episode) {
  if (!series || !episode) return
  const src = buildEpisodeStreamUrl(episode)
  if (!src) return
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

  if (nowPlayingEl) {
    nowPlayingEl.textContent =
      `S${episode.season || currentSeason}E${episode.episode_num || "?"} · ${episode.title || ""}`
  }

  if (posterEl) posterEl.classList.add("hidden")
  if (playerWrap) playerWrap.classList.remove("hidden")
  const videoEl = document.getElementById("series-player")
  videoEl?.removeAttribute("hidden")

  const player = await ensurePlayer()
  const localSrc = await getLocalPlayableSrc(src)
  const playSrc = localSrc || src
  const mime = chooseMime(src)
  player.one("error", () => {
    const e = player.error()
    console.error("[xt:series-detail] video.js error", {
      code: e?.code,
      message: e?.message,
      src: playSrc,
    })
  })

  currentEpisode = episode

  const saved = activePlaylistId
    ? getProgress(activePlaylistId, "episode", episode.id)
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
      if (!activePlaylistId || !currentEpisode) return
      const now = Date.now()
      if (now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return
      const pos = player.currentTime() || 0
      const dur = player.duration() || 0
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
      if (!activePlaylistId || !currentEpisode) return
      const dur = player.duration() || 0
      markCompleted(activePlaylistId, "episode", currentEpisode.id, {
        duration: dur,
        ...progressExtrasFor(currentEpisode),
      })
      const nextEp = findNextEpisode(currentEpisode)
      if (nextEp) showUpNextOverlay(nextEp)
    })
  }

  player.play().catch((err) =>
    console.warn("[xt:series-detail] play() rejected:", err?.message || err)
  )

  if (activePlaylistId && series) {
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
}

window.addEventListener("pagehide", () => {
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
  } catch {}
  clearAmbient(ambientEl)
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
  const epTitle = next.episode.title || `Episode ${epNum}`

  upNextEl = document.createElement("div")
  upNextEl.className =
    "up-next-card absolute right-3 bottom-3 z-30 max-w-sm w-[min(22rem,calc(100%-1.5rem))] " +
    "rounded-2xl border border-line bg-surface/95 backdrop-blur-md shadow-2xl " +
    "p-4 flex flex-col gap-3 ring-1 ring-accent/30"
  upNextEl.setAttribute("role", "dialog")
  upNextEl.setAttribute("aria-live", "polite")
  upNextEl.setAttribute("aria-label", "Up next")

  const eyebrow = document.createElement("div")
  eyebrow.className =
    "text-eyebrow font-semibold uppercase text-accent tracking-widest"
  eyebrow.textContent = "Up next"
  upNextEl.appendChild(eyebrow)

  const titleRow = document.createElement("div")
  titleRow.className = "flex flex-col gap-0.5 min-w-0"
  const seasonEl = document.createElement("div")
  seasonEl.className = "text-2xs text-fg-3 tabular-nums"
  seasonEl.textContent = seasonLabel
    ? `S${seasonLabel} · E${epNum}`
    : `Episode ${epNum}`
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
  skipBtn.textContent = "Cancel"
  skipBtn.addEventListener("click", () => dismissUpNext())
  const playNowBtn = document.createElement("button")
  playNowBtn.type = "button"
  playNowBtn.className =
    "rounded-lg bg-accent text-bg px-3 min-h-9 text-xs font-semibold " +
    "hover:brightness-110 focus-visible:brightness-110 outline-none transition-[filter,transform] " +
    "active:scale-[0.97]"
  playNowBtn.textContent = "Play now"
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
    countdownEl.textContent = `Playing in ${remaining}s`
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
  toggleFavorite(activePlaylistId, "series", series.id, {
    name: series.name || series.title || "",
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
  toggleWatchlist(activePlaylistId, "series", series.id, {
    name: series.name || series.title || "",
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
function showError(msg) {
  if (titleEl) titleEl.textContent = "Couldn't load this series"
  if (plotEl) plotEl.textContent = msg
}

async function boot() {
  if (!seriesId) {
    showError("No series ID was given.")
    return
  }

  series = null
  episodesByKey = null
  if (metaEl) metaEl.textContent = ""
  if (plotEl) plotEl.textContent = "Loading details…"
  if (seasonTabs) seasonTabs.replaceChildren()
  if (episodeList) episodeList.replaceChildren()

  const active = await getActiveEntry()
  if (!active) {
    showError("No playlist is selected. Add one in Settings.")
    return
  }
  activePlaylistId = active._id
  await ensurePrefsLoaded()
  creds = await loadCreds()

  const list = getCached(active._id, "series")
  series = list?.data?.find((s) => Number(s.id) === seriesId) || null

  const seriesDownloads = listDownloads().filter(
    (d) =>
      d.source?.kind === "episode" &&
      Number(d.source?.seriesId) === seriesId
  )

  if (!series) {
    const sample = seriesDownloads[0]
    series = {
      id: seriesId,
      name: sample?.source?.seriesName || `Series ${seriesId}`,
      logo: sample?.source?.logo || null,
    }
  }

  if (titleEl) titleEl.textContent = series.name || `Series ${seriesId}`
  paintPoster(series.name, series.logo || null)
  setAmbient(series.logo || null)
  syncFavButton()
  syncWatchButton()

  const cached = getCached(active._id, `series_info_${seriesId}`)
  if (cached) applySeriesInfo(cached.data)
  else if (plotEl) plotEl.textContent = "Loading details…"

  let infoOk = !!cached
  if (creds.host && creds.user && creds.pass) {
    try {
      const r = await providerFetch(
        buildApiUrl(creds, "get_series_info", {
          series_id: String(seriesId),
          series: String(seriesId),
        })
      )
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      setCached(active._id, `series_info_${seriesId}`, data, SERIES_INFO_TTL_MS)
      applySeriesInfo(data)
      infoOk = true
    } catch (e) {
      console.error("[xt:series-detail] info fetch failed:", e)
      if (!cached) {
        if (plotEl) {
          plotEl.textContent = seriesDownloads.length
            ? "Couldn't reach the provider. Downloaded episodes are still playable."
            : "Failed to load series details."
        }
        if (episodeList) {
          episodeList.replaceChildren()
          const fail = document.createElement("div")
          fail.className = "text-fg-3 text-sm py-3"
          fail.textContent = seriesDownloads.length
            ? "Episode list unavailable offline."
            : "Couldn't load episodes."
          episodeList.appendChild(fail)
        }
      }
    }
  } else if (!cached && plotEl) {
    plotEl.textContent = seriesDownloads.length
      ? "Downloaded episodes are still playable."
      : "Series details require an Xtream playlist. Switch playlists from the sidebar."
  }

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
