// Spatial-nav section helpers for TV views built on top of spatial-navigation.js.

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

function ensureElementId(root: HTMLElement, prefix: string): string {
  if (root.id) return root.id
  root.id = `${prefix}-${Math.random().toString(36).slice(2, 9)}`
  return root.id
}

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

  const rootId = ensureElementId(root, "tv-focus-section")
  const selector = opts.selector || `#${rootId} :is(a, button, [tabindex]:not([tabindex="-1"]), input, select, textarea)`

  try {
    spatialNav.add({
      id,
      selector,
      enterTo: opts.enterTo || "last-focused",
      restrict: opts.restrict,
      leaveFor: { left: `@${NAV_SECTION_ID}`, ...opts.leaveFor },
      defaultElement: opts.defaultElement || selector,
    })
    moveMainSectionLast()
    spatialNav.makeFocusable?.()
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

/** Converts a design-canvas rem value to CSS px at the current (viewport-scaled) root font size. */
export function remPx(rem: number): number {
  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return rem * rootFontSize
}

function reduceMotionActive(): boolean {
  return (
    document.documentElement.getAttribute("data-perf-mode") === "on" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

function offsetFromTrack(target: HTMLElement, track: HTMLElement, axis: "x" | "y"): number {
  let offset = 0
  for (let element: HTMLElement | null = target; element && element !== track; element = element.offsetParent as HTMLElement | null) {
    offset += axis === "x" ? element.offsetLeft : element.offsetTop
  }
  return offset
}

const keepInViewRefreshers = new WeakMap<HTMLElement, (target?: HTMLElement | null) => void>()

/** Re-applies a `keepFocusedInView` offset after its track's contents shifted under the focus. */
export function refreshKeepInView(scroller: HTMLElement, target?: HTMLElement | null): void {
  keepInViewRefreshers.get(scroller)?.(target)
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

  // clientWidth/Height counts the scroller's padding, but the track only fills its content box.
  function paddingAlongAxis(): number {
    const styles = getComputedStyle(scroller)
    const start = parseFloat(axis === "x" ? styles.paddingLeft : styles.paddingTop) || 0
    const end = parseFloat(axis === "x" ? styles.paddingRight : styles.paddingBottom) || 0
    return start + end
  }

  function trackPaddingStart(): number {
    const styles = getComputedStyle(track!)
    return parseFloat(axis === "x" ? styles.paddingLeft : styles.paddingTop) || 0
  }

  function position(target: HTMLElement, animate: boolean): void {
    ensureTrackPositioned()

    const scrollerSize =
      (axis === "x" ? scroller.clientWidth : scroller.clientHeight) - paddingAlongAxis()
    const trackSize = axis === "x" ? track!.scrollWidth : track!.scrollHeight
    const maxShift = Math.max(0, trackSize - scrollerSize)

    // Measured from the track's content-box start, so the first item rests at 0.
    const targetOffset = offsetFromTrack(target, track!, axis) - trackPaddingStart()
    const offsetPx = typeof offset === "function" ? offset() : offset
    const next = -clamp(targetOffset - offsetPx, 0, maxShift)

    // Native focus-scroll / wheel would stack on top of the transform.
    if (axis === "x") scroller.scrollLeft = 0
    else scroller.scrollTop = 0

    track!.classList.toggle("tv-keep-in-view-animated", animate && !reduceMotionActive())
    track!.style.transform = axis === "x" ? `translateX(${next}px)` : `translateY(${next}px)`
  }

  function onFocusIn(event: FocusEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement) || !track!.contains(target)) return
    position(target, true)
  }

  scroller.addEventListener("focusin", onFocusIn)
  keepInViewRefreshers.set(scroller, (target) => {
    // A caller-supplied target wins over DOM focus, which may sit elsewhere.
    const anchor = target && track!.contains(target) ? target : document.activeElement
    if (anchor instanceof HTMLElement && track!.contains(anchor)) position(anchor, false)
  })
  return () => {
    scroller.removeEventListener("focusin", onFocusIn)
    keepInViewRefreshers.delete(scroller)
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
}
