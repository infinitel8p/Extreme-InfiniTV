// Subtitle-delay adjust dialog + Z/X keyboard shortcuts, shared by movies/series
// detail. Mirrors video-scale-dialog.ts (styled <dialog>, appended once, reused).

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { toast } from "@/scripts/lib/toast.js"
import { ICON_CLOCK_EDIT } from "@/scripts/lib/icons.ts"

export interface SubtitleDelayDialogOptions {
  dialogId: string
  button: HTMLElement | null
  /** Nudge the active player's subtitle delay; null/undefined when nothing is showing. */
  nudge: (deltaSeconds: number) => number | null | undefined
  /** Video element hosting subtitle tracks; drives button visibility via textTracks events. */
  getMediaElement?: () => HTMLVideoElement | null
}

export interface SubtitleDelayController {
  setup(): void
  teardown(): void
  handleKeydown(event: KeyboardEvent): void
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (typeof element.closest === "function" && element.closest("dialog[open]")) return true
  return false
}

export function formatSubtitleDelay(offsetSeconds: number): string {
  return `${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds.toFixed(1)}s`
}

export function createSubtitleDelayController(options: SubtitleDelayDialogOptions): SubtitleDelayController {
  const { dialogId, button, nudge, getMediaElement } = options
  let dialogEl: HTMLDialogElement | null = null
  let dialogValueEl: HTMLElement | null = null
  let dialogResetBtn: HTMLButtonElement | null = null
  let syncTimer: ReturnType<typeof setInterval> | null = null
  let dismissToast: (() => void) | null = null
  let buttonBound = false
  let boundTrackList: TextTrackList | null = null

  function currentOffset(): number | null {
    return nudge(0) ?? null
  }

  // Hidden unless a subtitle track is currently showing, not just built.
  function syncButton(): void {
    if (!button) return
    if (currentOffset() == null) button.setAttribute("hidden", "")
    else button.removeAttribute("hidden")
  }

  function onTrackListEvent(): void {
    syncButton()
  }

  // The video element (and its textTracks list) is swapped per playback session.
  function bindTrackList(): void {
    const list = getMediaElement?.()?.textTracks ?? null
    if (list === boundTrackList) return
    if (boundTrackList) {
      boundTrackList.removeEventListener("change", onTrackListEvent)
      boundTrackList.removeEventListener("addtrack", onTrackListEvent)
      boundTrackList.removeEventListener("removetrack", onTrackListEvent)
    }
    boundTrackList = list
    if (boundTrackList) {
      boundTrackList.addEventListener("change", onTrackListEvent)
      boundTrackList.addEventListener("addtrack", onTrackListEvent)
      boundTrackList.addEventListener("removetrack", onTrackListEvent)
    }
    syncButton()
  }

  function unbindTrackList(): void {
    if (!boundTrackList) return
    boundTrackList.removeEventListener("change", onTrackListEvent)
    boundTrackList.removeEventListener("addtrack", onTrackListEvent)
    boundTrackList.removeEventListener("removetrack", onTrackListEvent)
    boundTrackList = null
  }

  function updateDialogValue(offsetSeconds: number): void {
    if (dialogValueEl) dialogValueEl.textContent = formatSubtitleDelay(offsetSeconds)
    if (dialogResetBtn) dialogResetBtn.disabled = Math.abs(offsetSeconds) < 0.05
  }

  function nudgeDelay(deltaSeconds: number): void {
    const newOffset = nudge(deltaSeconds)
    if (newOffset == null) return
    const rounded = Math.round(newOffset * 10) / 10
    updateDialogValue(rounded)
    syncButton()
    if (dialogEl?.hasAttribute("open")) return
    dismissToast?.()
    dismissToast = toast({
      title: t("player.subtitleDelay", { value: formatSubtitleDelay(rounded) }),
      duration: 1500,
    })
  }

  function ensureDialog(): HTMLDialogElement {
    if (dialogEl) return dialogEl
    const node = document.createElement("dialog")
    node.id = dialogId
    node.setAttribute("aria-labelledby", `${dialogId}-title`)
    node.className = [
      "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
      "w-[min(20rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)]",
      "open:flex flex-col overflow-hidden",
      "backdrop:bg-black/30",
    ].join(" ")
    node.innerHTML = `
      <div class="flex flex-col flex-auto min-h-0 gap-4 p-5 overflow-y-auto">
        <header class="flex items-center gap-3">
          <span class="icon-mark" aria-hidden="true">${ICON_CLOCK_EDIT}</span>
          <h2 id="${dialogId}-title" data-role="title" class="text-base font-semibold"></h2>
        </header>
        <div class="flex items-center justify-center gap-3">
          <button
            type="button"
            data-role="minus"
            class="shrink-0 rounded-lg border border-line min-h-11 min-w-11 inline-flex items-center justify-center text-fg-3
                   hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg focus-visible:border-accent
                   active:scale-[0.98] outline-none transition-colors">-</button>
          <span data-role="value" role="status" aria-live="polite" class="min-w-16 text-center text-base font-medium tabular-nums">0.0s</span>
          <button
            type="button"
            data-role="plus"
            class="shrink-0 rounded-lg border border-line min-h-11 min-w-11 inline-flex items-center justify-center text-fg-3
                   hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg focus-visible:border-accent
                   active:scale-[0.98] outline-none transition-colors">+</button>
        </div>
        <div class="flex justify-between gap-2">
          <button
            type="button"
            data-role="reset"
            class="inline-flex items-center justify-center min-h-11 rounded-xl border border-line px-4 text-sm transition-colors
                   hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent
                   disabled:opacity-60 disabled:cursor-not-allowed disabled:pointer-events-none"></button>
          <button
            type="button"
            data-role="close"
            class="inline-flex items-center justify-center min-h-11 rounded-xl border border-line px-4 text-sm transition-colors
                   hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"></button>
        </div>
      </div>
    `
    document.body.appendChild(node)
    attachDialogSpatialNav(node, {
      defaultElement: `#${dialogId} [data-role="minus"]`,
    })

    node.querySelector('[data-role="close"]')?.addEventListener("click", () => node.close())
    node.addEventListener("click", (event) => {
      if (event.target === node) node.close()
    })
    node.querySelector('[data-role="minus"]')?.addEventListener("click", () => nudgeDelay(-0.1))
    node.querySelector('[data-role="plus"]')?.addEventListener("click", () => nudgeDelay(0.1))
    node.querySelector('[data-role="reset"]')?.addEventListener("click", () => {
      const current = currentOffset()
      if (current != null) nudgeDelay(Math.round(-current * 10) / 10)
    })

    dialogEl = node
    dialogValueEl = node.querySelector('[data-role="value"]')
    dialogResetBtn = node.querySelector<HTMLButtonElement>('[data-role="reset"]')
    return node
  }

  function openDialog(): void {
    const node = ensureDialog()
    const titleEl = node.querySelector<HTMLElement>('[data-role="title"]')
    if (titleEl) titleEl.textContent = t("detail.subtitleDelay")
    node.querySelector('[data-role="minus"]')?.setAttribute("aria-label", t("detail.subtitleDelayEarlier"))
    node.querySelector('[data-role="plus"]')?.setAttribute("aria-label", t("detail.subtitleDelayLater"))
    const resetBtn = node.querySelector<HTMLElement>('[data-role="reset"]')
    if (resetBtn) resetBtn.textContent = t("detail.subtitleDelayReset")
    const closeBtn = node.querySelector<HTMLElement>('[data-role="close"]')
    if (closeBtn) closeBtn.textContent = t("common.close")
    updateDialogValue(currentOffset() ?? 0)
    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  }

  function setup(): void {
    bindTrackList()
    // Fallback net for element swaps the events above might miss.
    if (!syncTimer) syncTimer = setInterval(bindTrackList, 5000)
    if (buttonBound) return
    buttonBound = true
    button?.addEventListener("click", () => openDialog())
  }

  function teardown(): void {
    if (syncTimer) {
      clearInterval(syncTimer)
      syncTimer = null
    }
    unbindTrackList()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (isTypingTarget(event.target)) return
    const key = event.key.toLowerCase()
    if (key !== "z" && key !== "x") return
    nudgeDelay(key === "z" ? -0.1 : 0.1)
  }

  return { setup, teardown, handleKeydown }
}
