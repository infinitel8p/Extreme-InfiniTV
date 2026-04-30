<script>
  // Hub-only "Continue watching" strip.
  import { onMount } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getContinueWatching,
    clearProgress,
  } from "@/scripts/lib/preferences.js"
  import { getCached } from "@/scripts/lib/cache.js"

  /** @type {Array<{
   *   kind: "vod" | "episode",
   *   id: string,
   *   name: string,
   *   logo: string | null,
   *   subtitle: string,
   *   href: string,
   *   position: number,
   *   duration: number,
   *   percent: number,
   * }>}
   */
  let entries = $state([])
  let activePlaylistId = $state("")

  function buildEntry(raw, vodById) {
    const percent =
      raw.duration > 0
        ? Math.max(0, Math.min(100, (raw.position / raw.duration) * 100))
        : 0
    if (raw.kind === "vod") {
      const m = vodById.get(Number(raw.id))
      return {
        kind: raw.kind,
        id: raw.id,
        name: m?.name || `Movie ${raw.id}`,
        logo: m?.logo || null,
        subtitle: "Movie",
        href: `/movies/detail?id=${encodeURIComponent(raw.id)}&autoplay=1`,
        position: raw.position,
        duration: raw.duration,
        percent,
      }
    }
    const sLabel = raw.season != null ? `S${raw.season}` : ""
    const eLabel = raw.episodeNum != null ? `E${raw.episodeNum}` : ""
    const tag = (sLabel + eLabel) || "Episode"
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
      position: raw.position,
      duration: raw.duration,
      percent,
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

    const vodList = getCached(active._id, "vod")?.data || []
    const vodById = new Map(vodList.map((m) => [Number(m.id), m]))

    const raw = getContinueWatching(active._id, 6)
    entries = raw.map((r) => buildEntry(r, vodById))
  }

  function dismiss(e, entry) {
    e.preventDefault()
    e.stopPropagation()
    if (!activePlaylistId) return
    clearProgress(activePlaylistId, entry.kind, entry.id)
  }

  onMount(() => {
    reload()
    const handlers = {
      "xt:active-changed": reload,
      "xt:progress-changed": reload,
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
    aria-label="Continue watching"
    class="cw-section flex flex-col gap-3 shrink-0">
    <div class="flex items-baseline justify-between gap-2 px-1">
      <h2 class="text-eyebrow font-semibold uppercase tracking-wide text-fg-3">
        Continue watching
      </h2>
      <span class="text-2xs text-fg-3 tabular-nums">
        {entries.length} {entries.length === 1 ? "item" : "items"}
      </span>
    </div>

    <ul
      class="cw-strip flex gap-3 sm:gap-4 overflow-x-auto custom-scroll
             snap-x snap-mandatory py-2 -my-1 -mx-1 px-1">
      {#each entries as e (e.kind + ":" + e.id)}
        <li class="cw-item shrink-0 snap-start">
          <a
            href={e.href}
            aria-label={`Resume ${e.name}`}
            class="cw-card group relative block rounded-xl overflow-hidden
                   bg-surface-2 ring-1 ring-line
                   transition-[transform,box-shadow] duration-150
                   hover:ring-2 hover:ring-accent
                   focus-visible:ring-2 focus-visible:ring-accent
                   hover:transform-[translateY(-2px)]
                   focus-visible:transform-[translateY(-2px)]">
            <div class="cw-poster aspect-2/3 w-full overflow-hidden bg-surface-2 relative">
              {#if e.logo}
                <img
                  src={e.logo}
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
                  {e.name}
                </div>
              {/if}

              <div
                class="cw-progress absolute inset-x-0 bottom-0 h-1
                       bg-black/55 backdrop-blur-[2px]"
                aria-hidden="true">
                <div
                  class="cw-progress-fill h-full bg-accent"
                  style:width={e.percent + "%"}></div>
              </div>

              <button
                type="button"
                onclick={(ev) => dismiss(ev, e)}
                aria-label={`Remove ${e.name} from Continue watching`}
                title="Remove from Continue watching"
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
                {e.name}
              </div>
              <div class="truncate text-2xs text-fg-3 tabular-nums">
                {e.subtitle}
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

  /* Disabled in first-run mode (no playlists yet). The hub already hides
     #welcome and #hub-tiles around this state; the strip follows. */
  :global(html[data-first-run="true"]) .cw-section {
    display: none;
  }

  .cw-progress-fill {
    transition: width 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .cw-progress-fill {
      transition: none;
    }
  }
</style>
