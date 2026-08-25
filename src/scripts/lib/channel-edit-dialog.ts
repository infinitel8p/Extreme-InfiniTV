// "Edit channel" dialog for provider playlists: name / logo / number / hidden,
// written as a non-destructive override in preferences.js.
import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.js"
import { toast } from "@/scripts/lib/toast.ts"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.ts"
import {
  getChannelOverride,
  setChannelOverride,
  clearChannelOverride,
} from "@/scripts/lib/preferences.js"
import {
  resolveOverrideKey,
  overrideIdentity,
  sanitizeOverrideLogo,
  MAX_OVERRIDE_NAME_LENGTH,
  MAX_OVERRIDE_LOGO_LENGTH,
  MAX_OVERRIDE_CHNO,
  type OverriddenChannel,
} from "@/scripts/lib/channel-overrides.ts"

const DIALOG_ID = "xt-channel-edit-dialog"

let pendingResolve: ((result: ChannelEditResult) => void) | null = null

function settlePending(result?: ChannelEditResult): void {
  const resolve = pendingResolve
  pendingResolve = null
  resolve?.(result || { changed: false, reverted: false, hidden: false })
}

export interface ChannelEditResult {
  changed: boolean
  reverted: boolean
  hidden: boolean
}

export interface ChannelEditInit {
  playlistId: string
  channel: OverriddenChannel
  isM3U: boolean
  /** Provider values, so the dialog can show what "revert" goes back to. */
  providerName?: string
  providerLogo?: string | null
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

export function openChannelEditDialog(init: ChannelEditInit): Promise<ChannelEditResult> {
  const { playlistId, channel, isM3U } = init
  const key = resolveOverrideKey(channel, isM3U)
  const existing = key ? getChannelOverride(playlistId, key) : null
  // The passed channel already carries the overlay, so provider values come from
  // the record's stored identity when there is one.
  const providerName = init.providerName ?? existing?.srcName ?? String(channel?.name || "")
  const providerLogo = init.providerLogo ?? null

  return new Promise((resolve) => {
    if (!key) {
      resolve({ changed: false, reverted: false, hidden: false })
      return
    }
    // Removing a node fires no `close`, so a second open would leave the first
    // caller awaiting a promise that never settles.
    settlePending()
    document.getElementById(DIALOG_ID)?.remove()
    pendingResolve = resolve

    const dialog = document.createElement("dialog")
    dialog.id = DIALOG_ID
    // Same shape as every other dialog in the app: Tailwind's preflight zeroes the
    // UA `margin: auto` on <dialog>, so without `fixed inset-0 m-auto` it pins to
    // the top-left, and without the dvh height cap it overflows the viewport.
    dialog.className = [
      "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
      "w-[min(32rem,calc(100vw-2rem))] max-h-[min(80dvh,40rem)]",
      "open:flex flex-col overflow-hidden",
      "backdrop:bg-black/60",
    ].join(" ")
    dialog.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)

    const currentName = existing?.name || ""
    const currentLogo = existing?.logo || ""
    const currentChno = existing?.chno != null ? String(existing.chno) : ""
    const hidden = existing?.hidden === true

    dialog.innerHTML = `
      <form method="dialog" class="flex flex-col flex-auto min-h-0 overflow-y-auto gap-5 p-5 sm:p-6">
        <header class="flex items-start gap-3">
          ${
            providerLogo
              ? `<span class="inline-flex items-center justify-center size-10 rounded-lg border border-line bg-bg overflow-hidden shrink-0">
                   <img src="${escapeHtml(providerLogo)}" alt="" class="max-w-full max-h-full object-contain" />
                 </span>`
              : ""
          }
          <span class="flex flex-col gap-1 min-w-0">
            <span class="text-eyebrow font-semibold uppercase tracking-wide text-fg-3">
              ${escapeHtml(t("channelEdit.title") || "Edit channel")}
            </span>
            <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight break-words">
              ${escapeHtml(providerName)}
            </h2>
            <p class="text-sm text-fg-3 leading-relaxed">
              ${escapeHtml(t("channelEdit.subtitle") || "Your changes stay on this device and survive a playlist refresh.")}
            </p>
          </span>
        </header>

        <div class="flex flex-col gap-4">
          ${fieldRow(
            t("channelEdit.nameLabel") || "Name",
            `<input type="text" data-role="name" class="${INPUT_CLASS}" value="${escapeHtml(currentName)}"
               placeholder="${escapeHtml(providerName)}" autocomplete="off" spellcheck="false"
               maxlength="${MAX_OVERRIDE_NAME_LENGTH}" />`
          )}
          ${fieldRow(
            t("channelEdit.logoLabel") || "Logo URL",
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
            t("channelEdit.numberLabel") || "Channel number",
            `<input type="number" min="1" step="1" max="${MAX_OVERRIDE_CHNO}" data-role="chno" class="${INPUT_CLASS}" value="${escapeHtml(currentChno)}"
               placeholder="${escapeHtml(channel?.chno != null ? String(channel.chno) : "")}" inputmode="numeric" />`
          )}
          <label class="flex items-start gap-3 min-h-11">
            <input type="checkbox" data-role="hidden" class="mt-1 size-4 accent-accent" ${hidden ? "checked" : ""} />
            <span class="flex flex-col gap-0.5">
              <span class="text-sm font-medium text-fg-2">${escapeHtml(t("channelEdit.hideLabel") || "Hide this channel")}</span>
              <span class="text-xs text-fg-3 leading-relaxed">${escapeHtml(
                t("channelEdit.hideHint") || "Hidden channels stay out of every list until you unhide them in Settings."
              )}</span>
            </span>
          </label>
        </div>

        <footer class="flex flex-wrap items-center gap-3 shrink-0 mt-auto">
          <button type="button" data-role="revert" class="btn-danger"${existing ? "" : " disabled"}>
            ${escapeHtml(t("settings.channelOverrides.revert") || "Reset")}
          </button>
          <button type="button" data-role="cancel" class="btn ms-auto">${escapeHtml(t("common.cancel") || "Cancel")}</button>
          <button type="button" data-role="save" class="btn btn-primary">${escapeHtml(t("common.save") || "Save")}</button>
        </footer>
      </form>
    `

    document.body.appendChild(dialog)
    const releaseSpatialNav = attachDialogSpatialNav(dialog, {
      defaultElement: `#${DIALOG_ID} [data-role="name"]`,
    })

    const nameInput = dialog.querySelector<HTMLInputElement>('[data-role="name"]')
    const logoInput = dialog.querySelector<HTMLInputElement>('[data-role="logo"]')
    const chnoInput = dialog.querySelector<HTMLInputElement>('[data-role="chno"]')
    const hiddenInput = dialog.querySelector<HTMLInputElement>('[data-role="hidden"]')
    const preview = dialog.querySelector<HTMLImageElement>('[data-role="logo-preview"]')
    const logoStatus = dialog.querySelector<HTMLElement>('[data-role="logo-status"]')

    // The frame stays put whether or not there's an image, so typing a URL can't
    // shift the fields under the cursor.
    const paintPreview = () => {
      const rawUrl = (logoInput?.value || "").trim() || providerLogo || ""
      if (!preview) return
      if (!rawUrl) {
        preview.removeAttribute("src")
        if (logoStatus) logoStatus.textContent = ""
        return
      }
      // Preview only what save would accept, so the two can't disagree.
      const safeUrl = sanitizeOverrideLogo(rawUrl)
      if (!safeUrl) {
        preview.removeAttribute("src")
        if (logoStatus) logoStatus.textContent = t("channelEdit.logoInvalid")
        return
      }
      if (logoStatus) logoStatus.textContent = t("channelEdit.logoLoading") || "Loading preview…"
      preview.onload = () => {
        if (logoStatus) {
          logoStatus.textContent = (logoInput?.value || "").trim()
            ? t("channelEdit.logoPreview") || "Preview"
            : t("channelEdit.logoProvider") || "Provider logo"
        }
      }
      preview.onerror = () => {
        if (logoStatus) logoStatus.textContent = t("channelEdit.logoFailed") || "That image didn't load."
      }
      preview.src = safeUrl
    }
    paintPreview()
    let previewTimer: ReturnType<typeof setTimeout> | null = null
    logoInput?.addEventListener("input", () => {
      if (previewTimer) clearTimeout(previewTimer)
      previewTimer = setTimeout(paintPreview, 400)
    })

    let outcome: ChannelEditResult = { changed: false, reverted: false, hidden }
    const close = () => {
      if (previewTimer) clearTimeout(previewTimer)
      releaseSpatialNav?.()
      dialog.close()
    }

    const saveButton = dialog.querySelector<HTMLButtonElement>('[data-role="save"]')
    saveButton?.addEventListener("click", () => {
      const rawLogo = (logoInput?.value || "").trim()
      // Refuse a URL that could never render rather than storing a dead value.
      if (rawLogo && !sanitizeOverrideLogo(rawLogo)) {
        if (logoStatus) logoStatus.textContent = t("channelEdit.logoInvalid")
        logoInput?.focus()
        logoInput?.select()
        return
      }
      const identity = overrideIdentity({ ...channel, name: providerName })
      const nextName = (nameInput?.value || "").trim()
      const nextHidden = hiddenInput?.checked === true
      setChannelOverride(playlistId, key, {
        // A name equal to the provider's is not an override; store nothing.
        name: nextName && nextName !== providerName ? nextName : null,
        logo: rawLogo || null,
        chno: chnoInput?.value ? Number(chnoInput.value) : null,
        hidden: nextHidden,
        srcName: identity.srcName,
        srcTvgId: identity.srcTvgId,
      })
      outcome = { changed: true, reverted: false, hidden: nextHidden }
      close()
    })

    dialog.querySelector('[data-role="revert"]')?.addEventListener("click", () => {
      // Same weight as hiding a channel: undo rather than a confirm in the way.
      const restore = existing ? { ...existing } : null
      clearChannelOverride(playlistId, key)
      outcome = { changed: true, reverted: true, hidden: false }
      close()
      toast({
        title: t("channelEdit.revertToast", { name: providerName }),
        duration: 6000,
        action: restore
          ? {
              label: t("common.undo"),
              onClick: () => setChannelOverride(playlistId, key, restore),
            }
          : undefined,
      })
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
