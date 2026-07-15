import { describe, it, expect } from "vitest"
import {
  LIVE_RETURN_THRESHOLD_MS,
  WINDOW_START_MARGIN_MS,
  VIDEO_PLAYER_BUFFER_MS,
  CATCHUP_MIN_SEGMENT_SECONDS,
  CATCHUP_AUTO_ADVANCE_RESET_SECONDS,
  CATCHUP_MAX_CONSECUTIVE_SHORT_ADVANCES,
  clampSeekTarget,
  splitMountStart,
  minDistanceFromLiveMs,
  adjustTargetForGranularity,
  shouldIgnoreSeek,
  applySeekStep,
  resumeAction,
  autoAdvanceDecision,
  type StreamProfile,
} from "../src/scripts/lib/timeshift-math"

const terminatingMinuteProfile: StreamProfile = { granularitySeconds: 60, terminates: true }
const terminatingSecondProfile: StreamProfile = { granularitySeconds: 1, terminates: true }
const nonTerminatingProfile: StreamProfile = { granularitySeconds: 1, terminates: false }

describe("clampSeekTarget", () => {
  const nowUtcMs = Date.UTC(2024, 0, 2, 12, 0, 0)
  const catchupWindowMs = 7 * 86_400_000

  it("clamps a past-window target to windowStart + margin", () => {
    const targetUtcMs = nowUtcMs - catchupWindowMs - 3600_000
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({
      kind: "shifted",
      targetUtcMs: nowUtcMs - catchupWindowMs + WINDOW_START_MARGIN_MS,
    })
  })

  it("pins a future target behind live at the default threshold", () => {
    const result = clampSeekTarget(nowUtcMs + 60_000, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({ kind: "shifted", targetUtcMs: nowUtcMs - LIVE_RETURN_THRESHOLD_MS })
  })

  it("pins a target within the live threshold to the closest allowed position behind live", () => {
    const result = clampSeekTarget(nowUtcMs - 30_000, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({ kind: "shifted", targetUtcMs: nowUtcMs - LIVE_RETURN_THRESHOLD_MS })
  })

  it("resolves a target just beyond the live threshold to shifted at the requested position", () => {
    const targetUtcMs = nowUtcMs - (LIVE_RETURN_THRESHOLD_MS + 1000)
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs })
    expect(result).toEqual({ kind: "shifted", targetUtcMs })
  })

  it("pins to 10s behind live for a non-terminating profile", () => {
    const result = clampSeekTarget(nowUtcMs - 5000, { nowUtcMs, catchupWindowMs, profile: nonTerminatingProfile })
    expect(result).toEqual({ kind: "shifted", targetUtcMs: nowUtcMs - VIDEO_PLAYER_BUFFER_MS })
  })

  it("pins to 55s behind live for a terminating second-granularity profile", () => {
    const result = clampSeekTarget(nowUtcMs - 10_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: terminatingSecondProfile,
    })
    expect(result).toEqual({ kind: "shifted", targetUtcMs: nowUtcMs - 55_000 })
  })

  it("pins to 115s behind live for a terminating minute-granularity profile", () => {
    const result = clampSeekTarget(nowUtcMs - 10_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: terminatingMinuteProfile,
    })
    expect(result).toEqual({ kind: "shifted", targetUtcMs: nowUtcMs - 115_000 })
  })

  it("resolves a degenerate too-small catchup window to live", () => {
    const result = clampSeekTarget(nowUtcMs - 20_000, {
      nowUtcMs,
      catchupWindowMs: WINDOW_START_MARGIN_MS,
      profile: nonTerminatingProfile,
    })
    expect(result).toEqual({ kind: "live" })
  })

  it("still applies the floor clamp when the target is far behind the archive window start", () => {
    const targetUtcMs = nowUtcMs - catchupWindowMs - 3600_000
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs, profile: terminatingMinuteProfile })
    expect(result).toEqual({ kind: "shifted", targetUtcMs: nowUtcMs - catchupWindowMs + WINDOW_START_MARGIN_MS })
  })
})

