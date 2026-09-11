// Generic absolute-position virtual list: fixed row height, index-window mount/unmount,
// keyed so rows that stay inside the window across a focus move keep their DOM node.
import { rowWindow } from "@/scripts/lib/tv-grid-filter"
import { refreshKeepInView, resetKeepInView, invalidateKeepInViewLayout } from "@/scripts/tv/focus"
import { createKeyRepeatCoalescer } from "@/scripts/lib/key-repeat-coalescer"

export type VirtualRowNavKey = "ArrowDown" | "ArrowUp" | "PageDown" | "PageUp" | "Home" | "End"

const NAV_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"])

/** Clamped next index for a D-pad/keyboard nav key. Pure so it's unit-testable without DOM. */
export function nextRowIndex(current: number, key: VirtualRowNavKey, itemCount: number, pageSize: number): number {
  if (itemCount <= 0) return current
  let next = current
  switch (key) {
    case "ArrowDown":
      next = current + 1
      break
    case "ArrowUp":
      next = current - 1
      break
    case "PageDown":
      next = current + Math.max(1, pageSize)
      break
    case "PageUp":
      next = current - Math.max(1, pageSize)
      break
    case "Home":
      next = 0
      break
    case "End":
      next = itemCount - 1
      break
  }
  return Math.max(0, Math.min(itemCount - 1, next))
}

const INDEX_ATTR = "data-vrow-index"
const DEFAULT_OVERSCAN = 6

export interface VirtualRowsOptions<T> {
  scroller: HTMLElement
  track: HTMLElement
  fallbackRowHeightPx: number
  /** Extra px baked into each row's slot, since absolute positioning drops flex/grid gap. */
  rowGapPx?: number
  overscan?: number
  keyOf(item: T): string
  buildRow(item: T, index: number): HTMLElement
  onRowUnmount?(rowEl: HTMLElement): void
}

export interface VirtualRowsHandle<T> {
  setItems(items: T[], initialIndex?: number): void
  focusIndex(index: number): void
  focusKey(key: string): boolean
  currentFocusedIndex(): number | null
  rowForKey(key: string): HTMLElement | null
  forEachMountedRow(callback: (rowEl: HTMLElement, item: T, index: number) => void): void
  destroy(): void
}

