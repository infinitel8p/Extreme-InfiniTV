<script>
  // Hub-strips editor: ordered list of the user's home-page sections with
  // up/down + remove, and an "Add a section" picker for catalog entries
  // not yet in the active list. Mirrors the FavoritesReorder pattern
  // (drag handle for mouse, arrow buttons for keyboard / D-pad / touch).
  import { onMount } from "svelte"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import {
    HUB_STRIP_CATALOG,
    HUB_STRIPS_EVENT,
    getHubStripIds,
    setHubStripIds,
    moveHubStrip,
    addHubStrip,
    removeHubStrip,
    resetHubStrips,
  } from "@/scripts/lib/app-settings.js"

  let activeIds = $state(getHubStripIds())
  let locale = $state(0)
  const tr = (key, params) => (locale, t(key, params))

  /** @type {{ kind: string, fromIdx: number } | null} */
  let dragState = $state(null)
  /** @type {{ kind: string, idx: number } | null} */
  let dragOver = $state(null)
  /** @type {{ id: string } | null} */
  let justMoved = $state(null)
  let _settleTimer = null
  function flagSettle(id) {
    if (_settleTimer) clearTimeout(_settleTimer)
    justMoved = { id }
    _settleTimer = setTimeout(() => {
      justMoved = null
      _settleTimer = null
    }, 320)
  }

  const catalogById = new Map(HUB_STRIP_CATALOG.map((entry) => [entry.id, entry]))

  /** Localized label for a catalog entry. */
  function labelFor(entryId) {
    const entry = catalogById.get(entryId)
    if (!entry) return entryId
    void locale
    if (entry.type === "continue-watching") return t("hub.strip.continueWatching")
    if (entry.type === "because-watched") return t("hub.strip.becauseYouWatched.label")
    const subKey = entry.kind === "all" ? "all" : entry.kind
    const namespace =
      entry.type === "favorites"
        ? "favorites"
        : entry.type === "watchlist"
        ? "watchlist"
        : "recentlyAdded"
    return t(`hub.strip.${namespace}.${subKey}`)
  }

  const activeRows = $derived(
    activeIds
      .map((id) => {
        const entry = catalogById.get(id)
        return entry ? { ...entry } : null
      })
      .filter(/** @type {(row: any) => row is { id: string, type: string, kind: string }} */ (Boolean)),
  )

  const availableEntries = $derived(
    HUB_STRIP_CATALOG.filter((entry) => !activeIds.includes(entry.id)),
  )

  function move(id, delta) {
    const next = moveHubStrip(id, delta)
    if (next) {
      activeIds = next
      flagSettle(id)
    }
  }

  function remove(id) {
    activeIds = removeHubStrip(id)
  }

  function add(id) {
    const next = addHubStrip(id)
    if (next) activeIds = next
  }

  function reset() {
    resetHubStrips()
    activeIds = getHubStripIds()
  }

  function onDragStart(idx, event) {
    dragState = { kind: "hub", fromIdx: idx }
    dragOver = null
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move"
      try { event.dataTransfer.setData("text/plain", String(idx)) } catch {}
    }
  }
  function onDragOver(idx, event) {
    if (!dragState) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    if (dragOver?.idx !== idx) dragOver = { kind: "hub", idx }
  }
  function onDragLeave(idx) {
    if (dragOver?.idx === idx) dragOver = null
  }
  function onDragEnd() {
    dragState = null
    dragOver = null
  }
  function onDrop(idx, event) {
    event.preventDefault()
    if (!dragState) return
    const from = dragState.fromIdx
    const to = idx
    dragState = null
    dragOver = null
    if (from === to) return
    const next = activeIds.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setHubStripIds(next)
    activeIds = next
    flagSettle(moved)
  }

  onMount(() => {
    const onLocaleChange = () => { locale++ }
    const onHubChange = () => { activeIds = getHubStripIds() }
    document.addEventListener(LOCALE_EVENT, onLocaleChange)
    document.addEventListener(HUB_STRIPS_EVENT, onHubChange)
    return () => {
      document.removeEventListener(LOCALE_EVENT, onLocaleChange)
      document.removeEventListener(HUB_STRIPS_EVENT, onHubChange)
    }
  })
</script>

