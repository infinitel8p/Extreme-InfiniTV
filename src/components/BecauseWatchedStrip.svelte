<script>
  // Hub "Because you watched X" strip - rotates through a pool of recent watched seeds.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { dragScroll } from "@/scripts/lib/drag-scroll.ts"
  import { hubCardMenu } from "@/scripts/lib/hub-card-menu.ts"
  import {
    getWatchedSignals,
    isCompleted,
    hasSeriesWatchedOverride,
    getSeriesEpisodeProgress,
  } from "@/scripts/lib/preferences.js"
  import { getCached, getCachedByKindPrefix, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { extractEpisodeIds, requestEpisodeIds } from "@/scripts/lib/series-seasons.ts"
  import { parseProviderPeople } from "@/scripts/lib/similar-local.ts"
  import { fmtImdbRating } from "@/scripts/lib/format.js"
  import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"
  import { pickBecauseSeedPool, seedKey, pickNextSeed, buildBecauseRow } from "@/scripts/lib/because-watched.ts"
  import { cachedImg } from "@/scripts/lib/img-cache.ts"

  const SEED_KEY_PREFIX = "xt_because_seed:"

  function readStoredSeedKey(playlistId) {
    if (!playlistId) return null
    try {
      return localStorage.getItem(SEED_KEY_PREFIX + playlistId) || null
    } catch {
      return null
    }
  }

  function writeStoredSeedKey(playlistId, key) {
    if (!playlistId) return
    try {
      localStorage.setItem(SEED_KEY_PREFIX + playlistId, key)
    } catch {
      return
    }
  }

  /** @type {Array<{ kind: "vod"|"series", id: number, name: string, logo: string|null, rating: string, href: string }>} */
  let entries = $state([])
  let displayTitle = $state("")
  let activePlaylistId = $state("")
  let locale = $state(0)
  const tr = (key, params) => (locale, t(key, params))

  let requestToken = 0
  let chosenSeedKey = null

  function providerInfoForVod(cachedData) {
    return cachedData?.info || cachedData?.movie_data || cachedData || {}
  }

  function buildInfoLookup(rows, prefixLength, kind) {
    const mapEntries = rows
      .map((row) => {
        const id = Number(row.kind.slice(prefixLength))
        if (!Number.isFinite(id)) return null
        const info = kind === "vod" ? providerInfoForVod(row.data) : row.data?.info || {}
        return [id, parseProviderPeople(info)]
      })
      .filter(Boolean)
    const map = new Map(mapEntries)
    return (id) => map.get(Number(id)) || null
  }

  // Mirrors series.ts recomputeFullyWatched: override wins, else every real episode id must be completed.
  async function resolveWatchedSeriesIds(playlistId, seriesInfoRows, prefixLength) {
    const knownEpisodeIds = new Map(
      seriesInfoRows
        .map((row) => {
          const id = Number(row.kind.slice(prefixLength))
          if (!Number.isFinite(id)) return null
          return [id, extractEpisodeIds(row.data)]
        })
        .filter(Boolean)
    )

    const candidateIds = new Set(
      getWatchedSignals(playlistId, 20)
        .filter((signal) => signal.kind === "episode")
        .map((signal) => Number(signal.seriesId))
        .filter((seriesId) => Number.isFinite(seriesId))
    )

    const resolutions = await Promise.all(
      Array.from(candidateIds, async (seriesId) => {
        if (hasSeriesWatchedOverride(playlistId, seriesId)) return seriesId

        const progress = getSeriesEpisodeProgress(playlistId, seriesId)
        if (!progress.completedIds.length || progress.hasIncompleteEpisode) return null
        const completedIds = new Set(progress.completedIds)

        const knownIds = knownEpisodeIds.get(seriesId)
        const episodeIds =
          knownIds && knownIds.length
            ? knownIds
            : await requestEpisodeIds(playlistId, seriesId).catch(() => null)

        const fullyWatched =
          !!episodeIds?.length && episodeIds.every((episodeId) => completedIds.has(episodeId))
        return fullyWatched ? seriesId : null
      })
    )

    return new Set(resolutions.filter((seriesId) => seriesId != null))
  }

  function buildCard(kind, item) {
    const href =
      kind === "vod"
        ? `/movies/detail?id=${encodeURIComponent(item.id)}`
        : `/series/detail?id=${encodeURIComponent(item.id)}`
    return {
      kind,
      id: Number(item.id),
      name: item.name,
      logo: item.logo || null,
      rating: fmtImdbRating(item.rating),
      href,
    }
  }

  function pickSeedForThisCompute(playlistId, pool) {
    if (chosenSeedKey) {
      const stillInPool = pool.find((candidate) => seedKey(candidate) === chosenSeedKey)
      return stillInPool || pickNextSeed(pool, chosenSeedKey)
    }
    return pickNextSeed(pool, readStoredSeedKey(playlistId))
  }

  async function reload() {
    const active = await getActiveEntry()
    const token = ++requestToken
    if (!active) {
      entries = []
      activePlaylistId = ""
      return
    }
    const playlistId = active._id
    activePlaylistId = playlistId

    const pool = pickBecauseSeedPool(getWatchedSignals(playlistId, 20), 5)
    if (!pool.length) {
      entries = []
      return
    }
    const seed = pickSeedForThisCompute(playlistId, pool)
    if (!seed) {
      entries = []
      return
    }

    const catalogByKind = {}
    async function catalogFor(kind) {
      if (kind in catalogByKind) return catalogByKind[kind]
      await hydrateCache(playlistId, kind)
      catalogByKind[kind] = getCached(playlistId, kind)?.data || []
      return catalogByKind[kind]
    }

    const infoRowsByKind = {}
    async function infoRowsFor(kind) {
      if (kind in infoRowsByKind) return infoRowsByKind[kind]
      const prefix = kind === "vod" ? "vod_info_" : "series_info_"
      const rows = await getCachedByKindPrefix(playlistId, prefix)
      infoRowsByKind[kind] = { rows, prefixLength: prefix.length }
      return infoRowsByKind[kind]
    }

    let watchedSeriesIdsPromise = null
    function watchedSeriesIdsFor(rowsEntry) {
      if (!watchedSeriesIdsPromise) {
        watchedSeriesIdsPromise = resolveWatchedSeriesIds(playlistId, rowsEntry.rows, rowsEntry.prefixLength)
      }
      return watchedSeriesIdsPromise
    }

    async function attemptSeed(candidateSeed) {
      const catalog = await catalogFor(candidateSeed.kind)
      if (token !== requestToken) return null
      if (!catalog.length) return []

      const rowsEntry = await infoRowsFor(candidateSeed.kind)
      if (token !== requestToken) return null
      const infoLookup = buildInfoLookup(rowsEntry.rows, rowsEntry.prefixLength, candidateSeed.kind)

      let isWatched
      if (candidateSeed.kind === "vod") {
        isWatched = (id) => isCompleted(playlistId, "vod", id)
      } else {
        const watchedSeriesIds = await watchedSeriesIdsFor(rowsEntry)
        if (token !== requestToken) return null
        isWatched = (id) => watchedSeriesIds.has(Number(id))
      }
      return buildBecauseRow(candidateSeed, catalog, { limit: 12, infoLookup, isWatched })
    }

    let candidateSeed = seed
    let lastAttemptedSeed = seed
    let shownSeed = null
    let shownItems = []
    for (let attempt = 0; attempt < pool.length; attempt++) {
      lastAttemptedSeed = candidateSeed
      const row = await attemptSeed(candidateSeed)
      if (token !== requestToken) return
      if (row.length) {
        shownSeed = candidateSeed
        shownItems = row
        break
      }
      candidateSeed = pickNextSeed(pool, seedKey(candidateSeed))
      if (!candidateSeed) break
    }

    const persistedSeed = shownSeed || lastAttemptedSeed
    writeStoredSeedKey(playlistId, seedKey(persistedSeed))
    chosenSeedKey = seedKey(persistedSeed)

    if (!shownSeed) {
      entries = []
      return
    }
    displayTitle = cleanProviderTitle(shownSeed.name).variants[0] || shownSeed.name
    entries = shownItems.map((item) => buildCard(shownSeed.kind, item))
  }

  onMount(() => {
    reload()
    let pendingReload = false
    function scheduleReload() {
      if (pendingReload) return
      pendingReload = true
      requestAnimationFrame(async () => {
        pendingReload = false
        await reload()
      })
    }
    function onActiveChanged() {
      chosenSeedKey = null
      scheduleReload()
    }
    const onLocaleChange = () => { locale++ }
    const handlers = {
      "xt:active-changed": onActiveChanged,
      "xt:catalog-warmed": scheduleReload,
      "xt:progress-changed": scheduleReload,
      [LOCALE_EVENT]: onLocaleChange,
    }
    for (const [eventName, handler] of Object.entries(handlers)) {
      document.addEventListener(eventName, handler)
    }
    return () => {
      for (const [eventName, handler] of Object.entries(handlers)) {
        document.removeEventListener(eventName, handler)
      }
    }
  })
</script>

{#if entries.length}
  <section
    aria-label={tr("hub.strip.becauseYouWatched", { title: displayTitle })}
    class="bw-section flex flex-col gap-3 shrink-0">
    <div class="hub-section-head px-1">
      <div class="hub-section-head__title">
        <h2 class="hub-section-head__heading">{tr("hub.strip.becauseYouWatched", { title: displayTitle })}</h2>
      </div>
    </div>

    <ul
      use:dragScroll
      class="bw-strip flex gap-3 sm:gap-4 overflow-x-auto custom-scroll
             snap-x snap-mandatory py-3 -my-2 -mx-2 px-2">
      {#each entries as entry, idx (entry.id)}
        <li class="bw-item shrink-0 snap-start" style:--enter-delay={Math.min(idx, 8) * 28 + "ms"}>
          <a
            href={entry.href}
            aria-label={entry.name}
            use:hubCardMenu={{
              kind: entry.kind,
              id: entry.id,
              name: entry.name,
              logo: entry.logo,
              playlistId: activePlaylistId,
            }}
            class="bw-card group relative block rounded-xl overflow-hidden
                   bg-surface-2 ring-1 ring-line
                   transition-[transform,box-shadow] duration-150
                   hover:ring-[3px] hover:ring-accent
                   outline-none focus-visible:ring-1 focus-visible:ring-accent
                   hover:transform-[translateY(-2px)]
                   focus-visible:transform-[translateY(-2px)]">
            <div class="bw-thumb w-full aspect-2-3 overflow-hidden bg-surface-2 relative">
              {#if entry.logo}
                <img
                  use:cachedImg={{ url: entry.logo, kind: "poster" }}
                  alt=""
                  loading="lazy" fetchpriority="low"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  width="200" height="300"
                  class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
              {:else}
                <div
                  class="h-full w-full flex flex-col items-center justify-center gap-2 px-3
                         text-fg-3 bg-linear-to-br from-surface-2 to-surface-3">
                  <span class="text-2xs text-center truncate max-w-full">{entry.name}</span>
                </div>
              {/if}

              {#if entry.rating}
                <span
                  class="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1
                         rounded-md px-1.5 py-0.5 bg-black/55 backdrop-blur-sm
                         ring-1 ring-white/10 text-white/90 text-2xs font-semibold tabular-nums"
                  aria-label={`Rating ${entry.rating} out of 10`}>
                  <svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" class="text-accent">
                    <path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z" />
                  </svg>
                  <span>{entry.rating}</span>
                </span>
              {/if}
            </div>

            <div class="px-2 py-2 min-w-0">
              <div class="truncate text-sm font-medium text-fg">
                {entry.name}
              </div>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .bw-item {
    width: 8rem;
    animation: bw-enter 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--enter-delay, 0ms);
  }
  @media (min-width: 40em) {
    .bw-item {
      width: 9.5rem;
    }
  }
  @media (min-width: 64em) {
    .bw-item {
      width: 11rem;
    }
  }

  @keyframes bw-enter {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .aspect-2-3 { aspect-ratio: 2 / 3; }

  :global(html[data-first-run="true"]) .bw-section { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .bw-item { animation: none; }
  }
</style>
