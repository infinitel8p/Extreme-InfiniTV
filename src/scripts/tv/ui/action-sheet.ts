// Shared TV long-press action sheet: a titled <dialog> listing tap actions,
// extracted from live.ts's channel action sheet so other TV views can reuse it.

import { t } from "@/scripts/lib/i18n"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.ts"
import { ICON_X } from "@/scripts/lib/icons.js"

export interface ActionSheetItem {
  label: string
  onSelect: () => void
  destructive?: boolean
}

export interface ActionSheetFact {
  label: string
  value: string
  tone?: "good" | "warn" | "bad" | "neutral"
}

export interface ActionSheetOpenOptions {
  facts?: ActionSheetFact[]
}

export interface ActionSheetHandle {
  open(title: string, actions: ActionSheetItem[], opts?: ActionSheetOpenOptions): void
  destroy(): void
}

export function createActionSheet(dialogId: string): ActionSheetHandle {
  let dialog: HTMLDialogElement | null = null

  function ensureDialog(): HTMLDialogElement {
    if (dialog) return dialog
    const el = document.createElement("dialog")
    el.id = dialogId
    el.setAttribute("aria-labelledby", `${dialogId}-title`)
    el.className = "m-auto w-[22rem] max-w-[90vw] max-h-[85vh] rounded-2xl border border-line bg-surface p-0 text-fg open:flex flex-col backdrop:bg-black/70"
    el.innerHTML = `
      <div class="shrink-0 flex items-center justify-between gap-4 border-b border-line px-5 py-4">
        <h2 data-role="title" id="${dialogId}-title" class="min-w-0 flex-1 truncate text-base font-semibold"></h2>
        <button type="button" data-role="close" class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-3 outline-none tv-focus-inset hover:bg-surface-2 hover:text-fg" aria-label="${t("common.close")}">
          <span class="inline-flex text-base">${ICON_X}</span>
        </button>
      </div>
      <div data-role="body" class="min-h-0 overflow-y-auto">
        <dl data-role="facts" class="hidden flex-col border-b border-line px-5 py-3"></dl>
        <div data-role="actions" class="flex flex-col gap-1 p-2"></div>
      </div>
    `
    document.body.appendChild(el)
    el.querySelector('[data-role="close"]')?.addEventListener("click", () => el.close())
    el.addEventListener("click", (event) => {
      if (event.target === el) el.close()
    })
    attachDialogSpatialNav(el)
    dialog = el
    return el
  }

  function open(title: string, actions: ActionSheetItem[], opts: ActionSheetOpenOptions = {}): void {
    const el = ensureDialog()
    const titleEl = el.querySelector<HTMLElement>('[data-role="title"]')
    const factsEl = el.querySelector<HTMLElement>('[data-role="facts"]')
    const actionsEl = el.querySelector<HTMLElement>('[data-role="actions"]')
    if (titleEl) titleEl.textContent = title
    if (factsEl) {
      factsEl.replaceChildren()
      const facts = opts.facts || []
      for (const fact of facts) {
        const row = document.createElement("div")
        row.className = "flex items-center justify-between gap-3 py-1.5 border-b border-line/40 last:border-b-0 text-xs"
        const dt = document.createElement("dt")
        dt.className = "text-fg-3"
        dt.textContent = fact.label
        const dd = document.createElement("dd")
        dd.className =
          "tabular-nums text-end " +
          (fact.tone === "good"
            ? "text-good"
            : fact.tone === "warn"
            ? "text-warn"
            : fact.tone === "bad"
            ? "text-bad"
            : "text-fg-2")
        dd.textContent = fact.value
        row.append(dt, dd)
        factsEl.appendChild(row)
      }
      factsEl.classList.toggle("hidden", facts.length === 0)
      factsEl.classList.toggle("flex", facts.length > 0)
    }
    if (actionsEl) {
      actionsEl.replaceChildren()
      for (const action of actions) {
        const button = document.createElement("button")
        button.type = "button"
        const isDestructive = Boolean(action.destructive)
        button.className =
          "flex min-h-11 items-center rounded-xl px-3 text-start text-sm outline-none transition-colors " +
          "hover:bg-surface-2 tv-focus-inset" +
          (isDestructive ? " text-bad" : "")
        button.textContent = action.label
        button.addEventListener("click", () => {
          el.close()
          action.onSelect()
        })
        actionsEl.appendChild(button)
      }
    }
    if (typeof el.showModal === "function") el.showModal()
    actionsEl?.querySelector<HTMLButtonElement>("button")?.focus()
  }

  function destroy(): void {
    try {
      dialog?.close()
    } catch {}
    dialog?.remove()
    dialog = null
  }

  return { open, destroy }
}
