// Spatial-nav section helpers for TV views built on top of spatial-navigation.js.

interface FocusSectionOpts {
  selector?: string
  enterTo?: "last-focused" | "default-element"
  restrict?: "self-only" | "self-first"
  leaveFor?: Record<string, string>
  defaultElement?: string
}

function ensureElementId(root: HTMLElement, prefix: string): string {
  if (root.id) return root.id
  root.id = `${prefix}-${Math.random().toString(36).slice(2, 9)}`
  return root.id
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
      enterTo: opts.enterTo || "default-element",
      restrict: opts.restrict,
      leaveFor: opts.leaveFor,
      defaultElement: opts.defaultElement || selector,
    })
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

/** Translates `scroller`'s first child so the focused descendant sits `offsetPx` from the leading edge. */
export function keepFocusedInView(scroller: HTMLElement, axis: "x" | "y", offsetPx: number): () => void {
  const track = scroller.firstElementChild as HTMLElement | null
  if (!track) return () => {}

  if (getComputedStyle(track).position === "static") {
    track.classList.add("tv-keep-in-view-track")
  }

  // clientWidth/Height counts the scroller's padding, but the track only fills its content box.
  function paddingAlongAxis(): number {
    const styles = getComputedStyle(scroller)
    const start = parseFloat(axis === "x" ? styles.paddingLeft : styles.paddingTop) || 0
    const end = parseFloat(axis === "x" ? styles.paddingRight : styles.paddingBottom) || 0
    return start + end
  }

  function onFocusIn(event: FocusEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement) || !track!.contains(target)) return

    const scrollerSize =
      (axis === "x" ? scroller.clientWidth : scroller.clientHeight) - paddingAlongAxis()
    const trackSize = axis === "x" ? track!.scrollWidth : track!.scrollHeight
    const maxShift = Math.max(0, trackSize - scrollerSize)

    const targetOffset = offsetFromTrack(target, track!, axis)
    const next = clamp(offsetPx - targetOffset, -maxShift, 0)

    // Native focus-scroll / wheel would stack on top of the transform.
    if (axis === "x") scroller.scrollLeft = 0
    else scroller.scrollTop = 0

    track!.classList.toggle("tv-keep-in-view-animated", !reduceMotionActive())
    track!.style.transform = axis === "x" ? `translateX(${next}px)` : `translateY(${next}px)`
  }

  scroller.addEventListener("focusin", onFocusIn)
  return () => {
    scroller.removeEventListener("focusin", onFocusIn)
  }
}
