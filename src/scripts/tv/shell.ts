// Boots the /tv/* shell: i18n, back handling, spatial nav, the rail's active state + playlist dialog, per-route focus memory, and the view router.

import { navigate } from "astro:transitions/client"
import { initI18n, t, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { mountBackHandler } from "@/scripts/lib/back-handler"
import { mountTvInputGuard } from "@/scripts/lib/tv-input-guard"
import { initConnectivity } from "@/scripts/lib/connectivity.js"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav"
import { initUiSounds } from "@/scripts/lib/ui-sounds"
import { initHaptics } from "@/scripts/lib/haptics"
import { registerMainFocusSection, NAV_SECTION_ID } from "@/scripts/tv/focus"
import { getEntries, getActiveEntry } from "@/scripts/lib/creds.js"
import { renderPlaylistRow } from "@/scripts/lib/playlist-rows.js"
import { ICON_X } from "@/scripts/lib/icons"
import { mountTvRouter, TV_VIEW_MOUNTED_EVENT } from "@/scripts/tv/router"
import { tvNavActiveHref } from "@/scripts/lib/tv-routes"

function syncNavActiveState(): void {
  const activeHref = tvNavActiveHref(location.pathname)
  const items = document.querySelectorAll<HTMLAnchorElement>("#tv-nav a[data-tv-nav-item]")
  for (const item of items) {
    const href = item.getAttribute("href") || ""
    const active = href === activeHref
    item.dataset.tvNavActive = active ? "true" : "false"
    if (active) item.setAttribute("aria-current", "page")
    else item.removeAttribute("aria-current")
  }
}

function mountNavSync(): void {
  syncNavActiveState()
  document.addEventListener("astro:page-load", syncNavActiveState)
  document.addEventListener(LOCALE_EVENT, syncNavActiveState)
}

async function refreshPlaylistNavLabel(): Promise<void> {
  const markEl = document.getElementById("tv-nav-playlist-mark")
  const titleEl = document.getElementById("tv-nav-playlist-title")
  if (!markEl || !titleEl) return
  const active = await getActiveEntry()
  markEl.textContent = active?.emoji || (active?.title || "?").charAt(0).toUpperCase()
  titleEl.textContent = active?.title || t("tv.nav.playlist")
}

let playlistDialogEl: HTMLDialogElement | null = null

function ensurePlaylistDialog(): HTMLDialogElement {
  if (playlistDialogEl) return playlistDialogEl
  const dialog = document.createElement("dialog")
  dialog.id = "tv-playlist-dialog"
  dialog.className =
    "m-auto max-h-[70vh] w-[28rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70"
  dialog.innerHTML = `
    <div class="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
      <h2 class="text-lg font-semibold" data-i18n="tv.playlist.switchTitle">Switch playlist</h2>
      <button type="button" id="tv-playlist-dialog-close" class="rounded-lg p-2 text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Close" data-i18n-attr="aria-label:common.close">
        <span class="inline-flex text-base">${ICON_X}</span>
      </button>
    </div>
    <div id="tv-playlist-dialog-list" class="flex max-h-[55vh] flex-col overflow-y-auto p-2"></div>
  `
  document.body.appendChild(dialog)
  dialog.querySelector("#tv-playlist-dialog-close")?.addEventListener("click", () => dialog.close())
  attachDialogSpatialNav(dialog)
  playlistDialogEl = dialog
  return dialog
}

async function openPlaylistDialog(): Promise<void> {
  const dialog = ensurePlaylistDialog()
  const listEl = dialog.querySelector<HTMLElement>("#tv-playlist-dialog-list")
  if (listEl) {
    listEl.replaceChildren()
    const [entries, active] = await Promise.all([getEntries(), getActiveEntry()])
    for (const entry of entries) {
      listEl.appendChild(
        renderPlaylistRow({
          entry,
          isActive: active?._id === entry._id,
          density: "compact",
          onAfterSelect: async () => {
            dialog.close()
            try {
              await navigate(location.pathname + location.search, { history: "replace" })
            } catch {
              location.reload()
            }
          },
        })
      )
    }
  }
  if (typeof dialog.showModal === "function") dialog.showModal()
}

function mountNavPlaylistDialog(): void {
  document.getElementById("tv-nav-playlist-btn")?.addEventListener("click", () => {
    void openPlaylistDialog()
  })
  void refreshPlaylistNavLabel()
  document.addEventListener("xt:active-changed", () => void refreshPlaylistNavLabel())
  document.addEventListener("xt:entries-updated", () => void refreshPlaylistNavLabel())
}

function isNavigableElement(elem: Element): boolean {
  const fullscreenEl = document.fullscreenElement
  if (fullscreenEl && !fullscreenEl.contains(elem)) return false
  if (elem.closest("[inert]")) return false
  const rect = elem.getBoundingClientRect()
  if (rect.right <= 0 || rect.bottom <= 0) return false
  if (getComputedStyle(elem).visibility !== "visible") return false
  return true
}

const VERTICAL_KEYS: Record<string, true> = { ArrowUp: true, ArrowDown: true, PageUp: true, PageDown: true }
let verticalMovePending = false

function mountNavDirectionGuard(): void {
  document.addEventListener(
    "keydown",
    (event) => {
      verticalMovePending = !!VERTICAL_KEYS[event.key]
    },
    true
  )
}

// Up/Down must never jump sideways into the nav; only Left may enter it.
function isNavigableNavItem(elem: Element): boolean {
  if (verticalMovePending && !document.activeElement?.closest("#tv-nav")) return false
  return isNavigableElement(elem)
}

let lastMainFocused: HTMLElement | null = null

// Each view section keeps its own last-focused element, so "@main" alone can't
// resume where the user left the page when they come back out of the nav.
function mountNavReturnMemory(): void {
  document.addEventListener("focusin", (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || target.closest("#tv-nav")) return
    if (!document.getElementById("tv-main")?.contains(target)) return
    lastMainFocused = target
  })

  document.addEventListener("sn:willmove", (event) => {
    const detail = (event as CustomEvent).detail
    if (!detail || detail.direction !== "right" || detail.sectionId !== NAV_SECTION_ID) return
    const target = lastMainFocused
    if (!target || !target.isConnected || (target.offsetWidth <= 0 && target.offsetHeight <= 0)) return
    event.preventDefault()
    target.focus()
  })
}

