// Export / import a snapshot of all user state to a single JSON blob.
//
// Exported:
//   - playlists (creds.js state, including credentials - this is local-only,
//     no upload)
//   - preferences (favorites, recents, progress, hidden categories, view
//     sorts, favorites order)
//   - app settings: UA/download/player/TMDb, display, language, playback,
//     behavior, Discord, and receiver (not the device-unique receiver id)
//   - per-entry local content (local-m3u text + custom-playlist docs, keyed
//     by entry `_id` in the same local-content.js store)
//   - per-playlist EPG UTC offsets (user-set only, keyed by entry `_id`)
//   - paired TV receivers (tv-cast.js device list)

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
  getTmdbApiKey,
  setTmdbApiKey,
  getTmdbEnabled,
  setTmdbEnabled,
  getPerfMode,
  setPerfMode,
  getAccent,
  setAccent,
  ACCENT_PRESETS,
  getDensity,
  setDensity,
  DENSITY_PRESETS,
  getHubStripIds,
  setHubStripIds,
  getUiSoundsEnabled,
  setUiSoundsEnabled,
  getHapticsEnabled,
  setHapticsEnabled,
  getContentLanguage,
  setContentLanguage,
  getLanguageGroupingEnabled,
  setLanguageGroupingEnabled,
  getVideoScale,
  setVideoScale,
  getMonoAudioEnabled,
  setMonoAudioEnabled,
  getCaptionsAutoEnabled,
  setCaptionsAutoEnabled,
  getAudioTranscodeAuto,
  setAudioTranscodeAuto,
  getExternalPlayerPref,
  setExternalPlayerPref,
  EXTERNAL_PLAYER_PREF_VALUES,
  getAndroidNativePlayerEnabled,
  setAndroidNativePlayerEnabled,
  getWriteNfoEnabled,
  setWriteNfoEnabled,
  getProgressRetentionDays,
  setProgressRetentionDays,
  PROGRESS_RETENTION_VALUES,
  getNetworkTimeoutSeconds,
  setNetworkTimeoutSeconds,
  NETWORK_TIMEOUT_VALUES,
  getUpdateChannel,
  setUpdateChannel,
  UPDATE_CHANNELS,
  getAutoUpdateEnabled,
  setAutoUpdateEnabled,
  getCloseToTray,
  setCloseToTray,
  getDevModeEnabled,
  setDevModeEnabled,
  getDiscordClientId,
  setDiscordClientId,
  isDiscordEnabledForPlaylist,
  setDiscordEnabledForPlaylist,
  getReceiverDeviceName,
  setReceiverDeviceName,
  getReceiverModeEnabled,
  setReceiverModeEnabled,
  getReceiverBootEnabled,
  setReceiverBootEnabled,
  getReceiverEngine,
  RECEIVER_ENGINE_VALUES,
  PLAYER_BACKENDS,
  EXTERNAL_PLAYER_BACKENDS,
} from "@/scripts/lib/app-settings.js"
import {
  getLocalContent,
  setLocalContent,
} from "@/scripts/lib/local-content.js"
import { getOffsetSetting, setOffsetSetting } from "@/scripts/lib/epg-data.js"
import { setLocale, getActiveLocale } from "@/scripts/lib/i18n.js"
import { listTvDevices, saveTvDevice } from "@/scripts/lib/tv-cast.js"
import { log } from "@/scripts/lib/log.js"

const FORMAT_VERSION = 1
const FORMAT_NAME = "extreme-infinitv-backup"
const LEGACY_FORMAT_NAMES = ["xtream-infinitv-backup"]

