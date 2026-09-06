// TV gliding focus ring: follows focus with a smoothed rAF loop instead of a static outline.

import { motionAllowed } from "@/scripts/tv/motion"
import { PERF_MODE_EVENT } from "@/scripts/lib/app-settings.js"
import { applyAmbient, clearAmbient } from "@/scripts/tv/ambient-color"
import type { ImgKind } from "@/scripts/lib/img-scale"

interface GlideRect {
  left: number
  top: number
  width: number
  height: number
  radius: number
}

const SETTLE_EPSILON_PX = 0.3
const SETTLE_FRAMES = 3
const CHASE_SNAP_EPSILON_PX = 0.75
const CHASE_TAU_MIN_MS = 22
const CHASE_TAU_MAX_MS = 45
const CHASE_TAU_DISTANCE_DIVISOR = 25
const HIDE_DELAY_MS = 80
// Mirrors tv.css's `#tv-focus-glide` opacity transition duration.
const CROSS_VIEW_FADE_MS = 120
// Ambient glow extraction is comparatively expensive; only run it once focus stops hopping.
const AMBIENT_GLOW_DEBOUNCE_MS = 250

let mounted = false
let attached = false
let glideEl: HTMLDivElement | null = null
let reducedMotionQuery: MediaQueryList | null = null

let ringTarget: HTMLElement | null = null
// The target's box, read once per hop (not re-measured every rAF frame while chasing).
let goal: GlideRect | null = null
// Ring's animated position only; width/height/radius are sized once per hop (see applySize).
let current: { left: number; top: number } | null = null
let visible = false
let settledFrames = 0
let lastFrameTime = 0
let rafId = 0
let hideTimerId = 0
let crossViewFadeTimerId = 0
let ambientGlowTimerId = 0
let previousViewRoot: Element | null = null

const radiusCache = new WeakMap<HTMLElement, number>()

function getRadius(element: HTMLElement): number {
  const cached = radiusCache.get(element)
  if (cached !== undefined) return cached
  const parsed = parseFloat(getComputedStyle(element).borderRadius) || 0
  radiusCache.set(element, parsed)
  return parsed
}

function ensureGlideEl(): HTMLDivElement {
  if (glideEl) {
    if (!glideEl.isConnected) document.body.appendChild(glideEl)
    return glideEl
  }
  const element = document.createElement("div")
  element.id = "tv-focus-glide"
  element.setAttribute("aria-hidden", "true")
  element.dataset.visible = "false"
  // Registers the ambient custom property before tv.css's ::after glow relies on --tv-ambient-glow.
  clearAmbient(element, { vars: ["--tv-ambient-glow"] })
  document.body.appendChild(element)
  glideEl = element
  return element
}

/** Content identity for the card whose artwork tints the glide's spill. */
function resolveAmbientSource(target: HTMLElement): { imageUrl: string; kind: ImgKind } | null {
  const card = target.closest<HTMLElement>(".tv-focus-card")
  if (!card) return null
  const imageUrl = card.dataset.prefetchUrl || card.querySelector("[data-poster-wrap] img")?.getAttribute("src") || null
  if (!imageUrl) return null
  const kind: ImgKind = card.dataset.entryKey?.startsWith("live:") ? "logo" : "poster"
  return { imageUrl, kind }
}

function updateAmbientGlow(target: HTMLElement): void {
  const source = resolveAmbientSource(target)
  const element = ensureGlideEl()
  if (!source) {
    clearAmbient(element, { vars: ["--tv-ambient-glow"] })
    return
  }
  void applyAmbient(element, source.imageUrl, { vars: ["--tv-ambient-glow"], kind: source.kind })
}

/** Maps a focused element to the element whose rect the ring should draw around. */
function resolveRingTarget(target: HTMLElement): HTMLElement | null {
  const card = target.closest<HTMLElement>(".tv-focus-card")
  if (card) return card.querySelector<HTMLElement>("[data-poster-wrap]")
  return target.closest<HTMLElement>(".tv-focus-inset, .tv-focus-ring")
}

function shouldTrack(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest("#tv-nav")) return false
  if (target.closest("dialog[open]")) return false
  if (target.closest("[data-focus-glide='off']")) return false
  if (target.closest("input, textarea, select, [contenteditable='true']")) return false
  return true
}

