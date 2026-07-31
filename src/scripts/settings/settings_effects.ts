/**
 * Settings page "living instrument panel" enhancements.
 *
 * 1. Morphing pill across every [role="radiogroup"] - one accent pill
 *    springs between [aria-pressed="true"] / [aria-checked="true"] buttons via WAAPI + FLIP.
 * 2. Scroll-spy rail behind the sidebar nav - tracks aria-current and
 *    morphs height + position to fit the active link with calm easing.
 * 3. Per-card commit pulse - whenever a radiogroup commits a new value,
 *    the host card emits a brief accent ring so the change is felt.
 *
 * Reduced motion + perf mode collapse animations to instant snaps. The
 * indicator placement still works, just without the morph.
 */

const SPRING_EASE = "cubic-bezier(0.34, 1.45, 0.64, 1)"
const CALM_EASE = "cubic-bezier(0.16, 1, 0.3, 1)"
const PILL_DURATION = 540
const RAIL_DURATION = 460

function motionSuppressed(): boolean {
  if (typeof window === "undefined") return true
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true
  if (document.documentElement.getAttribute("data-perf-mode") === "on") return true
  return false
}

function isHTMLElement(node: Element | null | undefined): node is HTMLElement {
  return !!node && node instanceof HTMLElement
}

const lastPulseAt = new WeakMap<HTMLElement, number>()

function pulseCard(originEl: Element | null) {
  if (!originEl || motionSuppressed()) return
  const card =
    originEl.closest<HTMLElement>(".settings-surface") ??
    originEl.closest<HTMLElement>(".icon-mark-host") ??
    originEl.closest<HTMLElement>(
      ".settings-group > div.rounded-2xl, .settings-group > details",
    )
  if (!card) return
  const now = performance.now()
  const last = lastPulseAt.get(card)
  if (last !== undefined && now - last < 280) return
  lastPulseAt.set(card, now)
  card.classList.remove("settings-commit-pulse")
  void card.offsetWidth
  card.classList.add("settings-commit-pulse")
  window.setTimeout(() => card.classList.remove("settings-commit-pulse"), 760)
}

function setupCommitTriggers(stack: HTMLElement) {
  stack.addEventListener("change", (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest("[data-pill-group]")) return
    if (
      target instanceof HTMLSelectElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      pulseCard(target)
    }
  })

  const clickPulseSelectors = ["#ua-save", "#settings-clear-cache"]
  for (const selector of clickPulseSelectors) {
    const btn = stack.querySelector<HTMLElement>(selector)
    btn?.addEventListener("click", () => pulseCard(btn))
  }

  document.addEventListener("xt:active-changed", () => {
    const playlistsCard = document.querySelector<HTMLElement>(
      "#settings-playlists > div.rounded-2xl",
    )
    if (playlistsCard) pulseCard(playlistsCard)
  })
}

function setupRadioGroupPill(group: HTMLElement) {
  if (group.dataset.pillGroup !== undefined) return
  group.dataset.pillGroup = "init"

  const pill = document.createElement("span")
  pill.className = "overdrive-pill"
  pill.setAttribute("aria-hidden", "true")
  group.prepend(pill)

  let activeAnimation: Animation | null = null
  let previousTransform = ""
  let previousWidth = ""
  let previousHeight = ""
  let hasShown = false

  const findPressed = (): HTMLElement | null => {
    return group.querySelector<HTMLElement>('[aria-pressed="true"], [aria-checked="true"]')
  }

  const moveTo = (target: HTMLElement | null, animate: boolean) => {
    if (!target) {
      pill.style.opacity = "0"
      return
    }
    const groupRect = group.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const x = targetRect.left - groupRect.left - group.clientLeft
    const y = targetRect.top - groupRect.top - group.clientTop
    const width = targetRect.width
    const height = targetRect.height

    if (width === 0 || height === 0) return

    const nextTransform = `translate(${x}px, ${y}px)`
    const nextWidth = `${width}px`
    const nextHeight = `${height}px`

    if (!hasShown || !animate || motionSuppressed()) {
      activeAnimation?.cancel()
      pill.style.transform = nextTransform
      pill.style.width = nextWidth
      pill.style.height = nextHeight
      pill.style.opacity = "1"
      previousTransform = nextTransform
      previousWidth = nextWidth
      previousHeight = nextHeight
      hasShown = true
      return
    }

    activeAnimation?.cancel()
    activeAnimation = pill.animate(
      [
        { transform: previousTransform, width: previousWidth, height: previousHeight },
        { transform: nextTransform, width: nextWidth, height: nextHeight },
      ],
      { duration: PILL_DURATION, easing: SPRING_EASE, fill: "forwards" },
    )
    pill.style.transform = nextTransform
    pill.style.width = nextWidth
    pill.style.height = nextHeight
    previousTransform = nextTransform
    previousWidth = nextWidth
    previousHeight = nextHeight
  }

  const syncNow = (animate: boolean) => moveTo(findPressed(), animate)

  // Initial placement happens after layout settles. Mark the group as
  // "ready" so the pressed-button bg can defer to the pill via CSS.
  requestAnimationFrame(() => {
    syncNow(false)
    group.dataset.pillGroup = "ready"
  })

  const pressedObserver = new MutationObserver((mutations) => {
    let changed = false
    for (const mut of mutations) {
      if (mut.attributeName === "aria-pressed" || mut.attributeName === "aria-checked") {
        changed = true
        break
      }
    }
    if (!changed) return
    syncNow(true)
    pulseCard(group)
  })
  pressedObserver.observe(group, {
    attributes: true,
    attributeFilter: ["aria-pressed", "aria-checked"],
    subtree: true,
  })

  // Resize / locale-driven width changes reposition without animation.
  const resizeObserver = new ResizeObserver(() => syncNow(false))
  resizeObserver.observe(group)
  for (const child of group.children) {
    if (isHTMLElement(child) && child !== pill) resizeObserver.observe(child)
  }
}

