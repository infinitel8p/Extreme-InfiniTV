<script>
  import { onMount } from "svelte"
  import { getActiveEntry, entryToCreds, isLikelyM3USource } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getChannelOverrides,
    setChannelOverrides,
    clearChannelOverride,
    clearAllChannelOverrides,
    CHANNEL_OVERRIDES_CHANGED_EVENT,
  } from "@/scripts/lib/preferences.js"
  import { ensureLive } from "@/scripts/lib/catalog.js"
  import { planAffixStrip, resolveOverrideKey } from "@/scripts/lib/channel-overrides.ts"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { toastSuccess } from "@/scripts/lib/toast.ts"
  import { confirmDialog } from "@/scripts/lib/confirm-dialog.ts"
  import { log } from "@/scripts/lib/log.js"
  import { ICON_ALERT_TRIANGLE } from "@/scripts/lib/icons.js"

  let activePlaylistId = $state("")
  let isCustom = $state(false)
  let isM3U = $state(false)
  /** @type {Array<{ key: string, label: string, wasNamed: string, logo: string, chno: number|null, hidden: boolean, stale: boolean }>} */
  let rows = $state([])
  /** @type {HTMLElement|undefined} */
  let root = $state()
  /** Provider catalog, loaded on demand for the bulk tool and stale detection. */
  let channels = $state([])
  let channelsLoaded = $state(false)
  let loadingChannels = $state(false)
  let prefix = $state("")
  let suffix = $state("")
  // A bulk strip can create thousands of records; scanning the whole catalogue on
  // every keystroke would stall the main thread, so the plan runs off debounced copies.
  let plannedPrefix = $state("")
  let plannedSuffix = $state("")
  let loadError = $state(false)
  let applying = $state(false)
  let locale = $state(0)
  const tr = (key, params) => (locale, t(key, params))

  // Settings has no virtualized list; render a window and say what is not shown.
  const ROW_RENDER_CAP = 200
  const PREVIEW_CAP = 5

  function buildRows() {
    if (!activePlaylistId) {
      rows = []
      return
    }
    const overrides = getChannelOverrides(activePlaylistId)
    const liveKeys = channelsLoaded
      ? new Set(channels.map((channel) => resolveOverrideKey(channel, isM3U)).filter(Boolean))
      : null
    rows = Object.entries(overrides)
      .map(([key, record]) => ({
        key,
        label: record.name || record.srcName || key.replace(/^[a-z]:/, ""),
        // Only meaningful when the name itself was changed.
        wasNamed: record.name && record.srcName && record.name !== record.srcName ? record.srcName : "",
        logo: record.logo || "",
        chno: record.chno ?? null,
        hidden: record.hidden === true,
        stale: liveKeys ? !liveKeys.has(key) : false,
      }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }))
  }

  async function reload() {
    const active = await getActiveEntry()
    activePlaylistId = active?._id || ""
    isCustom = active?.type === "custom"
    if (activePlaylistId && !isCustom) {
      const creds = entryToCreds(active)
      isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
    }
    channelsLoaded = false
    channels = []
    await ensurePrefsLoaded()
    buildRows()
  }

  async function loadChannels() {
    if (channelsLoaded || loadingChannels || !activePlaylistId || isCustom) return
    loadingChannels = true
    loadError = false
    try {
      const active = await getActiveEntry()
      if (!active) throw new Error("no active playlist")
      // includeHidden: the bulk tool and stale check must see the whole catalog.
      const list = await ensureLive(entryToCreds(active), activePlaylistId, { includeHidden: true })
      channels = Array.isArray(list) ? list : []
      channelsLoaded = true
      buildRows()
    } catch (err) {
      log.warn("[xt:channel-overrides] channel load failed:", err)
      loadError = true
    } finally {
      loadingChannels = false
    }
  }

  function revert(key) {
    clearChannelOverride(activePlaylistId, key)
  }

  async function revertAll() {
    const ok = await confirmDialog({
      title: t("settings.channelOverrides.revertAllTitle"),
      message: t("settings.channelOverrides.revertAllBody", { n: rows.length }),
      confirmLabel: t("settings.channelOverrides.revertAllConfirm"),
      destructive: true,
    })
    if (!ok) return
    clearAllChannelOverrides(activePlaylistId)
  }

  let planTimer = null
  $effect(() => {
    const nextPrefix = prefix
    const nextSuffix = suffix
    if (planTimer) clearTimeout(planTimer)
    planTimer = setTimeout(() => {
      plannedPrefix = nextPrefix
      plannedSuffix = nextSuffix
    }, 250)
    return () => {
      if (planTimer) clearTimeout(planTimer)
    }
  })

  let plan = $derived(
    channelsLoaded && (plannedPrefix.trim() || plannedSuffix.trim())
      ? planAffixStrip(channels, plannedPrefix, plannedSuffix, isM3U)
      : []
  )
  let planPending = $derived(
    (prefix.trim() || suffix.trim()) && (prefix !== plannedPrefix || suffix !== plannedSuffix)
  )

  function applyStrip() {
    if (!plan.length || applying) return
    applying = true
    const patches = plan.map((entry) => ({
      key: entry.key,
      patch: {
        name: entry.to,
        srcName: entry.srcName,
        srcTvgId: entry.srcTvgId,
      },
    }))
    const changed = setChannelOverrides(activePlaylistId, patches)
    prefix = ""
    suffix = ""
    plannedPrefix = ""
    plannedSuffix = ""
    applying = false
    toastSuccess(t("settings.channelOverrides.stripApplied", { n: changed }))
  }

  onMount(() => {
    reload()
    // client:load mounts while the card is still collapsed, so defer the 20k-row
    // fetch until the user actually opens it.
    const card = root?.closest("details")
    const onToggle = () => { if (card?.open) void loadChannels() }
    card?.addEventListener("toggle", onToggle)
    if (card?.open) void loadChannels()
    const onLocale = () => { locale++ }
    const handlers = {
      "xt:active-changed": reload,
      [CHANNEL_OVERRIDES_CHANGED_EVENT]: buildRows,
      [LOCALE_EVENT]: onLocale,
    }
    for (const [eventName, handler] of Object.entries(handlers)) {
      document.addEventListener(eventName, handler)
    }
    return () => {
      card?.removeEventListener("toggle", onToggle)
      for (const [eventName, handler] of Object.entries(handlers)) {
        document.removeEventListener(eventName, handler)
      }
    }
  })

  const INPUT_CLASS =
    "min-h-11 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none " +
    "focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent"
