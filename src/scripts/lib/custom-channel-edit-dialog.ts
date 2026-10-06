// "Edit channel" dialog for custom-playlist channels: name/logo/number/tvg-id overrides.
import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.js"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.ts"
import { ICON_CHEVRON_DOWN, ICON_PENCIL } from "@/scripts/lib/icons.js"
import { sanitizeOverrideLogo, MAX_OVERRIDE_NAME_LENGTH, MAX_OVERRIDE_LOGO_LENGTH, MAX_OVERRIDE_CHNO } from "@/scripts/lib/channel-overrides.ts"
import type { CustomChannel, CustomChannelOverrides, CustomChannelCatchup } from "@/scripts/lib/custom-playlist.ts"

const DIALOG_ID = "xt-custom-channel-edit-dialog"

export interface CustomChannelEditResult {
  overrides: CustomChannelOverrides
  catchup?: CustomChannelCatchup | null
}

let pendingResolve: ((result: CustomChannelEditResult | null) => void) | null = null

function settlePending(result: CustomChannelEditResult | null = null): void {
  const resolve = pendingResolve
  pendingResolve = null
  resolve?.(result)
}

export interface CustomChannelEditInit {
  channel: CustomChannel
  /** Resolved source channel's own name/logo, for the placeholder and header. */
  resolvedName: string
  resolvedLogo?: string | null
  /** When present, renders a collapsed catch-up section and includes it in the resolved value. */
  catchup?: { value: CustomChannelCatchup | null }
}

function fieldRow(label: string, control: string, hint = ""): string {
  return `
    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-fg-2">${escapeHtml(label)}</span>
      ${control}
      ${hint ? `<span class="text-xs text-fg-3 leading-relaxed">${escapeHtml(hint)}</span>` : ""}
    </label>
  `
}

const INPUT_CLASS =
  "w-full min-h-11 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none " +
  "focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent"

