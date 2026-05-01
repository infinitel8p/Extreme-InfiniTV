<script>
  import { onMount } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getHiddenCategories,
    setCategoryHidden,
  } from "@/scripts/lib/preferences.js"
  import { kindLabelPlural, KIND_ORDER } from "@/scripts/lib/kinds.js"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"

  /** @type {string} */
  let activePlaylistId = $state("")
  /** @type {{ live: string[], vod: string[], series: string[] }} */
  let lists = $state({ live: [], vod: [], series: [] })
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {klp(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const klp = (kind) => (locale, kindLabelPlural(kind))

  async function reload() {
    const active = await getActiveEntry()
    activePlaylistId = active?._id || ""
    if (!activePlaylistId) {
      lists = { live: [], vod: [], series: [] }
      return
    }
    await ensurePrefsLoaded()
    lists = {
      live: [...getHiddenCategories(activePlaylistId, "live")].sort(
        sortStrings
      ),
      vod: [...getHiddenCategories(activePlaylistId, "vod")].sort(sortStrings),
      series: [...getHiddenCategories(activePlaylistId, "series")].sort(
        sortStrings
      ),
    }
  }

  function sortStrings(a, b) {
    return a.localeCompare(b, "en", { sensitivity: "base" })
  }

  function unhide(kind, name) {
    if (!activePlaylistId) return
    setCategoryHidden(activePlaylistId, kind, name, false)
  }

  onMount(() => {
    reload()
    const onLocale = () => { locale++ }
    const handlers = {
      "xt:active-changed": reload,
      "xt:hidden-categories-changed": reload,
      [LOCALE_EVENT]: onLocale,
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

  let total = $derived(lists.live.length + lists.vod.length + lists.series.length)
</script>

<div class="rounded-xl border border-line bg-surface p-4 flex flex-col gap-3">
  <div class="flex items-baseline justify-between gap-2">
    <h2 class="text-sm font-semibold text-fg">{tr("settings.hiddenCategories.title")}</h2>
    <span class="text-2xs text-fg-3 tabular-nums">
      {total === 0
        ? tr("settings.hiddenCategories.empty")
        : tr("settings.hiddenCategories.count", { n: total })}
    </span>
  </div>
  <p class="text-xs text-fg-3">
    {tr("settings.hiddenCategories.helperLong")}
  </p>

  {#if total === 0}
    <div class="text-xs text-fg-3 italic">
      {tr("settings.hiddenCategories.emptyState")}
    </div>
  {:else}
    <div class="flex flex-col gap-3 max-h-[50vh] overflow-y-auto custom-scroll pr-1 -mr-1">
    {#each KIND_ORDER as kind}
      {#if lists[kind].length}
        <div class="flex flex-col gap-1.5">
          <div class="sticky top-0 z-10 -mx-4 px-4 py-1.5 bg-surface/95 backdrop-blur-sm border-b border-line/60 text-eyebrow font-semibold uppercase tracking-wide text-fg-3">
            {klp(kind)}
          </div>
          <ul class="flex flex-wrap gap-1.5">
            {#each lists[kind] as name (name)}
              <li>
                <button
                  type="button"
                  onclick={() => unhide(kind, name)}
                  class="hidden-chip inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:border-accent text-fg px-2.5 py-1 text-xs transition-colors outline-none"
                  aria-label={tr("settings.hiddenCategories.unhideAria", { name })}
                  title={tr("settings.hiddenCategories.clickToUnhide")}>
                  <span class="truncate max-w-[16rem]">{name}</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="0.875em"
                    height="0.875em"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true">
                    <path d="M2 12s3-7 10-7 10 7 10 7"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/each}
    </div>
  {/if}
</div>

<style>
  /* Touch / TV-remote adaptation: chip taps need to be ~44px tall. */
  @media (pointer: coarse) {
    .hidden-chip {
      padding-top: 0.625rem;
      padding-bottom: 0.625rem;
      min-height: 2.5rem;
    }
  }
</style>
