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
import { ensureVod } from "@/scripts/lib/catalog.js"
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
import { resolveTmdbId, fetchMovieEnrichment, peekEarlyDetailData } from "@/scripts/lib/tmdb-enrich.ts"
import { matchRecommendationsToCatalog, extractLangPrefix } from "@/scripts/lib/tmdb-match.ts"
import { pickLocalSimilar, parseProviderPeople } from "@/scripts/lib/similar-local.ts"
import { tmdbImageUrl, TMDB_PROFILE_SIZE } from "@/scripts/lib/tmdb.ts"
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
import { attachPlayerInsights } from "@/scripts/lib/player-stats.ts"

const VOD_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ----------------------------
// Refs
// ----------------------------
const backLink = document.getElementById("movie-detail-back")
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
const taglineEl = document.getElementById("movie-detail-tagline")
const directorEl = document.getElementById("movie-detail-director")
const castSection = document.getElementById("movie-detail-cast")
const castListEl = document.getElementById("movie-detail-cast-list")
const similarSection = document.getElementById("movie-detail-similar")
const similarListEl = document.getElementById("movie-detail-similar-list")
if (castListEl) dragScroll(castListEl)
if (similarListEl) dragScroll(similarListEl)
let trailerUrl = ""

// Real back() instead of a push navigation, so bfcache and the grid's own
// back-navigation restore both work. Falls through to the plain href for
// deep links or when the referrer isn't the movies grid.
backLink?.addEventListener("click", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  if (history.length <= 1) return
  let referrerUrl
  try {
    referrerUrl = new URL(document.referrer)
  } catch {
    return
  }
  if (referrerUrl.origin !== location.origin || referrerUrl.pathname !== "/movies") return
  event.preventDefault()
  history.back()
})

// ----------------------------
// State
// ----------------------------
const urlParams = new URLSearchParams(location.search)
const movieId = Number(urlParams.get("id") || "0")
let wantsAutoplay = urlParams.get("autoplay") === "1"
let activePlaylistId = ""
let creds = { host: "", port: "", user: "", pass: "" }
let movie = null
let vodInfoRaw = null
let detailSrc = ""
let detailSrcBuilder = null
let metaYearText = ""
let metaDurationText = ""
let metaGenreText = ""
let metaRatingText = ""
let externalPresenceActive = false
let enrichRequestId = 0
let vodCatalogPromise = null
let heroPosterUrl = null
let heroBackdropUrl = null
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
    name: movie?.name || "",
    posterUrl: heroPosterUrl,
    backdropUrls: [heroBackdropUrl],
  })
}

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