function readGoal(target: HTMLElement): GlideRect {
  const rect = target.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, radius: getRadius(target) }
}

/** Sized once per hop (not per frame) - width/height/radius don't animate, only position does. */
function applySize(rect: GlideRect): void {
  const element = ensureGlideEl()
  element.style.width = `${Math.round(rect.width)}px`
  element.style.height = `${Math.round(rect.height)}px`
  element.style.borderRadius = `${Math.round(rect.radius)}px`
}

function applyPosition(left: number, top: number): void {
  const element = ensureGlideEl()
  element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
}

function showRing(): void {
  visible = true
  document.documentElement.dataset.tvGlide = "1"
  ensureGlideEl().dataset.visible = "true"
}

function hideRing(): void {
  visible = false
  ringTarget = null
  goal = null
  current = null
  previousViewRoot = null
  settledFrames = 0
  lastFrameTime = 0
  cancelAnimationFrame(rafId)
  rafId = 0
  cancelCrossViewFade()
  cancelAmbientGlow()
  delete document.documentElement.dataset.tvGlide
  if (glideEl) {
    glideEl.dataset.visible = "false"
    clearAmbient(glideEl, { vars: ["--tv-ambient-glow"] })
  }
}

function cancelHide(): void {
  if (!hideTimerId) return
  window.clearTimeout(hideTimerId)
  hideTimerId = 0
}

function cancelCrossViewFade(): void {
  if (!crossViewFadeTimerId) return
  window.clearTimeout(crossViewFadeTimerId)
  crossViewFadeTimerId = 0
}

function cancelAmbientGlow(): void {
  if (!ambientGlowTimerId) return
  window.clearTimeout(ambientGlowTimerId)
  ambientGlowTimerId = 0
}

function scheduleHide(): void {
  cancelHide()
  hideTimerId = window.setTimeout(() => {
    hideTimerId = 0
    hideRing()
  }, HIDE_DELAY_MS)
}

/** Shorter tau (faster catch-up) the closer the ring gets, so long and short hops both settle smoothly. */
function chaseTauMs(remainingPx: number): number {
  return Math.min(CHASE_TAU_MAX_MS, Math.max(CHASE_TAU_MIN_MS, remainingPx / CHASE_TAU_DISTANCE_DIVISOR))
}

function stepFollow(now: number): void {
  if (!ringTarget || !ringTarget.isConnected || !current || !goal) {
    hideRing()
    return
  }
  const dt = lastFrameTime ? now - lastFrameTime : 16
  lastFrameTime = now
  const remaining = Math.hypot(goal.left - current.left, goal.top - current.top)
  if (remaining < CHASE_SNAP_EPSILON_PX) {
    current = { left: goal.left, top: goal.top }
  } else {
    const factor = 1 - Math.exp(-dt / chaseTauMs(remaining))
    current.left += (goal.left - current.left) * factor
    current.top += (goal.top - current.top) * factor
  }
  applyPosition(current.left, current.top)

  const settledNow =
    Math.abs(goal.left - current.left) < SETTLE_EPSILON_PX && Math.abs(goal.top - current.top) < SETTLE_EPSILON_PX
  settledFrames = settledNow ? settledFrames + 1 : 0
  if (settledFrames >= SETTLE_FRAMES) {
    rafId = 0
    lastFrameTime = 0
    return
  }
  rafId = requestAnimationFrame(stepFollow)
}

function startFollowLoop(): void {
  if (rafId) return
  lastFrameTime = 0
  settledFrames = 0
  rafId = requestAnimationFrame(stepFollow)
}

/** Instantly repositions the ring behind a 120ms fade instead of lerping across unrelated content. */
function snapAcrossView(nextGoal: GlideRect): void {
  cancelCrossViewFade()
  const element = ensureGlideEl()
  if (!motionAllowed()) {
    current = { left: nextGoal.left, top: nextGoal.top }
    applyPosition(current.left, current.top)
    startFollowLoop()
    return
  }
  element.dataset.visible = "false"
  crossViewFadeTimerId = window.setTimeout(() => {
    crossViewFadeTimerId = 0
    current = { left: nextGoal.left, top: nextGoal.top }
    applyPosition(current.left, current.top)
    element.dataset.visible = "true"
    startFollowLoop()
  }, CROSS_VIEW_FADE_MS)
}