function initSpatialNavForMain(): void {
  const spatialNav = window.SpatialNavigation
  if (!spatialNav) return
  spatialNav.init()
  // Registered before "main": the polyfill assigns an element to the first matching section.
  spatialNav.add({
    id: NAV_SECTION_ID,
    selector: "#tv-nav [data-tv-nav-item]",
    restrict: "self-only",
    enterTo: "last-focused",
    leaveFor: { right: "@main", left: "", up: "", down: "" },
    navigableFilter: isNavigableNavItem,
  })
  // Registered through focus.ts so every later view section stays ahead of it.
  registerMainFocusSection({
    selector:
      "a, button, summary, input, textarea, [contenteditable='true'], select, [tabindex]:not([tabindex='-1'])",
    leaveFor: { left: `@${NAV_SECTION_ID}`, up: "", down: "" },
    navigableFilter: (elem: Element) => {
      if (elem.closest("#tv-nav")) return false
      return isNavigableElement(elem)
    },
  })
  spatialNav.makeFocusable()
}

function mountAmbientHandoffRefresh(): void {
  if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
  setTimeout(() => {
    let isAndroidTv = false
    try {
      isAndroidTv = !!window.AndroidDeviceInfo?.isTv?.()
    } catch {}
    if (!isAndroidTv) return
    Promise.all([
      import("@/scripts/lib/ambient-handoff"),
      import("@/scripts/lib/account-info.js"),
    ]).then(([{ maybeRefreshAmbientHandoff }, { getActivePlaylistIdSync }]) => {
      void maybeRefreshAmbientHandoff(() => getActivePlaylistIdSync() || null)
    })
  }, 60_000)
}

// astro:prefetch requires the `prefetch` config flag, which is off here.
function mountPrefetchOnFocus(): void {
  const prefetched = new Set<string>()
  document.addEventListener("focusin", (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest<HTMLAnchorElement>("a[href^='/tv']")
    if (!anchor || !anchor.href || prefetched.has(anchor.href)) return
    prefetched.add(anchor.href)
    try {
      const link = document.createElement("link")
      link.rel = "prefetch"
      link.href = anchor.href
      document.head.appendChild(link)
    } catch {}
  })
}

function focusKeyStorageKey(): string {
  return `xt_tv_focus:${location.pathname}`
}

const RESTORE_FOCUS_WAIT_MS = 2500

let cancelRestoreWait: (() => void) | null = null
// Initial full loads never see a swap event, so they count as forward.
let lastSwapDirection = "forward"

function stopRestoreWait(): void {
  const cancel = cancelRestoreWait
  cancelRestoreWait = null
  cancel?.()
}

