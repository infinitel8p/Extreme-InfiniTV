import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { attachStallWatchdog } from "@/scripts/lib/stall-watchdog.ts"
import type { StallWatchableVideo, StallWatchableTimeRanges } from "@/scripts/lib/stall-watchdog.ts"

function makeBuffered(ranges: Array<[number, number]>): StallWatchableTimeRanges {
  return {
    length: ranges.length,
    start(index: number) {
      return ranges[index][0]
    },
    end(index: number) {
      return ranges[index][1]
    },
  }
}

interface FakeVideo extends StallWatchableVideo {
  currentTime: number
  paused: boolean
  ended: boolean
  seeking: boolean
  buffered: StallWatchableTimeRanges
  readyState: number
}

function createFakeVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  const listeners = new Map<string, Set<() => void>>()
  return {
    currentTime: 0,
    paused: false,
    ended: false,
    seeking: false,
    buffered: makeBuffered([[0, 0]]),
    readyState: 4,
    ...overrides,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
  }
}

const OPTIONS_DEFAULTS = { stallTimeoutMs: 12000, checkIntervalMs: 3000, maxAttempts: 3, progressResetMs: 30000 }

describe("attachStallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires onStall(1) after the stall timeout when playback is frozen", () => {
    const video = createFakeVideo({
      currentTime: 10,
      buffered: makeBuffered([[0, 10]]),
      readyState: 2,
    })
    const onStall = vi.fn()
    const detach = attachStallWatchdog(video, { ...OPTIONS_DEFAULTS, onStall })

    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)

    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall).toHaveBeenCalledWith(1)
    detach()
  })

  it("never stalls while the video is paused", () => {
    const video = createFakeVideo({
      currentTime: 10,
      buffered: makeBuffered([[0, 10]]),
      readyState: 2,
      paused: true,
    })
    const onStall = vi.fn()
    const detach = attachStallWatchdog(video, { ...OPTIONS_DEFAULTS, onStall })

    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs * 5)

    expect(onStall).not.toHaveBeenCalled()
    detach()
  })

  it("never stalls while currentTime keeps advancing", () => {
    const video = createFakeVideo({
      currentTime: 0,
      buffered: makeBuffered([[0, 100]]),
      readyState: 4,
    })
    const onStall = vi.fn()
    const detach = attachStallWatchdog(video, { ...OPTIONS_DEFAULTS, onStall })

    for (let tick = 0; tick < 8; tick++) {
      video.currentTime += 3
      vi.advanceTimersByTime(OPTIONS_DEFAULTS.checkIntervalMs)
    }

    expect(onStall).not.toHaveBeenCalled()
    detach()
  })

  it("escalates attempts 1, 2, 3 and then goes dormant", () => {
    const video = createFakeVideo({
      currentTime: 10,
      buffered: makeBuffered([[0, 10]]),
      readyState: 2,
    })
    const onStall = vi.fn()
    const detach = attachStallWatchdog(video, { ...OPTIONS_DEFAULTS, onStall })

    // Four consecutive stall periods: the fourth must not produce a 4th call.
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)

    expect(onStall.mock.calls).toEqual([[1], [2], [3]])
    detach()
  })

  it("resets the attempt counter after a sustained healthy-progress window", () => {
    const video = createFakeVideo({
      currentTime: 10,
      buffered: makeBuffered([[0, 10]]),
      readyState: 2,
    })
    const onStall = vi.fn()
    const detach = attachStallWatchdog(video, { ...OPTIONS_DEFAULTS, onStall })

    // One stall period -> attempt 1.
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)
    expect(onStall.mock.calls).toEqual([[1]])

    // Sustained healthy progress for progressResetMs should forgive it.
    const healthyTicks = OPTIONS_DEFAULTS.progressResetMs / OPTIONS_DEFAULTS.checkIntervalMs
    video.buffered = makeBuffered([[0, 1000]])
    for (let tick = 0; tick < healthyTicks; tick++) {
      video.currentTime += 1
      vi.advanceTimersByTime(OPTIONS_DEFAULTS.checkIntervalMs)
    }

    // Freeze again: a fresh stall should report attempt 1 again, not 2.
    video.buffered = makeBuffered([[0, video.currentTime]])
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)

    expect(onStall.mock.calls).toEqual([[1], [1]])
    detach()
  })

  it("stops ticking and removing listeners once detached", () => {
    const video = createFakeVideo({
      currentTime: 10,
      buffered: makeBuffered([[0, 10]]),
      readyState: 2,
    })
    const onStall = vi.fn()
    const detach = attachStallWatchdog(video, { ...OPTIONS_DEFAULTS, onStall })

    detach()
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs * 5)

    expect(onStall).not.toHaveBeenCalled()
  })

  it("never stalls while isSuspended reports a caller-driven recovery in flight", () => {
    const video = createFakeVideo({
      currentTime: 10,
      buffered: makeBuffered([[0, 10]]),
      readyState: 2,
    })
    const onStall = vi.fn()
    let suspended = true
    const detach = attachStallWatchdog(video, {
      ...OPTIONS_DEFAULTS,
      onStall,
      isSuspended: () => suspended,
    })

    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs * 5)
    expect(onStall).not.toHaveBeenCalled()

    suspended = false
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs)
    expect(onStall).toHaveBeenCalledTimes(1)
    detach()
  })

  it("resetStallClock() re-baselines progress so a caller's own recovery latency isn't counted", () => {
    const video = createFakeVideo({
      currentTime: 10,
      buffered: makeBuffered([[0, 10]]),
      readyState: 2,
    })
    const onStall = vi.fn()
    const detach = attachStallWatchdog(video, { ...OPTIONS_DEFAULTS, onStall })

    // Near-stall, then the caller's recovery resets the clock.
    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs - OPTIONS_DEFAULTS.checkIntervalMs)
    detach.resetStallClock()

    vi.advanceTimersByTime(OPTIONS_DEFAULTS.stallTimeoutMs - OPTIONS_DEFAULTS.checkIntervalMs)
    expect(onStall).not.toHaveBeenCalled()

    vi.advanceTimersByTime(OPTIONS_DEFAULTS.checkIntervalMs)
    expect(onStall).toHaveBeenCalledTimes(1)
    detach()
  })
})
