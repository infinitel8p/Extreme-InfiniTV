// TV D-pad focus can land on text inputs without popping the IME; the keyboard
// should only open on an explicit OK/Enter ("edit mode"), not on plain focus.
import { isTvDevice } from "@/scripts/lib/tv-detect"

const GUARDED_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
])

function isGuardedElement(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false
  if (el.dataset.tvInputGuard === "off") return false
  if (el.hasAttribute("readonly")) return false
  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute("type") || "").toLowerCase()
    if (!GUARDED_INPUT_TYPES.has(type)) return false
  }
  return true
}

function isEditing(el: HTMLElement): boolean {
  return el.dataset.tvEditing !== undefined
}

// De-dupes the native DPAD_CENTER forward on devices that also deliver a DOM Enter.
let lastDomEnterAt = 0

// Mirrors tv/router.ts's TV_VIEW_MOUNTED_EVENT string without importing the TV router into
// this shared (classic + TV) module.
const TV_VIEW_MOUNTED_EVENT = "xt:tv-view-mounted"

function stampGuarded(el: HTMLElement): void {
  if (isEditing(el)) return
  if (el.dataset.tvGuarded !== "1") {
    const origInputmode = el.getAttribute("inputmode")
    if (origInputmode !== null) el.dataset.tvOrigInputmode = origInputmode
    el.dataset.tvGuarded = "1"
  }
  el.setAttribute("inputmode", "none")
}

// Focus must stay put while the IME opens: any blur/focus churn here tears down the
// InputConnection the delayed native showSoftInput builds against.
function enterEditMode(el: HTMLElement): void {
  if (isEditing(el)) return
  const origInputmode = el.dataset.tvOrigInputmode
  if (origInputmode !== undefined) el.setAttribute("inputmode", origInputmode)
  else el.removeAttribute("inputmode")
  el.dataset.tvEditing = "1"
  if (document.activeElement !== el) el.focus()
  try { window.AndroidIme?.show?.() } catch {}
}

function exitEditMode(el: HTMLElement): void {
  if (!isEditing(el)) return
  delete el.dataset.tvEditing
  el.setAttribute("inputmode", "none")
  try { window.AndroidIme?.hide?.() } catch {}
}

function stampAll(root: ParentNode): void {
  root.querySelectorAll("input, textarea").forEach((el) => {
    if (isGuardedElement(el)) stampGuarded(el)
  })
}

export function mountTvInputGuard(): void {
  if (!isTvDevice()) return

  // The TV shell (TvLayout.astro) always has a #tv-main whose content the router replaces
  // wholesale per view mount; scoping there (and re-stamping on those two events instead of
  // reacting to every added node) is much cheaper than a document-wide observer. The classic
  // UI has no #tv-main, so it keeps the original document-wide, mutation-driven behavior for
  // dynamically inserted dialogs (category picker, etc).
  const tvMain = document.getElementById("tv-main")

  stampAll(tvMain || document)

  if (tvMain) {
    const restamp = () => stampAll(document.getElementById("tv-main") || document)
    document.addEventListener("astro:page-load", restamp)
    document.addEventListener(TV_VIEW_MOUNTED_EVENT, restamp)
  } else {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return
          if (isGuardedElement(node)) stampGuarded(node)
          stampAll(node)
        })
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  window.addEventListener(
    "keydown",
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !isGuardedElement(target)) return
      if (event.key === "Enter") {
        event.preventDefault()
        event.stopImmediatePropagation()
        lastDomEnterAt = Date.now()
        if (isEditing(target)) exitEditMode(target)
        else enterEditMode(target)
      } else if (event.key === "Escape" && isEditing(target)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        exitEditMode(target)
      }
    },
    true
  )

  window.addEventListener("focusout", (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !isGuardedElement(target)) return
    exitEditMode(target)
  })

  // BACK closes the IME inside the keyboard window, invisible to the page; the
  // viewport growing back to full height is the only reliable closure signal.
  const viewport = window.visualViewport
  if (viewport) {
    let maxViewportHeight = viewport.height
    viewport.addEventListener("resize", () => {
      if (viewport.height > maxViewportHeight) maxViewportHeight = viewport.height
      if (viewport.height < maxViewportHeight - 40) return
      const active = document.activeElement
      if (active instanceof HTMLElement && isGuardedElement(active) && isEditing(active)) {
        exitEditMode(active)
      }
    })
  }

  ;(window as any).__xtRemoteOk = () => {
    if (Date.now() - lastDomEnterAt < 250) return
    const el = document.activeElement
    if (!(el instanceof HTMLElement) || !isGuardedElement(el)) return
    if (isEditing(el)) exitEditMode(el)
    else enterEditMode(el)
  }
}
