// TV search: one input feeding three ranked rails (channels, movies, series).
import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  getRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
  EVT_SEARCH_RECENT_CHANGED,
} from "@/scripts/lib/preferences.js"
import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels, ensureOverridesReady } from "@/scripts/lib/live-catalog.ts"
import { normalize, scoreNormMatch } from "@/scripts/lib/text.js"
import { kindLabel } from "@/scripts/lib/kinds.ts"
import { ICON_SEARCH } from "@/scripts/lib/icons.js"
import { registerFocusSection, keepFocusedInView } from "@/scripts/tv/focus"
import { createRail, type RailHandle } from "@/scripts/tv/ui/rail"
import { formatCardMeta, type LiveCardItem, type PosterCardItem } from "@/scripts/tv/ui/card"
import { playLive, type TvLiveChannel } from "@/scripts/tv/playback"

// Matches catalog.js's CATALOG_WARMED_EVENT - kept as a string so this view doesn't
// statically import the whole fetch stack just to know when it's stale.
const CATALOG_WARMED_EVENT = "xt:catalog-warmed"

const SEARCH_DEBOUNCE_MS = 200
const MIN_QUERY_LENGTH = 2
const RESULT_CAP = 30

interface CatalogRow {
  id: number | string
  name?: string
  logo?: string | null
  category?: string | null
  rating?: unknown
  year?: string | number | null
  norm?: string
}

interface LiveRow extends CatalogRow {
  url?: string | null
  userAgent?: string | null
  referer?: string | null
  tvgId?: string | null
  tvgShift?: number | null
}

function toTvLiveChannel(row: LiveRow & { norm: string }): TvLiveChannel {
  return {
    id: row.id,
    name: row.name || "",
    logo: row.logo ?? null,
    url: row.url ?? null,
    userAgent: row.userAgent ?? null,
    referer: row.referer ?? null,
    tvgId: row.tvgId ?? null,
    tvgShift: row.tvgShift ?? null,
  }
}

function withNorm<T extends { name?: string; category?: string | null; norm?: string }>(row: T): T & { norm: string } {
  return { ...row, norm: row.norm || normalize(`${row.name || ""} ${row.category || ""}`) }
}

function rankRows<T extends { norm: string }>(rows: T[], tokens: string[]): T[] {
  const scored: Array<{ row: T; score: number }> = []
  for (const row of rows) {
    const score = scoreNormMatch(row.norm, tokens)
    if (score > 0) scored.push({ row, score })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, RESULT_CAP).map((entry) => entry.row)
}

function metaForCatalogRow(row: CatalogRow): string {
  return formatCardMeta(row.year, row.rating)
}

