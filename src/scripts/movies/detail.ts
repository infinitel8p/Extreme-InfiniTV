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
  sanitizeProviderBackdropUrl,
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
  getContentLanguage,
  VIDEO_SCALE_EVENT,
} from "@/scripts/lib/app-settings.js"
import { resolveTmdbId, fetchMovieEnrichment, peekEarlyDetailData } from "@/scripts/lib/tmdb-enrich.ts"
import { noteDetailGenres } from "@/scripts/lib/genre-index.ts"
import { matchRecommendationsToCatalog } from "@/scripts/lib/tmdb-match.ts"
import { pickLocalSimilar, parseProviderPeople } from "@/scripts/lib/similar-local.ts"
import { createGroupingIndexMemo } from "@/scripts/lib/language-groups.ts"
import { parseNamePrefix, effectivePreferredTags } from "@/scripts/lib/language-tags.ts"
import { dragScroll } from "@/scripts/lib/drag-scroll.ts"
import {
  wireDetailBackLink,
  setDetailSkeletonVisible,
  youtubeUrlFromTrailer,
  displayTitle,
  extractDisplayYear,
  escapeDetailText,
  setFactRow,
  personFilterHref as buildPersonFilterHref,
  providerPeopleNames,
  patchDirectorElement,
  patchTaglineElement,
  renderCastList,
  renderProviderPeopleChipRow,
  renderSimilarRail,
  groupKeyForCatalog as sharedGroupKeyForCatalog,
  renderLanguagePills as sharedRenderLanguagePills,
} from "@/scripts/lib/detail-chrome.ts"
import { createInlineTrailer } from "@/scripts/lib/trailer-inline.ts"
import { fmtImdbRating, parseHmsToSeconds } from "@/scripts/lib/format.js"
import { setRichPresence, clearRichPresence } from "@/scripts/lib/discord-rpc.js"
import { t, initI18n, getActiveLocale } from "@/scripts/lib/i18n.js"
import {
  mountPlayer,
  getExternalLauncher,
  subscribeExternalPlayerExit,
} from "@/scripts/lib/player-runtime.ts"
import { toast } from "@/scripts/lib/toast.js"
import { setupExternalPlayerButton, surfaceLaunchError } from "@/scripts/lib/external-player-button.ts"
import { createVideoScaleController } from "@/scripts/lib/video-scale.ts"
import { openVideoScaleDialog, videoScaleModeLabelKey } from "@/scripts/lib/video-scale-dialog.ts"
import { createSubtitleDelayController } from "@/scripts/lib/subtitle-delay-dialog.ts"
import { attachPlayerInsights } from "@/scripts/lib/player-stats.ts"
import { createVodPlaybackToasts } from "@/scripts/lib/vod-playback-toasts.ts"
import { mountVodPlayback } from "@/scripts/lib/vod-mount.ts"

const VOD_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ----------------------------
// Refs
// ----------------------------
const backLink = document.getElementById("movie-detail-back")
const ambientEl = document.getElementById("movie-detail-ambient")
const titleEl = document.getElementById("movie-detail-title")
const metaEl = document.getElementById("movie-detail-meta")
const langsEl = document.getElementById("movie-detail-langs")
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

wireDetailBackLink(backLink, "/movies")

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
    name: movie?.name || "",
    posterUrl: heroPosterUrl,
    backdropUrls: [heroProviderBackdropUrl, heroBackdropUrl],
  })
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
    if (titleEl) titleEl.textContent = displayTitle(apiName)
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

  heroProviderBackdropUrl = sanitizeProviderBackdropUrl(info.backdrop_path, heroPosterUrl)
  if (heroProviderBackdropUrl) setAmbient(heroProviderBackdropUrl)

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
  if (activePlaylistId) noteDetailGenres(activePlaylistId, "vod", movieId, genre)
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

