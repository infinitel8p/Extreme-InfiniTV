<script>
  // Hub "Favorites" strip - cross-kind favorites for the active playlist.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getGlobalFavorites,
    getFavoriteMeta,
    setFavoriteMeta,
  } from "@/scripts/lib/preferences.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { kindLabel, KIND_ICON_SVG } from "@/scripts/lib/kinds.js"

  /** @type {Array<{ kind: "live"|"vod"|"series", id: number, name: string, logo: string|null, href: string }>} */
  let entries = $state([])
  let activePlaylistId = $state("")
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {kl(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const kl = (kind) => (locale, kindLabel(kind))
  /** @type {{ live: Map<number, any>, vod: Map<number, any>, series: Map<number, any> } | null} */
  let lookups = null
  let lookupsForPlaylistId = ""

  function buildEntry(playlistId, { kind, id }, lookups) {
    const meta = getFavoriteMeta(playlistId, kind, id)
    const item = lookups[kind]?.get(Number(id))
    // `kindLabel(kind)` here is build-time fallback for items without meta;
    // the badge in the template uses the locale-tracking wrapper so it stays
    // current without rebuilding the array.
    const name = meta?.name || item?.name || `${kindLabel(kind)} ${id}`
    const logo = meta?.logo ?? item?.logo ?? null
    if (!meta && (item?.name || item?.logo)) {
      setFavoriteMeta(playlistId, kind, id, {
        name: item.name || "",
        logo: item.logo || null,
      })
    }
    let href = "#"
    if (kind === "live") {
      href = `/livetv?channel=${encodeURIComponent(id)}`
    } else if (kind === "vod") {
      href = `/movies/detail?id=${encodeURIComponent(id)}`
    } else if (kind === "series") {
      href = `/series/detail?id=${encodeURIComponent(id)}`
    }
    return { kind, id, name, logo, href }
  }

  async function rebuildLookups(playlistId) {
    if (!playlistId) {
      lookups = null
      lookupsForPlaylistId = ""
      return
    }
    await Promise.all([
      hydrateCache(playlistId, "live"),
      hydrateCache(playlistId, "m3u"),
      hydrateCache(playlistId, "vod"),
      hydrateCache(playlistId, "series"),
    ])
    lookups = {
      live: new Map(
        (
          getCached(playlistId, "live")?.data ||
          getCached(playlistId, "m3u")?.data ||
          []
        ).map((c) => [Number(c.id), c])
      ),
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
    const raw = getGlobalFavorites(active._id)
    entries = raw.map((e) => buildEntry(active._id, e, lookups || {})).slice(0, 12)
  }

  onMount(() => {
    reload()
    // Catalog-changing events: invalidate lookup Maps before reloading.
    // `xt:catalog-warmed` fires once per kind, so up to 4 events arrive in
    // rapid succession; rAF dedupe collapses them into a single reload.
    let pendingCatalog = false
    function onCatalogChanged() {
      if (pendingCatalog) return
      pendingCatalog = true
      requestAnimationFrame(async () => {
        pendingCatalog = false
        lookups = null
        lookupsForPlaylistId = ""
        await reload()
      })
    }
    // Favorites-only events: keep lookups, just rebuild the entries list.
    const onLocaleChange = () => { locale++ }
    const handlers = {
      "xt:active-changed": onCatalogChanged,
      "xt:catalog-warmed": onCatalogChanged,
      "xt:favorites-changed": reload,
      "xt:favorites-order-changed": reload,
      [LOCALE_EVENT]: onLocaleChange,
    }
    for (const [k, v] of Object.entries(handlers)) {
      document.addEventListener(k, v)
    }
    return () => {
      for (const [k, v] of Object.entries(handlers)) {
        document.removeEventListener(k, v)
      }
    }
  })
</script>

{#if entries.length}
  <section
    aria-label={tr("nav.favorites")}
    class="fav-section flex flex-col gap-3 shrink-0">
    <div class="hub-section-head px-1">
      <div class="hub-section-head__title">
        <h2 class="hub-section-head__heading">{tr("nav.favorites")}</h2>
      </div>
      <a
        href="/favorites"
        class="hub-section-head__count text-fg-3 hover:text-accent focus-visible:text-accent transition-colors">
        {tr("strip.viewAll")}
        <svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ml-0.5 inline-block align-[-1px]">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </a>
    </div>

    <ul
      class="fav-strip flex gap-3 sm:gap-4 overflow-x-auto custom-scroll
             snap-x snap-mandatory py-3 -my-2 -mx-2 px-2">
      {#each entries as e, i (e.kind + ":" + e.id)}
        <li class="fav-item shrink-0 snap-start" data-kind={e.kind} style:--enter-delay={Math.min(i, 8) * 28 + "ms"}>
          <a
            href={e.href}
            aria-label={tr("favorites.itemAriaLabel", { name: e.name })}
            class="fav-card group relative block rounded-xl overflow-hidden
                   bg-surface-2 ring-1 ring-line
                   transition-[transform,box-shadow] duration-150
                   hover:ring-[3px] hover:ring-accent
                   focus-visible:ring-[3px] focus-visible:ring-accent
                   hover:transform-[translateY(-2px)]
                   focus-visible:transform-[translateY(-2px)]">
            <div class="fav-thumb w-full aspect-2-3 overflow-hidden bg-surface-2 relative">
              {#if e.logo}
                {#if e.kind === "live"}
                  <img
                    src={e.logo}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    class="absolute inset-0 h-full w-full object-cover scale-110 saturate-150 brightness-75 opacity-60 blur-2xl pointer-events-none" />
                  <div class="absolute inset-0 flex items-center justify-center p-3">
                    <img
                      src={e.logo}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      class="relative max-h-full max-w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]" />
                  </div>
                {:else}
                  <img
                    src={e.logo}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                {/if}
              {:else}
                <div
                  class="h-full w-full flex flex-col items-center justify-center gap-2 px-3
                         text-fg-3 bg-linear-to-br from-surface-2 to-surface-3">
                  <span class="size-7 opacity-60 inline-flex items-center justify-center" aria-hidden="true">{@html KIND_ICON_SVG[e.kind]}</span>
                  <span class="text-2xs text-center truncate max-w-full">{e.name}</span>
                </div>
              {/if}

              <span
                class="absolute top-1.5 left-1.5 text-label font-medium uppercase tracking-wide
                       rounded-md px-1.5 py-0.5 bg-black/55 text-white/85 backdrop-blur-sm ring-1 ring-white/10">
                {kl(e.kind)}
              </span>
            </div>

            <div class="px-2 py-2 min-w-0">
              <div class="truncate text-sm font-medium text-fg">
                {e.name}
              </div>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .fav-item {
    width: 8rem;
    animation: fav-enter 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--enter-delay, 0ms);
  }
  @media (min-width: 40em) {
    .fav-item {
      width: 9.5rem;
    }
  }
  @media (min-width: 64em) {
    .fav-item {
      width: 11rem;
    }
  }

  @keyframes fav-enter {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .aspect-2-3 { aspect-ratio: 2 / 3; }

  :global(html[data-first-run="true"]) .fav-section { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .fav-item { animation: none; }
  }
</style>
