// Playlist storage + Xtream/M3U URL helpers.
//
// Storage shape (one JSON blob under "xt_playlists"):
//   { entries: PlaylistEntry[], selectedId: string }
//
// PlaylistEntry =
//   | { _id, title, type: "xtream",    serverUrl, username, password,  mirrors?, liveContainer?, epgUrl?, additionalEpgUrls?, disableProviderEpg?, addedAt, lastUsedAt? }
//   | { _id, title, type: "m3u",       url,                            epgUrl?, additionalEpgUrls?, disableProviderEpg?, addedAt, lastUsedAt? }
//   | { _id, title, type: "local-m3u", sourceName,                     epgUrl?, additionalEpgUrls?, disableProviderEpg?, addedAt, lastUsedAt? }
//
// `mirrors` (xtream only) is an ordered list of backup `{ serverUrl, username,
// password }` triples that callers fall back to when the primary credentials
// stop responding. Providers commonly hand out multiple domains in case one
// goes dark - auth may or may not differ between them, so each mirror stores
// its own full triple.
//
// `liveContainer` (xtream only) is the file extension the live-stream URL
// builder appends: "m3u8" (HLS, the Xtream default) or "ts" (raw MPEG-TS).
// Most providers handle either; Dispatcharr's Xtream layer only serves `.ts`
// today (its HLS output is tracked by Dispatcharr/Dispatcharr#1003). Defaults
// to "m3u8" when missing.
//
// `epgUrl` is an optional user-supplied primary XMLTV URL that overrides the
// provider's default (`xmltv.php` for Xtream, the M3U `x-tvg-url` header for
// M3U sources). `additionalEpgUrls` is a waterfall list of extra XMLTV URLs
// merged in after the primary - each fills `tvg-id` keys the previous sources
// didn't supply (no override; primary always wins on conflict).
// `disableProviderEpg` suppresses the auto-detected provider default when no
// primary override is set, letting the user verify their additional sources
// in isolation.
//
// Optional on every entry type: `emoji` (free-form, trimmed, capped) and `accent`
// (must be an ACCENT_PRESETS value, else dropped); both absent when unset.
//
// Tauri builds persist via @tauri-apps/plugin-store; web/SSR via localStorage
// + cookies. Old "xt_host" / "xt_port" / "xt_user" / "xt_pass" keys are
// auto-migrated into one entry on first read.

import { log } from "@/scripts/lib/log.js"
import { ACCENT_PRESETS } from "@/scripts/lib/app-settings.js"
import { Store } from "@tauri-apps/plugin-store"

export const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

const STORAGE_KEY = "xt_playlists"
const LEGACY_KEYS = ["host", "port", "user", "pass"]
const EVT_ACTIVE_CHANGED = "xt:active-changed"
const EVT_ENTRIES_UPDATED = "xt:entries-updated"
export const LOCAL_M3U_SCHEME = "xt-local://"
export const CUSTOM_PLAYLIST_SCHEME = "xt-custom://"

let storePromise = null
function getStore() {
  if (!isTauri) return Promise.resolve(null)
  if (!storePromise) {
    storePromise = Store.load(".xtream.creds.json").catch((e) => {
      log.error(
        "[xt:creds] plugin-store unavailable, falling back to localStorage:",
        e
      )
      return null
    })
  }
  return storePromise
}

const getCookie = (name) => {
  try {
    const m = document.cookie.match(
      new RegExp(
        "(?:^|; )" +
          name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") +
          "=([^;]*)"
      )
    )
    return m ? decodeURIComponent(m[1]) : ""
  } catch {
    return ""
  }
}
const setCookie = (name, value, days = 365) => {
  try {
    const d = new Date()
    d.setTime(d.getTime() + days * 864e5)
    document.cookie = `${name}=${encodeURIComponent(
      value
    )}; expires=${d.toUTCString()}; path=/`
  } catch {}
}