export function createVirtualRows<T>(options: VirtualRowsOptions<T>): VirtualRowsHandle<T> {
  const overscan = options.overscan ?? DEFAULT_OVERSCAN
  let items: T[] = []
  let rowHeightPx = options.fallbackRowHeightPx
  let rowHeightMeasured = false
  let focusedIndex = 0
  let lastFocusedIndex: number | null = null
  const mountedRows = new Map<number, HTMLElement>()

  function setTrackHeight(): void {
    options.track.style.height = `${items.length * rowHeightPx}px`
  }

  function repositionMountedRows(): void {
    for (const [index, rowEl] of mountedRows) rowEl.style.top = `${index * rowHeightPx}px`
  }

  function measureRowHeight(force = false): void {
    if (rowHeightMeasured && !force) return
    // Anchors by focused index, not DOM focus, which may sit outside this list.
    const focusedRow = mountedRows.get(focusedIndex)
    if (!focusedRow) return
    rowHeightMeasured = true
    const measured = focusedRow.getBoundingClientRect().height + (options.rowGapPx ?? 0)
    if (measured > 0 && Math.abs(measured - rowHeightPx) > 0.5) {
      rowHeightPx = measured
      setTrackHeight()
      repositionMountedRows()
      refreshKeepInView(options.scroller, focusedRow)
    }
  }

  function visibleRowCount(): number {
    const available = options.scroller.clientHeight || rowHeightPx
    return Math.max(1, Math.ceil(available / rowHeightPx))
  }

  function mountRow(index: number): void {
    if (mountedRows.has(index)) return
    const rowEl = options.buildRow(items[index], index)
    rowEl.style.position = "absolute"
    rowEl.style.left = "0"
    rowEl.style.right = "0"
    rowEl.style.top = `${index * rowHeightPx}px`
    rowEl.setAttribute(INDEX_ATTR, String(index))
    options.track.appendChild(rowEl)
    mountedRows.set(index, rowEl)
    if (!rowHeightMeasured) requestAnimationFrame(() => measureRowHeight())
  }

  // Never prunes the row holding document.activeElement, so a key event mid-render never loses focus.
  function pruneOutsideWindow(start: number, end: number): void {
    const activeRow =
      document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(`[${INDEX_ATTR}]`) : null
    for (const [index, rowEl] of Array.from(mountedRows)) {
      if (index >= start && index < end) continue
      if (rowEl === activeRow) continue
      options.onRowUnmount?.(rowEl)
      rowEl.remove()
      mountedRows.delete(index)
    }
  }

  function renderWindow(): void {
    const { start, end } = rowWindow(items.length, focusedIndex, visibleRowCount(), overscan)
    for (let index = start; index < end; index++) mountRow(index)
    pruneOutsideWindow(start, end)
  }

  function clearMountedRows(): void {
    for (const rowEl of mountedRows.values()) {
      options.onRowUnmount?.(rowEl)
      rowEl.remove()
    }
    mountedRows.clear()
  }

  function setItems(newItems: T[], initialIndex = 0): void {
    clearMountedRows()
    items = newItems
    resetKeepInView(options.scroller)
    focusedIndex = items.length ? Math.max(0, Math.min(initialIndex, items.length - 1)) : 0
    lastFocusedIndex = items.length ? focusedIndex : null
    setTrackHeight()
    if (items.length) renderWindow()
  }

  function focusIndex(index: number): void {
    if (!items.length) return
    const clamped = Math.max(0, Math.min(items.length - 1, index))
    focusedIndex = clamped
    mountRow(clamped)
    renderWindow()
    const rowEl = mountedRows.get(clamped)
    // rowEl.focus() already fires a synchronous focusin that keepFocusedInView's own
    // listener positions from - a second explicit refreshKeepInView here is redundant.
    rowEl?.focus()
    if (rowEl) lastFocusedIndex = clamped
  }

  function indexForKey(key: string): number {
    return items.findIndex((item) => options.keyOf(item) === key)
  }

  function focusKey(key: string): boolean {
    const index = indexForKey(key)
    if (index < 0) return false
    focusIndex(index)
    return true
  }

  function rowForKey(key: string): HTMLElement | null {
    const index = indexForKey(key)
    return index >= 0 ? (mountedRows.get(index) ?? null) : null
  }

  function currentFocusedIndex(): number | null {
    const active = document.activeElement
    const rowEl = active instanceof HTMLElement ? active.closest<HTMLElement>(`[${INDEX_ATTR}]`) : null
    const raw = rowEl?.getAttribute(INDEX_ATTR)
    if (raw == null) return null
    const index = Number(raw)
    return Number.isFinite(index) ? index : null
  }

  function forEachMountedRow(callback: (rowEl: HTMLElement, item: T, index: number) => void): void {
    for (const [index, rowEl] of mountedRows) callback(rowEl, items[index], index)
  }

  // Accumulates same-burst key-repeat moves so a held Down/PageDown only touches the DOM
  // once per frame instead of once per keydown; see grid.ts's onKeyDown for the same pattern.
  const keyRepeat = createKeyRepeatCoalescer((delta) => {
    if (!items.length) return
    const domIndex = currentFocusedIndex() ?? lastFocusedIndex ?? 0
    focusIndex(Math.max(0, Math.min(items.length - 1, domIndex + delta)))
  })

  function onKeyDown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (!NAV_KEYS.has(event.key)) return
    const domIndex = currentFocusedIndex() ?? lastFocusedIndex
    if (domIndex == null || !items.length) return
    const projected = Math.max(0, Math.min(items.length - 1, domIndex + keyRepeat.pending()))
    const next = nextRowIndex(projected, event.key as VirtualRowNavKey, items.length, visibleRowCount())
    if (next === projected) return
    event.preventDefault()
    event.stopPropagation()
    keyRepeat.push(next - projected)
  }
  options.scroller.addEventListener("keydown", onKeyDown, true)

  // Capture-phase, ahead of any bubble-phase Enter/long-press handler a caller wires on
  // the track, so a burst's still-batched move is on screen before it reads the focused row.
  function onEnterKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return
    keyRepeat.flush()
  }
  options.scroller.addEventListener("keydown", onEnterKeyDown, true)

  function onFocusIn(event: FocusEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const rowEl = target.closest<HTMLElement>(`[${INDEX_ATTR}]`)
    const raw = rowEl?.getAttribute(INDEX_ATTR)
    if (raw == null) return
    const index = Number(raw)
    if (!Number.isFinite(index)) return
    lastFocusedIndex = index
    if (index !== focusedIndex) {
      focusedIndex = index
      renderWindow()
    }
  }
  options.scroller.addEventListener("focusin", onFocusIn)

  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => {
      invalidateKeepInViewLayout(options.scroller)
      if (items.length) measureRowHeight(true)
    })
    resizeObserver.observe(options.scroller)
  }

  function destroy(): void {
    clearMountedRows()
    resizeObserver?.disconnect()
    keyRepeat.cancel()
    options.scroller.removeEventListener("keydown", onKeyDown, true)
    options.scroller.removeEventListener("keydown", onEnterKeyDown, true)
    options.scroller.removeEventListener("focusin", onFocusIn)
  }

  return { setItems, focusIndex, focusKey, currentFocusedIndex, rowForKey, forEachMountedRow, destroy }
}
