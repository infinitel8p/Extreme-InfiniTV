// Two-level picker page inside the cast remote dialog: groups -> items, with an optional
// search that spans everything from either level. Lives in the remote's own <dialog> so
// there is a single focus trap and one spatial-nav scope. The source decides what the two
// levels mean: channel groups and channels, or seasons and episodes.
import { t } from "@/scripts/lib/i18n.js"
import { toast } from "@/scripts/lib/toast.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { escapeHtml } from "@/scripts/lib/format.js"
import { requestLogoFallback } from "@/scripts/lib/logo-fallback.js"
import { ICON_ARROW_LEFT, ICON_SEARCH } from "@/scripts/lib/icons.js"

const RENDER_CHUNK = 40
const SEARCH_DEBOUNCE_MS = 140

export interface PickerItem {
  id: string
  title: string
  subtitle?: string | null
  logoUrl?: string | null
  /** Handed to the logo fallback matcher; omit to skip the lookup entirely. */
  logoLookup?: { name?: string | null; tvgId?: string | null } | null
}

export interface PickerGroup {
  key: string
  label: string
  /** Raw SVG string, for the synthetic groups that carry one. */
  icon?: string
  items: PickerItem[]
}

export interface PickerLabels {
  heading: string
  searchPlaceholder: string
  results: string
  loading: string
  empty: string
  noMatch: string
  failed: string
  tuneFailed: string
  backToGroups: string
}

export interface PickerSource {
  labels: PickerLabels
  load(): Promise<PickerGroup[]>
  /** Cross-group search; leave undefined for sources that shouldn't offer one. */
  search?(query: string): PickerItem[]
  /** Id of whatever is on the receiver right now, for the now-playing accent. */
  playingId(): string | null
  /** Casts the item. `siblingIds` is the list the user picked from, in display order. */
  activate(item: PickerItem, siblingIds: string[]): Promise<boolean>
}

export interface CastPickerPanelOptions {
  source: PickerSource
  onBack(): void
  onTuneStart(): void
  onTuneEnd(ok: boolean): void
}

export interface CastPickerPanelHandle {
  /** Puts the panel back at the group level with an empty search. */
  reset(): void
  focusFirst(): void
  /** True when a level was popped; false when the panel was already at the top. */
  goBack(): boolean
  refreshNowPlaying(): void
  destroy(): void
}

type Level = "groups" | "items"

interface PanelRefs {
  back: HTMLButtonElement
  heading: HTMLElement
  count: HTMLElement
  searchRow: HTMLElement
  search: HTMLInputElement
  list: HTMLElement
  status: HTMLElement
}

function buildSkeleton(container: HTMLElement): void {
  container.innerHTML = `
    <header class="shrink-0 flex items-center gap-1 ps-1 pe-3 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] pb-2 border-b border-line short-viewport:pt-[calc(0.25rem+env(safe-area-inset-top,0px))]">
      <button type="button" data-role="panel-back" class="min-h-11 min-w-11 grid place-items-center rounded-full text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2">${ICON_ARROW_LEFT}</button>
      <h2 data-role="panel-heading" class="flex-1 min-w-0 truncate text-base font-semibold tracking-tight"></h2>
      <span data-role="panel-count" class="shrink-0 text-xs tabular-nums text-fg-3"></span>
    </header>
    <div data-role="panel-search-row" class="shrink-0 px-3 py-2 border-b border-line">
      <div class="flex items-center gap-2 rounded-lg bg-surface-2 px-3 focus-within:ring-1 focus-within:ring-accent">
        <span class="shrink-0 text-fg-3" aria-hidden="true">${ICON_SEARCH}</span>
        <input data-role="panel-search" type="search" autocomplete="off" spellcheck="false"
               class="min-h-11 w-full bg-transparent text-sm outline-none placeholder:text-fg-3" />
      </div>
    </div>
    <div data-role="panel-list" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 py-2"></div>
    <p data-role="panel-status" class="hidden shrink-0 px-4 pb-4 text-center text-sm text-fg-3" role="status"></p>
  `
}

function collectRefs(container: HTMLElement): PanelRefs {
  const query = <T extends HTMLElement>(role: string) => container.querySelector<T>(`[data-role="${role}"]`)!
  return {
    back: query<HTMLButtonElement>("panel-back"),
    heading: query("panel-heading"),
    count: query("panel-count"),
    searchRow: query("panel-search-row"),
    search: query<HTMLInputElement>("panel-search"),
    list: query("panel-list"),
    status: query("panel-status"),
  }
}

