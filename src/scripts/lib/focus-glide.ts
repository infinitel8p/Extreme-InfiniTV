let indicatorEl: HTMLDivElement | null = null
let lastTarget: HTMLElement | null = null
let usingPointer = false
let rafId = 0
let followRafId = 0
let activeAnimation: Animation | null = null

const SIZE_LIMIT = { w: 720, h: 480 }
const SKIP_TAGS = new Set(["BODY", "HTML", "MAIN", "ASIDE", "ARTICLE", "SECTION", "NAV", "HEADER", "FOOTER"])

const radiusCache = new WeakMap<HTMLElement, number>()
function getRadius(el: HTMLElement): number {
  const cached = radiusCache.get(el)
  if (cached !== undefined) return cached
  const parsed = parseFloat(getComputedStyle(el).borderRadius) || 12
  radiusCache.set(el, parsed)
  return parsed
}

function ensureIndicator(): HTMLDivElement {
  if (indicatorEl) return indicatorEl
  indicatorEl = document.createElement("div")
  indicatorEl.className = "xt-focus-glide"
  indicatorEl.setAttribute("aria-hidden", "true")
  indicatorEl.dataset.visible = "false"
  document.body.appendChild(indicatorEl)
  return indicatorEl
}

function shouldTrack(el: EventTarget | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false
  if (SKIP_TAGS.has(el.tagName)) return false
  if (el.dataset.focusGlide === "off") return false
  if (el.closest("[data-focus-glide='off']")) return false
  if (el.closest("dialog[open]")) return true
  if (!el.isConnected) return false
  return true
}

function updatePosition(target: HTMLElement, opts: { skipAnimation?: boolean } = {}) {
  const indicator = ensureIndicator()
  if (!target || !target.isConnected) {
    hideIndicator()
    return
  }
  const rect = target.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) {
    hideIndicator()
    return
  }
  if (rect.width > SIZE_LIMIT.w || rect.height > SIZE_LIMIT.h) {
    hideIndicator()
    return
  }
  const radius = getRadius(target)
  // Fractional bounds anti-alias unevenly; snap the ring to whole pixels.
  const left = Math.round(rect.left)
  const top = Math.round(rect.top)
  const next = {
    transform: `translate3d(${left}px, ${top}px, 0)`,
    width: `${Math.round(rect.right) - left}px`,
    height: `${Math.round(rect.bottom) - top}px`,
    borderRadius: `${Math.max(8, radius)}px`,
    opacity: "1",
  }
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    opts.skipAnimation === true
  // A stale filling animation overrides inline styles and pins the ring on scroll.
  activeAnimation?.cancel()
  activeAnimation = null
  if (!reduce && indicator.dataset.visible === "true") {
    activeAnimation = indicator.animate(
      [
        {
          transform: indicator.style.transform || next.transform,
          width: indicator.style.width || next.width,
          height: indicator.style.height || next.height,
          borderRadius: indicator.style.borderRadius || next.borderRadius,
        },
        next,
      ],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
    )
  }
  indicator.style.transform = next.transform
  indicator.style.width = next.width
  indicator.style.height = next.height
  indicator.style.borderRadius = next.borderRadius
  indicator.style.opacity = "1"
  indicator.dataset.visible = "true"
  // While tracking, the glide rect is the ring; suppress the static outline.
  document.documentElement.classList.add("xt-glide-tracking")
  lastTarget = target
  // Cards lift on focus after measurement; follow per frame so the ring rides the lift.
  if (!opts.skipAnimation) {
    if (activeAnimation) {
      // Keep the reference: fill:forwards masks styles until the follow loop cancels it.
      activeAnimation.onfinish = () => startFollow(target)
    } else {
      startFollow(target)
    }
  }
}

function startFollow(target: HTMLElement) {
  cancelAnimationFrame(followRafId)
  const followUntil = performance.now() + 600
  const step = () => {
    if (lastTarget !== target || !target.isConnected) return
    updatePosition(target, { skipAnimation: true })
    if (performance.now() < followUntil) followRafId = requestAnimationFrame(step)
  }
  followRafId = requestAnimationFrame(step)
}

function hideIndicator() {
  document.documentElement.classList.remove("xt-glide-tracking")
  cancelAnimationFrame(followRafId)
  if (!indicatorEl) return
  activeAnimation?.cancel()
  activeAnimation = null
  indicatorEl.dataset.visible = "false"
  indicatorEl.style.opacity = "0"
  lastTarget = null
}

function onFocus(ev: FocusEvent) {
  if (usingPointer) {
    hideIndicator()
    return
  }
  const target = ev.target
  if (!shouldTrack(target)) {
    hideIndicator()
    return
  }
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => updatePosition(target))
}

function onBlur() {
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    if (!document.activeElement || document.activeElement === document.body) {
      hideIndicator()
    }
  })
}

function onPointer() {
  usingPointer = true
  hideIndicator()
}

function onKey(ev: KeyboardEvent) {
  if (
    ev.key === "Tab" ||
    ev.key === "ArrowUp" ||
    ev.key === "ArrowDown" ||
    ev.key === "ArrowLeft" ||
    ev.key === "ArrowRight" ||
    ev.key === "Enter" ||
    ev.key === " "
  ) {
    usingPointer = false
  }
}

function onScrollOrResize() {
  if (lastTarget && lastTarget.isConnected) {
    updatePosition(lastTarget, { skipAnimation: true })
  }
}

let attached = false

function attach() {
  if (attached) return
  attached = true
  document.addEventListener("focusin", onFocus, true)
  document.addEventListener("focusout", onBlur, true)
  document.addEventListener("pointerdown", onPointer, true)
  document.addEventListener("pointermove", onPointer, { passive: true, capture: true })
  document.addEventListener("keydown", onKey, true)
  window.addEventListener("scroll", onScrollOrResize, { passive: true, capture: true })
  window.addEventListener("resize", onScrollOrResize)
}

function detach() {
  if (!attached) return
  attached = false
  document.removeEventListener("focusin", onFocus, true)
  document.removeEventListener("focusout", onBlur, true)
  document.removeEventListener("pointerdown", onPointer, true)
  document.removeEventListener("pointermove", onPointer, true)
  document.removeEventListener("keydown", onKey, true)
  window.removeEventListener("scroll", onScrollOrResize, true)
  window.removeEventListener("resize", onScrollOrResize)
  cancelAnimationFrame(rafId)
  hideIndicator()
}

function isPerfMode(): boolean {
  try {
    return localStorage.getItem("xt_perf_mode") === "1"
  } catch {
    return false
  }
}

export function initFocusGlide() {
  if (typeof window === "undefined") return
  if (!window.matchMedia("(min-width: 48em)").matches) return
  if (!isPerfMode()) attach()
  document.addEventListener("xt:perf-mode-changed", () => {
    if (isPerfMode()) detach()
    else attach()
  })
}
