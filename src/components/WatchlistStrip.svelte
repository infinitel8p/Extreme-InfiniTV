<script>
  // Hub "Watchlist" strip - VOD + series the user marked "watch later" for
  // the active playlist. Newest entries first (sorted by saved-time).
  import { onMount } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getWatchlist,
    setWatchlistMeta,
  } from "@/scripts/lib/preferences.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { KIND_LABEL, KIND_ICON_SVG } from "@/scripts/lib/kinds.js"

  /** @type {Array<{ kind: "vod"|"series", id: number, name: string, logo: string|null, subtitle: string, href: string }>} */
  let entries = $state([])
  let activePlaylistId = $state("")
  /** @type {{ vod: Map<number, any>, series: Map<number, any> } | null} */
  let lookups = null
  let lookupsForPlaylistId = ""

  function buildEntry(playlistId, kind, id, meta, lookups) {
    const item = lookups[kind]?.get(Number(id))
    const name = meta?.name || item?.name || `${KIND_LABEL[kind]} ${id}`
    const logo = meta?.logo ?? item?.logo ?? null
    if (!meta?.name && !meta?.logo && (item?.name || item?.logo)) {
      setWatchlistMeta(playlistId, kind, id, {
        name: item.name || "",
        logo: item.logo || null,
      })
    }
    const href =
      kind === "vod"
        ? `/movies/detail?id=${encodeURIComponent(id)}`
        : `/series/detail?id=${encodeURIComponent(id)}`
    return { kind, id, name, logo, subtitle: KIND_LABEL[kind], href }
  }

  async function rebuildLookups(playlistId) {
    if (!playlistId) {
      lookups = null
      lookupsForPlaylistId = ""
      return
    }
    await Promise.all([
      hydrateCache(playlistId, "vod"),
      hydrateCache(playlistId, "series"),
    ])
    lookups = {
      vod: new Map(
        (getCached(playlistId, "vod")?.data || []).map((m) => [Number(m.id), m])
      ),
      series: new Map(
        (getCached(playlistId, "series")?.data || []).map((s) => [
          Number(s.id),
          s,
        ])
      ),
    }
    lookupsForPlaylistId = playlistId
  }

  async function reload() {
    const active = await getActiveEntry()
    if (!active) {
      entries = []
      activePlaylistId = ""
      lookups = null
      return
    }
    activePlaylistId = active._id
    await ensurePrefsLoaded()
    if (lookupsForPlaylistId !== active._id || !lookups) {
      await rebuildLookups(active._id)
    }
    /** @type {Array<{ kind: "vod"|"series", id: number, ts: number, meta: any }>} */
    const merged = []
    for (const kind of /** @type {const} */ (["vod", "series"])) {
      const bag = getWatchlist(active._id, kind)
      for (const [stringId, meta] of Object.entries(bag)) {
        merged.push({
          kind,
          id: Number(stringId),
          ts: meta?.ts || 0,
          meta,
        })
      }
    }
    merged.sort((a, b) => b.ts - a.ts)
    entries = merged
      .slice(0, 12)
      .map((row) =>
        buildEntry(active._id, row.kind, row.id, row.meta, lookups || {})
      )
  }

  onMount(() => {
    reload()
    async function onCatalogChanged() {
      lookups = null
      lookupsForPlaylistId = ""
      await reload()
    }
    const handlers = {
      "xt:active-changed": onCatalogChanged,
      "xt:catalog-warmed": onCatalogChanged,
      "xt:watchlist-changed": reload,
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
    aria-label="Watchlist"
    class="watch-section flex flex-col gap-3 shrink-0">
    <div class="hub-section-head px-1">
      <div class="hub-section-head__title">
        <h2 class="hub-section-head__heading">Watchlist</h2>
      </div>
      <a
        href="/watchlist"
        class="hub-section-head__count text-fg-3 hover:text-accent focus-visible:text-accent transition-colors">
        View all
        <svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ml-0.5 inline-block align-[-1px]">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </a>
    </div>

    <ul
      class="watch-strip flex gap-3 sm:gap-4 overflow-x-auto custom-scroll
             snap-x snap-mandatory py-3 -my-2 -mx-2 px-2">
      {#each entries as entry, idx (entry.kind + ":" + entry.id)}
        <li class="watch-item shrink-0 snap-start" data-kind={entry.kind} style:--enter-delay={Math.min(idx, 8) * 28 + "ms"}>
          <a
            href={entry.href}
            aria-label={`Open ${entry.name}`}
            class="watch-card group relative block rounded-xl overflow-hidden
                   bg-surface-2 ring-1 ring-line
                   transition-[transform,box-shadow] duration-150
                   hover:ring-[3px] hover:ring-accent
                   focus-visible:ring-[3px] focus-visible:ring-accent
                   hover:transform-[translateY(-2px)]
                   focus-visible:transform-[translateY(-2px)]">
            <div class="watch-thumb w-full aspect-2-3 overflow-hidden bg-surface-2 relative">
              {#if entry.logo}
                <img
                  src={entry.logo}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
              {:else}
                <div
                  class="h-full w-full flex flex-col items-center justify-center gap-2 px-3
                         text-fg-3 bg-linear-to-br from-surface-2 to-surface-3">
                  <span class="size-7 opacity-60 inline-flex items-center justify-center" aria-hidden="true">{@html KIND_ICON_SVG[entry.kind]}</span>
                  <span class="text-2xs text-center truncate max-w-full">{entry.name}</span>
                </div>
              {/if}

              <span
                class="absolute top-1.5 left-1.5 text-label font-medium uppercase tracking-wide
                       rounded-md px-1.5 py-0.5 bg-black/55 text-white/85 backdrop-blur-sm ring-1 ring-white/10">
                {entry.subtitle}
              </span>

              <span
                aria-hidden="true"
                class="absolute top-1.5 right-1.5 inline-flex items-center justify-center
                       size-6 rounded-md bg-black/55 text-accent backdrop-blur-sm ring-1 ring-white/10">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M6 3a2 2 0 0 0-2 2v16l8-4 8 4V5a2 2 0 0 0-2-2H6z" />
                </svg>
              </span>
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
  .watch-item {
    width: 8rem;
    animation: watch-enter 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--enter-delay, 0ms);
  }
  @media (min-width: 40em) {
    .watch-item {
      width: 9.5rem;
    }
  }
  @media (min-width: 64em) {
    .watch-item {
      width: 11rem;
    }
  }

  @keyframes watch-enter {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .aspect-2-3 { aspect-ratio: 2 / 3; }

  :global(html[data-first-run="true"]) .watch-section { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .watch-item { animation: none; }
  }
</style>
