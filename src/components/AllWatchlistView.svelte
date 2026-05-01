<script>
  // Cross-playlist watchlist view - mirror of AllFavoritesView, but only
  // movies and series and sorted by added-time (newest first).
  import { onMount } from "svelte"
  import { log } from "@/scripts/lib/log.js"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getEntries, getActiveEntry, selectEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getAllGlobalWatchlist,
    setWatchlistMeta,
  } from "@/scripts/lib/preferences.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { kindLabel, KIND_ICON_SVG } from "@/scripts/lib/kinds.js"
  import { IconExternalLink } from "@tabler/icons-svelte"

  /** @type {"all"|"vod"|"series"} */
  let filter = $state("all")
  let activePlaylistId = $state("")
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {kl(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const kl = (kind) => (locale, kindLabel(kind))
  /** @type {Array<{ id: string, title: string }>} */
  let playlists = $state([])
  /** @type {Array<{
   *   playlistId: string,
   *   playlistTitle: string,
   *   kind: "vod"|"series",
   *   id: number,
   *   ts: number,
   *   name: string,
   *   logo: string|null,
   *   href: string,
   *   isCrossPlaylist: boolean,
   * }>} */
  let entries = $state([])
  let loading = $state(true)

  const counts = $derived({
    all: entries.length,
    vod: entries.filter((row) => row.kind === "vod").length,
    series: entries.filter((row) => row.kind === "series").length,
  })

  const visible = $derived(
    filter === "all" ? entries : entries.filter((row) => row.kind === filter)
  )

  function buildHref(kind, id) {
    if (kind === "vod") return `/movies/detail?id=${encodeURIComponent(id)}`
    return `/series/detail?id=${encodeURIComponent(id)}`
  }

  async function reload() {
    await ensurePrefsLoaded()
    const allEntries = await getEntries()
    const active = await getActiveEntry()
    activePlaylistId = active?._id || ""
    playlists = allEntries.map((entry) => ({
      id: entry._id,
      title: entry.title || "Untitled playlist",
    }))

    // Hydrate every playlist's catalogs in parallel so name / poster lookups
    // resolve for items that have no stored meta yet.
    await Promise.all(
      allEntries.flatMap((entry) => [
        hydrateCache(entry._id, "vod"),
        hydrateCache(entry._id, "series"),
      ])
    )

    /** @type {Map<string, { vod: Map<number, any>, series: Map<number, any> }>} */
    const lookups = new Map()
    for (const entry of allEntries) {
      lookups.set(entry._id, {
        vod: new Map(
          (getCached(entry._id, "vod")?.data || []).map((item) => [
            Number(item.id),
            item,
          ])
        ),
        series: new Map(
          (getCached(entry._id, "series")?.data || []).map((item) => [
            Number(item.id),
            item,
          ])
        ),
      })
    }

    const titleById = new Map(playlists.map((entry) => [entry.id, entry.title]))
    const raw = getAllGlobalWatchlist()
    entries = raw.map((row) => {
      const item = lookups.get(row.playlistId)?.[row.kind]?.get(Number(row.id))
      const name = row.name || item?.name || `${kindLabel(row.kind)} ${row.id}`
      const logo = row.logo ?? item?.logo ?? null
      // Lazily backfill stored meta so cross-playlist clicks still have name
      // and poster even when the source catalog cache later expires.
      if (!row.name && !row.logo && (item?.name || item?.logo)) {
        setWatchlistMeta(row.playlistId, row.kind, row.id, {
          name: item.name || "",
          logo: item.logo || null,
        })
      }
      return {
        playlistId: row.playlistId,
        playlistTitle: titleById.get(row.playlistId) || "Removed playlist",
        kind: row.kind,
        id: Number(row.id),
        ts: row.ts,
        name,
        logo,
        href: buildHref(row.kind, row.id),
        isCrossPlaylist: row.playlistId !== activePlaylistId,
      }
    })
    loading = false
  }

  async function openCard(event, entry) {
    if (!entry.isCrossPlaylist) return
    event.preventDefault()
    try {
      await selectEntry(entry.playlistId)
    } catch (err) {
      log.error("[xt:watchlist] selectEntry failed:", err)
    }
    window.location.href = entry.href
  }

  function setFilter(next) {
    filter = next
  }

  onMount(() => {
    reload()
    const onLocale = () => { locale++ }
    const handlers = {
      "xt:active-changed": reload,
      "xt:entries-updated": reload,
      "xt:watchlist-changed": reload,
      "xt:catalog-warmed": reload,
      [LOCALE_EVENT]: onLocale,
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

<div class="flex flex-col gap-3 shrink-0">
  <div class="flex flex-wrap gap-2" role="tablist" aria-label={tr("watchlist.heading")}>
    {#each [
      { id: "all", key: "favorites.filter.all" },
      { id: "vod", key: "favorites.filter.vod" },
      { id: "series", key: "favorites.filter.series" },
    ] as chip (chip.id)}
      <button
        type="button"
        role="tab"
        aria-selected={filter === chip.id}
        onclick={() => setFilter(chip.id)}
        class:active={filter === chip.id}
        class="filter-chip rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm
               hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent
               transition-colors">
        {tr(chip.key)}
        <span class="ml-1.5 text-fg-3 tabular-nums">{counts[chip.id]}</span>
      </button>
    {/each}
  </div>

  {#if loading && !entries.length}
    <div class="text-sm text-fg-3 px-1">{tr("common.loading")}</div>
  {:else if !entries.length}
    <div class="rounded-2xl border border-line bg-surface px-5 py-8 text-sm text-fg-2">
      {tr("watchlist.helperEmpty")}
    </div>
  {:else if !visible.length}
    <div class="rounded-2xl border border-line bg-surface px-5 py-8 text-sm text-fg-2">
      {tr("watchlist.helperEmpty")}
    </div>
  {:else}
    <div class="px-1 text-xs text-fg-3 tabular-nums">
      {tr("strip.itemCount", { count: visible.length })}
    </div>
  {/if}
</div>

{#if visible.length}
  <section
    class="flex-1 min-h-0 overflow-auto custom-scroll
           grid gap-3 sm:gap-4
           grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]
           sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]
           lg:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]
           auto-rows-min content-start
           p-2 pb-4">
    {#each visible as entry, i (entry.playlistId + ":" + entry.kind + ":" + entry.id)}
      <a
        href={entry.href}
        onclick={(event) => openCard(event, entry)}
        aria-label={tr("watchlist.cardAriaLabel", { name: entry.name, playlist: entry.playlistTitle })}
        class="fav-card group relative rounded-xl overflow-hidden bg-surface-2
               ring-1 ring-line
               transition-[transform,box-shadow] duration-150
               hover:ring-2 hover:ring-accent hover:[transform:translateY(-2px)]
               focus-visible:ring-2 focus-visible:ring-accent focus-visible:[transform:translateY(-2px)]">
        <div class="aspect-2/3 w-full bg-surface-2 overflow-hidden relative">
          {#if entry.logo}
            <img
              src={entry.logo}
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
          {:else}
            <div class="h-full w-full flex flex-col items-center justify-center gap-2 px-3
                        text-fg-3 bg-linear-to-br from-surface-2 to-surface-3">
              <span class="size-7 opacity-60 inline-flex items-center justify-center" aria-hidden="true">{@html KIND_ICON_SVG[entry.kind]}</span>
              <span class="text-2xs text-center truncate max-w-full">{entry.name}</span>
            </div>
          {/if}

          <span
            class="absolute top-1.5 left-1.5 text-label font-medium uppercase tracking-wide
                   rounded-md px-1.5 py-0.5 bg-black/55 text-white/85 backdrop-blur-sm ring-1 ring-white/10">
            {kl(entry.kind)}
          </span>
        </div>

        <div class="px-2 py-2 min-w-0">
          <div class="truncate text-sm font-medium text-fg">
            {entry.name}
          </div>
          <div class="truncate text-2xs text-fg-3 flex items-center gap-1">
            {#if entry.isCrossPlaylist}
              <IconExternalLink aria-hidden="true" class="h-3 w-3 shrink-0 text-accent" />
            {/if}
            <span class="truncate">{entry.playlistTitle}</span>
          </div>
        </div>
      </a>
    {/each}
  </section>
{/if}

<style>
  .filter-chip.active {
    background: var(--color-surface-2);
    border-color: var(--color-accent);
    color: var(--color-fg);
  }
</style>
