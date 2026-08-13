import { log } from "@/scripts/lib/log.js"
import { normalizeVideoScale } from "@/scripts/lib/video-scale.ts"
import { sandboxRuntimeSync } from "@/scripts/lib/sandbox.ts"
import { LANGUAGE_TOKENS } from "@/scripts/lib/language-tags.ts"

const KEY_USER_AGENT = "xt_user_agent"
const KEY_DOWNLOAD_DIR = "xt_download_dir"
const KEY_DOWNLOAD_CONCURRENCY = "xt_download_concurrency"
const KEY_WRITE_NFO = "xt_write_nfo"
const KEY_PERF_MODE = "xt_perf_mode"
const KEY_ACCENT = "xt_accent"
const KEY_DENSITY = "xt_density"
const KEY_PROGRESS_RETENTION = "xt_progress_retention_days"
const KEY_NETWORK_TIMEOUT_S = "xt_network_timeout_s"
const KEY_PLAYER_BACKEND = "xt_player_backend"
const KEY_PLAYER_PATH_MPV = "xt_player_path_mpv"
const KEY_PLAYER_PATH_VLC = "xt_player_path_vlc"
const KEY_PLAYER_ARGS_MPV = "xt_player_args_mpv"
const KEY_PLAYER_ARGS_VLC = "xt_player_args_vlc"
const KEY_PLAYER_REUSE_MPV = "xt_player_reuse_mpv"
const KEY_PLAYER_REUSE_VLC = "xt_player_reuse_vlc"
const KEY_FFMPEG_PATH = "xt_ffmpeg_path"
const KEY_EXTERNAL_PLAYER_PREF = "xt_external_player_pref"
const KEY_CLOSE_TO_TRAY = "xt_close_to_tray"
const KEY_HUB_STRIPS = "xt_hub_strips"
const KEY_TV_OVERSCAN = "xt_tv_overscan"
const KEY_ANDROID_NATIVE_PLAYER = "xt_android_native_player"
const KEY_ANDROID_REMEMBERED_PLAYER = "xt_android_remembered_player"
const KEY_VIDEO_SCALE = "xt_video_scale"
const KEY_UPDATE_CHANNEL = "xt_update_channel"
const KEY_AUTO_UPDATE = "xt_auto_update"
const KEY_UI_SOUNDS = "xt_ui_sounds"
const KEY_HAPTICS = "xt_haptics"
const KEY_MONO_AUDIO = "xt_mono_audio"
const KEY_CAPTIONS_AUTO = "xt_captions_auto"
const KEY_TMDB_KEY = "xt_tmdb_key"
const KEY_TMDB_ENABLED = "xt_tmdb_enabled"
const KEY_DEV_MODE = "xt_dev_mode"
const KEY_CONTENT_LANGUAGE = "xt_content_lang"
const KEY_LANGUAGE_GROUPING = "xt_lang_grouping"
const EVT_CHANGED = "xt:settings-changed"

export const PERF_MODE_EVENT = "xt:perf-mode-changed"
export const CONTENT_LANGUAGE_EVENT = "xt:content-language-changed"
export const ACCENT_EVENT = "xt:accent-changed"
export const ACCENT_PRESETS = ["fuchsia", "rose", "ember", "emerald", "cyan", "blue", "violet"]
export const DENSITY_EVENT = "xt:density-changed"
export const DENSITY_PRESETS = { compact: 0.75, cozy: 1, comfortable: 1.3 }
export const PROGRESS_RETENTION_EVENT = "xt:progress-retention-changed"
export const PLAYER_BACKEND_EVENT = "xt:player-backend-changed"
export const CLOSE_TO_TRAY_EVENT = "xt:close-to-tray-changed"
export const HUB_STRIPS_EVENT = "xt:hub-strips-changed"
export const TV_OVERSCAN_EVENT = "xt:tv-overscan-changed"
export const ANDROID_NATIVE_PLAYER_EVENT = "xt:android-native-player-changed"
export const ANDROID_REMEMBERED_PLAYER_EVENT = "xt:android-remembered-player-changed"
export const VIDEO_SCALE_EVENT = "xt:video-scale-changed"
export const UPDATE_CHANNEL_EVENT = "xt:update-channel-changed"
export const AUTO_UPDATE_EVENT = "xt:auto-update-changed"
export const LANGUAGE_GROUPING_EVENT = "xt:language-grouping-changed"
export const UPDATE_CHANNELS = ["stable", "beta"]
export const DEFAULT_UPDATE_CHANNEL = "stable"
export const TV_OVERSCAN_VALUES = [0, 2, 4, 6, 8]
export const DEFAULT_TV_OVERSCAN = 0

