// Pure now/next programme math shared by the classic Live TV row and the TV guide panel.
import { getNowNextForChannel } from "@/scripts/lib/epg-data.js"

export interface Programme {
  start: number
  stop: number
  title: string
  desc?: string
  catchupId?: string
  rawStart?: number
  rawStop?: number
}

export interface NowNextChannel {
  id: number | string
  name?: string
  tvgId?: string | null
  tvgShift?: number | null
}

export interface NowNextSlot {
  current: { title: string; start: number; stop: number; progress: number } | null
  next: { title: string; start: number; stop: number } | null
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function computeNowNext(
  programmes: Map<string, Programme[]> | null,
  channel: NowNextChannel | null | undefined,
  playlistId: string,
  nowMs: number = Date.now()
): NowNextSlot {
  if (!programmes || !channel) return { current: null, next: null }
  const { current, next } = getNowNextForChannel(programmes, channel, playlistId, nowMs)
  const span = current ? current.stop - current.start : 0
  return {
    current: current
      ? {
          title: current.title,
          start: current.start,
          stop: current.stop,
          progress: span > 0 ? clampProgress((nowMs - current.start) / span) : 0,
        }
      : null,
    next: next ? { title: next.title, start: next.start, stop: next.stop } : null,
  }
}

export function formatTimeRange(startMs: number, stopMs: number, locale?: string): string {
  try {
    const formatter = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })
    return `${formatter.format(startMs)}–${formatter.format(stopMs)}`
  } catch {
    return ""
  }
}

/** Programmes overlapping the local [dayStartMs, dayStartMs + 24h) window, sorted by start. */
export function programmesForDay(programmes: Programme[] | undefined, dayStartMs: number): Programme[] {
  if (!programmes || !programmes.length) return []
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000
  return programmes
    .filter((programme) => programme.stop > dayStartMs && programme.start < dayEndMs)
    .sort((first, second) => first.start - second.start)
}
