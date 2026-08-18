// In-app picker that replaces Android's system chooser for the Android
// player handoff. We enumerate installed video-handling apps ourselves
// (PackageManager via the AndroidIntent bridge), render a small dialog,
// and launch the user's pick via setPackage() - the same path the
// dedicated VLC button uses, which is the only one we've seen play
// reliably in all of VLC / MX Player / Just Player.
//
// Why not Intent.createChooser()? In testing VLC's playback service
// would fire (notification appears) but VideoPlayerActivity never
// foregrounded, so nothing actually played. The chooser routes through
// Android's ResolverActivity, and VLC's intent-filter resolution there
// is not deterministic across versions. setPackage() always lands on
// the highest-priority handler inside the chosen package.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { ICON_EXTERNAL_LINK } from "@/scripts/lib/icons.ts"
import type { AndroidVideoApp } from "@/scripts/lib/player-runtime.ts"

const DIALOG_ID = "android-player-picker"

let dlg: HTMLDialogElement | null = null

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&#39;"
  )
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
    "w-[min(32rem,calc(100vw-2rem))] max-h-[min(80dvh,36rem)]",
    "open:flex flex-col overflow-hidden",
    "backdrop:bg-black/60",
  ].join(" ")
  document.body.appendChild(node)
  dlg = node
  return dlg
}

export interface OpenPickerOpts {
  apps: AndroidVideoApp[]
  /** Optional content title shown as the dialog subtitle. */
  contentTitle?: string | null
  rememberDefault?: boolean
}

export interface PickerResult {
  app: AndroidVideoApp
  remember: boolean
}

/**
 * Show the picker. Resolves with the user's chosen app + remember flag, or
 * null if they cancelled (Escape, backdrop click, or the Cancel button).
 */
