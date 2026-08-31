// Android TV movie detail view (route: /tv/movies/detail?id=<vod_id>).

import { nextPaint, markLastOpenedEntry, type TvView, type TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT, getActiveLocale } from "@/scripts/lib/i18n"
import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
import { getCached, setCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { ensureVod } from "@/scripts/lib/catalog.js"
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  getProgress,
} from "@/scripts/lib/preferences.js"
import {
  startDownload,
  pauseDownload,
  resumeDownload,
  isDownloadable,
  inferExt,
  listDownloads,
  DOWNLOADS_LIST_EVENT,
  DOWNLOAD_PROGRESS_EVENT,
} from "@/scripts/lib/downloads.js"
import { parseProviderTmdbId } from "@/scripts/lib/tvdb-proxy.ts"
import { resolveTitleEnrichment } from "@/scripts/lib/enrichment.ts"
import { fillHeroGaps, type DetailHeroFields } from "@/scripts/tv/detail-enrich.ts"
import {
  LANGUAGE_GROUPING_EVENT,
  CONTENT_LANGUAGE_EVENT,
  getLanguageGroupingEnabled,
} from "@/scripts/lib/app-settings.js"
import { fmtImdbRating, parseHmsToSeconds, ratingSortValue } from "@/scripts/lib/format.ts"
import { parseNamePrefix, languageTagLabel, prefixQualityTokens } from "@/scripts/lib/language-tags.ts"
import { buildMovieStreamUrl } from "@/scripts/lib/stream-urls.ts"
import { playVod } from "@/scripts/tv/playback"
import { createDetailChrome, type DetailAction } from "@/scripts/tv/ui/detail"
import { createRail } from "@/scripts/tv/ui/rail"
import { formatCardMeta, type PosterCardItem } from "@/scripts/tv/ui/card"
import { STAR_OUTLINE, STAR_FILLED, BOOKMARK_FILLED } from "@/scripts/lib/entry-card.ts"
import { ICON_PLAYER_PLAY, ICON_DOWNLOAD } from "@/scripts/lib/icons"
import { toast } from "@/scripts/lib/toast"
import { confirmDialog } from "@/scripts/lib/confirm-dialog"
import { log } from "@/scripts/lib/log"
import { renderLanguagePills, type GroupingIndexLookup } from "@/scripts/lib/detail-chrome.ts"
import { getSharedGroupingIndex, isLanguageGroupingExplicitlyEnabled } from "@/scripts/lib/language-groups.ts"
import { registerFocusSection } from "@/scripts/tv/focus"
import { memoryConservative } from "@/scripts/tv/motion"

const VOD_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RESUME_MIN_SECONDS = 30
const SIMILAR_LIMIT = 20
const SIMILAR_FOCUS_SECTION_ID = "tv-detail-similar"
const LANGUAGE_VARIANTS_FOCUS_SECTION_ID = "tv-detail-language-variants"

const ICON_BOOKMARK_OUTLINE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z"/></svg>'

interface CatalogRow {
  id: number | string
  name: string
  logo: string | null
  year: string
  rating: string
  duration: string
  category: string
  plot: string
  added: number
  tmdb: number | null
}

interface Creds {
  host: string
  port: string
  user: string
  pass: string
}

