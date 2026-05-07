import { log } from "@/scripts/lib/log.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  getDownloadDir,
  setDownloadDir,
  getDownloadConcurrency,
} from "@/scripts/lib/app-settings.js"
import {
  getMaxConnectionsSync,
  getActivePlaylistIdSync,
} from "@/scripts/lib/account-info.js"
import { safeHttpUrl } from "@/scripts/lib/creds.js"
import * as AFs from "@/scripts/lib/android-fs.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

const STORAGE_KEY = "xt_downloads"
const EVT_PROGRESS = "xt:download-progress"
const EVT_LIST = "xt:downloads-changed"

const STALL_WINDOW_MS = 30_000
const STALL_CHECK_MS = 5_000

function maxConcurrent() {
  const user = getDownloadConcurrency()
  const cap = getMaxConnectionsSync(getActivePlaylistIdSync())
  if (cap > 0 && cap < user) return cap
  return user
}

/** @type {string[]} ids waiting for an active slot */
const queuedIds = []

function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeState(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {}
  document.dispatchEvent(new CustomEvent(EVT_LIST, { detail: list }))
}

function uuid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function listDownloads() {
  return readState()
}

export function isDownloadable() {
  return isTauri
}

export async function getLocalPlayableSrc(remoteUrl) {
  if (!isTauri || !remoteUrl) return null
  const item = readState().find(
    (d) => d.url === remoteUrl && d.status === "done" && d.path
  )
  if (!item) return null

  if (AFs.isAndroidUri(item.path)) {
    if (!(await AFs.fileExists(item.path))) {
      log.warn(
        "[xt:download] local file missing, falling back to stream:",
        item.path
      )
      return null
    }
    try {
      return await AFs.convertSrc(item.path)
    } catch (e) {
      log.error("[xt:download] android convertSrc failed:", e)
      return null
    }
  }

  try {
    const fs = await import("@tauri-apps/plugin-fs")
    if (typeof fs.exists === "function" && !(await fs.exists(item.path))) {
      log.warn(
        "[xt:download] local file missing, falling back to stream:",
        item.path
      )
      return null
    }
  } catch (e) {
    log.error("[xt:download] exists() failed for", item.path, e)
    return null
  }
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core")
    return convertFileSrc(item.path)
  } catch (e) {
    log.error("[xt:download] convertFileSrc failed:", e)
    return null
  }
}

/**
 * Android-only: if the remote URL has a completed local download, hand the
 * file off to the system "Open with..." chooser via Intent.ACTION_VIEW.
 * In-WebView local playback isn't viable on Android (tauri#12019, custom
 * URL protocols not intercepted by the system WebView), so the conventional
 * hybrid-app pattern is to defer to a real player like VLC / MX Player /
 * the system gallery. Returns true if the chooser was launched (caller
 * should bail out of starting in-app playback), false otherwise.
 */
export async function tryAndroidIntentPlayback(remoteUrl) {
  if (!isTauri || !remoteUrl) return false
  if (!AFs.isAndroidFsActive()) return false
  const item = readState().find(
    (d) => d.url === remoteUrl && d.status === "done" && d.path
  )
  if (!item || !AFs.isAndroidUri(item.path)) return false
  log.log("[xt:download] handing off to system video app:", item.path)
  return await AFs.viewFileExternally(item.path)
}

const WIN_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
])

export function sanitizeFilename(name) {
  let s = String(name || "download")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/, "")
    .slice(0, 200)
    .replace(/[. ]+$/g, "")

  if (!s) return "download"

  const stem = s.split(".")[0].toUpperCase()
  if (WIN_RESERVED_NAMES.has(stem)) s = "_" + s

  return s
}

export function inferExt(url, fallback = "mp4") {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i)
    if (m) return m[1].toLowerCase()
  } catch {}
  return fallback
}

const activeAborts = new Map()

/**
 * Per-id retry counter for transient OS-level file-lock errors (Windows
 * ERROR_SHARING_VIOLATION = error 32). Cleared on successful completion or
 * after the retry budget is exhausted.
 * @type {Map<string, number>}
 */
const lockRetryCount = new Map()

