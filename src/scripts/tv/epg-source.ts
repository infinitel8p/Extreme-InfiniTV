// Decides which EPG data source the TV browse UI reads from, and hosts the
// shared per-channel short-EPG cache all TV views/OSD pull from.
import { memoryConservative } from "@/scripts/tv/motion"
import {
  createShortEpgCache,
  xtreamShortEpgAvailable,
  type XtreamCreds,
  type ShortEpgCache,
  type ShortEpgNowNext,
  type Programme as ShortEpgProgramme,
} from "@/scripts/lib/short-epg.ts"
import type { NowNextSlot, Programme as NowNextProgramme } from "@/scripts/lib/now-next"

export type TvEpgSource = "short-epg" | "xmltv-now-next" | "xmltv-full"

/** Dispatched when a playlist's short-EPG endpoint is proven empty and the source switches. */
export const TV_EPG_SOURCE_CHANGED_EVENT = "xt:tv-epg-source-changed"

const SHORT_EPG_DEAD_KEY_PREFIX = "xt_short_epg_dead:"
const SHORT_EPG_DEAD_TTL_MS = 7 * 24 * 60 * 60 * 1000
// A handful of EPG-less channels (24/7, radio, VOD-as-live) in one mounted group
// must not demote a healthy provider - require a real sample and an actual ratio.
const SHORT_EPG_SAMPLE_MIN = 8
const SHORT_EPG_EMPTY_RATIO_THRESHOLD = 0.9

/** True when the provider's short-EPG endpoint was empirically empty within the last 7 days. */
export function shortEpgIsDead(playlistId: string): boolean {
  try {
    const raw = localStorage.getItem(SHORT_EPG_DEAD_KEY_PREFIX + playlistId)
    if (!raw) return false
    const markedAt = Number(raw)
    if (!Number.isFinite(markedAt)) return false
    if (Date.now() - markedAt >= SHORT_EPG_DEAD_TTL_MS) {
      localStorage.removeItem(SHORT_EPG_DEAD_KEY_PREFIX + playlistId)
      return false
    }
    return true
  } catch {
    return false
  }
}

function markShortEpgDead(playlistId: string): void {
  try {
    localStorage.setItem(SHORT_EPG_DEAD_KEY_PREFIX + playlistId, String(Date.now()))
  } catch {}
  if (typeof document !== "undefined") {
    document.dispatchEvent(
      new CustomEvent(TV_EPG_SOURCE_CHANGED_EVENT, { detail: { playlistId, source: "xmltv-now-next" } })
    )
  }
}

function clearShortEpgDead(playlistId: string): void {
  try {
    localStorage.removeItem(SHORT_EPG_DEAD_KEY_PREFIX + playlistId)
  } catch {}
}

interface ShortEpgSample {
  emptyIds: Set<string>
  nonEmptyIds: Set<string>
}

const shortEpgSamples = new Map<string, ShortEpgSample>()

function shortEpgSampleFor(playlistId: string): ShortEpgSample {
  let sample = shortEpgSamples.get(playlistId)
  if (!sample) {
    sample = { emptyIds: new Set(), nonEmptyIds: new Set() }
    shortEpgSamples.set(playlistId, sample)
  }
  return sample
}

/**
 * Tracks distinct empty vs non-empty stream ids per playlist (endpoint reachable,
 * zero listings counts as empty). Marks the playlist's short-EPG dead once at least
 * SHORT_EPG_SAMPLE_MIN distinct ids were sampled and SHORT_EPG_EMPTY_RATIO_THRESHOLD
 * of them are empty; a later non-empty result clears an existing dead marker.
 * Failures never reach here - only classified fetch successes do.
 */
export function recordShortEpgOutcome(
  playlistId: string,
  streamId: string | number,
  outcome: "empty" | "nonEmpty"
): void {
  const sample = shortEpgSampleFor(playlistId)
  const id = String(streamId)
  if (outcome === "nonEmpty") {
    sample.nonEmptyIds.add(id)
    sample.emptyIds.delete(id)
    clearShortEpgDead(playlistId)
    return
  }
  sample.emptyIds.add(id)
  sample.nonEmptyIds.delete(id)
  const totalSampled = sample.emptyIds.size + sample.nonEmptyIds.size
  if (totalSampled < SHORT_EPG_SAMPLE_MIN) return
  const emptyRatio = sample.emptyIds.size / totalSampled
  if (emptyRatio >= SHORT_EPG_EMPTY_RATIO_THRESHOLD && !shortEpgIsDead(playlistId)) {
    shortEpgSamples.delete(playlistId)
    markShortEpgDead(playlistId)
  }
}