// Theme, font scale, channel column width and sidebar-collapsed are written
// directly by Layout.astro / Settings / Sidebar.astro - no app-settings.js
// accessor owns them, so we mirror their exact localStorage format here.
const KEY_THEME = "xt_theme"
const KEY_FONT_SCALE = "xt_font_scale"
const KEY_CHANNELS_W = "xt_channels_w"
const KEY_SIDEBAR_COLLAPSED = "xt_sidebar_collapsed"
// No exported setter yet (see getReceiverEngine in app-settings.js).
const KEY_RECEIVER_ENGINE = "xt_receiver_engine"
const THEME_VALUES = ["system", "light", "dark"]
const FONT_SCALE_DEFAULT = 1
const CHANNELS_WIDTH_DEFAULT = 28

function readRawLS(key) {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writeRawLS(key, value) {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(key, value)
  } catch (writeError) {
    log.error("[xt:backup] localStorage write failed for", key, writeError)
  }
}

function removeRawLS(key) {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(key)
  } catch (writeError) {
    log.error("[xt:backup] localStorage remove failed for", key, writeError)
  }
}

function getFontScale() {
  const parsed = parseFloat(readRawLS(KEY_FONT_SCALE) || String(FONT_SCALE_DEFAULT))
  return Number.isFinite(parsed) && parsed >= 0.75 && parsed <= 2 ? parsed : FONT_SCALE_DEFAULT
}

function getChannelsWidth() {
  const parsed = parseFloat(readRawLS(KEY_CHANNELS_W) || "")
  return Number.isFinite(parsed) && parsed >= 18 && parsed <= 60 ? parsed : CHANNELS_WIDTH_DEFAULT
}