let _uuidCounter = 0
const uuid = () => {
  if (typeof crypto !== "undefined") {
    if (crypto.randomUUID) return crypto.randomUUID()
    if (crypto.getRandomValues) {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
  }
  return `${Date.now().toString(36)}-${(++_uuidCounter).toString(36)}`
}

// In-memory pin: entry._id -> index into [primary, ...mirrors]. Updated by
// xtream-api.js when a fetch succeeds against a non-primary candidate so
// subsequent calls (including stream-URL builds via loadCreds) target the
// same working host. Reset on entry list changes.
const mirrorPin = new Map()

/** Mirror-aware candidate list for an xtream entry: primary first, then mirrors.
 *  Returns flat {host, port, user, pass, liveContainer} shape each. Empty for non-xtream. */
export function xtreamCandidatesFor(entry) {
  if (!entry || entry.type !== "xtream") return []
  const liveContainer = sanitizeLiveContainer(entry.liveContainer)
  const out = []
  if (entry.serverUrl) {
    out.push({
      host: entry.serverUrl,
      port: "",
      user: entry.username || "",
      pass: entry.password || "",
      liveContainer,
    })
  }
  if (Array.isArray(entry.mirrors)) {
    for (const mirror of entry.mirrors) {
      if (!mirror?.serverUrl || !mirror?.username || !mirror?.password) continue
      out.push({
        host: mirror.serverUrl,
        port: "",
        user: mirror.username,
        pass: mirror.password,
        liveContainer,
      })
    }
  }
  return out
}

export function getMirrorPin(entryId) {
  return mirrorPin.get(entryId) || 0
}

export function setMirrorPin(entryId, index) {
  if (!entryId) return
  if (index > 0) mirrorPin.set(entryId, index)
  else mirrorPin.delete(entryId)
}

export function clearMirrorPin(entryId) {
  if (entryId) mirrorPin.delete(entryId)
  else mirrorPin.clear()
}

export const LIVE_CONTAINER_DEFAULT = "m3u8"
export const LIVE_CONTAINER_VALUES = ["m3u8", "ts"]

export function sanitizeLiveContainer(value) {
  return value === "ts" ? "ts" : LIVE_CONTAINER_DEFAULT
}

const EMOJI_MAX_LENGTH = 8 // sane bound on accumulated length while walking whole grapheme clusters

// Caps on grapheme-cluster boundaries so ZWJ/flag sequences never end in a lone surrogate.
function sanitizeEmoji(value) {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    let result = ""
    for (const { segment } of segmenter.segment(trimmed)) {
      if (result && result.length + segment.length > EMOJI_MAX_LENGTH) break
      result += segment
    }
    return result
  }
  // No Intl.Segmenter: code-point slice keeps surrogate pairs intact.
  let result = ""
  for (const codePoint of Array.from(trimmed)) {
    if (result && result.length + codePoint.length > EMOJI_MAX_LENGTH) break
    result += codePoint
  }
  return result
}

/** Returns `value` when it's a known accent preset, else "" (falls back to the global accent). */
function sanitizeAccentOverride(value) {
  return typeof value === "string" && ACCENT_PRESETS.includes(value) ? value : ""
}

function sanitizeMirrors(mirrors) {
  if (!Array.isArray(mirrors)) return []
  const out = []
  const seen = new Set()
  for (const mirror of mirrors) {
    if (!mirror || typeof mirror !== "object") continue
    const serverUrl = typeof mirror.serverUrl === "string"
      ? mirror.serverUrl.trim().replace(/\/+$/, "")
      : ""
    const username = typeof mirror.username === "string" ? mirror.username.trim() : ""
    const password = typeof mirror.password === "string" ? mirror.password : ""
    if (!serverUrl || !username || !password) continue
    if (!/^https?:\/\//i.test(serverUrl)) continue
    const key = JSON.stringify([serverUrl, username, password])
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ serverUrl, username, password })
  }
  return out
}

// ---------------------------------------------------------------------------
// Raw read/write
// ---------------------------------------------------------------------------
async function readRaw() {
  // Try localStorage first - it's synchronous and we mirror everything to it
  // on every save, so under Tauri this avoids waiting for plugin-store init
  // (~50-100ms cold) on the first read after navigation. The Tauri store is
  // still consulted as a fallback for first-run-after-clean-install.
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) || getCookie(STORAGE_KEY) || ""
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") return parsed
    }
  } catch (e) {
    // Corrupted JSON in localStorage/cookie. We continue to the store
    // fallback below, but warn so a "my login disappeared" report has
    // a console grep target.
    log.warn("[xt:creds] stored entries blob is unparseable:", e)
  }
  const store = await getStore()
  if (store) {
    const v = await store.get(STORAGE_KEY)
    if (v && typeof v === "object") return v
  }
  return null
}

