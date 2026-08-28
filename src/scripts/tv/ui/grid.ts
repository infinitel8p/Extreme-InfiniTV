// Row-windowed poster grid for the TV movies/series views. Only mounts the rows near the
// focused one; ArrowUp/Down/PageUp/PageDown/Home/End are intercepted so the D-pad can reach
// rows spatial-nav can't yet see in the DOM.

import { rowWindow, rowOf } from "@/scripts/lib/tv-grid-filter"
import { releaseCachedImages } from "@/scripts/lib/img-cache.ts"
import { registerFocusSection, keepFocusedInView, resetKeepInView, remPx } from "@/scripts/tv/focus"
import { createCard, type PosterCardItem } from "./card"

const OVERSCAN_ROWS = 2
const CARD_WIDTH_REM = 9.5
const ROW_GAP_REM = 1 // gap-4
const FALLBACK_ROW_HEIGHT_REM = 18.5
const MIN_COLUMNS = 4
const SKELETON_COUNT = 18
const SCROLL_OFFSET_REM = 1.5

export interface GridOptions {
  focusSectionId: string
  railId: string
  columns?: number
  emptyMessage?: string
}

/** Card items are built per mounted row, so a 20k-row catalog never materializes 20k of them. */
export interface GridSource {
  count: number
  itemAt(index: number): PosterCardItem
}

export interface GridHandle {
  el: HTMLElement
  setLoading(): void
  setEntries(source: GridSource, emptyMessage?: string): void
  destroy(): void
}

export const EMPTY_GRID_SOURCE: GridSource = { count: 0, itemAt: () => ({}) as PosterCardItem }

function buildSkeletonCard(): HTMLDivElement {
  const skeleton = document.createElement("div")
  skeleton.className = "skel aspect-[2/3] w-full rounded-xl"
  return skeleton
}

