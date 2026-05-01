// Self-contained toast notifications. Injects its own container + styles
// on first use. Works from Astro islands, vanilla scripts, and anywhere
// document is available.
import { t } from "@/scripts/lib/i18n.js"

type ToastVariant = "default" | "success" | "warn" | "error"

interface ToastOptions {
  title: string
  description?: string
  variant?: ToastVariant
  /** ms; 0 = sticky (manual dismiss only). Default 4000. */
  duration?: number
}

// We attach a cleanup hook to the toast element so dismiss() can cancel
// timers / animations even when called from the eviction path.
type ToastEl = HTMLElement & { _xtCleanup?: () => void }
//
// API:
//   toast({ title, description?, variant?, duration? })
//   toastSuccess(title, opts?)
//   toastError(title, opts?)
//   toastWarn(title, opts?)
//
// variant: "default" (fuchsia) | "success" (--color-ok) | "warn" | "error"
// duration: ms; 0 = sticky (manual dismiss only). Default 4000.
//
// Anchored top-center. Hover or keyboard focus pauses the timer.

import { ICON_X } from "@/scripts/lib/icons.js"

const DEFAULT_DURATION = 4000
const MAX_VISIBLE = 4
const GAP = 8

const CONTAINER_ID = "_xt_toast_container"
const STYLE_ID = "_xt_toast_styles"
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)"

let containerEl: HTMLOListElement | null = null

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `
    #${CONTAINER_ID} {
      position: fixed;
      top: max(1rem, env(safe-area-inset-top));
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${GAP}px;
      pointer-events: none;
      width: max-content;
      max-width: min(28rem, calc(100vw - 2rem));
    }
    @media (max-width: 40em) {
      #${CONTAINER_ID} {
        width: calc(100vw - 2rem);
        max-width: none;
      }
    }

    .xt-toast {
      pointer-events: auto;
      position: relative;
      display: flex;
      align-items: stretch;
      width: 100%;
      min-width: 18rem;
      max-width: 28rem;
      border-radius: 0.75rem;
      background: var(--color-surface);
      color: var(--color-fg);
      border: 1px solid var(--color-line);
      font-family: var(--font-sans);
      box-shadow:
        0 12px 32px -16px light-dark(oklch(0.165 0.013 255 / 0.20), oklch(0 0 0 / 0.55)),
        0 4px 12px -6px light-dark(oklch(0.165 0.013 255 / 0.12), oklch(0 0 0 / 0.35));
      opacity: 0;
      transform: translateY(-6px);
      animation: xt-toast-in 200ms ${EASE} forwards;
      transition:
        transform 200ms ${EASE},
        opacity 200ms ${EASE};
      overflow: hidden;
    }

    .xt-toast.is-leaving {
      animation: xt-toast-out 180ms cubic-bezier(0.4, 0, 1, 1) forwards;
    }

    .xt-toast__accent {
      width: 3px;
      flex-shrink: 0;
      background: var(--color-accent);
    }
    .xt-toast--success .xt-toast__accent { background: var(--color-ok); }
    .xt-toast--warn    .xt-toast__accent { background: var(--color-warn); }
    .xt-toast--error   .xt-toast__accent { background: var(--color-bad); }

    .xt-toast__body {
      flex: 1;
      min-width: 0;
      padding: 0.625rem 0.75rem 0.625rem 0.875rem;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }
    .xt-toast__title {
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1.35;
      letter-spacing: -0.005em;
      color: var(--color-fg);
    }
    .xt-toast__desc {
      font-size: var(--text-2xs, 0.6875rem);
      line-height: 1.4;
      color: var(--color-fg-2);
      white-space: pre-line;
    }

    .xt-toast__close {
      flex-shrink: 0;
      align-self: flex-start;
      background: transparent;
      border: none;
      cursor: pointer;
      width: 1.75rem;
      height: 1.75rem;
      margin: 0.375rem 0.375rem 0 -0.125rem;
      border-radius: 0.5rem;
      color: var(--color-fg-3);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.875rem;
      transition: background-color 150ms ${EASE}, color 150ms ${EASE};
      -webkit-tap-highlight-color: transparent;
    }
    .xt-toast__close:hover,
    .xt-toast__close:focus-visible {
      background: var(--color-surface-2);
      color: var(--color-fg);
    }
    .xt-toast__close:focus-visible {
      outline: 2px solid var(--color-accent);
      outline-offset: -1px;
    }
    @media (pointer: coarse) {
      .xt-toast__close {
        width: 2.75rem;
        height: 2.75rem;
        margin: 0 0.125rem 0 -0.25rem;
        font-size: 1rem;
      }
    }

    .xt-toast__progress {
      position: absolute;
      left: 3px;
      right: 0;
      bottom: 0;
      height: 2px;
      background: var(--color-accent);
      opacity: 0.45;
      transform-origin: left center;
      transform: scaleX(1);
    }
    .xt-toast--success .xt-toast__progress { background: var(--color-ok); }
    .xt-toast--warn    .xt-toast__progress { background: var(--color-warn); }
    .xt-toast--error   .xt-toast__progress { background: var(--color-bad); }

    .xt-toast.is-depth-1 { transform: scale(0.985); opacity: 0.92; }
    .xt-toast.is-depth-2 { transform: scale(0.97);  opacity: 0.78; }
    .xt-toast.is-depth-3 { transform: scale(0.955); opacity: 0.62; }

    @keyframes xt-toast-in {
      from { opacity: 0; transform: translateY(-6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes xt-toast-out {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(-6px) scale(0.98); }
    }

    @media (prefers-reduced-motion: reduce) {
      .xt-toast,
      .xt-toast.is-leaving { animation-duration: 0.01ms !important; }
      .xt-toast__progress { display: none; }
    }
  `
  document.head.appendChild(style)
}

