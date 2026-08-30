// Shared motion gate + easing for the TV UI; every WAAPI/View Transition path checks motionAllowed().

export const TV_EASE = "cubic-bezier(0.16, 1, 0.3, 1)"

let reducedMotionQuery: MediaQueryList | null = null

export function motionAllowed(): boolean {
  if (typeof document === "undefined") return false
  if (document.documentElement.getAttribute("data-perf-mode") === "on") return false
  if (!reducedMotionQuery && typeof window.matchMedia === "function") {
    reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
  }
  return !reducedMotionQuery?.matches
}

// ---------------------------------------------------------------------------
// Device-capability tier: keeps ambient colour extraction, Ken Burns and wide
// prefetch off low-memory / low-core TVs that pay for those layers in crashes.
// ---------------------------------------------------------------------------

export type EffectTier = "full" | "lite"

const FORCED_TIER_KEY = "xt_tv_effects"
const LITE_MEMORY_GB_MAX = 2
const LITE_ANDROID_CORES_MAX = 4

export interface ClassifyEffectTierInput {
  deviceMemoryGb?: number | null
  hardwareConcurrency?: number | null
  userAgent?: string | null
  forced?: EffectTier | null
}

export function classifyEffectTier(input: ClassifyEffectTierInput): EffectTier {
  if (input.forced === "full" || input.forced === "lite") return input.forced
  if (input.deviceMemoryGb != null && input.deviceMemoryGb <= LITE_MEMORY_GB_MAX) return "lite"
  const userAgent = input.userAgent || ""
  const isAndroid = /android/i.test(userAgent)
  if (isAndroid && input.hardwareConcurrency != null && input.hardwareConcurrency <= LITE_ANDROID_CORES_MAX) {
    return "lite"
  }
  if (/armv7|armeabi/i.test(userAgent)) return "lite"
  return "full"
}

function readForcedEffectTier(): EffectTier | null {
  try {
    const forced = localStorage.getItem(FORCED_TIER_KEY)
    return forced === "full" || forced === "lite" ? forced : null
  } catch {
    return null
  }
}

let cachedEffectTier: EffectTier | null = null

/** Memoized per session; reads `navigator` once and stamps `html[data-tv-effects]`. */
export function effectTier(): EffectTier {
  if (cachedEffectTier) return cachedEffectTier
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number })
  cachedEffectTier = classifyEffectTier({
    deviceMemoryGb: nav?.deviceMemory ?? null,
    hardwareConcurrency: nav?.hardwareConcurrency ?? null,
    userAgent: nav?.userAgent ?? null,
    forced: readForcedEffectTier(),
  })
  if (typeof document !== "undefined") document.documentElement.dataset.tvEffects = cachedEffectTier
  return cachedEffectTier
}

/** Gate for the heavy layers: Ken Burns, ambient colour extraction, wide prefetch. */
export function heavyEffectsAllowed(): boolean {
  return motionAllowed() && effectTier() === "full"
}

/** Strict memory gate for the lite tier: no eager decodes, no prefetch, no idle timers. */
export function memoryConservative(): boolean {
  return effectTier() === "lite"
}

const EPG_LITE_PAST_WINDOW_MS = 6 * 60 * 60 * 1000
const EPG_LITE_FUTURE_WINDOW_MS = 48 * 60 * 60 * 1000

/** Bounds the XMLTV parse on the lite tier so peak worker heap scales with the window, not the feed. */
export function epgLoadWindow(): { fromMs: number; toMs: number } | undefined {
  if (!memoryConservative()) return undefined
  const now = Date.now()
  return { fromMs: now - EPG_LITE_PAST_WINDOW_MS, toMs: now + EPG_LITE_FUTURE_WINDOW_MS }
}

export type EpgMode = "full" | "now-next"

/** Lite tier retains only the airing + upcoming programme per channel (see epg-worker.ts). */
export function epgLoadMode(): EpgMode {
  return memoryConservative() ? "now-next" : "full"
}

/** now-next mode bakes "now" into the parse, so it needs re-deriving on a timer rather than at query time. */
export const EPG_NOW_NEXT_REFRESH_MS = 30 * 60 * 1000

type ViewTransitionLike = { finished: Promise<void>; ready: Promise<void>; skipTransition(): void }
type DocumentWithVt = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ViewTransitionLike
  activeViewTransition?: ViewTransitionLike | null
}

let activeTransition: ViewTransitionLike | null = null

// True while Astro's own ClientRouter navigation transition is in flight (router.ts).
let navigationTransitionActive = false

export function beginNavigationTransition(): void {
  navigationTransitionActive = true
}

export function endNavigationTransition(): void {
  navigationTransitionActive = false
}

/** Runs `update` inside a same-document View Transition when supported and motion is allowed. */
export async function startViewTransitionSafe(update: () => void | Promise<void>): Promise<void> {
  const doc = document as DocumentWithVt
  const canOwnTransition =
    motionAllowed() &&
    typeof doc.startViewTransition === "function" &&
    !navigationTransitionActive &&
    !doc.activeViewTransition
  if (!canOwnTransition) {
    await update()
    return
  }
  activeTransition?.skipTransition()
  const transition = doc.startViewTransition(update)
  activeTransition = transition
  try {
    await transition.finished
  } catch {
    // A skipped or interrupted transition still applied `update`.
  } finally {
    if (activeTransition === transition) activeTransition = null
  }
}
