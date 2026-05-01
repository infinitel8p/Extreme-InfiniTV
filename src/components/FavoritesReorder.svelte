<script>
  // Reorder favorites within each kind. Drag handles for mouse, up/down
  // arrow buttons for D-pad / touch / keyboard.
  import { onMount } from "svelte"
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
  import { KIND_LABEL_PLURAL, KIND_ORDER } from "@/scripts/lib/kinds.js"
  import { t } from "@/scripts/lib/i18n.js"

  /** @type {string} */
  let activePlaylistId = $state("")
  /** @type {{ live: any[], vod: any[], series: any[] }} */
  let lists = $state({ live: [], vod: [], series: [] })
  // Memoized catalog lookups; same rationale as FavoritesStrip.
  /** @type {{ live: Map<number, any>, vod: Map<number, any>, series: Map<number, any> } | null} */
  let lookups = null
  let lookupsForPlaylistId = ""

  /** @type {{ kind: string, fromIdx: number } | null} */
  let dragState = $state(null)
  /** @type {{ kind: string, idx: number } | null} */
  let dragOver = $state(null)
  /** @type {{ kind: string, id: number } | null} */
  let justMoved = $state(null)
  let _settleTimer = null
  function flagSettle(kind, id) {
    if (_settleTimer) clearTimeout(_settleTimer)
    justMoved = { kind, id }
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
      const name = meta?.name || item?.name || `${KIND_LABEL_PLURAL[kind]} ${id}`
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
        (
          getCached(playlistId, "live")?.data ||
          getCached(playlistId, "m3u")?.data ||
          []
        ).map((c) => [Number(c.id), c])
      ),
      vod: new Map(
        (getCached(playlistId, "vod")?.data || []).map((m) => [
          Number(m.id),
          m,
        ])
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
    activePlaylistId = active?._id || ""
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
  }

  function move(kind, idx, delta) {
    if (!activePlaylistId) return
    const next = idx + delta
    if (next < 0 || next >= lists[kind].length) return
    const id = lists[kind][idx]?.id
    if (id == null) return
    moveFavorite(activePlaylistId, kind, id, /** @type {-1|1} */ (delta))
    flagSettle(kind, id)
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
  }
  function onDrop(kind, idx, ev) {
    ev.preventDefault()
    if (!dragState || dragState.kind !== kind || !activePlaylistId) {
      dragState = null
      dragOver = null
      return
    }
    const from = dragState.fromIdx
    const to = idx
    dragState = null
    dragOver = null
    if (from === to) return
    const ids = lists[kind].map((r) => r.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    setFavoritesOrder(activePlaylistId, kind, ids)
    flagSettle(kind, moved)
  }

  onMount(() => {
    reload()
    async function onCatalogChanged() {
      lookups = null
      lookupsForPlaylistId = ""
      await reload()
    }
    const handlers = {
      "xt:active-changed": onCatalogChanged,
      "xt:catalog-warmed": onCatalogChanged,
      "xt:favorites-changed": reload,
      "xt:favorites-order-changed": reload,
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

<div class="rounded-xl border border-line bg-surface p-4 flex flex-col gap-4">
  <div class="flex items-baseline justify-between gap-2">
    <h2 class="text-sm font-semibold text-fg">{t("settings.favoritesReorder.title")}</h2>
    <span class="text-2xs text-fg-3 tabular-nums">
      {total === 0 ? t("settings.favoritesReorder.empty") : t("settings.favoritesReorder.count", { n: total })}
    </span>
  </div>
  <p class="text-xs text-fg-3">
    {t("settings.favoritesReorder.helperLong")}
  </p>

  {#if total === 0}
    <div class="text-xs text-fg-3 italic">
      {t("settings.favoritesReorder.emptyState")}
    </div>
  {:else}
    <div class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto custom-scroll pr-1 -mr-1">
    {#each KIND_ORDER as kind}
      {#if lists[kind].length}
        <div class="flex flex-col gap-1.5">
          <div class="sticky top-0 z-10 -mx-4 px-4 py-1.5 bg-surface/95 backdrop-blur-sm border-b border-line/60 text-eyebrow font-semibold uppercase tracking-wide text-fg-3">
            {KIND_LABEL_PLURAL[kind]}
          </div>
          <ul class="flex flex-col gap-1">
            {#each lists[kind] as row, i (row.id)}
              <li
                draggable="true"
                ondragstart={(ev) => onDragStart(kind, i, ev)}
                ondragover={(ev) => onDragOver(kind, i, ev)}
                ondragleave={(ev) => onDragLeave(kind, i, ev)}
                ondragend={onDragEnd}
                ondrop={(ev) => onDrop(kind, i, ev)}
                class="reorder-row group flex items-center gap-2 rounded-lg border bg-surface-2 px-2 py-1.5 transition-[opacity,border-color] duration-150"
                class:is-dragging={dragState?.kind === kind && dragState?.fromIdx === i}
                class:is-drop-target={dragOver?.kind === kind && dragOver?.idx === i && dragState?.fromIdx !== i}
                class:is-settling={justMoved?.kind === kind && justMoved?.id === row.id}
                class:border-line={!(dragOver?.kind === kind && dragOver?.idx === i && dragState?.fromIdx !== i)}
                class:hover:border-line-soft={!dragState}>
                <span aria-hidden="true" class="reorder-handle text-fg-3 cursor-grab active:cursor-grabbing px-1 select-none" title={t("settings.favoritesReorder.dragToReorder")}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
                </span>
                <span class="size-7 shrink-0 rounded-md bg-surface ring-1 ring-line overflow-hidden flex items-center justify-center">
                  {#if row.logo}
                    <img src={row.logo} alt="" loading="lazy" class="h-full w-full object-cover" />
                  {/if}
                </span>
                <span class="flex-1 min-w-0 truncate text-sm text-fg">
                  {row.name}
                </span>
                <span class="shrink-0 flex items-center gap-1">
                  <button
                    type="button"
                    class="reorder-arrow size-7 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-3 focus-visible:bg-surface-3 outline-none disabled:opacity-30"
                    aria-label={t("settings.favoritesReorder.moveUpAria", { name: row.name })}
                    title={t("settings.favoritesReorder.moveUp")}
                    disabled={i === 0}
                    onclick={() => move(kind, i, -1)}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
                  </button>
                  <button
                    type="button"
                    class="reorder-arrow size-7 inline-flex items-center justify-center rounded-md text-fg-3 hover:text-fg hover:bg-surface-3 focus-visible:bg-surface-3 outline-none disabled:opacity-30"
                    aria-label={t("settings.favoritesReorder.moveDownAria", { name: row.name })}
                    title={t("settings.favoritesReorder.moveDown")}
                    disabled={i === lists[kind].length - 1}
                    onclick={() => move(kind, i, 1)}>
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
    .reorder-arrow {
      width: 2.75rem;
      height: 2.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .reorder-row {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