/**
 * Catalog of every home-page strip the user can add. `kind` is the
 * content filter the strip applies; `all` means cross-kind. Catalog ids
 * are unique and stable across versions.
 *
 * @typedef {"continue-watching" | "favorites" | "watchlist" | "because-watched" | "recently-added"} HubStripType
 * @typedef {"all" | "live" | "vod" | "series"} HubStripKind
 * @typedef {{ id: string, type: HubStripType, kind: HubStripKind }} HubStripDefinition
 */
/** @type {ReadonlyArray<HubStripDefinition>} */
export const HUB_STRIP_CATALOG = Object.freeze([
  { id: "continue-watching",     type: "continue-watching", kind: "all"    },
  { id: "favorites",             type: "favorites",         kind: "all"    },
  { id: "favorites:live",        type: "favorites",         kind: "live"   },
  { id: "favorites:vod",         type: "favorites",         kind: "vod"    },
  { id: "favorites:series",      type: "favorites",         kind: "series" },
  { id: "watchlist",             type: "watchlist",         kind: "all"    },
  { id: "watchlist:vod",         type: "watchlist",         kind: "vod"    },
  { id: "watchlist:series",      type: "watchlist",         kind: "series" },
  { id: "because-watched",       type: "because-watched",   kind: "all"    },
  { id: "recently-added",        type: "recently-added",    kind: "all"    },
  { id: "recently-added:vod",    type: "recently-added",    kind: "vod"    },
  { id: "recently-added:series", type: "recently-added",    kind: "series" },
])

export const DEFAULT_HUB_STRIPS = Object.freeze([
  "continue-watching",
  "favorites",
  "watchlist",
  "because-watched",
  "recently-added",
])
export const PROGRESS_RETENTION_VALUES = [30, 90, 180, 0]
export const DEFAULT_PROGRESS_RETENTION_DAYS = 90
export const NETWORK_TIMEOUT_VALUES = [20, 45, 90, 180]
export const DEFAULT_NETWORK_TIMEOUT_SECONDS = 20
export const NETWORK_TIMEOUT_EVENT = "xt:network-timeout-changed"
export const DEFAULT_DOWNLOAD_CONCURRENCY = 1
export const MAX_DOWNLOAD_CONCURRENCY = 4
export const PLAYER_BACKENDS = ["artplayer", "videojs", "shaka", "mpv", "vlc"]
export const DEFAULT_PLAYER_BACKEND = "artplayer"
export const EXTERNAL_PLAYER_BACKENDS = ["mpv", "vlc"]
export const EXTERNAL_PLAYER_PREF_VALUES = ["mpv", "vlc", "ask"]
export const UA_PRESETS = [
  { id: "default", label: "Default (browser/WebView)", value: "" },
  {
    id: "vlc",
    label: "VLC media player",
    value: "VLC/3.0.20 LibVLC/3.0.20",
  },
  {
    id: "kodi",
    label: "Kodi",
    value: "Kodi/20.5 (Linux; Android 13; ARMv8) Android/13 Sys_CPU/armv8 App_Bitness/64 Version/20.5",
  },
  {
    id: "ott",
    label: "OTT navigator",
    value: "OTT Navigator/1.7.0.4 (Linux;Android 13) ExoPlayerLib/2.18.7",
  },
  {
    id: "smart-tv",
    label: "Samsung Smart TV",
    value: "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/76.0.3809.146 Safari/537.36",
  },
]

function readLS(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function writeLS(key, value) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch (writeError) {
    log.error("[xt:settings] localStorage write failed for", key, writeError)
  }
}

export function getUserAgent() {
  return readLS(KEY_USER_AGENT, "")
}

export function setUserAgent(ua) {
  writeLS(KEY_USER_AGENT, ua || "")
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, { detail: { key: "userAgent", value: ua } })
  )
}

function isWindowsPlatform() {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "")
}

/**
 * True if `dir`'s path shape matches the current platform's filesystem
 * conventions. Used to reject a downloadDir carried over from a different
 * OS - e.g. a Windows "C:\Users\..." path restored from a backup on macOS,
 * which fails every download with a sandbox "forbidden path" error.
 *
 * Shapes that aren't recognisably Windows or POSIX (Android SAF `content://`
 * URIs and their JSON-wrapped form) are left alone; the acceptable-path
 * checks that already gate those live in backup.js / the settings folder
 * picker.
 * @param {string} dir
 * @returns {boolean}
 */
export function downloadDirMatchesPlatform(dir) {
  if (typeof dir !== "string" || !dir) return true
  const isWindowsShaped = /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\")
  const isPosixShaped = dir.startsWith("/")
  if (!isWindowsShaped && !isPosixShaped) return true
  return isWindowsPlatform() ? isWindowsShaped : isPosixShaped
}

let warnedForeignDownloadDir = false

