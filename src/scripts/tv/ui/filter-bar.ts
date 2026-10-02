// TV filter chip row (category / sort / hide-watched / search) shared by the movies and series grid views.

import { debounce } from "@/scripts/lib/debounce.ts"
import { registerFocusSection, keepFocusedInView } from "@/scripts/tv/focus"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav"
import { createVirtualRows, type VirtualRowsHandle } from "@/scripts/tv/ui/virtual-rows"
import { ICON_CHEVRON_DOWN, ICON_CHECK, ICON_SEARCH } from "@/scripts/lib/icons"

const QUERY_DEBOUNCE_MS = 150
// Above this count the option list mounts only the rows near the focused one - a 2000-category
// playlist would otherwise build 2000 buttons up front just to open the dialog.
const OPTIONS_VIRTUALIZE_THRESHOLD = 60
const OPTIONS_ROW_HEIGHT_PX = 44

const CHIP_BASE_CLASS =
  "flex min-h-10 items-center gap-2 rounded-full px-4 text-sm font-medium outline-none tv-focus-inset"
const CHIP_CLASS = `${CHIP_BASE_CLASS} bg-surface-2 text-fg`
const HIDE_WATCHED_OFF_CLASS = `${CHIP_BASE_CLASS} border border-line text-fg-2`
const HIDE_WATCHED_ON_CLASS = `${CHIP_BASE_CLASS} border border-accent bg-accent/15 text-accent`

export interface FilterOption {
  value: string
  label: string
  count?: number | null
}

export interface FilterBarState {
  hideWatched: boolean
  query?: string
}

export interface FilterBarLabels {
  categoryLabel: string
  sortLabel: string
}

export interface FilterBarOptions {
  focusSectionId: string
  hideWatchedLabel: string
  searchPlaceholder?: string
  onCategory(): void
  onSort(): void
  onToggleHideWatched(): void
  onQuery(text: string): void
}

export interface FilterBarHandle {
  el: HTMLElement
  setState(state: FilterBarState, labels: FilterBarLabels): void
  destroy(): void
}

let optionsDialog: HTMLDialogElement | null = null
// Reused across every open() call so keepFocusedInView's captured track reference (read once,
// at first registration) never goes stale.
let virtualTrack: HTMLElement | null = null
let virtualTrackKeepInViewRegistered = false
let optionsVirtualRows: VirtualRowsHandle<FilterOption> | null = null

function ensureOptionsDialog(): HTMLDialogElement {
  if (optionsDialog?.isConnected) return optionsDialog
  const dialog = document.createElement("dialog")
  dialog.id = "tv-filter-options-dialog"
  dialog.className =
    "m-auto max-h-[70vh] w-[26rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70"
  dialog.innerHTML =
    '<div class="border-b border-line px-6 py-4"><h2 id="tv-filter-options-title" class="text-lg font-semibold"></h2></div>' +
    '<div id="tv-filter-options-list" class="flex max-h-[55vh] flex-col overflow-y-auto p-2"></div>'
  document.body.appendChild(dialog)
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close()
  })
  attachDialogSpatialNav(dialog)
  optionsDialog = dialog
  return dialog
}

export interface OpenOptionsDialogParams {
  title: string
  options: FilterOption[]
  selectedValue: string
  onSelect(value: string): void
}

function buildOptionRow(
  option: FilterOption,
  selectedValue: string,
  onSelect: (value: string) => void,
  dialog: HTMLDialogElement
): HTMLElement {
  const isSelected = option.value === selectedValue
  const row = document.createElement("button")
  row.type = "button"
  row.dataset.focusKey = `tv-filter-option:${option.value}`
  row.className =
    "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none " +
    "hover:bg-surface-2 tv-focus-inset " +
    (isSelected ? "text-accent" : "text-fg")

  const left = document.createElement("span")
  left.className = "truncate"
  left.textContent = option.label
  row.appendChild(left)

  const right = document.createElement("span")
  right.className = "flex shrink-0 items-center gap-2"
  if (option.count != null) {
    const count = document.createElement("span")
    count.className = "text-xs text-fg-3 tabular-nums"
    count.textContent = String(option.count)
    right.appendChild(count)
  }
  if (isSelected) {
    const check = document.createElement("span")
    check.className = "text-accent"
    check.innerHTML = ICON_CHECK
    right.appendChild(check)
    row.dataset.tvAutofocus = ""
  }
  row.appendChild(right)

  row.addEventListener("click", () => {
    onSelect(option.value)
    dialog.close()
  })
  return row
}

// Lazily creates the persistent virtualized-list track and registers its scroll-into-view
// behavior exactly once: keepFocusedInView reads `scroller.firstElementChild` at call time,
// so the same track node must keep being reinstalled as that first child on every later open.
function ensureVirtualTrack(listEl: HTMLElement): HTMLElement {
  if (!virtualTrack) {
    virtualTrack = document.createElement("div")
    virtualTrack.className = "relative"
  }
  if (listEl.firstElementChild !== virtualTrack) listEl.replaceChildren(virtualTrack)
  if (!virtualTrackKeepInViewRegistered) {
    keepFocusedInView(listEl, "y", 0)
    virtualTrackKeepInViewRegistered = true
  }
  return virtualTrack
}

