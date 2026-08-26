// TV receiver mode: sender-side device store, session store, and HTTP client.
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { toast } from "@/scripts/lib/toast.js"
import { confirmDialog } from "@/scripts/lib/confirm-dialog.js"
import { t } from "@/scripts/lib/i18n.js"
import { log, redactUrl } from "@/scripts/lib/log.js"
import { buildMovieStreamUrl, buildSeriesStreamUrl } from "@/scripts/lib/stream-urls.ts"
import { getActivePlaylistIdSync, getConnectionLimitWarning } from "@/scripts/lib/account-info.js"
import {
  isCastableSrc,
  buildVodCastDescriptor,
  buildLiveCastDescriptor,
  deriveSessionIsLive,
  type CastDescriptorV1,
} from "@/scripts/lib/tv-cast-descriptor"
import { discoverReceivers, type DiscoveredReceiver } from "@/scripts/lib/receiver-discovery.ts"

export interface TvDevice {
  id: string
  name: string
  host: string
  port: number
  key: string
  createdAt: number
  lastSeenAt: number
  hosts?: string[]
  pinnedHostIndex?: number
}

export const TV_DEVICES_EVENT = "xt:tv-devices-changed"

const DEVICES_STORAGE_KEY = "xt_tv_devices"
const SESSION_STORAGE_KEY = "xt_cast_session"
/** localStorage mirror of the session, so a still-playing receiver can be found again after an app relaunch. */
const SESSION_BACKUP_STORAGE_KEY = "xt_cast_session_backup_v1"
const SESSION_BACKUP_MAX_AGE_MS = 12 * 60 * 60 * 1000

function readLocalStorage(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(key, value)
  } catch {}
}

function removeLocalStorage(key: string): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(key)
  } catch {}
}

function readSessionStorage(key: string): string | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writeSessionStorage(key: string, value: string | null): void {
  try {
    if (typeof sessionStorage === "undefined") return
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {}
}

function dispatchDocumentEvent(name: string): void {
  try {
    if (typeof document === "undefined") return
    document.dispatchEvent(new CustomEvent(name))
  } catch {}
}

function isTvDevice(value: unknown): value is TvDevice {
  if (!value || typeof value !== "object") return false
  const device = value as Record<string, unknown>
  if (
    typeof device.id !== "string" ||
    typeof device.name !== "string" ||
    typeof device.host !== "string" ||
    typeof device.port !== "number" ||
    typeof device.key !== "string" ||
    typeof device.createdAt !== "number" ||
    typeof device.lastSeenAt !== "number"
  ) {
    return false
  }
  if (device.hosts !== undefined && (!Array.isArray(device.hosts) || device.hosts.some((host) => typeof host !== "string"))) {
    return false
  }
  if (device.pinnedHostIndex !== undefined && typeof device.pinnedHostIndex !== "number") return false
  return true
}

export function listTvDevices(): TvDevice[] {
  const raw = readLocalStorage(DEVICES_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isTvDevice) : []
  } catch {
    return []
  }
}

function writeTvDevices(devices: TvDevice[]): void {
  writeLocalStorage(DEVICES_STORAGE_KEY, JSON.stringify(devices))
  dispatchDocumentEvent(TV_DEVICES_EVENT)
}

export function saveTvDevice(device: TvDevice): void {
  const devices = listTvDevices()
  const existingIndex = devices.findIndex((existing) => existing.id === device.id)
  if (existingIndex === -1) devices.push(device)
  else devices[existingIndex] = device
  writeTvDevices(devices)
}

export function removeTvDevice(id: string): void {
  writeTvDevices(listTvDevices().filter((device) => device.id !== id))
}

export function touchTvDevice(id: string): void {
  const devices = listTvDevices()
  const device = devices.find((entry) => entry.id === id)
  if (!device) return
  device.lastSeenAt = Date.now()
  writeTvDevices(devices)
}

export type DeviceInputResult =
  | { ok: true; host: string; port: number; code: string }
  | { ok: false; reason: "host" | "port" | "code" }

function isValidHost(host: string): boolean {
  return host.length > 0 && !/[\s/:]/.test(host)
}

export function validateDeviceInput(input: {
  host: string
  port: string | number
  code: string
}): DeviceInputResult {
  const host = input.host.trim()
  if (!isValidHost(host)) return { ok: false, reason: "host" }

  const port = typeof input.port === "number" ? input.port : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "port" }

  const code = input.code.trim()
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "code" }

  return { ok: true, host, port, code }
}

export interface CastSession {
  deviceId: string
  deviceName: string
  host: string
  port: number
  key: string
  title: string
  isLive: boolean
  startedAt: number
  /** Wall-clock session start, for the live elapsed-time clock; absent on pre-1.9 backups. */
  startedAtMs?: number
  dismissed?: boolean
  connectedOnly?: boolean
  hosts?: string[]
  pinnedHostIndex?: number
  contentHref?: string
  logo?: string
  liveContext?: { playlistId: string; channelIds: string[]; index: number }
  seriesContext?: { playlistId: string; seriesId: string; season: number; episodeNum: number }
  vodContext?: { playlistId: string; vodId: string }
}

export const CAST_SESSION_EVENT = "xt:cast-session-changed"

/** Bumped on every teardown so an in-flight castPlay can tell its session is gone and skip resurrecting it. */
let castGeneration = 0

function isCastSession(value: unknown): value is CastSession {
  if (!value || typeof value !== "object") return false
  const session = value as Record<string, unknown>
  return (
    typeof session.deviceId === "string" &&
    typeof session.deviceName === "string" &&
    typeof session.host === "string" &&
    typeof session.port === "number" &&
    typeof session.key === "string" &&
    typeof session.title === "string" &&
    typeof session.isLive === "boolean" &&
    typeof session.startedAt === "number"
  )
}