describe("splitMountStart", () => {
  it("floors to the minute and returns the residual seek for minute granularity", () => {
    const targetUtcMs = Date.UTC(2024, 0, 1, 10, 7, 43)
    const result = splitMountStart(targetUtcMs, "minute")
    expect(result.mountStartUtcMs).toBe(Date.UTC(2024, 0, 1, 10, 7, 0))
    expect(result.seekSeconds).toBe(43)
  })

  it("returns zero residual for second granularity", () => {
    const targetUtcMs = Date.UTC(2024, 0, 1, 10, 7, 43)
    const result = splitMountStart(targetUtcMs, "second")
    expect(result.mountStartUtcMs).toBe(targetUtcMs)
    expect(result.seekSeconds).toBe(0)
  })

  it("keeps the Xtream flooring math in lockstep with the resolver", () => {
    const targetUtcMs = Date.UTC(2024, 0, 1, 10, 7, 43)
    const expectedMountStartUtcMs = Math.floor(targetUtcMs / 60_000) * 60_000
    expect(splitMountStart(targetUtcMs, "minute").mountStartUtcMs).toBe(expectedMountStartUtcMs)
  })
})

describe("minDistanceFromLiveMs", () => {
  it("falls back to the legacy 45s threshold with no profile", () => {
    expect(minDistanceFromLiveMs()).toBe(LIVE_RETURN_THRESHOLD_MS)
    expect(minDistanceFromLiveMs(undefined)).toBe(45_000)
  })

  it("uses 115s for a terminating minute-granularity stream", () => {
    expect(minDistanceFromLiveMs(terminatingMinuteProfile)).toBe(115_000)
  })

  it("uses 55s for a terminating second-granularity stream", () => {
    expect(minDistanceFromLiveMs(terminatingSecondProfile)).toBe(55_000)
  })

  it("uses the 10s video-player buffer for a non-terminating stream", () => {
    expect(minDistanceFromLiveMs(nonTerminatingProfile)).toBe(VIDEO_PLAYER_BUFFER_MS)
    expect(minDistanceFromLiveMs({ granularitySeconds: 60, terminates: false })).toBe(VIDEO_PLAYER_BUFFER_MS)
  })
})

describe("clampSeekTarget with a stream profile", () => {
  const nowUtcMs = Date.UTC(2024, 0, 2, 12, 0, 0)
  const catchupWindowMs = 7 * 86_400_000

  it("pins a target 60s behind now to 115s behind live for a terminating minute stream", () => {
    const result = clampSeekTarget(nowUtcMs - 60_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: terminatingMinuteProfile,
    })
    expect(result).toEqual({ kind: "shifted", targetUtcMs: nowUtcMs - 115_000 })
  })

  it("resolves a target 120s behind now to shifted at the requested position for a terminating minute stream", () => {
    const targetUtcMs = nowUtcMs - 120_000
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs, profile: terminatingMinuteProfile })
    expect(result).toEqual({ kind: "shifted", targetUtcMs })
  })

  it("resolves a target 30s behind now to shifted at the requested position for a non-terminating stream", () => {
    const targetUtcMs = nowUtcMs - 30_000
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs, profile: nonTerminatingProfile })
    expect(result).toEqual({ kind: "shifted", targetUtcMs })
  })
})

describe("adjustTargetForGranularity", () => {
  it("pulls a minute-floored target back so the mount window never reaches past live", () => {
    const nowUtcMs = Date.UTC(2024, 0, 1, 10, 7, 30)
    const targetUtcMs = nowUtcMs - 30_000
    const adjustedUtcMs = adjustTargetForGranularity(targetUtcMs, nowUtcMs, 60_000)
    const mountStartUtcMs = Math.floor(adjustedUtcMs / 60_000) * 60_000
    expect(mountStartUtcMs + 60_000).toBeLessThanOrEqual(nowUtcMs)
    expect(adjustedUtcMs).toBeLessThan(targetUtcMs)
  })

  it("leaves a target well within the granularity window unchanged", () => {
    const nowUtcMs = Date.UTC(2024, 0, 1, 10, 7, 30)
    const targetUtcMs = nowUtcMs - 5 * 60_000
    expect(adjustTargetForGranularity(targetUtcMs, nowUtcMs, 60_000)).toBe(targetUtcMs)
  })

  it("leaves the target unchanged for a granularity at or below the 1s guard", () => {
    const nowUtcMs = Date.UTC(2024, 0, 1, 10, 7, 30)
    const targetUtcMs = nowUtcMs - 500
    expect(adjustTargetForGranularity(targetUtcMs, nowUtcMs, 1000)).toBe(targetUtcMs)
  })
})

