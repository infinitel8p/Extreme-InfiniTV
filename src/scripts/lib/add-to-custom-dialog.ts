// "Add to custom playlist" dialog: pick an existing custom playlist (or
// create a new one) and add a channel reference to it. Shared by the
// stream-sniffer "name" phase and the Live TV channel context menu.

import { getEntries, addEntry } from "@/scripts/lib/creds.js"
import { addChannel, loadCustomDoc, saveCustomDoc } from "@/scripts/lib/custom-playlist.ts"
import type { AddChannelInit, CustomSource } from "@/scripts/lib/custom-playlist.ts"
import { invalidateEntry } from "@/scripts/lib/cache.js"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.ts"
import { ICON_PLAYLIST_ADD } from "@/scripts/lib/icons.ts"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"

const DIALOG_ID = "add-to-custom-dialog"

let dlg: HTMLDialogElement | null = null

interface CustomEntryLite {
  _id: string
  title: string
}

function ensureDialog(): HTMLDialogElement | null {
  if (typeof document === "undefined") return null
  if (dlg && document.body.contains(dlg)) return dlg
  const existing = document.getElementById(DIALOG_ID)
  if (existing instanceof HTMLDialogElement) {
    dlg = existing
    return dlg
  }
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(26rem,calc(100vw-2rem))] max-h-[min(80dvh,32rem)]",
    "backdrop:bg-black/60",
  ].join(" ")
  document.body.appendChild(node)
  dlg = node
  return dlg
}

function headerHtml(channelName: string): string {
  return `
    <header class="flex items-start gap-3.5 shrink-0 px-3">
      <span class="icon-mark icon-mark--lg" aria-hidden="true">${ICON_PLAYLIST_ADD}</span>
      <div class="flex flex-col gap-1 min-w-0 pt-0.5">
        <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight">${escapeHtml(t("addToCustom.dialogTitle"))}</h2>
        ${channelName ? `<p class="text-sm text-fg-3 leading-relaxed truncate">${escapeHtml(channelName)}</p>` : ""}
      </div>
    </header>
  `
}

function renderList(channelName: string, entries: CustomEntryLite[]): string {
  const rows = entries
    .map(
      (entry) => `
        <button
          type="button"
          data-role="entry-btn"
          data-id="${escapeHtml(entry._id)}"
          class="xt-picker-row flex items-center w-full text-left gap-3 px-3 py-2.5 rounded-xl border border-line bg-surface hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98]"
        >
          <span class="text-sm truncate">${escapeHtml(entry.title)}</span>
        </button>
      `
    )
    .join("")
  return `
    <div class="flex flex-col h-full p-5 sm:p-6 gap-5">
      ${headerHtml(channelName)}
      <div data-role="list" class="flex flex-col gap-2.5 overflow-y-auto min-h-0">
        ${rows}
        <button
          type="button"
          data-role="new-playlist-btn"
          class="xt-picker-row flex items-center w-full text-left gap-3 px-3 py-2.5 rounded-xl border border-dashed border-line bg-surface hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98]"
        >
          <span class="text-sm font-medium text-accent">${escapeHtml(t("addToCustom.newPlaylistRow"))}</span>
        </button>
      </div>
      <footer class="flex items-center gap-3 shrink-0 mt-auto">
        <button type="button" data-role="cancel" class="btn ms-auto">${escapeHtml(t("common.cancel"))}</button>
      </footer>
    </div>
  `
}

function renderCreate(channelName: string): string {
  return `
    <div class="flex flex-col h-full p-5 sm:p-6 gap-5">
      ${headerHtml(channelName)}
      <label class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-wider uppercase text-fg-3">${escapeHtml(t("addToCustom.newPlaylistRow"))}</span>
        <input
          data-role="new-name-input"
          type="text"
          placeholder="${escapeHtml(t("addToCustom.newPlaylistPlaceholder"))}"
          class="field-input"
        />
      </label>
      <footer class="flex items-center gap-3 shrink-0 mt-auto">
        <button type="button" data-role="back" class="btn">${escapeHtml(t("common.back"))}</button>
        <button type="button" data-role="create-confirm" class="btn ms-auto">${escapeHtml(t("addToCustom.createBtn"))}</button>
      </footer>
    </div>
  `
}