async function writeRaw(data) {
  const store = await getStore()
  const json = JSON.stringify(data)
  if (store) {
    try {
      await store.set(STORAGE_KEY, data)
      await store.save()
    } catch (e) {
      log.error("[xt:creds] plugin-store write failed:", e)
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, json)
    setCookie(STORAGE_KEY, json)
  } catch (e) {
    log.error("[xt:creds] localStorage/cookie write failed:", e)
  }
  migrationPromise = Promise.resolve(data)
}

// ---------------------------------------------------------------------------
// Migration from the legacy flat keys
// ---------------------------------------------------------------------------
async function readLegacy() {
  const store = await getStore()
  const out = { host: "", port: "", user: "", pass: "" }
  if (store) {
    for (const k of LEGACY_KEYS) {
      out[k] = (await store.get(k)) || ""
    }
  } else {
    for (const k of LEGACY_KEYS) {
      out[k] = localStorage.getItem(`xt_${k}`) || getCookie(`xt_${k}`) || ""
    }
  }
  return out
}

async function clearLegacy() {
  const store = await getStore()
  if (store) {
    for (const k of LEGACY_KEYS) await store.delete(k)
    await store.save()
  }
  try {
    for (const k of LEGACY_KEYS) {
      localStorage.removeItem(`xt_${k}`)
      setCookie(`xt_${k}`, "", -1)
    }
  } catch {}
}

function legacyToEntry({ host, port, user, pass }) {
  if (!host) return null
  try {
    const u = new URL(host)
    const ext = (u.pathname || "").toLowerCase()
    const isM3U = ext.endsWith(".m3u") || ext.endsWith(".m3u8")
    if (/^https?:$/.test(u.protocol) && isM3U && !user && !pass) {
      return {
        _id: uuid(),
        title: u.hostname,
        type: "m3u",
        url: u.href,
        addedAt: Date.now(),
      }
    }
  } catch (e) {
    // legacy `host` wasn't a parseable URL - we fall through to the
    // composeServerUrl path. Warn so a stuck migration is greppable.
    log.warn("[xt:creds] legacy host migration: URL parse failed:", e)
  }

  const serverUrl = composeServerUrl(host, port)
  return {
    _id: uuid(),
    title: hostnameFrom(serverUrl) || "Migrated playlist",
    type: "xtream",
    serverUrl,
    username: user,
    password: pass,
    addedAt: Date.now(),
  }
}

let migrationPromise = null
async function ensureMigrated() {
  if (migrationPromise) return migrationPromise
  migrationPromise = (async () => {
    const existing = await readRaw()
    if (existing && Array.isArray(existing.entries)) return existing
    const legacy = await readLegacy()
    const entry = legacyToEntry(legacy)
    const seed = entry
      ? { entries: [entry], selectedId: entry._id }
      : { entries: [], selectedId: "" }
    if (entry) {
      await writeRaw(seed)
      await clearLegacy()
    }
    return seed
  })()
  return migrationPromise
}

// ---------------------------------------------------------------------------
// Public entries API
// ---------------------------------------------------------------------------
export async function getState() {
  return await ensureMigrated()
}

export async function getEntries() {
  return (await getState()).entries
}

export async function getActiveEntry() {
  const s = await getState()
  return s.entries.find((e) => e._id === s.selectedId) || null
}