describe("shouldIgnoreSeek", () => {
  it("never ignores a seek when the last seek wasn't live-anchored", () => {
    expect(shouldIgnoreSeek(1000, { lastSeekWasLive: false })).toBe(false)
    expect(shouldIgnoreSeek(200_000, { lastSeekWasLive: false, profile: terminatingMinuteProfile })).toBe(false)
  })

  it("ignores anything under the 10s video-player buffer regardless of profile", () => {
    expect(shouldIgnoreSeek(9000, { lastSeekWasLive: true })).toBe(true)
    expect(shouldIgnoreSeek(-9000, { lastSeekWasLive: true, profile: terminatingMinuteProfile })).toBe(true)
  })

  it("ignores up to 55s for a terminating second-granularity stream", () => {
    expect(shouldIgnoreSeek(54_000, { lastSeekWasLive: true, profile: terminatingSecondProfile })).toBe(true)
    expect(shouldIgnoreSeek(56_000, { lastSeekWasLive: true, profile: terminatingSecondProfile })).toBe(false)
  })

  it("ignores up to 115s for a terminating minute-granularity stream", () => {
    expect(shouldIgnoreSeek(114_000, { lastSeekWasLive: true, profile: terminatingMinuteProfile })).toBe(true)
    expect(shouldIgnoreSeek(116_000, { lastSeekWasLive: true, profile: terminatingMinuteProfile })).toBe(false)
  })

  it("only applies the 10s buffer for a non-terminating stream beyond that", () => {
    expect(shouldIgnoreSeek(20_000, { lastSeekWasLive: true, profile: nonTerminatingProfile })).toBe(false)
  })
})

describe("applySeekStep", () => {
  const nowUtcMs = Date.UTC(2024, 0, 2, 12, 0, 0)
  const catchupWindowMs = 7 * 86_400_000

  it("lands 116s behind live on a first -10s press against the Xtream profile", () => {
    const targetUtcMs = applySeekStep(null, nowUtcMs, -10_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: terminatingMinuteProfile,
    })
    expect(targetUtcMs).toBe(nowUtcMs - 116_000)
  })

  it("lands 11s behind live on a first -10s press with a non-terminating profile", () => {
    const targetUtcMs = applySeekStep(null, nowUtcMs, -10_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: nonTerminatingProfile,
    })
    expect(targetUtcMs).toBe(nowUtcMs - 11_000)
  })

  it("lands a single rewind press somewhere clampSeekTarget accepts as shifted, not live", () => {
    const targetUtcMs = applySeekStep(null, nowUtcMs, -10_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: terminatingMinuteProfile,
    })
    const result = clampSeekTarget(targetUtcMs, { nowUtcMs, catchupWindowMs, profile: terminatingMinuteProfile })
    expect(result).toEqual({ kind: "shifted", targetUtcMs })
  })

  it("accumulates a further -10s from the pending target on a second press", () => {
    const firstUtcMs = applySeekStep(null, nowUtcMs, -10_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: nonTerminatingProfile,
    })
    const secondUtcMs = applySeekStep(firstUtcMs, nowUtcMs, -10_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: nonTerminatingProfile,
    })
    expect(secondUtcMs).toBe(firstUtcMs - 10_000)
  })

  it("pins a forward step behind live at the default threshold, not at now", () => {
    const targetUtcMs = applySeekStep(nowUtcMs - 5000, nowUtcMs, 60_000, { nowUtcMs, catchupWindowMs })
    expect(targetUtcMs).toBe(nowUtcMs - LIVE_RETURN_THRESHOLD_MS - 1000)
  })

  it("pins a forward step behind live using the profile-derived threshold", () => {
    const targetUtcMs = applySeekStep(nowUtcMs - 200_000, nowUtcMs, 190_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: nonTerminatingProfile,
    })
    expect(targetUtcMs).toBe(nowUtcMs - VIDEO_PLAYER_BUFFER_MS - 1000)
  })

  it("clamps at the catchup window floor plus the start margin", () => {
    const targetUtcMs = applySeekStep(nowUtcMs - catchupWindowMs, nowUtcMs, -3_600_000, {
      nowUtcMs,
      catchupWindowMs,
    })
    expect(targetUtcMs).toBe(nowUtcMs - catchupWindowMs + WINDOW_START_MARGIN_MS)
  })

  it("lands 10 minutes behind live on a -10min press, beyond the minimum distance so no clamp applies", () => {
    const targetUtcMs = applySeekStep(null, nowUtcMs, -600_000, {
      nowUtcMs,
      catchupWindowMs,
      profile: terminatingMinuteProfile,
    })
    expect(targetUtcMs).toBe(nowUtcMs - 600_000)
  })
})

