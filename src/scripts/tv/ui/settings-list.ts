// TV Settings row list + single-select choice dialog, shared by the Settings view.
import { t } from "@/scripts/lib/i18n"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav"
import { ICON_X, ICON_CHECK } from "@/scripts/lib/icons"

export type SettingsRowKind = "action" | "toggle" | "choice"

export interface SettingsRow {
  id: string
  icon?: string
  label: string
  value?: string
  kind: SettingsRowKind
  checked?: boolean
  disabled?: boolean
  onActivate(): void
}

export interface SettingsListHandle {
  el: HTMLElement
  setRows(rows: SettingsRow[]): void
  destroy(): void
}

function buildSwitch(checked: boolean): HTMLSpanElement {
  const track = document.createElement("span")
  track.setAttribute("aria-hidden", "true")
  track.className =
    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors " +
    (checked ? "bg-accent" : "bg-surface-3")
  const knob = document.createElement("span")
  knob.className =
    "inline-block size-5 rounded-full bg-white shadow transition-transform " +
    (checked ? "translate-x-5" : "translate-x-0.5")
  track.appendChild(knob)
  return track
}

function buildRow(row: SettingsRow): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.dataset.focusKey = `set:${row.id}`
  button.dataset.rowId = row.id
  button.disabled = !!row.disabled
  button.className =
    "flex min-h-[3.5rem] w-full items-center gap-4 rounded-xl px-4 text-start outline-none " +
    "hover:bg-surface-2 tv-focus-inset disabled:pointer-events-none disabled:opacity-40"

  if (row.icon) {
    const iconMark = document.createElement("span")
    iconMark.setAttribute("aria-hidden", "true")
    iconMark.className = "icon-mark"
    iconMark.innerHTML = row.icon
    button.appendChild(iconMark)
  }

  const label = document.createElement("span")
  label.className = "min-w-0 flex-1 truncate text-sm font-medium"
  label.textContent = row.label
  button.appendChild(label)

  if (row.kind === "toggle") {
    button.setAttribute("role", "switch")
    button.setAttribute("aria-checked", String(!!row.checked))
    button.appendChild(buildSwitch(!!row.checked))
  } else if (row.value) {
    const value = document.createElement("span")
    value.className = "max-w-[45%] shrink-0 truncate text-sm text-fg-3"
    value.textContent = row.value
    button.appendChild(value)
  }

  return button
}

export function createSettingsList(opts: { focusSectionId: string }): SettingsListHandle {
  const el = document.createElement("div")
  el.id = opts.focusSectionId
  el.className = "flex flex-col gap-1"

  const rowsById = new Map<string, SettingsRow>()

  function onClick(event: Event): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-row-id]")
    const rowId = target?.dataset.rowId
    if (!rowId || !target || target.disabled) return
    rowsById.get(rowId)?.onActivate()
  }
  el.addEventListener("click", onClick)

  function setRows(rows: SettingsRow[]): void {
    const focused = document.activeElement
    const previouslyFocusedKey =
      focused instanceof HTMLElement && el.contains(focused) ? focused.dataset.focusKey : null

    rowsById.clear()
    const fragment = document.createDocumentFragment()
    for (const row of rows) {
      rowsById.set(row.id, row)
      fragment.appendChild(buildRow(row))
    }
    el.replaceChildren(fragment)

    if (previouslyFocusedKey) {
      el.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(previouslyFocusedKey)}"]`)?.focus()
    }
  }

  return {
    el,
    setRows,
    destroy() {
      el.removeEventListener("click", onClick)
      rowsById.clear()
      el.replaceChildren()
    },
  }
}

// ---------------------------------------------------------------------------
// Single-select choice dialog: resolves the picked option id, or null on cancel/close.
// ---------------------------------------------------------------------------

export interface ChoiceOption {
  id: string
  label: string
  description?: string
  swatch?: string
  icon?: string
}

export interface ChoiceDialogOptions {
  title: string
  options: ChoiceOption[]
  selectedId?: string
}

const CHOICE_DIALOG_ID = "tv-settings-choice-dialog"

let choiceDialogEl: HTMLDialogElement | null = null
let choiceResolve: ((value: string | null) => void) | null = null

