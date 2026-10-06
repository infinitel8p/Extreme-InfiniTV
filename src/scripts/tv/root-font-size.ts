// Computes the TV shell's root font-size in JS instead of a live `calc(min(100vw/60, 100vh/33.75))`
// in CSS: a raw vw/vh formula recomputes on every viewport resize event (including an on-screen
// keyboard opening), relayouting every rem-based measurement in the whole TV UI. Mirrors the
// canvas constants in tv.css's fallback rule - keep both in sync if the design canvas changes.
import { debounce } from "@/scripts/lib/debounce.ts"

const DESIGN_CANVAS_WIDTH_REM = 60
const DESIGN_CANVAS_HEIGHT_REM = 33.75
const MIN_ROOT_FONT_SIZE_PX = 12
const RESIZE_DEBOUNCE_MS = 150

function readFontScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--xt-font-scale")
  const parsed = parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/** Pure so it's unit-testable without a DOM/viewport. */
export function computeRootFontSizePx(viewportWidth: number, viewportHeight: number, fontScale: number): number {
  const fitted = Math.min(viewportWidth / DESIGN_CANVAS_WIDTH_REM, viewportHeight / DESIGN_CANVAS_HEIGHT_REM)
  return Math.max(MIN_ROOT_FONT_SIZE_PX, fitted * fontScale)
}

/** Recomputes `--xt-root-px` from the current viewport + `--xt-font-scale`. Call after either changes. */
export function applyRootFontSizePx(): void {
  const px = computeRootFontSizePx(window.innerWidth, window.innerHeight, readFontScale())
  // Written with its unit so tv.css's `var(--xt-root-px, <formula>)` never needs to convert
  // between a unitless number and the formula fallback, which is already a px length.
  document.documentElement.style.setProperty("--xt-root-px", `${px}px`)
}

/** Debounced resize listener that keeps `--xt-root-px` current; returns the teardown function. */
export function mountRootFontSizeSync(): () => void {
  applyRootFontSizePx()
  const onResize = debounce(applyRootFontSizePx, RESIZE_DEBOUNCE_MS)
  window.addEventListener("resize", onResize)
  return () => window.removeEventListener("resize", onResize)
}