const view: TvView = {
  mount(root: HTMLElement, ctx: TvViewContext) {
    const scroller = document.createElement("div")
    scroller.className = "h-full overflow-hidden"
    const track = document.createElement("div")
    track.className = "flex flex-col gap-8 pt-8 pb-20"
    scroller.appendChild(track)
    root.appendChild(scroller)

    const inputWrap = document.createElement("div")
    inputWrap.className = "px-12"
    const inputBox = document.createElement("div")
    inputBox.className = "flex h-[3.75rem] items-center gap-3 rounded-2xl bg-surface-2 px-5 tv-focus-inset-within"
    const searchIcon = document.createElement("span")
    searchIcon.setAttribute("aria-hidden", "true")
    searchIcon.className = "shrink-0 text-fg-3"
    searchIcon.innerHTML = ICON_SEARCH
    const inputEl = document.createElement("input")
    inputEl.type = "search"
    inputEl.autocomplete = "off"
    inputEl.spellcheck = false
    inputEl.dataset.tvAutofocus = ""
    inputEl.dataset.focusKey = "search:input"
    inputEl.className =
      "h-full min-w-0 flex-1 rounded-2xl bg-transparent text-lg text-fg outline-none placeholder:text-fg-3"
    inputBox.append(searchIcon, inputEl)
    inputWrap.appendChild(inputBox)

    const recentWrap = document.createElement("div")
    recentWrap.className = "flex flex-col gap-2 px-12"
    recentWrap.hidden = true
    const recentHead = document.createElement("div")
    recentHead.className = "flex items-center justify-between gap-3"
    const recentHeading = document.createElement("span")
    recentHeading.className = "text-eyebrow font-medium uppercase tracking-wide text-fg-3"
    const recentClear = document.createElement("button")
    recentClear.type = "button"
    recentClear.dataset.focusKey = "search:recent:clear"
    recentClear.className =
      "rounded-lg px-2 py-1 text-sm text-fg-3 outline-none transition-colors hover:text-fg focus-visible:text-fg tv-focus-inset"
    recentHead.append(recentHeading, recentClear)
    const recentTrack = document.createElement("div")
    recentTrack.className = "flex flex-wrap gap-2"
    recentWrap.append(recentHead, recentTrack)

    const statusEl = document.createElement("p")
    statusEl.className = "px-12 text-fg-3"
    statusEl.hidden = true

    track.append(inputWrap, recentWrap, statusEl)

    let channelsRail: RailHandle | null = null
    let moviesRail: RailHandle | null = null
    let seriesRail: RailHandle | null = null

    function createRails(): void {
      channelsRail = createRail({ title: t("search.results.live"), focusSectionId: "tv-search-channels" })
      moviesRail = createRail({ title: t("search.results.vod"), focusSectionId: "tv-search-movies" })
      seriesRail = createRail({ title: t("search.results.series"), focusSectionId: "tv-search-series" })
      track.append(channelsRail.el, moviesRail.el, seriesRail.el)
      channelsRail.el.addEventListener("click", commitCurrentSearch)
      moviesRail.el.addEventListener("click", commitCurrentSearch)
      seriesRail.el.addEventListener("click", commitCurrentSearch)
    }

    const offsetPx = Math.round(root.clientHeight * 0.4) || 240
    const unregisterKeepInView = keepFocusedInView(scroller, "y", offsetPx)
    const unregisterInputSection = registerFocusSection("tv-search-input", inputWrap)
    const unregisterRecentSection = registerFocusSection("tv-search-recent", recentWrap, {
      enterTo: "last-focused",
      restrict: "self-first",
    })

    let destroyed = false
    let activePlaylistId = ""
    let channels: Array<LiveRow & { norm: string }> = []
    let movies: Array<CatalogRow & { norm: string }> = []
    let series: Array<CatalogRow & { norm: string }> = []
    let recentSearches: Array<{ text: string; ts: number }> = []
    let indexReady = false
    let isWarming = false
    let warmupRequested = false
    let currentQuery = ""
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

    function commitCurrentSearch(): void {
      if (currentQuery) pushRecentSearch(activePlaylistId, currentQuery)
    }

    function setStatus(text: string): void {
      statusEl.hidden = !text
      statusEl.textContent = text
    }

    function refreshRecentSearches(): void {
      recentSearches = activePlaylistId ? getRecentSearches(activePlaylistId) : []
    }

    function renderRecentChips(): void {
      recentTrack.replaceChildren()
      for (const recent of recentSearches) {
        const chip = document.createElement("button")
        chip.type = "button"
        chip.dataset.focusKey = `search:recent:${recent.text}`
        chip.className =
          "inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-sm text-fg-2 outline-none " +
          "transition-colors hover:bg-surface-2 tv-focus-inset"
        chip.textContent = recent.text
        chip.addEventListener("click", () => selectRecentChip(recent.text))
        recentTrack.appendChild(chip)
      }
    }

    function selectRecentChip(text: string): void {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer)
        searchDebounceTimer = null
      }
      inputEl.value = text
      syncUrlQuery(text)
      runSearch(text)
    }

    function syncUrlQuery(value: string): void {
      try {
        const url = new URL(window.location.href)
        if (value) url.searchParams.set("q", value)
        else url.searchParams.delete("q")
        window.history.replaceState({}, "", url.toString())
      } catch {}
    }

    function toLiveCardItem(channel: LiveRow & { norm: string }, siblings: Array<LiveRow & { norm: string }>): LiveCardItem {
      const name = channel.name || ""
      return {
        railId: "tv-search-channels",
        kind: "live",
        id: channel.id,
        name,
        logoUrl: channel.logo || null,
        nowTitle: channel.category || kindLabel("live"),
        ariaLabel: t("tv.aria.watch", { name }),
        onActivate: () => {
          commitCurrentSearch()
          void playLive(
            {
              playlistId: activePlaylistId,
              channel: toTvLiveChannel(channel),
              siblings: siblings.map(toTvLiveChannel),
            },
            {}
          )
        },
      }
    }

    function toPosterCardItem(row: CatalogRow & { norm: string }, kind: "vod" | "series"): PosterCardItem {
      const fallbackKey = kind === "vod" ? "list.movieFallback" : "list.seriesFallback"
      const name = row.name || t(fallbackKey, { id: row.id })
      const href =
        kind === "vod"
          ? `/tv/movies/detail?id=${encodeURIComponent(String(row.id))}`
          : `/tv/series/detail?id=${encodeURIComponent(String(row.id))}`
      return {
        railId: kind === "vod" ? "tv-search-movies" : "tv-search-series",
        kind,
        id: row.id,
        name,
        href,
        posterUrl: row.logo || null,
        meta: metaForCatalogRow(row),
        ariaLabel: t("tv.aria.open", { name }),
      }
    }

    function runSearch(rawValue: string): void {
      if (!channelsRail || !moviesRail || !seriesRail) return
      const trimmed = rawValue.trim()
      currentQuery = trimmed

      const showRecent = !trimmed && recentSearches.length > 0
      recentWrap.hidden = !showRecent
      if (showRecent) renderRecentChips()

      if (trimmed.length < MIN_QUERY_LENGTH) {
        channelsRail.setItems([])
        moviesRail.setItems([])
        seriesRail.setItems([])
        setStatus(showRecent ? "" : t("search.helpHeading"))
        return
      }

      if (!indexReady) {
        channelsRail.setLoading()
        moviesRail.setLoading()
        seriesRail.setLoading()
        setStatus(t("search.loadingCatalog"))
        return
      }

      const tokens = normalize(trimmed).split(" ").filter(Boolean)
      const channelMatches = rankRows(channels, tokens)
      const movieMatches = rankRows(movies, tokens)
      const seriesMatches = rankRows(series, tokens)

      channelsRail.setItems(channelMatches.map((channel) => toLiveCardItem(channel, channelMatches)))
      moviesRail.setItems(movieMatches.map((movie) => toPosterCardItem(movie, "vod")))
      seriesRail.setItems(seriesMatches.map((row) => toPosterCardItem(row, "series")))

      const totalMatches = channelMatches.length + movieMatches.length + seriesMatches.length
      if (totalMatches > 0) setStatus("")
      else setStatus(isWarming ? t("search.loadingCatalog") : t("search.noResults", { query: trimmed }))
    }

    function scheduleSearch(value: string): void {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null
        syncUrlQuery(value)
        runSearch(value)
      }, SEARCH_DEBOUNCE_MS)
    }

    function rebuildIndex(): void {
      channels = (readCachedLiveChannels(activePlaylistId) as LiveRow[]).map(withNorm)
      movies = ((getCached(activePlaylistId, "vod")?.data || []) as CatalogRow[]).map(withNorm)
      series = ((getCached(activePlaylistId, "series")?.data || []) as CatalogRow[]).map(withNorm)
      indexReady = true
    }

    function scheduleWarmupIfCold(): void {
      if (warmupRequested || !activePlaylistId) return
      if (channels.length || movies.length || series.length) return
      warmupRequested = true
      isWarming = true
      import("@/scripts/lib/catalog.js")
        .then((mod) => mod.warmupActive(activePlaylistId))
        .catch(() => {})
    }

    function onCatalogWarmed(): void {
      isWarming = false
      if (!activePlaylistId) return
      rebuildIndex()
      runSearch(inputEl.value)
    }

    function renderCentered(message: string, linkHref?: string, linkLabel?: string): void {
      inputWrap.remove()
      recentWrap.remove()
      statusEl.remove()
      channelsRail?.destroy()
      moviesRail?.destroy()
      seriesRail?.destroy()
      const wrap = document.createElement("div")
      wrap.className = "flex h-full flex-col items-center justify-center gap-3 text-center"
      const text = document.createElement("p")
      text.className = "text-fg-3"
      text.textContent = message
      wrap.appendChild(text)
      if (linkHref && linkLabel) {
        const link = document.createElement("a")
        link.href = linkHref
        link.dataset.tvAutofocus = ""
        link.className = "btn"
        link.textContent = linkLabel
        wrap.appendChild(link)
      } else {
        wrap.tabIndex = 0
        wrap.dataset.tvAutofocus = ""
      }
      track.appendChild(wrap)
    }

    function updateStaticText(): void {
      inputEl.placeholder = t("search.placeholderFull")
      inputEl.setAttribute("aria-label", t("common.search"))
      recentHeading.textContent = t("search.recentHeading")
      recentClear.textContent = t("search.recentClear")
    }

    function onLocaleChanged(): void {
      updateStaticText()
      if (!channelsRail || !moviesRail || !seriesRail) return
      channelsRail.destroy()
      moviesRail.destroy()
      seriesRail.destroy()
      channelsRail = null
      moviesRail = null
      seriesRail = null
      createRails()
      runSearch(inputEl.value)
    }

    function onRecentChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (detail?.playlistId !== activePlaylistId) return
      refreshRecentSearches()
      runSearch(inputEl.value)
    }

    async function onActiveChanged(): Promise<void> {
      const active = await getActiveEntry()
      if (destroyed) return
      activePlaylistId = active?._id || ""
      refreshRecentSearches()
      rebuildIndex()
      runSearch(inputEl.value)
    }

    async function init(): Promise<void> {
      const initialQuery = ctx.url.searchParams.get("q") || ""
      inputEl.value = initialQuery

      const active = await getActiveEntry()
      if (destroyed) return
      if (!active) {
        renderCentered(t("list.noPlaylistSelected"), "/tv/login", t("playlist.addCta"))
        return
      }
      activePlaylistId = active._id

      createRails()
      updateStaticText()

      await ensurePrefsLoaded()
      if (destroyed) return
      refreshRecentSearches()
      runSearch(inputEl.value)

      await Promise.allSettled([
        hydrateCache(activePlaylistId, "live"),
        hydrateCache(activePlaylistId, "m3u"),
        hydrateCache(activePlaylistId, "vod"),
        hydrateCache(activePlaylistId, "series"),
      ])
      if (destroyed) return
      await ensureOverridesReady()
      if (destroyed) return

      rebuildIndex()
      scheduleWarmupIfCold()
      runSearch(inputEl.value)
    }

    inputEl.addEventListener("input", () => scheduleSearch(inputEl.value))
    recentClear.addEventListener("click", () => clearRecentSearches(activePlaylistId))

    document.addEventListener(CATALOG_WARMED_EVENT, onCatalogWarmed)
    document.addEventListener(EVT_SEARCH_RECENT_CHANGED, onRecentChanged)
    document.addEventListener(LOCALE_EVENT, onLocaleChanged)
    document.addEventListener("xt:active-changed", onActiveChanged)

    void init()

    return () => {
      destroyed = true
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
      document.removeEventListener(CATALOG_WARMED_EVENT, onCatalogWarmed)
      document.removeEventListener(EVT_SEARCH_RECENT_CHANGED, onRecentChanged)
      document.removeEventListener(LOCALE_EVENT, onLocaleChanged)
      document.removeEventListener("xt:active-changed", onActiveChanged)
      channelsRail?.destroy()
      moviesRail?.destroy()
      seriesRail?.destroy()
      unregisterInputSection()
      unregisterRecentSection()
      unregisterKeepInView()
      scroller.remove()
    }
  },
}

export default view