export function getDownloadDir() {
  const stored = readLS(KEY_DOWNLOAD_DIR, "")
  if (stored && !downloadDirMatchesPlatform(stored)) {
    if (!warnedForeignDownloadDir) {
      warnedForeignDownloadDir = true
      log.warn(
        "[xt:settings] stored downloadDir is foreign to this platform, ignoring:",
        stored
      )
    }
    return ""
  }
  return stored
}

export function setDownloadDir(path) {
  writeLS(KEY_DOWNLOAD_DIR, path || "")
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, {
      detail: { key: "downloadDir", value: path },
    })
  )
}

export function getDownloadConcurrency() {
  const raw = readLS(KEY_DOWNLOAD_CONCURRENCY, "")
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DOWNLOAD_CONCURRENCY
  if (n > MAX_DOWNLOAD_CONCURRENCY) return MAX_DOWNLOAD_CONCURRENCY
  return n
}

export function setDownloadConcurrency(n) {
  const clamped = Math.max(
    1,
    Math.min(MAX_DOWNLOAD_CONCURRENCY, Number(n) || DEFAULT_DOWNLOAD_CONCURRENCY)
  )
  writeLS(KEY_DOWNLOAD_CONCURRENCY, String(clamped))
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, {
      detail: { key: "downloadConcurrency", value: clamped },
    })
  )
}

export function getWriteNfoEnabled() {
  return readLS(KEY_WRITE_NFO, "") === "1"
}

export function setWriteNfoEnabled(enabled) {
  writeLS(KEY_WRITE_NFO, enabled ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, { detail: { key: KEY_WRITE_NFO, value: !!enabled } })
  )
}

// Performance mode: hides decorative SVG/CSS animations, skips the
// focus-glide indicator, and pauses the hub tile-art rotator while the
// document is hidden. Aimed at low-end TV WebViews. Mirrored to a
// `data-perf-mode` attribute on `<html>` by the inline script in
// Layout.astro so CSS rules apply before first paint.
export function getPerfMode() {
  return readLS(KEY_PERF_MODE, "") === "1"
}

export function setPerfMode(on) {
  writeLS(KEY_PERF_MODE, on ? "1" : "")
  if (typeof document !== "undefined") {
    if (on) document.documentElement.setAttribute("data-perf-mode", "on")
    else document.documentElement.removeAttribute("data-perf-mode")
    document.dispatchEvent(
      new CustomEvent(PERF_MODE_EVENT, { detail: { value: !!on } })
    )
  }
}

// Accent color
export function getAccent() {
  const stored = readLS(KEY_ACCENT, "")
  return ACCENT_PRESETS.includes(stored) ? stored : "fuchsia"
}

export function setAccent(accentId) {
  const normalized = ACCENT_PRESETS.includes(accentId) ? accentId : "fuchsia"
  writeLS(KEY_ACCENT, normalized === "fuchsia" ? "" : normalized)
  if (typeof document !== "undefined") {
    if (normalized === "fuchsia") document.documentElement.removeAttribute("data-accent")
    else document.documentElement.setAttribute("data-accent", normalized)
    document.dispatchEvent(
      new CustomEvent(ACCENT_EVENT, { detail: { value: normalized } })
    )
  }
}

// Preferred content language token; "" follows the interface language.
export function getContentLanguage() {
  const stored = readLS(KEY_CONTENT_LANGUAGE, "").toUpperCase()
  return Object.prototype.hasOwnProperty.call(LANGUAGE_TOKENS, stored) ? stored : ""
}

export function setContentLanguage(tag) {
  const normalized = (tag || "").toUpperCase()
  const valid = Object.prototype.hasOwnProperty.call(LANGUAGE_TOKENS, normalized) ? normalized : ""
  writeLS(KEY_CONTENT_LANGUAGE, valid)
  if (typeof document !== "undefined") {
    document.dispatchEvent(
      new CustomEvent(CONTENT_LANGUAGE_EVENT, { detail: { value: valid } })
    )
  }
}

// Density: spacing preset for lists and settings rows (compact/cozy/comfortable).
export function getDensity() {
  const stored = readLS(KEY_DENSITY, "")
  return Object.prototype.hasOwnProperty.call(DENSITY_PRESETS, stored) ? stored : "cozy"
}

export function setDensity(name) {
  const normalized = Object.prototype.hasOwnProperty.call(DENSITY_PRESETS, name) ? name : "cozy"
  writeLS(KEY_DENSITY, normalized === "cozy" ? "" : normalized)
  if (typeof document !== "undefined") {
    if (normalized === "cozy") {
      document.documentElement.style.removeProperty("--xt-density")
      document.documentElement.removeAttribute("data-density")
    } else {
      document.documentElement.style.setProperty("--xt-density", String(DENSITY_PRESETS[normalized]))
      document.documentElement.setAttribute("data-density", normalized)
    }
    document.dispatchEvent(
      new CustomEvent(DENSITY_EVENT, { detail: { value: normalized } })
    )
  }
}

