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
  pushRecent,
} from "@/scripts/lib/preferences.js"
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
      currentSeason = key
      renderSeasonTabs(seasonKeys)
      renderEpisodes()
    })
    seasonTabs.appendChild(btn)
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

    const playBtn = document.createElement("button")
    playBtn.type = "button"
    playBtn.className =
      "flex flex-1 min-w-0 items-center gap-3 text-left outline-none rounded-lg " +
      "focus-visible:ring-2 focus-visible:ring-accent"
    playBtn.addEventListener("click", () => playEpisode(ep))

    const num = document.createElement("div")
    num.className =
      "shrink-0 size-10 rounded-md bg-surface-3 flex items-center justify-center text-sm font-semibold tabular-nums text-fg-2"
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

    const arrow = document.createElement("span")
    arrow.className = "shrink-0 text-fg-3 text-base"
    arrow.textContent = "▶"
    playBtn.appendChild(arrow)

    row.appendChild(playBtn)

    if (isDownloadable()) {
      const epUrl = buildEpisodeStreamUrl(ep)
      if (epUrl) {
        const dlBtn = document.createElement("button")
        dlBtn.type = "button"
        dlBtn.className =
          "shrink-0 rounded-lg border border-line min-h-11 px-3 text-xs text-fg-2 tabular-nums " +
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
    if (year) bits.push(String(year))
    if (genre) bits.push(genre)
    if (rating) bits.push(`Rating: ${String(rating).slice(0, 4)}`)
    if (seasons.length) bits.push(`${seasons.length} season${seasons.length > 1 ? "s" : ""}`)
    metaEl.textContent = bits.join(" • ")
  }
  if (plotEl) {
    plotEl.textContent = plot || (cast ? `Cast: ${cast}` : "No description available.")
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
  player.src({ src: playSrc, type: mime })
  player.play().catch((err) =>
    console.warn("[xt:series-detail] play() rejected:", err?.message || err)
  )
}

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
  if (!series || !activePlaylistId) return
  toggleFavorite(activePlaylistId, "series", series.id)
})

document.addEventListener("xt:favorites-changed", (e) => {
  const detail = e.detail
  if (!detail || detail.playlistId !== activePlaylistId) return
  if (detail.kind !== "series") return
  if (series?.id === detail.id) syncFavButton()
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
