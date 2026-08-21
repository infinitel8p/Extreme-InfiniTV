// Play/pause reporting for the native receiver engine: without the play-state event a live cast never leaves "playing".
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { CastDescriptorV1 } from "../src/scripts/lib/tv-cast-descriptor"
import type { ReceiverEngine, ReceiverStatePartial } from "../src/scripts/receiver/engines"

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

let createAndroidNativeReceiverEngine: (callbacks: {
  report(partial: ReceiverStatePartial): void
  onSessionEnded(): void
}) => ReceiverEngine

beforeAll(async () => {
  ;(globalThis as { document?: unknown }).document = fakeDocument
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Linux; Android 11; UHD Android TV) AppleWebKit/537.36" },
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

describe("createAndroidNativeReceiverEngine play-state reporting", () => {
  let reports: ReceiverStatePartial[]
  let engine: ReceiverEngine

  beforeEach(() => {
    const captured: ReceiverStatePartial[] = []
    reports = captured
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