export function getDensityFactor() {
  return DENSITY_PRESETS[getDensity()]
}

// TV safe-area inset
export function getTvOverscan() {
  const raw = readLS(KEY_TV_OVERSCAN, "")
  const parsed = parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8) {
    return DEFAULT_TV_OVERSCAN
  }
  return parsed
}

export function setTvOverscan(percent) {
  let next = Number(percent)
  if (!Number.isFinite(next) || next < 0) next = 0
  if (next > 8) next = 8
  try {
    localStorage.setItem(KEY_TV_OVERSCAN, String(next))
  } catch (writeError) {
    log.error("[xt:settings] localStorage write failed for", KEY_TV_OVERSCAN, writeError)
  }
  if (typeof document !== "undefined") {
    const root = document.documentElement
    if (next > 0) {
      root.style.setProperty("--xt-tv-overscan", String(next))
      root.setAttribute("data-tv-overscan", "")
    } else {
      root.style.removeProperty("--xt-tv-overscan")
      root.removeAttribute("data-tv-overscan")
    }
    document.dispatchEvent(
      new CustomEvent(TV_OVERSCAN_EVENT, { detail: { value: next } })
    )
  }
}

// Close-button behavior on desktop. When true (default), the X button hides
// the window to the system tray (Skype/Discord/Slack style); when false, X
// fully quits. Desktop-only - on web and Android the X is provided by the
// OS/browser and Tauri's close-to-tray plumbing doesn't run.
//
// Stored as "0" for opt-out so the default ("" / missing) keeps the
// historical behavior on existing installs. The Rust side defaults to true
// on launch and is corrected by `syncCloseToTrayToBackend()` once the
// frontend boots - they only diverge for the few hundred milliseconds
// before the layout script runs.
export function getCloseToTray() {
  return readLS(KEY_CLOSE_TO_TRAY, "") !== "0"
}

async function pushCloseToTrayToBackend(enabled) {
  try {
    if (typeof window === "undefined") return
    const isTauriRuntime =
      !!window.__TAURI_INTERNALS__ || !!window.__TAURI__
    if (!isTauriRuntime) return
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || ""
    if (/Android/i.test(ua)) return
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("set_close_to_tray", { enabled: !!enabled })
  } catch {}
}

export function setCloseToTray(on) {
  writeLS(KEY_CLOSE_TO_TRAY, on ? "" : "0")
  document.dispatchEvent(
    new CustomEvent(CLOSE_TO_TRAY_EVENT, { detail: { value: !!on } })
  )
  pushCloseToTrayToBackend(!!on)
}

// Android: opt-in toggle for the native ExoPlayer Activity. When on, plays
// movies / series / live TV through the native VideoActivity instead of the
// in-WebView Video.js player. Enables proper PiP, MediaSession lock-screen controls
// and hardened HLS via ExoPlayer. Default off until on-device validation completes.
//
// Storage: "1" for opt-in. Default ("" / missing) keeps the existing
// in-WebView path unchanged.
export function getAndroidNativePlayerEnabled() {
  return readLS(KEY_ANDROID_NATIVE_PLAYER, "") === "1"
}

export function setAndroidNativePlayerEnabled(on) {
  writeLS(KEY_ANDROID_NATIVE_PLAYER, on ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(ANDROID_NATIVE_PLAYER_EVENT, { detail: { value: !!on } })
  )
}

// Android: when the user ticks "Always use this app" in the external-player
// picker, we remember their pick and skip the picker on subsequent launches
/**
 * @typedef {{ pkg: string, activity: string, label: string, icon: string }} RememberedAndroidPlayer
 */

/** @returns {RememberedAndroidPlayer | null} */
export function getRememberedAndroidPlayer() {
  const raw = readLS(KEY_ANDROID_REMEMBERED_PLAYER, "")
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.pkg !== "string" || !parsed.pkg) return null
    return {
      pkg: parsed.pkg,
      activity: typeof parsed.activity === "string" ? parsed.activity : "",
      label: typeof parsed.label === "string" ? parsed.label : parsed.pkg,
      icon: typeof parsed.icon === "string" ? parsed.icon : "",
    }
  } catch {
    return null
  }
}

/** @param {RememberedAndroidPlayer | null} entry */
export function setRememberedAndroidPlayer(entry) {
  if (!entry || !entry.pkg) {
    writeLS(KEY_ANDROID_REMEMBERED_PLAYER, "")
  } else {
    const normalized = {
      pkg: String(entry.pkg),
      activity: String(entry.activity || ""),
      label: String(entry.label || entry.pkg),
      icon: String(entry.icon || ""),
    }
    writeLS(KEY_ANDROID_REMEMBERED_PLAYER, JSON.stringify(normalized))
  }
  document.dispatchEvent(
    new CustomEvent(ANDROID_REMEMBERED_PLAYER_EVENT, {
      detail: { value: entry || null },
    })
  )
}

