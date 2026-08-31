import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  createThrottledProgressWriter,
  siblingsToLiveContext,
  type SiblingChannelInput,
} from "@/scripts/tv/playback-progress"

describe("createThrottledProgressWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("writes on the first sample", () => {
    const write = vi.fn()
    const writer = createThrottledProgressWriter({ intervalMs: 5000, write })
    writer.observe({ state: "playing", positionSeconds: 10, durationSeconds: 100 })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(10, 100, "playing")
  })

  it("throttles routine samples within the interval", () => {
    const write = vi.fn()
    const writer = createThrottledProgressWriter({ intervalMs: 5000, write })
    writer.observe({ state: "playing", positionSeconds: 10 })
    vi.setSystemTime(2000)
    writer.observe({ state: "playing", positionSeconds: 12 })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it("writes again once the interval elapses", () => {
    const write = vi.fn()
    const writer = createThrottledProgressWriter({ intervalMs: 5000, write })
    writer.observe({ state: "playing", positionSeconds: 10 })
    vi.setSystemTime(5000)
    writer.observe({ state: "playing", positionSeconds: 20 })
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(2, 20, undefined, "playing")
  })

  it("always writes on paused, bypassing the throttle", () => {
    const write = vi.fn()
    const writer = createThrottledProgressWriter({ intervalMs: 5000, write })
    writer.observe({ state: "playing", positionSeconds: 10 })
    vi.setSystemTime(100)
    writer.observe({ state: "paused", positionSeconds: 11 })
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(2, 11, undefined, "paused")
  })

  it("always writes on ended, bypassing the throttle", () => {
    const write = vi.fn()
    const writer = createThrottledProgressWriter({ intervalMs: 5000, write })
    writer.observe({ state: "playing", positionSeconds: 10 })
    vi.setSystemTime(200)
    writer.observe({ state: "ended", positionSeconds: 99, durationSeconds: 100 })
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(2, 99, 100, "ended")
  })
})

describe("siblingsToLiveContext", () => {
  const channelA: SiblingChannelInput = { id: 1, name: "Channel A", streamUrl: "https://example/a.m3u8" }
  const channelB: SiblingChannelInput = { id: 2, name: "Channel B", streamUrl: "https://example/b.m3u8" }

  it("maps resolved channels and keeps order", () => {
    const result = siblingsToLiveContext([channelA, channelB], channelA)
    expect(result).toEqual({
      channels: [channelA, channelB],
      initialChannelId: "1",
    })
  })

  it("drops entries without a stream url", () => {
    const unresolved: SiblingChannelInput = { id: 3, name: "Channel C", streamUrl: null }
    const result = siblingsToLiveContext([channelA, unresolved, channelB], channelA)
    expect(result?.channels.map((channel) => channel.id)).toEqual([1, 2])
  })

  it("dedupes by id, keeping the first occurrence", () => {
    const duplicate: SiblingChannelInput = { id: 1, name: "Channel A (dup)", streamUrl: "https://example/a2.m3u8" }
    const result = siblingsToLiveContext([channelA, duplicate, channelB], channelA)
    expect(result?.channels).toEqual([channelA, channelB])
  })

  it("returns null when no channel resolves a stream url", () => {
    const unresolved: SiblingChannelInput = { id: 1, name: "Channel A", streamUrl: null }
    const result = siblingsToLiveContext([unresolved], unresolved)
    expect(result).toBeNull()
  })

  it("returns null when the initial channel doesn't resolve", () => {
    const initial: SiblingChannelInput = { id: 9, name: "Missing", streamUrl: null }
    const result = siblingsToLiveContext([channelA, channelB], initial)
    expect(result).toBeNull()
  })
})