export function getCastSession(): CastSession | null {
  const raw = readSessionStorage(SESSION_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return isCastSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

export interface CastSessionBackup {
  session: CastSession
  savedAt: number
}

function isCastSessionBackup(value: unknown): value is CastSessionBackup {
  if (!value || typeof value !== "object") return false
  const backup = value as Record<string, unknown>
  return typeof backup.savedAt === "number" && isCastSession(backup.session)
}

/** Pure shape + expiry gate for a relaunch-reattach candidate; also narrows the parsed JSON. */
export function isReattachableBackup(value: unknown, nowMs: number): value is CastSessionBackup {
  if (!isCastSessionBackup(value)) return false
  return nowMs - value.savedAt < SESSION_BACKUP_MAX_AGE_MS
}

export function setCastSession(session: CastSession): void {
  writeSessionStorage(SESSION_STORAGE_KEY, JSON.stringify(session))
  writeLocalStorage(SESSION_BACKUP_STORAGE_KEY, JSON.stringify({ session, savedAt: Date.now() }))
  dispatchDocumentEvent(CAST_SESSION_EVENT)
}

export function updateCastSession(patch: Partial<CastSession>): void {
  const current = getCastSession()
  if (!current) return
  setCastSession({ ...current, ...patch })
}

export function clearCastSession(): void {
  castGeneration += 1
  writeSessionStorage(SESSION_STORAGE_KEY, null)
  removeLocalStorage(SESSION_BACKUP_STORAGE_KEY)
  dispatchDocumentEvent(CAST_SESSION_EVENT)
}

const LIVE_CONTEXT_MAX_CHANNELS = 500

/** Builds an ordered-channel-list cast context, windowed to 500 ids around the cast channel. */
export function buildLiveCastContext(
  playlistId: string,
  channelIds: string[],
  channelId: string
): CastSession["liveContext"] | undefined {
  const index = channelIds.indexOf(channelId)
  if (index === -1) return undefined
  if (channelIds.length <= LIVE_CONTEXT_MAX_CHANNELS) return { playlistId, channelIds, index }
  const halfWindow = Math.floor(LIVE_CONTEXT_MAX_CHANNELS / 2)
  const maxStart = channelIds.length - LIVE_CONTEXT_MAX_CHANNELS
  const start = Math.min(Math.max(0, index - halfWindow), maxStart)
  return { playlistId, channelIds: channelIds.slice(start, start + LIVE_CONTEXT_MAX_CHANNELS), index: index - start }
}

export class CastAuthError extends Error {}

/** Wraps a raw IPv6 host in brackets so it can sit in a URL authority; passthrough otherwise. */
export function formatHostForUrl(host: string): string {
  const alreadyBracketed = host.startsWith("[") && host.endsWith("]")
  if (host.includes(":") && !alreadyBracketed) return `[${host}]`
  return host
}

/** True for IPv6 link-local (fe80::/10) and IPv4 link-local (169.254.0.0/16) - unusable without a zone index. */
export function isLinkLocalHost(host: string): boolean {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(unwrapped)) return true
  if (!unwrapped.includes(":")) return false
  const firstHextet = unwrapped.split(":")[0]
  if (!/^[0-9a-fA-F]{1,4}$/.test(firstHextet)) return false
  return (parseInt(firstHextet, 16) & 0xffc0) === 0xfe80
}

function baseUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`
}

/** Thrown only for a connection-level failure (refused/timeout/DNS); never for an HTTP response. */
class HostUnreachableError extends Error {}

async function fetchFromHost(url: string, init: RequestInit & { logKind?: string }): Promise<Response> {
  try {
    return await providerFetch(url, init)
  } catch (err) {
    throw new HostUnreachableError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * [pinned-or-primary, ...rest], mirroring the Xtream mirror-pin walk in xtream-api.js.
 */
export function candidateHostOrder(hosts: string[], pinnedHostIndex?: number): string[] {
  if (hosts.length === 0) return []
  const pinnedIndex = pinnedHostIndex != null && pinnedHostIndex >= 0 && pinnedHostIndex < hosts.length ? pinnedHostIndex : 0
  const pinned = hosts[pinnedIndex]
  const rest = hosts.filter((_, index) => index !== pinnedIndex)
  const ordered = [pinned, ...rest]
  const reachable = ordered.filter((host) => !isLinkLocalHost(host))
  return reachable.length > 0 ? reachable : ordered
}

function deviceHostOrder(device: TvDevice): string[] {
  const hosts = device.hosts && device.hosts.length ? device.hosts : [device.host]
  return candidateHostOrder(hosts, device.pinnedHostIndex)
}

/** "host:port" entries for the Rust known-host discovery fast path (port-qualified, since PORT_ATTEMPTS can offset it). */
export function deviceKnownHostEntries(device: TvDevice): string[] {
  const hosts = device.hosts && device.hosts.length ? device.hosts : [device.host]
  return hosts.map((host) => `${host}:${device.port}`)
}

/** Tries each host in order, stopping at the first that doesn't throw `HostUnreachableError`. */
async function walkHosts<T>(
  hosts: string[],
  attempt: (host: string) => Promise<T>
): Promise<{ result: T; host: string }> {
  let lastError: unknown = null
  for (const host of hosts) {
    try {
      return { result: await attempt(host), host }
    } catch (err) {
      lastError = err
      if (!(err instanceof HostUnreachableError)) throw err
    }
  }
  throw lastError instanceof Error ? lastError : new HostUnreachableError("no reachable host")
}

function pinHostForDevice(device: TvDevice, host: string): void {
  const hosts = device.hosts && device.hosts.length ? device.hosts : [device.host]
  const index = hosts.indexOf(host)
  if (index === -1) return
  const stored = listTvDevices().find((entry) => entry.id === device.id)
  if (stored) saveTvDevice({ ...stored, pinnedHostIndex: index })
  const session = getCastSession()
  if (session && session.deviceId === device.id) updateCastSession({ pinnedHostIndex: index })
}

/**
 * Walks a device's candidate hosts on a connection failure, pinning the winner. An HTTP-level
 * failure (auth, bad status) propagates immediately instead of trying another host.
 */
async function withHostFallback<T>(device: TvDevice, attempt: (host: string) => Promise<T>): Promise<T> {
  const hosts = deviceHostOrder(device)
  const { result, host } = await walkHosts(hosts, attempt)
  if (host !== hosts[0]) pinHostForDevice(device, host)
  return result
}

interface AndroidDeviceInfoBridge {
  getDeviceName?: () => string
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)
}

let cachedSenderDeviceName: string | null = null

async function initSenderDeviceName(): Promise<void> {
  if (typeof window === "undefined") return
  try {
    const bridge = (window as any).AndroidDeviceInfo as AndroidDeviceInfoBridge | undefined
    const androidName = bridge?.getDeviceName?.()?.trim()
    if (androidName) {
      cachedSenderDeviceName = androidName
      return
    }
    if (!isTauriRuntime()) return
    const { invoke } = await import("@tauri-apps/api/core")
    const hostname = (await invoke<string>("device_hostname")).trim()
    if (hostname) cachedSenderDeviceName = hostname
  } catch {}
}

void initSenderDeviceName()

/** UA-based label is a fallback for the brief window before the real device name resolves. */
export function senderDeviceName(): string {
  if (cachedSenderDeviceName) return cachedSenderDeviceName
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Android/i.test(userAgent)) return "Extreme InfiniTV on Android"
  if (/Windows/i.test(userAgent)) return "Extreme InfiniTV on Windows"
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "Extreme InfiniTV on macOS"
  if (/Linux/i.test(userAgent)) return "Extreme InfiniTV on Linux"
  return "Extreme InfiniTV"
}

/**
 * Pre-pairing reachability probe. `hosts` (when given) are tried in order; unlike the
 * post-pairing calls below, a bad response also moves on to the next host, since there's no
 * established device yet to tell a live-but-wrong host apart from a dead one.
 */
export async function probeTvDevice(
  host: string,
  port: number,
  hosts?: string[]
): Promise<{ v: number; app: string; name: string } | null> {
  const candidates = candidateHostOrder(hosts && hosts.length ? hosts : [host])
  for (const candidate of candidates) {
    try {
      const response = await providerFetch(`${baseUrl(candidate, port)}/info`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
        logKind: "other",
      })
      if (!response.ok) continue
      const data = await response.json()
      if (
        !data ||
        typeof data !== "object" ||
        typeof data.v !== "number" ||
        typeof data.app !== "string" ||
        typeof data.name !== "string"
      ) {
        continue
      }
      return { v: data.v, app: data.app, name: data.name }
    } catch {
      continue
    }
  }
  return null
}

async function probeAuthorizedAtHost(host: string, device: TvDevice): Promise<"online" | "unauthorized"> {
  const response = await fetchFromHost(`${baseUrl(host, device.port)}/state`, {
    method: "GET",
    headers: { "X-XT-Key": device.key },
    signal: AbortSignal.timeout(4000),
    logKind: "other",
  })
  if (response.ok) return "online"
  if (response.status === 401 || response.status === 403) return "unauthorized"
  throw new Error(`probe failed: ${response.status}`)
}

/** Probes a paired device's own auth, distinguishing a stale key from an unreachable TV. */
export async function probeTvDeviceAuthorized(
  device: TvDevice
): Promise<"online" | "unauthorized" | "unreachable"> {
  try {
    return await withHostFallback(device, (host) => probeAuthorizedAtHost(host, device))
  } catch {
    return "unreachable"
  }
}

export async function pairTvDevice(params: {
  host: string
  port: number
  code: string
  hosts?: string[]
  /** mDNS id of the discovered receiver being paired, when pairing came from the discovery list. */
  id?: string
}): Promise<TvDevice> {
  const hosts = candidateHostOrder(params.hosts && params.hosts.length ? params.hosts : [params.host])
  let response: Response
  let winningHost: string
  try {
    const walked = await walkHosts(hosts, (host) =>
      fetchFromHost(`${baseUrl(host, params.port)}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, code: params.code, deviceName: senderDeviceName() }),
        signal: AbortSignal.timeout(8000),
        logKind: "other",
      })
    )
    response = walked.result
    winningHost = walked.host
  } catch {
    throw new Error("unreachable")
  }
  if (response.status === 403) throw new Error("badCode")
  if (!response.ok) throw new Error("unreachable")

  const data = await response.json().catch(() => null)
  if (!data || typeof data.key !== "string" || typeof data.name !== "string") {
    throw new Error("unreachable")
  }

  const device: TvDevice = {
    id: params.id || (typeof data.id === "string" && data.id ? data.id : `${winningHost}:${params.port}`),
    name: data.name,
    host: winningHost,
    port: params.port,
    key: data.key,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  if (hosts.length > 1) {
    device.hosts = hosts
    device.pinnedHostIndex = hosts.indexOf(winningHost)
  }
  saveTvDevice(device)
  return device
}