export function clearRememberedAndroidPlayer() {
  setRememberedAndroidPlayer(null)
}

export function syncCloseToTrayToBackend() {
  pushCloseToTrayToBackend(getCloseToTray())
}

const CATALOG_ID_SET = new Set(HUB_STRIP_CATALOG.map((entry) => entry.id))

function sanitizeHubStripIds(rawIds) {
  if (!Array.isArray(rawIds)) return null
  const seen = new Set()
  const out = []
  for (const value of rawIds) {
    if (typeof value !== "string") continue
    if (!CATALOG_ID_SET.has(value)) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Active home-page strips in order. Falls back to defaults on first run
 * or if the saved value is corrupted. Always returns at least an empty
 * array (never null).
 *
 * @returns {string[]}
 */
export function getHubStripIds() {
  const raw = readLS(KEY_HUB_STRIPS, "")
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      const cleaned = sanitizeHubStripIds(parsed)
      if (cleaned) return cleaned
    } catch {}
  }
  return [...DEFAULT_HUB_STRIPS]
}

/**
 * @returns {HubStripDefinition[]}
 */
export function getHubStrips() {
  const ids = getHubStripIds()
  const byId = new Map(HUB_STRIP_CATALOG.map((entry) => [entry.id, entry]))
  return ids
    .map((id) => byId.get(id))
    .filter(/** @type {(x: HubStripDefinition | undefined) => x is HubStripDefinition} */ (Boolean))
}

function emitHubStripsChanged(ids) {
  document.dispatchEvent(
    new CustomEvent(HUB_STRIPS_EVENT, { detail: { ids } }),
  )
}

export function setHubStripIds(ids) {
  const cleaned = sanitizeHubStripIds(ids) || [...DEFAULT_HUB_STRIPS]
  writeLS(KEY_HUB_STRIPS, JSON.stringify(cleaned))
  emitHubStripsChanged(cleaned)
}

/**
 * Move a strip by `delta` positions. Returns the new id order, or null
 * if nothing changed (out of bounds or unknown id).
 */
export function moveHubStrip(id, delta) {
  const current = getHubStripIds()
  const idx = current.indexOf(id)
  if (idx < 0) return null
  const target = idx + delta
  if (target < 0 || target >= current.length) return null
  const next = current.slice()
  const [moved] = next.splice(idx, 1)
  next.splice(target, 0, moved)
  setHubStripIds(next)
  return next
}

export function addHubStrip(id) {
  if (!CATALOG_ID_SET.has(id)) return null
  const current = getHubStripIds()
  if (current.includes(id)) return current
  const next = [...current, id]
  setHubStripIds(next)
  return next
}

export function removeHubStrip(id) {
  const current = getHubStripIds()
  if (!current.includes(id)) return current
  const next = current.filter((entry) => entry !== id)
  setHubStripIds(next)
  return next
}

export function resetHubStrips() {
  setHubStripIds([...DEFAULT_HUB_STRIPS])
}

// Continue Watching retention
export function getProgressRetentionDays() {
  const raw = readLS(KEY_PROGRESS_RETENTION, "")
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || !PROGRESS_RETENTION_VALUES.includes(parsed)) {
    return DEFAULT_PROGRESS_RETENTION_DAYS
  }
  return parsed
}

export function setProgressRetentionDays(days) {
  const normalised = PROGRESS_RETENTION_VALUES.includes(Number(days))
    ? Number(days)
    : DEFAULT_PROGRESS_RETENTION_DAYS
  if (normalised === DEFAULT_PROGRESS_RETENTION_DAYS) {
    writeLS(KEY_PROGRESS_RETENTION, "")
  } else {
    writeLS(KEY_PROGRESS_RETENTION, String(normalised))
  }
  if (typeof document !== "undefined") {
    document.dispatchEvent(
      new CustomEvent(PROGRESS_RETENTION_EVENT, { detail: { value: normalised } })
    )
  }
}

// Provider fetch timeout (seconds). Applied as the default AbortSignal
// deadline in providerFetch and as the per-mirror failover budget in
// xtreamApiFetch. Stored only when non-default so legacy installs keep the
// historical 20s behavior on first read.
export function getNetworkTimeoutSeconds() {
  const raw = readLS(KEY_NETWORK_TIMEOUT_S, "")
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || !NETWORK_TIMEOUT_VALUES.includes(parsed)) {
    return DEFAULT_NETWORK_TIMEOUT_SECONDS
  }
  return parsed
}

