// Pure timeline math for catch-up (archive) seeking. No DOM, no imports.

export const LIVE_RETURN_THRESHOLD_MS = 45_000
export const WINDOW_START_MARGIN_MS = 60_000
export const VIDEO_PLAYER_BUFFER_MS = 10_000

/** Per-mode terminating/granularity shape, ported from ffmpegdirect's stream classification. */
export interface StreamProfile {
  granularitySeconds: 1 | 60
  terminates: boolean
}

/** Minimum distance from live a seek/pause must keep, per stream profile (ffmpegdirect parity). */
export function minDistanceFromLiveMs(profile?: StreamProfile): number {
  if (!profile) return LIVE_RETURN_THRESHOLD_MS
  if (profile.terminates && profile.granularitySeconds === 60) return 115_000
  if (profile.terminates && profile.granularitySeconds === 1) return 55_000
  return VIDEO_PLAYER_BUFFER_MS
}

/** Clamp a requested seek target to the closest allowed position behind live; "live" is only the degenerate too-small-window case. */
export function clampSeekTarget(
  targetUtcMs: number,
  opts: { nowUtcMs: number; catchupWindowMs: number; profile?: StreamProfile },
): { kind: "live" } | { kind: "shifted"; targetUtcMs: number } {
  const latestUtcMs = opts.nowUtcMs - minDistanceFromLiveMs(opts.profile)
  const earliestUtcMs = opts.nowUtcMs - opts.catchupWindowMs + WINDOW_START_MARGIN_MS
  if (latestUtcMs <= earliestUtcMs) return { kind: "live" }
  return { kind: "shifted", targetUtcMs: Math.max(earliestUtcMs, Math.min(targetUtcMs, latestUtcMs)) }
}

/** Xtream timeshift mounts start on whole minutes; split target into mount start + residual seek. */
export function splitMountStart(
  targetUtcMs: number,
  granularity: "minute" | "second",
): { mountStartUtcMs: number; seekSeconds: number } {
  const granularityMs = granularity === "minute" ? 60_000 : 1000
  const mountStartUtcMs = Math.floor(targetUtcMs / granularityMs) * granularityMs
  const seekSeconds = (targetUtcMs - mountStartUtcMs) / 1000
  return { mountStartUtcMs, seekSeconds }
}

/** Port of GetGranularityCorrectionFromLive: pulls a minute-floored mount window back so it never reaches past live. */
export function adjustTargetForGranularity(targetUtcMs: number, nowUtcMs: number, granularityMs: number): number {
  if (granularityMs <= 1000) return targetUtcMs
  const mountStartUtcMs = Math.floor(targetUtcMs / granularityMs) * granularityMs
  if (mountStartUtcMs + granularityMs > nowUtcMs) {
    return targetUtcMs - (mountStartUtcMs + granularityMs - nowUtcMs + 1000)
  }
  return targetUtcMs
}

/** true when a seek this close to a previous live-anchored seek should be swallowed (ffmpegdirect m_lastSeekWasLive guard). */
export function shouldIgnoreSeek(
  distanceMs: number,
  opts: { lastSeekWasLive: boolean; profile?: StreamProfile },
): boolean {
  if (!opts.lastSeekWasLive) return false
  const absoluteDistanceMs = Math.abs(distanceMs)
  // Without a profile the 45s legacy fallback would be too aggressive here; only the 10s live buffer applies.
  const thresholdMs = opts.profile
    ? Math.max(VIDEO_PLAYER_BUFFER_MS, minDistanceFromLiveMs(opts.profile))
    : VIDEO_PLAYER_BUFFER_MS
  return absoluteDistanceMs < thresholdMs
}

/** Accumulating seek-step (mytv-android pattern); forward and backward steps both pin behind live, floor stays clamped. */
export function applySeekStep(
  pendingTargetUtcMs: number | null,
  currentAbsUtcMs: number,
  deltaMs: number,
  opts: { nowUtcMs: number; catchupWindowMs: number; profile?: StreamProfile },
): number {
  const baseUtcMs = pendingTargetUtcMs ?? currentAbsUtcMs
  let targetUtcMs = baseUtcMs + deltaMs
  targetUtcMs = Math.min(targetUtcMs, opts.nowUtcMs - minDistanceFromLiveMs(opts.profile) - 1000)
  targetUtcMs = Math.max(targetUtcMs, opts.nowUtcMs - opts.catchupWindowMs + WINDOW_START_MARGIN_MS)
  return targetUtcMs
}

export type ResumeAction = "native" | "reseek" | "live"

export const LIVE_RESUME_RETUNE_MS = 60_000

/** Resume decision for a paused mount: short or still-buffered gaps play on natively, long live pauses re-seek into archive (or retune without one), evicted in-session positions remount. */
export function resumeAction(opts: {
  pausedAbsUtcMs: number
  nowUtcMs: number
  bufferedEndAbsUtcMs: number
  wasLive: boolean
  archiveCapable: boolean
  profile?: StreamProfile
}): ResumeAction {
  const gapMs = opts.nowUtcMs - opts.pausedAbsUtcMs
  if (gapMs <= VIDEO_PLAYER_BUFFER_MS) return "native"
  if (opts.wasLive) {
    if (!opts.archiveCapable) return gapMs > LIVE_RESUME_RETUNE_MS ? "live" : "native"
    return gapMs >= minDistanceFromLiveMs(opts.profile) ? "reseek" : "native"
  }
  if (opts.pausedAbsUtcMs < opts.bufferedEndAbsUtcMs) return "native"
  return "reseek"
}

export const CATCHUP_MIN_SEGMENT_SECONDS = 5
export const CATCHUP_AUTO_ADVANCE_RESET_SECONDS = 30
export const CATCHUP_MAX_CONSECUTIVE_SHORT_ADVANCES = 3

export interface AutoAdvanceInput {
  segmentSeconds: number
  currentAbsUtcMs: number
  nowUtcMs: number
  programme: { startUtcMs: number; stopUtcMs: number } | null
  strikes: number
  profile?: StreamProfile
}

/** Decide whether a completed catch-up segment should remount into the next one or snap back to live. */
export function autoAdvanceDecision(
  input: AutoAdvanceInput,
): { action: "live" | "remount"; nextStopUtcMs?: number; strikes: number } {
  const nextStrikes = input.segmentSeconds >= CATCHUP_AUTO_ADVANCE_RESET_SECONDS ? 0 : input.strikes + 1

  // Consecutive sub-30s segments escalate to live even mid-programme, or a broken source remounts forever.
  if (nextStrikes > CATCHUP_MAX_CONSECUTIVE_SHORT_ADVANCES) {
    return { action: "live", strikes: nextStrikes }
  }

  if (input.nowUtcMs - input.currentAbsUtcMs <= minDistanceFromLiveMs(input.profile)) {
    return { action: "live", strikes: nextStrikes }
  }

  if (
    input.programme &&
    input.currentAbsUtcMs >= input.programme.startUtcMs &&
    input.currentAbsUtcMs < input.programme.stopUtcMs
  ) {
    return {
      action: "remount",
      nextStopUtcMs: Math.min(input.programme.stopUtcMs, input.nowUtcMs),
      strikes: nextStrikes,
    }
  }

  if (input.segmentSeconds < CATCHUP_MIN_SEGMENT_SECONDS) {
    return { action: "live", strikes: nextStrikes }
  }

  return { action: "remount", nextStopUtcMs: input.nowUtcMs, strikes: nextStrikes }
}