// Providers sometimes send a full release date instead of a bare year; show year-only.
function extractDisplayYear(value) {
  const raw = String(value).trim()
  const match = raw.match(/(19|20)\d{2}/)
  return match ? match[0] : raw
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

// The remuxed TS pipe has no intrinsic duration; get_vod_info's duration_secs is the source of
// truth, with movieData.duration / info.duration ("HH:MM:SS") as fallback.
function knownVodDurationSeconds() {
  const data = vodInfoRaw
  const movieData = data?.movie_data || data?.info || data || {}
  const info = data?.info || data?.movie_data || {}
  const durationSecs = Number(movieData.duration_secs || info.duration_secs || 0)
  if (durationSecs > 0) return durationSecs
  return parseHmsToSeconds(movieData.duration || info.duration)
}

function applyVodInfo(data) {
  vodInfoRaw = data
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
    heroPosterUrl = apiLogo
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

  metaYearText = year ? extractDisplayYear(year) : ""
  metaDurationText = fmtDuration(duration)
  metaGenreText = genre || ""
  metaRatingText = fmtImdbRating(rating)
  renderMetaLine()
  if (plotEl) plotEl.textContent = plot || t("detail.noDescription")

  trailerUrl = youtubeUrlFromTrailer(
    movieData.youtube_trailer || info.youtube_trailer || ""
  )
  if (trailerBtn) {
    if (trailerUrl) trailerBtn.removeAttribute("hidden")
    else trailerBtn.setAttribute("hidden", "")
  }

  if (!isTmdbActive()) {
    renderProviderPeopleChips(providerPeopleNames(parseProviderPeople(providerInfoForVod(data))))
  }
}

function buildMovieNfoMeta() {
  const data = vodInfoRaw
  const movieData = data?.movie_data || data?.info || data || {}
  const info = data?.info || data?.movie_data || {}
  const releaseDate = movieData.releasedate || movieData.year || info.year || movie?.year || ""
  const durationSecs = Number(movieData.duration_secs || info.duration_secs || 0)
  const poster =
    info.cover_big || info.movie_image || info.cover || movieData.cover || movieData.stream_icon || movie?.logo || ""
  return {
    type: "movie",
    title: movie?.name || "",
    year: releaseDate,
    premiered: /^\d{4}-\d{2}-\d{2}/.test(String(releaseDate)) ? String(releaseDate).slice(0, 10) : undefined,
    plot: movieData.plot || movieData.description || info.plot || info.description || movie?.plot || "",
    genre: movieData.genre || info.genre || "",
    rating: movieData.rating || info.rating || movieData.rating_5based || movie?.rating || "",
    runtimeMinutes: durationSecs > 0 ? Math.round(durationSecs / 60) : 0,
    poster,
  }
}

function escapeText(text) {
  const div = document.createElement("div")
  div.textContent = String(text)
  return div.innerHTML
}

// Genre/rating repeat in the facts column at lg+, so the compact strip hides its own copies there.
function renderMetaLine() {
  if (!metaEl) return
  const bits = []
  if (metaYearText) bits.push(`<span class="meta-item">${escapeText(metaYearText)}</span>`)
  if (metaDurationText) bits.push(`<span class="meta-item">${escapeText(metaDurationText)}</span>`)
  if (metaGenreText) bits.push(`<span class="meta-item lg:hidden">${escapeText(metaGenreText)}</span>`)
  if (metaRatingText) {
    bits.push(
      '<span class="meta-item inline-flex items-center gap-1 text-fg-2 lg:hidden" aria-label="' +
        escapeText(t("detail.imdbRatingAria", { rating: metaRatingText })) +
        '">' +
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
// Year/runtime stay in the strip only - the strip keeps them visible at lg+ too.
function renderFactsColumn() {
  setFactRow("movie-detail-fact-genre", metaGenreText)
  setFactRow("movie-detail-fact-rating", metaRatingText)
}

// ----------------------------
// TMDb enrichment
// ----------------------------
function resetTmdbEnrichmentUI() {
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
  document.getElementById("movie-detail-fact-genre")?.setAttribute("hidden", "")
  document.getElementById("movie-detail-fact-rating")?.setAttribute("hidden", "")
  if (castSection) castSection.setAttribute("hidden", "")
  castListEl?.replaceChildren()
  if (similarSection) similarSection.setAttribute("hidden", "")
  similarListEl?.replaceChildren()
  document.getElementById("movie-detail-provider-people")?.setAttribute("hidden", "")
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
  return `/movies?${params.toString()}`
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
  const row = document.getElementById("movie-detail-provider-people")
  const listEl = document.getElementById("movie-detail-provider-people-list")
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
      kind: "vod",
      activePlaylistId,
      detailHref: (e) => `/movies/detail?id=${encodeURIComponent(e.id)}`,
      fallbackTitle: (e) => t("list.movieFallback", { id: e.id }),
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

// A deep link boots from a stub movie, so take the fields only the catalog row carries.
function adoptCatalogRow(catalog) {
  if (!movie) return
  const row = catalog.find((entry) => Number(entry.id) === movieId)
  if (!row) return
  if (!movie.category) movie.category = row.category || null
  if (!movie.year) movie.year = row.year || ""
}

// The in-memory catalog is empty on a deep link, so load it instead of giving up on the rail.
function loadVodCatalog() {
  if (!activePlaylistId) return Promise.resolve([])
  const cached = getCached(activePlaylistId, "vod")?.data
  if (cached?.length) return Promise.resolve(cached)
  if (!vodCatalogPromise) {
    vodCatalogPromise = ensureVod(creds, activePlaylistId)
      .then((catalog) => {
        adoptCatalogRow(catalog)
        return catalog
      })
      .catch((err) => {
        log.warn("[xt:movie-detail] vod catalog load failed:", err)
        return []
      })
  }
  return vodCatalogPromise
}

// Shared by the async patch-in and the cache-warm early merge in boot().
function applyEnrichmentPatch(enrichment) {
  if (enrichment.posterUrl) heroPosterUrl = enrichment.posterUrl
  if (enrichment.backdropUrl) {
    heroBackdropUrl = enrichment.backdropUrl
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
async function enrichMovieDetailFromTmdb(requestId) {
  if (!isTmdbActive() || !movie || !activePlaylistId) {
    settleHero()
    return false
  }

  if (movie.name === t("list.movieFallback", { id: movieId })) {
    settleHero()
    return false
  }

  const data = vodInfoRaw
  const movieData = data?.movie_data || data?.info || data || {}
  const info = data?.info || data?.movie_data || {}
  const providerTmdbId = Number(info.tmdb_id || movieData.tmdb_id) || null

  const tmdbId = await resolveTmdbId(activePlaylistId, "vod", {
    id: movie.id,
    name: movie.name,
    year: movie.year || movieData.releasedate || movieData.year || info.year || null,
    providerTmdbId,
  })
  if (requestId !== enrichRequestId) return false
  if (tmdbId == null) {
    settleHero()
    return false
  }

  const enrichment = await fetchMovieEnrichment(activePlaylistId, tmdbId)
  if (requestId !== enrichRequestId) return false
  if (!enrichment) {
    settleHero()
    return false
  }

  applyEnrichmentPatch(enrichment)
  settleHero()

  if (enrichment.recommendations?.length) {
    const catalog = await loadVodCatalog()
    if (requestId !== enrichRequestId) return false
    const matches = matchRecommendationsToCatalog(enrichment.recommendations, catalog, {
      mediaType: "movie",
      limit: 12,
      sourcePrefix: extractLangPrefix(movie.name),
    })
    if (matches.length) {
      renderSimilar(matches)
      return true
    }
  }
  return false
}

function providerInfoForVod(cachedData) {
  return cachedData?.info || cachedData?.movie_data || cachedData || {}
}

async function populateLocalSimilarRail(requestId) {
  if (!movie || !activePlaylistId) return
  const catalog = await loadVodCatalog()
  if (requestId !== enrichRequestId) return
  const people = parseProviderPeople(providerInfoForVod(vodInfoRaw))
  const matches = pickLocalSimilar(
    {
      id: movie.id,
      category: movie.category || null,
      castNames: people.castNames,
      directorName: people.directorName,
    },
    catalog,
    {
      limit: 12,
      infoLookup: (id) => {
        const cached = getCached(activePlaylistId, `vod_info_${id}`)?.data
        return cached ? parseProviderPeople(providerInfoForVod(cached)) : null
      },
      sourcePrefix: extractLangPrefix(movie.name),
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
  const populatedFromTmdb = await enrichMovieDetailFromTmdb(requestId)
  if (requestId !== enrichRequestId) return
  if (!populatedFromTmdb) await populateLocalSimilarRail(requestId)
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
let movieInsights = null

function getMovieInsights() {
  if (!movieInsights) {
    movieInsights = attachPlayerInsights({
      getHandle: () => vjs,
      getContainer: () => playerWrap,
      backendLabel: () => getPlayerBackend(),
      sessionKind: "vod",
    })
  }
  return movieInsights
}
let progressListenersBound = false
let pipBtnBound = false
let scaleBtnBound = false
let statsBtnBound = false
let healthBtnBound = false
let playRequestId = 0
let audioSwitcher = null
let audioDiscoveryController = null
/** Tee-proxy session behind the mount that is currently playing, so a later start can stop it. */
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

function setupStatsButton() {
  const statsBtn = document.getElementById("movie-detail-stats")
  if (!statsBtn) return
  statsBtn.removeAttribute("hidden")
  if (statsBtnBound) return
  statsBtnBound = true
  statsBtn.addEventListener("click", () => {
    const visible = getMovieInsights().toggleOverlay()
    statsBtn.setAttribute("aria-pressed", String(visible))
  })
}

function setupHealthButton() {
  const healthBtn = document.getElementById("movie-detail-health")
  if (!healthBtn) return
  healthBtn.removeAttribute("hidden")
  if (healthBtnBound) return
  healthBtnBound = true
  healthBtn.addEventListener("click", () => getMovieInsights().openHealthDialog())
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

// Must run before a new pipeline touches the player: the old switcher's listeners still sit on
// the shared media element and can re-register its own remux (one session at a time) or remount over the new one.
function retirePreviousPlayback() {
  audioSwitcher?.dispose()
  audioSwitcher = null
  audioDiscoveryController?.abort()
  audioDiscoveryController = null
  activeMkvSession?.stop()
  activeMkvSession = null
}

async function startPlayback(options = {}) {
  if (!movie) return
  const requestId = ++playRequestId

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

  if (requestId !== playRequestId) return
  // Ahead of every await that can register a proxy/remux session for this run.
  retirePreviousPlayback()

  if (activePlaylistId) {
    pushRecent(activePlaylistId, "vod", movie.id, movie.name, movie.logo || null)
  }

  if (await tryAndroidIntentPlayback(detailSrc)) return

  const localSrc = await getLocalPlayableSrc(detailSrc)
  let playSrc = localSrc || detailSrc
  let mountSrc = detailSrc
  // The asset.localhost/asset:// mount URL doesn't reliably parse as http(s), so the container
  // decision for a local download uses the download's on-disk path instead.
  const localDownloadPath = localSrc ? await getLocalDownloadPath(detailSrc) : null
  if (requestId !== playRequestId) return
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
      const externalSrc = (await getLocalDownloadPath(detailSrc)) || playSrc
      await launchExternalPlayback(backend, externalSrc, resumePos)
      pushMoviePresence()
      externalPresenceActive = true
    } catch (err) {
      surfaceLaunchError(err, backend)
    }
    return
  }

  const mountStartedAt = Date.now()
  const remuxAvailable = await vodAudioRemuxAvailable()
  const forceRemux = activePlaylistId
    ? isRemuxPinnedContent(activePlaylistId, buildRemuxContentKey("movie", movie.id))
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
      log.info("[xt:movie-detail] avi source has a playable alternative container", {
        container: alternative.container,
      })
      playSrc = alternative.url
      mountSrc = alternative.url
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
      : chooseMime(mountSrc)

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
          nameHint: hasHevcNameHint(movie.name),
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
      contentKey: buildRemuxContentKey("movie", movie.id),
    })
    getMovieInsights().record("giveup", failure?.kind ?? toastPath)
    // No automatic retry follows this failure - close the session now, not on the next play.
    getMovieInsights().endSession("giveup")
    if (toastPath === "upstream-http") showSourceUnavailableToast()
    else if (toastPath === "hevc") showHevcUnsupportedToast()
    else if (toastPath === "audio") showAudioUnsupportedToast(failure.codec)
    else showContainerUnsupportedToast(resolvedContainer || detectVodContainer(playSrc) || "mkv")
  }

  // The player is shared across runs, so a superseded run must not report (or seek) for the one that did play.
  player.one("error", () => {
    if (requestId !== playRequestId) return
    const e = player.error()
    log.error("[xt:movie-detail] player error", {
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
        const contentKey = buildRemuxContentKey("movie", movie.id)
        rememberRemuxPinnedContent(activePlaylistId, contentKey)
        log.warn("[xt:movie-detail] WebView could not demux this MKV directly - remuxing with ffmpeg instead", {
          contentKey,
          container: unsupportedContainer,
        })
        retirePreviousPlayback()
        startPlayback({ isAutomaticRetry: true })
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
      log.warn("[xt:movie-detail] local vod proxy failed to register, cannot remux this download", {
        contentKey: buildRemuxContentKey("movie", movie.id),
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
      getKnownDurationSeconds: () => knownVodDurationSeconds() || saved?.duration || player.duration?.() || 0,
      tracks,
      mountRemuxImmediately: remuxOwnsInitialMount,
      initialStartSeconds: resumePos,
      onRemuxUnrecoverable: (detail) => {
        log.warn("[xt:movie-detail] remux playback unavailable for this source:", detail)
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

  // This pipeline owns the mount from here on, so its tee session is the one the next start must stop.
  activeMkvSession = prepared.mkvSession
  // An automatic remux retry continues the same tune's session instead of opening a new one.
  if (options.isAutomaticRetry) {
    getMovieInsights().record("fallback", "auto:mkv-remux-fallback")
  } else {
    getMovieInsights().startSession({ label: movie.name })
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
      getMovieInsights().endSession("ended")
      if (!activePlaylistId || !movie) return
      const dur = player.duration?.() || 0
      markCompleted(activePlaylistId, "vod", movie.id, { duration: dur })
    })
  }

  // The switcher-owned mount plays itself once its remux session is up.
  if (!remuxOwnsInitialMount) {
    playWhenReady(player, {
      isStale: () => requestId !== playRequestId,
      onReject: (err) =>
        log.info("[xt:movie-detail] play() rejected - re-arming on canplay", {
          error: err?.name || err?.message || String(err),
        }),
      onRetryReject: (err) =>
        log.warn("[xt:movie-detail] retry play() rejected:", err?.name || err?.message || err),
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

  pushMoviePresence()
  externalPresenceActive = false
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

// ----------------------------
// Subtitle delay
// ----------------------------
const subtitleDelayController = createSubtitleDelayController({
  dialogId: "movie-subtitle-delay-dialog",
  button: document.getElementById("movie-subtitle-delay-btn"),
  nudge: (deltaSeconds) => vjs?.subtitleDelay?.(deltaSeconds),
  getMediaElement: () => vjs?.getMediaElement?.() ?? null,
})

document.addEventListener("keydown", (event) => subtitleDelayController.handleKeydown(event))

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
      externalPresenceActive = true
    },
  }
)

subscribeExternalPlayerExit(() => {
  if (!externalPresenceActive) return
  externalPresenceActive = false
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
    retirePreviousPlayback()
    subtitleDelayController.teardown()
  } catch {}
  clearAmbient(ambientEl)
  externalPresenceActive = false
  clearRichPresence().catch(() => {})
})

// ----------------------------
// Favorites
// ----------------------------
favBtn?.addEventListener("click", () => {
  if (!movie || !activePlaylistId) return
  const isStubName = movie.name === t("list.movieFallback", { id: movie.id })
  toggleFavorite(activePlaylistId, "vod", movie.id, {
    name: isStubName ? "" : movie.name || movie.title || "",
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
  const isStubName = movie.name === t("list.movieFallback", { id: movie.id })
  toggleWatchlist(activePlaylistId, "vod", movie.id, {
    name: isStubName ? "" : movie.name || movie.title || "",
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
      nfo: buildMovieNfoMeta(),
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
    if (!titleEl.textContent) titleEl.textContent = t("detail.error.cantLoad")
    titleEl.removeAttribute("hidden")
  }
  metaEl?.removeAttribute("hidden")
  plotEl?.removeAttribute("hidden")
  if (!isTmdbActive()) settleHero()
}

function showError(msg) {
  if (titleEl) titleEl.textContent = t("detail.error.cantLoad")
  if (plotEl) plotEl.textContent = msg
  hideDetailSkeleton()
  settleHero()
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
  playRequestId++
  const enrichRequestIdForThisBoot = ++enrichRequestId
  try {
    vjs?.pause?.()
    await vjs?.dispose?.()
  } catch {}
  vjs = null
  retirePreviousPlayback()
  progressListenersBound = false

  movie = null
  detailSrc = ""
  detailSrcBuilder = null
  vodCatalogPromise = null
  heroPosterUrl = null
  heroBackdropUrl = null
  heroSettled = false
  earlyEnrichmentHandled = false
  earlyEnrichmentPopulatedSimilar = false
  showDetailSkeleton()
  if (metaEl) metaEl.textContent = ""
  if (plotEl) plotEl.textContent = ""
  if (titleEl) titleEl.textContent = ""
  resetTmdbEnrichmentUI()

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
  const catalogMovie = list?.data?.find((m) => Number(m.id) === movieId) || null

  const dl = listDownloads().find(
    (d) => d.source?.kind === "vod" && Number(d.source?.id) === movieId
  )

  const stubName = t("list.movieFallback", { id: movieId })
  movie = catalogMovie || {
    id: movieId,
    name: dl?.title || stubName,
    logo: dl?.source?.logo || null,
  }

  // The stub id-based name never reaches the DOM - the title stays hidden behind
  // the skeleton until a real name arrives (catalog/download now, or provider below).
  if (titleEl && movie.name !== stubName) titleEl.textContent = movie.name
  // Hero stays in its skeleton state - settleHero() below decides when to paint it once.
  heroPosterUrl = movie.logo || null
  setAmbient(movie.logo || null)
  syncFavButton()
  syncWatchButton()
  syncResumeUI()

  if (dl?.url) {
    detailSrc = dl.url
    applyDownloadState()
    externalBtnHandle?.refresh()
  }

  // Both probes are network-free (hydrate + memory read) and run under one bound,
  // so a cold IDB read can never delay first paint past the shared timeout.
  const { enrichment: earlyEnrichment, providerInfo: earlyProviderInfo } = await peekEarlyDetailData(
    "vod",
    movie.id,
    active._id,
    `vod_info_${movieId}`
  )
  if (enrichRequestIdForThisBoot !== enrichRequestId) return

  let providerInfoReady = false
  if (earlyProviderInfo) {
    applyVodInfo(earlyProviderInfo.data)
    providerInfoReady = true
  }

  if (earlyEnrichment) {
    applyEnrichmentPatch(earlyEnrichment.enrichment)
    settleHero()
    earlyEnrichmentHandled = true
    if (earlyEnrichment.enrichment.recommendations?.length) {
      const matches = matchRecommendationsToCatalog(earlyEnrichment.enrichment.recommendations, list?.data || [], {
        mediaType: "movie",
        limit: 12,
        sourcePrefix: extractLangPrefix(movie.name),
      })
      if (matches.length) {
        renderSimilar(matches)
        earlyEnrichmentPopulatedSimilar = true
      }
    }
  }

  if (providerInfoReady) hideDetailSkeleton()

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

  // Refresh from network when reachable. The provider info cache has no TTL gate here -
  // this always runs, matching the existing offline/SWR behavior for this endpoint.
  if (creds.host && creds.user && creds.pass) {
    try {
      const r = await xtreamApiFetch("get_vod_info", { vod_id: String(movieId) })
      if (!r.ok) throw new Error(await r.text())
      const data = await r.json()
      setCached(active._id, `vod_info_${movieId}`, data, VOD_INFO_TTL_MS)
      if (enrichRequestIdForThisBoot === enrichRequestId) {
        applyVodInfo(data)
        // applyVodInfo resets the provider-derived fields the merge already backfilled; reassert it.
        // settleHero() is a no-op once already settled, so this never repaints with a different image.
        if (earlyEnrichmentHandled) {
          applyEnrichmentPatch(earlyEnrichment.enrichment)
          settleHero()
        }
        hideDetailSkeleton()
      }
    } catch (e) {
      log.error("[xt:movie-detail] info fetch failed:", e)
      if (!providerInfoReady && enrichRequestIdForThisBoot === enrichRequestId) {
        if (plotEl) {
          plotEl.textContent = dl
            ? t("detail.error.providerLocal")
            : t("detail.error.failedTryPlay")
        }
        hideDetailSkeleton()
      }
    }
  } else if (!providerInfoReady) {
    if (plotEl) {
      plotEl.textContent = dl
        ? t("detail.error.localAvailable")
        : t("detail.error.noPlaylist")
    }
    hideDetailSkeleton()
  }

  populateSimilarRail(enrichRequestIdForThisBoot).catch((err) => {
    log.warn("[xt:movie-detail] similar rail population failed:", err)
  })

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
