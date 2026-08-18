// VOD stall-recovery watchdog: works around macOS suspending downloads mid-play.

import { log } from "@/scripts/lib/log.js"

export interface StallWatchableTimeRanges {
  length: number
  start(index: number): number
  end(index: number): number
}

export interface StallWatchableVideo {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  readonly currentTime: number
  readonly paused: boolean
  readonly ended: boolean
  readonly seeking: boolean
  readonly buffered: StallWatchableTimeRanges
  readonly readyState: number
}

export interface StallWatchdogOptions {
  /** No-progress duration (ms) before a stall period fires `onStall`. Default 12000. */
  stallTimeoutMs?: number
  /** How often (ms) to sample playback progress. Default 3000. */
  checkIntervalMs?: number
  /** Stall periods to escalate through before going dormant. Default 3. */
  maxAttempts?: number
  /** Continuous healthy-progress duration (ms) that resets the attempt counter. Default 30000. */
  progressResetMs?: number
  /** While true, ticks are ineligible (like paused), so a caller-driven recovery is never counted as a stall. */
  isSuspended?: () => boolean
  /** Called with the 1-based attempt number each time a stall period elapses. */
  onStall: (attemptNumber: number) => void
}

export interface StallWatchdogHandle {
  (): void
  /** Clears the stall accumulator and re-baselines progress. */
  resetStallClock(): void
}

const DEFAULT_STALL_TIMEOUT_MS = 12000
const DEFAULT_CHECK_INTERVAL_MS = 3000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_PROGRESS_RESET_MS = 30000

/** Buffered end of the range containing currentTime, or currentTime itself if none. */
function bufferedAheadEnd(video: StallWatchableVideo): number {
  const buffered = video.buffered
  const currentTime = video.currentTime
  for (let index = 0; index < buffered.length; index++) {
    if (currentTime >= buffered.start(index) && currentTime <= buffered.end(index)) {
      return buffered.end(index)
    }
  }
  return currentTime
}

/** The returned handle detaches when called; `.resetStallClock()` re-baselines without detaching. */
export function attachStallWatchdog(
  videoEl: StallWatchableVideo,
  options: StallWatchdogOptions
): StallWatchdogHandle {
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const progressResetMs = options.progressResetMs ?? DEFAULT_PROGRESS_RESET_MS
  const isSuspended = options.isSuspended
  const onStall = options.onStall

  let lastCurrentTime = videoEl.currentTime
  let lastBufferedEnd = bufferedAheadEnd(videoEl)
  // Accumulated no-progress time while eligible; 0 means the stall clock isn't running.
  let stalledMs = 0
  // Accumulated continuous healthy-progress time, used to forgive past stalls.
  let healthyMs = 0
  let attemptCount = 0
  let dormant = false

  function clearStalledAccumulator(): void {
    stalledMs = 0
  }

  function resetStallClock(): void {
    clearStalledAccumulator()
    lastCurrentTime = videoEl.currentTime
    lastBufferedEnd = bufferedAheadEnd(videoEl)
  }

  function onPlaying(): void {
    clearStalledAccumulator()
  }

  function onSeeked(): void {
    clearStalledAccumulator()
  }

  function onTimeUpdate(): void {
    if (videoEl.currentTime > lastCurrentTime) clearStalledAccumulator()
  }

  videoEl.addEventListener("playing", onPlaying)
  videoEl.addEventListener("seeked", onSeeked)
  videoEl.addEventListener("timeupdate", onTimeUpdate)

  function tick(): void {
    if (dormant) return

    // Paused / ended / seeking are user-initiated (or terminal) states, not stalls.
    // A caller-reported suspension (e.g. a recovery remount in flight) is treated the same way.
    const eligible = !videoEl.paused && !videoEl.ended && !videoEl.seeking && !isSuspended?.()
    if (!eligible) {
      clearStalledAccumulator()
      healthyMs = 0
      lastCurrentTime = videoEl.currentTime
      lastBufferedEnd = bufferedAheadEnd(videoEl)
      return
    }

    const currentTime = videoEl.currentTime
    const bufferedEnd = bufferedAheadEnd(videoEl)
    const progressed = currentTime > lastCurrentTime || bufferedEnd > lastBufferedEnd
    lastCurrentTime = currentTime
    lastBufferedEnd = bufferedEnd

    if (progressed) {
      clearStalledAccumulator()
      healthyMs += checkIntervalMs
      if (healthyMs >= progressResetMs) {
        attemptCount = 0
        healthyMs = 0
      }
      return
    }

    healthyMs = 0
    // Starving: either the engine reports it doesn't have enough data, or the
    // playhead is pinned at the edge of what's buffered.
    const starving = videoEl.readyState < 3 || currentTime >= bufferedEnd
    if (!starving) return

    stalledMs += checkIntervalMs
    if (stalledMs < stallTimeoutMs) return

    stalledMs = 0
    attemptCount += 1
    if (attemptCount > maxAttempts) {
      dormant = true
      log.warn("[xt:stall-watchdog] giving up after repeated stalls", { maxAttempts })
      return
    }
    onStall(attemptCount)
  }

  const intervalId = setInterval(tick, checkIntervalMs)

  const detach = function (): void {
    clearInterval(intervalId)
    videoEl.removeEventListener("playing", onPlaying)
    videoEl.removeEventListener("seeked", onSeeked)
    videoEl.removeEventListener("timeupdate", onTimeUpdate)
  } as StallWatchdogHandle
  detach.resetStallClock = resetStallClock
  return detach
}
