import { log } from "@/scripts/lib/log.js"

const isAndroid =
  typeof navigator !== "undefined" &&
  /Android/i.test(navigator.userAgent || "")

const PUBLIC_SUBDIR = "Extreme InfiniTV"

let modPromise = null
async function mod() {
  if (!isAndroid) return null
  if (!modPromise) {
    modPromise = import("tauri-plugin-android-fs-api").catch((e) => {
      log.error(
        "[xt:android-fs] plugin module unavailable, downloads will fall back:",
        e
      )
      return null
    })
  }
  return modPromise
}

export function isAndroidUri(p) {
  if (!p) return false
  if (typeof p === "string") {
    if (p.startsWith("content://")) return true
    if (p.startsWith('{"') && p.includes('"uri"')) {
      try {
        const o = JSON.parse(p)
        return !!(o && typeof o.uri === "string" && o.uri.startsWith("content://"))
      } catch {
        return false
      }
    }
    return false
  }
  if (typeof p === "object" && typeof p.uri === "string") {
    return p.uri.startsWith("content://")
  }
  return false
}

export function serializeUri(uri) {
  if (!uri) return ""
  if (typeof uri === "string") return uri
  return JSON.stringify(uri)
}

export function deserializeUri(stored) {
  if (!stored) return null
  if (typeof stored === "object") return stored
  if (stored.startsWith("content://")) return stored
  try {
    return JSON.parse(stored)
  } catch {
    return null
  }
}

export function prettifyAndroidUri(stored) {
  if (!stored) return ""
  let raw = stored
  try {
    const parsed = JSON.parse(stored)
    if (parsed && typeof parsed.uri === "string") raw = parsed.uri
  } catch {}
  try {
    const decoded = decodeURIComponent(raw)
    const match =
      decoded.match(/document\/(?:tree\/)?([^/]+)$/) ||
      decoded.match(/tree\/([^/]+)$/)
    if (match && match[1]) return match[1].replace(/^primary:/, "")
    return decoded
  } catch {
    return raw
  }
}

export function isAndroidFsActive() {
  return isAndroid
}

function mimeForExt(ext) {
  if (!ext) return "video/mp4"
  const e = ext.toLowerCase()
  if (e === "m3u8") return "application/x-mpegURL"
  if (e === "mpd") return "application/dash+xml"
  if (e === "webm") return "video/webm"
  if (e === "mkv") return "video/x-matroska"
  if (e === "ts") return "video/MP2T"
  if (e === "avi") return "video/x-msvideo"
  if (e === "mov") return "video/quicktime"
  return "video/mp4"
}

export async function createPublicDownloadFile(filename, ext) {
  const m = await mod()
  if (!m) throw new Error("Android FS plugin not available")
  return await m.AndroidFs.createNewPublicFile(
    m.AndroidPublicGeneralPurposeDir.Download,
    `${PUBLIC_SUBDIR}/${filename}`,
    mimeForExt(ext),
    { isPending: true }
  )
}

export async function pickDirectory() {
  const m = await mod()
  if (!m) throw new Error("Android FS plugin not available")
  const uri = await m.AndroidFs.showOpenDirPicker()
  if (!uri) return null
  try {
    await m.AndroidFs.persistPickerUriPermission(uri)
  } catch (e) {
    log.error("[xt:android-fs] persistPickerUriPermission failed:", e)
  }
  return uri
}

export async function createFileInPickedDir(parentUri, filename, ext) {
  const m = await mod()
  if (!m) throw new Error("Android FS plugin not available")
  return await m.AndroidFs.createNewFile(parentUri, filename, mimeForExt(ext))
}

export async function releasePickedDir(uri) {
  const m = await mod()
  if (!m) return
  try {
    await m.AndroidFs.releasePersistedPickerUriPermission(uri)
  } catch (e) {
    log.error("[xt:android-fs] releasePersistedPickerUriPermission failed:", e)
  }
}

