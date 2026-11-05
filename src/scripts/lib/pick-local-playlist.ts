import { LOCAL_CONTENT_MAX_BYTES } from "@/scripts/lib/local-content.js"
import { isAndroidFsActive, pickM3UFile } from "@/scripts/lib/android-fs.js"
import { isTauri } from "@/scripts/lib/creds.js"
import { isHlsStreamManifest, parseM3U } from "@/scripts/lib/m3u-parser"

export const MAX_LOCAL_M3U_BYTES: number = LOCAL_CONTENT_MAX_BYTES

export interface PickedPlaylist {
  name: string
  text: string
  size: number
  oversize?: boolean
}

export class NoFilePickerError extends Error {}

export type PlaylistValidation =
  | { ok: true; entryCount: number; epgUrl: string }
  | { ok: false; reasonKey: string; size?: number }

function looksLikeM3U(text: string): boolean {
  const head = (text || "").slice(0, 4096)
  return head.includes("#EXTM3U") || /#EXTINF\s*:/i.test(head)
}

async function pickViaTauri(): Promise<PickedPlaylist | null> {
  const { open } = await import("@tauri-apps/plugin-dialog")
  const pickedPath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "M3U playlist", extensions: ["m3u", "m3u8"] }],
  })
  if (!pickedPath || typeof pickedPath !== "string") return null
  const fs = await import("@tauri-apps/plugin-fs")
  let size = 0
  try {
    const stat = await fs.stat(pickedPath)
    size = stat?.size || 0
  } catch {}
  const slash = Math.max(pickedPath.lastIndexOf("/"), pickedPath.lastIndexOf("\\"))
  const name = slash >= 0 ? pickedPath.slice(slash + 1) : pickedPath
  if (size > MAX_LOCAL_M3U_BYTES) return { name, text: "", size, oversize: true }
  const text = await fs.readTextFile(pickedPath)
  return { name, text, size: size || text.length }
}

export async function pickLocalPlaylistFile(): Promise<PickedPlaylist | null> {
  if (isAndroidFsActive()) {
    try {
      const picked = await pickM3UFile({ maxBytes: MAX_LOCAL_M3U_BYTES })
      return picked || null
    } catch (error) {
      throw new NoFilePickerError(String((error as Error)?.message || error))
    }
  }
  if (isTauri) return pickViaTauri()
  return null
}

export function validatePickedPlaylist(picked: PickedPlaylist): PlaylistValidation {
  const textSize = picked.text?.length || 0
  if (picked.oversize && !picked.size) {
    return { ok: false, reasonKey: "login.status.localTooLargeUnknown" }
  }
  if (picked.oversize || picked.size > MAX_LOCAL_M3U_BYTES || textSize > MAX_LOCAL_M3U_BYTES) {
    return { ok: false, reasonKey: "login.status.localTooLarge", size: picked.size || textSize }
  }
  if (!picked.text) return { ok: false, reasonKey: "login.status.localEmpty" }
  if (!looksLikeM3U(picked.text) || isHlsStreamManifest(picked.text)) {
    return { ok: false, reasonKey: "login.status.localNotM3u" }
  }
  const parsed = parseM3U(picked.text)
  return { ok: true, entryCount: parsed.entries.length, epgUrl: parsed.epgUrl || "" }
}