export function createGrid(options: GridOptions): GridHandle {
  const el = document.createElement("div")
  el.className = "min-h-0 flex-1"

  const scroller = document.createElement("div")
  scroller.className = "relative h-full overflow-hidden p-[var(--tv-focus-pad)] -mx-[var(--tv-focus-pad)]"
  const track = document.createElement("div")
  track.className = "relative"
  scroller.appendChild(track)
  el.appendChild(scroller)

  const unregisterSection = registerFocusSection(options.focusSectionId, scroller, {
    enterTo: "last-focused",
    restrict: "self-first",
  })
  const unregisterKeepInView = keepFocusedInView(scroller, "y", () => remPx(SCROLL_OFFSET_REM))

  let source: GridSource = EMPTY_GRID_SOURCE
  const fixedColumns = options.columns || 0
  let columns = fixedColumns || 6
  let rowHeightPx = remPx(FALLBACK_ROW_HEIGHT_REM)
  let rowHeightMeasured = false
  let focusedRow = 0
  let lastFocusedIndex: number | null = null
  const mountedRows = new Map<number, HTMLElement>()

  function focusPadPx(): number {
    return parseFloat(getComputedStyle(scroller).paddingTop) || 0
  }

  function computeColumns(): number {
    if (fixedColumns) return fixedColumns
    // el, not scroller: scroller's own width is inflated by the focus-pad negative margin.
    const width = el.clientWidth || 0
    if (!width) return columns
    return Math.max(MIN_COLUMNS, Math.floor(width / (remPx(CARD_WIDTH_REM) + remPx(ROW_GAP_REM))))
  }

  function totalRows(): number {
    return columns > 0 ? Math.ceil(source.count / columns) : 0
  }

  function setTrackHeight(): void {
    track.style.height = `${totalRows() * rowHeightPx}px`
  }

  function repositionMountedRows(): void {
    for (const [rowIndex, rowEl] of mountedRows) rowEl.style.top = `${rowIndex * rowHeightPx}px`
  }

  function measureRowHeight(force = false): void {
    if (rowHeightMeasured && !force) return
    const firstCard = track.querySelector<HTMLElement>("[data-grid-index]")
    if (!firstCard) return
    rowHeightMeasured = true
    const measured = firstCard.offsetHeight + remPx(ROW_GAP_REM)
    if (measured > 0 && measured !== rowHeightPx) {
      rowHeightPx = measured
      setTrackHeight()
      repositionMountedRows()
    }
  }

  function buildRow(rowIndex: number): HTMLElement {
    const rowEl = document.createElement("div")
    rowEl.className = "absolute inset-x-0 grid gap-4"
    rowEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
    rowEl.style.top = `${rowIndex * rowHeightPx}px`
    rowEl.dataset.gridRow = String(rowIndex)
    const start = rowIndex * columns
    const end = Math.min(source.count, start + columns)
    for (let index = start; index < end; index++) {
      const card = createCard(source.itemAt(index), { fill: true }) as HTMLElement
      card.dataset.gridIndex = String(index)
      rowEl.appendChild(card)
    }
    return rowEl
  }

  function visibleRowCount(): number {
    const availableHeight = (scroller.clientHeight || rowHeightPx) - focusPadPx() * 2
    return Math.max(1, Math.ceil(availableHeight / rowHeightPx))
  }

  function mountRow(rowIndex: number): void {
    if (mountedRows.has(rowIndex)) return
    const rowEl = buildRow(rowIndex)
    track.appendChild(rowEl)
    mountedRows.set(rowIndex, rowEl)
  }

  // Never prunes the row holding document.activeElement, so a key event landing
  // mid-render never finds focus dropped to <body>.
  function pruneRowsOutsideWindow(start: number, end: number): void {
    const activeRowEl =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>("[data-grid-row]")
        : null
    for (const [rowIndex, rowEl] of Array.from(mountedRows)) {
      if (rowIndex >= start && rowIndex < end) continue
      if (rowEl === activeRowEl) continue
      releaseCachedImages(rowEl)
      rowEl.remove()
      mountedRows.delete(rowIndex)
    }
  }

  function renderWindow(): void {
    const rows = totalRows()
    const { start, end } = rowWindow(rows, focusedRow, visibleRowCount(), OVERSCAN_ROWS)
    for (let rowIndex = start; rowIndex < end; rowIndex++) mountRow(rowIndex)
    pruneRowsOutsideWindow(start, end)
    measureRowHeight()
  }

  function focusIndex(index: number): void {
    if (!source.count) return
    const clamped = Math.max(0, Math.min(source.count - 1, index))
    const targetRow = rowOf(clamped, columns)
    focusedRow = targetRow
    mountRow(targetRow)
    const target = track.querySelector<HTMLElement>(`[data-grid-index="${clamped}"]`)
    target?.focus()
    if (target) lastFocusedIndex = clamped
    renderWindow()
  }

  function currentFocusedIndex(): number | null {
    const active = document.activeElement
    const cardEl = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-grid-index]") : null
    const indexStr = cardEl?.dataset.gridIndex
    if (indexStr == null) return null
    const index = Number(indexStr)
    return Number.isFinite(index) ? index : null
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey) return
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "PageDown" &&
      event.key !== "PageUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return
    }
    const currentIndex = currentFocusedIndex() ?? lastFocusedIndex
    if (currentIndex == null || !source.count) return
    const pageSize = columns * visibleRowCount()
    let next = currentIndex
    switch (event.key) {
      case "ArrowDown":
        next = currentIndex + columns
        break
      case "ArrowUp":
        next = currentIndex - columns
        break
      case "PageDown":
        next = currentIndex + pageSize
        break
      case "PageUp":
        next = currentIndex - pageSize
        break
      case "Home":
        next = 0
        break
      case "End":
        next = source.count - 1
        break
    }
    next = Math.max(0, Math.min(source.count - 1, next))
    if (next === currentIndex) return
    event.preventDefault()
    event.stopPropagation()
    focusIndex(next)
  }
  scroller.addEventListener("keydown", onKeyDown, true)

  function onFocusIn(event: FocusEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const cardEl = target.closest<HTMLElement>("[data-grid-index]")
    const indexStr = cardEl?.dataset.gridIndex
    if (indexStr == null) return
    const index = Number(indexStr)
    if (!Number.isFinite(index)) return
    lastFocusedIndex = index
    const row = rowOf(index, columns)
    if (row !== focusedRow) {
      focusedRow = row
      renderWindow()
    }
  }
  scroller.addEventListener("focusin", onFocusIn)

  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver === "function") {
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!source.count) return
        const nextColumns = computeColumns()
        // Cards fill the row width, so even an unchanged column count needs a
        // row-height remeasure - the container width (and thus card height) moved.
        if (nextColumns === columns) {
          measureRowHeight(true)
          return
        }
        const focusedIndex = currentFocusedIndex()
        columns = nextColumns
        clearMountedRows()
        rowHeightMeasured = false
        setTrackHeight()
        if (focusedIndex != null) {
          focusIndex(Math.max(0, Math.min(source.count - 1, focusedIndex)))
        } else {
          focusedRow = 0
          renderWindow()
        }
      }, 120)
    })
    resizeObserver.observe(el)
  }

  function resetTrackForRows(): void {
    track.className = "relative"
    track.style.gridTemplateColumns = ""
  }

  function clearMountedRows(): void {
    mountedRows.forEach((rowEl) => {
      releaseCachedImages(rowEl)
      rowEl.remove()
    })
    mountedRows.clear()
  }

  function setLoading(): void {
    clearMountedRows()
    resetKeepInView(scroller)
    source = EMPTY_GRID_SOURCE
    lastFocusedIndex = null
    resetTrackForRows()
    track.style.height = ""
    track.className = "grid gap-4"
    track.style.gridTemplateColumns = `repeat(${computeColumns()}, minmax(0, 1fr))`
    releaseCachedImages(track)
    track.replaceChildren()
    for (let i = 0; i < SKELETON_COUNT; i++) track.appendChild(buildSkeletonCard())
  }

  function renderEmpty(message?: string): void {
    resetTrackForRows()
    track.style.height = ""
    const empty = document.createElement("div")
    empty.className = "flex h-full items-center justify-center text-center text-fg-3"
    empty.textContent = message || options.emptyMessage || "No results."
    track.appendChild(empty)
  }

  function setEntries(nextSource: GridSource, emptyMessage?: string): void {
    const heldFocus = scroller.contains(document.activeElement)
    const previousIndex = currentFocusedIndex()
    clearMountedRows()
    // Rows are re-laid out from the top, so a leftover offset would hide row 0.
    resetKeepInView(scroller)
    source = nextSource
    columns = computeColumns()
    focusedRow = 0
    lastFocusedIndex = source.count ? 0 : null
    rowHeightMeasured = false

    if (!source.count) {
      releaseCachedImages(track)
      track.replaceChildren()
      renderEmpty(emptyMessage)
      return
    }

    resetTrackForRows()
    // setLoading()'s skeleton tiles are flow children, never tracked in mountedRows,
    // so clearMountedRows() above leaves them behind under the absolute row layout.
    track.replaceChildren()
    setTrackHeight()
    renderWindow()
    const firstCard = track.querySelector<HTMLElement>("[data-grid-index]")
    if (firstCard) firstCard.dataset.tvAutofocus = ""
    window.SpatialNavigation?.makeFocusable?.()
    // The rebuild just dropped the focused card to <body>; put focus back where it was.
    if (heldFocus) focusIndex(previousIndex ?? 0)
  }

  function destroy(): void {
    clearMountedRows()
    resizeObserver?.disconnect()
    scroller.removeEventListener("keydown", onKeyDown, true)
    scroller.removeEventListener("focusin", onFocusIn)
    unregisterSection()
    unregisterKeepInView()
    el.remove()
  }

  return { el, setLoading, setEntries, destroy }
}
