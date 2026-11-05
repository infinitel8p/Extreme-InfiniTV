// Shared backup export: platform save (Android SAF -> public Download/, Tauri dialog, web download).

import { log } from "@/scripts/lib/log.js"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { t } from "@/scripts/lib/i18n.js"
import { isTauri } from "@/scripts/lib/creds.js"
import { isAndroidFsActive } from "@/scripts/lib/android-fs.js"
import { saveBackupSnapshot } from "@/scripts/lib/backup-snapshot.ts"


export interface ExportBackupOutcome {
  cancelled: boolean
  /** Best-effort saved path/URI. Empty on web or when unknown. */
  savedTo: string
  playlistCount: number
}

export interface ExportBackupOptions {
  logTag: string
}

function downloadBlobWeb(name: string, content: string): void {
  const blob = new Blob([content], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

async function writeBackupFile(
  filename: string,
  json: string,
  logTag: string
): Promise<{ cancelled: boolean; savedTo: string }> {
  if (isTauri && isAndroidFsActive()) {
    const androidFs = await import("@/scripts/lib/android-fs.js")
    let pickerFailed = false
    let pickerError: unknown = null
    try {
      const written = await androidFs.saveJsonFile(filename, json)
      if (!written) return { cancelled: true, savedTo: "" }
    } catch (err) {
      pickerFailed = true
      pickerError = err
      log.warn(`[${logTag}] SAF save picker failed, falling back to public Download/:`, err)
    }
    if (pickerFailed) {
      const publicPath = await androidFs.savePublicJsonFile(filename, json)
      if (!publicPath) {
        log.error(`[${logTag}] public Download/ save unavailable:`, pickerError)
        throw new Error(t("settings.toast.backupSaveUnavailable"))
      }
      return { cancelled: false, savedTo: publicPath }
    }
    return { cancelled: false, savedTo: "" }
  }
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog")
    const target = await save({
      defaultPath: filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (!target) return { cancelled: true, savedTo: "" }
    const { writeTextFile } = await import("@tauri-apps/plugin-fs")
    await writeTextFile(target, json)
    return { cancelled: false, savedTo: target }
  }
  downloadBlobWeb(filename, json)
  return { cancelled: false, savedTo: "" }
}

export async function exportBackupToFile(options: ExportBackupOptions): Promise<ExportBackupOutcome> {
  const { exportAll, suggestedFilename } = await import("@/scripts/lib/backup.js")
  const snapshot = await exportAll()
  const json = JSON.stringify(snapshot, null, 2)
  const playlistCount = (snapshot as any).creds.entries.length
  const result = await writeBackupFile(suggestedFilename(), json, options.logTag)
  if (result.cancelled) return { cancelled: true, savedTo: "", playlistCount }
  saveBackupSnapshot().catch((err: unknown) => {
    log.warn(`[${options.logTag}] backup snapshot refresh failed:`, err)
  })
  return { cancelled: false, savedTo: result.savedTo, playlistCount }
}

/** Returns true only when a file was written. */
export async function exportBackupWithToasts(options: ExportBackupOptions): Promise<boolean> {
  try {
    const outcome = await exportBackupToFile(options)
    if (outcome.cancelled) return false
    toastSuccess(t("settings.toast.backupExported"), {
      description: outcome.savedTo
        ? `${outcome.playlistCount} playlist(s) - ${outcome.savedTo}`
        : `${outcome.playlistCount} playlist(s).`,
      duration: 6000,
    })
    return true
  } catch (error: any) {
    log.error(`[${options.logTag}] failed:`, error)
    toastError(t("settings.toast.backupExportFail"), {
      description: (error && error.message) || "See console.",
    })
    return false
  }
}