export function openCustomChannelEditDialog(init: CustomChannelEditInit): Promise<CustomChannelEditResult | null> {
  const { channel, resolvedName } = init
  const resolvedLogo = init.resolvedLogo ?? null

  return new Promise((resolve) => {
    // Removed nodes fire no `close`, so settle any prior pending caller first.
    settlePending()
    document.getElementById(DIALOG_ID)?.remove()
    pendingResolve = resolve

    const dialog = document.createElement("dialog")
    dialog.id = DIALOG_ID
    dialog.className = [
      "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
      "w-[min(32rem,calc(100vw-2rem))] max-h-[min(80dvh,40rem)]",
      "open:flex flex-col overflow-hidden",
      "backdrop:bg-black/60",
    ].join(" ")
    dialog.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)

    const currentName = channel.overrides.name || ""
    const currentLogo = channel.overrides.logo || ""
    const currentChno = channel.overrides.chno != null ? String(channel.overrides.chno) : ""
    const currentTvgId = channel.overrides.tvgId || ""
    const hasOverrides =
      channel.overrides.name != null ||
      channel.overrides.logo != null ||
      channel.overrides.chno != null ||
      channel.overrides.tvgId != null

    dialog.innerHTML = `
      <form method="dialog" class="flex flex-col flex-auto min-h-0 overflow-y-auto gap-5 p-5 sm:p-6">
        <header class="flex items-center gap-3">
          <span class="icon-mark" aria-hidden="true">${ICON_PENCIL}</span>
          <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight break-words min-w-0">
            ${escapeHtml(resolvedName)}
          </h2>
        </header>

        <div class="flex flex-col gap-4">
          ${fieldRow(
            t("editor.nameLabel"),
            `<span class="flex items-center gap-3">
               <input type="text" data-role="name" class="${INPUT_CLASS}" value="${escapeHtml(currentName)}"
                 placeholder="${escapeHtml(resolvedName)}" autocomplete="off" spellcheck="false"
                 maxlength="${MAX_OVERRIDE_NAME_LENGTH}" />
               <button type="button" data-role="use-source-name"
                 class="shrink-0 text-xs font-medium text-accent hover:underline focus-visible:underline focus-visible:outline-none">
                 ${escapeHtml(t("editor.resetName"))}
               </button>
             </span>`
          )}
          ${fieldRow(
            t("editor.logoLabel"),
            `<span class="flex items-start gap-3">
               <span class="inline-flex items-center justify-center size-16 rounded-lg border border-line bg-bg overflow-hidden shrink-0"
                     data-role="logo-preview-row">
                 <img data-role="logo-preview" alt="" class="max-w-full max-h-full object-contain" />
               </span>
               <span class="flex flex-col gap-1.5 min-w-0 flex-1">
                 <input type="url" data-role="logo" class="${INPUT_CLASS}" value="${escapeHtml(currentLogo)}"
                   placeholder="https://…" autocomplete="off" spellcheck="false" inputmode="url"
                   maxlength="${MAX_OVERRIDE_LOGO_LENGTH}" />
                 <span class="text-xs text-fg-3 leading-relaxed" data-role="logo-status"></span>
               </span>
             </span>`
          )}
          ${fieldRow(
            t("editor.channelNumberLabel"),
            `<input type="number" min="1" step="1" max="${MAX_OVERRIDE_CHNO}" data-role="chno" class="${INPUT_CLASS}" value="${escapeHtml(currentChno)}"
               inputmode="numeric" />`
          )}
          ${fieldRow(
            t("editor.tvgIdLabel"),
            `<input type="text" data-role="tvgid" class="${INPUT_CLASS}" value="${escapeHtml(currentTvgId)}"
               autocomplete="off" spellcheck="false" />`,
            t("editor.tvgIdHelpText")
          )}
        </div>

        ${
          init.catchup
            ? `<details class="rounded-xl border border-line bg-bg">
                 <summary class="flex min-h-11 cursor-pointer select-none items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-2">
                   <span class="text-sm font-medium text-fg-2">${escapeHtml(t("editor.catchupFieldsetLabel"))}</span>
                   <span class="changelog-chevron inline-flex size-4 shrink-0 text-fg-3 transition-transform duration-200" aria-hidden="true">${ICON_CHEVRON_DOWN}</span>
                 </summary>
                 <div class="flex flex-col gap-4 px-3 pb-3 pt-1">
                   ${fieldRow(
                     t("editor.catchupModeLabel"),
                     `<select data-role="catchup-mode" class="${INPUT_CLASS}">
                        <option value="">${escapeHtml(t("editor.catchupModeInherit"))}</option>
                        <option value="default">${escapeHtml(t("editor.catchupModeDefault"))}</option>
                        <option value="append">${escapeHtml(t("editor.catchupModeAppend"))}</option>
                        <option value="shift">${escapeHtml(t("editor.catchupModeShift"))}</option>
                        <option value="flussonic">${escapeHtml(t("editor.catchupModeFlussonic"))}</option>
                        <option value="xc">${escapeHtml(t("editor.catchupModeXc"))}</option>
                      </select>`,
                     t("editor.catchupHelpText")
                   )}
                   <div class="grid grid-cols-2 gap-3">
                     ${fieldRow(
                       t("editor.catchupDaysLabel"),
                       `<input type="number" min="0" step="1" data-role="catchup-days" class="${INPUT_CLASS}" inputmode="numeric" />`
                     )}
                     ${fieldRow(
                       t("editor.catchupCorrectionLabel"),
                       `<input type="number" step="1" data-role="catchup-correction" class="${INPUT_CLASS}" inputmode="numeric" />`
                     )}
                   </div>
                   ${fieldRow(
                     t("editor.catchupSourceLabel"),
                     `<input type="text" data-role="catchup-source" class="${INPUT_CLASS}" autocomplete="off" spellcheck="false" />`,
                     t("editor.catchupHelpText")
                   )}
                 </div>
               </details>`
            : ""
        }

        <footer class="flex flex-wrap items-center gap-3 shrink-0 mt-auto">
          <button type="button" data-role="revert" class="btn-danger"${hasOverrides ? "" : " disabled"}>
            ${escapeHtml(t("settings.channelOverrides.revert"))}
          </button>
          <button type="button" data-role="cancel" class="btn ms-auto">${escapeHtml(t("common.cancel"))}</button>
          <button type="button" data-role="save" class="btn btn-primary">${escapeHtml(t("common.save"))}</button>
        </footer>
      </form>
    `

    document.body.appendChild(dialog)
    const releaseSpatialNav = attachDialogSpatialNav(dialog, {
      defaultElement: `#${DIALOG_ID} [data-role="name"]`,
    })

    const nameInput = dialog.querySelector<HTMLInputElement>('[data-role="name"]')
    dialog.querySelector('[data-role="use-source-name"]')?.addEventListener("click", () => {
      if (!nameInput) return
      nameInput.value = ""
      nameInput.focus()
    })
    const logoInput = dialog.querySelector<HTMLInputElement>('[data-role="logo"]')
    const chnoInput = dialog.querySelector<HTMLInputElement>('[data-role="chno"]')
    const tvgIdInput = dialog.querySelector<HTMLInputElement>('[data-role="tvgid"]')
    const preview = dialog.querySelector<HTMLImageElement>('[data-role="logo-preview"]')
    const logoStatus = dialog.querySelector<HTMLElement>('[data-role="logo-status"]')
    const catchupModeSelect = dialog.querySelector<HTMLSelectElement>('[data-role="catchup-mode"]')
    const catchupDaysInput = dialog.querySelector<HTMLInputElement>('[data-role="catchup-days"]')
    const catchupSourceInput = dialog.querySelector<HTMLInputElement>('[data-role="catchup-source"]')
    const catchupCorrectionInput = dialog.querySelector<HTMLInputElement>('[data-role="catchup-correction"]')
    if (init.catchup) {
      const catchupValue = init.catchup.value
      if (catchupModeSelect) catchupModeSelect.value = catchupValue?.catchup ?? ""
      if (catchupDaysInput) catchupDaysInput.value = catchupValue?.catchupDays != null ? String(catchupValue.catchupDays) : ""
      if (catchupSourceInput) catchupSourceInput.value = catchupValue?.catchupSource ?? ""
      if (catchupCorrectionInput) {
        catchupCorrectionInput.value = catchupValue?.catchupCorrection != null ? String(catchupValue.catchupCorrection) : ""
      }
    }

    const paintPreview = () => {
      const rawUrl = (logoInput?.value || "").trim() || resolvedLogo || ""
      if (!preview) return
      if (!rawUrl) {
        preview.removeAttribute("src")
        if (logoStatus) logoStatus.textContent = ""
        return
      }
      const safeUrl = sanitizeOverrideLogo(rawUrl)
      if (!safeUrl) {
        preview.removeAttribute("src")
        if (logoStatus) logoStatus.textContent = t("channelEdit.logoInvalid")
        return
      }
      if (logoStatus) logoStatus.textContent = t("channelEdit.logoLoading")
      preview.onload = () => {
        if (logoStatus) {
          logoStatus.textContent = (logoInput?.value || "").trim()
            ? t("channelEdit.logoPreview")
            : t("channelEdit.logoProvider")
        }
      }
      preview.onerror = () => {
        if (logoStatus) logoStatus.textContent = t("channelEdit.logoFailed")
      }
      preview.src = safeUrl
    }
    paintPreview()
    let previewTimer: ReturnType<typeof setTimeout> | null = null
    logoInput?.addEventListener("input", () => {
      if (previewTimer) clearTimeout(previewTimer)
      previewTimer = setTimeout(paintPreview, 400)
    })

    let outcome: CustomChannelEditResult | null = null
    const close = () => {
      if (previewTimer) clearTimeout(previewTimer)
      releaseSpatialNav?.()
      dialog.close()
    }

    const saveButton = dialog.querySelector<HTMLButtonElement>('[data-role="save"]')
    saveButton?.addEventListener("click", () => {
      const rawLogo = (logoInput?.value || "").trim()
      if (rawLogo && !sanitizeOverrideLogo(rawLogo)) {
        if (logoStatus) logoStatus.textContent = t("channelEdit.logoInvalid")
        logoInput?.focus()
        logoInput?.select()
        return
      }
      const nextName = (nameInput?.value || "").trim()
      const result: CustomChannelEditResult = {
        overrides: {
          name: nextName || null,
          logo: rawLogo || null,
          chno: chnoInput?.value ? Number(chnoInput.value) : null,
          tvgId: (tvgIdInput?.value || "").trim() || null,
        },
      }
      if (init.catchup) {
        const modeValue = catchupModeSelect?.value || ""
        result.catchup = modeValue
          ? {
              catchup: modeValue,
              catchupDays: catchupDaysInput?.value.trim() ? Math.max(0, Number(catchupDaysInput.value)) : null,
              catchupSource: catchupSourceInput?.value.trim() || null,
              catchupCorrection: catchupCorrectionInput?.value.trim() ? Number(catchupCorrectionInput.value) : null,
            }
          : null
      }
      outcome = result
      close()
    })

    dialog.querySelector('[data-role="revert"]')?.addEventListener("click", () => {
      outcome = { overrides: { name: null, logo: null, chno: null, tvgId: null } }
      close()
    })

    dialog.querySelector('[data-role="cancel"]')?.addEventListener("click", close)

    dialog.addEventListener("close", () => {
      dialog.remove()
      settlePending(outcome)
    })
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault()
      close()
    })

    dialog.showModal()
    nameInput?.focus()
    nameInput?.select()
  })
}