function isFileLockError(msg) {
  if (!msg) return false
  return /os error 32|sharing violation|verwendet wird|being used by another/i.test(
    msg
  )
}

async function pickDir() {
  const saved = getDownloadDir()
  if (saved) return saved
  try {
    const { open } = await import("@tauri-apps/plugin-dialog")
    const picked = await open({ directory: true, title: "Choose download folder" })
    if (!picked || typeof picked !== "string") return null
    setDownloadDir(picked)
    return picked
  } catch (e) {
    log.error("[xt:download] folder picker failed:", e)
    throw e
  }
}

async function ensureDir(path) {
  try {
    const { mkdir, exists } = await import("@tauri-apps/plugin-fs")
    if (await exists(path)) return
    await mkdir(path, { recursive: true })
  } catch (e) {
    log.error("[xt:download] ensureDir failed for", path, e)
    throw e
  }
}

const META_DIR = ".xtream-meta"

function pathParts(fullPath) {
  const sep = /\\/.test(fullPath) ? "\\" : "/"
  const idx = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"))
  if (idx < 0) return { dir: "", name: fullPath, sep }
  return { dir: fullPath.slice(0, idx), name: fullPath.slice(idx + 1), sep }
}

function metaSidecarPath(mediaPath) {
  const { dir, name, sep } = pathParts(mediaPath)
  const stem = name.replace(/\.[^.]+$/, "")
  return dir
    ? `${dir}${sep}${META_DIR}${sep}${stem}.json`
    : `${META_DIR}${sep}${stem}.json`
}

/**
 * Write `<dir>/.xtream-meta/<basename>.json` next to a finished download so a
 * fresh install can rediscover it via scanDownloadsFolder(). Stashed in a
 * dotfolder so the user's library isn't littered with `.xtmeta.json` files.
 */
async function writeMetaSidecar(item) {
  if (!isTauri) return
  if (!item?.path || AFs.isAndroidUri(item.path)) return
  try {
    const fs = await import("@tauri-apps/plugin-fs")
    const { dir, sep } = pathParts(item.path)
    if (dir) {
      const metaDir = `${dir}${sep}${META_DIR}`
      try {
        if (typeof fs.exists === "function" && !(await fs.exists(metaDir))) {
          await fs.mkdir(metaDir, { recursive: true })
        }
      } catch {}
    }
    const meta = {
      schema: 1,
      mediaFile: pathParts(item.path).name,
      title: item.title || "",
      url: item.url || "",
      bytesTotal: item.bytesTotal || 0,
      downloadedAt: Date.now(),
      source: item.source || null,
    }
    await fs.writeTextFile(metaSidecarPath(item.path), JSON.stringify(meta, null, 2))
  } catch (error) {
    log.warn("[xt:download] sidecar write failed:", error)
  }
}

async function removeMetaSidecar(path) {
  if (!isTauri || !path || AFs.isAndroidUri(path)) return
  try {
    const fs = await import("@tauri-apps/plugin-fs")
    const sidecarPath = metaSidecarPath(path)
    if (typeof fs.exists === "function" && (await fs.exists(sidecarPath))) {
      await fs.remove(sidecarPath)
    }
  } catch {}
}

async function statSize(path) {
  if (AFs.isAndroidUri(path)) {
    return await AFs.getByteLength(path)
  }
  const fs = await import("@tauri-apps/plugin-fs")
  let exists = false
  try {
    exists = await fs.exists(path)
  } catch {
    return 0
  }
  if (!exists) return 0
  if (typeof fs.stat === "function") {
    const s = await fs.stat(path)
    return Number(s?.size || 0)
  }
  if (typeof fs.readFile === "function") {
    const buf = await fs.readFile(path)
    return buf?.byteLength || buf?.length || 0
  }
  return 0
}

function joinPath(dir, name) {
  const sep = /\\/.test(dir) ? "\\" : "/"
  return dir.replace(/[\\/]$/, "") + sep + name
}

function updateItem(id, patch) {
  const list = readState()
  const idx = list.findIndex((d) => d.id === id)
  if (idx < 0) return
  list[idx] = { ...list[idx], ...patch }
  writeState(list)
  document.dispatchEvent(
    new CustomEvent(EVT_PROGRESS, { detail: list[idx] })
  )
}

