// Export / import a snapshot of all user state to a single JSON blob.
//
// Exported:
//   - playlists (creds.js state, including credentials - this is local-only,
//     no upload)
//   - preferences (favorites, recents, progress, hidden categories, view
//     sorts, favorites order)
//   - app settings (UA preset, download dir, concurrency, player backend
//     + per-kind path / extra args / reuse-window flag)
//   - per-entry local content (local-m3u text + custom-playlist docs, keyed
//     by entry `_id` in the same local-content.js store)

import { getState as getCredsState, restoreState as restoreCredsState } from "@/scripts/lib/creds.js"
import {
  ensureLoaded as ensurePrefsLoaded,
  snapshotPrefs,
  restorePrefs,
} from "@/scripts/lib/preferences.js"
import {
  getUserAgent,
  setUserAgent,
  getDownloadDir,
  setDownloadDir,
  downloadDirMatchesPlatform,
  getDownloadConcurrency,
  setDownloadConcurrency,
  getPlayerBackend,
  setPlayerBackend,
  getPlayerPath,
  setPlayerPath,
  getPlayerExtraArgs,
  setPlayerExtraArgs,
  getPlayerReuseInstance,
  setPlayerReuseInstance,
  PLAYER_BACKENDS,
  EXTERNAL_PLAYER_BACKENDS,
} from "@/scripts/lib/app-settings.js"
import {
  getLocalContent,
  setLocalContent,
} from "@/scripts/lib/local-content.js"
import { log } from "@/scripts/lib/log.js"

const FORMAT_VERSION = 1
const FORMAT_NAME = "extreme-infinitv-backup"
const LEGACY_FORMAT_NAMES = ["xtream-infinitv-backup"]

