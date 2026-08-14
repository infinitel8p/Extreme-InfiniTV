// In-memory per-play-session playback health log. No persistence.

import { redactUrl } from "@/scripts/lib/log.js"
import { formatPaddedHms } from "@/scripts/lib/format.js"

export type HealthKind =
  | "start"
  | "playing"
  | "waiting"
  | "stalled"
  | "variant"
  | "dropped"
  | "error"
  | "recover"
  | "fallback"
  | "giveup"
  | "end"

export interface HealthEntry {
  at: number
  kind: HealthKind
  detail: string
  count: number
}

export interface HealthSession {
  id: number
  seq: number | null
  startedAt: number
  endedAt: number | null
  label: string
  kind: "live" | "vod" | "series"
  backend: string
  engine: string | null
  entries: HealthEntry[]
}

export interface HealthSummary {
  variants: number
  stalls: number
  waits: number
  errors: number
  droppedFrames: number
  durationMs: number
}

export function appendHealthEntry(
  entries: HealthEntry[],
  entry: HealthEntry,
  options?: { coalesceWindowMs?: number; maxEntries?: number },
): HealthEntry[] {
  const coalesceWindowMs = options?.coalesceWindowMs ?? 2000
  const maxEntries = options?.maxEntries ?? 200
  const lastEntry = entries[entries.length - 1]
  let nextEntries: HealthEntry[]
  if (
    lastEntry &&
    lastEntry.kind === entry.kind &&
    lastEntry.detail === entry.detail &&
    entry.at - lastEntry.at <= coalesceWindowMs
  ) {
    const coalesced: HealthEntry = { ...lastEntry, at: entry.at, count: lastEntry.count + entry.count }
    nextEntries = [...entries.slice(0, -1), coalesced]
  } else {
    nextEntries = [...entries, entry]
  }
  if (nextEntries.length > maxEntries) nextEntries = nextEntries.slice(nextEntries.length - maxEntries)
  return nextEntries
}

export function summarizeSession(session: HealthSession): HealthSummary {
  let variants = 0
  let stalls = 0
  let waits = 0
  let errors = 0
  let droppedFrames = 0
  for (const entry of session.entries) {
    if (entry.kind === "variant") variants += entry.count
    else if (entry.kind === "stalled") stalls += entry.count
    else if (entry.kind === "waiting") waits += entry.count
    else if (entry.kind === "error" || entry.kind === "giveup") errors += entry.count
    else if (entry.kind === "dropped") {
      const parsed = Number(entry.detail)
      droppedFrames += Number.isFinite(parsed) ? parsed * entry.count : entry.count
    }
  }
  const durationMs = (session.endedAt ?? Date.now()) - session.startedAt
  return { variants, stalls, waits, errors, droppedFrames, durationMs }
}

export function formatEntryOffset(at: number, startedAt: number): string {
  let deltaSeconds = Math.round((at - startedAt) / 1000)
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) deltaSeconds = 0
  return `+${formatPaddedHms(deltaSeconds)}`
}

export function redactHealthDetail(detail: string): string {
  return redactUrl(detail)
}

/** True for a page bundle's internal "auto:*" retune reasons, false for a user-initiated tune. */
export function isAutomaticRetuneReason(reason: string): boolean {
  return reason.startsWith("auto:")
}

const MAX_SESSIONS = 8

let sessions: HealthSession[] = []
let nextSessionId = 1
let activeSession: HealthSession | null = null
const subscribers = new Set<() => void>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null

function cloneSession(session: HealthSession): HealthSession {
  return { ...session, entries: session.entries.map((entry) => ({ ...entry })) }
}

function notify(): void {
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const listener of subscribers) {
      try { listener() } catch {}
    }
  }, 0)
}

export function startHealthSession(input: {
  label: string
  kind: "live" | "vod" | "series"
  backend: string
  engine?: string | null
  seq?: number | null
}): HealthSession {
  endHealthSession()
  const session: HealthSession = {
    id: nextSessionId++,
    seq: input.seq ?? null,
    startedAt: Date.now(),
    endedAt: null,
    label: input.label,
    kind: input.kind,
    backend: input.backend,
    engine: input.engine ?? null,
    entries: [],
  }
  activeSession = session
  sessions = [...sessions, session]
  if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(sessions.length - MAX_SESSIONS)
  notify()
  return session
}

export function recordHealth(kind: HealthKind, detail = ""): void {
  if (!activeSession) return
  const entry: HealthEntry = { at: Date.now(), kind, detail: redactHealthDetail(detail), count: 1 }
  activeSession.entries = appendHealthEntry(activeSession.entries, entry)
  notify()
}

export function endHealthSession(reason?: string): void {
  if (!activeSession || activeSession.endedAt != null) return
  activeSession.endedAt = Date.now()
  if (reason) {
    activeSession.entries = appendHealthEntry(activeSession.entries, {
      at: activeSession.endedAt,
      kind: "end",
      detail: redactHealthDetail(reason),
      count: 1,
    })
  }
  activeSession = null
  notify()
}

export function listHealthSessions(): HealthSession[] {
  return [...sessions].reverse().map(cloneSession)
}

export function getActiveHealthSession(): HealthSession | null {
  return activeSession ? cloneSession(activeSession) : null
}

export function hasActiveHealthSession(): boolean {
  return activeSession !== null
}

export function subscribeHealth(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:player-fallback", (event) => {
    const detail = (event as CustomEvent).detail as { requested?: string; used?: string } | undefined
    recordHealth("fallback", `${detail?.requested ?? "?"} -> ${detail?.used ?? "?"}`)
  })
}