function getItem(id) {
  return readState().find((d) => d.id === id) || null
}

async function runDownloadAndroid(id, item, controller) {
  let lastProgressAt = Date.now()
  let received = 0
  let stallTimer = null

  const watchStall = () => {
    if (controller.signal.aborted) return
    if (Date.now() - lastProgressAt > STALL_WINDOW_MS) {
      controller.abort("stalled")
      return
    }
    stallTimer = setTimeout(watchStall, STALL_CHECK_MS)
  }
  stallTimer = setTimeout(watchStall, STALL_CHECK_MS)

  try {
    updateItem(id, { status: "downloading", bytesDone: 0, error: "" })

    const res = await providerFetch(item.url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const total = Number(res.headers.get("content-length") || 0)
    updateItem(id, { bytesTotal: total, bytesDone: 0 })

    const reader = res.body?.getReader()
    if (!reader) throw new Error("Response has no readable body.")

    const writable = await AFs.openWriteStream(item.path)
    const writer = writable.getWriter()

    try {
      let pendingFlushAt = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || !value.length) continue
        await writer.write(value)
        received += value.length
        lastProgressAt = Date.now()
        if (lastProgressAt - pendingFlushAt > 250) {
          pendingFlushAt = lastProgressAt
          updateItem(id, { bytesDone: received })
        }
      }
      await writer.close()
    } catch (e) {
      try {
        await writer.abort(e)
      } catch {}
      throw e
    }

    if (total > 0 && received !== total) {
      throw new Error(
        `Size mismatch: got ${received} bytes, expected ${total}.`
      )
    }

    await AFs.publishFile(item.path)

    updateItem(id, {
      status: "done",
      bytesDone: received,
      bytesTotal: total || received,
    })
    writeMetaSidecar(getItem(id))
  } catch (e) {
    if (controller.signal.aborted) {
      const userPaused = controller.signal.reason === "paused"
      const stalled = controller.signal.reason === "stalled"
      try { await AFs.removeFile(item.path) } catch {}
      if (stalled) {
        updateItem(id, {
          status: "stalled",
          bytesDone: 0,
          error: "No data received for 30s. Tap Resume to retry.",
        })
      } else if (userPaused) {
        updateItem(id, {
          status: "paused",
          bytesDone: 0,
          error: "",
          userPaused: true,
        })
      } else {
        updateItem(id, { status: "paused", bytesDone: 0 })
      }
    } else {
      const msg = String(e?.message || e || "Failed")
      log.error("[xt:download] runDownload (android) failed", {
        id,
        url: item.url,
        path: item.path,
        msg,
        error: e,
      })
      try { await AFs.removeFile(item.path) } catch {}
      updateItem(id, { status: "error", bytesDone: 0, error: msg })
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
  }
}