</script>

<div class="flex flex-col gap-4 overflow-x-clip" bind:this={root}>
  {#if isCustom}
    <p class="text-xs text-fg-3 italic">{tr("settings.channelOverrides.customHint")}</p>
  {:else if !activePlaylistId}
    <p class="text-xs text-fg-3 italic">{tr("settings.channelOverrides.noPlaylist")}</p>
  {:else}
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <span class="text-2xs text-fg-3 tabular-nums">
        {rows.length === 0
          ? tr("settings.channelOverrides.empty")
          : tr("settings.channelOverrides.count", { n: rows.length })}
      </span>
      {#if rows.length}
        <button type="button" class="btn" onclick={revertAll}>
          {tr("settings.channelOverrides.revertAll")}
        </button>
      {/if}
    </div>

    {#if rows.length}
      <ul class="flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto overflow-x-hidden custom-scroll pe-1 -me-1">
        {#each rows.slice(0, ROW_RENDER_CAP) as row (row.key)}
          <li class="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2">
            <span class="inline-flex items-center justify-center size-8 rounded bg-bg border border-line/60 overflow-hidden shrink-0">
              {#if row.logo}
                <img src={row.logo} alt="" class="max-w-full max-h-full object-contain" loading="lazy" />
              {/if}
            </span>
            <span class="flex flex-col min-w-0 gap-0.5">
              <span class="text-sm text-fg truncate">{row.label}</span>
              {#if row.wasNamed}
                <span class="text-2xs text-fg-3 truncate">
                  {tr("settings.channelOverrides.wasNamed", { name: row.wasNamed })}
                </span>
              {/if}
              {#if row.chno != null || row.hidden || row.stale}
                <span class="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {#if row.chno != null}
                    <span class="inline-flex items-center rounded border border-line bg-bg px-1.5 text-2xs text-fg-2 tabular-nums">
                      {tr("settings.channelOverrides.tagNumber", { n: row.chno })}
                    </span>
                  {/if}
                  {#if row.hidden}
                    <span class="inline-flex items-center rounded border border-line bg-bg px-1.5 text-2xs text-fg-2">
                      {tr("settings.channelOverrides.tagHidden")}
                    </span>
                  {/if}
                  {#if row.stale}
                    <!-- Icon + label, not amber alone: state must never ride on hue. -->
                    <span
                      class="inline-flex items-center gap-1 rounded border border-warn/50 px-1.5 text-2xs text-warn"
                      title={tr("settings.channelOverrides.tagStale")}>
                      <span class="inline-flex size-3" aria-hidden="true">{@html ICON_ALERT_TRIANGLE}</span>
                      {tr("settings.channelOverrides.tagStaleShort")}
                    </span>
                  {/if}
                </span>
              {/if}
            </span>
            <button
              type="button"
              class="ms-auto shrink-0 inline-flex items-center justify-center min-h-9 pointer-coarse:min-h-11 rounded-lg border border-line bg-bg px-3 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg focus-visible:bg-surface-3 focus-visible:border-accent transition-colors outline-none"
              onclick={() => revert(row.key)}
              aria-label={tr("settings.channelOverrides.revertAria", { name: row.label })}>
              {tr("settings.channelOverrides.revert")}
            </button>
          </li>
        {/each}
      </ul>
      {#if rows.length > ROW_RENDER_CAP}
        <p class="text-2xs text-fg-3 tabular-nums">
          {tr("settings.channelOverrides.rowsCapped", { shown: ROW_RENDER_CAP, total: rows.length })}
        </p>
      {/if}
    {:else}
      <p class="text-xs text-fg-3 italic">{tr("settings.channelOverrides.emptyState")}</p>
    {/if}

    <div class="flex flex-col gap-2 pt-1 border-t border-line/60">
      <span class="text-sm font-medium text-fg-2 pt-3">{tr("settings.channelOverrides.stripTitle")}</span>
      <p class="text-xs text-fg-3 leading-relaxed">{tr("settings.channelOverrides.stripHelper")}</p>
      {#if !channelsLoaded}
        <!-- Channels load when the card opens; this branch is only the wait or a failure. -->
        <div class="flex flex-col gap-2 items-start">
          {#if loadError}
            <p class="text-xs text-bad">{tr("settings.channelOverrides.stripLoadFailed")}</p>
            <button type="button" class="btn self-start" onclick={loadChannels} disabled={loadingChannels}>
              {loadingChannels ? tr("settings.channelOverrides.stripLoading") : tr("common.retry")}
            </button>
          {:else}
            <p class="text-xs text-fg-3">{tr("settings.channelOverrides.stripLoading")}</p>
          {/if}
        </div>
      {:else}
        <div class="flex flex-wrap gap-2">
          <input
            type="text"
            bind:value={prefix}
            class={INPUT_CLASS + " flex-1 min-w-[8rem]"}
            placeholder={tr("settings.channelOverrides.stripPrefixPlaceholder")}
            aria-label={tr("settings.channelOverrides.stripPrefixLabel")}
            autocomplete="off"
            spellcheck="false" />
          <input
            type="text"
            bind:value={suffix}
            class={INPUT_CLASS + " flex-1 min-w-[8rem]"}
            placeholder={tr("settings.channelOverrides.stripSuffixPlaceholder")}
            aria-label={tr("settings.channelOverrides.stripSuffixLabel")}
            autocomplete="off"
            spellcheck="false" />
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <button type="button" class="btn" onclick={applyStrip} disabled={!plan.length || applying}>
            {tr("settings.channelOverrides.stripApply")}
          </button>
          <span class="text-2xs text-fg-3 tabular-nums" aria-live="polite">
            {planPending
              ? tr("settings.channelOverrides.stripCounting")
              : tr("settings.channelOverrides.stripPreview", { n: plan.length })}
          </span>
        </div>
        {#if plan.length}
          <ul class="flex flex-col gap-1 text-2xs text-fg-3">
            {#each plan.slice(0, PREVIEW_CAP) as entry (entry.key)}
              <li class="truncate"><span class="line-through">{entry.from}</span> → {entry.to}</li>
            {/each}
            {#if plan.length > PREVIEW_CAP}
              <li class="tabular-nums">{tr("settings.channelOverrides.previewMore", { n: plan.length - PREVIEW_CAP })}</li>
            {/if}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}
</div>