// Genre/rating repeat in the facts column at lg+, so the compact strip hides its own copies there.
function renderMetaLine() {
  if (!metaEl) return
  const bits = []
  if (metaYearText) bits.push(`<span class="meta-item">${escapeDetailText(metaYearText)}</span>`)
  if (metaDurationText) bits.push(`<span class="meta-item">${escapeDetailText(metaDurationText)}</span>`)
  if (metaGenreText) bits.push(`<span class="meta-item lg:hidden">${escapeDetailText(metaGenreText)}</span>`)
  if (metaRatingText) {
    bits.push(
      '<span class="meta-item inline-flex items-center gap-1 text-fg-2 lg:hidden" aria-label="' +
        escapeDetailText(t("detail.imdbRatingAria", { rating: metaRatingText })) +
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
  patchDirectorElement(directorEl, director, tmdbPersonId, personFilterHref)
}

function patchTagline(tagline) {
  patchTaglineElement(taglineEl, tagline)
}

function patchGenreFromEnrichment(genres) {
  if (!genres?.length || metaGenreText) return
  metaGenreText = genres.join(", ")
  renderMetaLine()
  if (activePlaylistId) noteDetailGenres(activePlaylistId, "vod", movieId, metaGenreText)
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

function personFilterHref(name, tmdbPersonId) {
  return buildPersonFilterHref("/movies", name, tmdbPersonId)
}

function renderCast(cast) {
  renderCastList({ castSection, castListEl, cast, buildPersonHref: personFilterHref })
}

function renderProviderPeopleChips(names) {
  renderProviderPeopleChipRow({
    row: document.getElementById("movie-detail-provider-people"),
    listEl: document.getElementById("movie-detail-provider-people-list"),
    names,
    buildPersonHref: personFilterHref,
  })
}

function renderSimilar(matches) {
  renderSimilarRail({
    section: similarSection,
    listEl: similarListEl,
    matches,
    kind: "vod",
    activePlaylistId,
    detailHrefBase: "/movies/detail",
    fallbackTitleKey: "list.movieFallback",
  })
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

const getGroupingIndexFor = createGroupingIndexMemo()

function groupKeyForCatalog(catalog) {
  return sharedGroupKeyForCatalog(activePlaylistId, catalog, getGroupingIndexFor)
}

function renderLanguagePills(catalog) {
  sharedRenderLanguagePills({
    langsEl,
    item: movie,
    kind: "vod",
    activePlaylistId,
    catalog,
    getGroupingIndexFor,
    detailHrefBase: "/movies/detail",
  })
}

// Shared by the async patch-in and the cache-warm early merge in boot().
function applyEnrichmentPatch(enrichment) {
  if (enrichment.posterUrl) heroPosterUrl = enrichment.posterUrl
  if (enrichment.backdropUrl) {
    heroBackdropUrl = enrichment.backdropUrl
    if (!heroProviderBackdropUrl) setAmbient(enrichment.backdropUrl)
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

  const enrichment = await fetchMovieEnrichment(tmdbId)
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
    renderLanguagePills(catalog)
    const matches = matchRecommendationsToCatalog(enrichment.recommendations, catalog, {
      mediaType: "movie",
      limit: 12,
      sourcePrefix: parseNamePrefix(movie.name).tag,
      preferredTags: effectivePreferredTags(getContentLanguage(), getActiveLocale()),
      groupKeyForEntry: groupKeyForCatalog(catalog),
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
  renderLanguagePills(catalog)
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
      sourcePrefix: parseNamePrefix(movie.name).tag,
      preferredTags: effectivePreferredTags(getContentLanguage(), getActiveLocale()),
      groupKeyForEntry: groupKeyForCatalog(catalog),
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

const inlineTrailer = createInlineTrailer({
  wrapEl: document.getElementById("movie-detail-trailer-wrap"),
  frameEl: document.getElementById("movie-detail-trailer-frame"),
  closeBtn: document.getElementById("movie-detail-trailer-close"),
  externalBtn: document.getElementById("movie-detail-trailer-external"),
  posterEl,
  playerWrap,
  onOpen: () => { vjs?.pause?.() },
  onStateChange: (open) => trailerBtn?.setAttribute("aria-pressed", open ? "true" : "false"),
})

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
/** Detach for the stall-recovery watchdog on the currently mounted src, if any. */
let stallWatchdogDetach = null
/** Detach for the auto-hiding quality chip overlaid on the player edge, if any. */
let qualityChipDetach = null
const RESUME_MIN_SECONDS = 30
const RESUME_MAX_FRACTION = 0.95

const vodPlaybackToasts = createVodPlaybackToasts(() => externalBtnHandle?.refresh())

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
  stallWatchdogDetach?.()
  stallWatchdogDetach = null
  qualityChipDetach?.()
  qualityChipDetach = null
}

async function startPlayback(options = {}) {
  if (!movie) return
  inlineTrailer.close()
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
  const playSrc = localSrc || detailSrc
  const mountSrc = detailSrc
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

  await mountVodPlayback({
    logTag: "[xt:movie-detail]",
    prematureEndedLogTag: "[xt:movies-detail]",
    contentId: movie.id,
    remuxContentKind: "movie",
    playlistId: activePlaylistId,
    playSrc,
    mimeFallbackSrc: mountSrc,
    localDownloadPath,
    savedProgress: saved,
    resumePos,
    nameHintSource: movie.name,
    posterEl,
    playerWrap,
    videoElementId: "movie-player",
    backend,
    isAutomaticRetry: !!options.isAutomaticRetry,
    ensureEmbeddedPlayer,
    setupPlayerUi: (player) => {
      setupPipButton(player)
      setupScaleButton()
      setupStatsButton()
      setupHealthButton()
      subtitleDelayController.setup()
    },
    applyVideoScale,
    toasts: vodPlaybackToasts,
    recordGiveUp: (kind) => getMovieInsights().record("giveup", kind),
    endGiveUpSession: () => getMovieInsights().endSession("giveup"),
    clearAudioSwitcherIfOwn: (own) => { if (audioSwitcher === own) audioSwitcher = null },
    clearActiveMkvSessionIfMatches: (mkvSession) => { if (activeMkvSession === mkvSession) activeMkvSession = null },
    isStale: () => requestId !== playRequestId,
    retirePreviousPlaybackAndRetryRemux: () => {
      retirePreviousPlayback()
      startPlayback({ isAutomaticRetry: true })
    },
    beginInsightsSession: (isAutomaticRetry) => {
      if (isAutomaticRetry) getMovieInsights().record("fallback", "auto:mkv-remux-fallback")
      else getMovieInsights().startSession({ label: movie.name })
    },
    getKnownDurationSecondsForSwitcher: () => knownVodDurationSeconds(),
    getKnownDurationSecondsForEnded: () => knownVodDurationSeconds() || null,
    getAudioSwitcher: () => audioSwitcher,
    setAudioSwitcher: (switcher) => { audioSwitcher = switcher },
    setActiveMkvSession: (session) => { activeMkvSession = session },
    setAudioDiscoveryController: (controller) => { audioDiscoveryController = controller },
    replaceStallWatchdog: (detach) => {
      stallWatchdogDetach?.()
      stallWatchdogDetach = detach
    },
    setQualityChipDetach: (detach) => { qualityChipDetach = detach },
    bindProgressListenersOnce: (registerListeners) => {
      if (progressListenersBound) return
      progressListenersBound = true
      registerListeners()
    },
    hasActiveContent: () => !!activePlaylistId && !!movie,
    writeProgress: (pos, dur) => {
      setProgress(activePlaylistId, "vod", movie.id, pos, dur, {
        name: movie.name,
        logo: movie.logo || null,
      })
    },
    recordPlaybackEndedSession: () => getMovieInsights().endSession("ended"),
    markContentCompleted: (dur) => {
      markCompleted(activePlaylistId, "vod", movie.id, { duration: dur })
    },
    onMounted: () => {
      pushMoviePresence()
      externalPresenceActive = false
    },
  })
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
  if (inlineTrailer.isOpen()) inlineTrailer.close()
  else inlineTrailer.open(trailerUrl, titleEl?.textContent?.trim() || undefined)
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
  setDetailSkeletonVisible({ titleEl, metaEl, plotEl })
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
  heroProviderBackdropUrl = null
  heroSettled = false
  earlyEnrichmentHandled = false
  earlyEnrichmentPopulatedSimilar = false
  showDetailSkeleton()
  if (metaEl) metaEl.textContent = ""
  if (plotEl) plotEl.textContent = ""
  if (titleEl) titleEl.textContent = ""
  if (langsEl) {
    langsEl.setAttribute("hidden", "")
    langsEl.replaceChildren()
  }
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
  const catalogMovie = list?.data?.find((entry) => Number(entry.id) === movieId) || null

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
  if (titleEl && movie.name !== stubName) titleEl.textContent = displayTitle(movie.name)
  // Hero stays in its skeleton state - settleHero() below decides when to paint it once.
  heroPosterUrl = movie.logo || null
  setAmbient(movie.logo || null)
  syncFavButton()
  syncWatchButton()
  syncResumeUI()
  renderLanguagePills(list?.data || [])

  if (dl?.url) {
    detailSrc = dl.url
    applyDownloadState()
    externalBtnHandle?.refresh()
  }

  // Both probes are network-free (hydrate + memory read) and run under one bound,
  // so a cold IDB read can never delay first paint past the shared timeout.
  const { enrichment: earlyEnrichment, providerInfo: earlyProviderInfo } = await peekEarlyDetailData(
    active._id,
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
        sourcePrefix: parseNamePrefix(movie.name).tag,
        preferredTags: effectivePreferredTags(getContentLanguage(), getActiveLocale()),
        groupKeyForEntry: groupKeyForCatalog(list?.data || []),
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