async function runDownload(id) {
  const item = getItem(id)
  if (!item) return

  const controller = new AbortController()
  activeAborts.set(id, controller)

  if (AFs.isAndroidUri(item.path)) {
    try {
      await runDownloadAndroid(id, item, controller)
    } finally {
      activeAborts.delete(id)
      tryRunNext()
    }
    return
  }

  let lastProgressAt = Date.now()
  let received = await statSize(item.path)
  let stallTimer = null

  const watchStall = () => {
    if (controller.signal.aborted) return
    if (Date.now() - lastProgressAt > STALL_WINDOW_MS) {
      controller.abort("stalled")
      return
    }
    stallTimer = setTimeout(watchStall, STALL_CHECK_MS)
  }
  stallTimer = setTimeout(watchStall, STALL_CHECK_MS)

  try {
    const fs = await import("@tauri-apps/plugin-fs")

    const headers = new Headers()
    if (received > 0) headers.set("Range", `bytes=${received}-`)

    updateItem(id, {
      status: "downloading",
      bytesDone: received,
      error: "",
    })

    const res = await providerFetch(item.url, {
      signal: controller.signal,
      headers,
    })

    // 416 = Range Not Satisfiable. If we already have everything, treat as done.
    if (res.status === 416 && received > 0) {
      updateItem(id, { status: "done", bytesDone: received, bytesTotal: received })
      return
    }
    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }

    let total = 0
    if (res.status === 206) {
      const cr = res.headers.get("content-range") || ""
      const m = cr.match(/\/(\d+)\s*$/)
      if (m) total = Number(m[1])
      else total = received + Number(res.headers.get("content-length") || 0)
    } else {
      // Server didn't honor Range — restart from byte 0.
      if (received > 0) {
        await fs.writeFile(item.path, new Uint8Array(0))
        received = 0
      }
      total = Number(res.headers.get("content-length") || 0)
    }

    updateItem(id, { bytesTotal: total, bytesDone: received })

    const reader = res.body?.getReader()
    if (!reader) throw new Error("Response has no readable body.")

    let pendingFlushAt = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.length) continue

      await fs.writeFile(item.path, value, { append: true })

      received += value.length
      lastProgressAt = Date.now()

      if (lastProgressAt - pendingFlushAt > 250) {
        pendingFlushAt = lastProgressAt
        updateItem(id, { bytesDone: received })
      }
    }

    if (total > 0 && received !== total) {
      throw new Error(
        `Size mismatch after resume: got ${received} bytes, expected ${total}. The file may be corrupt - remove it and re-download.`
      )
    }
    if (total > 0) {
      const onDisk = await statSize(item.path)
      if (onDisk !== total) {
        throw new Error(
          `On-disk size ${onDisk} doesn't match expected ${total}. Remove and re-download.`
        )
      }
    }

    updateItem(id, {
      status: "done",
      bytesDone: received,
      bytesTotal: total || received,
    })
    lockRetryCount.delete(id)
    writeMetaSidecar(getItem(id))
  } catch (e) {
    const msg = String(e?.message || e || "Failed")
    const reason = controller.signal.reason
    if (!controller.signal.aborted) {
      log.error("[xt:download] runDownload failed", {
        id,
        url: item.url,
        path: item.path,
        msg,
        error: e,
      })
    }
    if (reason === "stalled") {
      updateItem(id, {
        status: "stalled",
        bytesDone: received,
        error: "No data received for 30s. Tap Resume to retry.",
      })
    } else if (controller.signal.aborted) {
      const userPaused = controller.signal.reason === "paused"
      if (userPaused) {
        updateItem(id, {
          status: "paused",
          bytesDone: received,
          error: "",
          userPaused: true,
        })
      } else {
        updateItem(id, { bytesDone: received })
      }
    } else if (isFileLockError(msg) && (lockRetryCount.get(id) || 0) < 2) {
      const tries = (lockRetryCount.get(id) || 0) + 1
      lockRetryCount.set(id, tries)
      updateItem(id, {
        status: "paused",
        bytesDone: received,
        error: "",
      })
      setTimeout(() => resumeDownload(id), 2500)
    } else {
      const friendly = isFileLockError(msg)
        ? "The file is in use by another program. Close it (e.g. a media player) and tap Resume."
        : msg
      lockRetryCount.delete(id)
      updateItem(id, {
        status: "error",
        bytesDone: received,
        error: friendly,
      })
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    activeAborts.delete(id)
    tryRunNext()
  }
}

function tryRunNext() {
  while (activeAborts.size < maxConcurrent() && queuedIds.length > 0) {
    const nextId = queuedIds.shift()
    if (!nextId) continue
    const next = getItem(nextId)
    if (!next || next.status !== "queued") continue
    runDownload(nextId)
  }
}

