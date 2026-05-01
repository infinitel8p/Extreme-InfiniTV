<script>
  // Full-page Recently Added view: VOD + series sorted by `added` ts.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import {
    warmupActive,
    CATALOG_WARMED_EVENT,
  } from "@/scripts/lib/catalog.js"
  import { fmtImdbRating } from "@/scripts/lib/format.js"
  import { kindLabel } from "@/scripts/lib/kinds.js"

  const PAGE_SIZE = 200

  /** @type {"all"|"vod"|"series"} */
  let filter = $state("all")
  let locale = $state(0)
  /** @type {Array<{ts:number, kind:"vod"|"series", item:any}>} */
  let merged = $state([])
  let loading = $state(true)
  let activePlaylistId = $state("")
  let renderLimit = $state(PAGE_SIZE)

  const visible = $derived(
    (filter === "all"
      ? merged
      : merged.filter((row) => row.kind === filter)
    ).slice(0, renderLimit)
  )

  const counts = $derived({
    all: merged.length,
    vod: merged.filter((row) => row.kind === "vod").length,
    series: merged.filter((row) => row.kind === "series").length,
  })

  function fmtAdded(ts) {
    if (!ts) return ""
    const ms = Date.now() - ts * 1000
    if (ms < 0) return "Soon"
    const day = 86_400_000
    if (ms < day) return "Today"
    if (ms < 2 * day) return "Yesterday"
    if (ms < 7 * day) return `${Math.floor(ms / day)}d ago`
    if (ms < 30 * day) return `${Math.floor(ms / (7 * day))}w ago`
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  }

  function buildHref(kind, id) {
    return kind === "vod"
      ? `/movies/detail?id=${encodeURIComponent(id)}`
      : `/series/detail?id=${encodeURIComponent(id)}`
  }

  async function reload() {
    const active = await getActiveEntry()
    if (!active) {
      merged = []
      activePlaylistId = ""
      loading = false
      return
    }
    activePlaylistId = active._id
    await Promise.all([
      hydrateCache(active._id, "vod"),
      hydrateCache(active._id, "series"),
    ])
    const vod = (getCached(active._id, "vod")?.data || [])
      .filter((item) => item && item.id && (item.added || 0) > 0)
      .map((item) => ({ ts: Number(item.added) || 0, kind: "vod", item }))
    const series = (getCached(active._id, "series")?.data || [])
      .filter((item) => item && item.id && (item.added || 0) > 0)
      .map((item) => ({ ts: Number(item.added) || 0, kind: "series", item }))
    merged = [...vod, ...series].sort(
      (firstRow, secondRow) => secondRow.ts - firstRow.ts
    )
    loading = false
    if (!merged.length) {
      // Cache may be cold - kick a warmup so the catalog populates.
      warmupActive().catch(() => {})
    }
  }

  function setFilter(next) {
    filter = next
    renderLimit = PAGE_SIZE
  }

  function loadMore() {
    renderLimit += PAGE_SIZE
  }

  onMount(() => {
    reload()
    const onLocale = () => { locale++ }
    const handlers = {
      "xt:active-changed": reload,
      [CATALOG_WARMED_EVENT]: reload,
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

<!-- {#key locale} wraps everything that depends on the locale rune so the
     cards section's badge / empty-state caption re-renders too (the previous
     `data-locale={locale}` only covered the chip row). -->
{#key locale}
<div class="flex flex-col gap-3 shrink-0">
  <div class="flex flex-wrap gap-2" role="tablist" aria-label={t("recentlyAdded.heading")}>
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
        {t(chip.key)}
        <span class="ml-1.5 text-fg-3 tabular-nums">{counts[chip.id]}</span>
      </button>
    {/each}
  </div>

  {#if loading && !merged.length}
    <div class="text-sm text-fg-3 px-1">{t("common.loading")}</div>
  {:else if !merged.length}
    <div class="rounded-2xl border border-line bg-surface px-5 py-8 text-sm text-fg-2">
      {t("recentlyAdded.empty")}
    </div>
  {:else}
    <div class="px-1 text-xs text-fg-3 tabular-nums">
      Showing <strong class="text-fg-2">{visible.length}</strong> of
      <strong class="text-fg-2">{counts[filter]}</strong>
    </div>
  {/if}
</div>

{#if merged.length}
  <section
    class="flex-1 min-h-0 overflow-auto custom-scroll
           grid gap-3 sm:gap-4
           grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]
           sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]
           lg:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]
           auto-rows-min content-start
           p-2 pb-4">
    {#each visible as row, i (row.kind + ":" + row.item.id)}
      {@const ratingText = fmtImdbRating(row.item.rating)}
      <a
        href={buildHref(row.kind, row.item.id)}
        aria-label={`Open ${row.item.name || row.kind}`}
        class="ra-card group relative rounded-xl overflow-hidden bg-surface-2
               ring-1 ring-line
               transition-[transform,box-shadow] duration-150
               hover:ring-2 hover:ring-accent hover:[transform:translateY(-2px)]
               focus-visible:ring-2 focus-visible:ring-accent focus-visible:[transform:translateY(-2px)]">
        <div class="aspect-2/3 w-full bg-surface-2 overflow-hidden relative">
          {#if row.item.logo}
            <img
              src={row.item.logo}
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
          {:else}
            <div class="h-full w-full flex items-center justify-center text-center px-3
                        text-fg-3 text-xs tracking-wide
                        bg-linear-to-br from-surface-2 to-surface-3">
              {row.item.name || kindLabel(row.kind)}
            </div>
          {/if}

          <span
            class="absolute top-1.5 left-1.5 text-label font-medium uppercase tracking-wide
                   rounded-md px-1.5 py-0.5 bg-black/55 text-white/85 backdrop-blur-sm ring-1 ring-white/10">
            {kindLabel(row.kind)}
          </span>

          {#if ratingText}
            <span
              class="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1
                     rounded-md px-1.5 py-0.5 bg-black/55 backdrop-blur-sm
                     ring-1 ring-white/10 text-white/90 text-2xs font-semibold tabular-nums"
              aria-label={`Rating ${ratingText} out of 10`}>
              <svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" class="text-accent">
                <path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z" />
              </svg>
              <span>{ratingText}</span>
            </span>
          {/if}
        </div>

        <div class="px-2 py-2 min-w-0">
          <div class="truncate text-sm font-medium text-fg">
            {row.item.name || kindLabel(row.kind)}
          </div>
          <div class="truncate text-2xs text-fg-3 tabular-nums">
            Added {fmtAdded(row.ts)}
          </div>
        </div>
      </a>
    {/each}

    {#if visible.length < (filter === "all" ? merged.length : counts[filter])}
      <div class="col-span-full flex justify-center py-3">
        <button
          type="button"
          onclick={loadMore}
          class="rounded-xl border border-line bg-surface px-4 py-2 text-sm
                 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent
                 transition-colors">
          Load more
        </button>
      </div>
    {/if}
  </section>
{/if}
{/key}

<style>
  .filter-chip.active {
    background: var(--color-surface-2);
    border-color: var(--color-accent);
    color: var(--color-fg);
  }
  .aspect-2-3 { aspect-ratio: 2 / 3; }
</style>