export async function openWriteStream(uri) {
  const m = await mod()
  if (!m) throw new Error("Android FS plugin not available")
  return await m.AndroidFs.openWriteFileStream(uri, { create: false })
}

export async function publishFile(uri) {
  const m = await mod()
  if (!m) return
  try {
    await m.AndroidFs.setPublicFilePending(uri, false)
  } catch (e) {
    log.error("[xt:android-fs] setPublicFilePending failed:", e)
  }
  try {
    await m.AndroidFs.scanPublicFile(uri)
  } catch (e) {
    log.error("[xt:android-fs] scanPublicFile failed:", e)
  }
}

export async function removeFile(uri) {
  const m = await mod()
  if (!m) return
  try {
    await m.AndroidFs.removeFile(uri)
  } catch (e) {
    log.error("[xt:android-fs] removeFile failed:", uri, e)
  }
}

export async function getByteLength(uri) {
  const m = await mod()
  if (!m) return 0
  try {
    return Number(await m.AndroidFs.getByteLength(uri)) || 0
  } catch {
    return 0
  }
}

export async function fileExists(uri) {
  const m = await mod()
  if (!m) return false
  try {
    await m.AndroidFs.getByteLength(uri)
    return true
  } catch {
    return false
  }
}

export async function convertSrc(uri) {
  const m = await mod()
  if (!m) throw new Error("Android FS plugin not available")
  return m.AndroidFs.convertFileSrc(uri)
}

/**
 * Open the system file picker for an M3U / M3U8 playlist and read its
 * contents as UTF-8 text. `maxBytes` is checked via getByteLength before
 * the file is read into WebView memory, so picking a multi-GB file no
 * longer OOMs the renderer.
 *
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{text: string, name: string, size: number, oversize?: boolean} | null>}
 *          null if the user cancelled or the plugin isn't available;
 *          `oversize: true` if the file exceeded `maxBytes`.
 */
export async function pickM3UFile(opts = {}) {
  const m = await mod()
  if (!m) return null
  const uris = await m.AndroidFs.showOpenFilePicker({
    mimeTypes: [
      "audio/x-mpegurl",
      "application/vnd.apple.mpegurl",
      "application/x-mpegurl",
      "text/plain",
      "application/octet-stream",
      "*/*",
    ],
    multiple: false,
  })
  const uri = Array.isArray(uris) ? uris[0] : null
  if (!uri) return null
  let name = ""
  try {
    name = (await m.AndroidFs.getName(uri)) || ""
  } catch {}
  let size = 0
  try {
    size = Number(await m.AndroidFs.getByteLength(uri)) || 0
  } catch {}
  const maxBytes = typeof opts.maxBytes === "number" && opts.maxBytes > 0 ? opts.maxBytes : 0
  if (maxBytes && size > maxBytes) {
    return { text: "", name, size, oversize: true }
  }
  const text = await m.AndroidFs.readTextFile(uri)
  return { text, name, size: size || text.length }
}

/**
 * Open the system file picker and read the picked file as UTF-8 text.
 * @returns {Promise<{text: string, name: string} | null>} null if the user
 *          cancelled or the plugin isn't available.
 */
export async function pickJsonFile() {
  const m = await mod()
  if (!m) return null
  const uris = await m.AndroidFs.showOpenFilePicker({
    mimeTypes: [
      "application/json",
      "text/json",
      "text/plain",
      "application/octet-stream",
      "*/*",
    ],
    multiple: false,
  })
  const uri = Array.isArray(uris) ? uris[0] : null
  if (!uri) return null
  let name = ""
  try {
    name = (await m.AndroidFs.getName(uri)) || ""
  } catch {}
  const text = await m.AndroidFs.readTextFile(uri)
  return { text, name }
}

/**
 * Open the system "Save As" picker and write `bytes` to the chosen destination.
 * @returns the written file's uri (truthy, and passable to `shareFile`), or
 *          false if the user cancelled or the plugin isn't available.
 */