export async function startDownload({ url, title, ext, source }) {
  if (!isTauri) {
    throw new Error("Downloads are only available in the desktop build.")
  }

  const resolvedExt = ext || inferExt(url)
  const filename = sanitizeFilename(title || "download") + "." + resolvedExt

  let fullPath
  if (AFs.isAndroidFsActive()) {
    const parentDir = AFs.deserializeUri(getDownloadDir())
    try {
      if (parentDir) {
        fullPath = await AFs.createFileInPickedDir(parentDir, filename, resolvedExt)
      } else {
        fullPath = await AFs.createPublicDownloadFile(filename, resolvedExt)
      }
    } catch (e) {
      log.error("[xt:download] android create file failed:", e)
      throw new Error("Couldn't create download file: " + (e?.message || e))
    }
  } else {
    let dir
    try {
      dir = await pickDir()
    } catch (e) {
      log.error("[xt:download] startDownload pickDir threw:", e)
      throw e
    }
    if (!dir) throw new Error("No download folder chosen.")
    try {
      await ensureDir(dir)
    } catch (e) {
      log.error("[xt:download] startDownload ensureDir threw for", dir, e)
      throw e
    }
    fullPath = joinPath(dir, filename)
  }

  const id = uuid()
  const willRun = activeAborts.size < maxConcurrent()
  const item = {
    id,
    url,
    title: title || filename,
    path: fullPath,
    bytesDone: 0,
    bytesTotal: 0,
    status: willRun ? "downloading" : "queued",
    startedAt: Date.now(),
    error: "",
    source: source || null,
  }
  const list = readState()
  list.unshift(item)
  writeState(list)

  if (willRun) runDownload(id)
  else queuedIds.push(id)
  return id
}

export function resumeDownload(id) {
  if (!isTauri) return
  if (activeAborts.has(id)) return
  if (queuedIds.includes(id)) return
  const item = getItem(id)
  if (!item) return
  if (item.status === "done") return
  updateItem(id, { userPaused: false })
  if (activeAborts.size < maxConcurrent()) {
    runDownload(id)
  } else {
    updateItem(id, { status: "queued", error: "" })
    queuedIds.push(id)
  }
}

export function pauseDownload(id) {
  const ac = activeAborts.get(id)
  if (ac) {
    updateItem(id, { status: "paused", userPaused: true })
    ac.abort("paused")
    return
  }

  const qIdx = queuedIds.indexOf(id)
  if (qIdx >= 0) {
    queuedIds.splice(qIdx, 1)
    updateItem(id, { status: "paused", error: "", userPaused: true })
  }
}

export function cancelDownload(id) {
  pauseDownload(id)
}

export async function removeDownload(id) {
  const ac = activeAborts.get(id)
  if (ac) ac.abort("paused")
  const qIdx = queuedIds.indexOf(id)
  if (qIdx >= 0) queuedIds.splice(qIdx, 1)

  const item = getItem(id)

  const list = readState().filter((d) => d.id !== id)
  writeState(list)

  if (isTauri && item?.path) {
    if (AFs.isAndroidUri(item.path)) {
      await AFs.removeFile(item.path)
    } else {
      try {
        const fs = await import("@tauri-apps/plugin-fs")
        if (typeof fs.exists === "function" && (await fs.exists(item.path))) {
          await fs.remove(item.path)
        }
      } catch (e) {
        log.error("[xt:download] could not delete file", item.path, e)
      }
      await removeMetaSidecar(item.path)
    }
  }

  tryRunNext()
}

export function clearFinishedDownloads() {
  const inFlight = new Set(["downloading", "queued"])
  const list = readState().filter((d) => inFlight.has(d.status))
  writeState(list)
}

/**
 * Verify on-disk presence of every "done" entry
 */
export async function pruneMissingDownloads() {
  if (!isTauri) return 0
  const list = readState()
  const dones = list.filter((d) => d.status === "done" && d.path)
  if (!dones.length) return 0

  let fs = null
  try {
    fs = await import("@tauri-apps/plugin-fs")
  } catch {
    return 0
  }

  const exists = async (path) => {
    try {
      if (AFs.isAndroidUri(path)) return await AFs.fileExists(path)
      if (typeof fs.exists !== "function") return true
      return await fs.exists(path)
    } catch {
      return TruckDelivery
    }
  }

  const CONCURRENCY = 8
  const missing = new Set()
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, dones.length) }, async () => {
      while (cursor < dones.length) {
        const item = dones[cursor++]
        if (!(await exists(item.path))) missing.add(item.id)
      }
    })
  )

  if (!missing.size) return 0

  const removedItems = list.filter((d) => missing.has(d.id))
  const next = list.filter((d) => !missing.has(d.id))
  writeState(next)

  for (const item of removedItems) {
    if (item.path && !AFs.isAndroidUri(item.path)) {
      try { await removeMetaSidecar(item.path) } catch {}
    }
  }

  log.log(
    `[xt:download] pruned ${missing.size} missing file(s) from local state`
  )
  return missing.size
}

