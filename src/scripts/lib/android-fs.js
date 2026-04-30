const isAndroid =
  typeof navigator !== "undefined" &&
  /Android/i.test(navigator.userAgent || "")

const PUBLIC_SUBDIR = "Extreme InfiniTV"

let modPromise = null
async function mod() {
  if (!isAndroid) return null
  if (!modPromise) {
    modPromise = import("tauri-plugin-android-fs-api").catch((e) => {
      console.error(
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
    console.error("[xt:android-fs] persistPickerUriPermission failed:", e)
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
    console.error("[xt:android-fs] releasePersistedPickerUriPermission failed:", e)
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
    console.error("[xt:android-fs] setPublicFilePending failed:", e)
  }
  try {
    await m.AndroidFs.scanPublicFile(uri)
  } catch (e) {
    console.error("[xt:android-fs] scanPublicFile failed:", e)
  }
}

export async function removeFile(uri) {
  const m = await mod()
  if (!m) return
  try {
    await m.AndroidFs.removeFile(uri)
  } catch (e) {
    console.error("[xt:android-fs] removeFile failed:", uri, e)
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
    console.error("[xt:android-fs] showViewFileDialog failed:", e)
    return false
  }
}
