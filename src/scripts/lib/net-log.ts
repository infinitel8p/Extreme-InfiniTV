// In-memory ring buffer of recent provider HTTP requests, for Settings + bug-report ZIP.
import { redactUrl } from "@/scripts/lib/log.js"

export type NetLogKind = "api" | "playlist" | "epg" | "image" | "media" | "update" | "other"
export type NetLogTransport = "native" | "tauri" | "tauri-fallback"
export type NetLogOutcome = "ok" | "error" | "aborted"

export interface NetLogEntry {
  seq: number
  startedAt: number
  durationMs: number
  method: string
  url: string
  kind: NetLogKind
  transport: NetLogTransport
  status: number | null
  ok: boolean
  outcome: NetLogOutcome
  error?: string
}

export interface NetworkLogSnapshot {
  capacity: number
  recorded: number
  dropped: number
  entries: NetLogEntry[]
}

export interface NetLogInput {
  method?: string
  url?: string
  kind?: NetLogKind
  transport?: NetLogTransport
  startedAt?: number
  endedAt?: number
  status?: number | null
  outcome?: NetLogOutcome
  error?: unknown
}

export const NET_LOG_CAPACITY = 200
export const NET_LOG_EVENT = "xt:net-log-changed"

const URL_MAX_LENGTH = 200
const ERROR_MAX_LENGTH = 160

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return String(error)
  } catch {
    return ""
  }
}

function resolveTimestamps(input: NetLogInput): { startedAt: number; endedAt: number } {
  const startedAt = Number.isFinite(input.startedAt)
    ? (input.startedAt as number)
    : Number.isFinite(input.endedAt)
      ? (input.endedAt as number)
      : Date.now()
  const endedAt = Number.isFinite(input.endedAt) ? (input.endedAt as number) : startedAt
  return { startedAt, endedAt }
}

export function makeNetLogEntry(input: NetLogInput, seq: number): NetLogEntry {
  const method = (input.method || "GET").toUpperCase()
  const url = redactUrl(input.url ?? "").slice(0, URL_MAX_LENGTH)
  const { startedAt, endedAt } = resolveTimestamps(input)
  const durationMs = Math.max(0, Math.round(endedAt - startedAt))
  const status = input.status == null ? null : input.status
  const hasError = input.error != null
  const outcome: NetLogOutcome = input.outcome ?? (hasError ? "error" : status != null ? "ok" : "error")
  const ok = outcome === "ok" && status != null && status >= 200 && status < 300

  const entry: NetLogEntry = {
    seq,
    startedAt,
    durationMs,
    method,
    url,
    kind: input.kind ?? "other",
    transport: input.transport ?? "native",
    status,
    ok,
    outcome,
  }
  if (hasError) entry.error = redactUrl(stringifyError(input.error)).slice(0, ERROR_MAX_LENGTH)
  return entry
}

export function pushWithCapacity<T>(entries: T[], entry: T, capacity: number): number {
  entries.push(entry)
  const maxLength = Math.max(0, capacity)
  let dropped = 0
  while (entries.length > maxLength) {
    entries.shift()
    dropped++
  }
  return dropped
}

export function shouldRecordKind(kind: NetLogKind, includeImages: boolean): boolean {
  return kind !== "image" || includeImages
}

const store = {
  entries: [] as NetLogEntry[],
  dropped: 0,
  recorded: 0,
  seq: 0,
}

const KEY_INCLUDE_IMAGES = "xt_netlog_images"
const SESSION_KEY = "xt_netlog_v1"
const SESSION_FALLBACK_TAIL = 50

function readLS(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function writeLS(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {}
}

function isNetLogEntry(value: unknown): value is NetLogEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.seq === "number" &&
    typeof entry.startedAt === "number" &&
    typeof entry.durationMs === "number" &&
    typeof entry.method === "string" &&
    typeof entry.url === "string" &&
    typeof entry.kind === "string" &&
    typeof entry.transport === "string" &&
    typeof entry.outcome === "string" &&
    typeof entry.ok === "boolean"
  )
}

function hydrateFromSession(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return
    const entries = (parsed as Record<string, unknown>).entries
    if (!Array.isArray(entries)) return
    const validEntries = entries.filter(isNetLogEntry)
    store.entries = validEntries
    const recorded = (parsed as Record<string, unknown>).recorded
    const dropped = (parsed as Record<string, unknown>).dropped
    store.recorded = typeof recorded === "number" ? recorded : validEntries.length
    store.dropped = typeof dropped === "number" ? dropped : 0
    store.seq = validEntries.reduce((maxSeq, entry) => Math.max(maxSeq, entry.seq), 0)
  } catch {}
}

hydrateFromSession()

let sessionPersistDisabled = false

function persistToSession(entries: NetLogEntry[]): void {
  if (sessionPersistDisabled) return
  const payload = JSON.stringify({ entries, recorded: store.recorded, dropped: store.dropped })
  try {
    sessionStorage.setItem(SESSION_KEY, payload)
    return
  } catch {}
  try {
    const tail = entries.slice(-SESSION_FALLBACK_TAIL)
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ entries: tail, recorded: store.recorded, dropped: store.dropped }),
    )
  } catch {
    sessionPersistDisabled = true
  }
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {}
}

let includeImages = readLS(KEY_INCLUDE_IMAGES, "") === "1"
let dispatchQueued = false

export function getNetLogIncludeImages(): boolean {
  return includeImages
}

export function setNetLogIncludeImages(on: boolean): void {
  includeImages = Boolean(on)
  writeLS(KEY_INCLUDE_IMAGES, includeImages ? "1" : "")
}

function dispatchNetLogEvent(): void {
  try {
    document.dispatchEvent(new CustomEvent(NET_LOG_EVENT))
  } catch {}
}

function queueDispatch(): void {
  if (dispatchQueued) return
  dispatchQueued = true
  setTimeout(() => {
    dispatchQueued = false
    persistToSession(store.entries)
    dispatchNetLogEvent()
  }, 0)
}

export function recordNetLog(input: NetLogInput): void {
  try {
    const kind = input.kind ?? "other"
    if (!shouldRecordKind(kind, includeImages)) return
    const entry = makeNetLogEntry(input, ++store.seq)
    store.dropped += pushWithCapacity(store.entries, entry, NET_LOG_CAPACITY)
    store.recorded++
    queueDispatch()
  } catch {}
}

export function getNetworkLog(): NetworkLogSnapshot {
  return {
    capacity: NET_LOG_CAPACITY,
    recorded: store.recorded,
    dropped: store.dropped,
    entries: store.entries.map((entry) => ({ ...entry })),
  }
}

export function clearNetworkLog(): void {
  try {
    store.entries = []
    store.dropped = 0
    store.recorded = 0
    clearSession()
    dispatchNetLogEvent()
  } catch {}
}
