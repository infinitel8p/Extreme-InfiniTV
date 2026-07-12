// App-kept backup snapshot (Tauri desktop + Android only). Mirrors the same
// payload `exportAll()` produces, written to `last-backup.json` in the app
// data dir so "Restore last backup" works even if the user never saved a
// file manually. No-op on web.

import { log } from "@/scripts/lib/log.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const SNAPSHOT_FILENAME = "last-backup.json"

export async function saveBackupSnapshot(): Promise<void> {
  if (!isTauri) return
  try {
    const { exportAll } = await import("@/scripts/lib/backup.js")
    const { writeTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    const snapshot = await exportAll()
    await writeTextFile(SNAPSHOT_FILENAME, JSON.stringify(snapshot), {
      baseDir: BaseDirectory.AppData,
    })
  } catch (err) {
    log.warn("[xt:backup-snapshot] save failed:", err)
  }
}

export async function loadBackupSnapshot(): Promise<string | null> {
  if (!isTauri) return null
  try {
    const { readTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    return await readTextFile(SNAPSHOT_FILENAME, { baseDir: BaseDirectory.AppData })
  } catch {
    return null
  }
}

export async function hasBackupSnapshot(): Promise<boolean> {
  if (!isTauri) return false
  try {
    const { exists, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    return await exists(SNAPSHOT_FILENAME, { baseDir: BaseDirectory.AppData })
  } catch {
    return false
  }
}