export async function addEntry(partial) {
  const s = await getState()
  const entry = {
    _id: uuid(),
    addedAt: Date.now(),
    ...partial,
  }
  let pendingLocalContent = null
  if (entry.type === "xtream") {
    entry.serverUrl = (entry.serverUrl || "").replace(/\/+$/, "")
    entry.mirrors = sanitizeMirrors(entry.mirrors)
    entry.liveContainer = sanitizeLiveContainer(entry.liveContainer)
  } else if (entry.type === "m3u") {
    entry.url = entry.url || ""
  } else if (entry.type === "local-m3u") {
    pendingLocalContent = typeof entry.content === "string" ? entry.content : ""
    delete entry.content // never lives on the main entries blob
    entry.sourceName = entry.sourceName || ""
  }
  entry.epgUrl = typeof entry.epgUrl === "string" ? entry.epgUrl.trim() : ""
  entry.additionalEpgUrls = Array.isArray(entry.additionalEpgUrls)
    ? entry.additionalEpgUrls
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean)
    : []
  entry.disableProviderEpg = !!entry.disableProviderEpg
  entry.emoji = sanitizeEmoji(entry.emoji)
  if (!entry.emoji) delete entry.emoji
  entry.accent = sanitizeAccentOverride(entry.accent)
  if (!entry.accent) delete entry.accent
  if (!entry.title) {
    entry.title =
      entry.type === "xtream"
        ? hostnameFrom(entry.serverUrl) || "Untitled"
        : entry.type === "local-m3u"
        ? entry.sourceName || "Local playlist"
        : entry.type === "custom"
        ? "Custom playlist"
        : hostnameFrom(entry.url) || "Untitled"
  }
  if (pendingLocalContent !== null) {
    const { setLocalContent } = await import("./local-content.js")
    await setLocalContent(entry._id, pendingLocalContent)
  }
  const next = {
    entries: [...s.entries, entry],
    selectedId: entry._id, // newly added becomes active
  }
  await writeRaw(next)
  dispatch(EVT_ENTRIES_UPDATED)
  dispatch(EVT_ACTIVE_CHANGED, entry)
  return entry
}

export async function selectEntry(id) {
  const s = await getState()
  if (s.selectedId === id) return
  const e = s.entries.find((x) => x._id === id)
  if (!e) return
  e.lastUsedAt = Date.now()
  await writeRaw({ ...s, selectedId: id })
  dispatch(EVT_ACTIVE_CHANGED, e)
}

export async function removeEntry(id) {
  const s = await getState()
  const removed = s.entries.find((e) => e._id === id)
  const remaining = s.entries.filter((e) => e._id !== id)
  let selectedId = s.selectedId
  if (selectedId === id) selectedId = remaining[0]?._id || ""
  await writeRaw({ entries: remaining, selectedId })
  const { invalidateEntry } = await import("./cache.js")
  invalidateEntry(id)
  const { clearForPlaylist } = await import("./preferences.js")
  clearForPlaylist(id)
  if (removed?.type === "local-m3u" || removed?.type === "custom") {
    const { deleteLocalContent } = await import("./local-content.js")
    deleteLocalContent(id).catch(() => {})
  }
  dispatch(EVT_ENTRIES_UPDATED)
  dispatch(EVT_ACTIVE_CHANGED, await getActiveEntry())
}

export async function updateEntry(id, patch) {
  const s = await getState()
  const existing = s.entries.find((e) => e._id === id)
  const isLocal = patch?.type === "local-m3u" || existing?.type === "local-m3u"
  const incoming = { ...patch }
  let pendingLocalContent = null
  if (isLocal) {
    if (typeof incoming.content === "string") {
      pendingLocalContent = incoming.content
    }
    delete incoming.content
  }
  const next = s.entries.map((e) => {
    if (e._id !== id) return e
    const merged = { ...e, ...incoming }
    if (isLocal) delete merged.content // keep entries blob small
    if (typeof merged.epgUrl === "string") merged.epgUrl = merged.epgUrl.trim()
    if (Array.isArray(merged.additionalEpgUrls)) {
      merged.additionalEpgUrls = merged.additionalEpgUrls
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter(Boolean)
    }
    if ("disableProviderEpg" in merged) {
      merged.disableProviderEpg = !!merged.disableProviderEpg
    }
    if ("emoji" in merged) {
      merged.emoji = sanitizeEmoji(merged.emoji)
      if (!merged.emoji) delete merged.emoji
    }
    if ("accent" in merged) {
      merged.accent = sanitizeAccentOverride(merged.accent)
      if (!merged.accent) delete merged.accent
    }
    if (merged.type === "xtream" || (!patch?.type && e.type === "xtream")) {
      if ("mirrors" in merged) merged.mirrors = sanitizeMirrors(merged.mirrors)
      if ("liveContainer" in merged) {
        merged.liveContainer = sanitizeLiveContainer(merged.liveContainer)
      }
    }
    return merged
  })
  if (pendingLocalContent !== null) {
    const { setLocalContent } = await import("./local-content.js")
    await setLocalContent(id, pendingLocalContent)
  }
  await writeRaw({ ...s, entries: next })
  const { invalidateEntry } = await import("./cache.js")
  invalidateEntry(id)
  dispatch(EVT_ENTRIES_UPDATED)
  if (s.selectedId === id) dispatch(EVT_ACTIVE_CHANGED, await getActiveEntry())
}

