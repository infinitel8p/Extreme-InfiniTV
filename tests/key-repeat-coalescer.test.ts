import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createKeyRepeatCoalescer } from "@/scripts/lib/key-repeat-coalescer"

describe("createKeyRepeatCoalescer", () => {
  let rafCallbacks: FrameRequestCallback[]

  beforeEach(() => {
    rafCallbacks = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function flushFrame(): void {
    const callbacks = rafCallbacks
    rafCallbacks = []
    for (const cb of callbacks) cb(0)
  }

  it("applies the first push of a burst synchronously", () => {
    const applied: number[] = []
    const coalescer = createKeyRepeatCoalescer((delta) => applied.push(delta))
    coalescer.push(1)
    expect(applied).toEqual([1])
  })

  it("batches pushes that arrive before the next frame after the first push", () => {
    const applied: number[] = []
    const coalescer = createKeyRepeatCoalescer((delta) => applied.push(delta))
    coalescer.push(1)
    coalescer.push(1)
    coalescer.push(1)
    expect(applied).toEqual([1])
    flushFrame()
    expect(applied).toEqual([1, 2])
  })

  it("schedules only one frame watcher per burst", () => {
    let scheduleCount = 0
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      scheduleCount++
      rafCallbacks.push(cb)
      return scheduleCount
    })
    const coalescer = createKeyRepeatCoalescer(() => {})
    coalescer.push(1)
    coalescer.push(1)
    coalescer.push(1)
    expect(scheduleCount).toBe(1)
  })

  it("continues the burst across frames while pushes keep arriving", () => {
    const applied: number[] = []
    const coalescer = createKeyRepeatCoalescer((delta) => applied.push(delta))
    coalescer.push(1)
    expect(applied).toEqual([1])
    coalescer.push(1)
    flushFrame()
    expect(applied).toEqual([1, 1])
    coalescer.push(1)
    flushFrame()
    expect(applied).toEqual([1, 1, 1])
  })

  it("ends the burst after a frame passes with no push, so the next push applies synchronously again", () => {
    const applied: number[] = []
    const coalescer = createKeyRepeatCoalescer((delta) => applied.push(delta))
    coalescer.push(1)
    expect(applied).toEqual([1])
    flushFrame() // no push landed before this frame - burst ends
    expect(applied).toEqual([1])
    coalescer.push(2)
    expect(applied).toEqual([1, 2])
  })

  it("does not call apply when the batched pushes after the first cancel out to zero", () => {
    const applied: number[] = []
    const coalescer = createKeyRepeatCoalescer((delta) => applied.push(delta))
    coalescer.push(2)
    expect(applied).toEqual([2])
    coalescer.push(3)
    coalescer.push(-3)
    flushFrame()
    expect(applied).toEqual([2])
  })

  it("exposes the pending delta before it flushes", () => {
    const coalescer = createKeyRepeatCoalescer(() => {})
    coalescer.push(4)
    coalescer.push(-1)
    expect(coalescer.pending()).toBe(-1)
    coalescer.push(2)
    expect(coalescer.pending()).toBe(1)
  })

  it("cancel drops the pending delta and ends the burst", () => {
    const applied: number[] = []
    const coalescer = createKeyRepeatCoalescer((delta) => applied.push(delta))
    coalescer.push(5)
    coalescer.push(3)
    coalescer.cancel()
    flushFrame()
    expect(applied).toEqual([5])
    expect(coalescer.pending()).toBe(0)
    // The burst ended, so the next push applies synchronously again.
    coalescer.push(1)
    expect(applied).toEqual([5, 1])
  })

  it("flush applies the pending delta immediately instead of waiting for the frame", () => {
    const applied: number[] = []
    const coalescer = createKeyRepeatCoalescer((delta) => applied.push(delta))
    coalescer.push(1)
    coalescer.push(3)
    expect(applied).toEqual([1])
    coalescer.flush()
    expect(applied).toEqual([1, 3])
    // The already-scheduled frame watcher fires later and finds nothing pending.
    flushFrame()
    expect(applied).toEqual([1, 3])
  })
})