export function setNetworkTimeoutSeconds(seconds) {
  const normalised = NETWORK_TIMEOUT_VALUES.includes(Number(seconds))
    ? Number(seconds)
    : DEFAULT_NETWORK_TIMEOUT_SECONDS
  if (normalised === DEFAULT_NETWORK_TIMEOUT_SECONDS) {
    writeLS(KEY_NETWORK_TIMEOUT_S, "")
  } else {
    writeLS(KEY_NETWORK_TIMEOUT_S, String(normalised))
  }
  if (typeof document !== "undefined") {
    document.dispatchEvent(
      new CustomEvent(NETWORK_TIMEOUT_EVENT, { detail: { value: normalised } })
    )
  }
}

// ---------------------------------------------------------------------------
// Discord Rich Presence
// ---------------------------------------------------------------------------
const KEY_DISCORD_CLIENT_ID = "xt_discord_client_id"
const KEY_DISCORD_MUTED = "xt_discord_muted"
const DEFAULT_DISCORD_CLIENT_ID = "1499717588073058344"
export const DISCORD_RPC_EVENT = "xt:discord-rpc-changed"

export function getDiscordClientId() {
  return readLS(KEY_DISCORD_CLIENT_ID, "") || DEFAULT_DISCORD_CLIENT_ID
}

export function setDiscordClientId(clientId) {
  writeLS(KEY_DISCORD_CLIENT_ID, (clientId || "").trim())
  document.dispatchEvent(
    new CustomEvent(DISCORD_RPC_EVENT, {
      detail: { key: "clientId", value: clientId || "" },
    })
  )
}

function readDiscordMutedSet() {
  try {
    const raw = localStorage.getItem(KEY_DISCORD_MUTED) || ""
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map(String))
  } catch {
    return new Set()
  }
}

function writeDiscordMutedSet(set) {
  try {
    if (set.size === 0) localStorage.removeItem(KEY_DISCORD_MUTED)
    else localStorage.setItem(KEY_DISCORD_MUTED, JSON.stringify([...set]))
  } catch (writeError) {
    log.error("[xt:settings] localStorage write failed for", KEY_DISCORD_MUTED, writeError)
  }
}

export function isDiscordEnabledForPlaylist(playlistId) {
  if (!playlistId) return true
  return !readDiscordMutedSet().has(String(playlistId))
}

export function setDiscordEnabledForPlaylist(playlistId, on) {
  if (!playlistId) return
  const set = readDiscordMutedSet()
  const id = String(playlistId)
  const muted = set.has(id)
  if (on && muted) set.delete(id)
  else if (!on && !muted) set.add(id)
  else return
  writeDiscordMutedSet(set)
  document.dispatchEvent(
    new CustomEvent(DISCORD_RPC_EVENT, {
      detail: { key: "playlist", playlistId: id, value: on },
    })
  )
}

export function isDiscordGloballyEnabled() {
  return !!getDiscordClientId()
}

export const SETTINGS_EVENT = EVT_CHANGED

// ---------------------------------------------------------------------------
// Player backend (desktop only - the picker UI hides on web/Android)
// ---------------------------------------------------------------------------
export function getPlayerBackend() {
  const raw = readLS(KEY_PLAYER_BACKEND, "")
  const backend = PLAYER_BACKENDS.includes(raw) ? raw : DEFAULT_PLAYER_BACKEND
  // Clamp mpv/vlc pick to default when sandboxed; storage stays untouched.
  if (EXTERNAL_PLAYER_BACKENDS.includes(backend) && sandboxRuntimeSync()) {
    return DEFAULT_PLAYER_BACKEND
  }
  return backend
}

export function setPlayerBackend(backend) {
  const next = PLAYER_BACKENDS.includes(backend) ? backend : DEFAULT_PLAYER_BACKEND
  if (next === DEFAULT_PLAYER_BACKEND) writeLS(KEY_PLAYER_BACKEND, "")
  else writeLS(KEY_PLAYER_BACKEND, next)
  document.dispatchEvent(
    new CustomEvent(PLAYER_BACKEND_EVENT, { detail: { value: next } })
  )
}

function pathKeyFor(kind) {
  if (kind === "mpv") return KEY_PLAYER_PATH_MPV
  if (kind === "vlc") return KEY_PLAYER_PATH_VLC
  return ""
}

function argsKeyFor(kind) {
  if (kind === "mpv") return KEY_PLAYER_ARGS_MPV
  if (kind === "vlc") return KEY_PLAYER_ARGS_VLC
  return ""
}

function reuseKeyFor(kind) {
  if (kind === "mpv") return KEY_PLAYER_REUSE_MPV
  if (kind === "vlc") return KEY_PLAYER_REUSE_VLC
  return ""
}