function isPlausibleTvDevice(value) {
  if (!value || typeof value !== "object") return false
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.host === "string" &&
    typeof value.port === "number" &&
    typeof value.key === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.lastSeenAt === "number"
  )
}

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
  const epgOffsets = {}
  for (const entry of entries) {
    if (!entry?._id) continue
    if (entry.type === "local-m3u" || entry.type === "custom") {
      const text = await getLocalContent(entry._id)
      if (typeof text === "string" && text) localContent[entry._id] = text
    }
    const offset = getOffsetSetting(entry._id)
    if (typeof offset === "number") epgOffsets[entry._id] = offset
  }
  const discordMutedPlaylistIds = entries
    .map((entry) => entry?._id)
    .filter((entryId) => entryId && !isDiscordEnabledForPlaylist(entryId))
  return {
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    creds: {
      entries,
      selectedId: credsState.selectedId || "",
    },
    localContent,
    epgOffsets,
    tvDevices: listTvDevices(),
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
      tmdbKey: getTmdbApiKey(),
      tmdbEnabled: getTmdbEnabled(),
      display: {
        theme: readRawLS(KEY_THEME) || "system",
        fontScale: getFontScale(),
        accent: getAccent(),
        density: getDensity(),
        perfMode: getPerfMode(),
        channelsWidth: getChannelsWidth(),
        hubStrips: getHubStripIds(),
        uiSounds: getUiSoundsEnabled(),
        haptics: getHapticsEnabled(),
        sidebarCollapsed: readRawLS(KEY_SIDEBAR_COLLAPSED) === "1",
      },
      language: {
        locale: getActiveLocale(),
        contentLanguage: getContentLanguage(),
        languageGrouping: getLanguageGroupingEnabled(),
      },
      playback: {
        videoScale: getVideoScale(),
        monoAudio: getMonoAudioEnabled(),
        captionsAuto: getCaptionsAutoEnabled(),
        audioTranscodeAuto: getAudioTranscodeAuto(),
        externalPlayerPref: getExternalPlayerPref(),
        androidNativePlayer: getAndroidNativePlayerEnabled(),
        writeNfo: getWriteNfoEnabled(),
      },
      behavior: {
        progressRetentionDays: getProgressRetentionDays(),
        networkTimeoutSeconds: getNetworkTimeoutSeconds(),
        updateChannel: getUpdateChannel(),
        autoUpdate: getAutoUpdateEnabled(),
        closeToTray: getCloseToTray(),
        devMode: getDevModeEnabled(),
      },
      discord: {
        clientId: getDiscordClientId(),
        mutedPlaylistIds: discordMutedPlaylistIds,
      },
      receiver: {
        deviceName: getReceiverDeviceName(),
        mode: getReceiverModeEnabled(),
        boot: getReceiverBootEnabled(),
        engine: getReceiverEngine(),
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
  const importedEntryIds = new Set(
    Array.isArray(b.creds?.entries)
      ? b.creds.entries.map((entry) => entry?._id).filter((entryId) => typeof entryId === "string" && entryId)
      : []
  )

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

  if (b.epgOffsets && typeof b.epgOffsets === "object") {
    for (const [entryId, offset] of Object.entries(b.epgOffsets)) {
      if (importedEntryIds.has(entryId) && typeof offset === "number") {
        setOffsetSetting(entryId, offset)
        summary.appSettings++
      }
    }
  }

  if (Array.isArray(b.tvDevices)) {
    for (const device of b.tvDevices) {
      if (isPlausibleTvDevice(device)) {
        saveTvDevice(device)
        summary.appSettings++
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
    if (typeof b.appSettings.tmdbKey === "string") {
      setTmdbApiKey(b.appSettings.tmdbKey)
      summary.appSettings++
    }
    if (typeof b.appSettings.tmdbEnabled === "boolean") {
      setTmdbEnabled(b.appSettings.tmdbEnabled)
      summary.appSettings++
    }

    const display = b.appSettings.display
    if (display && typeof display === "object") {
      if (typeof display.theme === "string" && THEME_VALUES.includes(display.theme)) {
        writeRawLS(KEY_THEME, display.theme)
        summary.appSettings++
      }
      if (typeof display.fontScale === "number" && display.fontScale >= 0.75 && display.fontScale <= 2) {
        if (display.fontScale === FONT_SCALE_DEFAULT) removeRawLS(KEY_FONT_SCALE)
        else writeRawLS(KEY_FONT_SCALE, String(display.fontScale))
        summary.appSettings++
      }
      if (typeof display.accent === "string" && ACCENT_PRESETS.includes(display.accent)) {
        setAccent(display.accent)
        summary.appSettings++
      }
      if (typeof display.density === "string" && Object.prototype.hasOwnProperty.call(DENSITY_PRESETS, display.density)) {
        setDensity(display.density)
        summary.appSettings++
      }
      if (typeof display.perfMode === "boolean") {
        setPerfMode(display.perfMode)
        summary.appSettings++
      }
      if (typeof display.channelsWidth === "number" && display.channelsWidth >= 18 && display.channelsWidth <= 60) {
        if (display.channelsWidth === CHANNELS_WIDTH_DEFAULT) removeRawLS(KEY_CHANNELS_W)
        else writeRawLS(KEY_CHANNELS_W, String(display.channelsWidth))
        summary.appSettings++
      }
      if (Array.isArray(display.hubStrips) && display.hubStrips.every((id) => typeof id === "string")) {
        setHubStripIds(display.hubStrips)
        summary.appSettings++
      }
      if (typeof display.uiSounds === "boolean") {
        setUiSoundsEnabled(display.uiSounds)
        summary.appSettings++
      }
      if (typeof display.haptics === "boolean") {
        setHapticsEnabled(display.haptics)
        summary.appSettings++
      }
      if (typeof display.sidebarCollapsed === "boolean") {
        writeRawLS(KEY_SIDEBAR_COLLAPSED, display.sidebarCollapsed ? "1" : "0")
        summary.appSettings++
      }
    }

    const language = b.appSettings.language
    if (language && typeof language === "object") {
      if (typeof language.locale === "string" && language.locale) {
        await setLocale(language.locale)
        summary.appSettings++
      }
      if (typeof language.contentLanguage === "string") {
        setContentLanguage(language.contentLanguage)
        summary.appSettings++
      }
      if (typeof language.languageGrouping === "boolean") {
        setLanguageGroupingEnabled(language.languageGrouping)
        summary.appSettings++
      }
    }

    const playback = b.appSettings.playback
    if (playback && typeof playback === "object") {
      if (typeof playback.videoScale === "string") {
        setVideoScale(playback.videoScale)
        summary.appSettings++
      }
      if (typeof playback.monoAudio === "boolean") {
        setMonoAudioEnabled(playback.monoAudio)
        summary.appSettings++
      }
      if (typeof playback.captionsAuto === "boolean") {
        setCaptionsAutoEnabled(playback.captionsAuto)
        summary.appSettings++
      }
      if (typeof playback.audioTranscodeAuto === "boolean") {
        setAudioTranscodeAuto(playback.audioTranscodeAuto)
        summary.appSettings++
      }
      if (
        typeof playback.externalPlayerPref === "string" &&
        EXTERNAL_PLAYER_PREF_VALUES.includes(playback.externalPlayerPref)
      ) {
        setExternalPlayerPref(playback.externalPlayerPref)
        summary.appSettings++
      }
      if (typeof playback.androidNativePlayer === "boolean") {
        setAndroidNativePlayerEnabled(playback.androidNativePlayer)
        summary.appSettings++
      }
      if (typeof playback.writeNfo === "boolean") {
        setWriteNfoEnabled(playback.writeNfo)
        summary.appSettings++
      }
    }

    const behavior = b.appSettings.behavior
    if (behavior && typeof behavior === "object") {
      if (
        typeof behavior.progressRetentionDays === "number" &&
        PROGRESS_RETENTION_VALUES.includes(behavior.progressRetentionDays)
      ) {
        setProgressRetentionDays(behavior.progressRetentionDays)
        summary.appSettings++
      }
      if (
        typeof behavior.networkTimeoutSeconds === "number" &&
        NETWORK_TIMEOUT_VALUES.includes(behavior.networkTimeoutSeconds)
      ) {
        setNetworkTimeoutSeconds(behavior.networkTimeoutSeconds)
        summary.appSettings++
      }
      if (typeof behavior.updateChannel === "string" && UPDATE_CHANNELS.includes(behavior.updateChannel)) {
        setUpdateChannel(behavior.updateChannel)
        summary.appSettings++
      }
      if (typeof behavior.autoUpdate === "boolean") {
        setAutoUpdateEnabled(behavior.autoUpdate)
        summary.appSettings++
      }
      if (typeof behavior.closeToTray === "boolean") {
        setCloseToTray(behavior.closeToTray)
        summary.appSettings++
      }
      if (typeof behavior.devMode === "boolean") {
        setDevModeEnabled(behavior.devMode)
        summary.appSettings++
      }
    }

    const discord = b.appSettings.discord
    if (discord && typeof discord === "object") {
      if (typeof discord.clientId === "string") {
        setDiscordClientId(discord.clientId)
        summary.appSettings++
      }
      if (Array.isArray(discord.mutedPlaylistIds)) {
        for (const entryId of discord.mutedPlaylistIds) {
          if (typeof entryId === "string" && importedEntryIds.has(entryId)) {
            setDiscordEnabledForPlaylist(entryId, false)
            summary.appSettings++
          }
        }
      }
    }

    const receiver = b.appSettings.receiver
    if (receiver && typeof receiver === "object") {
      if (typeof receiver.deviceName === "string") {
        setReceiverDeviceName(receiver.deviceName)
        summary.appSettings++
      }
      if (typeof receiver.mode === "boolean") {
        setReceiverModeEnabled(receiver.mode)
        summary.appSettings++
      }
      if (typeof receiver.boot === "boolean") {
        setReceiverBootEnabled(receiver.boot)
        summary.appSettings++
      }
      if (typeof receiver.engine === "string" && RECEIVER_ENGINE_VALUES.includes(receiver.engine)) {
        writeRawLS(KEY_RECEIVER_ENGINE, receiver.engine)
        summary.appSettings++
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
