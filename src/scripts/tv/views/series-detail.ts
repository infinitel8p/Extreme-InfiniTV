// Android TV series detail view (route: /tv/series/detail?id=<series_id>&season=&episode=).

import { nextPaint, type TvView, type TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT, getActiveLocale } from "@/scripts/lib/i18n"
import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
import { getCached } from "@/scripts/lib/cache.js"
import { ensureSeries } from "@/scripts/lib/catalog.js"
import { requestSeriesInfo } from "@/scripts/lib/series-seasons.ts"
import { loadSeriesEpisodes } from "@/scripts/lib/tv-cast-episode.ts"
import { flattenSeriesEpisodes, resolveSeriesNextUp, type SeriesEpisodeEntry } from "@/scripts/lib/tv-cast-next.ts"
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  isCompleted,
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
import { resolveTmdbId, fetchSeriesEnrichment } from "@/scripts/lib/tmdb-enrich.ts"
import { parseProviderTmdbId, type TvdbSeasonRef } from "@/scripts/lib/tvdb-proxy.ts"
import type { TvdbEpisode } from "@/scripts/lib/tvdb-contract"
import {
  fillHeroGaps,
  heroFieldsNeedFill,
  resolveTvdbFallback,
  resolveTvdbSeason,
  patchEpisodeFromTvdb,
  type DetailHeroFields,
} from "@/scripts/tv/detail-enrich.ts"
import { isGenericEpisodeTitle } from "@/scripts/lib/episode-title.ts"
import { isTmdbActive, LANGUAGE_GROUPING_EVENT, CONTENT_LANGUAGE_EVENT } from "@/scripts/lib/app-settings.js"
import { fmtImdbRating, ratingSortValue, formatPaddedHms } from "@/scripts/lib/format.ts"
import { parseNamePrefix, languageTagLabel, prefixQualityTokens } from "@/scripts/lib/language-tags.ts"
import { playEpisode } from "@/scripts/tv/playback"
import { createDetailChrome, type DetailAction } from "@/scripts/tv/ui/detail"
import { createRail } from "@/scripts/tv/ui/rail"
import { formatCardMeta, type PosterCardItem } from "@/scripts/tv/ui/card"
import { registerFocusSection, keepFocusedInView, remPx } from "@/scripts/tv/focus"
import { STAR_OUTLINE, STAR_FILLED, BOOKMARK_FILLED } from "@/scripts/lib/entry-card.ts"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { ICON_PLAYER_PLAY, ICON_DOWNLOAD, ICON_CHECK } from "@/scripts/lib/icons"
import { toast } from "@/scripts/lib/toast"
import { confirmDialog } from "@/scripts/lib/confirm-dialog"
import { log } from "@/scripts/lib/log"
import { renderLanguagePills, type GroupingIndexLookup } from "@/scripts/lib/detail-chrome.ts"
import { getSharedGroupingIndex } from "@/scripts/lib/language-groups.ts"

const RESUME_MIN_SECONDS = 30
const SIMILAR_LIMIT = 20
const SIMILAR_FOCUS_SECTION_ID = "tv-detail-similar"
const SEASONS_FOCUS_SECTION_ID = "tv-detail-seasons"
const EPISODES_FOCUS_SECTION_ID = "tv-detail-episodes"
const EPISODES_VERTICAL_OFFSET_REM = 10
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
  category: string
  plot: string
  added: number
  tmdb: number | null
  genre: string
}

interface Creds {
  host: string
  port: string
  user: string
  pass: string
}

interface EpisodeRow extends SeriesEpisodeEntry {
  durationText: string
  thumbUrl: string | null
  plot: string
}

function episodeFocusKey(season: number, episodeNum: number): string {
  return `ep:${season}:${episodeNum}`
}

// Number("") is 0, not NaN, so an explicit empty/present check is needed to keep season 0 (specials).
function parseDeepLinkNumber(raw: string | null): number | null {
  const parsed = Number(raw)
  return raw !== null && raw !== "" && Number.isFinite(parsed) ? parsed : null
}