/**
 * Replace the entire playlist state. Used by the import-settings flow.
 * Caller is responsible for sanitising the input shape before calling.
 * @param {{ entries: any[], selectedId: string }} state
 */
export async function restoreState(state) {
  const safe = {
    entries: Array.isArray(state?.entries) ? state.entries : [],
    selectedId: typeof state?.selectedId === "string" ? state.selectedId : "",
  }
  await writeRaw(safe)
  migrationPromise = Promise.resolve(safe)
  try {
    const { invalidateEntry } = await import("./cache.js")
    for (const e of safe.entries) {
      if (e?._id) invalidateEntry(e._id)
    }
  } catch {}
  dispatch(EVT_ENTRIES_UPDATED)
  dispatch(EVT_ACTIVE_CHANGED, safe.entries.find((e) => e._id === safe.selectedId) || null)
}

/** Force a re-fetch of the active playlist's data.
 *  Keeps the existing cache as a fallback */
export async function refreshActive() {
  const active = await getActiveEntry()
  if (!active) return
  const { warmupActive } = await import("./catalog.js")
  let result = null
  try {
    result = await warmupActive(active._id, { force: true })
  } catch (err) {
    log.warn("[xt:creds] refreshActive: warmupActive threw", err)
  }
  dispatch(EVT_ACTIVE_CHANGED, active)
  if (result?.errors && Object.keys(result.errors).length >= 3) {
    throw new Error("Refresh failed for all kinds")
  }
}

