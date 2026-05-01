<script>
  // Full search experience. Mounted on /search and used as the search surface 
  import { onMount, tick } from "svelte"
  import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
  import { normalize } from "@/scripts/lib/text.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { ensureLoaded as ensurePrefsLoaded } from "@/scripts/lib/preferences.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import {
    loadProgrammes,
    getProgrammesSync,
    EPG_LOADED_EVENT,
  } from "@/scripts/lib/epg-data.js"
  import { KIND_LABEL } from "@/scripts/lib/kinds.js"
  import { t } from "@/scripts/lib/i18n.js"

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
  const initialFromUrl = readUrlQuery()

  /** @type {"all"|"live"|"vod"|"series"|"epg"} */
  let kindFilter = $state("all")
  let query = $state(initialFromUrl)
  let queryDebounced = $state(initialFromUrl)
  let _queryTimer = null
  function setQueryDebounced(v) {
    if (_queryTimer) clearTimeout(_queryTimer)
    _queryTimer = setTimeout(() => {
      queryDebounced = v
      syncUrl(v)
    }, 80)
  }
  let activeIndex = $state(0)

  /** @type {Array<{ kind: "live"|"vod"|"series"|"epg", id: string|number, name: string, logo: string|null, subtitle: string, href: string, norm: string }>} */
  let allItems = $state([])
  let isWarming = $state(false)
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

  async function loadIndex(opts = {}) {
    const active = await getActiveEntry()
    if (!active) {
      allItems = []
      return
    }
    await ensurePrefsLoaded()
    await Promise.all([
      hydrateCache(active._id, "live"),
      hydrateCache(active._id, "m3u"),
      hydrateCache(active._id, "vod"),
      hydrateCache(active._id, "series"),
    ])

    const liveData =
      getCached(active._id, "live")?.data ||
      getCached(active._id, "m3u")?.data ||
      []
    const vodData = getCached(active._id, "vod")?.data || []
    const seriesData = getCached(active._id, "series")?.data || []

    const cold =
      !liveData.length && !vodData.length && !seriesData.length
    if (cold && opts.warm !== false) {
      isWarming = true
      warmupActive(active._id).then(() => {
        isWarming = false
        loadIndex({ warm: false })
      })
    }

    const items = []
    for (const c of liveData) {
      items.push({
        kind: "live",
        id: Number(c.id),
        name: c.name || "",
        logo: c.logo || null,
        subtitle: c.category || "Live",
        href: buildHref("live", c.id),
        norm: c.norm || normalize(`${c.name || ""} ${c.category || ""}`),
      })
    }
    for (const m of vodData) {
      items.push({
        kind: "vod",
        id: Number(m.id),
        name: m.name || "",
        logo: m.logo || null,
        subtitle: m.year ? `Movie · ${m.year}` : "Movie",
        href: buildHref("vod", m.id),
        norm: m.norm || normalize(`${m.name || ""} ${m.category || ""}`),
      })
    }
    for (const s of seriesData) {
      items.push({
        kind: "series",
        id: Number(s.id),
        name: s.name || "",
        logo: s.logo || null,
        subtitle: s.year ? `Series · ${s.year}` : "Series",
        href: buildHref("series", s.id),
        norm: s.norm || normalize(`${s.name || ""} ${s.category || ""}`),
      })
    }

    const epgState = getProgrammesSync(active._id)
    const hasTvgChannels = liveData.some((channel) => channel.tvgId)
    if (hasTvgChannels && !epgState && opts.warmEpg !== false) {
      try {
        const creds = await loadCreds()
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

  function syncUrl(q) {
    try {
      const url = new URL(window.location.href)
      if (q) url.searchParams.set("q", q)
      else url.searchParams.delete("q")
      window.history.replaceState({}, "", url.toString())
    } catch {}
  }

  let scoredAll = $derived.by(() => {
    const counts = { all: 0, live: 0, vod: 0, series: 0, epg: 0 }
    const q = normalize(queryDebounced.trim())
    if (!q) return { items: [], counts }
    const tokens = q.split(" ").filter(Boolean)
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
      for (let t = 0; t < tokensLen; t++) {
        const tok = tokens[t]
        const idx = norm.indexOf(tok)
        if (idx === -1) {
          allMatch = false
          break
        }
        score += 100 - (idx > 99 ? 99 : idx) + (norm.startsWith(tok) ? 25 : 0)
      }
      if (allMatch) {
        counts.all++
        counts[item.kind]++
        if (matched.length < HARD_CAP) matched.push({ item, score })
      }
    }
    matched.sort((a, b) => b.score - a.score)
    return { items: matched, counts }
  })

  let results = $derived.by(() => {
    const items = scoredAll.items
    const k = kindFilter
    const out = []
    const MAX = 200
    for (let i = 0; i < items.length && out.length < MAX; i++) {
      const it = items[i].item
      if (k !== "all" && it.kind !== k) continue
      out.push(it)
    }
    return out
  })

  let kindCounts = $derived(scoredAll.counts)

  $effect(() => {
    void results
    if (activeIndex >= results.length) activeIndex = 0
  })

  function navigate(item) {
    if (!item) return
    window.location.href = item.href
  }

  function onKey(ev) {
    const onInput = document.activeElement === inputEl
    if (onInput && ev.key === "ArrowDown") {
      ev.preventDefault()
      if (results.length) activeIndex = (activeIndex + 1) % results.length
    } else if (onInput && ev.key === "ArrowUp") {
      ev.preventDefault()
      if (results.length)
        activeIndex = (activeIndex - 1 + results.length) % results.length
    } else if (ev.key === "Enter" && onInput) {
      ev.preventDefault()
      navigate(results[activeIndex])
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
    loadIndex()
    function onWarmed() {
      loadIndex({ warm: false })
    }
    function onEpgLoaded() {
      loadIndex({ warm: false, warmEpg: false })
    }
    document.addEventListener("xt:catalog-warmed", onWarmed)
    document.addEventListener(EPG_LOADED_EVENT, onEpgLoaded)
    document.addEventListener("xt:active-changed", () => loadIndex())
    if (focusOnMount) {
      tick().then(() => {
        inputEl?.focus()
        inputEl?.select?.()
      })
    }
    return () => {
      document.removeEventListener("xt:catalog-warmed", onWarmed)
      document.removeEventListener(EPG_LOADED_EVENT, onEpgLoaded)
      if (_queryTimer) clearTimeout(_queryTimer)
    }
  })
</script>

<svelte:window onkeydown={onKey} />

<section class="search-view flex flex-col gap-4 flex-1 min-h-0">
  <div class="flex flex-col gap-3 shrink-0">
    <div class="search-input-wrap flex items-center gap-2 px-3 py-2 rounded-xl border border-line bg-surface focus-within:border-accent transition-[border-color,box-shadow] duration-200 ease-out">
      <svg xmlns="http://www.w3.org/2000/svg" width="1.125rem" height="1.125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="text-fg-3 shrink-0">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
      </svg>
      <input
        bind:this={inputEl}
        value={query}
        oninput={(ev) => {
          const v = ev.currentTarget.value
          query = v
          setQueryDebounced(v)
        }}
        type="search"
        placeholder={t("search.placeholderFull")}
        aria-label={t("common.search")}
        autocomplete="off"
        spellcheck="false"
        class="flex-1 min-w-0 bg-transparent text-fg placeholder:text-fg-3 outline-none py-2 text-base" />
      {#if query}
        <button
          type="button"
          onclick={() => {
            query = ""
            queryDebounced = ""
            syncUrl("")
            inputEl?.focus()
          }}
          aria-label={t("search.clear")}
          class="search-clear size-7 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-2 outline-none focus-visible:bg-surface-2 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1rem" height="1rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      {/if}
    </div>

    <div class="flex items-center gap-1 overflow-x-auto custom-scroll -mx-1 px-1">
      {#each /** @type {const} */ (["all", "live", "vod", "series", "epg"]) as k}
        <button
          type="button"
          onclick={() => (kindFilter = k)}
          aria-pressed={kindFilter === k}
          class="filter-chip rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors outline-none border"
          class:bg-accent-soft={kindFilter === k}
          class:text-accent={kindFilter === k}
          class:border-accent={kindFilter === k}
          class:text-fg-2={kindFilter !== k}
          class:border-line={kindFilter !== k}
          class:hover:bg-surface-2={kindFilter !== k}>
          {k === "all"
            ? t("common.all")
            : k === "vod"
            ? t("nav.movies")
            : k === "live"
            ? t("nav.livetv")
            : k === "epg"
            ? t("nav.epg")
            : t("nav.series")}
          {#if queryDebounced.trim()}
            <span class="ml-1.5 text-2xs tabular-nums opacity-70">{kindCounts[k]}</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  {#snippet warming(hint)}
    <div class="flex items-center justify-center gap-2 mb-2">
      <svg viewBox="0 0 24 24" width="1rem" height="1rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" class="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.2-8.55"/>
      </svg>
      <span>{t("search.loadingCatalog")}</span>
    </div>
    <div class="text-2xs">{hint}</div>
  {/snippet}

  <div class="flex-1 min-h-0 overflow-auto custom-scroll">
    {#if !queryDebounced.trim()}
      <div class="px-4 py-12 text-center text-sm text-fg-3 max-w-md mx-auto">
        {#if isWarming}
          {@render warming(t("search.warmingHint"))}
        {:else}
          <p class="text-base text-fg-2 mb-1">{t("search.helpHeading")}</p>
          <p class="text-2xs">{t("search.helpKbd")}</p>
        {/if}
      </div>
    {:else if !results.length}
      <div class="px-4 py-12 text-center text-sm text-fg-3 max-w-md mx-auto">
        {#if isWarming}
          {@render warming(t("search.warmingResultsHint"))}
        {:else}
          <p>{t("search.noResults", { query: queryDebounced.trim() })}</p>
          {#if kindFilter !== "all" && kindCounts.all > 0}
            <button
              type="button"
              onclick={() => (kindFilter = "all")}
              class="mt-4 inline-flex items-center justify-center min-h-11 px-3.5 rounded-lg border border-line bg-surface text-sm text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors outline-none">
              {t("search.showAllKinds", { n: kindCounts.all })}
            </button>
          {/if}
        {/if}
      </div>
    {:else}
      <ul class="flex flex-col gap-1 pb-4">
        {#each results as r, i (r.kind + ":" + r.id)}
          <li class="result-row" style:--enter-delay={Math.min(i, 12) * 18 + "ms"}>
            <a
              href={r.href}
              onmouseenter={() => (activeIndex = i)}
              onfocus={() => (activeIndex = i)}
              class="w-full text-left rounded-lg px-2.5 py-2 flex items-center gap-3 outline-none transition-colors focus-visible:bg-surface-2"
              class:bg-surface-2={activeIndex === i}>
              <span class="size-12 shrink-0 rounded-md bg-surface-2 ring-1 ring-line overflow-hidden flex items-center justify-center">
                {#if r.logo}
                  <img
                    src={r.logo}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    class="h-full w-full"
                    class:object-cover={r.kind !== "live"}
                    class:object-contain={r.kind === "live"} />
                {:else}
                  <span class="text-2xs text-fg-3 uppercase">{KIND_LABEL[r.kind][0]}</span>
                {/if}
              </span>
              <span class="flex-1 min-w-0">
                <span class="block truncate text-sm text-fg">{r.name}</span>
                <span class="block truncate text-2xs text-fg-3">{r.subtitle}</span>
              </span>
              <span class="shrink-0 text-2xs uppercase tracking-wide text-fg-3 px-1.5 py-0.5 rounded border border-line">
                {KIND_LABEL[r.kind]}
              </span>
            </a>
          </li>
        {/each}
        {#if scoredAll.items.length >= 500}
          <li class="px-3 py-3 text-center text-2xs text-fg-3 italic">
            {t("search.showingTop", { n: results.length })}
          </li>
        {/if}
      </ul>
    {/if}
  </div>
</section>

<style>
  .result-row {
    animation: result-enter 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--enter-delay, 0ms);
  }
  @keyframes result-enter {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .search-input-wrap:focus-within {
    box-shadow: 0 0 0 4px var(--color-accent-soft);
  }

  @media (pointer: coarse) {
    .search-clear {
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
