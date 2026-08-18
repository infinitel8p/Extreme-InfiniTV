// Programmatic confirm() replacement: opens a styled <dialog>, returns a
// Promise<boolean>. Used in shared lib code (e.g. playlist-rows.js) that
// can't depend on a page-scoped <dialog>. Mirrors the page-scoped delete
// dialogs in downloads.astro / settings.astro so the look is consistent.
//
// Reason this exists: on Android the WebView's native window.confirm() is
// a no-op because we don't delegate WebChromeClient.onJsConfirm to wry
// (delegating broke PiP). See MainActivity.kt comment on
// FullscreenAwareChromeClient.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"

const DIALOG_ID = "xt-confirm-dialog"

let dlg: HTMLDialogElement | null = null
let resolveFn: ((value: boolean) => void) | null = null
let linkFn: (() => void) | null = null

export interface ConfirmDialogOptions {
  message: string
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  link?: { label: string; onClick: () => void }
}

const BUTTON_CLASS_DEFAULT =
  "rounded-xl px-4 py-2 text-sm font-semibold bg-accent text-bg " +
  "hover:opacity-90 focus-visible:opacity-90 focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-accent"

const BUTTON_CLASS_DESTRUCTIVE =
  "rounded-xl px-4 py-2 text-sm font-semibold bg-bad text-bg " +
  "hover:opacity-90 focus-visible:opacity-90 focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-bad"

function ensureDialog(): HTMLDialogElement {
  if (dlg) return dlg
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(28rem,calc(100vw-2rem))]",
    "backdrop:bg-black/70",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col gap-4 p-5">
      <div class="flex flex-col gap-1.5">
        <h2 id="${DIALOG_ID}-title" data-role="title" class="text-base font-semibold"></h2>
        <p data-role="body" class="text-sm text-fg-2"></p>
        <button
          data-role="link"
          type="button"
          class="hidden self-start text-sm font-medium text-accent hover:underline focus-visible:underline focus-visible:outline-none"></button>
      </div>
      <div class="flex gap-2 justify-end">
        <button
          data-role="cancel"
          type="button"
          class="rounded-xl border border-line px-4 py-2 text-sm hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"></button>
        <button
          data-role="confirm"
          type="button"
          class="${BUTTON_CLASS_DEFAULT}"></button>
      </div>
    </div>
  `
  document.body.appendChild(node)
  attachDialogSpatialNav(node, {
    defaultElement: `#${DIALOG_ID} [data-role="cancel"]`,
  })

  const cancelBtn = node.querySelector(
    '[data-role="cancel"]'
  ) as HTMLButtonElement
  const confirmBtn = node.querySelector(
    '[data-role="confirm"]'
  ) as HTMLButtonElement

  const linkBtn = node.querySelector(
    '[data-role="link"]'
  ) as HTMLButtonElement

  cancelBtn.addEventListener("click", () => node.close())
  confirmBtn.addEventListener("click", () => {
    settle(true)
    node.close()
  })
  linkBtn.addEventListener("click", () => {
    const fn = linkFn
    node.close()
    fn?.()
  })
  // Backdrop click closes (= cancel).
  node.addEventListener("click", (event) => {
    if (event.target === node) node.close()
  })
  // Esc or any non-confirm close resolves false.
  node.addEventListener("close", () => settle(false))

  dlg = node
  return dlg
}

function settle(value: boolean) {
  if (!resolveFn) return
  const fn = resolveFn
  resolveFn = null
  fn(value)
}

export function confirmDialog(
  opts: ConfirmDialogOptions
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const node = ensureDialog()
    // If a prior dialog is still open, settle it as cancelled before we
    // overwrite the resolver - otherwise the prior promise would never
    // resolve once we attach to the new one.
    settle(false)
    resolveFn = resolve

    const titleEl = node.querySelector(
      '[data-role="title"]'
    ) as HTMLElement
    const bodyEl = node.querySelector(
      '[data-role="body"]'
    ) as HTMLElement
    const cancelBtn = node.querySelector(
      '[data-role="cancel"]'
    ) as HTMLButtonElement
    const confirmBtn = node.querySelector(
      '[data-role="confirm"]'
    ) as HTMLButtonElement
    const linkBtn = node.querySelector(
      '[data-role="link"]'
    ) as HTMLButtonElement

    titleEl.textContent = opts.title || t("common.confirmTitle")
    bodyEl.textContent = opts.message
    cancelBtn.textContent = opts.cancelLabel || t("common.cancel")
    confirmBtn.textContent = opts.confirmLabel || t("common.confirm")
    confirmBtn.className = opts.destructive
      ? BUTTON_CLASS_DESTRUCTIVE
      : BUTTON_CLASS_DEFAULT

    if (opts.link) {
      linkFn = opts.link.onClick
      linkBtn.textContent = opts.link.label
      linkBtn.classList.remove("hidden")
    } else {
      linkFn = null
      linkBtn.textContent = ""
      linkBtn.classList.add("hidden")
    }

    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  })
}