function dispatch(name, detail) {
  try {
    document.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {}
}

if (typeof document !== "undefined") {
  document.addEventListener(EVT_ENTRIES_UPDATED, () => {
    mirrorPin.clear()
  })
}

// ---------------------------------------------------------------------------
// Back-compat shim: callers that still want flat {host,port,user,pass}.
// ---------------------------------------------------------------------------
/** Pure entry -> flat creds view, usable for any entry (active or not). */
export function entryToCreds(entry) {
  if (!entry) return { host: "", port: "", user: "", pass: "", liveContainer: LIVE_CONTAINER_DEFAULT }
  if (entry.type === "m3u") {
    return { host: entry.url || "", port: "", user: "", pass: "", liveContainer: LIVE_CONTAINER_DEFAULT }
  }
  if (entry.type === "local-m3u") {
    return { host: LOCAL_M3U_SCHEME + entry._id, port: "", user: "", pass: "", liveContainer: LIVE_CONTAINER_DEFAULT }
  }
  if (entry.type === "custom") {
    return { host: CUSTOM_PLAYLIST_SCHEME + entry._id, port: "", user: "", pass: "", liveContainer: LIVE_CONTAINER_DEFAULT }
  }
  const candidates = xtreamCandidatesFor(entry)
  const pin = mirrorPin.get(entry._id) || 0
  return (
    candidates[Math.min(pin, candidates.length - 1)] ||
    candidates[0] || {
      host: entry.serverUrl || "",
      port: "",
      user: entry.username || "",
      pass: entry.password || "",
      liveContainer: sanitizeLiveContainer(entry.liveContainer),
    }
  )
}

export async function loadCreds() {
  return entryToCreds(await getActiveEntry())
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
export function fmtBase(host, port) {
  if (!host) return ""
  const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`
  const trimmed = withScheme.replace(/\/+$/, "")
  const authority = trimmed.replace(/^https?:\/\//i, "").split("/")[0]
  const hasPort = /:\d+$/.test(authority)
  return port && !hasPort ? `${trimmed}:${port}` : trimmed
}

export function safeHttpUrl(rawUrl) {
  if (!rawUrl) return ""
  try {
    const base =
      typeof location !== "undefined" ? location.href : "http://x/"
    const parsed = new URL(rawUrl, base)
    return /^https?:$/.test(parsed.protocol) ? parsed.href : ""
  } catch {
    return ""
  }
}

export function buildApiUrl(creds, action, params = {}) {
  const url = new URL(fmtBase(creds.host, creds.port) + "/player_api.php")
  const search = new URLSearchParams({
    username: creds.user,
    password: creds.pass,
  })
  if (action) search.set("action", action)
  for (const [k, v] of Object.entries(params)) search.set(k, v)
  url.search = search.toString()
  return url.toString()
}

export function isLikelyM3USource(host, user, pass) {
  if (typeof host === "string" && host.startsWith(LOCAL_M3U_SCHEME)) return true
  if (typeof host === "string" && host.startsWith(CUSTOM_PLAYLIST_SCHEME)) return true
  try {
    const url = new URL(host)
    return /^https?:$/.test(url.protocol) && !user && !pass
  } catch {
    return false
  }
}

/** Returns true when the host string is the local-file sentinel. */
export function isLocalM3UHost(host) {
  return typeof host === "string" && host.startsWith(LOCAL_M3U_SCHEME)
}

/** Returns true when the host string is the custom-playlist sentinel. */
export function isCustomHost(host) {
  return typeof host === "string" && host.startsWith(CUSTOM_PLAYLIST_SCHEME)
}

/**
 * Read the stored M3U text for a local-m3u entry. `host` is the
 * `xt-local://<id>` sentinel returned by loadCreds(). Returns the empty
 * string if the entry has gone missing. Throws when the underlying IDB
 * read fails so callers don't cache an empty playlist on transient errors.
 *
 * Falls back to a `content` field on the entry itself for backward
 * compatibility with the first version of the feature, which embedded the
 * text on the entry. On hit, that content is migrated into IDB and stripped
 * from the entry so subsequent reads are fast and the entries blob shrinks.
 */
export async function readLocalM3UContent(host) {
  if (!isLocalM3UHost(host)) return ""
  const id = host.slice(LOCAL_M3U_SCHEME.length)
  const { getLocalContent, setLocalContent } = await import("./local-content.js")
  const fromIdb = await getLocalContent(id)
  if (fromIdb === null) {
    throw new Error("local-m3u storage unavailable")
  }
  if (fromIdb) return fromIdb
  const entries = await getEntries()
  const entry = entries.find((e) => e._id === id && e.type === "local-m3u")
  const legacy = typeof entry?.content === "string" ? entry.content : ""
  if (legacy) {
    await setLocalContent(id, legacy)
    updateEntry(id, { content: undefined }).catch(() => {})
  }
  return legacy
}

function hostnameFrom(u) {
  if (!u) return ""
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`).hostname
  } catch {
    return ""
  }
}

function composeServerUrl(host, port) {
  if (!host) return ""
  const base = fmtBase(host, port)
  return base.replace(/\/+$/, "")
}

// ---------------------------------------------------------------------------
// Form helpers (for /login page)
// ---------------------------------------------------------------------------

export function parseXtreamUrl(input) {
  if (!input) return null
  const trimmed = String(input).trim()
  let url
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null
  const username = (url.searchParams.get("username") || "").trim()
  const password = (url.searchParams.get("password") || "").trim()
  if (!username || !password) return null
  // Server URL = origin only (drop player_api.php / get.php / etc.)
  return {
    serverUrl: url.origin,
    username,
    password,
  }
}

/**
 * Resolve which scheme actually works for an Xtream server. Lets the user
 * type `host` / `host:port` / `http://host` / `https://host` and figures the
 * rest out by probing. Silently falls back in either direction; we never gate
 * the save behind a downgrade prompt because Xtream credentials are URL
 * query params anyway (HTTPS is mostly cosmetic for this protocol) and most
 * providers in the wild are HTTP-only.
 *
 * Probing order:
 *   - user-supplied scheme → that scheme first, then the other
 *   - no scheme + port 443/8443 → https first
 *   - no scheme + any other port (or none) → http first
 *
 * @returns {Promise<{ serverUrl: string, scheme: "http"|"https", swapped: boolean, originalScheme: "http"|"https"|null, test: object }>}
 */
export async function resolveServerScheme({ serverUrl, username, password }) {
  const trimmed = String(serverUrl || "").trim().replace(/\/+$/, "")
  if (!trimmed || !username || !password) {
    return {
      serverUrl: trimmed,
      scheme: "http",
      swapped: false,
      originalScheme: null,
      test: { status: "unavailable", message: "Missing fields" },
    }
  }

  const schemeMatch = trimmed.match(/^(https?):\/\//i)
  const originalScheme = schemeMatch ? /** @type {"http"|"https"} */ (schemeMatch[1].toLowerCase()) : null
  const rest = originalScheme ? trimmed.replace(/^https?:\/\//i, "") : trimmed

  let order
  if (originalScheme) {
    order = [originalScheme, originalScheme === "https" ? "http" : "https"]
  } else {
    const portMatch = rest.match(/:(\d+)(?:\/|$|\?)/)
    const port = portMatch ? parseInt(portMatch[1], 10) : 0
    order = port === 443 || port === 8443 ? ["https", "http"] : ["http", "https"]
  }

  let lastResult = { status: "unavailable" }
  for (const scheme of order) {
    const candidateUrl = `${scheme}://${rest}`
    const result = await testXtreamConnection({ serverUrl: candidateUrl, username, password })
    // Any answer the provider could meaningfully return (active/expired/inactive)
    // means the scheme is right. Only "unavailable" warrants trying the other one.
    if (result.status !== "unavailable") {
      return {
        serverUrl: candidateUrl,
        scheme,
        swapped: originalScheme ? scheme !== originalScheme : false,
        originalScheme,
        test: result,
      }
    }
    lastResult = result
  }

  const fallbackScheme = originalScheme || "http"
  return {
    serverUrl: `${fallbackScheme}://${rest}`,
    scheme: fallbackScheme,
    swapped: false,
    originalScheme,
    test: lastResult,
  }
}

/**
 * Same idea as resolveServerScheme but for M3U / M3U8 playlist URLs - probes
 * both schemes (http first unless port hints at TLS) and saves whichever
 * actually serves a valid M3U body. Lets users paste `provider.com/get.php?...`
 * without the `http://` prefix on D-pad keyboards.
 *
 * @returns {Promise<{ url: string, scheme: "http"|"https", swapped: boolean, originalScheme: "http"|"https"|null, test: object }>}
 */
export async function resolveM3UScheme(url) {
  const trimmed = String(url || "").trim()
  if (!trimmed) {
    return {
      url: trimmed,
      scheme: "http",
      swapped: false,
      originalScheme: null,
      test: { status: "unavailable", message: "Missing URL" },
    }
  }

  const schemeMatch = trimmed.match(/^(https?):\/\//i)
  const originalScheme = schemeMatch ? /** @type {"http"|"https"} */ (schemeMatch[1].toLowerCase()) : null
  const rest = originalScheme ? trimmed.replace(/^https?:\/\//i, "") : trimmed

  let order
  if (originalScheme) {
    order = [originalScheme, originalScheme === "https" ? "http" : "https"]
  } else {
    const portMatch = rest.match(/:(\d+)(?:\/|$|\?)/)
    const port = portMatch ? parseInt(portMatch[1], 10) : 0
    order = port === 443 || port === 8443 ? ["https", "http"] : ["http", "https"]
  }

  let lastResult = { status: "unavailable" }
  for (const scheme of order) {
    const candidateUrl = `${scheme}://${rest}`
    const result = await testM3UUrl(candidateUrl)
    if (result.status === "active") {
      return {
        url: candidateUrl,
        scheme,
        swapped: originalScheme ? scheme !== originalScheme : false,
        originalScheme,
        test: result,
      }
    }
    lastResult = result
  }

  const fallbackScheme = originalScheme || "http"
  return {
    url: `${fallbackScheme}://${rest}`,
    scheme: fallbackScheme,
    swapped: false,
    originalScheme,
    test: lastResult,
  }
}

/**
 * Hit `get_account_info` and classify the response.
 *
 * `reason` is populated on every non-success path via `classifyError`, so the
 * caller can render actionable copy without parsing free-form messages. See
 * `provider-error.js` for the full taxonomy.
 *
 * @returns {Promise<{ status: "active"|"expired"|"inactive"|"unavailable", expDate?: number|null, reason?: string, httpStatus?: number, raw?: string, latencyMs?: number, allowedOutputFormats?: string[]|null }>}
 */
export async function testXtreamConnection({ serverUrl, username, password }) {
  if (!serverUrl || !username || !password) {
    return { status: "unavailable", reason: "unknown", raw: "Missing fields" }
  }
  const safe = safeHttpUrl(serverUrl)
  if (!safe) return { status: "unavailable", reason: "unknown", raw: "Bad URL" }
  const { classifyError } = await import("./provider-error.js")
  const startedAt = Date.now()
  try {
    const url = buildApiUrl(
      { host: serverUrl, port: "", user: username, pass: password },
      "get_account_info"
    )
    const { providerFetch } = await import("./provider-fetch.js")
    const response = await providerFetch(url, { logKind: "api" })
    if (!response.ok) {
      const classified = classifyError({ response })
      return {
        status: "unavailable",
        reason: classified.kind,
        httpStatus: classified.httpStatus,
        latencyMs: Date.now() - startedAt,
      }
    }
    let data
    try {
      data = await response.json()
    } catch (parseError) {
      return {
        status: "unavailable",
        reason: "bad_response",
        raw: String(parseError?.message || parseError),
        latencyMs: Date.now() - startedAt,
      }
    }
    const latencyMs = Date.now() - startedAt
    const info = data?.user_info
    if (info && (info.auth === 0 || info.auth === "0")) {
      const classified = classifyError({ payload: data })
      return { status: "unavailable", reason: classified.kind, latencyMs }
    }
    if (!info?.status) {
      return { status: "unavailable", reason: "bad_response", latencyMs }
    }
    const expSeconds = parseInt(info.exp_date ?? "", 10)
    const expDate = Number.isFinite(expSeconds) ? expSeconds * 1000 : null
    const allowedOutputFormats = Array.isArray(info.allowed_output_formats)
      ? info.allowed_output_formats.map((format) => String(format).toLowerCase())
      : null
    if (info.status !== "Active") return { status: "inactive", expDate, latencyMs, allowedOutputFormats }
    if (expDate && expDate < Date.now()) return { status: "expired", expDate, latencyMs, allowedOutputFormats }
    return { status: "active", expDate, latencyMs, allowedOutputFormats }
  } catch (caughtError) {
    const classified = classifyError({ error: caughtError })
    return {
      status: "unavailable",
      reason: classified.kind,
      raw: classified.raw,
      latencyMs: Date.now() - startedAt,
    }
  }
}

/**
 * @returns {Promise<{ status: "active"|"unavailable", count?: number, reason?: string, httpStatus?: number, raw?: string, latencyMs?: number }>}
 */
export async function testM3UUrl(url) {
  if (!url) return { status: "unavailable", reason: "unknown", raw: "Missing URL" }
  if (!/^https?:\/\//i.test(url)) {
    return { status: "unavailable", reason: "unknown", raw: "Missing scheme" }
  }
  const { classifyError } = await import("./provider-error.js")
  const startedAt = Date.now()
  try {
    const { providerFetch } = await import("./provider-fetch.js")
    const response = await providerFetch(url, { logKind: "api" })
    if (!response.ok) {
      const classified = classifyError({ response })
      return {
        status: "unavailable",
        reason: classified.kind,
        httpStatus: classified.httpStatus,
        latencyMs: Date.now() - startedAt,
      }
    }
    const text = await response.text()
    const latencyMs = Date.now() - startedAt
    const head = text.slice(0, 4096)
    const looksLikeM3U =
      head.includes("#EXTM3U") || /#EXTINF\s*:/i.test(head)
    if (!looksLikeM3U) {
      return { status: "unavailable", reason: "bad_response", latencyMs }
    }
    const matches = text.match(/#EXTINF\s*:/gi)
    return { status: "active", count: matches ? matches.length : 0, latencyMs }
  } catch (caughtError) {
    const classified = classifyError({ error: caughtError })
    return {
      status: "unavailable",
      reason: classified.kind,
      raw: classified.raw,
      latencyMs: Date.now() - startedAt,
    }
  }
}