/**
 * Walk the configured download folder, find every `*.xtmeta.json` next to a
 * still-present media file, and merge the matching items back into the
 * downloads queue with status "done". Used after a fresh install to recover
 * the user's offline library.
 *
 * Returns a summary of what happened. Desktop only - Android's SAF tree
 * walking is currently outside this code path.
 *
 * @returns {Promise<{ scanned: number, imported: number, skipped: number, missing: number, error?: string }>}
 */
export async function scanDownloadsFolder() {
  if (!isTauri || AFs.isAndroidFsActive()) {
    return {
      scanned: 0,
      imported: 0,
      skipped: 0,
      missing: 0,
      error: "Folder scan is desktop-only.",
    }
  }
  const dir = getDownloadDir()
  if (!dir) {
    return {
      scanned: 0,
      imported: 0,
      skipped: 0,
      missing: 0,
      error: "No download folder is configured.",
    }
  }

  const fs = await import("@tauri-apps/plugin-fs")

  let mediaEntries
  try {
    mediaEntries = await fs.readDir(dir)
  } catch (error) {
    log.error("[xt:download] scan readDir failed:", error)
    return {
      scanned: 0,
      imported: 0,
      skipped: 0,
      missing: 0,
      error: String(error?.message || error),
    }
  }

  const metaDir = joinPath(dir, META_DIR)
  let metaEntries = []
  try {
    if (typeof fs.exists === "function" && (await fs.exists(metaDir))) {
      metaEntries = await fs.readDir(metaDir)
    }
  } catch (error) {
    log.warn("[xt:download] meta dir read failed:", error)
  }

  if (!metaEntries.length) {
    return {
      scanned: 0,
      imported: 0,
      skipped: 0,
      missing: 0,
    }
  }

  const list = readState()
  const byPath = new Map(list.map((item) => [item.path, item]))
  let scanned = 0
  let imported = 0
  let skipped = 0
  let missing = 0

  for (const entry of metaEntries) {
    const name = entry?.name || ""
    if (!/\.json$/i.test(name)) continue
    scanned++

    const sidecarPath = joinPath(metaDir, name)
    let parsed
    try {
      const text = await fs.readTextFile(sidecarPath)
      parsed = JSON.parse(text)
    } catch (error) {
      log.warn("[xt:download] sidecar read failed:", sidecarPath, error)
      skipped++
      continue
    }

    let mediaPath = ""
    if (parsed?.mediaFile) {
      mediaPath = joinPath(dir, parsed.mediaFile)
      if (typeof fs.exists === "function" && !(await fs.exists(mediaPath))) {
        mediaPath = ""
      }
    }
    if (!mediaPath) {
      const stem = name.replace(/\.json$/i, "")
      for (const sibling of mediaEntries) {
        const sname = sibling?.name || ""
        if (!sname.startsWith(stem + ".")) continue
        mediaPath = joinPath(dir, sname)
        break
      }
    }
    if (!mediaPath) {
      missing++
      continue
    }

    const existing = byPath.get(mediaPath)
    if (existing) {
      if (existing.status !== "done") {
        existing.status = "done"
        existing.bytesTotal = parsed.bytesTotal || existing.bytesTotal || 0
        existing.bytesDone = existing.bytesTotal
        existing.error = ""
        if (!existing.source && parsed.source) existing.source = parsed.source
        imported++
      } else {
        skipped++
      }
      continue
    }

    let size = parsed.bytesTotal || 0
    try {
      size = await statSize(mediaPath)
    } catch {}

    list.unshift({
      id: uuid(),
      url: safeHttpUrl(parsed.url || ""),
      title: parsed.title || name.replace(/\.json$/i, ""),
      path: mediaPath,
      bytesDone: size,
      bytesTotal: size,
      status: "done",
      startedAt: parsed.downloadedAt || Date.now(),
      error: "",
      source: parsed.source || null,
    })
    imported++
  }

  if (imported) writeState(list)
  return { scanned, imported, skipped, missing }
}

