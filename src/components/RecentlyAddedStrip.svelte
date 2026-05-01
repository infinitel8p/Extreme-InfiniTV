<script>
  // Hub "Recently added" strip - mixes VOD + series sorted by `added` ts.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { fmtImdbRating } from "@/scripts/lib/format.js"

  const STRIP_LIMIT = 12

  /** @type {Array<{
   *   kind: "vod" | "series",
   *   id: number,
   *   name: string,
   *   logo: string | null,
   *   subtitle: string,
   *   href: string,
   *   rating: string,
   * }>} */
  let entries = $state([])
  let activePlaylistId = $state("")
  let locale = $state(0)
  // Wrapper reads the locale rune so {tr(...)} template effects track it
  // and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))

  function buildEntry(item, kind) {
    const subtitle = kind === "vod" ? "Movie" : "Series"
    const href =
      kind === "vod"
        ? `/movies/detail?id=${encodeURIComponent(item.id)}`
        : `/series/detail?id=${encodeURIComponent(item.id)}`
    return {
      kind,
      id: Number(item.id),
      name: item.name || `${subtitle} ${item.id}`,
      logo: item.logo || null,
      subtitle,
      href,
      rating: fmtImdbRating(item.rating),
    }
  }

  async function reload() {
    const active = await getActiveEntry()
    if (!active) {
      entries = []
      activePlaylistId = ""
      return
    }
    activePlaylistId = active._id
    await Promise.all([
      hydrateCache(active._id, "vod"),
      hydrateCache(active._id, "series"),
    ])
    const vod = (getCached(active._id, "vod")?.data || []).filter(
      (item) => item && item.id && (item.added || 0) > 0
    )
    const series = (getCached(active._id, "series")?.data || []).filter(
      (item) => item && item.id && (item.added || 0) > 0
    )
    const merged = [
      ...vod.map((item) => ({ ts: Number(item.added) || 0, kind: "vod", item })),
      ...series.map((item) => ({ ts: Number(item.added) || 0, kind: "series", item })),
    ]
    merged.sort((firstRow, secondRow) => secondRow.ts - firstRow.ts)
    entries = merged
      .slice(0, STRIP_LIMIT)
      .map((row) => buildEntry(row.item, row.kind))
  }

  onMount(() => {
    reload()
    const onLocaleChange = () => { locale++ }
    const handlers = {
      "xt:active-changed": reload,
      "xt:catalog-warmed": reload,
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
    aria-label={tr("nav.recentlyAdded")}
    class="ra-section flex flex-col gap-3 shrink-0">
    <div class="hub-section-head px-1">
      <div class="hub-section-head__title">
        <h2 class="hub-section-head__heading">{tr("nav.recentlyAdded")}</h2>
      </div>
      <a
        href="/recently-added"
        class="hub-section-head__count text-fg-3 hover:text-accent focus-visible:text-accent transition-colors">
        {tr("strip.viewAll")}
        <svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ml-0.5 inline-block align-[-1px]">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </a>
    </div>

    <ul
      class="ra-strip flex gap-3 sm:gap-4 overflow-x-auto custom-scroll
             snap-x snap-mandatory py-3 -my-2 -mx-2 px-2">
      {#each entries as entry, i (entry.kind + ":" + entry.id)}
        <li
          class="ra-item shrink-0 snap-start"
          data-kind={entry.kind}
          style:--enter-delay={Math.min(i, 8) * 28 + "ms"}>
          <a
            href={entry.href}
            aria-label={`Open ${entry.name}`}
            class="ra-card group relative block rounded-xl overflow-hidden
                   bg-surface-2 ring-1 ring-line
                   transition-[transform,box-shadow] duration-150
                   hover:ring-[3px] hover:ring-accent
                   focus-visible:ring-[3px] focus-visible:ring-accent
                   hover:transform-[translateY(-2px)]
                   focus-visible:transform-[translateY(-2px)]">
            <div class="ra-poster aspect-2/3 w-full overflow-hidden bg-surface-2 relative">
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
                  class="h-full w-full flex items-center justify-center text-center px-3
                         text-fg-3 text-xs tracking-wide
                         bg-linear-to-br from-surface-2 to-surface-3">
                  {entry.name}
                </div>
              {/if}

              <span
                class="absolute top-1.5 left-1.5 text-label font-medium uppercase tracking-wide
                       rounded-md px-1.5 py-0.5 bg-black/55 text-white/85 backdrop-blur-sm ring-1 ring-white/10">
                {entry.subtitle}
              </span>

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
  .ra-item {
    width: 8rem;
    animation: ra-enter 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--enter-delay, 0ms);
  }
  @media (min-width: 40em) {
    .ra-item { width: 9.5rem; }
  }
  @media (min-width: 64em) {
    .ra-item { width: 11rem; }
  }

  @keyframes ra-enter {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  :global(html[data-first-run="true"]) .ra-section { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .ra-item { animation: none; }
  }
</style>
