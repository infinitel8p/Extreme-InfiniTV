// Play/pause reporting for the native receiver engine: without the play-state event a live cast never leaves "playing".
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { CastDescriptorV1 } from "../src/scripts/lib/tv-cast-descriptor"
import type {
  ReceiverEngine,
  ReceiverEngineCallbacks,
  ReceiverPlayOptions,
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

vi.mock("@/scripts/lib/player-runtime", () => ({
  mountPlayer: async () => null,
  playWhenReady: () => {},
}))

const fakeDocument = new FakeDocument()
const launchLiveCalls: Array<{ contentKey: string; channels: string; initialChannelId: string }> = []

let createAndroidNativeReceiverEngine: (callbacks: ReceiverEngineCallbacks) => ReceiverEngine

beforeAll(async () => {
  ;(globalThis as { document?: unknown }).document = fakeDocument
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Linux; Android 11; UHD Android TV) AppleWebKit/537.36" },
    configurable: true,
  })
  ;(globalThis as { window?: unknown }).window = {
    AndroidVideo: {
      launchVod: () => true,
      launchLive: (contentKey: string, channels: string, initialChannelId: string) => {
        launchLiveCalls.push({ contentKey, channels, initialChannelId })
        return true
      },
      drainEvents: () => "[]",
      receiverSessionStart: () => true,
      receiverSessionEnd: () => {},
      receiverControl: () => true,
    },
  }
  ;({ createAndroidNativeReceiverEngine } = await import("../src/scripts/receiver/engines"))
})

function liveDescriptor(): CastDescriptorV1 {
  return {
    v: 1,
    src: "http://tv.example/live/user/pass/1562686.m3u8",
    mime: "application/x-mpegURL",
    isLive: true,
    title: "DE: SKY SPORT 1",
  } as CastDescriptorV1
}

function liveContextOptions(): ReceiverPlayOptions {
  return {
    liveContext: {
      channels: [
        { id: "10", name: "Channel 10", streamUrl: "http://tv.example/live/user/pass/10.m3u8" },
        { id: "20", name: "Channel 20", streamUrl: "http://tv.example/live/user/pass/20.m3u8" },
      ],
      initialChannelId: "10",
    },
  }
}

describe("createAndroidNativeReceiverEngine play-state reporting", () => {
  let reports: ReceiverStatePartial[]
  let engine: ReceiverEngine

  beforeEach(() => {
    const captured: ReceiverStatePartial[] = []
    reports = captured
    launchLiveCalls.length = 0
    engine = createAndroidNativeReceiverEngine({
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
    })
  })

  it("reports paused when the TV stops playback on its own", async () => {
    await engine.play(liveDescriptor())
    expect(reports.at(-1)).toMatchObject({ state: "playing" })
    fakeDocument.emit("xt:android-native-play-state", {
      contentKey: "receiver-live-1",
      playing: false,
      positionMs: 12_000,
    })
    expect(reports.at(-1)).toMatchObject({ state: "paused", positionSeconds: 12 })
  })

  it("reports playing again when playback resumes", async () => {
    await engine.play(liveDescriptor())
    fakeDocument.emit("xt:android-native-play-state", {
      contentKey: "receiver-live-1",
      playing: false,
      positionMs: 0,
    })
    fakeDocument.emit("xt:android-native-play-state", {
      contentKey: "receiver-live-1",
      playing: true,
      positionMs: 0,
    })
    expect(reports.at(-1)).toMatchObject({ state: "playing" })
  })

  it("ignores a play-state event from a superseded session", async () => {
    await engine.play(liveDescriptor())
    const beforeCount = reports.length
    fakeDocument.emit("xt:android-native-play-state", {
      contentKey: "receiver-live-99",
      playing: false,
      positionMs: 0,
    })
    expect(reports.length).toBe(beforeCount)
  })
})

describe("createAndroidNativeReceiverEngine liveContext", () => {
  let reports: ReceiverStatePartial[]
  let channelChanges: Array<{ channelId: string; channelName: string }>
  let finishedChannelIds: Array<string | null>
  let engine: ReceiverEngine

  beforeEach(() => {
    const captured: ReceiverStatePartial[] = []
    const capturedChanges: Array<{ channelId: string; channelName: string }> = []
    const capturedFinished: Array<string | null> = []
    reports = captured
    channelChanges = capturedChanges
    finishedChannelIds = capturedFinished
    launchLiveCalls.length = 0
    engine = createAndroidNativeReceiverEngine({
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
      onLiveChannelChanged: (channelId, channelName) => capturedChanges.push({ channelId, channelName }),
      onFinished: (finalChannelId) => capturedFinished.push(finalChannelId),
    })
  })

  it("passes the channel list and initial channel through to launchLive", async () => {
    await engine.play(liveDescriptor(), liveContextOptions())
    expect(launchLiveCalls).toHaveLength(1)
    expect(launchLiveCalls[0].initialChannelId).toBe("10")
    expect(JSON.parse(launchLiveCalls[0].channels)).toMatchObject([
      { id: "10", streamUrl: "http://tv.example/live/user/pass/10.m3u8" },
      { id: "20", streamUrl: "http://tv.example/live/user/pass/20.m3u8" },
    ])
  })

  it("accepts a live:<id> error for a channel present in the live context", async () => {
    await engine.play(liveDescriptor(), liveContextOptions())
    fakeDocument.emit("xt:android-native-error", { contentKey: "live:20", code: "ERROR_CODE_DECODING_FAILED" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports.some((report) => report.state === "error")).toBe(true)
  })

  it("drops a live:<id> error for a channel not in the live context", async () => {
    await engine.play(liveDescriptor(), liveContextOptions())
    const beforeCount = reports.length
    fakeDocument.emit("xt:android-native-error", { contentKey: "live:other", code: "ERROR_CODE_DECODING_FAILED" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports.length).toBe(beforeCount)
  })

  it("fires onLiveChannelChanged for a channel-changed event on the current session", async () => {
    await engine.play(liveDescriptor(), liveContextOptions())
    fakeDocument.emit("xt:android-native-channel-changed", { channelId: "20", channelName: "Channel 20" })
    expect(channelChanges).toEqual([{ channelId: "20", channelName: "Channel 20" }])
  })

  it("passes the final channel id to onFinished", async () => {
    await engine.play(liveDescriptor(), liveContextOptions())
    fakeDocument.emit("xt:android-native-finished", { completed: false, finalChannelId: "20" })
    expect(finishedChannelIds).toEqual(["20"])
  })

  it("reports a null final channel id when the native side omits it", async () => {
    await engine.play(liveDescriptor())
    fakeDocument.emit("xt:android-native-finished", { completed: true, contentKey: "receiver-live-1" })
    expect(finishedChannelIds).toEqual([null])
  })
})
