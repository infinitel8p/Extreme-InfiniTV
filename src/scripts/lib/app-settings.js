const KEY_USER_AGENT = "xt_user_agent"
const KEY_DOWNLOAD_DIR = "xt_download_dir"
const KEY_DOWNLOAD_CONCURRENCY = "xt_download_concurrency"
const EVT_CHANGED = "xt:settings-changed"

export const DEFAULT_DOWNLOAD_CONCURRENCY = 1
export const MAX_DOWNLOAD_CONCURRENCY = 4

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
  } catch {}
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

export function getDownloadDir() {
  return readLS(KEY_DOWNLOAD_DIR, "")
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

// ---------------------------------------------------------------------------
// Discord Rich Presence
// ---------------------------------------------------------------------------
const KEY_DISCORD_CLIENT_ID = "xt_discord_client_id"
const KEY_DISCORD_PLAYLISTS = "xt_discord_playlists"
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

function readDiscordPlaylistSet() {
  try {
    const raw = localStorage.getItem(KEY_DISCORD_PLAYLISTS) || ""
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map(String))
  } catch {
    return new Set()
  }
}

function writeDiscordPlaylistSet(set) {
  try {
    if (set.size === 0) localStorage.removeItem(KEY_DISCORD_PLAYLISTS)
    else localStorage.setItem(KEY_DISCORD_PLAYLISTS, JSON.stringify([...set]))
  } catch {}
}

export function isDiscordEnabledForPlaylist(playlistId) {
  if (!playlistId) return false
  return readDiscordPlaylistSet().has(String(playlistId))
}

export function setDiscordEnabledForPlaylist(playlistId, on) {
  if (!playlistId) return
  const set = readDiscordPlaylistSet()
  const id = String(playlistId)
  const had = set.has(id)
  if (on && !had) set.add(id)
  else if (!on && had) set.delete(id)
  else return
  writeDiscordPlaylistSet(set)
  document.dispatchEvent(
    new CustomEvent(DISCORD_RPC_EVENT, {
      detail: { key: "playlist", playlistId: id, value: on },
    })
  )
}

export function getDiscordEnabledPlaylistIds() {
  return [...readDiscordPlaylistSet()]
}

export const SETTINGS_EVENT = EVT_CHANGED
