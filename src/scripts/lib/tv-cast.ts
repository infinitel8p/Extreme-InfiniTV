// TV receiver mode: sender-side device store, session store, and HTTP client.
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { toast } from "@/scripts/lib/toast.js"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { buildMovieStreamUrl } from "@/scripts/lib/stream-urls.ts"
import {
  isCastableSrc,
  buildVodCastDescriptor,
  buildLiveCastDescriptor,
  type CastDescriptorV1,
} from "@/scripts/lib/tv-cast-descriptor"

export interface TvDevice {
  id: string
  name: string
  host: string
  port: number
  key: string
  createdAt: number
  lastSeenAt: number
}

export const TV_DEVICES_EVENT = "xt:tv-devices-changed"

const DEVICES_STORAGE_KEY = "xt_tv_devices"
const SESSION_STORAGE_KEY = "xt_cast_session"

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
  return (
    typeof device.id === "string" &&
    typeof device.name === "string" &&
    typeof device.host === "string" &&
    typeof device.port === "number" &&
    typeof device.key === "string" &&
    typeof device.createdAt === "number" &&
    typeof device.lastSeenAt === "number"
  )
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
  dismissed?: boolean
}

export const CAST_SESSION_EVENT = "xt:cast-session-changed"

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

export function setCastSession(session: CastSession): void {
  writeSessionStorage(SESSION_STORAGE_KEY, JSON.stringify(session))
  dispatchDocumentEvent(CAST_SESSION_EVENT)
}

export function updateCastSession(patch: Partial<CastSession>): void {
  const current = getCastSession()
  if (!current) return
  setCastSession({ ...current, ...patch })
}

export function clearCastSession(): void {
  writeSessionStorage(SESSION_STORAGE_KEY, null)
  dispatchDocumentEvent(CAST_SESSION_EVENT)
}

export class CastAuthError extends Error {}

function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`
}

export function senderDeviceName(): string {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Android/i.test(userAgent)) return "Extreme InfiniTV on Android"
  if (/Windows/i.test(userAgent)) return "Extreme InfiniTV on Windows"
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "Extreme InfiniTV on macOS"
  if (/Linux/i.test(userAgent)) return "Extreme InfiniTV on Linux"
  return "Extreme InfiniTV"
}

export async function probeTvDevice(
  host: string,
  port: number
): Promise<{ v: number; app: string; name: string } | null> {
  try {
    const response = await providerFetch(`${baseUrl(host, port)}/info`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      logKind: "other",
    })
    if (!response.ok) return null
    const data = await response.json()
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.v !== "number" ||
      typeof data.app !== "string" ||
      typeof data.name !== "string"
    ) {
      return null
    }
    return { v: data.v, app: data.app, name: data.name }
  } catch {
    return null
  }
}

export async function pairTvDevice(params: {
  host: string
  port: number
  code: string
}): Promise<TvDevice> {
  let response: Response
  try {
    response = await providerFetch(`${baseUrl(params.host, params.port)}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, code: params.code, deviceName: senderDeviceName() }),
      signal: AbortSignal.timeout(8000),
      logKind: "other",
    })
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
    id: typeof data.id === "string" && data.id ? data.id : `${params.host}:${params.port}`,
    name: data.name,
    host: params.host,
    port: params.port,
    key: data.key,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
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
  const response = await providerFetch(`${baseUrl(device.host, device.port)}${path}`, {
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
}

export async function castPlay(device: TvDevice, descriptor: CastDescriptorV1): Promise<void> {
  await postDeviceAction(device, "/play", descriptor, 8000)
  setCastSession({
    deviceId: device.id,
    deviceName: device.name,
    host: device.host,
    port: device.port,
    key: device.key,
    title: descriptor.title,
    isLive: descriptor.isLive,
    startedAt: Date.now(),
  })
  touchTvDevice(device.id)
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
  await postDeviceAction(device, "/stop", {}, 4000)
  clearCastSession()
}

export interface CastState {
  state: string
  positionSeconds: number
  durationSeconds?: number
  title?: string
}

export async function fetchCastState(device: TvDevice): Promise<CastState | null> {
  try {
    const response = await providerFetch(`${baseUrl(device.host, device.port)}/state`, {
      method: "GET",
      headers: { "X-XT-Key": device.key },
      signal: AbortSignal.timeout(4000),
      logKind: "other",
    })
    if (!response.ok) return null
    const data = await response.json()
    if (!data || typeof data !== "object" || typeof data.state !== "string" || typeof data.positionSeconds !== "number") {
      return null
    }
    const state: CastState = { state: data.state, positionSeconds: data.positionSeconds }
    if (typeof data.durationSeconds === "number") state.durationSeconds = data.durationSeconds
    if (typeof data.title === "string") state.title = data.title
    return state
  } catch {
    return null
  }
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

export interface PlayOnTvOptions {
  buildDescriptor: () => Promise<CastDescriptorV1 | null> | CastDescriptorV1 | null
  stopLocal?: () => void
  contentTitle?: string | null
}

async function castToDevice(device: TvDevice, options: PlayOnTvOptions): Promise<boolean> {
  const descriptor = await options.buildDescriptor()
  if (!descriptor) {
    toast({ title: t("cast.toast.failed", { device: device.name }) })
    return false
  }

  try {
    await castPlay(device, descriptor)
    options.stopLocal?.()
    toast({ title: t("cast.toast.playing", { device: device.name }), duration: 2600 })
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
  return castToDevice(repaired, options)
}

/** Orchestrates picker -> descriptor build -> cast; reopens the picker on an auth failure. */
export async function playOnTv(options: PlayOnTvOptions): Promise<boolean> {
  const { openTvDevicePicker } = await import("@/scripts/lib/tv-device-dialog.js")
  const device = await openTvDevicePicker({ contentTitle: options.contentTitle })
  if (!device) return false
  return castToDevice(device, options)
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
}

/** Builds a "play on TV" click handler for an Xtream VOD entry (movies + hub cards). */
export function castXtreamVodToTv(params: CastXtreamVodParams): () => void {
  return () => {
    void playOnTv({
      contentTitle: params.title || null,
      buildDescriptor: () => {
        const src = buildMovieStreamUrl(params.creds, params.vodId, params.containerExt || null)
        if (!isCastableSrc(src)) return null
        return buildVodCastDescriptor({ src, title: params.title || "", logo: params.logo || undefined })
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
  stopLocal?: () => void
}

/** Builds a "play on TV" click handler for a live channel (Live TV channel list + player more-menu). */
export function castLiveChannelToTv(params: CastLiveChannelParams): () => void {
  return () => {
    void playOnTv({
      contentTitle: params.contentTitle,
      stopLocal: params.stopLocal,
      buildDescriptor: () => {
        const src = params.buildSrc()
        if (!src || !isCastableSrc(src)) return null
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
