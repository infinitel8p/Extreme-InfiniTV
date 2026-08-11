// "Display mode" picker for Live TV - lets the viewer fix a wrong-aspect
// channel via fit/stretch/zoom/16:9/4:3, per-channel or globally. Mirrors
// confirm-dialog.ts (styled <dialog>, resolved once, reused across opens).

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { ICON_ASPECT_RATIO } from "@/scripts/lib/icons.ts"
import { VIDEO_SCALE_MODES, type VideoScaleMode } from "@/scripts/lib/video-scale.ts"

const DIALOG_ID = "xt-video-scale-dialog"

let dlg: HTMLDialogElement | null = null
let resolveFn: ((value: VideoScaleDialogResult | null) => void) | null = null
let previewFn: ((mode: VideoScaleMode) => void) | null = null
let lastPreviewedMode: VideoScaleMode | null = null

export interface VideoScaleDialogOpts {
  currentMode: VideoScaleMode
  applyAllDefault?: boolean
  /** i18n key for the "apply to all" checkbox label. Defaults to the Live TV wording. */
  applyAllLabelKey?: string
  /** Fired on focus/hover of a row so the video can preview the mode before it's picked. */
  onPreview?: (mode: VideoScaleMode) => void
}

export interface VideoScaleDialogResult {
  mode: VideoScaleMode
  applyToAll: boolean
}

const SCHEMATIC_FRAME = '<rect x="1.5" y="1.5" width="37" height="21" rx="3" />'

function schematicSvg(inner: string): string {
  return `<svg viewBox="0 0 40 24" width="40" height="24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="shrink-0">${SCHEMATIC_FRAME}${inner}</svg>`
}

// Schematics: outer rounded rect is always the frame, inner shape is the content box.
const SCHEMATICS: Record<VideoScaleMode, string> = {
  fit: schematicSvg('<rect x="13" y="2.5" width="14" height="19" rx="1.5" fill="currentColor" fill-opacity="0.12" />'),
  fill: schematicSvg(
    '<rect x="1.5" y="1.5" width="37" height="21" rx="3" fill="currentColor" fill-opacity="0.12" stroke="none" />' +
      '<path d="M13 12h14" /><path d="M16 9l-3 3l3 3" /><path d="M24 9l3 3l-3 3" />'
  ),
  zoom: schematicSvg(
    '<clipPath id="xt-scale-zoom-clip"><rect x="1.5" y="1.5" width="37" height="21" rx="3" /></clipPath>' +
      '<g clip-path="url(#xt-scale-zoom-clip)"><rect x="-2" y="-2" width="44" height="28" rx="2" fill="currentColor" fill-opacity="0.12" /></g>'
  ),
  "16:9": schematicSvg('<rect x="3" y="2.5" width="34" height="19" rx="1.5" fill="currentColor" fill-opacity="0.12" />'),
  "4:3": schematicSvg('<rect x="10" y="4.5" width="20" height="15" rx="1.5" fill="currentColor" fill-opacity="0.12" />'),
}

export function videoScaleModeLabelKey(mode: VideoScaleMode): string {
  if (mode === "fit") return "stream.scale.fit"
  if (mode === "fill") return "stream.scale.fill"
  if (mode === "zoom") return "stream.scale.zoom"
  if (mode === "16:9") return "stream.scale.ratio169"
  return "stream.scale.ratio43"
}

