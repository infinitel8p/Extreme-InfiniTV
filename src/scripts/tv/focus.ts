// Spatial-nav section helpers for TV views built on top of spatial-navigation.js.

import { motionAllowed } from "@/scripts/tv/motion"
import { clampDragShift, pickAnchorIndex, DRAG_START_THRESHOLD_PX } from "@/scripts/tv/rail-drag"

interface FocusSectionOpts {
  selector?: string
  enterTo?: "last-focused" | "default-element"
  restrict?: "self-only" | "self-first"
  leaveFor?: Record<string, string>
  defaultElement?: string
}

export const NAV_SECTION_ID = "tv-nav"
const MAIN_SECTION_ID = "main"

let mainSectionConfig: Record<string, unknown> | null = null

/**
 * (Re)registers the catch-all "main" section. Kept last in the polyfill's section
 * order, since getSectionId assigns an element to the first matching section and
 * "main" matches everything a view section matches.
 */
export function registerMainFocusSection(config: Record<string, unknown>): void {
  mainSectionConfig = { ...config, id: MAIN_SECTION_ID }
  moveMainSectionLast()
}

function moveMainSectionLast(): void {
  const spatialNav = window.SpatialNavigation
  if (!spatialNav || !mainSectionConfig) return
  try {
    spatialNav.remove(MAIN_SECTION_ID)
  } catch {}
  try {
    spatialNav.add({ ...mainSectionConfig })
  } catch {}
}

/** Registers a spatial-nav section scoped to `root`'s descendants. Returns an unregister fn. */
export function registerFocusSection(
  id: string,
  root: HTMLElement,
  opts: FocusSectionOpts = {}
): () => void {
  const spatialNav = window.SpatialNavigation
  if (!spatialNav) return () => {}

  // `root` scopes the selector's querySelectorAll instead of a `#some-id` prefix, so the
  // catch-all "main" section can also tell (and drop) elements a rooted section already owns.
  const selector = opts.selector || `:is(a, button, [tabindex]:not([tabindex="-1"]), input, select, textarea)`

  try {
    spatialNav.add({
      id,
      selector,
      root,
      enterTo: opts.enterTo || "last-focused",
      restrict: opts.restrict,
      leaveFor: { left: `@${NAV_SECTION_ID}`, ...opts.leaveFor },
      defaultElement: opts.defaultElement || selector,
    })
    moveMainSectionLast()
    spatialNav.makeFocusable?.(id)
  } catch {
    return () => {}
  }

  return () => {
    try {
      spatialNav.remove(id)
    } catch {}
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Root font size is viewport-derived (see tv.css), so it only ever changes on resize.
let cachedRootFontSizePx: number | null = null

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    cachedRootFontSizePx = null
  })
}

/** Converts a design-canvas rem value to CSS px at the current (viewport-scaled) root font size. */
export function remPx(rem: number): number {
  if (cachedRootFontSizePx == null) {
    cachedRootFontSizePx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  }
  return rem * cachedRootFontSizePx
}

function reduceMotionActive(): boolean {
  return !motionAllowed()
}

function offsetFromTrack(target: HTMLElement, track: HTMLElement, axis: "x" | "y"): number {
  let offset = 0
  for (let element: HTMLElement | null = target; element && element !== track; element = element.offsetParent as HTMLElement | null) {
    offset += axis === "x" ? element.offsetLeft : element.offsetTop
  }
  return offset
}

const keepInViewRefreshers = new WeakMap<HTMLElement, (target?: HTMLElement | null) => void>()
const keepInViewInvalidators = new WeakMap<HTMLElement, () => void>()
const lastFocusedByScroller = new WeakMap<HTMLElement, HTMLElement>()

const FOCUSABLE_SELECTOR = `:is(a, button, [tabindex]:not([tabindex="-1"]), input, select, textarea)`
const ARROW_KEY_BY_DIRECTION: Record<"up" | "down" | "left" | "right", string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
}
const ARROW_KEYCODE_BY_DIRECTION: Record<"up" | "down" | "left" | "right", number> = {
  up: 38,
  down: 40,
  left: 37,
  right: 39,
}

/** True if `scroller` has anything a wheel-driven step could ever land on. */
function hasFocusTarget(scroller: HTMLElement): boolean {
  return scroller.querySelector(FOCUSABLE_SELECTOR) != null
}

