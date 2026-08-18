// Shared right-click / long-press context menu for movie and series posters.
// Mirrors the channel-list menu in `stream.ts` so all three grids feel
// consistent: same dismissal behaviour (outside-click / Escape / blur /
// resize / scroll), same long-press threshold, same visual style.
//
// The menu items differ per kind:
//   vod    - Open, Favorite, Watchlist, Watched, Download, Copy stream URL
//   series - Open, Favorite, Watchlist, Watched
// (Download and stream URL don't apply at the series level - those are
// per-episode and live on the detail page.)

import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { toast } from "@/scripts/lib/toast.js"
import {
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  isCompleted,
  markCompleted,
  clearProgress,
  hasSeriesWatchedOverride,
  setSeriesWatchedOverride,
} from "@/scripts/lib/preferences.js"

export type PosterMenuKind = "vod" | "series"

export interface PosterMenuEntry {
  id: string | number
  name?: string | null
  logo?: string | null
}

export interface PosterMenuOptions {
  kind: PosterMenuKind
  entry: PosterMenuEntry
  activePlaylistId: string
  anchor: HTMLElement
  point: { x: number; y: number } | null
  onOpen: () => void
  /** vod only - kicks off the download queue for this movie. */
  onDownload?: () => void
  /** vod only - returns the canonical stream URL for the clipboard. */
  buildStreamUrl?: () => string | null
  /** Opt-in group-aware overrides, mirroring entry-card.ts's star/badge hooks; read at menu-open time, not memoized. */
  favoriteActive?: () => boolean
  onToggleFavorite?: (currentlyFavorited: boolean) => void
  watchlistActive?: () => boolean
  onToggleWatchlist?: (currentlyOnWatchlist: boolean) => void
  watchedActive?: () => boolean
  onToggleWatched?: (currentlyWatched: boolean) => void
}

const MENU_ID = "xt-poster-menu"

let menuEl: HTMLElement | null = null

function closeMenu() {
  if (!menuEl) return
  menuEl.remove()
  menuEl = null
  document.removeEventListener("pointerdown", onMenuOutside, true)
  document.removeEventListener("keydown", onMenuKey, true)
  window.removeEventListener("blur", closeMenu)
  window.removeEventListener("resize", closeMenu)
  window.removeEventListener("scroll", closeMenu, true)
}

function onMenuOutside(event: PointerEvent) {
  if (!menuEl) return
  if (menuEl.contains(event.target as Node)) return
  closeMenu()
}

function onMenuKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault()
    closeMenu()
  }
}

function makeItem(label: string, handler: () => void): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.setAttribute("role", "menuitem")
  btn.className =
    "w-full text-left px-3 py-2.5 min-h-11 rounded-lg text-sm " +
    "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-accent " +
    "outline-none transition-colors"
  btn.textContent = label
  btn.addEventListener("click", () => {
    closeMenu()
    try {
      handler()
    } catch (error) {
      log.warn("[xt:poster-menu] handler threw:", error)
    }
  })
  return btn
}

