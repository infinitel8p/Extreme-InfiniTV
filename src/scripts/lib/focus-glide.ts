let indicatorEl: HTMLDivElement | null = null
let lastTarget: HTMLElement | null = null
let usingPointer = false
let rafId = 0

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
  const next = {
    transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderRadius: `${Math.max(8, radius)}px`,
    opacity: "1",
  }
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    opts.skipAnimation === true
  if (!reduce && indicator.dataset.visible === "true") {
    indicator.animate(
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
  lastTarget = target
}

function hideIndicator() {
  if (!indicatorEl) return
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
