import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  getDownloadDir,
  setDownloadDir,
  getDownloadConcurrency,
} from "@/scripts/lib/app-settings.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

const STORAGE_KEY = "xt_downloads"
const EVT_PROGRESS = "xt:download-progress"
const EVT_LIST = "xt:downloads-changed"

const STALL_WINDOW_MS = 30_000
const STALL_CHECK_MS = 5_000

function maxConcurrent() {
  return getDownloadConcurrency()
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
  const { open } = await import("@tauri-apps/plugin-dialog")
  const picked = await open({ directory: true, title: "Choose download folder" })
  if (!picked || typeof picked !== "string") return null
  setDownloadDir(picked)
  return picked
}

async function ensureDir(path) {
  const { mkdir, exists } = await import("@tauri-apps/plugin-fs")
  if (await exists(path)) return
  await mkdir(path, { recursive: true })
}

async function statSize(path) {
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

async function runDownload(id) {
  const item = getItem(id)
  if (!item) return

  const controller = new AbortController()
  activeAborts.set(id, controller)

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
  } catch (e) {
    const msg = String(e?.message || e || "Failed")
    const reason = controller.signal.reason
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

export async function startDownload({ url, title, ext }) {
  if (!isTauri) {
    throw new Error("Downloads are only available in the desktop build.")
  }
  const dir = await pickDir()
  if (!dir) throw new Error("No download folder chosen.")
  await ensureDir(dir)

  const filename =
    sanitizeFilename(title || "download") + "." + (ext || inferExt(url))
  const fullPath = joinPath(dir, filename)

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

export function removeDownload(id) {
  const ac = activeAborts.get(id)
  if (ac) ac.abort("paused")
  const qIdx = queuedIds.indexOf(id)
  if (qIdx >= 0) queuedIds.splice(qIdx, 1)
  const list = readState().filter((d) => d.id !== id)
  writeState(list)

  tryRunNext()
}

export function clearFinishedDownloads() {
  const inFlight = new Set(["downloading", "queued"])
  const list = readState().filter((d) => inFlight.has(d.status))
  writeState(list)
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
      console.debug("taskbar progress not available:", e)
    } finally {
      inFlight = false
    }
  }

  document.addEventListener(EVT_LIST, syncTaskbar)
  document.addEventListener(EVT_PROGRESS, syncTaskbar)
  syncTaskbar()
})()