export async function saveBinaryFile(defaultFileName, bytes, mime = "application/octet-stream") {
  const m = await mod()
  if (!m) return false
  const uri = await m.AndroidFs.showSaveFilePicker(defaultFileName, mime)
  if (!uri) return false
  await m.AndroidFs.writeFile(uri, bytes)
  return uri
}

/**
 * Open the system "Save As" picker and write `text` (UTF-8) to the chosen destination.
 * @returns true if the file was written, false if the user cancelled or
 *          the plugin isn't available.
 */
export async function saveTextFile(defaultFileName, text, mime = "text/plain") {
  return saveBinaryFile(defaultFileName, new TextEncoder().encode(text), mime)
}

export async function saveJsonFile(defaultFileName, text) {
  return saveTextFile(defaultFileName, text, "application/json")
}

/**
 * Drop a binary file directly into the public Downloads/Extreme InfiniTV/
 * folder via MediaStore. No picker UI - used as a fallback when the SAF
 * "Save As" picker is unavailable on the device.
 *
 * @returns the on-device path (best effort) or the URI string of the
 *          written file, or null if the plugin isn't available.
 */
export async function savePublicBinaryFile(filename, bytes, mime = "application/octet-stream") {
  const m = await mod()
  if (!m) return null
  const uri = await m.AndroidFs.createNewPublicFile(
    m.AndroidPublicGeneralPurposeDir.Download,
    `${PUBLIC_SUBDIR}/${filename}`,
    mime,
    { isPending: true }
  )
  if (!uri) return null
  try {
    await m.AndroidFs.writeFile(uri, bytes)
  } catch (e) {
    try {
      await m.AndroidFs.removeFile(uri)
    } catch {}
    throw e
  }
  try {
    await m.AndroidFs.setPublicFilePending(uri, false)
  } catch (e) {
    log.warn("[xt:android-fs] setPublicFilePending(false) failed:", e)
  }
  try {
    await m.AndroidFs.scanPublicFile(uri)
  } catch (e) {
    log.warn("[xt:android-fs] scanPublicFile failed:", e)
  }
  return `Download/${PUBLIC_SUBDIR}/${filename}`
}

/**
 * Drop a text file directly into the public Downloads/Extreme InfiniTV/
 * folder via MediaStore. No picker UI - used as a fallback when the SAF
 * "Save As" picker is unavailable on the device.
 *
 * @returns the on-device path (best effort) or the URI string of the
 *          written file, or null if the plugin isn't available.
 */
export async function savePublicTextFile(filename, text, mime = "text/plain") {
  return savePublicBinaryFile(filename, new TextEncoder().encode(text), mime)
}

export async function savePublicJsonFile(filename, text) {
  return savePublicTextFile(filename, text, "application/json")
}

/**
 * Hand the URI off to Android's system "Open with..." chooser via
 * Intent.ACTION_VIEW. The user picks VLC / MX Player / native gallery / etc.
 * In-WebView local-file playback is broken on Android in current Tauri 2
 * (see tauri#12019), so this is the practical playback path until a fix lands.
 *
 * @returns true if the intent was fired, false if the plugin isn't available.
 */
export async function viewFileExternally(uri) {
  const m = await mod()
  if (!m) return false
  try {
    await m.AndroidFs.showViewFileDialog(uri)
    return true
  } catch (e) {
    log.error("[xt:android-fs] showViewFileDialog failed:", e)
    return false
  }
}

/**
 * Hand the URI off to Android's system share sheet via Intent.ACTION_SEND.
 * @returns true if the intent was fired, false if the plugin isn't available.
 */
export async function shareFile(uri) {
  const m = await mod()
  if (!m) return false
  try {
    await m.AndroidFs.showShareFileDialog(uri)
    return true
  } catch (e) {
    log.error("[xt:android-fs] showShareFileDialog failed:", e)
    return false
  }
}
