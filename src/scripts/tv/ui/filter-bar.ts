// TV filter chip row (category / sort / hide-watched / search) shared by the movies and series grid views.

import { debounce } from "@/scripts/lib/debounce.ts"
import { registerFocusSection } from "@/scripts/tv/focus"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav"
import { ICON_CHEVRON_DOWN, ICON_CHECK, ICON_SEARCH } from "@/scripts/lib/icons"

const QUERY_DEBOUNCE_MS = 150

const CHIP_CLASS =
  "flex h-[3.25rem] items-center gap-2 rounded-full bg-surface-2 px-5 text-sm font-medium text-fg outline-none " +
  "transition-transform focus-visible:ring-4 focus-visible:ring-accent focus-visible:ring-offset-4 " +
  "focus-visible:ring-offset-bg focus-visible:scale-[1.04]"

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

function ensureOptionsDialog(): HTMLDialogElement {
  if (optionsDialog) return optionsDialog
  const dialog = document.createElement("dialog")
  dialog.id = "tv-filter-options-dialog"
  dialog.className =
    "m-auto max-h-[70vh] w-[26rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70"
  dialog.innerHTML =
    '<div class="border-b border-line px-6 py-4"><h2 id="tv-filter-options-title" class="text-lg font-semibold"></h2></div>' +
    '<div id="tv-filter-options-list" class="flex max-h-[55vh] flex-col overflow-y-auto p-[var(--tv-focus-pad)]"></div>'
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

/** Shared TV-sized list dialog for the category / sort chips. */
export function openTvOptionsDialog(params: OpenOptionsDialogParams): void {
  const dialog = ensureOptionsDialog()
  const titleEl = dialog.querySelector<HTMLElement>("#tv-filter-options-title")
  const listEl = dialog.querySelector<HTMLElement>("#tv-filter-options-list")
  if (titleEl) titleEl.textContent = params.title
  if (listEl) {
    listEl.replaceChildren()
    for (const option of params.options) {
      const isSelected = option.value === params.selectedValue
      const row = document.createElement("button")
      row.type = "button"
      row.dataset.focusKey = `tv-filter-option:${option.value}`
      row.className =
        "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none " +
        "hover:bg-surface-2 focus-visible:bg-surface-2 " +
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
        params.onSelect(option.value)
        dialog.close()
      })
      listEl.appendChild(row)
    }
  }
  if (typeof dialog.showModal === "function") dialog.showModal()
  window.SpatialNavigation?.makeFocusable?.()
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
  hideWatchedChip.className = CHIP_CLASS
  const hideWatchedCheck = document.createElement("span")
  hideWatchedCheck.className = "shrink-0 text-accent opacity-0 transition-opacity"
  hideWatchedCheck.innerHTML = ICON_CHECK
  const hideWatchedLabelEl = document.createElement("span")
  hideWatchedLabelEl.textContent = options.hideWatchedLabel
  hideWatchedChip.append(hideWatchedCheck, hideWatchedLabelEl)
  hideWatchedChip.addEventListener("click", () => options.onToggleHideWatched())

  const searchWrap = document.createElement("label")
  searchWrap.className = `${CHIP_CLASS} min-w-[16rem] flex-1 cursor-text`
  const searchIcon = document.createElement("span")
  searchIcon.className = "shrink-0 text-fg-3"
  searchIcon.innerHTML = ICON_SEARCH
  const searchInput = document.createElement("input")
  searchInput.type = "search"
  searchInput.dataset.focusKey = "filter:query"
  searchInput.className = "w-full bg-transparent text-fg outline-none placeholder:text-fg-3"
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
    hideWatchedCheck.style.opacity = state.hideWatched ? "1" : "0"
    if (state.query != null && searchInput.value !== state.query) searchInput.value = state.query
  }

  function destroy(): void {
    unregisterSection()
    el.remove()
  }

  return { el, setState, destroy }
}
