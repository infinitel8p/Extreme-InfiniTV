// Programmatic <dialog> picking which backup sections to restore.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.ts"

const DIALOG_ID = "xt-backup-sections-dialog"

const SECTION_HINT_KEYS: Record<string, string> = {
  localContent: "backup.section.localContent.hint",
  tvDevices: "backup.section.tvDevices.hint",
  appSettings: "backup.section.appSettings.hint",
}

let dlg: HTMLDialogElement | null = null
let resolveFn: ((value: Set<string> | null) => void) | null = null

const BUTTON_CLASS_DESTRUCTIVE =
  "inline-flex items-center justify-center min-h-11 rounded-xl px-4 py-2 text-sm font-semibold bg-bad text-bg tv-focus-inset " +
  "hover:opacity-90 focus-visible:opacity-90 focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-bad disabled:opacity-50 disabled:pointer-events-none"

function ensureDialog(): HTMLDialogElement {
  if (dlg && dlg.isConnected) return dlg
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
        <p data-role="body" class="text-sm text-fg-2 whitespace-pre-line"></p>
      </div>
      <div data-role="sections" class="flex flex-col gap-1"></div>
      <div class="flex gap-2 justify-end">
        <button
          data-role="cancel"
          type="button"
          class="inline-flex items-center justify-center min-h-11 rounded-xl border border-line px-4 py-2 text-sm tv-focus-inset hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"></button>
        <button
          data-role="confirm"
          type="button"
          class="${BUTTON_CLASS_DESTRUCTIVE}"></button>
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
  const sectionsEl = node.querySelector(
    '[data-role="sections"]'
  ) as HTMLElement

  cancelBtn.addEventListener("click", () => node.close())
  confirmBtn.addEventListener("click", () => {
    const checked = new Set(
      Array.from(
        sectionsEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')
      ).map((input) => input.value)
    )
    settle(checked)
    node.close()
  })
  sectionsEl.addEventListener("change", () => updateConfirmState(node))
  // Backdrop click closes (= cancel).
  node.addEventListener("click", (event) => {
    if (event.target === node) node.close()
  })
  // Esc or any non-confirm close resolves null.
  node.addEventListener("close", () => settle(null))

  dlg = node
  return dlg
}

function settle(value: Set<string> | null) {
  if (!resolveFn) return
  const fn = resolveFn
  resolveFn = null
  fn(value)
}

function updateConfirmState(node: HTMLDialogElement) {
  const confirmBtn = node.querySelector(
    '[data-role="confirm"]'
  ) as HTMLButtonElement
  const anyChecked = node.querySelector(
    '[data-role="sections"] input[type="checkbox"]:checked'
  )
  confirmBtn.disabled = !anyChecked
}

/** `present` is the caller's ordered section list. Resolves with the checked names, or null on cancel. */
export function pickBackupSections(present: string[]): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const node = ensureDialog()
    settle(null)
    if (node.open) node.close()
    resolveFn = resolve

    const titleEl = node.querySelector('[data-role="title"]') as HTMLElement
    const bodyEl = node.querySelector('[data-role="body"]') as HTMLElement
    const cancelBtn = node.querySelector(
      '[data-role="cancel"]'
    ) as HTMLButtonElement
    const confirmBtn = node.querySelector(
      '[data-role="confirm"]'
    ) as HTMLButtonElement
    const sectionsEl = node.querySelector(
      '[data-role="sections"]'
    ) as HTMLElement

    titleEl.textContent = t("backup.restore.title")
    bodyEl.textContent = t("backup.restore.body")
    cancelBtn.textContent = t("common.cancel")
    confirmBtn.textContent = t("backup.restore.confirm")

    sectionsEl.innerHTML = present
      .map((section) => {
        const hintKey = SECTION_HINT_KEYS[section]
        const hint = hintKey
          ? `<span class="text-xs text-fg-2">${escapeHtml(t(hintKey))}</span>`
          : ""
        return `
          <label class="flex items-start gap-2.5 min-h-11 px-1 py-1.5 rounded-lg tv-focus-inset-within cursor-pointer hover:bg-surface-2">
            <input type="checkbox" value="${escapeHtml(section)}" checked class="mt-1 size-4 accent-accent flex-none" />
            <span class="flex flex-col gap-0.5">
              <span class="text-sm">${escapeHtml(t(`backup.section.${section}`))}</span>
              ${hint}
            </span>
          </label>
        `
      })
      .join("")
    updateConfirmState(node)

    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  })
}
