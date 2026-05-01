<script>
  import { onMount, tick } from "svelte"
  import { IconChevronDown, IconPlus, IconRefresh } from "@tabler/icons-svelte"
  import {
    getEntries,
    getActiveEntry,
    refreshActive,
  } from "@/scripts/lib/creds.js"
  import {
    renderPlaylistRow,
    getPlaylistListEmptyCopy,
  } from "@/scripts/lib/playlist-rows.js"
  import { hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
  import { t } from "@/scripts/lib/i18n.js"

  const SECTION_ID = "ps-popover-section"

  let isOpen = $state(false)
  let activeTitle = $state(t("playlist.none"))
  let activeBadge = $state("-")
  let hasActive = $state(false)

  /** @type {HTMLElement | undefined} */
  let wrapEl
  /** @type {HTMLButtonElement | undefined} */
  let triggerEl
  /** @type {HTMLElement | undefined} */
  let popoverEl
  /** @type {HTMLElement | undefined} */
  let listEl

  let sectionRegistered = false

  async function openPopover() {
    if (isOpen) return
    isOpen = true
    await tick()
    await renderList()
    const SN = window.SpatialNavigation
    if (SN && !sectionRegistered) {
      try {
        SN.add({
          id: SECTION_ID,
          selector: "#ps-popover button, #ps-popover a",
          restrict: "self-only",
          enterTo: "default-element",
          defaultElement: "#ps-popover button[data-id], #ps-popover a",
        })
        sectionRegistered = true
      } catch {}
    }
    requestAnimationFrame(() => {
      SN?.makeFocusable?.()
      const first = popoverEl?.querySelector("button[data-id], a, button")
      if (first instanceof HTMLElement) first.focus()
    })
  }

  function closePopover() {
    if (!isOpen) return
    isOpen = false
    const SN = window.SpatialNavigation
    if (SN && sectionRegistered) {
      try {
        SN.remove(SECTION_ID)
      } catch {}
      sectionRegistered = false
    }
    triggerEl?.focus()
  }

  function onTriggerClick(event) {
    event.stopPropagation()
    if (!window.matchMedia("(min-width: 64rem)").matches) {
      window.location.href = "/settings"
      return
    }
    if (isOpen) closePopover()
    else openPopover()
  }

  async function onRefresh() {
    closePopover()
    try {
      await refreshActive()
      toastSuccess(t("settings.toast.refreshOk"))
    } catch (err) {
      toastError(t("settings.toast.refreshFail"), {
        description: (err && err.message) || t("settings.toast.checkConnLogin"),
        duration: 6000,
      })
    }
  }

  async function renderHeader() {
    const active = await getActiveEntry()
    if (!active) {
      activeTitle = t("playlist.none")
      activeBadge = "-"
      hasActive = false
      return
    }
    activeTitle = active.title
    activeBadge = active.type === "xtream" ? "XT" : "M3U"
    hasActive = true
  }

  async function renderList() {
    if (!listEl) return
    const entries = await getEntries()
    if (!entries.length) {
      listEl.innerHTML = `<div class="px-3.5 py-4 text-fg-3 text-xs">${getPlaylistListEmptyCopy()}</div>`
      return
    }
    const active = await getActiveEntry()
    await Promise.all(
      entries.flatMap((entry) => [
        hydrateCache(entry._id, "live"),
        hydrateCache(entry._id, "m3u"),
        hydrateCache(entry._id, "vod"),
        hydrateCache(entry._id, "series"),
      ])
    )
    const frag = document.createDocumentFragment()
    for (const entry of entries) {
      frag.appendChild(
        renderPlaylistRow({
          entry,
          isActive: active?._id === entry._id,
          density: "compact",
          onAfterSelect: async () => {
            await renderHeader()
            await renderList()
            closePopover()
          },
          onAfterRemove: async () => {
            await renderHeader()
            await renderList()
          },
        })
      )
    }
    listEl.replaceChildren(frag)
  }

  onMount(() => {
    renderHeader()

    const onDocClick = (event) => {
      if (!isOpen) return
      if (wrapEl && !wrapEl.contains(event.target)) closePopover()
    }
    const onDocKey = (event) => {
      if (event.key === "Escape" && isOpen) {
        event.stopPropagation()
        closePopover()
      }
    }
    const onActiveChanged = () => {
      renderHeader()
      if (isOpen) renderList()
    }
    const onEntriesUpdated = () => {
      if (isOpen) renderList()
    }
    const onCatalogWarmed = () => {
      if (isOpen) renderList()
    }

    document.addEventListener("click", onDocClick)
    document.addEventListener("keydown", onDocKey)
    document.addEventListener("xt:active-changed", onActiveChanged)
    document.addEventListener("xt:entries-updated", onEntriesUpdated)
    document.addEventListener("xt:catalog-warmed", onCatalogWarmed)
    document.addEventListener("xt:locale-changed", onActiveChanged)
    return () => {
      document.removeEventListener("click", onDocClick)
      document.removeEventListener("keydown", onDocKey)
      document.removeEventListener("xt:active-changed", onActiveChanged)
      document.removeEventListener("xt:entries-updated", onEntriesUpdated)
      document.removeEventListener("xt:catalog-warmed", onCatalogWarmed)
      document.removeEventListener("xt:locale-changed", onActiveChanged)
    }
  })
</script>

<div
  bind:this={wrapEl}
  data-ps-wrap
  data-open={isOpen ? "true" : "false"}
  class="relative [view-transition-name:playlist-switcher]">
  <button
    bind:this={triggerEl}
    id="ps-trigger"
    type="button"
    aria-haspopup="menu"
    aria-controls="ps-popover"
    aria-expanded={isOpen}
    title="Switch playlist"
    data-i18n-attr="title:playlist.switch"
    onclick={onTriggerClick}
    class="flex w-full items-center gap-2.5 px-2.5 py-2.5 min-h-11 rounded-xl border border-line bg-surface text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent
      justify-center lg:justify-between">
    <span class="flex items-center gap-2.5 min-w-0">
      <span
        id="ps-badge"
        class="h-5 px-1.5 inline-flex items-center justify-center rounded-md text-label font-semibold uppercase text-fg-2 ring-1 ring-line shrink-0">
        {activeBadge}
      </span>
      <span
        id="ps-title"
        class:text-fg={hasActive}
        class:text-fg-3={!hasActive}
        class="hidden lg:inline truncate tracking-tight">
        {activeTitle}
      </span>
    </span>
    <IconChevronDown
      aria-hidden="true"
      class="hidden lg:block h-4 w-4 text-fg-3 shrink-0 transition-transform duration-200 ps-chevron"
    />
  </button>

  <div
    bind:this={popoverEl}
    id="ps-popover"
    role="menu"
    aria-labelledby="ps-trigger"
    hidden={!isOpen}
    class="ps-popover
      max-h-[min(70dvh,32rem)]
      rounded-t-xl border border-line border-b-0 bg-surface text-fg
      overflow-hidden">
    <div
      bind:this={listEl}
      id="ps-list"
      class="flex-1 min-h-0 overflow-auto custom-scroll py-2">
      <div data-i18n="common.loading" class="px-3.5 py-3 text-fg-3 text-xs">Loading…</div>
    </div>

    <div class="flex items-stretch border-t border-line shrink-0">
      {#if hasActive}
        <button
          id="ps-refresh"
          type="button"
          onclick={onRefresh}
          class="flex flex-1 items-center justify-center gap-1.5 px-2 py-3 text-sm font-medium text-fg-2 whitespace-nowrap
            hover:text-fg hover:bg-surface-2
            focus-visible:text-fg focus-visible:bg-surface-2
            min-h-11 transition-colors outline-none border-r border-line">
          <IconRefresh aria-hidden="true" class="h-4 w-4 shrink-0" />
          <span data-i18n="common.refresh">Refresh</span>
        </button>
      {/if}
      <a
        href="/login"
        class="flex flex-1 items-center justify-center gap-1.5 px-2 py-3 text-sm font-medium text-fg whitespace-nowrap
          hover:bg-surface-2
          focus-visible:bg-surface-2
          min-h-11 transition-colors">
        <IconPlus aria-hidden="true" class="h-4 w-4 text-accent shrink-0" />
        <span data-i18n="playlist.add">Add playlist</span>
      </a>
    </div>
  </div>
</div>

<style>
  [data-ps-wrap][data-open="true"] :global(#ps-popover) {
    display: flex;
    flex-direction: column;
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    z-index: 50;
  }
  :global(#ps-trigger[aria-expanded="true"] .ps-chevron) {
    transform: rotate(180deg);
  }
  :global(#ps-trigger[aria-expanded="true"]) {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    background-color: var(--color-surface-2);
  }
</style>