function trackTarget(target: HTMLElement): void {
  const ring = resolveRingTarget(target)
  if (!ring) {
    scheduleHide()
    return
  }
  cancelHide()
  const viewRoot = target.closest("[data-tv-view-root]")
  const crossedView = viewRoot !== previousViewRoot
  const previousDisconnected = ringTarget !== null && !ringTarget.isConnected
  previousViewRoot = viewRoot
  ringTarget = ring
  const nextGoal = readGoal(ring)
  goal = nextGoal
  // Sized once per hop; only position glides frame-to-frame (see stepFollow).
  applySize(nextGoal)

  // First appearance (or after a page swap) snaps in place; a live target glides from its old spot.
  if (!visible || !current) {
    current = { left: nextGoal.left, top: nextGoal.top }
    applyPosition(current.left, current.top)
    showRing()
    startFollowLoop()
    return
  }
  if (crossedView || previousDisconnected) {
    cancelAnimationFrame(rafId)
    rafId = 0
    snapAcrossView(nextGoal)
    return
  }
  startFollowLoop()
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target
  if (!shouldTrack(target)) {
    scheduleHide()
    return
  }
  trackTarget(target)
  // Ambient extraction only runs once focus stops hopping for a beat, not on every hop.
  cancelAmbientGlow()
  ambientGlowTimerId = window.setTimeout(() => {
    ambientGlowTimerId = 0
    updateAmbientGlow(target)
  }, AMBIENT_GLOW_DEBOUNCE_MS)
}

function onFocusOut(event: FocusEvent): void {
  // A focusin follows synchronously when focus actually moves to another element.
  if (event.relatedTarget) return
  scheduleHide()
}

function onBeforeSwap(): void {
  cancelHide()
  hideRing()
  // Both point into the outgoing document; holding them pins that whole view root.
  ringTarget = null
  previousViewRoot = null
}

function onPageLoad(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && shouldTrack(active)) {
    trackTarget(active)
    updateAmbientGlow(active)
  }
}

function onWindowResize(): void {
  if (!ringTarget) return
  // The stored goal isn't re-measured per frame anymore, so a viewport resize needs an
  // explicit re-read - the target's rect (and thus the ring's fixed size) may have moved.
  goal = readGoal(ringTarget)
  applySize(goal)
  startFollowLoop()
}

function attach(): void {
  if (attached) return
  attached = true
  document.addEventListener("focusin", onFocusIn, true)
  document.addEventListener("focusout", onFocusOut, true)
  document.addEventListener("astro:before-swap", onBeforeSwap)
  document.addEventListener("astro:page-load", onPageLoad)
  window.addEventListener("resize", onWindowResize)
  const active = document.activeElement
  if (active instanceof HTMLElement && shouldTrack(active)) {
    trackTarget(active)
    updateAmbientGlow(active)
  }
}

function detach(): void {
  if (!attached) return
  attached = false
  document.removeEventListener("focusin", onFocusIn, true)
  document.removeEventListener("focusout", onFocusOut, true)
  document.removeEventListener("astro:before-swap", onBeforeSwap)
  document.removeEventListener("astro:page-load", onPageLoad)
  window.removeEventListener("resize", onWindowResize)
  cancelHide()
  hideRing()
  glideEl?.remove()
  glideEl = null
}

function syncAttachment(): void {
  if (motionAllowed()) attach()
  else detach()
}

export function mountTvFocusGlide(): void {
  if (typeof window === "undefined" || mounted) return
  mounted = true
  document.addEventListener(PERF_MODE_EVENT, syncAttachment)
  reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
  reducedMotionQuery.addEventListener("change", syncAttachment)
  syncAttachment()
}

export function unmountTvFocusGlide(): void {
  if (!mounted) return
  mounted = false
  document.removeEventListener(PERF_MODE_EVENT, syncAttachment)
  reducedMotionQuery?.removeEventListener("change", syncAttachment)
  reducedMotionQuery = null
  detach()
}
