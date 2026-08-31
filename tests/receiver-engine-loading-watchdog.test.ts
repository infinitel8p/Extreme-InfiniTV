// The embedded engine's start watchdog: media-load progress buys more time, silence does not,
// and VOD gets a wider window than live because a first frame can need the whole file.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { CastDescriptorV1 } from "../src/scripts/lib/tv-cast-descriptor"
import type {
  EmbeddedEngineDom,
  ReceiverEngine,
  ReceiverStatePartial,
} from "../src/scripts/receiver/engines"

type Listener = (event: { type: string; detail?: unknown }) => void

class FakeDocument {
  private listeners = new Map<string, Listener[]>()
  addEventListener(type: string, listener: Listener): void {
    const forType = this.listeners.get(type) || []
    forType.push(listener)
    this.listeners.set(type, forType)
  }
  emit(type: string, detail: unknown): void {
    for (const listener of this.listeners.get(type) || []) listener({ type, detail })
  }
}

class FakeMediaElement {
  volume = 1
  muted = false
  currentTime = 0
  duration = Number.NaN
  paused = false
  videoWidth = 640
  videoHeight = 360
  error: unknown = null
  addEventListener(): void {}
}

class FakeHandle {
  private handlers = new Map<string, Array<() => void>>()
  mediaEl = new FakeMediaElement()
  on(type: string, handler: () => void): void {
    const forType = this.handlers.get(type) || []
    forType.push(handler)
    this.handlers.set(type, forType)
  }
  fire(type: string): void {
    for (const handler of this.handlers.get(type) || []) handler()
  }
  src(): void {}
  pause(): void {}
  reset(): void {}
  duration(): number {
    return 0
  }
  currentTime(): void {}
  muted(): void {}
  getMediaElement(): FakeMediaElement {
    return this.mediaEl
  }
  codecInfo(): { videoCodec: null; audioCodec: null; errorDetail: null } {
    return { videoCodec: null, audioCodec: null, errorDetail: null }
  }
}

let currentHandle = new FakeHandle()

vi.mock("@/scripts/lib/player-runtime", () => ({
  mountPlayer: async () => ({ kind: "embedded", handle: currentHandle }),
  playWhenReady: () => {},
}))

vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key }))

vi.mock("@/scripts/lib/manifest-probe.js", () => ({
  probeManifestSource: async () => "inconclusive",
  messageKeyForProbeVerdict: () => null,
}))

function fakeElement(): HTMLElement {
  return {
    textContent: "",
    offsetWidth: 0,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    focus: () => {},
  } as unknown as HTMLElement
}

function embeddedDom(): EmbeddedEngineDom {
  return {
    idleEl: fakeElement(),
    playerViewEl: fakeElement(),
    videoEl: currentHandle.mediaEl as unknown as HTMLVideoElement,
    titleWrapEl: fakeElement(),
    titleEl: fakeElement(),
    loadingEl: fakeElement(),
    loadingTitleEl: fakeElement(),
    pausedEl: fakeElement(),
    errorEl: fakeElement(),
    errorMessageEl: fakeElement(),
    errorCountdownEl: fakeElement(),
    errorRetryEl: fakeElement(),
  }
}

const fakeDocument = new FakeDocument()

let createEmbeddedReceiverEngine: (
  dom: EmbeddedEngineDom,
  callbacks: { report(partial: ReceiverStatePartial): void; onSessionEnded(): void },
) => ReceiverEngine

beforeAll(async () => {
  ;(globalThis as { document?: unknown }).document = fakeDocument
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    configurable: true,
  })
  ;(globalThis as { window?: unknown }).window = {}
  ;(globalThis as { MediaError?: unknown }).MediaError = {
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_NETWORK: 2,
  }
  ;({ createEmbeddedReceiverEngine } = await import("../src/scripts/receiver/engines"))
})

function descriptor(isLive: boolean): CastDescriptorV1 {
  return {
    v: 1,
    src: isLive ? "http://tv.example/live/user/pass/9.m3u8" : "http://tv.example/movie/user/pass/9.mp4",
    mime: isLive ? "application/x-mpegURL" : "video/mp4",
    isLive,
    title: isLive ? "Some Channel" : "Some Movie",
  } as CastDescriptorV1
}

describe("embedded receiver engine start watchdog", () => {
  let reports: ReceiverStatePartial[]
  let engine: ReceiverEngine

  const states = () => reports.map((report) => report.state)

  async function startPlayback(isLive: boolean): Promise<void> {
    await engine.play(descriptor(isLive))
    // The first "waiting" is how a real element announces it has no data yet.
    currentHandle.fire("waiting")
  }

  beforeEach(() => {
    vi.useFakeTimers()
    currentHandle = new FakeHandle()
    reports = []
    engine = createEmbeddedReceiverEngine(embeddedDom(), {
      report: (partial) => reports.push(partial),
      onSessionEnded: () => {},
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fails a silent VOD start only after the wider VOD window", async () => {
    await startPlayback(false)
    await vi.advanceTimersByTimeAsync(60000)
    expect(states()).not.toContain("error")
    await vi.advanceTimersByTimeAsync(31000)
    expect(states()).toContain("error")
  })

  it("fails a silent live start after the live window", async () => {
    await startPlayback(true)
    await vi.advanceTimersByTimeAsync(31000)
    expect(states()).toContain("error")
  })

  it("keeps waiting while the element still reports load progress", async () => {
    await startPlayback(false)
    for (let elapsed = 0; elapsed < 150000; elapsed += 30000) {
      await vi.advanceTimersByTimeAsync(30000)
      currentHandle.fire("progress")
    }
    expect(states()).not.toContain("error")
    await vi.advanceTimersByTimeAsync(91000)
    expect(states()).toContain("error")
  })

  it("gives up on a source that loads forever without ever playing", async () => {
    await startPlayback(false)
    for (let elapsed = 0; elapsed < 240000; elapsed += 10000) {
      await vi.advanceTimersByTimeAsync(10000)
      currentHandle.fire("progress")
    }
    expect(states()).toContain("error")
  })

  it("clears the watchdog once playback starts", async () => {
    await startPlayback(false)
    await vi.advanceTimersByTimeAsync(10000)
    currentHandle.fire("playing")
    await vi.advanceTimersByTimeAsync(200000)
    expect(states()).not.toContain("error")
  })
})