function focusFirstAvailable(main: HTMLElement): void {
  const target =
    main.querySelector<HTMLElement>("[data-tv-autofocus]") ||
    main.querySelector<HTMLElement>("[data-focus-key]")
  if (target) {
    target.focus()
    return
  }
  document.querySelector<HTMLElement>('#tv-nav a[data-tv-nav-active="true"]')?.focus()
}

function restoreFocus(): void {
  const main = document.getElementById("tv-main")
  if (!main) return
  stopRestoreWait()

  // Focus memory is a Back affordance; a forward visit always starts at the view's default.
  if (lastSwapDirection !== "back") {
    try {
      sessionStorage.removeItem(focusKeyStorageKey())
    } catch {}
    focusFirstAvailable(main)
    return
  }

  let storedKey = ""
  try {
    storedKey = sessionStorage.getItem(focusKeyStorageKey()) || ""
  } catch {}

  const storedSelector = storedKey ? `[data-focus-key="${CSS.escape(storedKey)}"]` : ""
  if (storedSelector) {
    const target = main.querySelector<HTMLElement>(storedSelector)
    if (target) {
      target.focus()
      return
    }
  }
  if (main.querySelector("[data-tv-autofocus]") || !storedSelector) {
    focusFirstAvailable(main)
    return
  }

  // Views populate asynchronously, so the stored row can land after the mount event.
  const focusAtWaitStart = document.activeElement
  let userInteracted = false
  const noteInteraction = (): void => {
    userInteracted = true
  }
  window.addEventListener("keydown", noteInteraction, true)
  window.addEventListener("pointerdown", noteInteraction, true)

  const observer = new MutationObserver(() => {
    const appeared = main.querySelector<HTMLElement>(storedSelector)
    if (!appeared) return
    stopRestoreWait()
    const active = document.activeElement
    // A view autofocusing its own first row is not the user moving on.
    const userMovedOn =
      userInteracted && active instanceof HTMLElement && main.contains(active) && active !== focusAtWaitStart
    if (!userMovedOn) appeared.focus()
  })
  observer.observe(main, { childList: true, subtree: true })

  const timeoutId = window.setTimeout(() => {
    stopRestoreWait()
    const active = document.activeElement
    if (active instanceof HTMLElement && main.contains(active)) return
    focusFirstAvailable(main)
  }, RESTORE_FOCUS_WAIT_MS)

  cancelRestoreWait = () => {
    observer.disconnect()
    window.clearTimeout(timeoutId)
    window.removeEventListener("keydown", noteInteraction, true)
    window.removeEventListener("pointerdown", noteInteraction, true)
  }
}

// Astro's swapRootAttributes replaces <html>'s attributes and TvLayout's pre-paint script doesn't re-run.
function mountRootAttributeCarryOver(): void {
  document.addEventListener("astro:before-swap", (event) => {
    const incoming = event.newDocument?.documentElement
    if (!incoming) return
    for (const attr of Array.from(document.documentElement.attributes)) {
      const name = attr.name
      if (name.startsWith("data-astro-transition")) continue
      if (name === "style" || name === "lang" || name === "dir" || name.startsWith("data-")) {
        incoming.setAttribute(name, attr.value)
      }
    }
  })
}

function mountFocusMemory(): void {
  document.addEventListener("astro:before-swap", (event) => {
    lastSwapDirection = event.direction
    stopRestoreWait()
    const active = document.activeElement
    const focusKeyEl = active instanceof Element ? active.closest<HTMLElement>("[data-focus-key]") : null
    // Leaving via the rail must not overwrite a still-useful key.
    if (!focusKeyEl || !document.getElementById("tv-main")?.contains(focusKeyEl)) return
    try {
      sessionStorage.setItem(focusKeyStorageKey(), focusKeyEl.dataset.focusKey || "")
    } catch {}
  })

  document.addEventListener(TV_VIEW_MOUNTED_EVENT, () => {
    restoreFocus()
    const active = document.activeElement
    if (!active || active === document.body) {
      try {
        window.SpatialNavigation?.makeFocusable()
        window.SpatialNavigation?.focus()
      } catch {}
    }
  })
}

export function bootTvShell(): void {
  void initI18n()
  mountBackHandler()
  mountTvInputGuard()
  initConnectivity()
  initUiSounds()
  initHaptics()
  mountNavDirectionGuard()
  mountNavReturnMemory()
  initSpatialNavForMain()
  mountRootAttributeCarryOver()
  mountAmbientHandoffRefresh()
  mountNavSync()
  mountNavPlaylistDialog()
  mountPrefetchOnFocus()
  mountFocusMemory()
  mountTvRouter()
}