function fmtDuration(value: string): string {
  if (!value) return ""
  const raw = value.trim()
  if (!raw) return ""
  const totalMinutes = raw.includes(":")
    ? Math.round(parseHmsToSeconds(raw) / 60)
    : parseInt(raw, 10)
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return ""
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes} min`
}

// Set once boot() resolves a playlist; lets prepaint read the cache synchronously on a later visit.
let lastKnownPlaylistId = ""

function stubHero(row: CatalogRow) {
  const languageTag = parseNamePrefix(row.name).tag
  const languageLabel = languageTag ? languageTagLabel(languageTag, getActiveLocale()) : ""
  const qualityLabel = prefixQualityTokens(row.name).join(" ")
  return {
    backdropUrl: null,
    posterUrl: row.logo,
    title: row.name,
    subtitle: String(row.year || ""),
    metaChips: [languageLabel, qualityLabel],
    description: row.plot || t("detail.noDescription"),
    rating: fmtImdbRating(row.rating) || null,
  }
}

function languageGroupingAllowed(): boolean {
  return memoryConservative() ? isLanguageGroupingExplicitlyEnabled() : getLanguageGroupingEnabled()
}

const view: TvView = {
  prepaint(root: HTMLElement, url: URL): boolean {
    const movieId = Number(url.searchParams.get("id") || "0")
    if (!movieId || !lastKnownPlaylistId) return false
    const cachedCatalog = (getCached(lastKnownPlaylistId, "vod")?.data || []) as CatalogRow[]
    const catalogRow = cachedCatalog.find((row) => Number(row.id) === movieId)
    if (!catalogRow) return false
    markLastOpenedEntry({ kind: "vod", id: movieId })
    const chrome = createDetailChrome(root)
    chrome.setSkeleton(false)
    chrome.setHero(stubHero(catalogRow))
    return true
  },
  mount(root: HTMLElement, ctx: TvViewContext) {
    const movieId = Number(ctx.url.searchParams.get("id") || "0")
    const wantsAutoplay = ctx.url.searchParams.get("autoplay") === "1"

    const chrome = createDetailChrome(root)

    const languageVariantsRow = document.createElement("div")
    languageVariantsRow.id = LANGUAGE_VARIANTS_FOCUS_SECTION_ID
    languageVariantsRow.hidden = true
    languageVariantsRow.setAttribute("aria-label", t("detail.lang.title"))
    languageVariantsRow.className = "flex flex-wrap gap-2"
    chrome.sections.appendChild(languageVariantsRow)
    const unregisterLanguageVariantsSection = registerFocusSection(
      LANGUAGE_VARIANTS_FOCUS_SECTION_ID,
      languageVariantsRow
    )
    const getGroupingIndexFor: GroupingIndexLookup = (_playlistId, catalog) => getSharedGroupingIndex(catalog)

    const similarRail = createRail({ title: t("tv.detail.similar"), focusSectionId: SIMILAR_FOCUS_SECTION_ID })
    chrome.sections.appendChild(similarRail.el)
    similarRail.setLoading()

    let destroyed = false
    let activePlaylistId = ""
    let creds: Creds = { host: "", port: "", user: "", pass: "" }
    let movie: CatalogRow | null = null
    let vodInfoRaw: any = null
    let containerExt = "mp4"
    let heroBackdropUrl: string | null = null
    let heroOverview = ""
    let heroGenres = ""
    let heroDurationText = ""
    let heroRatingText = ""
    let heroYearText = ""
    let enrichRequestId = 0
    let focusedPrimaryOnce = false
    let lastLanguageVariantsCatalog: CatalogRow[] = []

    function stubName(): string {
      return t("list.movieFallback", { id: movieId })
    }

    function detailSrc(): string {
      if (!creds.host || !creds.user || !creds.pass) return ""
      return buildMovieStreamUrl(creds, movieId, containerExt)
    }

    function knownDurationSeconds(): number {
      const data = vodInfoRaw?.movie_data || vodInfoRaw?.info || vodInfoRaw || {}
      const info = vodInfoRaw?.info || vodInfoRaw?.movie_data || {}
      const durationSecs = Number(data.duration_secs || info.duration_secs || 0)
      if (durationSecs > 0) return durationSecs
      return parseHmsToSeconds(data.duration || info.duration)
    }

    function findExistingDownload() {
      return listDownloads().find(
        (download: any) => download.source?.kind === "vod" && Number(download.source?.id) === movieId
      )
    }

    function renderHero(): void {
      if (!movie) return
      const languageTag = parseNamePrefix(movie.name).tag
      const languageLabel = languageTag ? languageTagLabel(languageTag, getActiveLocale()) : ""
      const qualityLabel = prefixQualityTokens(movie.name).join(" ")

      chrome.setHero({
        backdropUrl: heroBackdropUrl,
        posterUrl: movie.logo,
        title: movie.name,
        subtitle: [heroYearText || movie.year, heroDurationText, heroGenres].filter(Boolean).join(" · "),
        metaChips: [languageLabel, qualityLabel],
        description: heroOverview || movie.plot || t("detail.noDescription"),
        rating: heroRatingText || fmtImdbRating(movie.rating) || null,
      })
    }

    async function startPlayback(resumeSeconds: number): Promise<void> {
      if (!movie || !activePlaylistId) return
      await playVod(
        {
          playlistId: activePlaylistId,
          movieId,
          title: movie.name,
          logo: movie.logo,
          containerExt,
          resumeSeconds,
          durationSeconds: knownDurationSeconds() || undefined,
        },
        {
          onEnded: () => renderActions(),
        }
      )
    }

    async function onDownloadActivate(): Promise<void> {
      if (!movie || !isDownloadable()) return
      const existing = findExistingDownload()
      if (existing?.status === "downloading" || existing?.status === "queued") {
        pauseDownload(existing.id)
        return
      }
      if (existing && ["paused", "stalled", "error"].includes(existing.status)) {
        resumeDownload(existing.id)
        return
      }
      if (existing?.status === "done") return

      const confirmed = await confirmDialog({
        title: t("detail.action.download"),
        message: t("tv.detail.downloadConfirm", { title: movie.name }),
      })
      if (!confirmed) return

      const src = detailSrc()
      if (!src) {
        toast({ title: t("detail.download.noUrl"), variant: "error" })
        return
      }
      try {
        await startDownload({
          url: src,
          title: movie.name || stubName(),
          ext: inferExt(src, "mp4"),
          source: { kind: "vod", playlistId: activePlaylistId, id: movieId, logo: movie.logo },
          nfo: null,
        })
        toast({ title: t("detail.download.starting") })
      } catch (err) {
        log.error("[xt:tv-movie-detail] download failed:", err)
        toast({ title: t("detail.download.failed"), variant: "error" })
      }
    }

    function downloadLabel(): string {
      if (!isDownloadable()) return t("detail.action.download")
      const existing = findExistingDownload()
      if (!existing) return t("detail.action.download")
      switch (existing.status) {
        case "downloading": {
          const pct = existing.bytesTotal > 0 ? Math.floor((existing.bytesDone / existing.bytesTotal) * 100) : null
          return pct !== null ? `${pct}%` : t("detail.action.downloading")
        }
        case "queued":
          return t("detail.download.queued")
        case "paused":
          return t("detail.download.resume")
        case "stalled":
        case "error":
          return t("detail.download.retry")
        case "done":
          return t("detail.action.downloaded")
        default:
          return t("detail.action.download")
      }
    }

    function renderActions(): void {
      if (!movie || destroyed) return
      const saved = activePlaylistId ? getProgress(activePlaylistId, "vod", movieId) : null
      const canResume = !!saved && !saved.completed && saved.position > RESUME_MIN_SECONDS
      const percent = canResume && saved.duration > 0 ? Math.round((saved.position / saved.duration) * 100) : 0

      const favorite = activePlaylistId ? isFavorite(activePlaylistId, "vod", movieId) : false
      const onWatchlist = activePlaylistId ? isOnWatchlist(activePlaylistId, "vod", movieId) : false
      const existingDownload = findExistingDownload()

      const actions: DetailAction[] = [
        {
          id: "play",
          label: canResume ? t("tv.detail.resumePercent", { percent }) : t("detail.action.play"),
          icon: ICON_PLAYER_PLAY,
          primary: true,
          onActivate: () => void startPlayback(canResume ? saved.position : 0),
        },
        {
          id: "favorite",
          label: favorite ? t("detail.action.removeFavorite") : t("detail.action.addFavorite"),
          icon: favorite ? STAR_FILLED : STAR_OUTLINE,
          pressed: favorite,
          onActivate: () => {
            if (!movie || !activePlaylistId) return
            toggleFavorite(activePlaylistId, "vod", movieId, { name: movie.name, logo: movie.logo })
            renderActions()
          },
        },
        {
          id: "watchlist",
          label: onWatchlist ? t("detail.action.removeWatchlist") : t("detail.action.watchLater"),
          icon: onWatchlist ? BOOKMARK_FILLED : ICON_BOOKMARK_OUTLINE,
          pressed: onWatchlist,
          onActivate: () => {
            if (!movie || !activePlaylistId) return
            toggleWatchlist(activePlaylistId, "vod", movieId, { name: movie.name, logo: movie.logo })
            renderActions()
          },
        },
        {
          id: "download",
          label: downloadLabel(),
          icon: ICON_DOWNLOAD,
          disabled: !isDownloadable(),
          pressed: existingDownload?.status === "done",
          onActivate: () => void onDownloadActivate(),
        },
      ]

      chrome.setActions(actions)

      if (!focusedPrimaryOnce) {
        focusedPrimaryOnce = true
        requestAnimationFrame(() => {
          chrome.el.querySelector<HTMLElement>("[data-tv-autofocus]")?.focus()
        })
      }
    }

    function applyVodInfo(data: any): void {
      vodInfoRaw = data
      const movieData = data?.movie_data || data?.info || data || {}
      const info = data?.info || data?.movie_data || {}

      const rawExt = movieData.container_extension || info.container_extension || "mp4"
      containerExt = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"

      const apiName = movieData.name || info.name || ""
      if (apiName && movie && (!movie.name || movie.name === stubName())) movie.name = apiName

      const apiLogo = info.cover_big || info.movie_image || info.cover || movieData.cover || movieData.stream_icon || null
      if (apiLogo && movie && !movie.logo) movie.logo = apiLogo

      heroBackdropUrl = typeof info.backdrop_path === "string" && info.backdrop_path ? info.backdrop_path : null
      if (Array.isArray(info.backdrop_path) && info.backdrop_path.length) heroBackdropUrl = info.backdrop_path[0]

      heroYearText = String(movieData.releasedate || movieData.year || info.year || "").match(/\d{4}/)?.[0] || ""
      heroDurationText = fmtDuration(String(movieData.duration || info.duration || ""))
      heroGenres = String(movieData.genre || info.genre || "")
      heroRatingText = fmtImdbRating(movieData.rating || info.rating || movieData.rating_5based)
      heroOverview = String(movieData.plot || movieData.description || info.plot || info.description || "")

      renderHero()
      renderActions()
    }

    function currentHeroFields(): DetailHeroFields {
      return {
        backdropUrl: heroBackdropUrl,
        overview: heroOverview,
        genres: heroGenres,
        ratingText: heroRatingText,
        yearText: heroYearText,
      }
    }

    function applyHeroFields(fields: DetailHeroFields): void {
      heroBackdropUrl = fields.backdropUrl
      heroOverview = fields.overview
      heroGenres = fields.genres
      heroRatingText = fields.ratingText
      heroYearText = fields.yearText
    }

    // No isTmdbActive() gate: the TheTVDB proxy enriches without a user key.
    async function enrichHero(requestId: number): Promise<void> {
      if (!movie || !activePlaylistId) return
      const data = vodInfoRaw
      const movieData = data?.movie_data || data?.info || data || {}
      const info = data?.info || data?.movie_data || {}
      const providerTmdbId = parseProviderTmdbId(info) ?? parseProviderTmdbId(movieData) ?? movie.tmdb ?? null
      try {
        const enrichment = await resolveTitleEnrichment({
          kind: "movie",
          playlistId: activePlaylistId,
          itemId: String(movie.id),
          name: movie.name,
          year: parseInt(String(movie.year), 10) || null,
          providerTmdbId,
        })
        if (requestId !== enrichRequestId || !enrichment) return
        applyHeroFields(fillHeroGaps(currentHeroFields(), enrichment))
        if (!movie.logo && enrichment.posterUrl) movie.logo = enrichment.posterUrl
        renderHero()
      } catch (err) {
        log.warn("[xt:tv-movie-detail] enrichment failed:", err)
      }
    }

    function renderLanguageVariants(catalog: CatalogRow[]): void {
      lastLanguageVariantsCatalog = catalog
      if (!movie) return
      renderLanguagePills({
        langsEl: languageVariantsRow,
        item: { id: Number(movie.id), name: movie.name },
        kind: "vod",
        activePlaylistId,
        catalog,
        getGroupingIndexFor,
        detailHrefBase: "/tv/movies/detail",
        groupingAllowed: languageGroupingAllowed(),
      })
    }

    async function loadSimilar(): Promise<void> {
      if (!movie || !activePlaylistId) return
      const currentMovie = movie
      let catalog = (getCached(activePlaylistId, "vod")?.data || []) as CatalogRow[]
      if (!catalog.length) {
        try {
          catalog = await ensureVod(creds, activePlaylistId)
        } catch (err) {
          log.warn("[xt:tv-movie-detail] similar catalog load failed:", err)
          catalog = []
        }
      }
      if (destroyed) return
      renderLanguageVariants(catalog)
      const candidates = catalog
        .filter((row) => row.id !== currentMovie.id && (!currentMovie.category || row.category === currentMovie.category))
        .sort((left, right) => ratingSortValue(right.rating) - ratingSortValue(left.rating))
        .slice(0, SIMILAR_LIMIT)

      const items: PosterCardItem[] = candidates.map((row) => ({
        railId: SIMILAR_FOCUS_SECTION_ID,
        kind: "vod",
        id: row.id,
        name: row.name,
        href: `/tv/movies/detail?id=${encodeURIComponent(String(row.id))}`,
        posterUrl: row.logo,
        meta: formatCardMeta(row.year, row.rating),
        ariaLabel: t("tv.aria.open", { name: row.name }),
      }))
      similarRail.setItems(items)
    }

    function onFavoritesChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "vod" || detail.id !== movieId) return
      renderActions()
    }

    function onWatchlistChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "vod" || detail.id !== movieId) return
      renderActions()
    }

    function onProgressChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "vod" || detail.id !== movieId) return
      renderActions()
    }

    function onDownloadsChanged(): void {
      renderActions()
    }

    function onLocaleChanged(): void {
      renderHero()
      renderActions()
      renderLanguageVariants(lastLanguageVariantsCatalog)
    }

    function onLanguageSettingsChanged(): void {
      renderLanguageVariants(lastLanguageVariantsCatalog)
    }

    document.addEventListener("xt:favorites-changed", onFavoritesChanged)
    document.addEventListener("xt:watchlist-changed", onWatchlistChanged)
    document.addEventListener("xt:progress-changed", onProgressChanged)
    document.addEventListener(DOWNLOADS_LIST_EVENT, onDownloadsChanged)
    document.addEventListener(DOWNLOAD_PROGRESS_EVENT, onDownloadsChanged)
    document.addEventListener(LOCALE_EVENT, onLocaleChanged)
    document.addEventListener(LANGUAGE_GROUPING_EVENT, onLanguageSettingsChanged)
    document.addEventListener(CONTENT_LANGUAGE_EVENT, onLanguageSettingsChanged)

    async function boot(): Promise<void> {
      if (!movieId) {
        chrome.setSkeleton(false)
        chrome.setHero({
          backdropUrl: null,
          posterUrl: null,
          title: t("detail.error.cantLoad"),
          subtitle: "",
          metaChips: [],
          description: t("detail.error.noMovieId"),
        })
        return
      }
      markLastOpenedEntry({ kind: "vod", id: movieId })

      const active = await getActiveEntry()
      if (destroyed) return
      if (!active) {
        chrome.setSkeleton(false)
        chrome.setHero({
          backdropUrl: null,
          posterUrl: null,
          title: t("detail.error.cantLoad"),
          subtitle: "",
          metaChips: [],
          description: t("detail.error.noPlaylist"),
        })
        return
      }

      activePlaylistId = active._id
      lastKnownPlaylistId = activePlaylistId
      await ensurePrefsLoaded()
      creds = await loadCreds()
      if (destroyed) return

      const cachedCatalog = (getCached(activePlaylistId, "vod")?.data || []) as CatalogRow[]
      const catalogRow = cachedCatalog.find((row) => Number(row.id) === movieId) || null
      movie = catalogRow || {
        id: movieId,
        name: stubName(),
        logo: null,
        year: "",
        rating: "",
        duration: "",
        category: "",
        plot: "",
        added: 0,
        tmdb: null,
      }

      chrome.setSkeleton(false)
      renderHero()
      renderActions()

      if (wantsAutoplay) {
        const cachedVodInfo = getCached(activePlaylistId, `vod_info_${movieId}`)?.data as any
        const cachedExt = cachedVodInfo?.movie_data?.container_extension || cachedVodInfo?.info?.container_extension
        if (typeof cachedExt === "string" && cachedExt) {
          containerExt = cachedExt.replace(/^\.+/, "").toLowerCase() || "mp4"
        }
        const savedProgress = getProgress(activePlaylistId, "vod", movieId)
        const canResumeAutoplay = !!savedProgress && !savedProgress.completed && savedProgress.position > RESUME_MIN_SECONDS
        void startPlayback(canResumeAutoplay ? savedProgress.position : 0)
      }

      // Language pills and the similar rail both walk the whole catalog; the hero must be on screen first.
      void nextPaint().then(() => {
        if (!destroyed) void loadSimilar()
      })

      const requestId = ++enrichRequestId
      await hydrateCache(activePlaylistId, `vod_info_${movieId}`)
      if (destroyed || requestId !== enrichRequestId) return
      const cachedInfo = getCached(activePlaylistId, `vod_info_${movieId}`)?.data
      if (cachedInfo) applyVodInfo(cachedInfo)

      if (creds.host && creds.user && creds.pass) {
        try {
          const response = await xtreamApiFetch("get_vod_info", { vod_id: String(movieId) })
          if (!response.ok) throw new Error(await response.text())
          const data = await response.json()
          if (destroyed || requestId !== enrichRequestId) return
          setCached(activePlaylistId, `vod_info_${movieId}`, data, VOD_INFO_TTL_MS)
          applyVodInfo(data)
        } catch (err) {
          log.warn("[xt:tv-movie-detail] vod_info fetch failed:", err)
        }
      }

      await enrichHero(requestId)
    }

    void boot()

    return () => {
      destroyed = true
      document.removeEventListener("xt:favorites-changed", onFavoritesChanged)
      document.removeEventListener("xt:watchlist-changed", onWatchlistChanged)
      document.removeEventListener("xt:progress-changed", onProgressChanged)
      document.removeEventListener(DOWNLOADS_LIST_EVENT, onDownloadsChanged)
      document.removeEventListener(DOWNLOAD_PROGRESS_EVENT, onDownloadsChanged)
      document.removeEventListener(LOCALE_EVENT, onLocaleChanged)
      document.removeEventListener(LANGUAGE_GROUPING_EVENT, onLanguageSettingsChanged)
      document.removeEventListener(CONTENT_LANGUAGE_EVENT, onLanguageSettingsChanged)
      unregisterLanguageVariantsSection()
      similarRail.destroy()
      chrome.destroy()
    }
  },
}

export default view