function nearestFocusable(scroller: HTMLElement, pointer?: { clientX: number; clientY: number }): HTMLElement | null {
  const candidates = Array.from(scroller.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (candidates.length === 0) return null
  if (!pointer) return candidates[0]

  let closest = candidates[0]
  let closestDistance = Infinity
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect()
    const distance = Math.hypot(
      rect.left + rect.width / 2 - pointer.clientX,
      rect.top + rect.height / 2 - pointer.clientY
    )
    if (distance < closestDistance) {
      closestDistance = distance
      closest = candidate
    }
  }
  return closest
}

/** Moves focus one step by replaying the arrow key spatial-nav already acts on. */
export function stepFocus(
  scroller: HTMLElement,
  direction: "up" | "down" | "left" | "right",
  pointer?: { clientX: number; clientY: number }
): boolean {
  const active = document.activeElement
  let target: HTMLElement | null = active instanceof HTMLElement && scroller.contains(active) ? active : null

  if (!target) {
    const remembered = lastFocusedByScroller.get(scroller)
    target = remembered && remembered.isConnected && scroller.contains(remembered) ? remembered : null
  }
  if (!target) target = nearestFocusable(scroller, pointer)
  if (!target) return false

  if (document.activeElement !== target) target.focus({ preventScroll: true })

  const key = ARROW_KEY_BY_DIRECTION[direction]
  const event = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true })
  // spatial-navigation.js still keys off the legacy keyCode; the constructor ignores it.
  Object.defineProperty(event, "keyCode", { get: () => ARROW_KEYCODE_BY_DIRECTION[direction] })
  Object.defineProperty(event, "which", { get: () => ARROW_KEYCODE_BY_DIRECTION[direction] })
  target.dispatchEvent(event)
  return true
}

export const WHEEL_STEP_THROTTLE_MS = 80
export const WHEEL_STEP_THRESHOLD = 4

export interface WheelStepIntent {
  handled: boolean
  direction: "up" | "down" | "left" | "right" | null
  delta: number
}

/** Pure axis/delta decision: does this wheel event belong to `axis`, and which way does it step? */
export function resolveWheelStepIntent(
  axis: "x" | "y",
  deltaX: number,
  deltaY: number,
  shiftKey: boolean
): WheelStepIntent {
  if (axis === "x") {
    const horizontalIntent = shiftKey || Math.abs(deltaX) > Math.abs(deltaY)
    if (!horizontalIntent) return { handled: false, direction: null, delta: 0 }
    const delta = deltaX || deltaY
    if (delta === 0) return { handled: false, direction: null, delta: 0 }
    return { handled: true, direction: delta > 0 ? "right" : "left", delta }
  }
  const verticalIntent = Math.abs(deltaY) >= Math.abs(deltaX)
  if (!verticalIntent || deltaY === 0) return { handled: false, direction: null, delta: 0 }
  return { handled: true, direction: deltaY > 0 ? "down" : "up", delta: deltaY }
}

/** Re-applies a `keepFocusedInView` offset after its track's contents shifted under the focus. */
export function refreshKeepInView(scroller: HTMLElement, target?: HTMLElement | null): void {
  keepInViewRefreshers.get(scroller)?.(target)
}

/** Drops `keepFocusedInView`'s cached padding/scroll-size reads. Call after a resize or `setItems`. */
export function invalidateKeepInViewLayout(scroller: HTMLElement): void {
  keepInViewInvalidators.get(scroller)?.()
}

