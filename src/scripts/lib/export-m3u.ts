// Export any stored playlist entry (xtream / m3u / local-m3u / custom) to an
// .m3u file: resolve its live catalog through the normal catalog pipeline,
// map to M3UEntry, serialize, and write it via the platform-appropriate path.

import { entryToCreds } from "@/scripts/lib/creds.js"
import { ensureLive } from "@/scripts/lib/catalog.js"
import type { M3UEntry } from "@/scripts/lib/m3u-parser.ts"
import { log } from "@/scripts/lib/log.ts"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

const M3U_MIME = "audio/x-mpegurl"

export function sanitizeFilename(name: string): string {
  const trimmed = (name || "playlist").trim() || "playlist"
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120)
}

export interface BuildM3UResult {
  entries: M3UEntry[]
  skippedCount: number
}

/** Resolve a playlist entry's live catalog into M3UEntry rows. Rows without a
 *  URL (unresolved custom-playlist channels) are dropped and counted. */
export async function buildM3UEntriesForEntry(entry: any): Promise<BuildM3UResult> {
  const creds = entryToCreds(entry)
  const channels = await ensureLive(creds, entry._id, { force: true })
  const list = Array.isArray(channels) ? channels : []
  const usable = list.filter((channel: any) => channel && channel.url && !channel.unresolved)
  const entries: M3UEntry[] = usable.map((channel: any) => ({
    name: channel.name || "",
    url: channel.url,
    logo: channel.logo ?? null,
    category: channel.category ?? null,
    tvgId: channel.tvgId ?? null,
    tvgName: null,
    chno: channel.chno ?? null,
    catchup: channel.catchup ?? null,
    catchupDays: channel.catchupDays ?? null,
    catchupSource: channel.catchupSource ?? null,
    catchupCorrection: channel.catchupCorrection ?? null,
    userAgent: channel.userAgent ?? null,
    referer: channel.referer ?? null,
    tvgType: null,
    isRadio: !!channel.isRadio,
    manifestType: channel.manifestType ?? null,
    drmScheme: channel.drmScheme ?? null,
    licenseKey: channel.licenseKey ?? null,
  }))
  return { entries, skippedCount: list.length - usable.length }
}

async function downloadBlobWeb(name: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: M3U_MIME })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export interface SaveOutcome {
  /** True when the user dismissed a native save/SAF picker without saving. */
  cancelled: boolean
  /** Best-effort saved path/URI. Empty on web (browser download, no path) or when unknown. */
  savedTo: string
}

/** Write M3U text to disk: Tauri save dialog on desktop, SAF (falling back to
 *  public Downloads/) on Android, Blob download on web. */
export async function saveM3UText(filename: string, text: string): Promise<SaveOutcome> {
  if (isTauri && isAndroid) {
    const androidFs = await import("@/scripts/lib/android-fs.js")
    let pickerFailed = false
    try {
      const written = await androidFs.saveTextFile(filename, text, M3U_MIME)
      if (!written) return { cancelled: true, savedTo: "" }
    } catch (err) {
      pickerFailed = true
      log.warn("[xt:export-m3u] SAF save picker failed, falling back to public Download/:", err)
    }
    if (pickerFailed) {
      const publicPath = await androidFs.savePublicTextFile(filename, text, M3U_MIME)
      if (!publicPath) throw new Error("Android FS is not available.")
      return { cancelled: false, savedTo: publicPath }
    }
    return { cancelled: false, savedTo: "" }
  }
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog")
    const target = await save({
      defaultPath: filename,
      filters: [{ name: "M3U", extensions: ["m3u", "m3u8"] }],
    })
    if (!target) return { cancelled: true, savedTo: "" }
    const { writeTextFile } = await import("@tauri-apps/plugin-fs")
    await writeTextFile(target, text)
    return { cancelled: false, savedTo: target }
  }
  await downloadBlobWeb(filename, text)
  return { cancelled: false, savedTo: "" }
}
