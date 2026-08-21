// Pure catch-up timeline math + the async cast-descriptor resolver, shared by the local mount path
// in stream.ts and the "cast this catch-up" routing branch.

import { resolveCatchupSrc, type CatchupCreds, type CatchupRequestChannel } from "@/scripts/lib/catchup-resolve.ts"
import { buildCatchupCastDescriptor, type CastDescriptorV1 } from "@/scripts/lib/tv-cast-descriptor"

export function catchupMimeForKindHint(kindHint: "hls" | "ts"): string {
  return kindHint === "hls" ? "application/x-mpegURL" : "video/mp2t"
}

export interface ComputeCatchupTimelineInput {
  kind: "programme" | "timeshift"
  startUtcMs: number
  stopUtcMs: number
  effectiveStartUtcMs: number
  timelineStartUtcMs: number
  /** Whether the caller explicitly requested `timelineStartUtcMs`, as opposed to it defaulting to `startUtcMs`. */
  timelineStartUtcMsWasExplicit: boolean
  timelineStopUtcMsOverride?: number | null
  profileTerminates: boolean
  /** Only consulted when `kind === "timeshift"`; the current programme window under the requested start, from EPG. */
  timeshiftAnchorWindow?: { startUtcMs: number; stopUtcMs: number } | null
  seekSeconds: number
  nowUtcMs?: number
}

export interface CatchupTimeline {
  mountedStartUtcMs: number
  timelineStartUtcMs: number
  timelineStopUtcMs: number | null
  timelineOffsetSeconds: number
  timelineSpanSeconds: number
  initialPositionSeconds: number
}

/** Full-programme span (TiviMate-style bar) only for non-terminating streams still mid-broadcast; terminating archives keep the elapsed-so-far span. */
export function computeCatchupTimeline(input: ComputeCatchupTimelineInput): CatchupTimeline {
  const nowUtcMs = input.nowUtcMs ?? Date.now()
  const mountedStartUtcMs = input.effectiveStartUtcMs
  let timelineStartUtcMs = input.timelineStartUtcMs
  let timelineStopUtcMs = input.timelineStopUtcMsOverride ?? null

  if (timelineStopUtcMs == null && !input.profileTerminates) {
    const anchorWindow =
      input.kind === "programme"
        ? { startUtcMs: input.startUtcMs, stopUtcMs: input.stopUtcMs }
        : input.timeshiftAnchorWindow ?? null
    if (anchorWindow && anchorWindow.stopUtcMs > nowUtcMs) {
      if (!input.timelineStartUtcMsWasExplicit) timelineStartUtcMs = anchorWindow.startUtcMs
      timelineStopUtcMs = anchorWindow.stopUtcMs
    }
  }

  // Mounted stream lands at [offset, span] on the [timelineStart, stop] timeline so position/duration stay 1:1 across remounts.
  const timelineOffsetSeconds = Math.max(0, (mountedStartUtcMs - timelineStartUtcMs) / 1000)
  const timelineSpanSeconds =
    timelineStopUtcMs != null
      ? Math.max(1, Math.round((timelineStopUtcMs - timelineStartUtcMs) / 1000))
      : Math.max(1, Math.round((Math.min(input.stopUtcMs, nowUtcMs) - timelineStartUtcMs) / 1000))
  const initialPositionSeconds = Math.max(0, (input.startUtcMs - timelineStartUtcMs) / 1000 + input.seekSeconds)

  return {
    mountedStartUtcMs,
    timelineStartUtcMs,
    timelineStopUtcMs,
    timelineOffsetSeconds,
    timelineSpanSeconds,
    initialPositionSeconds,
  }
}

export interface ResolveCatchupCastDescriptorInput {
  playlistId: string
  creds: CatchupCreds
  channel: CatchupRequestChannel
  startUtcMs: number
  stopUtcMs: number
  catchupId?: string | null
  kind?: "programme" | "timeshift"
  timelineStartUtcMs?: number | null
  timelineStopUtcMs?: number | null
  timeshiftAnchorWindow?: { startUtcMs: number; stopUtcMs: number } | null
  seekSeconds?: number
  title: string
  logo?: string | null
  headers?: CastDescriptorV1["headers"]
}

/** Resolves a catch-up src for `channel`'s programme window and builds the matching cast descriptor, or null when resolution fails. */
export async function resolveCatchupCastDescriptor(
  input: ResolveCatchupCastDescriptorInput,
): Promise<CastDescriptorV1 | null> {
  const resolution = await resolveCatchupSrc(input.playlistId, input.creds, {
    channel: input.channel,
    startUtcMs: input.startUtcMs,
    stopUtcMs: input.stopUtcMs,
    catchupId: input.catchupId,
  })
  if (!resolution) return null

  const kind = input.kind ?? "programme"
  const timelineStartUtcMs = input.timelineStartUtcMs ?? input.startUtcMs
  const timeline = computeCatchupTimeline({
    kind,
    startUtcMs: input.startUtcMs,
    stopUtcMs: input.stopUtcMs,
    effectiveStartUtcMs: resolution.effectiveStartUtcMs,
    timelineStartUtcMs,
    timelineStartUtcMsWasExplicit: input.timelineStartUtcMs != null,
    timelineStopUtcMsOverride: input.timelineStopUtcMs ?? null,
    profileTerminates: resolution.profile.terminates,
    timeshiftAnchorWindow: input.timeshiftAnchorWindow,
    seekSeconds: input.seekSeconds ?? 0,
  })

  return buildCatchupCastDescriptor({
    src: resolution.src,
    mime: catchupMimeForKindHint(resolution.kindHint),
    title: input.title,
    logo: input.logo ?? undefined,
    headers: input.headers,
    durationSeconds: timeline.timelineSpanSeconds,
    timelineOffsetSeconds: timeline.timelineOffsetSeconds,
    resumeSeconds: timeline.initialPositionSeconds > 0 ? timeline.initialPositionSeconds : undefined,
  })
}