export function mountCastPickerPanel(
  container: HTMLElement,
  options: CastPickerPanelOptions
): CastPickerPanelHandle {
  const { source } = options
  buildSkeleton(container)
  const refs = collectRefs(container)
  refs.back.setAttribute("aria-label", t("common.back"))
  refs.search.placeholder = source.labels.searchPlaceholder
  refs.search.setAttribute("aria-label", source.labels.searchPlaceholder)
  refs.searchRow.classList.toggle("hidden", !source.search)

  let groups: PickerGroup[] = []
  let level: Level = "groups"
  let activeGroup: PickerGroup | null = null
  let query = ""
  let rendered = 0
  let visibleItems: PickerItem[] = []
  let tuning = false
  let destroyed = false
  let observer: IntersectionObserver | null = null

  function setStatus(text: string): void {
    refs.status.textContent = text
    refs.status.classList.toggle("hidden", !text)
  }

  function renderGroupRows(): void {
    refs.heading.textContent = source.labels.heading
    refs.count.textContent = ""
    refs.back.setAttribute("aria-label", t("cast.remote.backToRemote"))
    const fragment = document.createDocumentFragment()
    for (const group of groups) {
      const row = document.createElement("button")
      row.type = "button"
      row.dataset.groupKey = group.key
      row.className =
        "flex w-full min-h-12 items-center gap-3 rounded-lg px-3 text-start hover:bg-surface-2 focus-visible:bg-surface-2"
      row.innerHTML =
        (group.icon ? `<span class="shrink-0 text-fg-3" aria-hidden="true">${group.icon}</span>` : "") +
        `<span class="flex-1 min-w-0 truncate text-sm">${escapeHtml(group.label)}</span>` +
        `<span class="shrink-0 text-xs tabular-nums text-fg-3">${group.items.length.toLocaleString()}</span>`
      fragment.appendChild(row)
    }
    refs.list.replaceChildren(fragment)
    refs.list.scrollTop = 0
    setStatus(groups.length ? "" : source.labels.empty)
  }

  function itemRow(item: PickerItem): HTMLElement {
    const row = document.createElement("button")
    row.type = "button"
    row.dataset.itemId = item.id
    row.className =
      "channel-row flex w-full min-h-14 items-center gap-3 rounded-lg px-3 py-2 text-start hover:bg-surface-2 focus-visible:bg-surface-2"
    if (source.playingId() === item.id) row.dataset.nowPlaying = "true"

    if (item.logoUrl !== undefined || item.logoLookup) {
      const logoBox = document.createElement("span")
      logoBox.className =
        "grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-surface-2 ring-1 ring-inset ring-line text-fg-3"
      logoBox.setAttribute("aria-hidden", "true")
      if (item.logoUrl) {
        const img = document.createElement("img")
        img.src = item.logoUrl
        img.alt = ""
        img.loading = "lazy"
        img.decoding = "async"
        img.referrerPolicy = "no-referrer"
        img.className = "h-full w-full object-contain"
        img.onerror = () => {
          img.remove()
          if (item.logoLookup) requestLogoFallback(logoBox, item.logoLookup)
        }
        logoBox.appendChild(img)
      } else if (item.logoLookup) {
        requestLogoFallback(logoBox, item.logoLookup)
      }
      row.appendChild(logoBox)
    }

    const textCol = document.createElement("span")
    textCol.className = "flex min-w-0 flex-1 flex-col"
    const title = document.createElement("span")
    title.className = "truncate text-sm"
    title.textContent = item.title
    textCol.appendChild(title)
    if (item.subtitle) {
      const subtitle = document.createElement("span")
      subtitle.className = "truncate text-xs text-fg-3"
      subtitle.textContent = item.subtitle
      textCol.appendChild(subtitle)
    }
    row.appendChild(textCol)
    return row
  }

  function renderChunk(): void {
    if (rendered >= visibleItems.length) return
    const fragment = document.createDocumentFragment()
    const end = Math.min(rendered + RENDER_CHUNK, visibleItems.length)
    for (let i = rendered; i < end; i++) fragment.appendChild(itemRow(visibleItems[i]))
    rendered = end
    const sentinel = refs.list.querySelector('[data-role="panel-sentinel"]')
    if (sentinel) refs.list.insertBefore(fragment, sentinel)
    else refs.list.appendChild(fragment)
    if (rendered >= visibleItems.length) sentinel?.remove()
  }

  function renderItemRows(items: PickerItem[], heading: string): void {
    visibleItems = items
    rendered = 0
    refs.heading.textContent = heading
    refs.count.textContent = items.length ? items.length.toLocaleString() : ""
    const sentinel = document.createElement("div")
    sentinel.dataset.role = "panel-sentinel"
    sentinel.className = "h-4"
    refs.list.replaceChildren(sentinel)
    renderChunk()
    refs.list.scrollTop = 0
    observer?.disconnect()
    if (rendered < visibleItems.length) observer?.observe(sentinel)
    setStatus(items.length ? "" : query ? source.labels.noMatch : source.labels.empty)
  }

  function render(): void {
    if (query && source.search) {
      refs.back.setAttribute("aria-label", t("common.back"))
      renderItemRows(source.search(query), source.labels.results)
      return
    }
    if (level === "items" && activeGroup) {
      refs.back.setAttribute("aria-label", source.labels.backToGroups)
      renderItemRows(activeGroup.items, activeGroup.label)
      return
    }
    renderGroupRows()
  }

  async function load(): Promise<void> {
    setStatus(source.labels.loading)
    try {
      groups = await source.load()
      if (destroyed) return
      // A single group is a level the user would only ever pass through.
      if (groups.length === 1) {
        level = "items"
        activeGroup = groups[0]
      }
      render()
    } catch {
      setStatus(source.labels.failed)
    }
  }

  async function tune(itemId: string): Promise<void> {
    if (tuning) return
    const item = visibleItems.find((candidate) => candidate.id === itemId)
    if (!item) return
    tuning = true
    options.onTuneStart()
    const siblingIds = visibleItems.map((candidate) => candidate.id)
    const ok = await source.activate(item, siblingIds)
    tuning = false
    if (!ok) toast({ title: source.labels.tuneFailed })
    options.onTuneEnd(ok)
  }

  function onListClick(event: Event): void {
    const target = event.target as HTMLElement | null
    const groupRow = target?.closest<HTMLElement>("[data-group-key]")
    if (groupRow) {
      activeGroup = groups.find((group) => group.key === groupRow.dataset.groupKey) || null
      level = "items"
      render()
      refs.list.querySelector<HTMLElement>("button")?.focus()
      return
    }
    const itemRowEl = target?.closest<HTMLElement>("[data-item-id]")
    if (itemRowEl?.dataset.itemId) void tune(itemRowEl.dataset.itemId)
  }

  /** Spatial nav cannot reach rows that were never rendered, so landing on the last one grows the list. */
  function onListFocusIn(event: Event): void {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-item-id]")
    if (!row) return
    const rows = refs.list.querySelectorAll("[data-item-id]")
    if (rows[rows.length - 1] === row) renderChunk()
  }

  const onSearchInput = debounce(() => {
    query = refs.search.value.trim()
    render()
  }, SEARCH_DEBOUNCE_MS)

  function goBack(): boolean {
    if (query) {
      refs.search.value = ""
      query = ""
      render()
      return true
    }
    // With one group there is no group level to return to.
    if (level === "items" && groups.length > 1) {
      level = "groups"
      activeGroup = null
      render()
      return true
    }
    return false
  }

  function onBackClick(): void {
    if (!goBack()) options.onBack()
  }

  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) renderChunk()
      },
      { root: refs.list, rootMargin: "200px" }
    )
  }

  refs.list.addEventListener("click", onListClick)
  refs.list.addEventListener("focusin", onListFocusIn)
  refs.search.addEventListener("input", onSearchInput)
  refs.back.addEventListener("click", onBackClick)

  void load()

  return {
    reset(): void {
      query = ""
      refs.search.value = ""
      if (groups.length > 1) {
        level = "groups"
        activeGroup = null
      }
      if (groups.length) render()
    },
    focusFirst(): void {
      const firstRow = refs.list.querySelector<HTMLElement>("button")
      ;(firstRow || refs.back).focus()
    },
    goBack,
    refreshNowPlaying(): void {
      const playing = source.playingId()
      for (const row of refs.list.querySelectorAll<HTMLElement>("[data-item-id]")) {
        if (row.dataset.itemId === playing) row.dataset.nowPlaying = "true"
        else delete row.dataset.nowPlaying
      }
    },
    destroy(): void {
      destroyed = true
      observer?.disconnect()
      observer = null
      refs.list.removeEventListener("click", onListClick)
      refs.list.removeEventListener("focusin", onListFocusIn)
      refs.search.removeEventListener("input", onSearchInput)
      refs.back.removeEventListener("click", onBackClick)
      container.replaceChildren()
    },
  }
}