function durationTextFromInfo(info: any): string {
  if (info?.duration) return String(info.duration)
  const seconds = Number(info?.duration_secs || 0)
  return seconds > 0 ? formatPaddedHms(seconds) : ""
}

function collectRawEpisodes(seriesInfo: any): any[] {
  const episodes = seriesInfo?.episodes
  if (!episodes) return []
  if (Array.isArray(episodes)) return episodes
  if (typeof episodes === "object") {
    return Object.values(episodes).flatMap((seasonEpisodes) => (Array.isArray(seasonEpisodes) ? seasonEpisodes : []))
  }
  return []
}

const view: TvView = {
  mount(root: HTMLElement, ctx: TvViewContext) {
    const seriesId = Number(ctx.url.searchParams.get("id") || "0")
    const deepLinkSeason = parseDeepLinkNumber(ctx.url.searchParams.get("season"))
    const deepLinkEpisode = parseDeepLinkNumber(ctx.url.searchParams.get("episode"))

    const chrome = createDetailChrome(root)

    const languageVariantsRow = document.createElement("div")
    languageVariantsRow.id = LANGUAGE_VARIANTS_FOCUS_SECTION_ID
    languageVariantsRow.hidden = true
    languageVariantsRow.setAttribute("aria-label", t("detail.lang.title"))
    languageVariantsRow.className = "flex flex-wrap gap-2"
    const getGroupingIndexFor: GroupingIndexLookup = (_playlistId, catalog) => getSharedGroupingIndex(catalog)

    const seasonsSection = document.createElement("section")
    seasonsSection.id = SEASONS_FOCUS_SECTION_ID
    seasonsSection.className = "flex gap-2 overflow-x-auto"
    seasonsSection.hidden = true

    const episodesScroller = document.createElement("div")
    episodesScroller.id = EPISODES_FOCUS_SECTION_ID
    episodesScroller.className = "overflow-hidden"
    const episodesTrack = document.createElement("div")
    episodesTrack.className = "flex flex-col gap-2"
    episodesScroller.appendChild(episodesTrack)

    const similarRail = createRail({ title: t("tv.detail.similar"), focusSectionId: SIMILAR_FOCUS_SECTION_ID })
    similarRail.setLoading()

    chrome.sections.append(languageVariantsRow, seasonsSection, episodesScroller, similarRail.el)

    const unregisterLanguageVariantsSection = registerFocusSection(
      LANGUAGE_VARIANTS_FOCUS_SECTION_ID,
      languageVariantsRow
    )
    const unregisterSeasonsSection = registerFocusSection(SEASONS_FOCUS_SECTION_ID, seasonsSection, {
      enterTo: "last-focused",
    })
    const unregisterEpisodesSection = registerFocusSection(EPISODES_FOCUS_SECTION_ID, episodesScroller, {
      enterTo: "last-focused",
    })
    const unregisterKeepInView = keepFocusedInView(episodesScroller, "y", () => remPx(EPISODES_VERTICAL_OFFSET_REM))

    let destroyed = false
    let activePlaylistId = ""
    let creds: Creds = { host: "", port: "", user: "", pass: "" }
    let series: CatalogRow | null = null
    let seriesInfoRaw: any = null
    let episodes: EpisodeRow[] = []
    let currentSeason: number | null = deepLinkSeason
    let nextUp: Awaited<ReturnType<typeof resolveSeriesNextUp>> = null
    let heroBackdropUrl: string | null = null
    let heroOverview = ""
    let heroGenres = ""
    let heroRatingText = ""
    let heroYearText = ""
    let enrichRequestId = 0
    let resolvedTmdbId: number | null = null
    let resolvedTvdbId: number | null = null
    let providerTmdbIdForTvdb: number | null = null
    let seasonEnrichRequestId = 0
    let focusedDeepLinkOnce = deepLinkSeason == null
    let focusedPrimaryOnce = false
    let focusPlaced = false
    let lastLanguageVariantsCatalog: CatalogRow[] = []

    function stubName(): string {
      return t("list.seriesFallback", { id: seriesId })
    }

    function seasonNumbers(): number[] {
      return [...new Set(episodes.map((entry) => entry.season))].sort((left, right) => left - right)
    }

    function episodesForCurrentSeason(): EpisodeRow[] {
      if (currentSeason == null) return []
      return episodes.filter((entry) => entry.season === currentSeason).sort((left, right) => left.episodeNum - right.episodeNum)
    }

    function renderHero(): void {
      if (!series) return
      const languageTag = parseNamePrefix(series.name).tag
      const languageLabel = languageTag ? languageTagLabel(languageTag, getActiveLocale()) : ""
      const qualityLabel = prefixQualityTokens(series.name).join(" ")
      const seasonsCount = seasonNumbers().length
      const seasonsText = seasonsCount ? t("series.seasonsCount", { count: seasonsCount }) : ""

      chrome.setHero({
        backdropUrl: heroBackdropUrl,
        posterUrl: series.logo,
        title: series.name,
        subtitle: [heroYearText || series.year, seasonsText, heroGenres || series.genre].filter(Boolean).join(" · "),
        metaChips: [languageLabel, qualityLabel],
        description: heroOverview || series.plot || t("detail.noDescription"),
        rating: heroRatingText || fmtImdbRating(series.rating) || null,
      })
    }

    function findExistingEpisodeDownload(episodeId: string | number) {
      return listDownloads().find(
        (download: any) => download.source?.kind === "episode" && Number(download.source?.id) === Number(episodeId)
      )
    }

    async function startEpisodePlayback(entry: EpisodeRow, resumeSeconds: number): Promise<void> {
      if (!series || !activePlaylistId) return
      await playEpisode(
        {
          playlistId: activePlaylistId,
          seriesId,
          season: entry.season,
          episodeNum: entry.episodeNum,
          episodeId: entry.id,
          title: entry.title || t("series.episode.fallback", { n: entry.episodeNum }),
          seriesName: series.name,
          logo: series.logo,
          containerExt: entry.containerExt,
          resumeSeconds,
        },
        { onEnded: () => void refreshNextUp() }
      )
    }

    function downloadLabel(episodeId: string | number | null): string {
      if (!isDownloadable() || episodeId == null) return t("detail.action.download")
      const existing = findExistingEpisodeDownload(episodeId)
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

    async function onDownloadActivate(): Promise<void> {
      if (!series || !nextUp || !isDownloadable() || !creds.host || !creds.user || !creds.pass) return
      const existing = findExistingEpisodeDownload(nextUp.episodeId)
      if (existing?.status === "downloading" || existing?.status === "queued") {
        pauseDownload(existing.id)
        return
      }
      if (existing && ["paused", "stalled", "error"].includes(existing.status)) {
        resumeDownload(existing.id)
        return
      }
      if (existing?.status === "done") return

      const episodeTitle = nextUp.title || t("series.episode.fallback", { n: nextUp.episodeNum })
      const confirmed = await confirmDialog({
        title: t("detail.action.download"),
        message: t("tv.detail.downloadConfirm", { title: `${series.name} - S${nextUp.season}E${nextUp.episodeNum}` }),
      })
      if (!confirmed) return

      const { buildSeriesStreamUrl } = await import("@/scripts/lib/stream-urls.ts")
      const src = buildSeriesStreamUrl(creds, nextUp.episodeId, nextUp.containerExt)
      try {
        await startDownload({
          url: src,
          title: `${series.name} - S${nextUp.season}E${nextUp.episodeNum}${episodeTitle ? " - " + episodeTitle : ""}`,
          ext: nextUp.containerExt || inferExt(src, "mp4"),
          source: {
            kind: "episode",
            playlistId: activePlaylistId,
            id: nextUp.episodeId,
            seriesId,
            seriesName: series.name,
            season: nextUp.season,
            episode: nextUp.episodeNum,
            logo: series.logo,
          },
          nfo: null,
        })
        toast({ title: t("detail.download.starting") })
      } catch (err) {
        log.error("[xt:tv-series-detail] download failed:", err)
        toast({ title: t("detail.download.failed"), variant: "error" })
      }
    }

    function renderActions(): void {
      if (!series || destroyed) return
      const favorite = activePlaylistId ? isFavorite(activePlaylistId, "series", seriesId) : false
      const onWatchlist = activePlaylistId ? isOnWatchlist(activePlaylistId, "series", seriesId) : false

      const actions: DetailAction[] = []

      if (nextUp) {
        const playTarget = nextUp
        const isContinuing = playTarget.resumeSeconds > RESUME_MIN_SECONDS
        const episodeTitle = playTarget.title || t("series.episode.fallback", { n: playTarget.episodeNum })
        actions.push({
          id: "play",
          label: isContinuing
            ? t("detail.action.continue")
            : t("tv.detail.playEpisode", { season: playTarget.season, episode: playTarget.episodeNum, title: episodeTitle }),
          icon: ICON_PLAYER_PLAY,
          primary: true,
          onActivate: () => {
            const entry = episodes.find((row) => String(row.id) === String(playTarget.episodeId))
            if (entry) void startEpisodePlayback(entry, playTarget.resumeSeconds)
          },
        })
      }

      actions.push(
        {
          id: "favorite",
          label: favorite ? t("detail.action.removeFavorite") : t("detail.action.addFavorite"),
          icon: favorite ? STAR_FILLED : STAR_OUTLINE,
          pressed: favorite,
          onActivate: () => {
            if (!series || !activePlaylistId) return
            toggleFavorite(activePlaylistId, "series", seriesId, { name: series.name, logo: series.logo })
            renderActions()
          },
        },
        {
          id: "watchlist",
          label: onWatchlist ? t("detail.action.removeWatchlist") : t("detail.action.watchLater"),
          icon: onWatchlist ? BOOKMARK_FILLED : ICON_BOOKMARK_OUTLINE,
          pressed: onWatchlist,
          onActivate: () => {
            if (!series || !activePlaylistId) return
            toggleWatchlist(activePlaylistId, "series", seriesId, { name: series.name, logo: series.logo })
            renderActions()
          },
        },
        {
          id: "download",
          label: downloadLabel(nextUp?.episodeId ?? null),
          icon: ICON_DOWNLOAD,
          disabled: !isDownloadable() || !nextUp,
          pressed: nextUp ? findExistingEpisodeDownload(nextUp.episodeId)?.status === "done" : false,
          onActivate: () => void onDownloadActivate(),
        }
      )

      chrome.setActions(actions)

      if (!focusedPrimaryOnce && focusedDeepLinkOnce) {
        focusedPrimaryOnce = true
        requestAnimationFrame(() => {
          if (focusPlaced) return
          const target = chrome.el.querySelector<HTMLElement>("[data-tv-autofocus]")
          if (!target) return
          focusPlaced = true
          target.focus()
        })
      }
    }

    function buildEpisodeButton(entry: EpisodeRow): HTMLButtonElement {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.focusKey = episodeFocusKey(entry.season, entry.episodeNum)
      button.className =
        "relative flex min-h-[4.5rem] items-center gap-3 rounded-xl p-2 text-left outline-none transition-colors " +
        "hover:bg-surface-2 tv-focus-inset"

      const thumbWrap = document.createElement("div")
      thumbWrap.className = "relative isolate aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-black/40"
      if (entry.thumbUrl) {
        const img = document.createElement("img")
        img.alt = ""
        img.loading = "lazy"
        img.decoding = "async"
        img.className = "block h-full w-full object-cover"
        thumbWrap.appendChild(img)
        mountCachedImage(img, entry.thumbUrl, "poster")
      }

      const saved = activePlaylistId ? getProgress(activePlaylistId, "episode", entry.id) : null
      const fraction = saved && saved.duration > 0 ? Math.max(0, Math.min(1, saved.position / saved.duration)) : 0
      if (fraction > 0) {
        const progressTrack = document.createElement("div")
        progressTrack.className = "absolute inset-x-0 bottom-0 h-1 bg-black/55"
        const progressFill = document.createElement("div")
        progressFill.className = "h-full bg-accent"
        progressFill.style.width = `${fraction * 100}%`
        progressTrack.appendChild(progressFill)
        thumbWrap.appendChild(progressTrack)
      }
      if (activePlaylistId && isCompleted(activePlaylistId, "episode", entry.id)) {
        const watchedBadge = document.createElement("span")
        watchedBadge.className =
          "absolute right-1.5 top-1.5 inline-flex items-center justify-center rounded-md bg-accent px-1.5 py-0.5 text-bg"
        watchedBadge.innerHTML = ICON_CHECK
        thumbWrap.appendChild(watchedBadge)
      }

      const textWrap = document.createElement("div")
      textWrap.className = "min-w-0 flex-1"
      const titleEl = document.createElement("div")
      titleEl.className = "truncate text-sm font-medium text-fg"
      titleEl.textContent = `E${entry.episodeNum} · ${entry.title || t("series.episode.fallback", { n: entry.episodeNum })}`
      const metaEl = document.createElement("div")
      metaEl.className = "truncate text-xs text-fg-3"
      metaEl.textContent = entry.durationText
      textWrap.append(titleEl, metaEl)

      button.append(thumbWrap, textWrap)
      button.addEventListener("click", () => {
        const resumeSeconds = fraction > 0 && !isCompleted(activePlaylistId, "episode", entry.id) ? saved?.position || 0 : 0
        void startEpisodePlayback(entry, resumeSeconds)
      })
      return button
    }

    function renderSeasons(): void {
      const seasons = seasonNumbers()
      seasonsSection.hidden = seasons.length < 2
      seasonsSection.replaceChildren()
      for (const seasonNumber of seasons) {
        const chip = document.createElement("button")
        chip.type = "button"
        chip.dataset.focusKey = `season:${seasonNumber}`
        const active = seasonNumber === currentSeason
        chip.className =
          "shrink-0 rounded-full border min-h-9 px-3 py-1.5 text-sm font-medium outline-none transition-colors tv-focus-inset " +
          (active ? "border-accent text-accent" : "border-line text-fg-2 hover:text-fg")
        chip.textContent = t("series.season", { n: seasonNumber })
        chip.setAttribute("aria-current", String(active))
        chip.addEventListener("click", () => {
          if (currentSeason === seasonNumber) return
          currentSeason = seasonNumber
          renderSeasons()
          renderEpisodes()
          void enrichSeasonFromTvdb(seasonNumber)
        })
        seasonsSection.appendChild(chip)
      }
    }

    function renderEpisodes(): void {
      episodesTrack.replaceChildren()
      const seasonEpisodes = episodesForCurrentSeason()
      if (!seasonEpisodes.length) {
        const empty = document.createElement("p")
        empty.className = "px-2 text-fg-3"
        empty.textContent = t("series.episodes.empty")
        episodesTrack.appendChild(empty)
        return
      }
      for (const entry of seasonEpisodes) episodesTrack.appendChild(buildEpisodeButton(entry))

      if (!focusedDeepLinkOnce && deepLinkSeason != null && currentSeason === deepLinkSeason) {
        focusedDeepLinkOnce = true
        const targetKey = episodeFocusKey(deepLinkSeason, deepLinkEpisode ?? seasonEpisodes[0].episodeNum)
        requestAnimationFrame(() => {
          if (focusPlaced) return
          const target = episodesTrack.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(targetKey)}"]`)
          if (!target) return
          focusPlaced = true
          target.focus()
        })
      }
    }

    async function refreshNextUp(): Promise<void> {
      if (!activePlaylistId) return
      try {
        nextUp = await resolveSeriesNextUp(activePlaylistId, seriesId)
      } catch (err) {
        log.warn("[xt:tv-series-detail] resolveSeriesNextUp failed:", err)
        nextUp = null
      }
      if (destroyed) return
      renderActions()
    }

    function applySeriesInfo(data: any): void {
      seriesInfoRaw = data
      const info = data?.info || {}

      const apiName = info.name || info.title || ""
      if (apiName && series && (!series.name || series.name === stubName())) series.name = apiName

      const apiPoster = info.cover || info.cover_big || info.movie_image || null
      if (apiPoster && series && !series.logo) series.logo = apiPoster

      const backdropPath = info.backdrop_path
      heroBackdropUrl = Array.isArray(backdropPath) ? backdropPath[0] || null : backdropPath || null

      heroYearText = String(info.releaseDate || info.releasedate || info.year || "").match(/\d{4}/)?.[0] || ""
      heroRatingText = fmtImdbRating(info.rating || info.rating_5based)
      heroGenres = String(info.genre || info.category || "")
      heroOverview = String(info.plot || info.description || "")

      const rawById = new Map(collectRawEpisodes(data).map((raw) => [String(raw.id), raw]))
      episodes = flattenSeriesEpisodes(data).map((entry) => {
        const raw = rawById.get(String(entry.id))
        const rawInfo = raw?.info || {}
        return {
          ...entry,
          durationText: durationTextFromInfo(rawInfo),
          thumbUrl: rawInfo.movie_image || null,
          plot: String(rawInfo.plot || ""),
        }
      })

      if (currentSeason == null || !seasonNumbers().includes(currentSeason)) {
        currentSeason = seasonNumbers()[0] ?? null
      }
      // A deep-linked season/episode that no longer exists must not block the primary-action autofocus fallback.
      if (!focusedDeepLinkOnce && deepLinkSeason != null && currentSeason !== deepLinkSeason) {
        focusedDeepLinkOnce = true
      }

      renderHero()
      renderSeasons()
      renderEpisodes()
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

    async function enrichFromTmdb(requestId: number): Promise<void> {
      if (!series || !activePlaylistId || !isTmdbActive()) return
      try {
        const tmdbId = await resolveTmdbId(activePlaylistId, "series", {
          id: series.id,
          name: series.name,
          year: series.year || null,
          providerTmdbId: series.tmdb,
        })
        if (requestId !== enrichRequestId) return
        resolvedTmdbId = tmdbId
        if (!tmdbId) return
        const enrichment = await fetchSeriesEnrichment(tmdbId)
        if (requestId !== enrichRequestId || !enrichment) return
        applyHeroFields(fillHeroGaps(currentHeroFields(), enrichment))
        if (!series.logo && enrichment.posterUrl) series.logo = enrichment.posterUrl
        renderHero()
      } catch (err) {
        log.warn("[xt:tv-series-detail] TMDb enrichment failed:", err)
      }
    }

    function episodeNeedsTvdbFill(entry: EpisodeRow): boolean {
      const fallbackTitle = t("series.episode.fallback", { n: entry.episodeNum })
      return isGenericEpisodeTitle(entry.title, { seriesName: series?.name, fallbackTitle }) || !entry.thumbUrl || !entry.plot
    }

    function patchSeasonEpisodesFromTvdb(seasonNumber: number, tvdbEpisodes: TvdbEpisode[]): void {
      if (!series || !tvdbEpisodes.length) return
      const byNumber = new Map(tvdbEpisodes.map((episode) => [episode.episodeNumber, episode]))
      let changed = false
      episodes = episodes.map((entry) => {
        if (entry.season !== seasonNumber) return entry
        const tvdbEpisode = byNumber.get(entry.episodeNum)
        if (!tvdbEpisode) return entry
        const fallbackTitle = t("series.episode.fallback", { n: entry.episodeNum })
        const isGenericTitle = isGenericEpisodeTitle(entry.title, { seriesName: series?.name, fallbackTitle })
        const patched = patchEpisodeFromTvdb(
          { title: entry.title ?? null, thumbUrl: entry.thumbUrl, plot: entry.plot },
          tvdbEpisode,
          isGenericTitle
        )
        if (patched.title === entry.title && patched.thumbUrl === entry.thumbUrl && patched.plot === entry.plot) return entry
        changed = true
        return { ...entry, title: patched.title, thumbUrl: patched.thumbUrl, plot: patched.plot }
      })
      if (changed && currentSeason === seasonNumber) renderEpisodes()
    }

    // Re-run per season shown (initial paint, season switch), since TheTVDB models broadcast
    // seasons TMDb files as one flat run and providers can leave episode titles/thumbs empty.
    async function enrichSeasonFromTvdb(seasonNumber: number): Promise<void> {
      if (!series || !activePlaylistId) return
      const seasonRef: TvdbSeasonRef = resolvedTvdbId
        ? { tvdbId: resolvedTvdbId }
        : { tmdbId: resolvedTmdbId ?? providerTmdbIdForTvdb }
      if (!seasonRef.tvdbId && !seasonRef.tmdbId) return
      const seasonEpisodes = episodes.filter((entry) => entry.season === seasonNumber)
      if (!seasonEpisodes.length || !seasonEpisodes.some(episodeNeedsTvdbFill)) return
      const requestId = ++seasonEnrichRequestId
      const tvdbEpisodes = await resolveTvdbSeason(seasonRef, seasonNumber)
      if (destroyed || requestId !== seasonEnrichRequestId) return
      patchSeasonEpisodesFromTvdb(seasonNumber, tvdbEpisodes)
    }

    // No isTmdbActive() gate: the TheTVDB proxy enriches without a user key.
    async function enrichFromTvdb(requestId: number): Promise<void> {
      if (!series || !activePlaylistId) return
      const info = seriesInfoRaw?.info || {}
      providerTmdbIdForTvdb = resolvedTmdbId ?? parseProviderTmdbId(info) ?? series.tmdb ?? null

      if (heroFieldsNeedFill(currentHeroFields())) {
        const filled = await resolveTvdbFallback(providerTmdbIdForTvdb, "series", {
          name: series.name,
          year: parseInt(String(series.year), 10) || null,
        })
        if (requestId === enrichRequestId && filled) {
          resolvedTvdbId = filled.tvdbId
          applyHeroFields(fillHeroGaps(currentHeroFields(), filled.enrichment))
          if (!series.logo && filled.enrichment.posterUrl) series.logo = filled.enrichment.posterUrl
          renderHero()
        }
      }
      if (requestId !== enrichRequestId) return
      if (currentSeason != null) void enrichSeasonFromTvdb(currentSeason)
    }

    function renderLanguageVariants(catalog: CatalogRow[]): void {
      lastLanguageVariantsCatalog = catalog
      if (!series) return
      renderLanguagePills({
        langsEl: languageVariantsRow,
        item: { id: Number(series.id), name: series.name },
        kind: "series",
        activePlaylistId,
        catalog,
        getGroupingIndexFor,
        detailHrefBase: "/tv/series/detail",
      })
    }

    async function loadSimilar(): Promise<void> {
      if (!series || !activePlaylistId) return
      const currentSeries = series
      let catalog = (getCached(activePlaylistId, "series")?.data || []) as CatalogRow[]
      if (!catalog.length) {
        try {
          catalog = await ensureSeries(creds, activePlaylistId)
        } catch (err) {
          log.warn("[xt:tv-series-detail] similar catalog load failed:", err)
          catalog = []
        }
      }
      if (destroyed) return
      renderLanguageVariants(catalog)
      const candidates = catalog
        .filter((row) => row.id !== currentSeries.id && (!currentSeries.category || row.category === currentSeries.category))
        .sort((left, right) => ratingSortValue(right.rating) - ratingSortValue(left.rating))
        .slice(0, SIMILAR_LIMIT)

      const items: PosterCardItem[] = candidates.map((row) => ({
        railId: SIMILAR_FOCUS_SECTION_ID,
        kind: "series",
        id: row.id,
        name: row.name,
        href: `/tv/series/detail?id=${encodeURIComponent(String(row.id))}`,
        posterUrl: row.logo,
        meta: formatCardMeta(row.year, row.rating),
        ariaLabel: t("tv.aria.open", { name: row.name }),
      }))
      similarRail.setItems(items)
    }

    function onFavoritesChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "series" || detail.id !== seriesId) return
      renderActions()
    }

    function onWatchlistChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "series" || detail.id !== seriesId) return
      renderActions()
    }

    function onProgressChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== activePlaylistId || detail.kind !== "episode") return
      if (!episodes.some((entry) => String(entry.id) === String(detail.id))) return
      renderEpisodes()
      void refreshNextUp()
    }

    function onDownloadsChanged(): void {
      renderActions()
    }

    function onLocaleChanged(): void {
      renderHero()
      renderSeasons()
      renderEpisodes()
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
      if (!seriesId) {
        chrome.setSkeleton(false)
        chrome.setHero({
          backdropUrl: null,
          posterUrl: null,
          title: t("detail.error.cantLoadSeries"),
          subtitle: "",
          metaChips: [],
          description: t("detail.error.noSeriesId"),
        })
        return
      }

      const active = await getActiveEntry()
      if (destroyed) return
      if (!active) {
        chrome.setSkeleton(false)
        chrome.setHero({
          backdropUrl: null,
          posterUrl: null,
          title: t("detail.error.cantLoadSeries"),
          subtitle: "",
          metaChips: [],
          description: t("detail.error.noPlaylist"),
        })
        return
      }

      activePlaylistId = active._id
      await ensurePrefsLoaded()
      creds = await loadCreds()
      if (destroyed) return

      const cachedCatalog = (getCached(activePlaylistId, "series")?.data || []) as CatalogRow[]
      const catalogRow = cachedCatalog.find((row) => Number(row.id) === seriesId) || null
      series = catalogRow || {
        id: seriesId,
        name: stubName(),
        logo: null,
        year: "",
        rating: "",
        category: "",
        plot: "",
        added: 0,
        tmdb: null,
        genre: "",
      }

      chrome.setSkeleton(false)
      renderHero()
      void refreshNextUp()

      // Language pills and the similar rail both walk the whole catalog; the hero must be on screen first.
      void nextPaint().then(() => {
        if (!destroyed) void loadSimilar()
      })

      const requestId = ++enrichRequestId
      const cachedInfo = getCached(activePlaylistId, `series_info_${seriesId}`)?.data
      if (cachedInfo) applySeriesInfo(cachedInfo)

      try {
        const data = await requestSeriesInfo(activePlaylistId, seriesId)
        if (destroyed || requestId !== enrichRequestId) return
        if (data) applySeriesInfo(data)
      } catch (err) {
        log.warn("[xt:tv-series-detail] series_info fetch failed:", err)
      }

      // loadSeriesEpisodes/flattenSeriesEpisodes power resolveSeriesNextUp's own lookup;
      // touching them here keeps their cache warm for the neighbor-episode helpers.
      void loadSeriesEpisodes(activePlaylistId, seriesId)

      await enrichFromTmdb(requestId)
      if (destroyed || requestId !== enrichRequestId) return
      void enrichFromTvdb(requestId)
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
      unregisterSeasonsSection()
      unregisterEpisodesSection()
      unregisterKeepInView()
      similarRail.destroy()
      chrome.destroy()
    }
  },
}

export default view