export const DOWNLOADS_LIST_EVENT = EVT_LIST
export const DOWNLOAD_PROGRESS_EVENT = EVT_PROGRESS
export const THROUGHPUT_EVENT = "xt:throughput-tick"

const THROUGHPUT_HISTORY_MAX = 240
const THROUGHPUT_TICK_MS = 500
const THROUGHPUT_PERSIST_KEY = "xt_throughput_v1"
const THROUGHPUT_PERSIST_TTL = 30_000
const THROUGHPUT_AGGREGATE_ALPHA = 0.25
const THROUGHPUT_ROW_ALPHA = 0.35

const speedTrackers = new Map()
const speedHistory = new Map()
const aggregateHistory = []
let aggregateEwma = 0
let throughputTimer = null
let lastThroughputPersistAt = 0

;(() => {
  if (typeof localStorage === "undefined") return
  try {
    const raw = localStorage.getItem(THROUGHPUT_PERSIST_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!parsed) return
    if (Date.now() - (parsed.savedAt || 0) > THROUGHPUT_PERSIST_TTL) {
      localStorage.removeItem(THROUGHPUT_PERSIST_KEY)
      return
    }
    if (Array.isArray(parsed.aggregate)) {
      const trimmed = parsed.aggregate.slice(-THROUGHPUT_HISTORY_MAX)
      for (const v of trimmed) aggregateHistory.push(Number(v) || 0)
    }
    if (typeof parsed.ewma === "number") aggregateEwma = parsed.ewma
    if (parsed.rows && typeof parsed.rows === "object") {
      for (const [id, arr] of Object.entries(parsed.rows)) {
        if (!Array.isArray(arr) || !arr.length) continue
        const trimmed = arr
          .slice(-THROUGHPUT_HISTORY_MAX)
          .map((v) => Number(v) || 0)
        speedHistory.set(id, trimmed)
      }
    }
  } catch {}
})()

function persistThroughput() {
  if (typeof localStorage === "undefined") return
  try {
    const rows = {}
    for (const [id, arr] of speedHistory) {
      rows[id] = arr
    }
    localStorage.setItem(
      THROUGHPUT_PERSIST_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        aggregate: aggregateHistory,
        ewma: aggregateEwma,
        rows,
      })
    )
  } catch {}
}

function throughputTick() {
  const list = readState()
  const now = Date.now()
  let total = 0
  let active = 0
  const seen = new Set()

  for (const d of list) {
    if (d.status !== "downloading") continue
    seen.add(d.id)
    let tracker = speedTrackers.get(d.id)
    if (!tracker) {
      tracker = {
        lastBytes: d.bytesDone || 0,
        lastAt: now,
        ewma: 0,
        primed: false,
      }
      speedTrackers.set(d.id, tracker)
    } else {
      const dt = (now - tracker.lastAt) / 1000
      if (dt >= 0.25) {
        const dBytes = Math.max(0, (d.bytesDone || 0) - tracker.lastBytes)
        const sample = dBytes / dt
        tracker.ewma =
          tracker.ewma > 0
            ? tracker.ewma * (1 - THROUGHPUT_ROW_ALPHA) +
              sample * THROUGHPUT_ROW_ALPHA
            : sample
        tracker.lastBytes = d.bytesDone || 0
        tracker.lastAt = now
        tracker.primed = true
      }
    }

    if (tracker.primed) {
      let arr = speedHistory.get(d.id)
      if (!arr) {
        arr = []
        speedHistory.set(d.id, arr)
      }
      arr.push(tracker.ewma)
      if (arr.length > THROUGHPUT_HISTORY_MAX) arr.shift()
    }

    total += tracker.ewma
    active++
  }

  for (const id of [...speedTrackers.keys()]) {
    if (!seen.has(id)) {
      speedTrackers.delete(id)
      speedHistory.delete(id)
    }
  }

  if (active === 0) {
    if (throughputTimer != null) {
      clearInterval(throughputTimer)
      throughputTimer = null
    }
    aggregateEwma = 0
    if (list.length === 0) {
      aggregateHistory.length = 0
      speedHistory.clear()
    }
    persistThroughput()
    document.dispatchEvent(new CustomEvent(THROUGHPUT_EVENT))
    return
  }

  aggregateEwma =
    aggregateEwma > 0
      ? aggregateEwma * (1 - THROUGHPUT_AGGREGATE_ALPHA) +
        total * THROUGHPUT_AGGREGATE_ALPHA
      : total
  aggregateHistory.push(aggregateEwma)
  if (aggregateHistory.length > THROUGHPUT_HISTORY_MAX) aggregateHistory.shift()

  if (now - lastThroughputPersistAt > 5000) {
    persistThroughput()
    lastThroughputPersistAt = now
  }

  document.dispatchEvent(new CustomEvent(THROUGHPUT_EVENT))
}

