// Shared "restore from backup" wiring: platform file picker (Android SAF ->
// Tauri dialog -> web <input type=file>), a section picker dialog, then import.

import { log } from "@/scripts/lib/log.js"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { t } from "@/scripts/lib/i18n.js"
import { pickBackupSections } from "@/scripts/lib/backup-sections-dialog.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)
const isAndroid =
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent || "")

export interface BackupSummary {
  playlists: number
  prefsPlaylists: number
  sections: string[]
}

export interface RestoreTextOptions {
  logTag: string
  onRestored?: (summary: BackupSummary) => void | Promise<void>
  successDuration?: number
}

export interface RestoreBackupOptions extends RestoreTextOptions {
  fileInput: HTMLInputElement | null
  onBusyChange?: (busy: boolean) => void
}

/** Parse -> validate -> pick sections -> import -> toast. Returns true only when an import ran. */
export async function restoreBackupText(text: string, options: RestoreTextOptions): Promise<boolean> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (parseError) {
    log.warn(`[${options.logTag}] backup JSON parse failed:`, parseError)
    toastError(t("settings.toast.backupParseFail"), { description: "Not valid JSON." })
    return false
  }
  try {
    const { BACKUP_SECTIONS, BACKUP_FORMAT_MARKER_ERROR, importAll, isBackupBlob } = await import(
      "@/scripts/lib/backup.js"
    )
    if (!isBackupBlob(parsed)) {
      toastError(t("settings.toast.backupRestoreFail"), { description: BACKUP_FORMAT_MARKER_ERROR })
      return false
    }
    const present = BACKUP_SECTIONS.filter(
      (name: string) => parsed && typeof parsed === "object" && name in (parsed as Record<string, unknown>)
    )
    const sections = await pickBackupSections(present)
    if (!sections) return false
    const summary = (await importAll(parsed, { sections })) as BackupSummary
    toastSuccess(t("settings.toast.backupRestored"), {
      description: `${summary.playlists} playlist(s), ${summary.prefsPlaylists} preference set(s).`,
      duration: options.successDuration ?? 4000,
    })
    await options.onRestored?.(summary)
    return true
  } catch (error: unknown) {
    log.error(`[${options.logTag}] backup import failed:`, error)
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "See console."
    toastError(t("settings.toast.backupRestoreFail"), { description: message })
    return false
  }
}

async function applyBackupText(text: string, options: RestoreBackupOptions) {
  await restoreBackupText(text, options)
}

/** Android SAF -> Tauri dialog -> web <input> pick, then import + toast. */
export async function pickAndRestoreBackup(
  options: RestoreBackupOptions,
  setBusy: (busy: boolean) => void = () => {}
): Promise<void> {
  const { fileInput, logTag } = options
  if (isTauri && isAndroid) {
    try {
      setBusy(true)
      const { pickJsonFile } = await import("@/scripts/lib/android-fs.js")
      const picked = await pickJsonFile()
      if (picked) await applyBackupText(picked.text, options)
      setBusy(false)
      return
    } catch (error) {
      log.warn(`[${logTag}] android-fs picker failed, falling back:`, error)
      setBusy(false)
      if (!fileInput) {
        toastError(t("settings.toast.backupRestoreFail"), {
          description: t("settings.toast.backupPickerUnavailable"),
        })
        return
      }
    }
  } else if (isTauri) {
    try {
      setBusy(true)
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
      if (picked && typeof picked === "string") {
        const { readTextFile } = await import("@tauri-apps/plugin-fs")
        await applyBackupText(await readTextFile(picked), options)
      }
      setBusy(false)
      return
    } catch (error) {
      log.warn(`[${logTag}] tauri open failed, falling back:`, error)
      setBusy(false)
      if (!fileInput) {
        toastError(t("settings.toast.backupRestoreFail"), {
          description: t("settings.toast.backupPickerUnavailable"),
        })
        return
      }
    }
  }
  setBusy(true)
  fileInput?.click()
}

/** Wire a "restore from backup" trigger to the platform-appropriate file picker
 * (Android SAF -> Tauri dialog -> web <input>), then parse + import the chosen
 * JSON and run the caller's follow-up. Native pickers fall back to the web
 * <input> when they fail; the busy flag guards against concurrent picks and is
 * cleared if a web pick is abandoned (window regains focus with no file). */
export function bindBackupRestore(trigger: HTMLElement | null, options: RestoreBackupOptions) {
  if (!trigger) return
  const { fileInput, onBusyChange } = options
  let busy = false
  const setBusy = (next: boolean) => {
    busy = next
    onBusyChange?.(next)
  }

  trigger.addEventListener("click", async () => {
    if (busy) return
    await pickAndRestoreBackup(options, setBusy)
  })

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0]
    if (!file) {
      setBusy(false)
      return
    }
    try {
      await applyBackupText(await file.text(), options)
    } finally {
      fileInput.value = ""
      setBusy(false)
    }
  })

  if (!isTauri) {
    window.addEventListener("focus", () => {
      if (busy && fileInput && !fileInput.files?.length) {
        setTimeout(() => {
          if (busy && !fileInput.files?.length) setBusy(false)
        }, 200)
      }
    })
  }
}