/** Translates `scroller`'s first child so the focused descendant sits `offset` from the leading edge. */
export function keepFocusedInView(
  scroller: HTMLElement,
  axis: "x" | "y",
  offset: number | (() => number)
): () => void {
  const track = scroller.firstElementChild as HTMLElement | null
  if (!track) return () => {}

  let trackPositioned = false

  // Deferred: getComputedStyle reports nothing while the track is still detached,
  // and an unpositioned track lets the offsetParent walk escape past it.
  function ensureTrackPositioned(): void {
    if (trackPositioned) return
    trackPositioned = true
    const position = getComputedStyle(track!).position
    if (position === "static" || !position) track!.classList.add("tv-keep-in-view-track")
  }

  // Cached across calls (each one otherwise forces a style recalc); cleared by
  // invalidateKeepInViewLayout() when the scroller/track size or padding can have changed.
  let cachedScrollerPaddingPx: number | null = null
  let cachedTrackPaddingStartPx: number | null = null
  let cachedScrollerSizePx: number | null = null
  let cachedTrackSizePx: number | null = null

  function invalidateMetrics(): void {
    cachedScrollerPaddingPx = null
    cachedTrackPaddingStartPx = null
    cachedScrollerSizePx = null
    cachedTrackSizePx = null
  }

  // clientWidth/Height counts the scroller's padding, but the track only fills its content box.
  function paddingAlongAxis(): number {
    if (cachedScrollerPaddingPx == null) {
      const styles = getComputedStyle(scroller)
      const start = parseFloat(axis === "x" ? styles.paddingLeft : styles.paddingTop) || 0
      const end = parseFloat(axis === "x" ? styles.paddingRight : styles.paddingBottom) || 0
      cachedScrollerPaddingPx = start + end
    }
    return cachedScrollerPaddingPx
  }

  function trackPaddingStart(): number {
    if (cachedTrackPaddingStartPx == null) {
      const styles = getComputedStyle(track!)
      cachedTrackPaddingStartPx = parseFloat(axis === "x" ? styles.paddingLeft : styles.paddingTop) || 0
    }
    return cachedTrackPaddingStartPx
  }

  // Shared by position() and the drag handler below, which needs the same numbers mid-gesture.
  function measureMaxShiftPx(): number {
    ensureTrackPositioned()
    if (cachedScrollerSizePx == null) {
      cachedScrollerSizePx = (axis === "x" ? scroller.clientWidth : scroller.clientHeight) - paddingAlongAxis()
    }
    if (cachedTrackSizePx == null) {
      cachedTrackSizePx = axis === "x" ? track!.scrollWidth : track!.scrollHeight
    }
    return Math.max(0, cachedTrackSizePx - cachedScrollerSizePx)
  }

  // Kept in sync by position(); the drag handler reads it as the gesture's starting shift.
  let currentShiftPx = 0

  function position(target: HTMLElement, animate: boolean): void {
    const maxShift = measureMaxShiftPx()

    // Measured from the track's content-box start, so the first item rests at 0.
    const targetOffset = offsetFromTrack(target, track!, axis) - trackPaddingStart()
    const offsetPx = typeof offset === "function" ? offset() : offset
    const next = -clamp(targetOffset - offsetPx, 0, maxShift)

    // Native focus-scroll / wheel would stack on top of the transform.
    if (axis === "x") scroller.scrollLeft = 0
    else scroller.scrollTop = 0

    track!.classList.toggle("tv-keep-in-view-animated", animate && !reduceMotionActive())
    track!.style.transform = axis === "x" ? `translateX(${next}px)` : `translateY(${next}px)`
    currentShiftPx = next
  }

  function onFocusIn(event: FocusEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement) || !track!.contains(target)) return
    lastFocusedByScroller.set(scroller, target)
    position(target, true)
  }

  let lastWheelStepAt = 0
  // Only consumed when the wheel intent matches this scroller's own axis, and only when it has
  // something to step onto - otherwise the event passes through to an ancestor scroller / native
  // scroll untouched.
  function onWheel(event: WheelEvent): void {
    const intent = resolveWheelStepIntent(axis, event.deltaX, event.deltaY, event.shiftKey)
    if (!intent.handled || !intent.direction) return
    if (!hasFocusTarget(scroller)) return

    event.preventDefault()
    event.stopPropagation()

    if (Math.abs(intent.delta) < WHEEL_STEP_THRESHOLD) return
    const now = performance.now()
    if (now - lastWheelStepAt < WHEEL_STEP_THROTTLE_MS) return
    lastWheelStepAt = now
    stepFocus(scroller, intent.direction, { clientX: event.clientX, clientY: event.clientY })
  }

  const wheelStepEnabled = document.documentElement.dataset.tv !== "1"

  // Mouse drag-to-scroll for the desktop UI mode; TV devices never see a pointer drag.
  function attachRailDrag(): () => void {
    let pointerId: number | null = null
    let dragging = false
    let abandoned = false
    let startClientX = 0
    let startClientY = 0
    let startShiftPx = 0
    let suppressNextClick = false

    function onPointerDown(event: PointerEvent): void {
      if (event.pointerType !== "mouse" || event.button !== 0) return
      if ((event.target as HTMLElement | null)?.closest("button, input, [contenteditable]")) return
      pointerId = event.pointerId
      dragging = false
      abandoned = false
      startClientX = event.clientX
      startClientY = event.clientY
      startShiftPx = currentShiftPx
    }

    function onPointerMove(event: PointerEvent): void {
      if (pointerId == null || event.pointerId !== pointerId || abandoned) return
      const deltaX = event.clientX - startClientX
      const deltaY = event.clientY - startClientY

      if (!dragging) {
        if (Math.abs(deltaX) < DRAG_START_THRESHOLD_PX && Math.abs(deltaY) < DRAG_START_THRESHOLD_PX) return
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          abandoned = true
          return
        }
        dragging = true
        scroller.setPointerCapture(pointerId)
        scroller.dataset.railDragging = "true"
        track!.classList.remove("tv-keep-in-view-animated")
      }

      const nextShiftPx = clampDragShift(startShiftPx, deltaX, measureMaxShiftPx())
      track!.style.transform = `translateX(${nextShiftPx}px)`
      currentShiftPx = nextShiftPx
    }

    function endDrag(event: PointerEvent): void {
      if (pointerId == null || event.pointerId !== pointerId) return
      const wasDragging = dragging
      if (wasDragging && scroller.hasPointerCapture(pointerId)) scroller.releasePointerCapture(pointerId)
      pointerId = null
      dragging = false
      abandoned = false
      delete scroller.dataset.railDragging
      if (!wasDragging) return

      const cardOffsetsPx = Array.from(track!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).map(
        (card) => offsetFromTrack(card, track!, "x") - trackPaddingStart()
      )
      const offsetPx = typeof offset === "function" ? offset() : offset
      const anchorIndex = pickAnchorIndex(cardOffsetsPx, currentShiftPx, offsetPx)
      const anchorCard =
        anchorIndex >= 0 ? track!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)[anchorIndex] : null

      if (anchorCard) {
        suppressNextClick = true
        anchorCard.focus({ preventScroll: true })
      } else {
        track!.style.transform = `translateX(${startShiftPx}px)`
        currentShiftPx = startShiftPx
      }
    }

    // The mouseup ending the drag would otherwise also fire as a click and activate the card.
    function onClickCapture(event: MouseEvent): void {
      if (!suppressNextClick) return
      suppressNextClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    // Card roots may be anchors, which are natively draggable.
    function onDragStart(event: DragEvent): void {
      event.preventDefault()
    }

    scroller.addEventListener("pointerdown", onPointerDown)
    scroller.addEventListener("pointermove", onPointerMove)
    scroller.addEventListener("pointerup", endDrag)
    scroller.addEventListener("pointercancel", endDrag)
    scroller.addEventListener("lostpointercapture", endDrag)
    scroller.addEventListener("click", onClickCapture, true)
    scroller.addEventListener("dragstart", onDragStart)

    return () => {
      scroller.removeEventListener("pointerdown", onPointerDown)
      scroller.removeEventListener("pointermove", onPointerMove)
      scroller.removeEventListener("pointerup", endDrag)
      scroller.removeEventListener("pointercancel", endDrag)
      scroller.removeEventListener("lostpointercapture", endDrag)
      scroller.removeEventListener("click", onClickCapture, true)
      scroller.removeEventListener("dragstart", onDragStart)
    }
  }

  const dragEnabled = axis === "x" && wheelStepEnabled
  const detachRailDrag = dragEnabled ? attachRailDrag() : null

  scroller.addEventListener("focusin", onFocusIn)
  if (wheelStepEnabled) scroller.addEventListener("wheel", onWheel, { passive: false })
  keepInViewRefreshers.set(scroller, (target) => {
    // A caller-supplied target wins over DOM focus, which may sit elsewhere.
    const anchor = target && track!.contains(target) ? target : document.activeElement
    if (anchor instanceof HTMLElement && track!.contains(anchor)) position(anchor, false)
  })
  keepInViewInvalidators.set(scroller, invalidateMetrics)
  return () => {
    scroller.removeEventListener("focusin", onFocusIn)
    if (wheelStepEnabled) scroller.removeEventListener("wheel", onWheel)
    detachRailDrag?.()
    keepInViewRefreshers.delete(scroller)
    keepInViewInvalidators.delete(scroller)
  }
}

/** Drops a `keepFocusedInView` scroller's offset. Call whenever its content is rebuilt from the top. */
export function resetKeepInView(scroller: HTMLElement): void {
  const track = scroller.firstElementChild as HTMLElement | null
  if (!track) return
  track.classList.remove("tv-keep-in-view-animated")
  track.style.transform = ""
  scroller.scrollLeft = 0
  scroller.scrollTop = 0
  invalidateKeepInViewLayout(scroller)
}