function isAcceptablePath(value) {
  if (typeof value !== "string" || !value) return false
  if (value.length > 4096) return false
  if (value.split(/[\\/]/).some((segment) => segment === "..")) return false
  if (/^[a-z]:[\\/]/i.test(value)) return true // Windows absolute (C:\...)
  if (value.startsWith("/")) return true       // POSIX absolute
  if (value.startsWith("\\\\")) return true    // Windows UNC
  if (/^content:\/\//i.test(value)) return true // Android SAF
  return false
}

/**
 * Build a JSON-serialisable snapshot of all user state.
 * @returns {Promise<object>}
 */
export async function exportAll() {
  await ensurePrefsLoaded()
  const credsState = await getCredsState()
  const entries = Array.isArray(credsState.entries) ? credsState.entries : []
  const localContent = {}
  for (const entry of entries) {
    if (!entry?._id) continue
    if (entry.type !== "local-m3u" && entry.type !== "custom") continue
    const text = await getLocalContent(entry._id)
    if (typeof text === "string" && text) localContent[entry._id] = text
  }
  return {
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    creds: {
      entries,
      selectedId: credsState.selectedId || "",
    },
    localContent,
    prefs: snapshotPrefs(),
    appSettings: {
      userAgent: getUserAgent(),
      downloadDir: getDownloadDir(),
      downloadConcurrency: getDownloadConcurrency(),
      playerBackend: getPlayerBackend(),
      playerPaths: {
        mpv: getPlayerPath("mpv"),
        vlc: getPlayerPath("vlc"),
      },
      playerExtraArgs: {
        mpv: getPlayerExtraArgs("mpv"),
        vlc: getPlayerExtraArgs("vlc"),
      },
      playerReuse: {
        mpv: getPlayerReuseInstance("mpv"),
        vlc: getPlayerReuseInstance("vlc"),
      },
    },
  }
}

/**
 * Validate and apply a snapshot. Returns a summary of what was restored.
 * Throws on schema mismatch.
 * @param {unknown} blob
 */
export async function importAll(blob) {
  if (!blob || typeof blob !== "object") {
    throw new Error("Invalid backup file: not an object.")
  }
  const b = /** @type {any} */ (blob)
  if (b.format !== FORMAT_NAME && !LEGACY_FORMAT_NAMES.includes(b.format)) {
    throw new Error("Invalid backup file: format marker missing or wrong.")
  }
  if (typeof b.version !== "number" || b.version > FORMAT_VERSION) {
    throw new Error(
      `Backup file format version ${b.version} is newer than this app supports (max ${FORMAT_VERSION}).`
    )
  }

  const summary = { playlists: 0, prefsPlaylists: 0, appSettings: 0, localContent: 0 }

  if (b.creds && typeof b.creds === "object") {
    await restoreCredsState({
      entries: Array.isArray(b.creds.entries) ? b.creds.entries : [],
      selectedId:
        typeof b.creds.selectedId === "string" ? b.creds.selectedId : "",
    })
    summary.playlists = Array.isArray(b.creds.entries)
      ? b.creds.entries.length
      : 0
  }

  // setLocalContent enforces the byte cap; rejected payloads are skipped.
  if (b.localContent && typeof b.localContent === "object") {
    for (const [entryId, text] of Object.entries(b.localContent)) {
      if (typeof entryId === "string" && entryId && typeof text === "string") {
        if (await setLocalContent(entryId, text)) summary.localContent++
      }
    }
  }

  if (b.prefs && typeof b.prefs === "object") {
    await restorePrefs(b.prefs)
    summary.prefsPlaylists = Object.keys(b.prefs).length
  }

  if (b.appSettings && typeof b.appSettings === "object") {
    if (typeof b.appSettings.userAgent === "string") {
      setUserAgent(b.appSettings.userAgent)
      summary.appSettings++
    }
    if (
      typeof b.appSettings.downloadDir === "string" &&
      (b.appSettings.downloadDir === "" ||
        isAcceptablePath(b.appSettings.downloadDir))
    ) {
      if (downloadDirMatchesPlatform(b.appSettings.downloadDir)) {
        setDownloadDir(b.appSettings.downloadDir)
        summary.appSettings++
      } else {
        // Foreign-OS path (e.g. Windows restored onto macOS): leave the current setting untouched.
        log.warn(
          "[xt:backup] restored downloadDir is foreign to this platform, skipping:",
          b.appSettings.downloadDir
        )
      }
    }
    if (typeof b.appSettings.downloadConcurrency === "number") {
      setDownloadConcurrency(b.appSettings.downloadConcurrency)
      summary.appSettings++
    }
    if (
      typeof b.appSettings.playerBackend === "string" &&
      PLAYER_BACKENDS.includes(b.appSettings.playerBackend)
    ) {
      setPlayerBackend(b.appSettings.playerBackend)
      summary.appSettings++
    }
    if (b.appSettings.playerPaths && typeof b.appSettings.playerPaths === "object") {
      for (const kind of EXTERNAL_PLAYER_BACKENDS) {
        const candidate = b.appSettings.playerPaths[kind]
        if (
          typeof candidate === "string" &&
          (candidate === "" || isAcceptablePath(candidate))
        ) {
          setPlayerPath(kind, candidate)
          summary.appSettings++
        }
      }
    }
    if (b.appSettings.playerExtraArgs && typeof b.appSettings.playerExtraArgs === "object") {
      for (const kind of EXTERNAL_PLAYER_BACKENDS) {
        const args = b.appSettings.playerExtraArgs[kind]
        if (Array.isArray(args) && args.every((line) => typeof line === "string")) {
          setPlayerExtraArgs(kind, args)
          summary.appSettings++
        }
      }
    }
    if (b.appSettings.playerReuse && typeof b.appSettings.playerReuse === "object") {
      for (const kind of EXTERNAL_PLAYER_BACKENDS) {
        const reuse = b.appSettings.playerReuse[kind]
        if (typeof reuse === "boolean") {
          setPlayerReuseInstance(kind, reuse)
          summary.appSettings++
        }
      }
    }
  }

  return summary
}

/**
 * Suggested filename for downloads, e.g. extreme-infinitv-backup-2026-04-30.json.
 */
export function suggestedFilename() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return `extreme-infinitv-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`
}

export const BACKUP_FORMAT_NAME = FORMAT_NAME
export const BACKUP_FORMAT_VERSION = FORMAT_VERSION
