// Radiogroup track picker for the mpv-embedded control bar, shared by the audio and subtitle menus.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.js"
import { ICON_LANGUAGE, ICON_BADGE_CC } from "@/scripts/lib/icons.js"

const DIALOG_ID = "xt-mpv-track-dialog"

export type MpvTrackDialogKind = "audio" | "subtitles"

export interface MpvTrackDialogItem {
  id: string | null
  label: string
  active: boolean
}

export interface MpvTrackDialogResult {
  id: string | null
}

const DIALOG_META: Record<MpvTrackDialogKind, { titleKey: string; icon: string }> = {
  audio: { titleKey: "player.audio", icon: ICON_LANGUAGE },
  subtitles: { titleKey: "player.subtitles", icon: ICON_BADGE_CC },
}

let dlg: HTMLDialogElement | null = null
let resolveFn: ((value: MpvTrackDialogResult | null) => void) | null = null

function ensureDialog(): HTMLDialogElement {
  if (dlg) return dlg
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(22rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)]",
    "open:flex flex-col overflow-hidden",
    "backdrop:bg-black/30",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col flex-auto min-h-0 gap-4 p-5 overflow-y-auto">
      <header class="flex items-center gap-3">
        <span class="icon-mark" data-role="icon" aria-hidden="true"></span>
        <h2 id="${DIALOG_ID}-title" data-role="title" class="text-base font-semibold"></h2>
      </header>
      <div data-role="list" role="radiogroup" aria-labelledby="${DIALOG_ID}-title" class="flex flex-col gap-2"></div>
      <div class="flex justify-end">
        <button
          type="button"
          data-role="close"
          class="inline-flex items-center justify-center min-h-11 rounded-xl border border-line px-4 text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"
        ></button>
      </div>
    </div>
  `
  document.body.appendChild(node)
  attachDialogSpatialNav(node, {
    defaultElement: `#${DIALOG_ID} [data-role="track-btn"][aria-checked="true"]`,
  })

  node.querySelector('[data-role="close"]')?.addEventListener("click", () => node.close())
  node.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target === node) {
      node.close()
      return
    }
    const btn = target.closest<HTMLElement>('[data-role="track-btn"]')
    if (!btn) return
    settle({ id: btn.dataset.trackId || null })
    node.close()
  })
  // Esc or any non-pick close resolves null.
  node.addEventListener("close", () => settle(null))

  dlg = node
  return dlg
}

function settle(value: MpvTrackDialogResult | null): void {
  if (!resolveFn) return
  const fn = resolveFn
  resolveFn = null
  fn(value)
}

export function openMpvTrackDialog(
  kind: MpvTrackDialogKind,
  items: MpvTrackDialogItem[],
): Promise<MpvTrackDialogResult | null> {
  return new Promise((resolve) => {
    const node = ensureDialog()
    // If a prior dialog is still open, settle it as cancelled before overwriting the resolver.
    settle(null)
    resolveFn = resolve

    const meta = DIALOG_META[kind]
    const titleEl = node.querySelector<HTMLElement>('[data-role="title"]')
    if (titleEl) titleEl.textContent = t(meta.titleKey)
    const iconEl = node.querySelector<HTMLElement>('[data-role="icon"]')
    if (iconEl) iconEl.innerHTML = meta.icon
    const closeBtn = node.querySelector<HTMLButtonElement>('[data-role="close"]')
    if (closeBtn) closeBtn.textContent = t("common.close")

    const list = node.querySelector<HTMLElement>('[data-role="list"]')
    if (list) {
      list.innerHTML = items
        .map(
          (item) => `
        <button
          type="button"
          role="radio"
          aria-checked="${item.active}"
          data-role="track-btn"
          data-track-id="${item.id ?? ""}"
          class="flex items-center w-full text-left gap-3 min-h-11 px-3.5 py-2.5 rounded-xl border transition-colors scroll-my-2 ${
            item.active
              ? "border-accent bg-surface-2"
              : "border-line bg-surface hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"
          }"
        >
          <span class="grow text-sm font-medium">${escapeHtml(item.label)}</span>
          <span aria-hidden="true" class="size-4 shrink-0 inline-flex items-center justify-center rounded-full border ${item.active ? "border-accent" : "border-line"}">
            <span class="size-2 rounded-full bg-accent ${item.active ? "" : "hidden"}"></span>
          </span>
        </button>
      `,
        )
        .join("")
    }

    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  })
}