/** Full XMLTV off the lite tier; the per-channel Xtream client on it when available, else XMLTV now-next. */
export function tvEpgSource(creds: XtreamCreds | null | undefined): TvEpgSource {
  if (!memoryConservative()) return "xmltv-full"
  if (!xtreamShortEpgAvailable(creds)) return "xmltv-now-next"
  if (creds?.entryId && shortEpgIsDead(creds.entryId)) return "xmltv-now-next"
  return "short-epg"
}

export function toXtreamCreds(
  playlistId: string,
  creds: { host: string; port?: string; user: string; pass: string }
): XtreamCreds {
  return { host: creds.host, port: creds.port, user: creds.user, pass: creds.pass, entryId: playlistId }
}

const rawCache = createShortEpgCache()

function classifyNowNext(result: ShortEpgNowNext): "empty" | "nonEmpty" {
  return result.current || result.next ? "nonEmpty" : "empty"
}

function classifyProgrammes(result: ShortEpgProgramme[]): "empty" | "nonEmpty" {
  return result.length ? "nonEmpty" : "empty"
}

const cache: ShortEpgCache = {
  async getNowNext(creds, streamId) {
    const result = await rawCache.getNowNext(creds, streamId)
    if (result && creds.entryId) recordShortEpgOutcome(creds.entryId, streamId, classifyNowNext(result))
    return result
  },
  async getProgrammes(creds, streamId) {
    const result = await rawCache.getProgrammes(creds, streamId)
    if (result && creds.entryId) recordShortEpgOutcome(creds.entryId, streamId, classifyProgrammes(result))
    return result
  },
  clear() {
    rawCache.clear()
  },
}

/** Shared across every TV view/OSD instance so a channel's rows/guide/hero share one fetch. */
export function tvShortEpgCache(): ShortEpgCache {
  return cache
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:active-changed", () => cache.clear())
}

/** Maps a short-EPG now/next payload into the shared NowNextSlot shape rows/guide/OSD render. */
export function shortEpgNowNextSlot(nowNext: ShortEpgNowNext | null, nowMs: number = Date.now()): NowNextSlot {
  const current = nowNext?.current ?? null
  const span = current ? current.stop - current.start : 0
  return {
    current: current
      ? {
          title: current.title,
          start: current.start,
          stop: current.stop,
          progress: span > 0 ? Math.max(0, Math.min(1, (nowMs - current.start) / span)) : 0,
        }
      : null,
    next: nowNext?.next ? { title: nowNext.next.title, start: nowNext.next.start, stop: nowNext.next.stop } : null,
  }
}

/** Maps short-EPG full-timeline rows into the now-next.ts Programme shape the guide panel renders. */
export function shortEpgToGuideProgrammes(rows: ShortEpgProgramme[]): NowNextProgramme[] {
  return rows.map((row) => ({
    start: row.start,
    stop: row.stop,
    title: row.title,
    desc: row.desc,
    rawStart: row.start,
    rawStop: row.stop,
  }))
}

/** Current/next straight off an already-fetched programme list - short-EPG has no tvgId map to key off. */
export function nowNextFromProgrammes(rows: NowNextProgramme[], nowMs: number = Date.now()): NowNextSlot {
  let current: NowNextProgramme | null = null
  let next: NowNextProgramme | null = null
  for (const programme of rows) {
    if (programme.start <= nowMs && nowMs < programme.stop) current = programme
    else if (programme.start > nowMs && (!next || programme.start < next.start)) next = programme
  }
  const span = current ? current.stop - current.start : 0
  return {
    current: current
      ? {
          title: current.title,
          start: current.start,
          stop: current.stop,
          progress: span > 0 ? Math.max(0, Math.min(1, (nowMs - current.start) / span)) : 0,
        }
      : null,
    next: next ? { title: next.title, start: next.start, stop: next.stop } : null,
  }
}