function ensureDialog(): HTMLDialogElement {
  if (dlg) return dlg
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(24rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)]",
    "open:flex flex-col overflow-hidden",
    "backdrop:bg-black/30",
  ].join(" ")

  const rows = VIDEO_SCALE_MODES.map((mode) => `
    <button
      type="button"
      role="radio"
      aria-checked="false"
      data-role="mode-btn"
      data-mode="${mode}"
      class="flex items-center w-full text-left gap-3 min-h-11 px-3.5 py-2.5 rounded-xl border border-line bg-surface hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98] transition-colors scroll-my-2"
    >
      <span data-role="mode-glyph" class="shrink-0">${SCHEMATICS[mode]}</span>
      <span data-role="mode-label" class="grow text-sm font-medium"></span>
      <span data-role="mode-radio" aria-hidden="true" class="size-4 shrink-0 inline-flex items-center justify-center rounded-full border border-line transition-colors">
        <span data-role="mode-radio-dot" class="size-2 rounded-full bg-accent hidden"></span>
      </span>
    </button>
  `).join("")

  node.innerHTML = `
    <div class="flex flex-col flex-auto min-h-0 gap-4 p-5 overflow-y-auto">
      <header class="flex items-center gap-3">
        <span class="icon-mark" aria-hidden="true">${ICON_ASPECT_RATIO}</span>
        <h2 id="${DIALOG_ID}-title" data-role="title" class="text-base font-semibold"></h2>
      </header>
      <div data-role="list" role="radiogroup" aria-labelledby="${DIALOG_ID}-title" class="flex flex-col gap-2">${rows}</div>
      <label class="flex items-center gap-2.5 min-h-11 text-sm text-fg-2 px-3 py-2 rounded-lg cursor-pointer select-none hover:text-fg focus-within:text-fg">
        <span class="relative inline-flex w-9 h-5 shrink-0">
          <input type="checkbox" data-role="apply-all" class="sr-only peer" />
          <span class="absolute inset-0 rounded-full border border-line bg-surface-2 transition-colors peer-checked:bg-accent peer-checked:border-accent peer-focus-visible:ring-1 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface"></span>
          <span class="absolute top-0.5 left-0.5 rtl:left-auto rtl:right-0.5 size-4 rounded-full bg-fg-2 transition-transform peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4 peer-checked:bg-bg"></span>
        </span>
        <span data-role="apply-all-label"></span>
      </label>
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
    defaultElement: `#${DIALOG_ID} [data-role="mode-btn"][aria-checked="true"]`,
  })

  node.querySelector('[data-role="close"]')?.addEventListener("click", () => node.close())
  node.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target === node) {
      node.close()
      return
    }
    const btn = target.closest<HTMLElement>('[data-role="mode-btn"]')
    if (!btn) return
    const mode = normalizeButtonMode(btn.dataset.mode)
    if (!mode) return
    const applyAll = !!node.querySelector<HTMLInputElement>('[data-role="apply-all"]')?.checked
    settle({ mode, applyToAll: applyAll })
    node.close()
  })
  // Esc or any non-pick close resolves null.
  node.addEventListener("close", () => settle(null))

  const list = node.querySelector<HTMLElement>('[data-role="list"]')
  // focusin bubbles; pointerenter doesn't, so it's delegated via the capture phase instead.
  list?.addEventListener("focusin", firePreview)
  list?.addEventListener("pointerenter", firePreview, true)

  dlg = node
  return dlg
}

function firePreview(event: Event): void {
  if (!previewFn) return
  const target = event.target as HTMLElement | null
  const btn = target?.closest<HTMLElement>('[data-role="mode-btn"]')
  if (!btn) return
  const mode = normalizeButtonMode(btn.dataset.mode)
  if (!mode || mode === lastPreviewedMode) return
  lastPreviewedMode = mode
  previewFn(mode)
}

function normalizeButtonMode(value: string | undefined): VideoScaleMode | null {
  return (VIDEO_SCALE_MODES as string[]).includes(value as string)
    ? (value as VideoScaleMode)
    : null
}

function settle(value: VideoScaleDialogResult | null) {
  if (!resolveFn) return
  const fn = resolveFn
  resolveFn = null
  previewFn = null
  lastPreviewedMode = null
  fn(value)
}

export function openVideoScaleDialog(
  opts: VideoScaleDialogOpts
): Promise<VideoScaleDialogResult | null> {
  return new Promise((resolve) => {
    const node = ensureDialog()
    // If a prior dialog is still open, settle it as cancelled before we
    // overwrite the resolver - otherwise the prior promise would never
    // resolve once we attach to the new one.
    settle(null)
    resolveFn = resolve
    previewFn = opts.onPreview ?? null

    const titleEl = node.querySelector<HTMLElement>('[data-role="title"]')
    if (titleEl) titleEl.textContent = t("stream.scale.title")
    const closeBtn = node.querySelector<HTMLButtonElement>('[data-role="close"]')
    if (closeBtn) closeBtn.textContent = t("common.close")
    const applyAllLabel = node.querySelector<HTMLElement>('[data-role="apply-all-label"]')
    if (applyAllLabel) applyAllLabel.textContent = t(opts.applyAllLabelKey || "stream.scale.applyAll")
    const applyAllCheckbox = node.querySelector<HTMLInputElement>('[data-role="apply-all"]')
    if (applyAllCheckbox) applyAllCheckbox.checked = !!opts.applyAllDefault

    for (const btn of node.querySelectorAll<HTMLElement>('[data-role="mode-btn"]')) {
      const mode = normalizeButtonMode(btn.dataset.mode)
      if (!mode) continue
      const label = btn.querySelector<HTMLElement>('[data-role="mode-label"]')
      if (label) label.textContent = t(videoScaleModeLabelKey(mode))
      const radio = btn.querySelector<HTMLElement>('[data-role="mode-radio"]')
      const radioDot = btn.querySelector<HTMLElement>('[data-role="mode-radio-dot"]')
      const glyph = btn.querySelector<HTMLElement>('[data-role="mode-glyph"]')
      const isCurrent = mode === opts.currentMode
      radio?.classList.toggle("border-accent", isCurrent)
      radio?.classList.toggle("border-line", !isCurrent)
      radioDot?.classList.toggle("hidden", !isCurrent)
      glyph?.classList.toggle("text-accent", isCurrent)
      btn.setAttribute("aria-checked", String(isCurrent))
      btn.classList.toggle("border-accent", isCurrent)
      btn.classList.toggle("bg-surface-2", isCurrent)
      btn.classList.toggle("border-line", !isCurrent)
      btn.classList.toggle("bg-surface", !isCurrent)
    }

    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  })
}
