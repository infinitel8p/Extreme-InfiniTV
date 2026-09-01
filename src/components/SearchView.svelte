<script>
  // Full search experience. Mounted on /search and used as the search surface 
  import { onMount, tick } from "svelte"
  import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
  import { normalize } from "@/scripts/lib/text.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getRecentSearches,
    pushRecentSearch,
    removeRecentSearch,
    clearRecentSearches,
    EVT_SEARCH_RECENT_CHANGED,
  } from "@/scripts/lib/preferences.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import { readCachedLiveChannels, hasCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
  import {
    loadProgrammes,
    getProgrammesSync,
    EPG_LOADED_EVENT,
  } from "@/scripts/lib/epg-data.js"
  import { kindLabel } from "@/scripts/lib/kinds.js"
  import { fmtChannelIdentity } from "@/scripts/lib/format.ts"
  import { cachedImg } from "@/scripts/lib/img-cache.ts"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import {
    observeSeasonCount,
    seasonsLabel,
  } from "@/scripts/lib/series-seasons.ts"
  import { searchPeople } from "@/scripts/lib/person-search.ts"
  import { resolvePersonTitleIds } from "@/scripts/lib/person-filter.ts"
  import { isTvDevice } from "@/scripts/lib/tv-detect"
  import { buildEntryCard } from "@/scripts/lib/entry-card.ts"
  import { hubCardMenu } from "@/scripts/lib/hub-card-menu.ts"
  import {
    getSearchView,
    setSearchView,
    SEARCH_VIEW_EVENT,
  } from "@/scripts/lib/app-settings.js"

  /** @type {{ focusOnMount?: boolean }} */
  let { focusOnMount = false } = $props()

  // Read ?q= from the URL at mount time.
  function readUrlQuery() {
    if (typeof window === "undefined") return ""
    try {
      return new URL(window.location.href).searchParams.get("q") || ""
    } catch {
      return ""
    }
  }
  function readUrlPersonParams() {
    if (typeof window === "undefined") return null
    try {
      const params = new URL(window.location.href).searchParams
      const name = params.get("person")
      if (!name) return null
      const tmdbIdRaw = Number(params.get("personId"))
      return { name, tmdbId: Number.isFinite(tmdbIdRaw) && tmdbIdRaw > 0 ? tmdbIdRaw : null }
    } catch {
      return null
    }
  }
  const initialPersonFromUrl = readUrlPersonParams()
  const initialFromUrl = initialPersonFromUrl ? "" : readUrlQuery()

  /** @type {"all"|"live"|"vod"|"series"|"epg"|"actors"} */
  let kindFilter = $state("all")
  /** @type {Array<"all"|"live"|"vod"|"series"|"actors"|"epg">} */
  const kindOptions = ["all", "live", "vod", "series", "actors", "epg"]
  /** @type {"cards"|"list"} */
  let viewMode = $state(getSearchView())
  const cardsMode = $derived(viewMode === "cards")
  const viewModes = ["cards", "list"]
  // Matches the /movies and /series grid tracks.
  const GRID_CLASS =
    "grid gap-3 sm:gap-4 auto-rows-min content-start p-2 " +
    "grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] " +
    "sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] " +
    "lg:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]"
  let query = $state(initialFromUrl)
  let queryDebounced = $state(initialFromUrl)
  let _queryTimer = null
  function setQueryDebounced(value) {
    if (_queryTimer) clearTimeout(_queryTimer)
    _queryTimer = setTimeout(() => {
      queryDebounced = value
      syncUrl(value)
    }, 80)
  }

  /** @type {{name: string, tmdbId: number|null}|null} */
  let personMode = $state(initialPersonFromUrl)
  /** @type {{vod: Set<number>, series: Set<number>}|null} */
  let personTitleIds = $state(null)
  let personResolveToken = 0
  /** @type {import("@/scripts/lib/person-search.ts").PersonCandidate[]} */
  let actorResults = $state([])
  let _personSearchTimer = null
  let _personSearchToken = 0

  let activeIndex = $state(0)
  // Left/Right move cards only after stepping out of the query box.
  let navigatingResults = false
  /** @type {Array<{text: string, ts: number}>} */
  let recentSearches = $state([])
  /** @type {HTMLElement|null} */
  let recentSectionEl = null
  /** @type {HTMLElement|null} */
  let resultsEl = null

  /** @type {Array<{ kind: "live"|"vod"|"series"|"epg", id: string|number, name: string, logo: string|null, subtitle: string, href: string, norm: string }>} */
  let allItems = $state([])
  let rawVodData = $state([])
  let rawSeriesData = $state([])
  let isWarming = $state(false)
  const showRecentSearches = $derived(!personMode && !isWarming && !query.trim() && recentSearches.length > 0)
  let locale = $state(0)
  let activePlaylistId = $state("")
  let seasonCounts = $state({})
  // Wrappers read the locale rune so {tr(...)} / {kl(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const kl = (kind) => (locale, kindLabel(kind))

  function displaySubtitle(item) {
    if (item.kind !== "series") return item.subtitle
    void locale
    const parts = ["Series"]
    if (item.year) parts.push(item.year)
    const count = seasonCounts[item.id]
    if (count) parts.push(seasonsLabel(count))
    if (item.genre) parts.push(item.genre)
    return parts.join(" · ")
  }

  function lazySeasons(node, item) {
    if (!item || item.kind !== "series" || !activePlaylistId) return
    observeSeasonCount(node, activePlaylistId, item.id, (count) => {
      seasonCounts = { ...seasonCounts, [item.id]: count }
    })
  }
  /** @type {HTMLInputElement|null} */
  let inputEl = null

  function buildHref(kind, id) {
    if (kind === "live") return `/livetv?channel=${encodeURIComponent(id)}`
    if (kind === "vod") return `/movies/detail?id=${encodeURIComponent(id)}`
    return `/series/detail?id=${encodeURIComponent(id)}`
  }

  function fmtProgrammeStart(start) {
    const startDate = new Date(start)
    const now = new Date()
    const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayDiff = Math.round((startDay - today) / 86_400_000)
    const time = startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    if (dayDiff === 0) return `${t("epg.today")} ${time}`
    if (dayDiff === 1) return `${t("common.tomorrow")} ${time}`
    const wk = startDate.toLocaleDateString([], { weekday: "short" })
    return `${wk} ${time}`
  }

  let loadIndexGeneration = 0

  async function loadIndex(opts = {}) {
    const generation = ++loadIndexGeneration
    const [active] = await Promise.all([getActiveEntry(), ensurePrefsLoaded()])
    if (generation !== loadIndexGeneration) return
    if (!active) {
      allItems = []
      activePlaylistId = ""
      seasonCounts = {}
      recentSearches = []
      return
    }
    if (active._id !== activePlaylistId) seasonCounts = {}
    activePlaylistId = active._id
    refreshRecentSearches()

    const buildIndex = async () => {
      const liveData = readCachedLiveChannels(active._id)
      const vodData = getCached(active._id, "vod")?.data || []
      const seriesData = getCached(active._id, "series")?.data || []
      rawVodData = vodData
      rawSeriesData = seriesData

      const cold =
        !liveData.length && !vodData.length && !seriesData.length
      if (cold && opts.warm !== false) {
        isWarming = true
        warmupActive(active._id).then(() => {
          isWarming = false
          if (generation === loadIndexGeneration) loadIndex({ warm: false })
        })
      }

      const items = []
      for (const channel of liveData) {
        items.push({
          kind: "live",
          id: Number(channel.id),
          name: channel.name || "",
          logo: channel.logo || null,
          subtitle: `${fmtChannelIdentity(channel.chno, channel.id)} · ${channel.category || "Live"}`,
          href: buildHref("live", channel.id),
          norm: channel.norm || normalize(`${channel.name || ""} ${channel.category || ""}`),
        })
      }
      for (const movie of vodData) {
        items.push({
          kind: "vod",
          id: Number(movie.id),
          name: movie.name || "",
          logo: movie.logo || null,
          rating: movie.rating || "",
          year: movie.year || "",
          category: movie.category || "",
          subtitle: movie.year ? `Movie · ${movie.year}` : "Movie",
          href: buildHref("vod", movie.id),
          norm: movie.norm || normalize(`${movie.name || ""} ${movie.category || ""}`),
        })
      }
      for (const series of seriesData) {
        items.push({
          kind: "series",
          id: Number(series.id),
          name: series.name || "",
          logo: series.logo || null,
          rating: series.rating || "",
          year: series.year || "",
          category: series.category || "",
          genre: series.category || "",
          subtitle: series.year ? `Series · ${series.year}` : "Series",
          href: buildHref("series", series.id),
          norm: series.norm || normalize(`${series.name || ""} ${series.category || ""}`),
        })
      }

      const epgState = getProgrammesSync(active._id)
      const hasTvgChannels = liveData.some((channel) => channel.tvgId)
      if (hasTvgChannels && !epgState && opts.warmEpg !== false) {
        try {
          const creds = await loadCreds()
          if (generation !== loadIndexGeneration) return
          if (creds?.host) loadProgrammes(active._id, creds).catch(() => {})
        } catch {}
      }
      if (epgState?.programmes?.size) {
        const now = Date.now()
        const HORIZON = now + 36 * 60 * 60 * 1000
        const HARD_CAP = 5000
        let epgCount = 0
        outer: for (const channel of liveData) {
          if (!channel.tvgId) continue
          const programmes = epgState.programmes.get(
            String(channel.tvgId).toLowerCase()
          )
          if (!programmes || !programmes.length) continue
          const channelName = channel.name || ""
          const channelLogo = channel.logo || null
          for (const programme of programmes) {
            if (programme.stop <= now) continue
            if (programme.start > HORIZON) break
            const isLive = programme.start <= now && now < programme.stop
            const when = isLive ? "Live now" : fmtProgrammeStart(programme.start)
            items.push({
              kind: "epg",
              id: `${channel.id}:${programme.start}`,
              name: programme.title || "Untitled",
              logo: channelLogo,
              subtitle: `${channelName} · ${when}`,
              href: buildHref("live", channel.id),
              norm: normalize(`${programme.title || ""} ${channelName}`),
            })
            epgCount++
            if (epgCount >= HARD_CAP) break outer
          }
        }
      }

      allItems = items
    }

    const hydrations = [
      hydrateCache(active._id, "live"),
      hydrateCache(active._id, "m3u"),
      hydrateCache(active._id, "vod"),
      hydrateCache(active._id, "series"),
    ]
    const allCached =
      hasCachedLiveChannels(active._id) &&
      !!getCached(active._id, "vod") &&
      !!getCached(active._id, "series")

    if (allCached) {
      // Build from memory now; hydration below only refreshes stale data.
      await buildIndex()
      void Promise.allSettled(hydrations).then(() => {
        if (generation === loadIndexGeneration) buildIndex()
      })
    } else {
      await Promise.allSettled(hydrations)
      if (generation !== loadIndexGeneration) return
      await buildIndex()
    }
  }

  function syncUrl(queryValue) {
    try {
      const url = new URL(window.location.href)
      if (queryValue) url.searchParams.set("q", queryValue)
      else url.searchParams.delete("q")
      window.history.replaceState({}, "", url.toString())
    } catch {}
  }

  function syncPersonUrl() {
    try {
      const url = new URL(window.location.href)
      if (personMode) {
        url.searchParams.set("person", personMode.name)
        if (personMode.tmdbId) url.searchParams.set("personId", String(personMode.tmdbId))
        else url.searchParams.delete("personId")
        url.searchParams.delete("q")
      } else {
        url.searchParams.delete("person")
        url.searchParams.delete("personId")
      }
      window.history.replaceState({}, "", url.toString())
    } catch {}
  }

  function personInitials(name) {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return "?"
    if (parts.length === 1) return parts[0][0].toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }

  function toCatalogEntries(list) {
    return list.map((entry) => ({ id: entry.id, name: entry.name || "", year: entry.year || null }))
  }

  async function resolvePersonMode() {
    if (!personMode) return
    const runToken = ++personResolveToken
    personTitleIds = null
    const currentPerson = personMode
    const [vodIds, seriesIds] = await Promise.all([
      resolvePersonTitleIds({
        kind: "vod",
        playlistId: activePlaylistId,
        personName: currentPerson.name,
        tmdbPersonId: currentPerson.tmdbId,
        catalogEntries: toCatalogEntries(rawVodData),
      }),
      resolvePersonTitleIds({
        kind: "series",
        playlistId: activePlaylistId,
        personName: currentPerson.name,
        tmdbPersonId: currentPerson.tmdbId,
        catalogEntries: toCatalogEntries(rawSeriesData),
      }),
    ])
    if (runToken !== personResolveToken) return
    personTitleIds = { vod: vodIds, series: seriesIds }
  }

  function enterPersonMode(candidate) {
    if (_personSearchTimer) {
      clearTimeout(_personSearchTimer)
      _personSearchTimer = null
    }
    _personSearchToken++
    actorResults = []
    personMode = { name: candidate.name, tmdbId: candidate.tmdbId }
    personTitleIds = null
    kindFilter = "all"
    query = ""
    queryDebounced = ""
    syncPersonUrl()
    resolvePersonMode()
  }

  function exitPersonMode() {
    if (!personMode) return
    personResolveToken++
    personMode = null
    personTitleIds = null
    syncPersonUrl()
  }

  function scheduleActorSearch(value) {
    if (_personSearchTimer) clearTimeout(_personSearchTimer)
    const trimmed = value.trim()
    if (trimmed.length < 2 || !activePlaylistId) {
      actorResults = []
      return
    }
    _personSearchTimer = setTimeout(async () => {
      const runToken = ++_personSearchToken
      const candidates = await searchPeople(activePlaylistId, trimmed, 5)
      if (runToken !== _personSearchToken) return
      actorResults = candidates
    }, 300)
  }

  function personModeResults() {
    if (!personTitleIds) return []
    const activeKind = kindFilter === "vod" || kindFilter === "series" ? kindFilter : "all"
    const out = []
    for (const item of allItems) {
      if (item.kind === "vod") {
        if (!personTitleIds.vod.has(item.id)) continue
      } else if (item.kind === "series") {
        if (!personTitleIds.series.has(item.id)) continue
      } else {
        continue
      }
      if (activeKind !== "all" && activeKind !== item.kind) continue
      out.push(item)
    }
    return out
  }

  let scoredAll = $derived.by(() => {
    const counts = { all: 0, live: 0, vod: 0, series: 0, epg: 0 }
    const normalizedQuery = normalize(queryDebounced.trim())
    if (!normalizedQuery) return { items: [], counts }
    const tokens = normalizedQuery.split(" ").filter(Boolean)
    if (!tokens.length) return { items: [], counts }
    const items = allItems
    const itemsLen = items.length
    const tokensLen = tokens.length
    const matched = []
    const HARD_CAP = 500
    for (let i = 0; i < itemsLen; i++) {
      const item = items[i]
      const norm = item.norm
      let score = 0
      let allMatch = true
      for (let tokenIndex = 0; tokenIndex < tokensLen; tokenIndex++) {
        const tok = tokens[tokenIndex]
        const matchIndex = norm.indexOf(tok)
        if (matchIndex === -1) {
          allMatch = false
          break
        }
        score += 100 - (matchIndex > 99 ? 99 : matchIndex) + (norm.startsWith(tok) ? 25 : 0)
      }
      if (allMatch) {
        counts.all++
        counts[item.kind]++
        if (matched.length < HARD_CAP) matched.push({ item, score })
      }
    }
    matched.sort((left, right) => right.score - left.score)
    return { items: matched, counts }
  })

  let results = $derived.by(() => {
    if (personMode) return personTitleIds === null ? [] : personModeResults()
    const items = scoredAll.items
    const activeKind = kindFilter
    const out = []
    const MAX = 200
    if ((activeKind === "all" || activeKind === "actors") && actorResults.length && queryDebounced.trim()) {
      for (const candidate of actorResults) {
        out.push({
          kind: "person",
          id: candidate.tmdbId ?? candidate.name,
          name: candidate.name,
          profileUrl: candidate.profileUrl,
          knownFor: candidate.knownFor,
          candidate,
        })
      }
    }
    if (activeKind !== "actors") {
      for (let i = 0; i < items.length && out.length < MAX; i++) {
        const it = items[i].item
        if (activeKind !== "all" && it.kind !== activeKind) continue
        out.push(it)
      }
    }
    return out
  })

  let kindCounts = $derived({ ...scoredAll.counts, actors: actorResults.length })

  function isCardable(result) {
    return result.kind === "vod" || result.kind === "series" || result.kind === "person"
  }

  // Runs keep ranking order across the cards/rows split.
  let resultRuns = $derived.by(() => {
    const runs = []
    for (let idx = 0; idx < results.length; idx++) {
      const result = results[idx]
      const layout = !cardsMode || !isCardable(result)
        ? "rows"
        : result.kind === "person"
          ? "actors"
          : "cards"
      const last = runs[runs.length - 1]
      if (last && last.layout === layout) last.entries.push({ result, idx })
      else runs.push({ layout, entries: [{ result, idx }] })
    }
    return runs
  })

  function cardMeta(result) {
    void locale
    if (result.kind === "person") return result.knownFor || t("search.actorGeneric")
    return displaySubtitle(result)
  }

  function setViewMode(mode) {
    if (viewMode === mode) return
    viewMode = mode
    setSearchView(mode)
  }

  // Rebuilds on identity change only; a late season count just patches the meta.
  function searchCard(node, params) {
    let card = null
    let key = ""
    let current = params
    const activate = () => (activeIndex = current.idx)
    node.addEventListener("mouseenter", activate)
    node.addEventListener("focusin", activate)
    node.addEventListener("click", commitSearch)
    function render(next) {
      const nextKey = `${next.playlistId}|${next.locale}|${next.result.kind}:${next.result.id}`
      if (card && nextKey === key) {
        const meta = card.querySelector('[data-role="meta"]')
        if (meta) meta.textContent = cardMeta(next.result)
        return
      }
      key = nextKey
      card?.remove()
      card = buildEntryCard({
        entry: next.result,
        idx: next.idx,
        kind: next.result.kind,
        activePlaylistId: next.playlistId,
        detailHref: (entry) => entry.href,
        fallbackTitle: (entry) => entry.name || String(entry.id),
        metaText: (entry) => cardMeta(entry),
      })
      node.appendChild(card)
    }
    render(current)
    return {
      update(next) {
        current = next
        render(next)
      },
      destroy() {
        node.removeEventListener("mouseenter", activate)
        node.removeEventListener("focusin", activate)
        node.removeEventListener("click", commitSearch)
        card?.remove()
        card = null
      },
    }
  }

  $effect(() => {
    void results
    if (activeIndex >= results.length) activeIndex = 0
  })

  function refreshRecentSearches() {
    recentSearches = activePlaylistId ? getRecentSearches(activePlaylistId) : []
  }

  // Record a committed query (result activated), never a per-keystroke
  // debounce partial.
  function commitSearch() {
    const trimmedQuery = query.trim()
    if (trimmedQuery) pushRecentSearch(activePlaylistId, trimmedQuery)
  }

  function selectRecentSearch(text) {
    if (_queryTimer) {
      clearTimeout(_queryTimer)
      _queryTimer = null
    }
    if (personMode) exitPersonMode()
    query = text
    queryDebounced = text
    syncUrl(text)
    scheduleActorSearch(text)
    inputEl?.focus()
  }

  function removeOneRecentSearch(text) {
    removeRecentSearch(activePlaylistId, text)
  }

  function clearAllRecentSearches() {
    clearRecentSearches(activePlaylistId)
    inputEl?.focus()
  }

  function scrollActiveIntoView() {
    tick().then(() => {
      resultsEl
        ?.querySelector(`[data-result-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  }

  // auto-fill column count is only knowable from the rendered grid.
  function activeGridColumns() {
    const grid = resultsEl
      ?.querySelector(`[data-result-index="${activeIndex}"]`)
      ?.closest("[data-result-grid]")
    if (!grid) return 0
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length
    return columns > 0 ? columns : 1
  }

  function stepActive(delta) {
    if (!results.length) return
    const next = activeIndex + delta
    activeIndex = next < 0 ? 0 : next >= results.length ? results.length - 1 : next
    scrollActiveIntoView()
  }

  function wrapActive(delta) {
    if (!results.length) return
    activeIndex = (activeIndex + delta + results.length) % results.length
    scrollActiveIntoView()
  }

  function navigate(item) {
    if (!item) return
    if (item.kind === "person") {
      enterPersonMode(item.candidate)
      return
    }
    commitSearch()
    window.location.href = item.href
  }

  function onKey(ev) {
    if (isTvDevice()) return
    const onInput = document.activeElement === inputEl
    const inRecentSection = !!recentSectionEl?.contains(document.activeElement)
    if (onInput && personMode && ev.key === "Backspace" && !query) {
      ev.preventDefault()
      exitPersonMode()
    } else if (ev.key === "Escape" && personMode) {
      ev.preventDefault()
      exitPersonMode()
      inputEl?.focus()
    } else if (onInput && ev.key === "ArrowDown" && showRecentSearches) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      recentSectionEl?.querySelector(".recent-search-row")?.focus()
    } else if (onInput && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      navigatingResults = true
      const columns = activeGridColumns()
      const step = ev.key === "ArrowDown" ? 1 : -1
      if (columns) stepActive(step * columns)
      else wrapActive(step)
    } else if (
      onInput &&
      cardsMode &&
      navigatingResults &&
      (ev.key === "ArrowRight" || ev.key === "ArrowLeft")
    ) {
      if (!activeGridColumns()) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      stepActive(ev.key === "ArrowRight" ? 1 : -1)
    } else if (ev.key === "Enter" && onInput) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      navigate(results[activeIndex])
    } else if (ev.key === "Escape" && inRecentSection) {
      ev.preventDefault()
      inputEl?.focus()
    } else if (ev.key === "Escape") {
      if (query) {
        ev.preventDefault()
        query = ""
        queryDebounced = ""
        syncUrl("")
      }
    }
  }

  onMount(() => {
    loadIndex().then(() => {
      if (personMode) resolvePersonMode()
    })
    function onWarmed() {
      loadIndex({ warm: false })
    }
    function onEpgLoaded() {
      loadIndex({ warm: false, warmEpg: false })
    }
    const onLocale = () => { locale++ }
    const onSearchView = () => { viewMode = getSearchView() }
    const onActiveChanged = () =>
      loadIndex().then(() => {
        if (personMode) resolvePersonMode()
      })
    const onSearchRecentChanged = (ev) => {
      if (ev.detail?.playlistId === activePlaylistId) refreshRecentSearches()
    }
    document.addEventListener("xt:catalog-warmed", onWarmed)
    document.addEventListener(EPG_LOADED_EVENT, onEpgLoaded)
    document.addEventListener("xt:active-changed", onActiveChanged)
    document.addEventListener(LOCALE_EVENT, onLocale)
    document.addEventListener(SEARCH_VIEW_EVENT, onSearchView)
    document.addEventListener(EVT_SEARCH_RECENT_CHANGED, onSearchRecentChanged)
    window.addEventListener("keydown", onKey, true)
    if (focusOnMount) {
      tick().then(() => {
        inputEl?.focus()
        inputEl?.select?.()
      })
    }
    return () => {
      document.removeEventListener("xt:catalog-warmed", onWarmed)
      document.removeEventListener(EPG_LOADED_EVENT, onEpgLoaded)
      document.removeEventListener("xt:active-changed", onActiveChanged)
      document.removeEventListener(LOCALE_EVENT, onLocale)
      document.removeEventListener(SEARCH_VIEW_EVENT, onSearchView)
      document.removeEventListener(EVT_SEARCH_RECENT_CHANGED, onSearchRecentChanged)
      window.removeEventListener("keydown", onKey, true)
      if (_queryTimer) clearTimeout(_queryTimer)
      if (_personSearchTimer) clearTimeout(_personSearchTimer)
    }
  })
</script>

<section class="search-view flex flex-col gap-4 flex-1 min-h-0">
  <div class="flex flex-col gap-3 shrink-0">
    <div data-focus-glide="off" class="search-input-wrap flex items-center gap-2 px-3 py-2 rounded-xl border border-line bg-surface focus-within:border-accent transition-[border-color,box-shadow] duration-200 ease-out">
      <svg xmlns="http://www.w3.org/2000/svg" width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="text-fg-3 shrink-0">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
      </svg>
      {#if personMode}
        <span class="person-chip inline-flex items-center gap-1.5 min-h-9 pl-2.5 pr-1 py-1 rounded-lg bg-accent-soft text-accent text-sm max-w-[55%] shrink-0">
          <span class="truncate">{personMode.name}</span>
          <button
            type="button"
            onclick={exitPersonMode}
            aria-label={tr("search.personChipRemove", { name: personMode.name })}
            class="person-chip-remove size-7 shrink-0 inline-flex items-center justify-center rounded-md text-accent hover:bg-surface-2/60 focus-visible:bg-surface-2/60 outline-none transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="0.8rem" height="0.8rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </span>
      {/if}
      <input
        bind:this={inputEl}
        value={personMode ? "" : query}
        oninput={(ev) => {
          const value = ev.currentTarget.value
          if (personMode) exitPersonMode()
          navigatingResults = false
          query = value
          setQueryDebounced(value)
          scheduleActorSearch(value)
        }}
        type="search"
        placeholder={tr("search.placeholderFull")}
        aria-label={tr("common.search")}
        autocomplete="off"
        spellcheck="false"
        class="flex-1 min-w-0 bg-transparent text-fg placeholder:text-fg-3 outline-none py-2 text-base" />
      {#if query && !personMode}
        <button
          type="button"
          onclick={() => {
            query = ""
            queryDebounced = ""
            syncUrl("")
            actorResults = []
            if (_personSearchTimer) {
              clearTimeout(_personSearchTimer)
              _personSearchTimer = null
            }
            inputEl?.focus()
          }}
          aria-label={tr("search.clear")}
          class="search-clear size-7 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-2 outline-none focus-visible:bg-surface-2 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1rem" height="1rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <div class="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto custom-scroll -mx-1 px-1">
        {#each kindOptions as kindOption}
          <button
            type="button"
            onclick={() => (kindFilter = kindOption)}
            aria-pressed={kindFilter === kindOption}
            class="filter-chip rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors outline-none border"
            class:bg-accent-soft={kindFilter === kindOption}
            class:text-accent={kindFilter === kindOption}
            class:border-accent={kindFilter === kindOption}
            class:text-fg-2={kindFilter !== kindOption}
            class:border-line={kindFilter !== kindOption}
            class:hover:bg-surface-2={kindFilter !== kindOption}>
            {kindOption === "all"
              ? tr("common.all")
              : kindOption === "vod"
              ? tr("nav.movies")
              : kindOption === "live"
              ? tr("nav.livetv")
              : kindOption === "epg"
              ? tr("nav.epg")
              : kindOption === "actors"
              ? tr("search.actors")
              : tr("nav.series")}
            {#if queryDebounced.trim()}
              <span class="ml-1.5 text-2xs tabular-nums opacity-70">{kindCounts[kindOption]}</span>
            {/if}
          </button>
        {/each}
      </div>

      <div role="group" aria-label={tr("search.viewToggle")} class="view-toggle shrink-0 flex items-center gap-0.5 p-0.5 rounded-lg border border-line bg-surface">
        {#each viewModes as mode (mode)}
          {@const label = mode === "cards" ? tr("search.viewCards") : tr("search.viewList")}
          <button
            type="button"
            onclick={() => setViewMode(mode)}
            aria-pressed={viewMode === mode}
            aria-label={label}
            title={label}
            class="size-8 inline-flex items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent"
            class:bg-accent-soft={viewMode === mode}
            class:text-accent={viewMode === mode}
            class:text-fg-3={viewMode !== mode}
            class:hover:text-fg={viewMode !== mode}
            class:hover:bg-surface-2={viewMode !== mode}>
            {#if mode === "cards"}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.05rem" height="1.05rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
              </svg>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.05rem" height="1.05rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>
              </svg>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>

  {#snippet warming(hint)}
    <div class="flex items-center justify-center gap-2 mb-2">
      <svg viewBox="0 0 24 24" width="1rem" height="1rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" class="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.2-8.55"/>
      </svg>
      <span>{tr("search.loadingCatalog")}</span>
    </div>
    <div class="text-2xs">{hint}</div>
  {/snippet}

  <div bind:this={resultsEl} class="flex-1 min-h-0 overflow-auto custom-scroll">
    {#if !personMode && !queryDebounced.trim()}
      {#if showRecentSearches}
        <div bind:this={recentSectionEl} class="recent-searches pt-3 pb-2">
          <div class="flex items-baseline justify-between gap-2 mb-1 px-2.5">
            <span class="text-eyebrow font-medium uppercase tracking-wide text-fg-3">{tr("search.recentHeading")}</span>
            <button
              type="button"
              onclick={clearAllRecentSearches}
              class="inline-flex items-center min-h-9 px-2 rounded-lg text-xs text-fg-3 hover:text-fg focus-visible:text-fg underline-offset-2 hover:underline outline-none pointer-coarse:min-h-11">
              {tr("search.recentClear")}
            </button>
          </div>
          <ul class="flex flex-col gap-1">
            {#each recentSearches as recent (recent.text)}
              <li class="flex items-center gap-1">
                <button
                  type="button"
                  onclick={() => selectRecentSearch(recent.text)}
                  class="recent-search-row flex-1 min-w-0 min-h-11 rounded-lg px-2.5 flex items-center gap-2 text-left text-fg-2 hover:bg-surface-2 focus-visible:bg-surface-2 outline-none transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 text-fg-3">
                    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
                  </svg>
                  <span class="truncate text-sm">{recent.text}</span>
                </button>
                <button
                  type="button"
                  onclick={() => removeOneRecentSearch(recent.text)}
                  aria-label={tr("search.recentRemove", { query: recent.text })}
                  class="size-9 pointer-coarse:size-11 shrink-0 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-2 focus-visible:bg-surface-2 outline-none transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="0.875rem" height="0.875rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      <div class="px-4 text-center text-sm text-fg-3 max-w-md mx-auto" class:py-12={!showRecentSearches} class:py-6={showRecentSearches}>
        {#if isWarming}
          {@render warming(tr("search.warmingHint"))}
        {:else}
          <p class="text-base text-fg-2 mb-1">{tr("search.helpHeading")}</p>
          <p class="text-2xs">{tr("search.helpKbd")}</p>
        {/if}
      </div>
    {:else if personMode && personTitleIds === null}
      {#if cardsMode}
        <ul class={GRID_CLASS} aria-hidden="true">
          {#each Array.from({ length: 12 }) as _, i (i)}
            <li>
              <span class="block aspect-[2/3] rounded-xl skel" style:--skel-delay={i * 60 + "ms"}></span>
              <span class="mt-2 block h-3 rounded skel" style:width={55 + ((i * 7) % 35) + "%"} style:--skel-delay={i * 60 + 70 + "ms"}></span>
            </li>
          {/each}
        </ul>
      {:else}
        <ul class="flex flex-col gap-1 pt-3 pb-4" aria-hidden="true">
          {#each Array.from({ length: 6 }) as _, i (i)}
            <li class="flex items-center gap-3 px-2.5 py-2">
              <span class="size-12 shrink-0 rounded-full skel" style:--skel-delay={i * 90 + "ms"}></span>
              <span class="flex-1 min-w-0 flex flex-col gap-1.5">
                <span class="h-3 rounded skel" style:width={60 + ((i * 7) % 30) + "%"} style:--skel-delay={i * 90 + 70 + "ms"}></span>
                <span class="h-2.5 rounded skel" style:width={30 + ((i * 5) % 25) + "%"} style:--skel-delay={i * 90 + 140 + "ms"}></span>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if !results.length}
      <div class="px-4 py-12 text-center text-sm text-fg-3 max-w-md mx-auto">
        {#if personMode}
          <p>{tr("search.noResultsForPerson", { name: personMode.name })}</p>
        {:else if isWarming}
          {@render warming(tr("search.warmingResultsHint"))}
        {:else}
          <p>{tr("search.noResults", { query: queryDebounced.trim() })}</p>
          {#if kindFilter !== "all" && kindCounts.all > 0}
            <button
              type="button"
              onclick={() => (kindFilter = "all")}
              class="mt-4 inline-flex items-center justify-center min-h-11 px-3.5 rounded-lg border border-line bg-surface text-sm text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors outline-none">
              {tr("search.showAllKinds", { n: kindCounts.all })}
            </button>
          {/if}
        {/if}
      </div>
    {:else}
      {#snippet resultRow(result, idx)}
        <li class="result-row" data-result-index={idx} style:--enter-delay={Math.min(idx, 12) * 18 + "ms"}>
          {#if result.kind === "person"}
            <button
              type="button"
              onmouseenter={() => (activeIndex = idx)}
              onfocus={() => (activeIndex = idx)}
              onclick={() => enterPersonMode(result.candidate)}
              class="w-full text-left rounded-lg px-2.5 py-2 flex items-center gap-3 outline-none transition-colors focus-visible:bg-surface-2"
              class:bg-surface-2={activeIndex === idx}>
              <span class="size-12 shrink-0 rounded-full bg-surface-2 ring-1 ring-line overflow-hidden flex items-center justify-center text-2xs font-medium uppercase text-fg-3">
                {#if result.profileUrl}
                  <img
                    use:cachedImg={{ url: result.profileUrl, kind: "poster" }}
                    alt=""
                    loading="lazy" fetchpriority="low"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    width="48" height="48"
                    class="h-full w-full object-cover" />
                {:else}
                  {personInitials(result.name)}
                {/if}
              </span>
              <span class="flex-1 min-w-0">
                <span class="block truncate text-sm text-fg">{result.name}</span>
                <span class="block truncate text-2xs text-fg-3">{result.knownFor || tr("search.actorGeneric")}</span>
              </span>
              <span class="shrink-0 text-2xs uppercase tracking-wide text-fg-3 px-1.5 py-0.5 rounded border border-line">
                {tr("search.actorGeneric")}
              </span>
            </button>
          {:else}
            <a
              href={result.href}
              use:lazySeasons={result}
              onmouseenter={() => (activeIndex = idx)}
              onfocus={() => (activeIndex = idx)}
              onclick={commitSearch}
              class="w-full text-left rounded-lg px-2.5 py-2 flex items-center gap-3 outline-none transition-colors focus-visible:bg-surface-2"
              class:bg-surface-2={activeIndex === idx}>
              <span class="size-12 shrink-0 rounded-md bg-surface-2 ring-1 ring-line overflow-hidden flex items-center justify-center">
                {#if result.logo}
                  <img
                    use:cachedImg={{ url: result.logo, kind: result.kind === "live" ? "logo" : "poster" }}
                    alt=""
                    loading="lazy" fetchpriority="low"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    width="48" height="48"
                    class="h-full w-full"
                    class:object-cover={result.kind !== "live"}
                    class:object-contain={result.kind === "live"} />
                {:else}
                  <span class="text-2xs text-fg-3 uppercase">{kl(result.kind)[0]}</span>
                {/if}
              </span>
              <span class="flex-1 min-w-0">
                <span class="block truncate text-sm text-fg">{result.name}</span>
                <span class="block truncate text-2xs text-fg-3">{displaySubtitle(result)}</span>
              </span>
              <span class="shrink-0 text-2xs uppercase tracking-wide text-fg-3 px-1.5 py-0.5 rounded border border-line">
                {kl(result.kind)}
              </span>
            </a>
          {/if}
        </li>
      {/snippet}

      <div class="pb-4">
        {#each resultRuns as run (run.layout + ":" + run.entries[0].idx)}
          {#if run.layout === "rows"}
            <ul class="flex flex-col gap-1">
              {#each run.entries as entry (entry.result.kind + ":" + entry.result.id)}
                {#if !personMode && entry.result.kind === "person" && entry.idx === 0}
                  <li class="px-2.5 pt-1 pb-1.5">
                    <span class="text-eyebrow font-medium uppercase tracking-wide text-fg-3">{tr("search.actors")}</span>
                  </li>
                {/if}
                {@render resultRow(entry.result, entry.idx)}
              {/each}
            </ul>
          {:else if run.layout === "actors"}
            <div class="px-2.5 pt-1 pb-1.5">
              <span class="text-eyebrow font-medium uppercase tracking-wide text-fg-3">{tr("search.actors")}</span>
            </div>
            <ul data-result-grid="1" class={GRID_CLASS}>
              {#each run.entries as entry (entry.result.kind + ":" + entry.result.id)}
                <li
                  data-result-index={entry.idx}
                  class="rounded-xl"
                  class:result-active={activeIndex === entry.idx}>
                  <button
                    type="button"
                    onmouseenter={() => (activeIndex = entry.idx)}
                    onfocus={() => (activeIndex = entry.idx)}
                    onclick={() => enterPersonMode(entry.result.candidate)}
                    class="person-card group relative block w-full text-left rounded-xl overflow-hidden bg-surface-2 ring-1 ring-line outline-none
                           transition-[transform,box-shadow] duration-150
                           hover:ring-accent hover:[transform:translateY(-2px)]
                           focus-visible:ring-accent focus-visible:[transform:translateY(-2px)]">
                    <span class="aspect-[2/3] w-full block bg-surface-2 overflow-hidden relative">
                      {#if entry.result.profileUrl}
                        <img
                          use:cachedImg={{ url: entry.result.profileUrl, kind: "poster" }}
                          alt=""
                          loading="lazy" fetchpriority="low"
                          decoding="async"
                          referrerpolicy="no-referrer"
                          width="200" height="300"
                          class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                      {:else}
                        <span class="absolute inset-0 flex items-center justify-center text-xl font-medium text-fg-3">
                          {personInitials(entry.result.name)}
                        </span>
                      {/if}
                    </span>
                    <span class="block px-2 py-2 min-w-0">
                      <span class="block truncate text-sm font-medium text-fg">{entry.result.name}</span>
                      <span class="block truncate text-2xs text-fg-3">{entry.result.knownFor || tr("search.actorGeneric")}</span>
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <ul data-result-grid="1" class={GRID_CLASS}>
              {#each run.entries as entry (entry.result.kind + ":" + entry.result.id)}
                <li
                  data-result-index={entry.idx}
                  class="rounded-xl"
                  class:result-active={activeIndex === entry.idx}
                  use:lazySeasons={entry.result}
                  use:hubCardMenu={{
                    kind: entry.result.kind,
                    id: entry.result.id,
                    name: entry.result.name,
                    logo: entry.result.logo,
                    playlistId: activePlaylistId,
                  }}
                  use:searchCard={{
                    result: entry.result,
                    idx: entry.idx,
                    playlistId: activePlaylistId,
                    locale,
                    seasonCount: seasonCounts[entry.result.id],
                  }}></li>
              {/each}
            </ul>
          {/if}
        {/each}
        {#if scoredAll.items.length >= 500}
          <p class="px-3 py-3 text-center text-2xs text-fg-3 italic">
            {tr("search.showingTop", { n: results.length })}
          </p>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .result-active {
    box-shadow: 0 0 0 2px var(--color-accent);
  }

  .result-row {
    animation: result-enter 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--enter-delay, 0ms);
  }
  @keyframes result-enter {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .search-input-wrap:focus-within {
    box-shadow: 0 0 0 2px var(--color-accent-soft);
  }
  /* The wrapper carries the focus ring; Layout's global input outline would draw a second, inner one. */
  .search-input-wrap input:focus-visible {
    outline: none;
  }

  @media (pointer: coarse) {
    .search-clear,
    .person-chip-remove {
      width: 2.75rem;
      height: 2.75rem;
    }
    .filter-chip {
      padding-top: 0.5rem;
      padding-bottom: 0.5rem;
      min-height: 2.5rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .result-row { animation: none; }
    .search-input-wrap { transition: none; }
  }
</style>
