// Playlist storage + Xtream/M3U URL helpers.
//
// Storage shape (one JSON blob under "xt_playlists"):
//   { entries: PlaylistEntry[], selectedId: string }
//
// PlaylistEntry =
//   | { _id, title, type: "xtream", serverUrl, username, password, addedAt, lastUsedAt? }
//   | { _id, title, type: "m3u",    url,                                 addedAt, lastUsedAt? }
//
// Tauri builds persist via @tauri-apps/plugin-store; web/SSR via localStorage
// + cookies. Old "xt_host" / "xt_port" / "xt_user" / "xt_pass" keys are
// auto-migrated into one entry on first read.
import { Store } from "@tauri-apps/plugin-store"

export const isTauri =
  typeof window !== "undefined" && !!window.__TAURI__

const STORAGE_KEY = "xt_playlists"
const LEGACY_KEYS = ["host", "port", "user", "pass"]
const EVT_ACTIVE_CHANGED = "xt:active-changed"
const EVT_ENTRIES_UPDATED = "xt:entries-updated"

let storePromise = null
function getStore() {
  if (!isTauri) return Promise.resolve(null)
  if (!storePromise) storePromise = Store.load(".xtream.creds.json")
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

const uuid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

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
  } catch {}
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
    await store.set(STORAGE_KEY, data)
    await store.save()
  }
  try {
    localStorage.setItem(STORAGE_KEY, json)
    setCookie(STORAGE_KEY, json)
  } catch {}
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
  // M3U: absolute http(s) URL ending in .m3u/.m3u8 with no creds.
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
  } catch {}
  // Xtream: combine host + port into a serverUrl.
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
  if (entry.type === "xtream") {
    entry.serverUrl = (entry.serverUrl || "").replace(/\/+$/, "")
  } else if (entry.type === "m3u") {
    entry.url = entry.url || ""
  }
  if (!entry.title) {
    entry.title =
      entry.type === "xtream"
        ? hostnameFrom(entry.serverUrl) || "Untitled"
        : hostnameFrom(entry.url) || "Untitled"
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
  const remaining = s.entries.filter((e) => e._id !== id)
  let selectedId = s.selectedId
  if (selectedId === id) selectedId = remaining[0]?._id || ""
  await writeRaw({ entries: remaining, selectedId })
  // Drop any cached channel/VOD lists for this playlist.
  const { invalidateEntry } = await import("./cache.js")
  invalidateEntry(id)
  // Drop favorites + recents for this playlist (xtream_rust pattern: per-source
  // entries don't outlive their source).
  const { clearForPlaylist } = await import("./preferences.js")
  clearForPlaylist(id)
  dispatch(EVT_ENTRIES_UPDATED)
  dispatch(EVT_ACTIVE_CHANGED, await getActiveEntry())
}

export async function updateEntry(id, patch) {
  const s = await getState()
  const next = s.entries.map((e) => (e._id === id ? { ...e, ...patch } : e))
  await writeRaw({ ...s, entries: next })
  // Edited creds may not produce the same channel list - drop caches.
  const { invalidateEntry } = await import("./cache.js")
  invalidateEntry(id)
  dispatch(EVT_ENTRIES_UPDATED)
  if (s.selectedId === id) dispatch(EVT_ACTIVE_CHANGED, await getActiveEntry())
}

/** Force a re-fetch of the active playlist's data. */
export async function refreshActive() {
  const active = await getActiveEntry()
  if (!active) return
  const { invalidateEntry } = await import("./cache.js")
  invalidateEntry(active._id)
  dispatch(EVT_ACTIVE_CHANGED, active)
}

function dispatch(name, detail) {
  try {
    document.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {}
}

// ---------------------------------------------------------------------------
// Back-compat shim: callers that still want flat {host,port,user,pass}.
// ---------------------------------------------------------------------------
export async function loadCreds() {
  const e = await getActiveEntry()
  if (!e) return { host: "", port: "", user: "", pass: "" }
  if (e.type === "m3u") {
    return { host: e.url || "", port: "", user: "", pass: "" }
  }
  return {
    host: e.serverUrl || "",
    port: "",
    user: e.username || "",
    pass: e.password || "",
  }
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

export function safeHttpUrl(u) {
  if (!u) return ""
  try {
    const base =
      typeof location !== "undefined" ? location.href : "http://x/"
    const x = new URL(u, base)
    return /^https?:$/.test(x.protocol) ? x.href : ""
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
  try {
    const url = new URL(host)
    const ext = (url.pathname || "").toLowerCase()
    const isM3U = ext.endsWith(".m3u") || ext.endsWith(".m3u8")
    return /^https?:$/.test(url.protocol) && isM3U && !user && !pass
  } catch {
    return false
  }
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

/**
 * Inspect a pasted URL. If it's a `?username=&password=` query, return the
 * extracted creds. Used to auto-populate the form on paste (iptvnator-style).
 */
export function parseXtreamUrl(input) {
  if (!input) return null
  let url
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null
  const username = url.searchParams.get("username") || ""
  const password = url.searchParams.get("password") || ""
  if (!username || !password) return null
  // Server URL = origin only (drop player_api.php / get.php / etc.)
  return {
    serverUrl: url.origin,
    username,
    password,
  }
}

/**
 * Hit `get_account_info` and classify the response.
 * @returns {Promise<{ status: "active"|"expired"|"inactive"|"unavailable", expDate?: number, message?: string }>}
 */
export async function testXtreamConnection({ serverUrl, username, password }) {
  if (!serverUrl || !username || !password) {
    return { status: "unavailable", message: "Missing fields" }
  }
  const safe = safeHttpUrl(serverUrl)
  if (!safe) return { status: "unavailable", message: "Bad URL" }
  try {
    const url = buildApiUrl(
      { host: serverUrl, port: "", user: username, pass: password },
      "get_account_info"
    )
    const r = await fetch(url)
    if (!r.ok) {
      return {
        status: "unavailable",
        message: `HTTP ${r.status} ${r.statusText}`,
      }
    }
    const data = await r.json().catch(() => null)
    const info = data?.user_info
    if (!info?.status) {
      return { status: "unavailable", message: "No user_info in response" }
    }
    const expSeconds = parseInt(info.exp_date ?? "", 10)
    const expDate = Number.isFinite(expSeconds) ? expSeconds * 1000 : null
    if (info.status !== "Active") return { status: "inactive", expDate }
    if (expDate && expDate < Date.now()) return { status: "expired", expDate }
    return { status: "active", expDate }
  } catch (e) {
    return { status: "unavailable", message: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------
const DIACRITICS = /[\u0300-\u036F]/g

export const normalize = (s) =>
  (s || "")
    .toString()
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[|_\-()[\].,:/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export const debounce = (fn, ms = 180) => {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}
