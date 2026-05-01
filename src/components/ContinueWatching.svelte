<script>
  // Hub-only "Continue watching" strip.
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getContinueWatching,
    getRecents,
    clearProgress,
    clearRecent,
  } from "@/scripts/lib/preferences.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"

  const STRIP_LIMIT = 8
  const LIVE_TTL_MS = 48 * 60 * 60 * 1000

  /** @type {Array<{
   *   kind: "vod" | "episode" | "live",
   *   id: string,
   *   name: string,
   *   logo: string | null,
   *   subtitle: string,
   *   href: string,
   *   percent: number,
   *   hasProgress: boolean,
   * }>}
   */
  let entries = $state([])
  let activePlaylistId = $state("")
  let locale = $state(0)

  function buildProgressEntry(raw, vodById) {
    const percent =
      raw.duration > 0
        ? Math.max(0, Math.min(100, (raw.position / raw.duration) * 100))
        : 0
    if (raw.kind === "vod") {
      const movie = vodById.get(Number(raw.id))
      return {
        kind: raw.kind,
        id: raw.id,
        name: raw.name || movie?.name || `Movie ${raw.id}`,
        logo: raw.logo || movie?.logo || null,
        subtitle: "Movie",
        href: `/movies/detail?id=${encodeURIComponent(raw.id)}&autoplay=1`,
        percent,
        hasProgress: true,
      }
    }
    const seasonLabel = raw.season != null ? `S${raw.season}` : ""
    const episodeLabel = raw.episodeNum != null ? `E${raw.episodeNum}` : ""
    const tag = seasonLabel + episodeLabel || "Episode"
    const seriesPart = raw.seriesName ? `${raw.seriesName} · ${tag}` : tag
    const seriesIdParam = raw.seriesId != null ? encodeURIComponent(raw.seriesId) : ""
    return {
      kind: raw.kind,
      id: raw.id,
      name: raw.episodeTitle || raw.seriesName || `Episode ${raw.id}`,
      logo: raw.seriesLogo || null,
      subtitle: seriesPart,
      href: seriesIdParam
        ? `/series/detail?id=${seriesIdParam}&autoplay=1&episode=${encodeURIComponent(raw.id)}`
        : "#",
      percent,
      hasProgress: true,
    }
  }

  function buildLiveEntry(recent, liveById) {
    const channel = liveById.get(Number(recent.id))
    return {
      kind: "live",
      id: String(recent.id),
      name: recent.name || channel?.name || `Channel ${recent.id}`,
      logo: recent.logo || channel?.logo || null,
      subtitle: "Live TV",
      href: `/livetv?channel=${encodeURIComponent(recent.id)}`,
      percent: 0,
      hasProgress: false,
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
    await ensurePrefsLoaded()
    await Promise.all([
      hydrateCache(active._id, "vod"),
      hydrateCache(active._id, "live"),
      hydrateCache(active._id, "m3u"),
    ])

    const vodList = getCached(active._id, "vod")?.data || []
    const vodById = new Map(vodList.map((movie) => [Number(movie.id), movie]))
    const liveList =
      getCached(active._id, "live")?.data ||
      getCached(active._id, "m3u")?.data ||
      []
    const liveById = new Map(liveList.map((channel) => [Number(channel.id), channel]))

    const progress = getContinueWatching(active._id, STRIP_LIMIT).map((row) => ({
      ts: row.updatedAt || 0,
      built: buildProgressEntry(row, vodById),
    }))
    const liveCutoff = Date.now() - LIVE_TTL_MS
    const recents = getRecents(active._id, "live")
      .filter((row) => (row.ts || 0) >= liveCutoff)
      .map((row) => ({
        ts: row.ts || 0,
        built: buildLiveEntry(row, liveById),
      }))

    const merged = [...progress, ...recents].sort((a, b) => b.ts - a.ts)
    entries = merged.slice(0, STRIP_LIMIT).map((row) => row.built)
  }

  function dismiss(event, entry) {
    event.preventDefault()
    event.stopPropagation()
    if (!activePlaylistId) return
    if (entry.kind === "live") {
      clearRecent(activePlaylistId, "live", Number(entry.id))
    } else {
      clearProgress(activePlaylistId, entry.kind, entry.id)
    }
  }

  onMount(() => {
    reload()
    const onLocaleChange = () => { locale++ }
    const handlers = {
      "xt:active-changed": reload,
      "xt:progress-changed": reload,
      "xt:recents-changed": reload,
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
  {@const _locale = locale}
  <section
    aria-label={t("strip.continueWatching")}
    class="cw-section flex flex-col gap-3 shrink-0">
    <div class="hub-section-head px-1">
      <div class="hub-section-head__title">
        <h2 class="hub-section-head__heading">{t("strip.continueWatching")}</h2>
      </div>
      <span class="hub-section-head__count">
        {t("strip.itemCount", { count: entries.length })}
      </span>
    </div>

    <ul
      class="cw-strip flex gap-3 sm:gap-4 overflow-x-auto custom-scroll
             snap-x snap-mandatory py-3 -my-2 -mx-2 px-2">
      {#each entries as entry, i (entry.kind + ":" + entry.id)}
        <li
          class="cw-item shrink-0 snap-start"
          data-kind={entry.kind}
          style:--enter-delay={Math.min(i, 6) * 28 + "ms"}>
          <a
            href={entry.href}
            aria-label={entry.kind === "live"
              ? `Watch ${entry.name}`
              : `Resume ${entry.name}`}
            class="cw-card group relative block rounded-xl overflow-hidden
                   bg-surface-2 ring-1 ring-line
                   transition-[transform,box-shadow] duration-150
                   hover:ring-[3px] hover:ring-accent
                   focus-visible:ring-[3px] focus-visible:ring-accent
                   hover:transform-[translateY(-2px)]
                   focus-visible:transform-[translateY(-2px)]">
            <div class="cw-poster aspect-2/3 w-full overflow-hidden bg-surface-2 relative">
              {#if entry.logo}
                {#if entry.kind === "live"}
                  <img
                    src={entry.logo}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    class="absolute inset-0 h-full w-full object-cover scale-110 saturate-150 brightness-75 opacity-60 blur-2xl pointer-events-none" />
                  <div class="absolute inset-0 flex items-center justify-center p-3">
                    <img
                      src={entry.logo}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      class="relative max-h-full max-w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]" />
                  </div>
                {:else}
                  <img
                    src={entry.logo}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                {/if}
              {:else}
                <div
                  class="h-full w-full flex items-center justify-center text-center px-3
                         text-fg-3 text-xs tracking-wide
                         bg-linear-to-br from-surface-2 to-surface-3">
                  {entry.name}
                </div>
              {/if}

              {#if entry.kind === "live"}
                <span
                  class="absolute top-1.5 left-1.5 inline-flex items-center gap-1 text-label font-medium uppercase tracking-wide
                         rounded-md px-1.5 py-0.5 bg-black/55 text-white/85 backdrop-blur-sm ring-1 ring-white/10">
                  <span class="size-1.5 rounded-full bg-accent" aria-hidden="true"></span>
                  Live
                </span>
              {/if}

              {#if entry.hasProgress}
                <div
                  class="cw-progress absolute inset-x-0 bottom-0 h-1
                         bg-black/55 backdrop-blur-[2px]"
                  aria-hidden="true">
                  <div
                    class="cw-progress-fill h-full bg-accent"
                    style:width={entry.percent + "%"}></div>
                </div>
              {/if}

              <button
                type="button"
                onclick={(event) => dismiss(event, entry)}
                aria-label={entry.kind === "live"
                  ? `Remove ${entry.name} from recents`
                  : `Remove ${entry.name} from Continue watching`}
                title={entry.kind === "live"
                  ? "Remove from recents"
                  : "Remove from Continue watching"}
                class="cw-dismiss absolute top-1.5 right-1.5 size-7 rounded-md
                       bg-black/55 text-white/85 backdrop-blur-sm ring-1 ring-white/10
                       opacity-0 group-hover:opacity-100 group-focus-within:opacity-100
                       focus-visible:opacity-100
                       hover:text-white hover:bg-black/75
                       focus-visible:ring-2 focus-visible:ring-accent
                       transition-opacity flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-3.5">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <div class="px-2 py-2 min-w-0">
              <div class="truncate text-sm font-medium text-fg">
                {entry.name}
              </div>
              <div class="truncate text-2xs text-fg-3 tabular-nums">
                {entry.subtitle}
              </div>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .cw-item {
    width: 8rem;
    animation: cw-enter 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--enter-delay, 0ms);
  }
  @media (min-width: 40em) {
    .cw-item {
      width: 9.5rem;
    }
  }
  @media (min-width: 64em) {
    .cw-item {
      width: 11rem;
    }
  }

  @keyframes cw-enter {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* Disabled in first-run mode */
  :global(html[data-first-run="true"]) .cw-section {
    display: none;
  }

  .cw-progress-fill {
    transition: width 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* Touch adaptation */
  @media (pointer: coarse) {
    .cw-dismiss {
      width: 2.25rem;
      height: 2.25rem;
      opacity: 0.7;
    }
    .cw-dismiss :global(svg) {
      width: 1rem;
      height: 1rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cw-progress-fill {
      transition: none;
    }
    .cw-item {
      animation: none;
    }
  }
</style>
