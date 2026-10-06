<script>
  // Reorder favorites within each kind. Drag handles for mouse, up/down
  // arrow buttons for D-pad / touch / keyboard, checkboxes + block moves
  // for multi-select.
  import { onMount } from "svelte"
  import { SvelteSet } from "svelte/reactivity"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getFavoritesOrdered,
    setFavoritesOrder,
    moveFavorite,
    getFavoriteMeta,
    setFavoriteMeta,
  } from "@/scripts/lib/preferences.js"
  import { getCached } from "@/scripts/lib/cache.js"
  import { readCachedLiveChannels, hasCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
  import { kindLabelPlural, KIND_ORDER } from "@/scripts/lib/kinds.js"
  import { cachedImg } from "@/scripts/lib/img-cache.ts"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { edgeScrollVelocity } from "@/scripts/lib/drag-autoscroll.ts"

  /**
   * Shifts every contiguous run of selected ids one step toward the given
   * edge; a run already touching that edge stays put. Same rule as
   * shiftSelectedRuns in custom-playlist.ts.
   */
  function shiftSelectedIds(ids, selectedIds, direction) {
    const result = [...ids]
    const length = result.length
    if (direction === "up") {
      let index = 0
      while (index < length) {
        if (!selectedIds.has(result[index])) {
          index++
          continue
        }
        const runStart = index
        let runEnd = index
        while (runEnd + 1 < length && selectedIds.has(result[runEnd + 1])) runEnd++
        if (runStart > 0) {
          const [moved] = result.splice(runStart - 1, 1)
          result.splice(runEnd, 0, moved)
        }
        index = runEnd + 1
      }
    } else {
      let index = length - 1
      while (index >= 0) {
        if (!selectedIds.has(result[index])) {
          index--
          continue
        }
        const runEnd = index
        let runStart = index
        while (runStart - 1 >= 0 && selectedIds.has(result[runStart - 1])) runStart--
        if (runEnd < length - 1) {
          const [moved] = result.splice(runEnd + 1, 1)
          result.splice(runStart, 0, moved)
        }
        index = runStart - 1
      }
    }
    return result
  }

  /** Moves the selected ids as one block to targetIndex among the unselected ids. */
  function insertBlock(ids, selectedIds, targetIndex) {
    const selectedRun = ids.filter((id) => selectedIds.has(id))
    if (!selectedRun.length) return ids
    const rest = ids.filter((id) => !selectedIds.has(id))
    const clampedIndex = Math.max(0, Math.min(targetIndex, rest.length))
    return [...rest.slice(0, clampedIndex), ...selectedRun, ...rest.slice(clampedIndex)]
  }

  /** Moves the selected ids as one contiguous block, keeping their relative order. */
  function moveBlock(ids, selectedIds, direction) {
    if (direction === "top") return insertBlock(ids, selectedIds, 0)
    if (direction === "bottom") return insertBlock(ids, selectedIds, ids.length)
    return shiftSelectedIds(ids, selectedIds, direction)
  }

  /** Sorts the selected ids by name, writing them back into their own index slots. */
  function sortSelectedInPlace(ids, selectedIds, nameOf, direction) {
    const result = [...ids]
    const indices = []
    const sortedRun = []
    for (let index = 0; index < result.length; index++) {
      if (selectedIds.has(result[index])) {
        indices.push(index)
        sortedRun.push(result[index])
      }
    }
    sortedRun.sort((left, right) => {
      const compared = nameOf(left).localeCompare(nameOf(right), undefined, { sensitivity: "base", numeric: true })
      return direction === "desc" ? -compared : compared
    })
    for (let index = 0; index < indices.length; index++) {
      result[indices[index]] = sortedRun[index]
    }
    return result
  }

  /** @type {string} */
  let activePlaylistId = $state("")
  /** @type {{ live: any[], vod: any[], series: any[] }} */
  let lists = $state({ live: [], vod: [], series: [] })
  // Memoized catalog lookups; same rationale as FavoritesStrip.
  /** @type {{ live: Map<number, any>, vod: Map<number, any>, series: Map<number, any> } | null} */
  let lookups = null
  let lookupsForPlaylistId = ""

  // Per-kind selection for multi-select block moves.
  const selected = { live: new SvelteSet(), vod: new SvelteSet(), series: new SvelteSet() }
  const lastSelectedIndex = { live: null, vod: null, series: null }

  /** @type {{ kind: string, fromIdx: number } | null} */
  let dragState = $state(null)
  /** @type {{ kind: string, idx: number } | null} */
  let dragOver = $state(null)
  let scrollEl
  let scrollVelocity = 0
  let scrollRafId = null
  /** @type {{ kind: string, ids: Set<number> } | null} */
  let justMoved = $state(null)
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {klp(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const klp = (kind) => (locale, kindLabelPlural(kind))
  let _settleTimer = null
  function flagSettle(kind, ids) {
    if (_settleTimer) clearTimeout(_settleTimer)
    justMoved = { kind, ids: new Set(ids) }
    _settleTimer = setTimeout(() => {
      justMoved = null
      _settleTimer = null
    }, 320)
  }

  function buildList(playlistId, kind, lookup) {
    const ids = getFavoritesOrdered(playlistId, kind)
    return ids.map((id) => {
      const meta = getFavoriteMeta(playlistId, kind, id)
      const item = lookup.get(Number(id))
      if (item?.isHeader) {
        return { id: Number(id), name: item.name || meta?.name || "", logo: null, isHeader: true }
      }
      const name = meta?.name || item?.name || `${kindLabelPlural(kind)} ${id}`
      const logo = meta?.logo ?? item?.logo ?? null
      if (!meta && (item?.name || item?.logo)) {
        setFavoriteMeta(playlistId, kind, id, {
          name: item.name || "",
          logo: item.logo || null,
        })
      }
      return { id: Number(id), name, logo }
    })
  }

  function rebuildLookups(playlistId) {
    if (!playlistId) {
      lookups = null
      lookupsForPlaylistId = ""
      return
    }
    lookups = {
      live: new Map(
        readCachedLiveChannels(playlistId).map((channel) => [Number(channel.id), channel])
      ),
      vod: new Map(
        (getCached(playlistId, "vod")?.data || []).map((movie) => [
          Number(movie.id),
          movie,
        ])
      ),
      series: new Map(
        (getCached(playlistId, "series")?.data || []).map((series) => [
          Number(series.id),
          series,
        ])
      ),
    }
    lookupsForPlaylistId = playlistId
  }

  // Prune selections for ids that no longer exist; a plain reorder never
  // drops an id, so this only fires when a favorite is removed elsewhere.
  function pruneSelection() {
    for (const kind of KIND_ORDER) {
      const validIds = new Set(lists[kind].map((row) => row.id))
      for (const id of [...selected[kind]]) {
        if (!validIds.has(id)) selected[kind].delete(id)
      }
    }
  }

  async function reload() {
    const active = await getActiveEntry()
    const nextPlaylistId = active?._id || ""
    if (nextPlaylistId !== activePlaylistId) {
      for (const kind of KIND_ORDER) selected[kind].clear()
    }
    activePlaylistId = nextPlaylistId
    if (!activePlaylistId) {
      lists = { live: [], vod: [], series: [] }
      lookups = null
      return
    }
    await ensurePrefsLoaded()
    if (lookupsForPlaylistId !== activePlaylistId || !lookups) {
      rebuildLookups(activePlaylistId)
    }
    const empty = new Map()
    lists = {
      live: buildList(activePlaylistId, "live", lookups?.live || empty),
      vod: buildList(activePlaylistId, "vod", lookups?.vod || empty),
      series: buildList(activePlaylistId, "series", lookups?.series || empty),
    }
    pruneSelection()
  }

  function move(kind, idx, delta) {
    if (!activePlaylistId) return
    const next = idx + delta
    if (next < 0 || next >= lists[kind].length) return
    const id = lists[kind][idx]?.id
    if (id == null) return
    moveFavorite(activePlaylistId, kind, id, /** @type {-1|1} */ (delta))
    flagSettle(kind, [id])
  }

  function toggleSelection(kind, idx, shiftKey) {
    const id = lists[kind][idx]?.id
    if (id == null) return
    const set = selected[kind]
    if (shiftKey && lastSelectedIndex[kind] != null) {
      const start = Math.min(lastSelectedIndex[kind], idx)
      const end = Math.max(lastSelectedIndex[kind], idx)
      for (let i = start; i <= end; i++) {
        const rowId = lists[kind][i]?.id
        if (rowId != null) set.add(rowId)
      }
    } else if (set.has(id)) {
      set.delete(id)
    } else {
      set.add(id)
    }
    lastSelectedIndex[kind] = idx
  }

  function selectAll(kind) {
    const set = selected[kind]
    for (const row of lists[kind]) set.add(row.id)
  }

  function deselectAll(kind) {
    selected[kind].clear()
  }

  function applyBlockMove(kind, direction) {
    if (!activePlaylistId) return
    const selectedSet = selected[kind]
    if (!selectedSet.size) return
    const ids = lists[kind].map((row) => row.id)
    const next = moveBlock(ids, selectedSet, direction)
    if (next.join(",") === ids.join(",")) return
    setFavoritesOrder(activePlaylistId, kind, next)
    flagSettle(kind, selectedSet)
  }

  function applySort(kind, direction) {
    if (!activePlaylistId) return
    const selectedSet = selected[kind]
    if (!selectedSet.size) return
    const ids = lists[kind].map((row) => row.id)
    const namesById = new Map(lists[kind].map((row) => [row.id, row.name]))
    const nameOf = (id) => namesById.get(id) || ""
    const next = sortSelectedInPlace(ids, selectedSet, nameOf, direction)
    if (next.join(",") === ids.join(",")) return
    setFavoritesOrder(activePlaylistId, kind, next)
    flagSettle(kind, selectedSet)
  }

  function stopAutoScroll() {
    scrollVelocity = 0
    if (scrollRafId != null) {
      cancelAnimationFrame(scrollRafId)
      scrollRafId = null
    }
  }

  function stepAutoScroll() {
    if (!dragState || scrollVelocity === 0 || !scrollEl) {
      scrollRafId = null
      return
    }
    scrollEl.scrollTop += scrollVelocity
    scrollRafId = requestAnimationFrame(stepAutoScroll)
  }

  function onContainerDragOver(ev) {
    if (!dragState || !scrollEl) return
    const rect = scrollEl.getBoundingClientRect()
    scrollVelocity = edgeScrollVelocity(ev.clientY, rect.top, rect.bottom, 56, 14)
    if (scrollVelocity !== 0) {
      ev.preventDefault()
      if (scrollRafId == null) scrollRafId = requestAnimationFrame(stepAutoScroll)
    }
  }

  function onDragStart(kind, idx, ev) {
    dragState = { kind, fromIdx: idx }
    dragOver = null
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move"
      try { ev.dataTransfer.setData("text/plain", String(idx)) } catch {}
    }
  }
  function onDragOver(kind, idx, ev) {
    if (!dragState || dragState.kind !== kind) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move"
    if (dragOver?.kind !== kind || dragOver.idx !== idx) {
      dragOver = { kind, idx }
    }
  }
  function onDragLeave(kind, idx, ev) {
    if (dragOver?.kind === kind && dragOver.idx === idx) {
      dragOver = null
    }
  }
  function onDragEnd() {
    dragState = null
    dragOver = null
    stopAutoScroll()
  }
  function onDrop(kind, idx, ev) {
    ev.preventDefault()
    stopAutoScroll()
    if (!dragState || dragState.kind !== kind || !activePlaylistId) {
      dragState = null
      dragOver = null
      return
    }
    const from = dragState.fromIdx
    const to = idx
    dragState = null
    dragOver = null
    const ids = lists[kind].map((favorite) => favorite.id)
    const draggedId = ids[from]
    const selectedSet = selected[kind]
    if (draggedId != null && selectedSet.has(draggedId) && selectedSet.size > 1) {
      const restBefore = ids.slice(0, to).filter((id) => !selectedSet.has(id)).length
      const next = insertBlock(ids, selectedSet, restBefore)
      if (next.join(",") === ids.join(",")) return
      setFavoritesOrder(activePlaylistId, kind, next)
      flagSettle(kind, selectedSet)
      return
    }
    if (from === to) return
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    setFavoritesOrder(activePlaylistId, kind, ids)
    flagSettle(kind, [moved])
  }

  onMount(() => {
    reload()
    async function onCatalogChanged() {
      lookups = null
      lookupsForPlaylistId = ""
      await reload()
    }
    const onLocale = () => { locale++ }
    const handlers = {
      "xt:active-changed": onCatalogChanged,
      "xt:catalog-warmed": onCatalogChanged,
      "xt:favorites-changed": reload,
      "xt:favorites-order-changed": reload,
      [LOCALE_EVENT]: onLocale,
    }
    for (const [eventName, handler] of Object.entries(handlers)) {
      document.addEventListener(eventName, handler)
    }
    return () => {
      stopAutoScroll()
      for (const [eventName, handler] of Object.entries(handlers)) {
        document.removeEventListener(eventName, handler)
      }
    }
  })

  let total = $derived(lists.live.length + lists.vod.length + lists.series.length)
</script>

<div class="flex flex-col gap-4 overflow-x-clip">
  <div class="flex justify-end">
    <span class="text-2xs text-fg-3 tabular-nums">
      {total === 0 ? tr("settings.favoritesReorder.empty") : tr("settings.favoritesReorder.count", { n: total })}
    </span>
  </div>
  {#if total === 0}
    <div class="text-xs text-fg-3 italic">
      {tr("settings.favoritesReorder.emptyState")}
    </div>
  {:else}
    <div
      class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto overflow-x-hidden custom-scroll pr-1 -mr-1"
      bind:this={scrollEl}
      ondragover={onContainerDragOver}>
    {#each KIND_ORDER as kind}
      {#if lists[kind].length}
        <div class="flex flex-col gap-1.5">
          <div class="sticky top-0 z-10 -mx-5 sm:-mx-6 px-5 sm:px-6 py-1.5 bg-surface/95 backdrop-blur-sm border-b border-line/60 flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <span class="text-eyebrow font-semibold uppercase tracking-wide text-fg-3">{klp(kind)}</span>
              {#if lists[kind].length >= 2}
                <span class="flex items-center gap-1">
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2 rounded-lg text-2xs text-fg-3 hover:text-fg focus-visible:text-fg underline-offset-2 hover:underline outline-none"
                    onclick={() => selectAll(kind)}>
                    {tr("settings.favoritesReorder.selectAll")}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2 rounded-lg text-2xs text-fg-3 hover:text-fg focus-visible:text-fg underline-offset-2 hover:underline outline-none"
                    onclick={() => deselectAll(kind)}>
                    {tr("settings.favoritesReorder.deselectAll")}
                  </button>
                </span>
              {/if}
            </div>
            {#if lists[kind].length >= 2}
              <div
                class="flex items-center gap-2 flex-wrap rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 transition-opacity"
                class:opacity-50={selected[kind].size === 0}
                class:pointer-events-none={selected[kind].size === 0}>
                <span class="text-2xs font-medium text-fg-2 tabular-nums shrink-0">
                  {tr("settings.favoritesReorder.selectedCount", { n: selected[kind].size })}
                </span>
                <div class="flex items-center gap-1.5 flex-wrap ms-auto">
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2.5 rounded-full border border-line bg-surface text-2xs font-medium text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors disabled:opacity-50"
                    disabled={selected[kind].size === 0}
                    onclick={() => applyBlockMove(kind, "up")}>
                    {tr("settings.favoritesReorder.moveUp")}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2.5 rounded-full border border-line bg-surface text-2xs font-medium text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors disabled:opacity-50"
                    disabled={selected[kind].size === 0}
                    onclick={() => applyBlockMove(kind, "down")}>
                    {tr("settings.favoritesReorder.moveDown")}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2.5 rounded-full border border-line bg-surface text-2xs font-medium text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors disabled:opacity-50"
                    disabled={selected[kind].size === 0}
                    onclick={() => applyBlockMove(kind, "top")}>
                    {tr("settings.favoritesReorder.moveToTop")}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2.5 rounded-full border border-line bg-surface text-2xs font-medium text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors disabled:opacity-50"
                    disabled={selected[kind].size === 0}
                    onclick={() => applyBlockMove(kind, "bottom")}>
                    {tr("settings.favoritesReorder.moveToBottom")}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2.5 rounded-full border border-line bg-surface text-2xs font-medium text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors disabled:opacity-50"
                    disabled={selected[kind].size === 0}
                    onclick={() => applySort(kind, "asc")}>
                    {tr("settings.favoritesReorder.sortAz")}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2.5 rounded-full border border-line bg-surface text-2xs font-medium text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors disabled:opacity-50"
                    disabled={selected[kind].size === 0}
                    onclick={() => applySort(kind, "desc")}>
                    {tr("settings.favoritesReorder.sortZa")}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center min-h-9 pointer-coarse:min-h-11 px-2.5 rounded-full border border-line bg-surface text-2xs font-medium text-fg-2 hover:text-fg hover:border-line-soft hover:bg-surface-3 focus-visible:bg-surface-3 outline-none transition-colors disabled:opacity-50"
                    disabled={selected[kind].size === 0}
                    onclick={() => deselectAll(kind)}>
                    {tr("settings.favoritesReorder.clearSelection")}
                  </button>
                </div>
              </div>
            {/if}
          </div>
          <ul class="flex flex-col gap-1">
            {#each lists[kind] as row, idx (row.id)}
              <li
                draggable="true"
                ondragstart={(ev) => onDragStart(kind, idx, ev)}
                ondragover={(ev) => onDragOver(kind, idx, ev)}
                ondragleave={(ev) => onDragLeave(kind, idx, ev)}
                ondragend={onDragEnd}
                ondrop={(ev) => onDrop(kind, idx, ev)}
                class="reorder-row group flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-[opacity,border-color] duration-150"
                class:is-dragging={dragState?.kind === kind && dragState?.fromIdx === idx}
                class:is-drop-target={dragOver?.kind === kind && dragOver?.idx === idx && dragState?.fromIdx !== idx}
                class:is-settling={justMoved?.kind === kind && justMoved?.ids.has(row.id)}
                class:bg-surface-2={!row.isHeader}
                class:border-dashed={!!row.isHeader}
                class:border-line={!(dragOver?.kind === kind && dragOver?.idx === idx && dragState?.fromIdx !== idx)}
                class:hover:border-line-soft={!dragState}>
                <label
                  class="shrink-0 inline-flex items-center justify-center size-9 pointer-coarse:size-11 rounded-md cursor-pointer select-none"
                  aria-label={tr("settings.favoritesReorder.selectAria", { name: row.name })}>
                  <input
                    type="checkbox"
                    class="size-4 accent-accent outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                    checked={selected[kind].has(row.id)}
                    onclick={(ev) => {
                      toggleSelection(kind, idx, ev.shiftKey)
                      ev.currentTarget.checked = selected[kind].has(row.id)
                    }} />
                </label>
                <span aria-hidden="true" class="reorder-handle text-fg-3 cursor-grab active:cursor-grabbing px-1 select-none" title={tr("settings.favoritesReorder.dragToReorder")}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
                </span>
                {#if !row.isHeader}
                  <span class="size-7 shrink-0 rounded-md bg-surface ring-1 ring-line overflow-hidden flex items-center justify-center">
                    {#if row.logo}
                      <img use:cachedImg={{ url: row.logo, kind: "logo" }} alt="" loading="lazy" fetchpriority="low" class="h-full w-full object-cover" />
                    {/if}
                  </span>
                {/if}
                <span class="flex-1 min-w-0 truncate {row.isHeader ? 'text-2xs font-semibold uppercase tracking-wide text-fg-3' : 'text-sm text-fg'}">
                  {row.name}
                </span>
                <span class="shrink-0 flex items-center gap-1">
                  <button
                    type="button"
                    class="reorder-arrow size-9 pointer-coarse:size-11 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-3 focus-visible:bg-surface-3 outline-none disabled:opacity-30"
                    aria-label={tr("settings.favoritesReorder.moveUpAria", { name: row.name })}
                    title={tr("settings.favoritesReorder.moveUp")}
                    disabled={idx === 0}
                    onclick={() => move(kind, idx, -1)}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
                  </button>
                  <button
                    type="button"
                    class="reorder-arrow size-9 pointer-coarse:size-11 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-3 focus-visible:bg-surface-3 outline-none disabled:opacity-30"
                    aria-label={tr("settings.favoritesReorder.moveDownAria", { name: row.name })}
                    title={tr("settings.favoritesReorder.moveDown")}
                    disabled={idx === lists[kind].length - 1}
                    onclick={() => move(kind, idx, 1)}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                  </button>
                </span>
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
  .reorder-row.is-dragging {
    opacity: 0.4;
  }
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
    .reorder-handle {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .reorder-row {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