function getContainer(): HTMLOListElement {
  if (containerEl && document.body.contains(containerEl)) return containerEl
  injectStyles()
  containerEl = document.createElement("ol")
  containerEl.id = CONTAINER_ID
  containerEl.setAttribute("role", "region")
  containerEl.setAttribute("aria-label", t("common.notifications"))
  containerEl.setAttribute("data-i18n-attr", "aria-label:common.notifications")
  document.body.appendChild(containerEl)
  return containerEl
}

function updateStackDepth(): void {
  if (!containerEl) return
  const items = Array.from(
    containerEl.querySelectorAll<HTMLElement>(".xt-toast:not(.is-leaving)")
  )
  const n = items.length
  for (let i = 0; i < n; i++) {
    const el = items[i]!
    const depth = n - 1 - i
    el.classList.remove("is-depth-1", "is-depth-2", "is-depth-3")
    if (depth >= 3) el.classList.add("is-depth-3")
    else if (depth === 2) el.classList.add("is-depth-2")
    else if (depth === 1) el.classList.add("is-depth-1")
  }
}

function evictOverflow(): void {
  if (!containerEl) return
  const items = containerEl.querySelectorAll<HTMLElement>(".xt-toast:not(.is-leaving)")
  if (items.length <= MAX_VISIBLE) return
  for (let i = 0; i < items.length - MAX_VISIBLE; i++) {
    dismiss(items[i]!)
  }
}

function dismiss(el: ToastEl): void {
  if (!el || el.classList.contains("is-leaving")) return
  el.classList.add("is-leaving")
  el._xtCleanup?.()
  el.addEventListener(
    "animationend",
    () => {
      el.remove()
      updateStackDepth()
    },
    { once: true }
  )
}