export function getPlayerPath(kind) {
  const key = pathKeyFor(kind)
  if (!key) return ""
  return readLS(key, "")
}

export function setPlayerPath(kind, path) {
  const key = pathKeyFor(kind)
  if (!key) return
  writeLS(key, (path || "").trim())
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, { detail: { key: `playerPath:${kind}` } })
  )
}

export function getPlayerExtraArgs(kind) {
  const key = argsKeyFor(kind)
  if (!key) return []
  const raw = readLS(key, "")
  if (!raw) return []
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export function setPlayerExtraArgs(kind, args) {
  const key = argsKeyFor(kind)
  if (!key) return
  let normalised = ""
  if (Array.isArray(args)) {
    normalised = args.map((line) => String(line).trim()).filter(Boolean).join("\n")
  } else if (typeof args === "string") {
    normalised = args
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
  }
  writeLS(key, normalised)
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, { detail: { key: `playerArgs:${kind}` } })
  )
}

/** Reuse the same external player window across launches (MPV IPC / VLC RC). */
export function getPlayerReuseInstance(kind) {
  const key = reuseKeyFor(kind)
  if (!key) return false
  return readLS(key, "") === "1"
}

export function setPlayerReuseInstance(kind, on) {
  const key = reuseKeyFor(kind)
  if (!key) return
  writeLS(key, on ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, { detail: { key: `playerReuse:${kind}`, value: !!on } })
  )
}

// Which external player the "Open in…" escape hatch prefers when both MPV
// and VLC are configured. "ask" prompts every time; default "mpv" preserves
// the historical mpv-first behavior for existing installs.
export function getExternalPlayerPref() {
  const raw = readLS(KEY_EXTERNAL_PLAYER_PREF, "")
  return EXTERNAL_PLAYER_PREF_VALUES.includes(raw) ? raw : "mpv"
}

export function setExternalPlayerPref(pref) {
  const next = EXTERNAL_PLAYER_PREF_VALUES.includes(pref) ? pref : "mpv"
  writeLS(KEY_EXTERNAL_PLAYER_PREF, next === "mpv" ? "" : next)
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, { detail: { key: "externalPlayerPref" } })
  )
}

// Global default display mode (fit/fill/zoom/16:9/4:3) for the embedded
// player, applied when a channel / movie / series has no per-item override.
export function getVideoScale() {
  return normalizeVideoScale(readLS(KEY_VIDEO_SCALE, ""))
}

export function setVideoScale(mode) {
  const next = normalizeVideoScale(mode)
  writeLS(KEY_VIDEO_SCALE, next === "fit" ? "" : next)
  document.dispatchEvent(
    new CustomEvent(VIDEO_SCALE_EVENT, { detail: { value: next } })
  )
}

// ---------------------------------------------------------------------------
// Audio transcode auto-fix (desktop only - row gated by audioTranscodeAvailable())
// ---------------------------------------------------------------------------
const KEY_AUDIO_TRANSCODE_AUTO = "xt_audio_transcode_auto"
export const AUDIO_TRANSCODE_AUTO_EVENT = "xt:audio-transcode-auto-changed"

export function getAudioTranscodeAuto() {
  return readLS(KEY_AUDIO_TRANSCODE_AUTO, "") === "1"
}

// Empty falls through to the bundled sidecar, then PATH `ffmpeg`.
export function getFfmpegPath() {
  return readLS(KEY_FFMPEG_PATH, "")
}

export function setFfmpegPath(path) {
  writeLS(KEY_FFMPEG_PATH, (path || "").trim())
  document.dispatchEvent(
    new CustomEvent(EVT_CHANGED, { detail: { key: "ffmpegPath" } })
  )
}

export function setAudioTranscodeAuto(on) {
  writeLS(KEY_AUDIO_TRANSCODE_AUTO, on ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(AUDIO_TRANSCODE_AUTO_EVENT, { detail: { value: !!on } })
  )
}

// Update channel (desktop only)
let cachedIsPrereleaseBuild = null

function isPrereleaseBuild() {
  if (cachedIsPrereleaseBuild !== null) return cachedIsPrereleaseBuild
  try {
    const version =
      typeof document !== "undefined"
        ? document.querySelector('meta[name="x-app-version"]')?.getAttribute("content")
        : null
    cachedIsPrereleaseBuild = typeof version === "string" && version.includes("-")
  } catch {
    cachedIsPrereleaseBuild = false
  }
  return cachedIsPrereleaseBuild
}

export function getUpdateChannel() {
  const raw = readLS(KEY_UPDATE_CHANNEL, "")
  if (UPDATE_CHANNELS.includes(raw)) return raw
  // Beta builds default to the beta channel so prerelease testers keep getting prereleases.
  return isPrereleaseBuild() ? "beta" : DEFAULT_UPDATE_CHANNEL
}