/**
 * Open the "Add to custom playlist" picker. Resolves true once the channel
 * has been added to a (possibly newly created) custom playlist entry, false
 * on cancel/escape or an unrecoverable failure.
 */
export async function openAddToCustomDialog(
  source: CustomSource,
  init: AddChannelInit & { name: string }
): Promise<boolean> {
  const dialog = ensureDialog()
  if (!dialog) return Promise.resolve(false)

  return new Promise((resolve) => {
    let resolved = false
    let phase: "list" | "create" = "list"
    let customEntries: CustomEntryLite[] = []
    let busy = false

    const settle = (added: boolean) => {
      if (resolved) return
      resolved = true
      dialog.removeEventListener("click", onClick)
      dialog.removeEventListener("cancel", onCancel)
      dialog.removeEventListener("close", onClose)
      try {
        if (dialog.open) dialog.close()
      } catch {}
      resolve(added)
    }

    const render = () => {
      dialog.innerHTML = phase === "create" ? renderCreate(init.name) : renderList(init.name, customEntries)
      const focusTarget = dialog.querySelector<HTMLElement>('[data-role="new-name-input"], [data-role="entry-btn"], button')
      focusTarget?.focus()
    }

    const addToEntry = async (entryId: string) => {
      if (busy) return
      busy = true
      try {
        const doc = await loadCustomDoc(entryId)
        const { doc: updatedDoc } = addChannel(doc, source, init)
        const saved = await saveCustomDoc(entryId, updatedDoc)
        if (!saved) throw new Error("saveCustomDoc returned false")
        invalidateEntry(entryId)
        document.dispatchEvent(new CustomEvent("xt:entries-updated"))
        toastSuccess(t("addToCustom.toastAdded"))
        settle(true)
      } catch (err) {
        log.warn("[xt:add-to-custom] add failed:", err)
        toastError(t("addToCustom.toastFailed"))
        busy = false
      }
    }

    const createAndAdd = async (nameInput: HTMLInputElement | null) => {
      if (busy) return
      busy = true
      const title = (nameInput?.value || "").trim()
      try {
        const entry = await addEntry(title ? { type: "custom", title } : { type: "custom" })
        await addToEntry(entry._id)
      } catch (err) {
        log.warn("[xt:add-to-custom] create playlist failed:", err)
        toastError(t("addToCustom.toastFailed"))
        busy = false
      }
    }

    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target) return

      if (target.closest('[data-role="cancel"]')) {
        settle(false)
        return
      }

      const entryBtn = target.closest<HTMLElement>('[data-role="entry-btn"]')
      if (entryBtn && phase === "list") {
        const entryId = entryBtn.dataset.id
        if (entryId) void addToEntry(entryId)
        return
      }

      if (target.closest('[data-role="new-playlist-btn"]')) {
        phase = "create"
        render()
        return
      }

      if (target.closest('[data-role="back"]')) {
        phase = "list"
        render()
        return
      }

      if (target.closest('[data-role="create-confirm"]')) {
        const nameInput = dialog.querySelector<HTMLInputElement>('[data-role="new-name-input"]')
        void createAndAdd(nameInput)
        return
      }

      if (target === dialog) settle(false)
    }

    const onCancel = (event: Event) => {
      event.preventDefault()
      settle(false)
    }

    const onClose = () => settle(false)

    dialog.addEventListener("click", onClick)
    dialog.addEventListener("cancel", onCancel)
    dialog.addEventListener("close", onClose)

    ;(async () => {
      try {
        const entries = await getEntries()
        customEntries = entries
          .filter((entry: any) => entry.type === "custom")
          .map((entry: any) => ({ _id: entry._id, title: entry.title || "" }))
      } catch (err) {
        log.warn("[xt:add-to-custom] getEntries failed:", err)
      }
      render()

      try {
        dialog.showModal()
      } catch (err) {
        log.warn("[xt:add-to-custom] showModal failed:", err)
        settle(false)
        return
      }

      attachDialogSpatialNav(dialog, {
        defaultElement: `#${DIALOG_ID} [data-role="entry-btn"], #${DIALOG_ID} [data-role="new-playlist-btn"]`,
      })
    })()
  })
}