export function openPosterMenu(opts: PosterMenuOptions): void {
  closeMenu()
  const { kind, entry, activePlaylistId, anchor, point } = opts
  const playlistId = activePlaylistId || ""

  const menu = document.createElement("div")
  menu.id = MENU_ID
  menu.className =
    "fixed z-50 min-w-[12rem] rounded-xl border border-line bg-surface text-fg shadow-2xl " +
    "p-1 flex flex-col gap-0.5 poster-menu-enter"
  menu.setAttribute("role", "menu")
  menu.setAttribute(
    "aria-label",
    t("list.menu.ariaFor", { name: entry.name || t("list.fallbackTitle") })
  )

  // Open
  menu.appendChild(makeItem(t("list.menu.open"), () => opts.onOpen()))

  // Favorite toggle - label flips between add/remove based on state
  const favOn = opts.favoriteActive
    ? opts.favoriteActive()
    : playlistId
      ? isFavorite(playlistId, kind, entry.id)
      : false
  menu.appendChild(
    makeItem(
      t(favOn ? "list.menu.favoriteRemove" : "list.menu.favoriteAdd"),
      () => {
        if (opts.onToggleFavorite) {
          opts.onToggleFavorite(favOn)
          return
        }
        if (!playlistId) return
        toggleFavorite(playlistId, kind, entry.id, {
          name: entry.name || "",
          logo: entry.logo || null,
        })
      }
    )
  )

  // Watchlist toggle - same pattern
  const watchOn = opts.watchlistActive
    ? opts.watchlistActive()
    : playlistId
      ? isOnWatchlist(playlistId, kind, entry.id)
      : false
  menu.appendChild(
    makeItem(
      t(watchOn ? "list.menu.watchlistRemove" : "list.menu.watchlistAdd"),
      () => {
        if (opts.onToggleWatchlist) {
          opts.onToggleWatchlist(watchOn)
          return
        }
        if (!playlistId) return
        toggleWatchlist(playlistId, kind, entry.id, {
          name: entry.name || "",
          logo: entry.logo || null,
        })
      }
    )
  )

  // Watched toggle - vod tracks completion, series uses a manual override
  const watchedOn = opts.watchedActive
    ? opts.watchedActive()
    : playlistId
      ? kind === "vod"
        ? isCompleted(playlistId, "vod", entry.id)
        : hasSeriesWatchedOverride(playlistId, entry.id)
      : false
  menu.appendChild(
    makeItem(
      t(watchedOn ? "list.menu.watchedUnmark" : "list.menu.watchedMark"),
      () => {
        if (opts.onToggleWatched) {
          opts.onToggleWatched(watchedOn)
          return
        }
        if (!playlistId) return
        if (kind === "vod") {
          if (watchedOn) clearProgress(playlistId, "vod", entry.id)
          else {
            markCompleted(playlistId, "vod", entry.id, {
              name: entry.name || "",
              logo: entry.logo || null,
            })
          }
        } else {
          setSeriesWatchedOverride(playlistId, entry.id, !watchedOn)
        }
      }
    )
  )

  // VOD-only items
  if (kind === "vod") {
    if (opts.onDownload) {
      menu.appendChild(makeItem(t("list.menu.download"), () => opts.onDownload!()))
    }
    if (opts.buildStreamUrl) {
      menu.appendChild(
        makeItem(t("stream.menu.test"), () => {
          const url = opts.buildStreamUrl!()
          if (!url) return
          import("@/scripts/lib/stream-diagnostic-dialog.js").then(({ openStreamDiagnostic }) => {
            openStreamDiagnostic({ url, title: entry.name || "" })
          })
        })
      )
      menu.appendChild(
        makeItem(t("list.menu.copyUrl"), async () => {
          const url = opts.buildStreamUrl!()
          if (!url) return
          try {
            const { writeClipboardText } = await import("@/scripts/lib/clipboard")
            await writeClipboardText(url)
            toast({ title: t("stream.toast.copied"), duration: 2200 })
          } catch (error) {
            log.warn("[xt:poster-menu] copy stream URL failed:", error)
            toast({ title: t("toast.copyError"), variant: "warn", duration: 2800 })
          }
        })
      )
    }
  }

  document.body.appendChild(menu)

  // Position: prefer the click point; clamp to viewport.
  const margin = 8
  const rect = menu.getBoundingClientRect()
  let left: number
  let top: number
  if (point) {
    left = Math.min(point.x, window.innerWidth - rect.width - margin)
    top = Math.min(point.y, window.innerHeight - rect.height - margin)
  } else {
    const anchorRect = anchor.getBoundingClientRect()
    left = Math.min(anchorRect.right + 6, window.innerWidth - rect.width - margin)
    top = Math.min(anchorRect.top, window.innerHeight - rect.height - margin)
  }
  menu.style.left = `${Math.max(margin, left)}px`
  menu.style.top = `${Math.max(margin, top)}px`

  menuEl = menu
  document.addEventListener("pointerdown", onMenuOutside, true)
  document.addEventListener("keydown", onMenuKey, true)
  window.addEventListener("blur", closeMenu)
  window.addEventListener("resize", closeMenu)
  window.addEventListener("scroll", closeMenu, true)

  // Focus the first item so D-pad / keyboard can step through.
  const first = menu.querySelector<HTMLButtonElement>("button[role='menuitem']")
  first?.focus({ preventScroll: true })
}

const LONG_PRESS_MS = 500

/**
 * Wire right-click + long-press handlers onto a card root. The card stays
 * focusable / clickable for the normal "open detail" path; only contextmenu
 * and touch long-press open the menu.
 */
export function attachPosterContextMenu(
  cardRoot: HTMLElement,
  open: (anchor: HTMLElement, point: { x: number; y: number } | null) => void
): void {
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let pressX = 0
  let pressY = 0
  let triggered = false
  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }

  cardRoot.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    if (triggered) return
    open(cardRoot, { x: event.clientX, y: event.clientY })
  })

  cardRoot.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return
    triggered = false
    pressX = event.clientX
    pressY = event.clientY
    cancelPress()
    pressTimer = setTimeout(() => {
      triggered = true
      open(cardRoot, { x: pressX, y: pressY })
    }, LONG_PRESS_MS)
  })
  cardRoot.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") return
    const dx = Math.abs(event.clientX - pressX)
    const dy = Math.abs(event.clientY - pressY)
    if (dx > 8 || dy > 8) cancelPress()
  })
  cardRoot.addEventListener("pointerup", () => cancelPress())
  cardRoot.addEventListener("pointercancel", () => cancelPress())
  // Suppress the click that follows a long-press so we don't open detail too.
  cardRoot.addEventListener(
    "click",
    (event) => {
      if (triggered) {
        event.preventDefault()
        event.stopPropagation()
        triggered = false
      }
    },
    true
  )
}