describe("resumeAction", () => {
  const nowUtcMs = Date.UTC(2024, 0, 2, 12, 0, 0)

  it("stays native for a short pause gap regardless of session state", () => {
    expect(
      resumeAction({
        pausedAbsUtcMs: nowUtcMs - 5000,
        nowUtcMs,
        bufferedEndAbsUtcMs: nowUtcMs - 20_000,
        wasLive: true,
        archiveCapable: true,
      }),
    ).toBe("native")
  })

  it("stays native for a live archive-capable gap under the profile's minimum distance", () => {
    expect(
      resumeAction({
        pausedAbsUtcMs: nowUtcMs - 60_000,
        nowUtcMs,
        bufferedEndAbsUtcMs: nowUtcMs - 700_000,
        wasLive: true,
        archiveCapable: true,
        profile: terminatingMinuteProfile,
      }),
    ).toBe("native")
  })

  it("reseeks (mounts a timeshift session) for a live archive-capable gap beyond the profile's minimum distance", () => {
    expect(
      resumeAction({
        pausedAbsUtcMs: nowUtcMs - 120_000,
        nowUtcMs,
        bufferedEndAbsUtcMs: nowUtcMs - 700_000,
        wasLive: true,
        archiveCapable: true,
        profile: terminatingMinuteProfile,
      }),
    ).toBe("reseek")
  })

  it("stays native for a live no-archive gap under the retune threshold", () => {
    expect(
      resumeAction({
        pausedAbsUtcMs: nowUtcMs - 30_000,
        nowUtcMs,
        bufferedEndAbsUtcMs: nowUtcMs - 700_000,
        wasLive: true,
        archiveCapable: false,
      }),
    ).toBe("native")
  })

  it("retunes to live for a live no-archive gap beyond the retune threshold", () => {
    expect(
      resumeAction({
        pausedAbsUtcMs: nowUtcMs - 90_000,
        nowUtcMs,
        bufferedEndAbsUtcMs: nowUtcMs - 700_000,
        wasLive: true,
        archiveCapable: false,
      }),
    ).toBe("live")
  })

  it("reseeks an in-session pause once the paused position has been evicted from the buffer", () => {
    const pausedAbsUtcMs = nowUtcMs - 30_000
    expect(
      resumeAction({
        pausedAbsUtcMs,
        nowUtcMs,
        bufferedEndAbsUtcMs: pausedAbsUtcMs,
        wasLive: false,
        archiveCapable: true,
      }),
    ).toBe("reseek")
  })

  it("stays native for an in-session pause the buffer still covers", () => {
    expect(
      resumeAction({
        pausedAbsUtcMs: nowUtcMs - 30_000,
        nowUtcMs,
        bufferedEndAbsUtcMs: nowUtcMs - 10_000,
        wasLive: false,
        archiveCapable: true,
      }),
    ).toBe("native")
  })
})