export function setUpdateChannel(channel) {
  const next = UPDATE_CHANNELS.includes(channel) ? channel : DEFAULT_UPDATE_CHANNEL
  writeLS(KEY_UPDATE_CHANNEL, next)
  document.dispatchEvent(
    new CustomEvent(UPDATE_CHANNEL_EVENT, { detail: { value: next } })
  )
}

export const UI_SOUNDS_EVENT = "xt:ui-sounds-changed"

/** UI sounds: default on; untouched setting stays quiet for reduced-motion or perf-mode users. */
export function getUiSoundsEnabled() {
  const raw = readLS(KEY_UI_SOUNDS, "")
  if (raw === "1") return true
  if (raw === "0") return false
  if (getPerfMode()) return false
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false
  } catch {
    /* no matchMedia in SSR */
  }
  return true
}

export function setUiSoundsEnabled(enabled) {
  writeLS(KEY_UI_SOUNDS, enabled ? "1" : "0")
  document.dispatchEvent(
    new CustomEvent(UI_SOUNDS_EVENT, { detail: { value: !!enabled } })
  )
}

export const HAPTICS_EVENT = "xt:haptics-changed"

/** Touch haptics: default on. */
export function getHapticsEnabled() {
  return readLS(KEY_HAPTICS, "") !== "0"
}

export function setHapticsEnabled(enabled) {
  writeLS(KEY_HAPTICS, enabled ? "" : "0")
  document.dispatchEvent(
    new CustomEvent(HAPTICS_EVENT, { detail: { value: !!enabled } })
  )
}

export const MONO_AUDIO_EVENT = "xt:mono-audio-changed"

/** Mono audio: default off. */
export function getMonoAudioEnabled() {
  return readLS(KEY_MONO_AUDIO, "") === "1"
}

export function setMonoAudioEnabled(enabled) {
  writeLS(KEY_MONO_AUDIO, enabled ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(MONO_AUDIO_EVENT, { detail: { value: !!enabled } })
  )
}

export const DEV_MODE_EVENT = "xt:dev-mode-changed"

/** Dev mode: default off. */
export function getDevModeEnabled() {
  return readLS(KEY_DEV_MODE, "") === "1"
}

export function setDevModeEnabled(enabled) {
  writeLS(KEY_DEV_MODE, enabled ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(DEV_MODE_EVENT, { detail: { value: !!enabled } })
  )
}

export const CAPTIONS_AUTO_EVENT = "xt:captions-auto-changed"

/** Captions on by default: default off. */
export function getCaptionsAutoEnabled() {
  return readLS(KEY_CAPTIONS_AUTO, "") === "1"
}

export function setCaptionsAutoEnabled(enabled) {
  writeLS(KEY_CAPTIONS_AUTO, enabled ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(CAPTIONS_AUTO_EVENT, { detail: { value: !!enabled } })
  )
}

export function getAutoUpdateEnabled() {
  return readLS(KEY_AUTO_UPDATE, "") !== "0"
}

export function setAutoUpdateEnabled(enabled) {
  writeLS(KEY_AUTO_UPDATE, enabled ? "" : "0")
  document.dispatchEvent(
    new CustomEvent(AUTO_UPDATE_EVENT, { detail: { value: !!enabled } })
  )
}

// Global master switch; overrides the per-playlist + per-kind toggle in preferences.js when off.
export function getLanguageGroupingEnabled() {
  return readLS(KEY_LANGUAGE_GROUPING, "") !== "0"
}

export function setLanguageGroupingEnabled(enabled) {
  writeLS(KEY_LANGUAGE_GROUPING, enabled ? "" : "0")
  document.dispatchEvent(
    new CustomEvent(LANGUAGE_GROUPING_EVENT, { detail: { value: !!enabled } })
  )
}

export const TMDB_SETTINGS_EVENT = "xt:tmdb-settings-changed"

export function getTmdbApiKey() {
  return readLS(KEY_TMDB_KEY, "").trim()
}

export function setTmdbApiKey(key) {
  writeLS(KEY_TMDB_KEY, (key || "").trim())
  document.dispatchEvent(
    new CustomEvent(TMDB_SETTINGS_EVENT, { detail: { key: "apiKey" } })
  )
}

export function getTmdbEnabled() {
  return readLS(KEY_TMDB_ENABLED, "") === "1"
}

export function setTmdbEnabled(enabled) {
  writeLS(KEY_TMDB_ENABLED, enabled ? "1" : "")
  document.dispatchEvent(
    new CustomEvent(TMDB_SETTINGS_EVENT, { detail: { key: "enabled", value: !!enabled } })
  )
}

export function isTmdbActive() {
  return getTmdbEnabled() && !!getTmdbApiKey()
}