// Smoothly ramp playbackRate over `ms` ms for a calm pause/resume.
function smoothRate(anim: Animation, from: number, to: number, ms: number): void {
  const start = performance.now()
  function tick(now: number): void {
    const progress = Math.min((now - start) / ms, 1)
    const eased = 1 - (1 - progress) * (1 - progress)
    anim.playbackRate = from + (to - from) * eased
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function toast(opts: ToastOptions): () => void {
  if (typeof document === "undefined") return () => {}
  const {
    title,
    description,
    variant = "default",
    duration = DEFAULT_DURATION,
  } = opts || ({} as ToastOptions)
  if (!title) return () => {}

  const root = getContainer()
  const li = document.createElement("li") as ToastEl
  li.className = "xt-toast" + (variant !== "default" ? ` xt-toast--${variant}` : "")
  li.setAttribute("role", variant === "error" ? "alert" : "status")
  li.setAttribute("aria-live", variant === "error" ? "assertive" : "polite")

  const accent = document.createElement("div")
  accent.className = "xt-toast__accent"
  li.appendChild(accent)

  const body = document.createElement("div")
  body.className = "xt-toast__body"

  const titleEl = document.createElement("div")
  titleEl.className = "xt-toast__title"
  titleEl.textContent = title
  body.appendChild(titleEl)

  if (description) {
    const descEl = document.createElement("div")
    descEl.className = "xt-toast__desc"
    descEl.textContent = description
    body.appendChild(descEl)
  }
  li.appendChild(body)

  const closeBtn = document.createElement("button")
  closeBtn.className = "xt-toast__close"
  closeBtn.type = "button"
  closeBtn.setAttribute("aria-label", t("common.dismissNotification"))
  closeBtn.setAttribute("data-i18n-attr", "aria-label:common.dismissNotification")
  closeBtn.innerHTML = ICON_X
  li.appendChild(closeBtn)

  let progressBar: HTMLDivElement | null = null
  if (duration > 0) {
    progressBar = document.createElement("div")
    progressBar.className = "xt-toast__progress"
    li.appendChild(progressBar)
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  let timer: ReturnType<typeof setTimeout> | null = null
  let progressAnim: Animation | null = null
  let pausedAt: number | null = null
  let remaining = duration

  const doDismiss = () => dismiss(li)

  function startTimer(ms: number): void {
    if (ms <= 0) return
    timer = setTimeout(doDismiss, ms)
    if (progressBar && !reduced) {
      progressAnim = progressBar.animate(
        [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
        { duration: ms, fill: "forwards", easing: "linear" }
      )
    }
  }

  function pause(): void {
    if (timer == null || pausedAt != null) return
    clearTimeout(timer)
    pausedAt = performance.now()
    if (progressAnim) smoothRate(progressAnim, progressAnim.playbackRate, 0, 180)
  }

  function resume(): void {
    if (pausedAt == null) return
    remaining = Math.max(400, remaining - (performance.now() - pausedAt))
    pausedAt = null
    timer = setTimeout(doDismiss, remaining)
    if (progressAnim) smoothRate(progressAnim, 0, 1, 180)
  }

  if (duration > 0) startTimer(duration)

  if (!reduced) {
    li.addEventListener("mouseenter", pause)
    li.addEventListener("mouseleave", resume)
    li.addEventListener("focusin", pause)
    li.addEventListener("focusout", (e) => {
      if (!li.contains(e.relatedTarget as Node | null)) resume()
    })
  }

  closeBtn.addEventListener("click", doDismiss)

  li._xtCleanup = () => {
    if (timer) clearTimeout(timer)
    if (progressAnim) progressAnim.cancel()
  }

  root.appendChild(li)
  updateStackDepth()
  evictOverflow()

  return doDismiss
}

type ToastShortcutOpts = Omit<ToastOptions, "title" | "variant">

export const toastSuccess = (title: string, opts: ToastShortcutOpts = {}) =>
  toast({ ...opts, title, variant: "success" })
export const toastError = (title: string, opts: ToastShortcutOpts = {}) =>
  toast({ ...opts, title, variant: "error" })
export const toastWarn = (title: string, opts: ToastShortcutOpts = {}) =>
  toast({ ...opts, title, variant: "warn" })