describe("autoAdvanceDecision", () => {
  const nowUtcMs = Date.UTC(2024, 0, 2, 12, 0, 0)

  it("snaps to live for a degenerate segment once the strike limit is exceeded", () => {
    const result = autoAdvanceDecision({
      segmentSeconds: 3,
      currentAbsUtcMs: nowUtcMs - 3600_000,
      nowUtcMs,
      programme: null,
      strikes: 3,
    })
    expect(result).toEqual({ action: "live", strikes: 4 })
  })

  it("escalates to live mid-programme once consecutive short segments exceed the strike limit", () => {
    const programme = { startUtcMs: nowUtcMs - 7200_000, stopUtcMs: nowUtcMs - 1800_000 }
    const result = autoAdvanceDecision({
      segmentSeconds: 12,
      currentAbsUtcMs: nowUtcMs - 3600_000,
      nowUtcMs,
      programme,
      strikes: 3,
    })
    expect(result).toEqual({ action: "live", strikes: 4 })
  })

  it("remounts mid-programme on a short segment, counting a strike", () => {
    const programme = { startUtcMs: nowUtcMs - 7200_000, stopUtcMs: nowUtcMs - 1800_000 }
    const result = autoAdvanceDecision({
      segmentSeconds: 3,
      currentAbsUtcMs: nowUtcMs - 3600_000,
      nowUtcMs,
      programme,
      strikes: 0,
    })
    expect(result).toEqual({
      action: "remount",
      nextStopUtcMs: Math.min(programme.stopUtcMs, nowUtcMs),
      strikes: 1,
    })
  })

  it("remounts mid-programme on a healthy segment and resets strikes", () => {
    const programme = { startUtcMs: nowUtcMs - 7200_000, stopUtcMs: nowUtcMs - 1800_000 }
    const result = autoAdvanceDecision({
      segmentSeconds: 45,
      currentAbsUtcMs: nowUtcMs - 3600_000,
      nowUtcMs,
      programme,
      strikes: 2,
    })
    expect(result).toEqual({
      action: "remount",
      nextStopUtcMs: Math.min(programme.stopUtcMs, nowUtcMs),
      strikes: 0,
    })
  })

  it("snaps to live once playback has caught up within the profile's minimum distance", () => {
    const result = autoAdvanceDecision({
      segmentSeconds: 45,
      currentAbsUtcMs: nowUtcMs - 5000,
      nowUtcMs,
      programme: null,
      strikes: 0,
      profile: nonTerminatingProfile,
    })
    expect(result).toEqual({ action: "live", strikes: 0 })
  })

  it("remounts to now with no EPG data on a healthy segment", () => {
    const result = autoAdvanceDecision({
      segmentSeconds: 45,
      currentAbsUtcMs: nowUtcMs - 3600_000,
      nowUtcMs,
      programme: null,
      strikes: 0,
    })
    expect(result).toEqual({ action: "remount", nextStopUtcMs: nowUtcMs, strikes: 0 })
  })

  it("snaps to live via the strike limit when there's no EPG data and segments stay short", () => {
    const result = autoAdvanceDecision({
      segmentSeconds: 10,
      currentAbsUtcMs: nowUtcMs - 3600_000,
      nowUtcMs,
      programme: null,
      strikes: 3,
    })
    expect(result).toEqual({ action: "live", strikes: 4 })
  })
})

describe("catch-up auto-advance tuning constants", () => {
  it("matches the ffmpegdirect-derived thresholds", () => {
    expect(CATCHUP_MIN_SEGMENT_SECONDS).toBe(5)
    expect(CATCHUP_AUTO_ADVANCE_RESET_SECONDS).toBe(30)
    expect(CATCHUP_MAX_CONSECUTIVE_SHORT_ADVANCES).toBe(3)
  })
})
