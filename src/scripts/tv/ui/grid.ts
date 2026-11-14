// Row-windowed poster grid for the TV movies/series views. Only mounts the rows near the
// focused one; ArrowUp/Down/PageUp/PageDown/Home/End are intercepted so the D-pad can reach
// rows spatial-nav can't yet see in the DOM.

import { rowWindow, rowOf } from "@/scripts/lib/tv-grid-filter"
import { releaseCachedImages } from "@/scripts/lib/img-cache.ts"
import {
  registerFocusSection,
  keepFocusedInView,
  resetKeepInView,
  remPx,
  refreshKeepInView,
  invalidateKeepInViewLayout,
} from "@/scripts/tv/focus"
import { motionAllowed, startViewTransitionSafe, TV_EASE, heavyEffectsAllowed, memoryConservative } from "@/scripts/tv/motion"
import { createKeyRepeatCoalescer } from "@/scripts/lib/key-repeat-coalescer"
import { createCard, keepCardMediaDecoded, registerCardLongPress, type PosterCardItem } from "./card"

const OVERSCAN_ROWS_FULL = 2
// Lite keeps only the visible rows mounted - no extra rows held resident off-screen.
const OVERSCAN_ROWS_LITE = 0
// 6 columns at the 960x540 design canvas, so a row is short enough to leave the next one peeking.
const CARD_WIDTH_REM = 7.25
const ROW_GAP_REM = 1 // gap-4
const FALLBACK_ROW_HEIGHT_REM = 16
const MIN_COLUMNS = 4
const SKELETON_COUNT = 18
const SCROLL_OFFSET_REM = 1.5
const MAX_NAMED_TRANSITIONS = 48
// Each named element is its own snapshot texture; lite keeps only the root crossfade.
const MAX_NAMED_TRANSITIONS_LITE = 0

export interface GridOptions {
  focusSectionId: string
  railId: string
  columns?: number
  emptyMessage?: string
  /** Fires once per mounted card - callers that need to decorate cards (e.g. language chips)
   * hook this instead of running a MutationObserver over the whole grid subtree. */
  onCardMounted?(cardEl: HTMLElement): void
}

/** Card items are built per mounted row, so a 20k-row catalog never materializes 20k of them. */
export interface GridSource {
  count: number
  itemAt(index: number): PosterCardItem
  /** Cheap `${kind}:${id}` lookup for reuse/reconcile; falls back to itemAt(index) when absent. */
  keyAt?(index: number): string
}

export interface GridSetEntriesOptions {
  /** false skips the View Transition entirely - used by prepaint, which must never animate. */
  animate?: boolean
}

export interface GridHandle {
  el: HTMLElement
  setLoading(): void
  setEntries(source: GridSource, emptyMessage?: string, options?: GridSetEntriesOptions): void
  destroy(): void
}

export const EMPTY_GRID_SOURCE: GridSource = { count: 0, itemAt: () => ({}) as PosterCardItem }

function buildSkeletonCard(): HTMLDivElement {
  const skeleton = document.createElement("div")
  skeleton.className = "skel aspect-[2/3] w-full rounded-xl"
  return skeleton
}

function entryKeyOf(source: GridSource, index: number): string {
  if (source.keyAt) return source.keyAt(index)
  const item = source.itemAt(index)
  return `${item.kind}:${item.id}`
}

// key -> index, built once per GridSource identity and shared by nameSurvivorCards/findIndexByKey.
const sourceKeyIndexCache = new WeakMap<GridSource, Map<string, number>>()

function cardSignatureOf(item: PosterCardItem): string {
  return [item.href, item.name, item.meta, item.posterUrl ?? "", item.progressPercent ?? ""].join("")
}

function sanitizeViewTransitionName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "-")
}

let viewTransitionStyleInjected = false

function ensureViewTransitionStyle(): void {
  if (viewTransitionStyleInjected || typeof document === "undefined") return
  viewTransitionStyleInjected = true
  const style = document.createElement("style")
  style.textContent = `
::view-transition-group(*) { animation-duration: 320ms; animation-timing-function: ${TV_EASE}; }
::view-transition-old(*), ::view-transition-new(*) { animation-duration: 200ms; animation-timing-function: ${TV_EASE}; }
`
  document.head.appendChild(style)
}