function setupNavRail(nav: HTMLElement) {
  if (nav.dataset.railReady !== undefined) return

  const rail = document.createElement("span")
  rail.className = "settings-nav-rail"
  rail.setAttribute("aria-hidden", "true")
  nav.prepend(rail)

  let activeAnimation: Animation | null = null
  let previousTransform = ""
  let previousWidth = ""
  let previousHeight = ""
  let hasShown = false

  const findCurrent = (): HTMLElement | null => {
    return nav.querySelector<HTMLElement>('.settings-nav-link[aria-current="true"]')
  }

  const moveTo = (target: HTMLElement | null, animate: boolean) => {
    if (!target) {
      rail.style.opacity = "0"
      return
    }
    const navRect = nav.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    // Account for the nav's horizontal scroll so the rail aligns with
    // its target even when the mobile chip rail has scrolled.
    const x = targetRect.left - navRect.left - nav.clientLeft + nav.scrollLeft
    const y = targetRect.top - navRect.top - nav.clientTop + nav.scrollTop
    const width = targetRect.width
    const height = targetRect.height

    if (width === 0 || height === 0) return

    const nextTransform = `translate(${x}px, ${y}px)`
    const nextWidth = `${width}px`
    const nextHeight = `${height}px`

    rail.dataset.danger = target.dataset.danger === "true" ? "true" : "false"

    if (!hasShown || !animate || motionSuppressed()) {
      activeAnimation?.cancel()
      rail.style.transform = nextTransform
      rail.style.width = nextWidth
      rail.style.height = nextHeight
      rail.style.opacity = "1"
      previousTransform = nextTransform
      previousWidth = nextWidth
      previousHeight = nextHeight
      hasShown = true
      return
    }

    activeAnimation?.cancel()
    activeAnimation = rail.animate(
      [
        { transform: previousTransform, width: previousWidth, height: previousHeight },
        { transform: nextTransform, width: nextWidth, height: nextHeight },
      ],
      { duration: RAIL_DURATION, easing: CALM_EASE, fill: "forwards" },
    )
    rail.style.transform = nextTransform
    rail.style.width = nextWidth
    rail.style.height = nextHeight
    previousTransform = nextTransform
    previousWidth = nextWidth
    previousHeight = nextHeight
  }

  const syncNow = (animate: boolean) => moveTo(findCurrent(), animate)

  // Place after first paint so initial aria-current (set by the
  // existing scroll-spy script) is already in the DOM.
  requestAnimationFrame(() => {
    syncNow(false)
    nav.dataset.railReady = ""
  })

  // Watch aria-current on each link.
  const observer = new MutationObserver(() => syncNow(true))
  const linkNodes = nav.querySelectorAll<HTMLElement>(".settings-nav-link")
  for (const link of linkNodes) {
    observer.observe(link, {
      attributes: true,
      attributeFilter: ["aria-current"],
    })
  }

  // Reposition when layout or text changes.
  const resizeObserver = new ResizeObserver(() => syncNow(false))
  resizeObserver.observe(nav)
  for (const link of linkNodes) resizeObserver.observe(link)

  // Mobile chip rail can scroll horizontally; keep rail glued to its link.
  nav.addEventListener("scroll", () => syncNow(false), { passive: true })
}

function init() {
  const stack = document.querySelector<HTMLElement>(".settings-stack")
  if (stack) {
    const groups = stack.querySelectorAll<HTMLElement>('[role="radiogroup"]')
    for (const group of groups) setupRadioGroupPill(group)

    // Catch radio groups that mount later (Svelte islands rendering after
    // hydration may add their own toggle clusters).
    const lateObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.matches('[role="radiogroup"]')) {
            setupRadioGroupPill(node)
          }
          const nested = node.querySelectorAll<HTMLElement>('[role="radiogroup"]')
          for (const group of nested) setupRadioGroupPill(group)
        }
      }
    })
    lateObserver.observe(stack, { childList: true, subtree: true })

    setupCommitTriggers(stack)
  }

  const nav = document.querySelector<HTMLElement>(".settings-nav")
  if (nav) setupNavRail(nav)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init)
} else {
  init()
}

export {}