/** Shared TV-sized list dialog for the category / sort chips. */
export function openTvOptionsDialog(params: OpenOptionsDialogParams): void {
  const dialog = ensureOptionsDialog()
  const titleEl = dialog.querySelector<HTMLElement>("#tv-filter-options-title")
  const listEl = dialog.querySelector<HTMLElement>("#tv-filter-options-list")
  if (titleEl) titleEl.textContent = params.title

  optionsVirtualRows?.destroy()
  optionsVirtualRows = null

  if (listEl) {
    if (params.options.length > OPTIONS_VIRTUALIZE_THRESHOLD) {
      const track = ensureVirtualTrack(listEl)
      const selectedIndex = Math.max(
        0,
        params.options.findIndex((option) => option.value === params.selectedValue)
      )
      const virtualRows = createVirtualRows<FilterOption>({
        scroller: listEl,
        track,
        fallbackRowHeightPx: OPTIONS_ROW_HEIGHT_PX,
        keyOf: (option) => option.value,
        buildRow: (option) => buildOptionRow(option, params.selectedValue, params.onSelect, dialog),
      })
      optionsVirtualRows = virtualRows
      virtualRows.setItems(params.options, selectedIndex)
    } else {
      listEl.replaceChildren()
      for (const option of params.options) {
        listEl.appendChild(buildOptionRow(option, params.selectedValue, params.onSelect, dialog))
      }
    }
  }
  if (typeof dialog.showModal === "function") dialog.showModal()
  // attachDialogSpatialNav (ensureOptionsDialog) registers this section id from the dialog's id.
  window.SpatialNavigation?.makeFocusable?.("tv-filter-options-dialog-section")
}

export function createFilterBar(options: FilterBarOptions): FilterBarHandle {
  const el = document.createElement("div")
  el.className = "flex flex-wrap items-center gap-3"

  const categoryChip = document.createElement("button")
  categoryChip.type = "button"
  categoryChip.dataset.focusKey = "filter:category"
  categoryChip.className = CHIP_CLASS
  const categoryLabelEl = document.createElement("span")
  categoryLabelEl.className = "max-w-[12rem] truncate"
  const categoryChevron = document.createElement("span")
  categoryChevron.className = "shrink-0 text-fg-3"
  categoryChevron.innerHTML = ICON_CHEVRON_DOWN
  categoryChip.append(categoryLabelEl, categoryChevron)
  categoryChip.addEventListener("click", () => options.onCategory())

  const sortChip = document.createElement("button")
  sortChip.type = "button"
  sortChip.dataset.focusKey = "filter:sort"
  sortChip.className = CHIP_CLASS
  const sortLabelEl = document.createElement("span")
  sortLabelEl.className = "max-w-[10rem] truncate"
  const sortChevron = document.createElement("span")
  sortChevron.className = "shrink-0 text-fg-3"
  sortChevron.innerHTML = ICON_CHEVRON_DOWN
  sortChip.append(sortLabelEl, sortChevron)
  sortChip.addEventListener("click", () => options.onSort())

  const hideWatchedChip = document.createElement("button")
  hideWatchedChip.type = "button"
  hideWatchedChip.dataset.focusKey = "filter:hideWatched"
  hideWatchedChip.setAttribute("role", "checkbox")
  hideWatchedChip.className = HIDE_WATCHED_OFF_CLASS
  const hideWatchedLabelEl = document.createElement("span")
  hideWatchedLabelEl.textContent = options.hideWatchedLabel
  hideWatchedChip.append(hideWatchedLabelEl)
  hideWatchedChip.addEventListener("click", () => options.onToggleHideWatched())

  const searchWrap = document.createElement("label")
  searchWrap.className =
    "flex min-h-10 min-w-[14rem] flex-1 cursor-text items-center gap-2 rounded-full bg-surface-2 px-4 tv-focus-inset-within"
  const searchIcon = document.createElement("span")
  searchIcon.className = "shrink-0 text-fg-3"
  searchIcon.innerHTML = ICON_SEARCH
  const searchInput = document.createElement("input")
  searchInput.type = "search"
  searchInput.dataset.focusKey = "filter:query"
  searchInput.className = "h-full w-full rounded-full bg-transparent text-fg outline-none placeholder:text-fg-3"
  if (options.searchPlaceholder) searchInput.placeholder = options.searchPlaceholder
  searchWrap.append(searchIcon, searchInput)

  const debouncedQuery = debounce((value: string) => options.onQuery(value), QUERY_DEBOUNCE_MS)
  searchInput.addEventListener("input", () => debouncedQuery(searchInput.value))

  el.append(categoryChip, sortChip, hideWatchedChip, searchWrap)

  const unregisterSection = registerFocusSection(options.focusSectionId, el, {
    enterTo: "last-focused",
    restrict: "self-first",
  })

  function setState(state: FilterBarState, labels: FilterBarLabels): void {
    categoryLabelEl.textContent = labels.categoryLabel
    sortLabelEl.textContent = labels.sortLabel
    hideWatchedChip.setAttribute("aria-checked", String(state.hideWatched))
    hideWatchedChip.setAttribute("aria-pressed", String(state.hideWatched))
    hideWatchedChip.className = state.hideWatched ? HIDE_WATCHED_ON_CLASS : HIDE_WATCHED_OFF_CLASS
    const existingCheck = hideWatchedChip.querySelector("[data-role=check]")
    if (state.hideWatched && !existingCheck) {
      const check = document.createElement("span")
      check.dataset.role = "check"
      check.className = "shrink-0"
      check.innerHTML = ICON_CHECK
      hideWatchedChip.prepend(check)
    } else if (!state.hideWatched && existingCheck) {
      existingCheck.remove()
    }
    if (state.query != null && searchInput.value !== state.query) searchInput.value = state.query
  }

  function destroy(): void {
    unregisterSection()
    el.remove()
  }

  return { el, setState, destroy }
}
