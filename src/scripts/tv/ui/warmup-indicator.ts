// Corner pill surfacing lib/catalog.js's background warmup progress on TV.

import { t, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { KIND_ORDER } from "@/scripts/lib/kinds"

const HOLD_AFTER_DONE_MS = 900

let pillEl: HTMLDivElement | null = null
let dotEl: HTMLSpanElement | null = null
let textEl: HTMLSpanElement | null = null
const doneKinds = new Set<string>()
let hideTimer: ReturnType<typeof setTimeout> | null = null
let mounted = false

function ensurePill(): HTMLDivElement {
  if (pillEl?.isConnected) return pillEl
  const pill = document.createElement("div")
  pill.id = "tv-warmup-indicator"
  pill.setAttribute("role", "status")
  pill.setAttribute("aria-live", "polite")
  // Opaque background instead of backdrop-blur: this pill can be visible for the whole
  // catalog warmup, so it must never hold a compositor blur filter alive that long.
  pill.className =
    "fixed z-9000 hidden items-center gap-2 rounded-full border border-line bg-bg px-3.5 py-2 " +
    "text-xs text-fg-2 pointer-events-none"
  pill.style.bottom = "max(1rem, calc(env(safe-area-inset-bottom) + var(--xt-tv-overscan, 0) * 1vh))"
  pill.style.right = "max(1rem, calc(env(safe-area-inset-right) + var(--xt-tv-overscan, 0) * 1vw))"

  const dot = document.createElement("span")
  dot.className = "tv-warmup-dot size-2 shrink-0 rounded-full bg-accent"
  dot.setAttribute("aria-hidden", "true")

  const text = document.createElement("span")

  pill.append(dot, text)
  document.body.appendChild(pill)
  pillEl = pill
  dotEl = dot
  textEl = text
  return pill
}

function updateText(): void {
  if (!textEl) return
  textEl.textContent = `${t("catalog.warming")}… ${doneKinds.size}/${KIND_ORDER.length}`
}

function show(): void {
  const pill = ensurePill()
  pill.classList.remove("hidden")
  pill.classList.add("flex")
  if (dotEl) dotEl.dataset.state = "pending"
}

function scheduleHide(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    pillEl?.classList.add("hidden")
    pillEl?.classList.remove("flex")
  }, HOLD_AFTER_DONE_MS)
}

function onWarmingStart(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  doneKinds.clear()
  updateText()
  show()
}

function onWarmingProgress(event: Event): void {
  const detail = (event as CustomEvent).detail
  if (!detail?.kind) return
  if (detail.status === "done" || detail.status === "error") doneKinds.add(detail.kind)
  updateText()
}

function onWarmed(): void {
  if (dotEl) dotEl.dataset.state = "done"
  scheduleHide()
}

// The pill is appended straight to <body>, outside any ClientRouter-persisted
// element, so a swap drops it - reattach once the new document has settled.
function reattach(): void {
  if (pillEl && !pillEl.isConnected) document.body.appendChild(pillEl)
}

export function mountTvWarmupIndicator(): void {
  if (mounted) return
  mounted = true
  document.addEventListener("xt:catalog-warming-start", onWarmingStart)
  document.addEventListener("xt:catalog-warming-progress", onWarmingProgress)
  document.addEventListener("xt:catalog-warmed", onWarmed)
  document.addEventListener(LOCALE_EVENT, updateText)
  document.addEventListener("astro:page-load", reattach)
}