function settleChoice(value: string | null): void {
  if (!choiceResolve) return
  const resolve = choiceResolve
  choiceResolve = null
  resolve(value)
}

function buildChoiceOption(option: ChoiceOption, isSelected: boolean, dialog: HTMLDialogElement): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.dataset.focusKey = `choice:${option.id}`
  button.className =
    "flex w-full flex-col gap-0.5 rounded-xl px-4 py-2.5 text-start outline-none " +
    "hover:bg-surface-2 tv-focus-inset"
  if (isSelected) button.dataset.selected = "true"

  const labelLine = document.createElement("span")
  labelLine.className = "flex items-center gap-2 text-sm"
  if (option.swatch) {
    const dot = document.createElement("span")
    dot.setAttribute("aria-hidden", "true")
    dot.className = "size-3 shrink-0 rounded-full"
    dot.style.background = option.swatch
    labelLine.appendChild(dot)
  }
  if (option.icon) {
    const icon = document.createElement("span")
    icon.setAttribute("aria-hidden", "true")
    icon.className = "shrink-0 text-fg-3"
    icon.innerHTML = option.icon
    labelLine.appendChild(icon)
  }
  const labelText = document.createElement("span")
  labelText.className = "min-w-0 flex-1 truncate"
  labelText.textContent = option.label
  labelLine.appendChild(labelText)
  if (isSelected) {
    const check = document.createElement("span")
    check.setAttribute("aria-hidden", "true")
    check.className = "shrink-0 text-accent"
    check.innerHTML = ICON_CHECK
    labelLine.appendChild(check)
  }
  button.appendChild(labelLine)

  if (option.description) {
    const description = document.createElement("span")
    description.className = "truncate text-xs text-fg-3"
    description.textContent = option.description
    button.appendChild(description)
  }

  button.addEventListener("click", () => {
    settleChoice(option.id)
    dialog.close()
  })
  return button
}

function ensureChoiceDialog(): HTMLDialogElement {
  if (choiceDialogEl?.isConnected) return choiceDialogEl
  const dialog = document.createElement("dialog")
  dialog.id = CHOICE_DIALOG_ID
  dialog.className =
    "m-auto max-h-[70vh] w-[26rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70"

  const header = document.createElement("div")
  header.className = "flex items-center justify-between gap-4 border-b border-line px-6 py-4"
  const title = document.createElement("h2")
  title.dataset.role = "title"
  title.className = "text-lg font-semibold"
  const closeButton = document.createElement("button")
  closeButton.type = "button"
  closeButton.dataset.role = "close"
  closeButton.className =
    "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-3 outline-none tv-focus-inset hover:bg-surface-2 hover:text-fg"
  const closeIcon = document.createElement("span")
  closeIcon.className = "inline-flex text-base"
  closeIcon.innerHTML = ICON_X
  closeButton.appendChild(closeIcon)
  header.append(title, closeButton)

  const list = document.createElement("div")
  list.dataset.role = "list"
  list.className = "flex max-h-[55vh] flex-col overflow-y-auto p-2"

  dialog.append(header, list)
  document.body.appendChild(dialog)

  closeButton.addEventListener("click", () => dialog.close())
  dialog.addEventListener("close", () => settleChoice(null))

  attachDialogSpatialNav(dialog, {
    defaultElement: `#${CHOICE_DIALOG_ID} [data-selected="true"], #${CHOICE_DIALOG_ID} [data-role="close"]`,
  })

  choiceDialogEl = dialog
  return dialog
}

export function openChoiceDialog(opts: ChoiceDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = ensureChoiceDialog()
    settleChoice(null)
    choiceResolve = resolve

    const titleEl = dialog.querySelector<HTMLElement>('[data-role="title"]')
    const closeButton = dialog.querySelector<HTMLElement>('[data-role="close"]')
    const listEl = dialog.querySelector<HTMLElement>('[data-role="list"]')
    if (titleEl) titleEl.textContent = opts.title
    if (closeButton) closeButton.setAttribute("aria-label", t("common.close"))

    if (listEl) {
      listEl.replaceChildren()
      const fragment = document.createDocumentFragment()
      for (const option of opts.options) {
        fragment.appendChild(buildChoiceOption(option, option.id === opts.selectedId, dialog))
      }
      listEl.appendChild(fragment)
    }

    if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal()
  })
}