<div class="flex flex-col gap-4 overflow-x-clip">
  <div class="flex items-baseline justify-between gap-2 flex-wrap">
    <h3 class="text-sm font-semibold text-fg">{tr("settings.hubStrips.activeTitle")}</h3>
    <button
      type="button"
      class="inline-flex items-center min-h-9 px-2 rounded-lg text-xs text-fg-3 hover:text-fg focus-visible:text-fg underline-offset-2 hover:underline outline-none pointer-coarse:min-h-11"
      onclick={reset}>
      {tr("settings.hubStrips.reset")}
    </button>
  </div>

  {#if activeRows.length === 0}
    <div class="text-xs text-fg-3 italic">{tr("settings.hubStrips.emptyActive")}</div>
  {:else}
    <ul class="flex flex-col gap-1">
      {#each activeRows as row, idx (row.id)}
        <li
          draggable="true"
          ondragstart={(event) => onDragStart(idx, event)}
          ondragover={(event) => onDragOver(idx, event)}
          ondragleave={() => onDragLeave(idx)}
          ondragend={onDragEnd}
          ondrop={(event) => onDrop(idx, event)}
          class="reorder-row group flex items-center gap-2 rounded-lg border bg-surface-2 px-2 py-1.5 transition-[opacity,border-color] duration-150"
          class:is-dragging={dragState?.fromIdx === idx}
          class:is-drop-target={dragOver?.idx === idx && dragState?.fromIdx !== idx}
          class:is-settling={justMoved?.id === row.id}
          class:border-line={!(dragOver?.idx === idx && dragState?.fromIdx !== idx)}
          class:hover:border-line-soft={!dragState}>
          <span aria-hidden="true" class="reorder-handle text-fg-3 cursor-grab active:cursor-grabbing px-1 select-none" title={tr("settings.hubStrips.dragToReorder")}>
            <svg xmlns="http://www.w3.org/2000/svg" width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
          </span>
          <span class="flex-1 min-w-0 truncate text-sm text-fg">{labelFor(row.id)}</span>
          <span class="shrink-0 flex items-center gap-1">
            <button
              type="button"
              class="reorder-arrow size-9 pointer-coarse:size-11 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-3 focus-visible:bg-surface-3 outline-none disabled:opacity-30"
              aria-label={tr("settings.hubStrips.moveUpAria", { name: labelFor(row.id) })}
              title={tr("settings.hubStrips.moveUp")}
              disabled={idx === 0}
              onclick={() => move(row.id, -1)}>
              <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
            </button>
            <button
              type="button"
              class="reorder-arrow size-9 pointer-coarse:size-11 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-3 focus-visible:bg-surface-3 outline-none disabled:opacity-30"
              aria-label={tr("settings.hubStrips.moveDownAria", { name: labelFor(row.id) })}
              title={tr("settings.hubStrips.moveDown")}
              disabled={idx === activeRows.length - 1}
              onclick={() => move(row.id, 1)}>
              <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <button
              type="button"
              class="reorder-arrow size-9 pointer-coarse:size-11 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-bad hover:bg-bad-soft focus-visible:text-bad focus-visible:bg-bad-soft outline-none"
              aria-label={tr("settings.hubStrips.removeAria", { name: labelFor(row.id) })}
              title={tr("settings.hubStrips.remove")}
              onclick={() => remove(row.id)}>
              <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if availableEntries.length > 0}
    <div class="flex flex-col gap-2 border-t border-line/60 pt-3">
      <h4 class="text-eyebrow font-medium uppercase tracking-wide text-fg-3">{tr("settings.hubStrips.addTitle")}</h4>
      <ul class="flex flex-wrap gap-1.5">
        {#each availableEntries as entry (entry.id)}
          <li>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 min-h-9 pointer-coarse:min-h-11 rounded-full border border-line bg-surface-2 px-3 text-xs text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors"
              onclick={() => add(entry.id)}>
              <svg xmlns="http://www.w3.org/2000/svg" width="0.85rem" height="0.85rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
              <span>{labelFor(entry.id)}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .reorder-row.is-dragging { opacity: 0.4; }
  .reorder-row.is-drop-target {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent) inset;
  }
  .reorder-row.is-settling {
    animation: reorder-settle 320ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes reorder-settle {
    0%   { transform: scale(1); }
    35%  { transform: scale(0.97); }
    100% { transform: scale(1); }
  }
  @media (pointer: coarse) {
    .reorder-handle { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .reorder-row { transition: none !important; animation: none !important; }
  }
</style>