export function createGrid(options: GridOptions): GridHandle {
  ensureViewTransitionStyle()

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
  // One delegated long-press listener set for the whole track instead of one per card.
  const cardLongPress = registerCardLongPress(track)

  let source: GridSource = EMPTY_GRID_SOURCE
  const fixedColumns = options.columns || 0
  let columns = fixedColumns || 6
  let rowHeightPx = remPx(FALLBACK_ROW_HEIGHT_REM)
  let rowHeightMeasured = false
  let rowHeightMeasurePending = false
  let focusedRow = 0
  let lastFocusedIndex: number | null = null
  const mountedRows = new Map<number, HTMLElement>()

  // Measured on demand and refreshed before a render pass, so the View Transition callback
  // (which must run and settle in one frame) never forces a synchronous layout read itself.
  let cachedFocusPadPx = 0
  let cachedScrollerHeight = 0

  function measureLayoutMetrics(): void {
    cachedFocusPadPx = parseFloat(getComputedStyle(scroller).paddingTop) || 0
    cachedScrollerHeight = scroller.clientHeight
  }
  measureLayoutMetrics()

  function focusPadPx(): number {
    return cachedFocusPadPx
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

  function measureRowHeightNow(force: boolean): void {
    if (rowHeightMeasured && !force) return
    const firstCard = track.querySelector<HTMLElement>("[data-grid-index]")
    if (!firstCard) return
    rowHeightMeasured = true
    const measured = firstCard.offsetHeight + remPx(ROW_GAP_REM)
    if (measured > 0 && measured !== rowHeightPx) {
      rowHeightPx = measured
      setTrackHeight()
      repositionMountedRows()
      // Anchors by focused row, not DOM focus, which may sit outside the grid.
      refreshKeepInView(scroller, mountedRows.get(focusedRow) ?? null)
    }
  }

  // Deferred to a rAF so the layout read never lands in the same task as the row mount.
  function scheduleRowHeightMeasure(force = false): void {
    if (rowHeightMeasured && !force) return
    if (rowHeightMeasurePending) return
    rowHeightMeasurePending = true
    requestAnimationFrame(() => {
      rowHeightMeasurePending = false
      measureRowHeightNow(force)
    })
  }

  function buildRow(rowIndex: number, reusePool?: Map<string, HTMLElement>): HTMLElement {
    const rowEl = document.createElement("div")
    rowEl.className = "absolute inset-x-0 grid gap-4"
    rowEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
    rowEl.style.top = `${rowIndex * rowHeightPx}px`
    rowEl.dataset.gridRow = String(rowIndex)
    const start = rowIndex * columns
    const end = Math.min(source.count, start + columns)
    for (let index = start; index < end; index++) {
      const item = source.itemAt(index)
      const key = source.keyAt ? source.keyAt(index) : `${item.kind}:${item.id}`
      const signature = cardSignatureOf(item)
      const reused = reusePool?.get(key)
      let card: HTMLElement
      if (reused && reused.dataset.cardSignature === signature) {
        card = reused
        reusePool!.delete(key)
        // Detaching/reattaching a lazy <img> re-queues its load/decode; force it to repaint now.
        keepCardMediaDecoded(card)
      } else {
        card = createCard(item, { fill: true }) as HTMLElement
        card.dataset.entryKey = key
        card.dataset.cardSignature = signature
      }
      card.dataset.gridIndex = String(index)
      rowEl.appendChild(card)
      options.onCardMounted?.(card)
    }
    return rowEl
  }

  function visibleRowCount(): number {
    const availableHeight = (cachedScrollerHeight || rowHeightPx) - focusPadPx() * 2
    return Math.max(1, Math.ceil(availableHeight / rowHeightPx))
  }

  function mountRow(rowIndex: number, reusePool?: Map<string, HTMLElement>): void {
    if (mountedRows.has(rowIndex)) return
    const rowEl = buildRow(rowIndex, reusePool)
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

  function renderWindow(reusePool?: Map<string, HTMLElement>): void {
    const rows = totalRows()
    const overscanRows = memoryConservative() ? OVERSCAN_ROWS_LITE : OVERSCAN_ROWS_FULL
    const { start, end } = rowWindow(rows, focusedRow, visibleRowCount(), overscanRows)
    for (let rowIndex = start; rowIndex < end; rowIndex++) mountRow(rowIndex, reusePool)
    pruneRowsOutsideWindow(start, end)
    scheduleRowHeightMeasure()
  }

  function focusIndex(index: number, reusePool?: Map<string, HTMLElement>): void {
    if (!source.count) return
    const clamped = Math.max(0, Math.min(source.count - 1, index))
    const targetRow = rowOf(clamped, columns)
    focusedRow = targetRow
    mountRow(targetRow, reusePool)
    const target = track.querySelector<HTMLElement>(`[data-grid-index="${clamped}"]`)
    target?.focus()
    if (target) lastFocusedIndex = clamped
    renderWindow(reusePool)
  }

  function currentFocusedIndex(): number | null {
    const active = document.activeElement
    const cardEl = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-grid-index]") : null
    const indexStr = cardEl?.dataset.gridIndex
    if (indexStr == null) return null
    const index = Number(indexStr)
    return Number.isFinite(index) ? index : null
  }

  // Built once per source (cached by object identity) so a 180k-row catalog is scanned a
  // single time per reconcile pass instead of once per findIndexByKey/nameSurvivorCards call.
  function keyIndexMapFor(targetSource: GridSource): Map<string, number> {
    let map = sourceKeyIndexCache.get(targetSource)
    if (map) return map
    map = new Map()
    for (let index = 0; index < targetSource.count; index++) map.set(entryKeyOf(targetSource, index), index)
    sourceKeyIndexCache.set(targetSource, map)
    return map
  }

  function findIndexByKey(targetSource: GridSource, key: string, _nearIndex: number): number | null {
    if (targetSource.count <= 0) return null
    return keyIndexMapFor(targetSource).get(key) ?? null
  }

  // Accumulates same-burst key-repeat moves so a held Down/PageDown only touches the DOM
  // once per frame instead of once per keydown; the callback re-reads the DOM index at
  // flush time since it may differ from what was on screen when the burst started.
  const keyRepeat = createKeyRepeatCoalescer((delta) => {
    if (!source.count) return
    const domIndex = currentFocusedIndex() ?? lastFocusedIndex ?? 0
    focusIndex(Math.max(0, Math.min(source.count - 1, domIndex + delta)))
  })

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
    const domIndex = currentFocusedIndex() ?? lastFocusedIndex
    if (domIndex == null || !source.count) return
    // Projects where focus is headed once every already-queued move in this burst applies,
    // so a fast repeat keeps computing the next step from there instead of the stale DOM index.
    const projected = Math.max(0, Math.min(source.count - 1, domIndex + keyRepeat.pending()))
    const pageSize = columns * visibleRowCount()
    let next = projected
    switch (event.key) {
      case "ArrowDown":
        next = projected + columns
        break
      case "ArrowUp":
        next = projected - columns
        break
      case "PageDown":
        next = projected + pageSize
        break
      case "PageUp":
        next = projected - pageSize
        break
      case "Home":
        next = 0
        break
      case "End":
        next = source.count - 1
        break
    }
    next = Math.max(0, Math.min(source.count - 1, next))
    if (next === projected) return
    // Bail so spatial nav can move focus out of the grid at this edge.
    const isRowMove = event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "PageDown" || event.key === "PageUp"
    if (isRowMove && rowOf(next, columns) === rowOf(projected, columns)) return
    event.preventDefault()
    event.stopPropagation()
    keyRepeat.push(next - projected)
  }
  scroller.addEventListener("keydown", onKeyDown, true)

  // Capture-phase, ahead of registerCardLongPress's bubble-phase Enter handler on the
  // track, so a burst's still-batched move is on screen before Enter/long-press reads it.
  function onEnterKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return
    keyRepeat.flush()
  }
  scroller.addEventListener("keydown", onEnterKeyDown, true)

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

  // Pulls every currently attached card out of its row (without releasing its image)
  // so a reslot/reconcile pass can reuse the ones whose entry survives.
  function detachReusableCards(): Map<string, HTMLElement> {
    const pool = new Map<string, HTMLElement>()
    for (const [rowIndex, rowEl] of Array.from(mountedRows)) {
      for (const card of Array.from(rowEl.children) as HTMLElement[]) {
        const key = card.dataset.entryKey
        if (key) pool.set(key, card)
      }
      rowEl.remove()
      mountedRows.delete(rowIndex)
    }
    return pool
  }

  function releasePool(pool: Map<string, HTMLElement>): void {
    for (const card of pool.values()) releaseCachedImages(card)
    pool.clear()
  }

  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver === "function") {
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        measureLayoutMetrics()
        invalidateKeepInViewLayout(scroller)
        if (!source.count) return
        const nextColumns = computeColumns()
        // Cards fill the row width, so even an unchanged column count needs a
        // row-height remeasure - the container width (and thus card height) moved.
        if (nextColumns === columns) {
          scheduleRowHeightMeasure(true)
          return
        }
        const focusedIndex = currentFocusedIndex()
        columns = nextColumns
        const reusePool = detachReusableCards()
        rowHeightMeasured = false
        setTrackHeight()
        if (focusedIndex != null) {
          focusIndex(Math.max(0, Math.min(source.count - 1, focusedIndex)), reusePool)
        } else {
          focusedRow = 0
          renderWindow(reusePool)
        }
        releasePool(reusePool)
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

  // Names the mounted cards that survive into `nextSource` so the view transition can
  // slide them to their new slot instead of cross-fading; capped so a huge reflow just
  // falls back to a plain fade for anything beyond the cap.
  function nameSurvivorCards(nextSource: GridSource): HTMLElement[] {
    const cap = heavyEffectsAllowed() ? MAX_NAMED_TRANSITIONS : MAX_NAMED_TRANSITIONS_LITE
    if (cap <= 0 || !motionAllowed() || !mountedRows.size) return []
    const survivorIndexByKey = keyIndexMapFor(nextSource)

    const named: HTMLElement[] = []
    for (const rowEl of mountedRows.values()) {
      for (const card of Array.from(rowEl.children) as HTMLElement[]) {
        if (named.length >= cap) return named
        const key = card.dataset.entryKey
        if (!key || !survivorIndexByKey.has(key)) continue
        card.style.viewTransitionName = `tv-card-${sanitizeViewTransitionName(key)}`
        named.push(card)
      }
    }
    return named
  }

  function clearViewTransitionNames(cards: HTMLElement[]): void {
    for (const card of cards) card.style.viewTransitionName = ""
  }

  function applyEntries(
    nextSource: GridSource,
    emptyMessage: string | undefined,
    heldFocus: boolean,
    previousIndex: number | null,
    previousKey: string | null
  ): void {
    const reusePool = detachReusableCards()
    // Rows are re-laid out from the top, so a leftover offset would hide row 0.
    resetKeepInView(scroller)
    source = nextSource
    columns = computeColumns()
    lastFocusedIndex = source.count ? 0 : null
    rowHeightMeasured = false

    if (!source.count) {
      releasePool(reusePool)
      releaseCachedImages(track)
      track.replaceChildren()
      focusedRow = 0
      renderEmpty(emptyMessage)
      return
    }

    resetTrackForRows()
    // setLoading()'s skeleton tiles are flow children, never tracked in mountedRows,
    // so detachReusableCards() above leaves them behind under the absolute row layout.
    track.replaceChildren()
    setTrackHeight()

    let restoreIndex: number | null = null
    if (heldFocus) {
      const survivorIndex = previousKey ? findIndexByKey(source, previousKey, previousIndex ?? 0) : null
      restoreIndex = Math.max(0, Math.min(source.count - 1, survivorIndex ?? previousIndex ?? 0))
      focusedRow = rowOf(restoreIndex, columns)
    } else {
      focusedRow = 0
    }

    renderWindow(reusePool)
    releasePool(reusePool)

    const firstCard = track.querySelector<HTMLElement>("[data-grid-index]")
    if (firstCard) firstCard.dataset.tvAutofocus = ""
    window.SpatialNavigation?.makeFocusable?.(options.focusSectionId)
    // The rebuild just dropped the focused card to <body>; put focus back where it was.
    if (heldFocus && restoreIndex != null) focusIndex(restoreIndex)
  }

  async function performSetEntries(nextSource: GridSource, emptyMessage: string | undefined, animate: boolean): Promise<void> {
    const heldFocus = scroller.contains(document.activeElement)
    const previousIndex = currentFocusedIndex()
    const previousKey = previousIndex != null && source.count ? entryKeyOf(source, previousIndex) : null
    // Measured now, outside any View Transition callback, so the callback itself never
    // forces a synchronous layout read while the browser is mid-capture.
    measureLayoutMetrics()

    if (!animate || !heavyEffectsAllowed()) {
      applyEntries(nextSource, emptyMessage, heldFocus, previousIndex, previousKey)
      return
    }

    const namedCards = nameSurvivorCards(nextSource)
    await startViewTransitionSafe(() => {
      applyEntries(nextSource, emptyMessage, heldFocus, previousIndex, previousKey)
    })
    clearViewTransitionNames(namedCards)
  }

  function setEntries(nextSource: GridSource, emptyMessage?: string, options?: GridSetEntriesOptions): void {
    void performSetEntries(nextSource, emptyMessage, options?.animate ?? true)
  }

  function destroy(): void {
    clearMountedRows()
    resizeObserver?.disconnect()
    keyRepeat.cancel()
    scroller.removeEventListener("keydown", onKeyDown, true)
    scroller.removeEventListener("keydown", onEnterKeyDown, true)
    scroller.removeEventListener("focusin", onFocusIn)
    cardLongPress.destroy()
    unregisterSection()
    unregisterKeepInView()
    el.remove()
  }

  return { el, setLoading, setEntries, destroy }
}