async function postDeviceAction(
  device: TvDevice,
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<void> {
  await withHostFallback(device, async (host) => {
    const response = await fetchFromHost(`${baseUrl(host, device.port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-XT-Key": device.key },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
      logKind: "other",
    })
    if (response.status === 401 || response.status === 403) {
      throw new CastAuthError("unauthorized")
    }
    if (!response.ok) {
      throw new Error(`cast request failed: ${response.status}`)
    }
  })
}

const AMBIENT_PUSH_THROTTLE_KEY = "xt_tv_ambient_pushed"
const AMBIENT_PUSH_THROTTLE_MS = 6 * 60 * 60 * 1000

function readAmbientPushTimestamps(): Record<string, number> {
  const raw = readLocalStorage(AMBIENT_PUSH_THROTTLE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function wasAmbientPushedRecently(deviceId: string): boolean {
  const pushedAt = readAmbientPushTimestamps()[deviceId]
  return typeof pushedAt === "number" && Date.now() - pushedAt < AMBIENT_PUSH_THROTTLE_MS
}

function markAmbientPushed(deviceId: string): void {
  const timestamps = readAmbientPushTimestamps()
  timestamps[deviceId] = Date.now()
  writeLocalStorage(AMBIENT_PUSH_THROTTLE_KEY, JSON.stringify(timestamps))
}

async function activePlaylistId(): Promise<string | null> {
  try {
    const { getActiveEntry } = await import("@/scripts/lib/creds.js")
    const entry = await getActiveEntry()
    return entry?._id ?? null
  } catch {
    return null
  }
}

/** Best-effort artwork push for receiver-only ambient screensavers; never throws or surfaces a toast. */
export async function pushAmbientManifest(device: TvDevice): Promise<void> {
  if (wasAmbientPushedRecently(device.id)) return
  try {
    const playlistId = await activePlaylistId()
    if (!playlistId) return
    const { buildAmbientManifest } = await import("@/scripts/lib/ambient-manifest.js")
    const entries = await buildAmbientManifest(playlistId)
    if (!entries.length) return
    await withHostFallback(device, async (host) => {
      const response = await fetchFromHost(`${baseUrl(host, device.port)}/ambient`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-XT-Key": device.key },
        body: JSON.stringify({ v: 1, entries }),
        signal: AbortSignal.timeout(8000),
        logKind: "other",
      })
      if (!response.ok) throw new Error(`ambient push failed: ${response.status}`)
    })
    markAmbientPushed(device.id)
  } catch (err) {
    log.warn("[xt:tv-cast] pushAmbientManifest failed:", err)
  }
}

export interface CastPlayContext {
  liveContext?: CastSession["liveContext"]
  seriesContext?: CastSession["seriesContext"]
  vodContext?: CastSession["vodContext"]
}

interface LastPlayRequest {
  deviceId: string
  descriptor: CastDescriptorV1
  context?: CastPlayContext
}

/** The most recent successful castPlay, kept so the pill's Retry button can replay it after a receiver error. */
let lastPlayRequest: LastPlayRequest | null = null

export const CAST_PLAY_SETTLE_MS = 5000
let castPlayInFlight = 0
let lastCastPlayAtMs = 0

/** A /play swaps the receiver's engine, which reports a transient idle; senders must not read that as a stop. */
export function isCastPlaySettling(nowMs: number = Date.now()): boolean {
  return castPlayInFlight > 0 || (lastCastPlayAtMs > 0 && nowMs - lastCastPlayAtMs < CAST_PLAY_SETTLE_MS)
}

export async function castPlay(
  device: TvDevice,
  descriptor: CastDescriptorV1,
  context?: CastPlayContext
): Promise<void> {
  const generationAtRequest = castGeneration
  castPlayInFlight += 1
  lastCastPlayAtMs = Date.now()
  // Receiver errors arrive minutes later over the state feed; without this they read as spontaneous.
  log.info("[xt:cast] play", {
    device: device.name,
    title: descriptor.title,
    isLive: descriptor.isLive,
    mime: descriptor.mime,
    src: redactUrl(descriptor.src),
  })
  try {
    await postDeviceAction(device, "/play", descriptor, 8000)
  } finally {
    castPlayInFlight -= 1
    lastCastPlayAtMs = Date.now()
  }
  // Session was torn down (e.g. stop) while this request was in flight; don't resurrect it.
  if (generationAtRequest !== castGeneration) return
  const storedDevice = listTvDevices().find((entry) => entry.id === device.id) ?? device
  setCastSession({
    deviceId: storedDevice.id,
    deviceName: storedDevice.name,
    host: storedDevice.host,
    port: storedDevice.port,
    key: storedDevice.key,
    title: descriptor.title,
    isLive: deriveSessionIsLive(descriptor, context),
    startedAt: Date.now(),
    startedAtMs: Date.now(),
    hosts: storedDevice.hosts,
    pinnedHostIndex: storedDevice.pinnedHostIndex,
    contentHref: typeof location !== "undefined" ? location.pathname + location.search : undefined,
    logo: descriptor.logo,
    liveContext: context?.liveContext,
    seriesContext: context?.seriesContext,
    vodContext: context?.vodContext,
  })
  touchTvDevice(storedDevice.id)
  lastPlayRequest = { deviceId: storedDevice.id, descriptor, context }
  void pushAmbientManifest(storedDevice)
}

/** Replays the last successful castPlay for this device, for the pill's error-state Retry button. */
export async function castRetryLast(device: TvDevice): Promise<boolean> {
  if (!lastPlayRequest || lastPlayRequest.deviceId !== device.id) return false
  try {
    await castPlay(device, lastPlayRequest.descriptor, lastPlayRequest.context)
    return true
  } catch (err) {
    log.warn("[xt:tv-cast] castRetryLast failed:", err)
    return false
  }
}

export async function castPause(device: TvDevice): Promise<void> {
  await postDeviceAction(device, "/pause", {}, 4000)
}

export async function castResume(device: TvDevice): Promise<void> {
  await postDeviceAction(device, "/resume", {}, 4000)
}

export async function castSeek(device: TvDevice, seconds: number): Promise<void> {
  await postDeviceAction(device, "/seek", { seconds }, 4000)
}

export async function castStop(device: TvDevice): Promise<void> {
  // Session must clear even when the TV is gone, or routing stays on forever.
  try {
    await postDeviceAction(device, "/stop", {}, 4000)
  } finally {
    lastPlayRequest = null
    clearCastSession()
  }
}

export async function castSetVolume(device: TvDevice, level: number, muted: boolean): Promise<void> {
  const clampedLevel = Math.min(1, Math.max(0, level))
  await postDeviceAction(device, "/volume", { level: clampedLevel, muted }, 5000)
}

export interface CastState {
  state: string
  positionSeconds: number
  durationSeconds?: number
  title?: string
  error?: string
  volume?: number
  muted?: boolean
}

/** Shared payload validation for the poll (`/state`) and push (`/events` WebSocket) transports. */
export function parseCastStateValue(value: unknown): CastState | null {
  if (!value || typeof value !== "object") return null
  const data = value as Record<string, unknown>
  if (typeof data.state !== "string" || typeof data.positionSeconds !== "number") return null
  const state: CastState = { state: data.state, positionSeconds: data.positionSeconds }
  if (typeof data.durationSeconds === "number") state.durationSeconds = data.durationSeconds
  if (typeof data.title === "string") state.title = data.title
  if (typeof data.error === "string" && data.error) state.error = data.error
  if (typeof data.volume === "number" && data.volume >= 0 && data.volume <= 1) state.volume = data.volume
  if (typeof data.muted === "boolean") state.muted = data.muted
  return state
}

async function fetchStateFromHost(host: string, device: TvDevice): Promise<CastState> {
  const response = await fetchFromHost(`${baseUrl(host, device.port)}/state`, {
    method: "GET",
    headers: { "X-XT-Key": device.key },
    signal: AbortSignal.timeout(4000),
    logKind: "other",
  })
  if (!response.ok) throw new Error(`cast state failed: ${response.status}`)
  const data = await response.json()
  const state = parseCastStateValue(data)
  if (!state) throw new Error("cast state: bad payload")
  return state
}

/** Poll-tick state fetch: pinned host only, no fallback walk (keeps the 2s poll cheap). */
export async function fetchCastState(device: TvDevice): Promise<CastState | null> {
  try {
    return await fetchStateFromHost(deviceHostOrder(device)[0], device)
  } catch {
    return null
  }
}

/** Same as fetchCastState but walks the device's remaining hosts on a connection failure. */
export async function fetchCastStateWithFallback(device: TvDevice): Promise<CastState | null> {
  try {
    return await withHostFallback(device, (host) => fetchStateFromHost(host, device))
  } catch {
    return null
  }
}

/** Distinguishes an actively-running receiver session (worth reattaching to) from idle or errored. */
export function isActivelyPlayingState(state: CastState): boolean {
  return state.state === "playing" || state.state === "paused"
}

/** Matches a rediscovered receiver to a paired device: by receiver id when known, else by name. */
export function matchDiscoveredReceiver(
  device: TvDevice,
  discovered: DiscoveredReceiver[]
): DiscoveredReceiver | null {
  const byId = discovered.find((receiver) => receiver.id && receiver.id === device.id)
  if (byId) return byId
  return discovered.find((receiver) => receiver.name === device.name) ?? null
}

/** Builds an in-memory candidate only; the caller persists it once a probe confirms the identity. */
function applyDiscoveredHost(device: TvDevice, discovered: DiscoveredReceiver): TvDevice {
  const hosts = discovered.hosts.length ? discovered.hosts : [discovered.host]
  return { ...device, host: hosts[0], port: discovered.port, hosts, pinnedHostIndex: 0 }
}

function discoverReceiversOnce(timeoutMs: number, knownHosts?: string[]): Promise<DiscoveredReceiver[]> {
  return new Promise((resolve) => {
    let latest: DiscoveredReceiver[] = []
    discoverReceivers(
      (list) => {
        latest = list
      },
      timeoutMs,
      () => resolve(latest),
      { knownHosts }
    )
  })
}

/** Probes the paired device's own hosts, picking up any pinnedHostIndex the host-fallback walk just persisted. */
async function probeDeviceForReattach(device: TvDevice): Promise<{ state: CastState; device: TvDevice } | null> {
  const state = await fetchCastStateWithFallback(device)
  if (!state) return null
  const pinnedDevice = listTvDevices().find((entry) => entry.id === device.id) ?? device
  return { state, device: pinnedDevice }
}

/**
 * Probes a rediscovered host without touching storage. Answering with a valid state at all (even idle)
 * already proves identity, since /state requires the paired device's own key - the caller persists the
 * candidate only once this succeeds.
 */
async function probeDiscoveredHostForReattach(
  pairedDevice: TvDevice,
  discovered: DiscoveredReceiver
): Promise<{ state: CastState; device: TvDevice } | null> {
  const candidate = applyDiscoveredHost(pairedDevice, discovered)
  const state = await fetchCastStateWithFallback(candidate)
  if (!state) return null
  return { state, device: candidate }
}

/** True when a still-fresh backup is on disk, i.e. a later reattach attempt is worth making. */
export function hasReattachableCastBackup(): boolean {
  const rawBackup = readLocalStorage(SESSION_BACKUP_STORAGE_KEY)
  if (!rawBackup) return false
  try {
    return isReattachableBackup(JSON.parse(rawBackup), Date.now())
  } catch {
    return false
  }
}

/**
 * Relaunch-time rediscovery: rebuilds an orphaned cast session from the localStorage backup, probing
 * (and, if unreachable, rediscovering) the receiver so a still-playing TV doesn't lose its pill for good.
 * The backup is only removed on a conclusive negative (expired, unpaired, or a receiver that answered but
 * isn't playing our session); a merely unreachable receiver keeps the backup so a later retry can succeed.
 */
export async function tryReattachCastSession(): Promise<CastSession | null> {
  if (getCastSession()) return null

  const rawBackup = readLocalStorage(SESSION_BACKUP_STORAGE_KEY)
  if (!rawBackup) return null

  let parsedBackup: unknown
  try {
    parsedBackup = JSON.parse(rawBackup)
  } catch {
    removeLocalStorage(SESSION_BACKUP_STORAGE_KEY)
    return null
  }
  if (!isReattachableBackup(parsedBackup, Date.now())) {
    removeLocalStorage(SESSION_BACKUP_STORAGE_KEY)
    return null
  }

  const pairedDevice = listTvDevices().find((entry) => entry.id === parsedBackup.session.deviceId)
  if (!pairedDevice) {
    removeLocalStorage(SESSION_BACKUP_STORAGE_KEY)
    return null
  }

  let probe = await probeDeviceForReattach(pairedDevice)
  if (!probe) {
    const discovered = await discoverReceiversOnce(3000, deviceKnownHostEntries(pairedDevice))
    const match = matchDiscoveredReceiver(pairedDevice, discovered)
    if (match) {
      probe = await probeDiscoveredHostForReattach(pairedDevice, match)
      if (probe) saveTvDevice(probe.device)
    }
  }

  // Transient: the receiver simply didn't answer this time - keep the backup for a later retry.
  if (!probe) return null

  // Conclusive: the receiver answered but isn't playing our session anymore.
  if (!isActivelyPlayingState(probe.state)) {
    removeLocalStorage(SESSION_BACKUP_STORAGE_KEY)
    return null
  }

  const restoredSession: CastSession = {
    ...parsedBackup.session,
    deviceName: probe.device.name,
    host: deviceHostOrder(probe.device)[0],
    port: probe.device.port,
    key: probe.device.key,
    hosts: probe.device.hosts,
    pinnedHostIndex: probe.device.pinnedHostIndex,
    // Keep a dismissed session dismissed: it should reattach for accurate state, not silently re-route.
    dismissed: parsedBackup.session.dismissed === true,
  }
  // The probes above can take several seconds - if the user (or another reattach)
  // started a session in the meantime, leave it alone instead of clobbering it.
  if (getCastSession()) return null
  setCastSession(restoredSession)
  return restoredSession
}

/** Fetches the receiver's own log tail for diagnostics; null on any failure. */
export async function fetchReceiverLogs(device: TvDevice): Promise<string | null> {
  try {
    return await withHostFallback(device, async (host) => {
      const response = await fetchFromHost(`${baseUrl(host, device.port)}/logs`, {
        method: "GET",
        headers: { "X-XT-Key": device.key },
        signal: AbortSignal.timeout(5000),
        logKind: "other",
      })
      if (!response.ok) throw new Error(`logs failed: ${response.status}`)
      return await response.text()
    })
  } catch {
    return null
  }
}

export interface ReceiverLogSnapshot {
  at: string
  text: string
  /** "stream" came off the /events socket as the session ran; "fetch" is a /logs tail. */
  source?: "stream" | "fetch"
}

const RECEIVER_LOG_SNAPSHOT_KEY = "xt_receiver_log_snapshot_v1"
const RECEIVER_LOG_SNAPSHOT_MAX_BYTES = 64 * 1024
const receiverLogSnapshotFallback = new Map<string, ReceiverLogSnapshot>()

function capReceiverLogText(text: string): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= RECEIVER_LOG_SNAPSHOT_MAX_BYTES) return text
  return new TextDecoder("utf-8", { fatal: false }).decode(
    encoded.subarray(encoded.length - RECEIVER_LOG_SNAPSHOT_MAX_BYTES)
  )
}

function readReceiverLogSnapshotsFromStorage(): Record<string, ReceiverLogSnapshot> {
  const raw = readLocalStorage(RECEIVER_LOG_SNAPSHOT_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/** Caches a receiver's log tail in localStorage so it survives an app restart, not just the tab. */
export function cacheReceiverLogSnapshot(
  deviceName: string,
  text: string,
  source: ReceiverLogSnapshot["source"] = "fetch"
): void {
  const snapshot: ReceiverLogSnapshot = { at: new Date().toISOString(), text: capReceiverLogText(text), source }
  try {
    if (typeof localStorage === "undefined") throw new Error("no-local-storage")
    const snapshots = readReceiverLogSnapshotsFromStorage()
    snapshots[deviceName] = snapshot
    localStorage.setItem(RECEIVER_LOG_SNAPSHOT_KEY, JSON.stringify(snapshots))
  } catch {
    receiverLogSnapshotFallback.set(deviceName, snapshot)
  }
}

const MAX_STREAMED_LOG_LINES = 400
const streamedReceiverLogs = new Map<string, string[]>()

/** Appends /events log lines; persisted per batch so a bug report survives the TV going unreachable. */
export function appendStreamedReceiverLog(deviceName: string, lines: string[]): void {
  const usable = lines.filter((line) => typeof line === "string" && line.trim() !== "")
  if (usable.length === 0) return
  const existing = streamedReceiverLogs.get(deviceName) ?? []
  const combined = existing.concat(usable)
  const capped = combined.slice(Math.max(0, combined.length - MAX_STREAMED_LOG_LINES))
  streamedReceiverLogs.set(deviceName, capped)
  cacheReceiverLogSnapshot(deviceName, capped.join("\n"), "stream")
}

export function getStreamedReceiverLog(deviceName: string): string[] {
  return streamedReceiverLogs.get(deviceName) ?? []
}

export function getReceiverLogSnapshots(): Record<string, ReceiverLogSnapshot> {
  const merged = readReceiverLogSnapshotsFromStorage()
  for (const [deviceName, snapshot] of receiverLogSnapshotFallback) {
    if (!merged[deviceName]) merged[deviceName] = snapshot
  }
  return merged
}

export function getReceiverLogSnapshotAt(deviceName: string): number | null {
  const snapshot = getReceiverLogSnapshots()[deviceName]
  if (!snapshot) return null
  const at = Date.parse(snapshot.at)
  return Number.isNaN(at) ? null : at
}

const RECEIVER_LOG_TAIL_LINES = 5

/** Last few receiver log lines cached for a device, for the remote dialog's collapsed error detail. */
export function getReceiverLogTail(deviceName: string): string[] {
  const snapshot = getReceiverLogSnapshots()[deviceName]
  if (!snapshot) return []
  return snapshot.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-RECEIVER_LOG_TAIL_LINES)
}

export function startCastStatePolling(
  device: TvDevice,
  onState: (state: CastState) => void,
  { intervalMs = 2000 }: { intervalMs?: number } = {}
): () => void {
  let stopped = false
  const interval = setInterval(() => {
    if (stopped) return
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return
    fetchCastState(device).then((state) => {
      if (!stopped && state) onState(state)
    })
  }, intervalMs)
  return () => {
    stopped = true
    clearInterval(interval)
  }
}

/** Sentinel a buildDescriptor callback returns when a newer request superseded it; distinct from a genuine build failure. */
export const CAST_SUPERSEDED = "cast-superseded"
const UNCASTABLE_SCHEME_PREFIX = "cast-uncastable-scheme:"
export type CastUncastableScheme = `${typeof UNCASTABLE_SCHEME_PREFIX}${string}`

/** Rejects a source by scheme so the toast can name it; null for http(s). */
export function castUncastableScheme(src: string): CastUncastableScheme | null {
  const scheme = (String(src).split("://")[0] || "").toLowerCase()
  if (!scheme || scheme === "http" || scheme === "https") return null
  return `${UNCASTABLE_SCHEME_PREFIX}${scheme}`
}

export interface PlayOnTvOptions {
  buildDescriptor: () =>
    | Promise<CastDescriptorV1 | null | typeof CAST_SUPERSEDED | CastUncastableScheme>
    | CastDescriptorV1
    | null
    | typeof CAST_SUPERSEDED
    | CastUncastableScheme
  /** Return false when nothing was actually released, to skip the provider-slot wait. */
  stopLocal?: () => boolean | void
  contentTitle?: string | null
  quiet?: boolean
  contentHref?: string | null
  liveContext?: CastSession["liveContext"]
  seriesContext?: CastSession["seriesContext"]
  vodContext?: CastSession["vodContext"]
  /** True for live/catch-up sources that hold a provider connection open, so the connection-limit gate applies. */
  holdsProviderConnection?: boolean
}

/** Reconstructs a TvDevice from an active cast session, for routing without the picker. */
export function sessionAsDevice(session: CastSession): TvDevice {
  return {
    id: session.deviceId,
    name: session.deviceName,
    host: session.host,
    port: session.port,
    key: session.key,
    createdAt: 0,
    lastSeenAt: 0,
    hosts: session.hosts,
    pinnedHostIndex: session.pinnedHostIndex,
  }
}

// Xtream panels free a stream slot only once the sender's socket has closed.
const PROVIDER_SLOT_SETTLE_MS = 600

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isCastRoutingActive(): boolean {
  const session = getCastSession()
  return !!session && !session.dismissed
}

type ConnLimitWarning = { level: "ok" | "warn" | "crit"; currentCons: number; maxCons: number } | null

export type ConnLimitGateAction = "block-confirm" | "toast" | "proceed"

/** Pure decision for the connection-limit gate ahead of an initial live cast handoff. */
export function decideConnLimitGateAction(warning: ConnLimitWarning): ConnLimitGateAction {
  if (!warning) return "proceed"
  if (warning.level === "crit") return "block-confirm"
  if (warning.level === "warn") return "toast"
  return "proceed"
}

/** Warns or blocks before a live handoff briefly holds two provider connections; false = abort the cast. */
async function gateConnectionLimitForLiveCast(): Promise<boolean> {
  const playlistId = getActivePlaylistIdSync()
  const warning = playlistId ? getConnectionLimitWarning(playlistId) : null
  const action = decideConnLimitGateAction(warning)
  if (action === "proceed") return true

  const params = { current: String(warning!.currentCons), max: String(warning!.maxCons) }
  if (action === "toast") {
    toast({ title: t("cast.connLimit.toastWarn", params), variant: "warn" })
    return true
  }

  return confirmDialog({
    title: t("cast.connLimit.confirmTitle"),
    message: t("cast.connLimit.confirmBody", params),
    confirmLabel: t("cast.connLimit.confirmAction"),
  })
}

/** A cast session already running on this device means the receiver will just swap streams, not add a connection. */
function isAlreadyCastingToDevice(device: TvDevice): boolean {
  const session = getCastSession()
  return !!session && !session.dismissed && session.deviceId === device.id
}

async function castToDevice(
  device: TvDevice,
  options: PlayOnTvOptions,
  skipConnLimitGate = false
): Promise<boolean> {
  if (
    !skipConnLimitGate &&
    options.holdsProviderConnection &&
    !isAlreadyCastingToDevice(device) &&
    !(await gateConnectionLimitForLiveCast())
  ) {
    return false
  }

  const descriptor = await options.buildDescriptor()
  if (descriptor === CAST_SUPERSEDED) return false
  if (typeof descriptor === "string") {
    const scheme = descriptor.slice(UNCASTABLE_SCHEME_PREFIX.length)
    log.warn("[xt:tv-cast] source scheme cannot be cast", { scheme, device: device.name })
    toast({ title: t("cast.toast.schemeUnsupported", { scheme, device: device.name }) })
    return false
  }
  if (!descriptor) {
    toast({ title: t("cast.toast.failed", { device: device.name }) })
    return false
  }

  // Hand our provider connection over first: a capped account refuses the second one outright.
  if (options.stopLocal) {
    const released = options.stopLocal()
    if (released !== false) await sleep(PROVIDER_SLOT_SETTLE_MS)
  }

  try {
    await castPlay(device, descriptor, {
      liveContext: options.liveContext,
      seriesContext: options.seriesContext,
      vodContext: options.vodContext,
    })
    if (options.contentHref) updateCastSession({ contentHref: options.contentHref })
    if (!options.quiet) {
      toast({ title: t("cast.toast.playing", { device: device.name }), duration: 2600 })
    }
    return true
  } catch (err) {
    if (err instanceof CastAuthError) {
      toast({
        title: t("cast.toast.authFailed", { device: device.name }),
        action: {
          label: t("cast.toast.pairAgain"),
          onClick: () => {
            void repairAndCast(device, options)
          },
        },
      })
      return false
    }
    log.warn("[xt:tv-cast] playOnTv failed:", err)
    toast({ title: t("cast.toast.failed", { device: device.name }) })
    return false
  }
}

async function repairAndCast(device: TvDevice, options: PlayOnTvOptions): Promise<boolean> {
  const { openTvDevicePicker } = await import("@/scripts/lib/tv-device-dialog.js")
  const repaired = await openTvDevicePicker({
    contentTitle: options.contentTitle,
    prefillHost: device.host,
    prefillPort: device.port,
  })
  if (!repaired) return false
  // The original attempt already gated (and the user may have confirmed) - don't ask twice for one cast.
  return castToDevice(repaired, options, true)
}

async function repairAndConnect(device: TvDevice): Promise<boolean> {
  const { openTvDevicePicker } = await import("@/scripts/lib/tv-device-dialog.js")
  const repaired = await openTvDevicePicker({ prefillHost: device.host, prefillPort: device.port })
  if (!repaired) return false
  return castConnect(repaired)
}

/** Connects to a TV before playing anything, Chromecast-style; leaves an already-casting session alone. */
export async function castConnect(device: TvDevice): Promise<boolean> {
  const current = getCastSession()
  if (current && current.deviceId === device.id && current.title) return true

  const status = await probeTvDeviceAuthorized(device)
  if (status === "online") {
    const storedDevice = listTvDevices().find((entry) => entry.id === device.id) ?? device
    setCastSession({
      deviceId: storedDevice.id,
      deviceName: storedDevice.name,
      host: storedDevice.host,
      port: storedDevice.port,
      key: storedDevice.key,
      title: "",
      isLive: false,
      startedAt: Date.now(),
      connectedOnly: true,
      hosts: storedDevice.hosts,
      pinnedHostIndex: storedDevice.pinnedHostIndex,
    })
    touchTvDevice(storedDevice.id)
    toast({ title: t("cast.toast.connected", { device: device.name }), duration: 2600 })
    void pushAmbientManifest(storedDevice)
    return true
  }
  if (status === "unauthorized") {
    toast({
      title: t("cast.toast.authFailed", { device: device.name }),
      action: {
        label: t("cast.toast.pairAgain"),
        onClick: () => {
          void repairAndConnect(device)
        },
      },
    })
    return false
  }
  toast({ title: t("cast.toast.failed", { device: device.name }) })
  return false
}

/** Orchestrates picker -> descriptor build -> cast; reopens the picker on an auth failure. */
export async function playOnTv(options: PlayOnTvOptions): Promise<boolean> {
  const { openTvDevicePicker } = await import("@/scripts/lib/tv-device-dialog.js")
  const device = await openTvDevicePicker({ contentTitle: options.contentTitle })
  if (!device) return false
  return castToDevice(device, options)
}

/** Casts to the already-active session's device without opening the picker. */
export async function routePlayToCast(options: PlayOnTvOptions): Promise<boolean> {
  const session = getCastSession()
  if (!session || session.dismissed) return false
  return castToDevice(sessionAsDevice(session), options)
}

interface XtreamCastCreds {
  host: string
  port?: string | number
  user: string
  pass: string
}

export interface CastXtreamVodParams {
  creds: XtreamCastCreds
  vodId: string | number
  containerExt?: string | null
  title?: string | null
  logo?: string | null
  contentHref?: string | null
  resumeSeconds?: number
  durationSeconds?: number
  /** Hub cards can belong to a non-active playlist; progress must be recorded against that one. */
  playlistId?: string | null
}

/** Builds a "play on TV" click handler for an Xtream VOD entry (movies + hub cards). */
export function castXtreamVodToTv(params: CastXtreamVodParams): () => void {
  return () => {
    void (async () => {
      const playlistId = params.playlistId || (await activePlaylistId())
      await playOnTv({
        contentTitle: params.title || null,
        contentHref: params.contentHref ?? `/movies/detail?id=${params.vodId}`,
        vodContext: playlistId ? { playlistId, vodId: String(params.vodId) } : undefined,
        buildDescriptor: () => {
          const src = buildMovieStreamUrl(params.creds, params.vodId, params.containerExt || null)
          if (!isCastableSrc(src)) return null
          return buildVodCastDescriptor({
            src,
            title: params.title || "",
            logo: params.logo || undefined,
            resumeSeconds: params.resumeSeconds,
            durationSeconds: params.durationSeconds,
          })
        },
      })
    })()
  }
}

export interface CastXtreamEpisodeParams {
  creds: XtreamCastCreds
  playlistId: string
  seriesId: string | number
  episodeId: string | number
  containerExt?: string | null
  season: number
  episodeNum: number
  title?: string | null
  logo?: string | null
  resumeSeconds?: number
  durationSeconds?: number
  contentHref?: string | null
  stopLocal?: () => boolean | void
  /** Overrides the built Xtream URL - custom-playlist episodes carry their own direct stream URL. */
  src?: string | null
}

/** Builds a "play on TV" click handler for a series episode (episode context menu + detail-page button). */
export function castXtreamEpisodeToTv(params: CastXtreamEpisodeParams): () => void {
  return () => {
    void playOnTv({
      contentTitle: params.title || null,
      contentHref: params.contentHref ?? null,
      stopLocal: params.stopLocal,
      seriesContext: {
        playlistId: params.playlistId,
        seriesId: String(params.seriesId),
        season: params.season,
        episodeNum: params.episodeNum,
      },
      buildDescriptor: () => {
        const src = params.src || buildSeriesStreamUrl(params.creds, params.episodeId, params.containerExt)
        if (!isCastableSrc(src)) return null
        return buildVodCastDescriptor({
          src,
          title: params.title || "",
          logo: params.logo || undefined,
          resumeSeconds: params.resumeSeconds,
          durationSeconds: params.durationSeconds,
        })
      },
    })
  }
}

export interface CastLiveChannelParams {
  contentTitle: string | null
  title: string
  logo?: string | null
  buildSrc: () => string | null
  drm?: CastDescriptorV1["drm"]
  headers?: CastDescriptorV1["headers"]
  preferNativeHls?: boolean
  stopLocal?: () => boolean | void
  contentHref?: string | null
  liveContext?: CastSession["liveContext"]
}

/** Builds a "play on TV" click handler for a live channel (Live TV channel list + player more-menu). */
export function castLiveChannelToTv(params: CastLiveChannelParams): () => void {
  return () => {
    const channelId = params.liveContext?.channelIds[params.liveContext.index]
    void playOnTv({
      contentTitle: params.contentTitle,
      contentHref: params.contentHref ?? (channelId ? `/livetv?channel=${channelId}` : "/livetv"),
      stopLocal: params.stopLocal,
      liveContext: params.liveContext,
      holdsProviderConnection: true,
      buildDescriptor: () => {
        const src = params.buildSrc()
        if (!src) return null
        if (!isCastableSrc(src, { live: true })) return castUncastableScheme(src)
        return buildLiveCastDescriptor({
          src,
          title: params.title,
          logo: params.logo || undefined,
          drm: params.drm,
          headers: params.headers,
          preferNativeHls: params.preferNativeHls,
        })
      },
    })
  }
}
