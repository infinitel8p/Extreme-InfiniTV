// Audio/subtitle track-memory restore + persist wiring for the native receiver engine (VOD only).
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { CastDescriptorV1 } from "../src/scripts/lib/tv-cast-descriptor"
import type {
  ReceiverEngine,
  ReceiverEngineCallbacks,
  ReceiverPlayOptions,
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

const fakeDocument = new FakeDocument()
const launchVodCalls: Array<{ tracks: { audioLang: string | null; subLang: string | null; subOff: boolean } }> = []

let createAndroidNativeReceiverEngine: (callbacks: ReceiverEngineCallbacks) => ReceiverEngine
let getTrackPrefs: (playlistId: string, kind: "vod" | "episode", id: string) => { audioLang: string | null; subLang: string | null; subOff: boolean } | null
let setTrackPrefs: (playlistId: string, kind: "vod" | "episode", id: string, patch: Record<string, unknown>) => void

beforeAll(async () => {
  ;(globalThis as { document?: unknown }).document = fakeDocument
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Linux; Android 11; UHD Android TV) AppleWebKit/537.36" },
    configurable: true,
  })
  ;(globalThis as { window?: unknown }).window = {
    AndroidVideo: {
      launchVod: (
        _contentKey: string,
        _url: string,
        _ua: string,
        _referer: string,
        _title: string,
        _posterUrl: string,
        _startMs: number,
        _dns: string,
        audioLang: string | null,
        subLang: string | null,
        subEnabled: boolean,
      ) => {
        launchVodCalls.push({ tracks: { audioLang, subLang, subOff: !subEnabled } })
        return true
      },
      launchLive: () => true,
      drainEvents: () => "[]",
      receiverSessionStart: () => true,
      receiverSessionEnd: () => {},
      receiverControl: () => true,
    },
  }
  ;({ createAndroidNativeReceiverEngine } = await import("../src/scripts/receiver/engines"))
  ;({ getTrackPrefs, setTrackPrefs } = await import("../src/scripts/lib/preferences.js"))
})

function vodDescriptor(): CastDescriptorV1 {
  return {
    v: 1,
    src: "http://tv.example/movie/user/pass/1.mp4",
    mime: "video/mp4",
    isLive: false,
    title: "A Movie",
  } as CastDescriptorV1
}

function liveDescriptor(): CastDescriptorV1 {
  return {
    v: 1,
    src: "http://tv.example/live/user/pass/1.m3u8",
    mime: "application/x-mpegURL",
    isLive: true,
    title: "A Channel",
  } as CastDescriptorV1
}

describe("createAndroidNativeReceiverEngine trackMemory", () => {
  let engine: ReceiverEngine

  beforeEach(() => {
    launchVodCalls.length = 0
    engine = createAndroidNativeReceiverEngine({ report: () => {}, onSessionEnded: () => {} })
  })

  it("forwards stored track prefs into the launch call", async () => {
    setTrackPrefs("p1", "vod", "9", { audioLang: "de", subLang: "en", subOff: false })
    const options: ReceiverPlayOptions = { trackMemory: { playlistId: "p1", kind: "vod", id: "9" } }
    await engine.play(vodDescriptor(), options)
    expect(launchVodCalls[0]?.tracks).toEqual({ audioLang: "de", subLang: "en", subOff: false })
  })

  it("passes null tracks when no trackMemory is given", async () => {
    await engine.play(vodDescriptor())
    expect(launchVodCalls[0]?.tracks).toEqual({ audioLang: null, subLang: null, subOff: true })
  })

  it("persists an xt:android-native-tracks event for the active VOD session", async () => {
    const options: ReceiverPlayOptions = { trackMemory: { playlistId: "p1", kind: "vod", id: "10" } }
    await engine.play(vodDescriptor(), options)
    fakeDocument.emit("xt:android-native-tracks", {
      contentKey: "receiver-vod-1",
      audioLang: "eng",
      subLang: "ger",
      subOff: false,
    })
    expect(getTrackPrefs("p1", "vod", "10")).toMatchObject({ audioLang: "en", subLang: "de", subOff: false })
  })

  it("ignores trackMemory for a live descriptor", async () => {
    const options: ReceiverPlayOptions = { trackMemory: { playlistId: "p1", kind: "vod", id: "11" } }
    await engine.play(liveDescriptor(), options)
    fakeDocument.emit("xt:android-native-tracks", {
      contentKey: "receiver-live-1",
      audioLang: "eng",
      subOff: false,
    })
    expect(getTrackPrefs("p1", "vod", "11")).toBeNull()
  })
})
