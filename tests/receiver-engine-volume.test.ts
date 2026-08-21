// Volume reporting for both receiver engines: every report has to carry the current level.
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
  muted(value: boolean): void {
    this.mediaEl.muted = value
  }
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

function fakeElement(): HTMLElement {
  return {
    textContent: "",
    offsetWidth: 0,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    focus: () => {},
  } as unknown as HTMLElement
}

const volumeCalls: Array<{ level: number; muted: boolean }> = []
let volumeBridgeApplies = true

const fakeDocument = new FakeDocument()

let createAndroidNativeReceiverEngine: (callbacks: {
  report(partial: ReceiverStatePartial): void
  onSessionEnded(): void
}) => ReceiverEngine
let createEmbeddedReceiverEngine: (
  dom: EmbeddedEngineDom,
  callbacks: { report(partial: ReceiverStatePartial): void; onSessionEnded(): void },
) => ReceiverEngine

beforeAll(async () => {
  ;(globalThis as { document?: unknown }).document = fakeDocument
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Linux; Android 12; BRAVIA) AppleWebKit/537.36" },
    configurable: true,
  })
  ;(globalThis as { window?: unknown }).window = {
    AndroidVideo: {
      launchVod: () => true,
      launchLive: () => true,
      drainEvents: () => "[]",
      receiverSessionStart: () => true,
      receiverSessionEnd: () => {},
      receiverControl: () => true,
      receiverVolume: (level: number, muted: boolean) => {
        volumeCalls.push({ level, muted })
        return volumeBridgeApplies
      },
    },
  }
  ;({ createAndroidNativeReceiverEngine, createEmbeddedReceiverEngine } = await import(
    "../src/scripts/receiver/engines"
  ))
})

function vodDescriptor(overrides: Partial<CastDescriptorV1> = {}): CastDescriptorV1 {
  return {
    v: 1,
    src: "http://tv.example/movie/user/pass/42.mkv",
    mime: "video/x-matroska",
    isLive: false,
    title: "Some Movie",
    ...overrides,
  } as CastDescriptorV1
}

function embeddedDom(videoEl: unknown): EmbeddedEngineDom {
  return {
    idleEl: fakeElement(),
    playerViewEl: fakeElement(),
    videoEl: videoEl as HTMLVideoElement | null,
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

describe("createAndroidNativeReceiverEngine volume reporting", () => {
  let reports: ReceiverStatePartial[]
  let engine: ReceiverEngine

  beforeEach(() => {
    const captured: ReceiverStatePartial[] = []
    reports = captured
    volumeCalls.length = 0
    volumeBridgeApplies = true
    engine = createAndroidNativeReceiverEngine({
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
    })
  })

  afterEach(() => {
    engine.teardown()
  })

  it("carries a volume on the very first report so the remote can reveal its slider", async () => {
    await engine.play(vodDescriptor())
    expect(reports[0]).toMatchObject({ state: "loading", volume: 1, muted: false })
  })

  it("keeps carrying the volume on progress ticks", async () => {
    await engine.play(vodDescriptor())
    fakeDocument.emit("xt:android-native-progress", { contentKey: "receiver-vod-1", positionMs: 4000 })
    expect(reports.at(-1)).toMatchObject({ positionSeconds: 4, volume: 1, muted: false })
  })

  it("stays silent about volume when the bridge has no volume control", async () => {
    const bridge = (globalThis as unknown as { window: { AndroidVideo: Record<string, unknown> } }).window
      .AndroidVideo
    const receiverVolume = bridge.receiverVolume
    delete bridge.receiverVolume
    const captured: ReceiverStatePartial[] = []
    const noVolumeEngine = createAndroidNativeReceiverEngine({
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
    })
    bridge.receiverVolume = receiverVolume
    await noVolumeEngine.play(vodDescriptor())
    for (const report of captured) {
      expect(report.volume).toBeUndefined()
      expect(report.muted).toBeUndefined()
    }
    noVolumeEngine.teardown()
  })

  it("reports the updated level on later reports after a volume change", async () => {
    await engine.play(vodDescriptor())
    engine.setVolume(0.25, false)
    fakeDocument.emit("xt:android-native-progress", { contentKey: "receiver-vod-1", positionMs: 6000 })
    expect(reports.at(-1)).toMatchObject({ volume: 0.25, muted: false })
    engine.control("pause")
    expect(reports.at(-1)).toMatchObject({ state: "paused", volume: 0.25 })
  })
})

describe("createEmbeddedReceiverEngine volume reporting", () => {
  let reports: ReceiverStatePartial[]
  let engine: ReceiverEngine

  beforeEach(() => {
    currentHandle = new FakeHandle()
    const captured: ReceiverStatePartial[] = []
    reports = captured
    engine = createEmbeddedReceiverEngine(embeddedDom(currentHandle.mediaEl), {
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
    })
  })

  it("carries the media element volume on the very first report", async () => {
    await engine.play(vodDescriptor())
    expect(reports[0]).toMatchObject({ state: "loading", volume: 1, muted: false })
  })

  it("keeps carrying the volume on plain state transitions", async () => {
    await engine.play(vodDescriptor())
    currentHandle.mediaEl.volume = 0.4
    currentHandle.fire("playing")
    expect(reports.at(-1)).toMatchObject({ state: "playing", volume: 0.4, muted: false })
    currentHandle.fire("pause")
    expect(reports.at(-1)).toMatchObject({ state: "paused", volume: 0.4 })
  })

  it("omits the volume when there is no media element to control", async () => {
    const captured: ReceiverStatePartial[] = []
    const noVideoEngine = createEmbeddedReceiverEngine(embeddedDom(null), {
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
    })
    await noVideoEngine.play(vodDescriptor())
    expect(captured[0].volume).toBeUndefined()
    expect(captured[0].muted).toBeUndefined()
  })
})