export function openAndroidPlayerPicker(
  opts: OpenPickerOpts,
): Promise<PickerResult | null> {
  const dialog = ensureDialog()
  if (!dialog) return Promise.resolve(null)

  return new Promise((resolve) => {
    const subtitle = opts.contentTitle
      ? `<div data-role="subtitle" class="text-sm text-fg-3 line-clamp-2">${escapeHtml(opts.contentTitle)}</div>`
      : ""

    const headerTitle =
      t("settings.playback.androidPickerTitle") ||
      "Open with"

    const cancelLabel =
      t("common.cancel") ||
      t("settings.playback.cancel") ||
      "Cancel"

    const emptyLabel =
      t("settings.playback.androidNoHandler") ||
      "No app on this device can play this stream."

    const rememberLabel =
      t("settings.playback.androidPickerRemember") ||
      "Always use this app"

    const apps = Array.isArray(opts.apps) ? opts.apps : []
    const rememberDefault = !!opts.rememberDefault

    const appButtons = apps
      .map((entry, idx) => {
        const label = escapeHtml(entry.label || entry.pkg)
        const pkg = escapeHtml(entry.pkg)
        const activity = escapeHtml(entry.activity || "")
        // Icons are base64-encoded data URIs (or empty if the bridge
        // couldn't load one). Fall back to a neutral monogrammed tile
        // so the layout stays consistent.
        const iconCell = entry.icon
          ? `<img
              src="${escapeHtml(entry.icon)}"
              alt=""
              aria-hidden="true"
              loading="eager"
              decoding="sync"
              class="shrink-0 w-10 h-10 rounded-xl object-contain bg-surface-2"
            />`
          : `<span
              aria-hidden="true"
              class="shrink-0 w-10 h-10 rounded-xl bg-surface-2 grid place-items-center text-fg-3 text-base font-semibold"
            >${escapeHtml((entry.label || entry.pkg).charAt(0).toUpperCase())}</span>`
        return `
          <button
            type="button"
            data-role="app-btn"
            data-pkg="${pkg}"
            data-activity="${activity}"
            data-idx="${idx}"
            class="xt-picker-row flex items-center w-full text-left gap-3.5 px-3 py-2.5 rounded-xl border border-line bg-surface hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98]"
          >
            ${iconCell}
            <span class="flex flex-col grow min-w-0">
              <span class="text-sm font-medium truncate">${label}</span>
              <span class="text-xs text-fg-3 truncate">${pkg}</span>
            </span>
          </button>
        `
      })
      .join("")

    const bodyHtml = apps.length
      ? `<div data-role="list" class="flex flex-col gap-2.5 overflow-y-auto min-h-0">${appButtons}</div>`
      : `<div class="text-sm text-fg-3 text-center py-8 px-4">${escapeHtml(emptyLabel)}</div>`

    const rememberCheckboxHtml = apps.length
      ? `
        <label
          data-role="remember-label"
          class="flex items-center gap-2.5 min-h-11 text-sm text-fg-2 px-3 py-2.5 rounded-lg cursor-pointer select-none hover:text-fg focus-within:text-fg focus-within:bg-surface-2 has-checked:text-fg has-checked:bg-accent-soft/30 transition-colors">
          <input
            type="checkbox"
            data-role="remember"
            class="size-4 accent-accent shrink-0"
            ${rememberDefault ? "checked" : ""}
          />
          <span>${escapeHtml(rememberLabel)}</span>
        </label>
      `
      : ""

    dialog.innerHTML = `
      <div class="flex flex-col flex-auto min-h-0 p-5 sm:p-6 gap-5">
        <header class="flex items-start gap-3.5 shrink-0 px-3">
          <span class="icon-mark icon-mark--lg" aria-hidden="true">${ICON_EXTERNAL_LINK}</span>
          <div class="flex flex-col gap-1 min-w-0 pt-0.5">
            <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight">${escapeHtml(headerTitle)}</h2>
            ${subtitle}
          </div>
        </header>
        ${bodyHtml}
        <footer class="flex flex-col gap-3 shrink-0 sm:flex-row sm:items-center">
          ${rememberCheckboxHtml}
          <button
            type="button"
            data-role="cancel"
            class="btn shrink-0 sm:ms-auto"
          >${escapeHtml(cancelLabel)}</button>
        </footer>
      </div>
    `

    const rememberCheckbox = dialog.querySelector<HTMLInputElement>(
      '[data-role="remember"]',
    )

    let resolved = false
    const settle = (choice: PickerResult | null) => {
      if (resolved) return
      resolved = true
      detach()
      try {
        if (dialog.open) dialog.close()
      } catch {}
      resolve(choice)
    }

    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      // Clicks inside the remember checkbox row toggle the box; never settle.
      if (target.closest('[data-role="remember-label"]')) {
        return
      }
      if (target.closest('[data-role="cancel"]')) {
        settle(null)
        return
      }
      const btn = target.closest<HTMLElement>('[data-role="app-btn"]')
      if (btn) {
        const idx = Number(btn.dataset.idx ?? "-1")
        const picked = apps[idx]
        if (picked) {
          settle({
            app: picked,
            remember: !!rememberCheckbox?.checked,
          })
        }
        return
      }
      // Click on backdrop (outside the inner content) closes.
      if (target === dialog) settle(null)
    }

    const onCancel = (event: Event) => {
      // ESC fires cancel on <dialog>; default closes. We intercept to
      // signal a null resolution and prevent the close-without-result.
      event.preventDefault()
      settle(null)
    }

    const onClose = () => {
      // Belt-and-suspenders for any other close path.
      settle(null)
    }

    const onLocaleChange = () => {
      if (resolved) return
      // Re-open with the same args under the new locale so the labels
      // refresh.
      resolved = true
      detach()
      try {
        if (dialog.open) dialog.close()
      } catch {}
      void openAndroidPlayerPicker(opts).then(resolve, () => resolve(null))
    }

    function detach() {
      dialog.removeEventListener("click", onClick)
      dialog.removeEventListener("cancel", onCancel)
      dialog.removeEventListener("close", onClose)
      document.removeEventListener(LOCALE_EVENT, onLocaleChange)
    }

    dialog.addEventListener("click", onClick)
    dialog.addEventListener("cancel", onCancel)
    dialog.addEventListener("close", onClose)
    document.addEventListener(LOCALE_EVENT, onLocaleChange)

    try {
      dialog.showModal()
    } catch (err) {
      detach()
      resolve(null)
      return
    }

    attachDialogSpatialNav(dialog, {
      defaultElement: `#${DIALOG_ID} [data-role="app-btn"], #${DIALOG_ID} [data-role="cancel"]`,
    })

    const firstFocusable = dialog.querySelector<HTMLElement>(
      '[data-role="app-btn"], [data-role="cancel"]',
    )
    firstFocusable?.focus()
  })
}