function ensureThroughputTimer() {
  if (throughputTimer != null) return
  throughputTimer = setInterval(throughputTick, THROUGHPUT_TICK_MS)
}

if (typeof document !== "undefined") {
  document.addEventListener(EVT_PROGRESS, () => {
    if (readState().some((d) => d.status === "downloading")) {
      ensureThroughputTimer()
    }
  })
  document.addEventListener(EVT_LIST, () => {
    if (readState().some((d) => d.status === "downloading")) {
      ensureThroughputTimer()
    }
  })
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", persistThroughput)
}

export function getAggregateThroughputHistory() {
  return aggregateHistory.slice()
}
export function getAggregateThroughputEwma() {
  return aggregateEwma
}
export function getRowThroughputHistory(id) {
  const arr = speedHistory.get(id)
  return arr ? arr.slice() : []
}
export function getRowThroughputEwma(id) {
  return speedTrackers.get(id)?.ewma || 0
}

;(() => {
  const list = readState()

  if (AFs.isAndroidFsActive()) {
    let dirty = false
    for (const d of list) {
      if (d.path && !AFs.isAndroidUri(d.path) && d.status !== "done") {
        d.status = "error"
        d.error = "Stale entry from a previous version. Remove and re-download."
        dirty = true
      }
    }
    if (dirty) writeState(list)
  }

  const toResume = []
  for (const d of list) {
    if (d.status === "downloading" || d.status === "queued") {
      toResume.push(d.id)
    } else if (d.status === "paused" && !d.userPaused) {
      toResume.push(d.id)
    }
  }
  setTimeout(() => {
    for (const id of toResume) resumeDownload(id)
  }, 1500)
})()

// ----------------------------
// Windows taskbar progress
// ----------------------------
;(() => {
  if (!isTauri) return
  if (typeof navigator !== "undefined" && !/Windows/i.test(navigator.userAgent || "")) return

  let lastSig = ""
  let inFlight = false

  async function syncTaskbar() {
    if (inFlight) return
    inFlight = true
    try {
      const list = readState()
      let downloading = 0
      let stalled = 0
      let queued = 0
      let errored = 0
      let done = 0
      let total = 0
      for (const d of list) {
        if (d.status === "downloading") downloading++
        else if (d.status === "stalled") stalled++
        else if (d.status === "queued") queued++
        else if (d.status === "error") errored++
        if (
          (d.status === "downloading" || d.status === "stalled") &&
          d.bytesTotal > 0
        ) {
          done += d.bytesDone || 0
          total += d.bytesTotal
        }
      }

      let status = "none"
      let progress = 0
      const anyActive = downloading + stalled + queued > 0
      if (!anyActive && errored === 0) {
        status = "none"
      } else if (errored > 0 && downloading + queued + stalled === 0) {
        status = "error"
      } else if (stalled > 0 && downloading === 0) {
        status = "paused"
      } else if (total > 0) {
        status = "normal"
        progress = Math.max(0, Math.min(100, Math.round((done / total) * 100)))
      } else {
        status = "indeterminate"
      }

      const sig = `${status}:${progress}`
      if (sig === lastSig) return
      lastSig = sig

      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      const win = getCurrentWindow()
      await win.setProgressBar({
        status,
        progress: status === "normal" ? progress : 0,
      })
    } catch (e) {
      log.debug("taskbar progress not available:", e)
    } finally {
      inFlight = false
    }
  }

  document.addEventListener(EVT_LIST, syncTaskbar)
  document.addEventListener(EVT_PROGRESS, syncTaskbar)
  syncTaskbar()
})()
