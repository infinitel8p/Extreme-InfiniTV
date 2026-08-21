// Duration reporting for the native receiver engine: a zero must never stand in for "not known yet".
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
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

const fakeDocument = new FakeDocument()
const controlCalls: Array<{ action: string; positionMs: number }> = []

let createAndroidNativeReceiverEngine: (callbacks: {
  report(partial: ReceiverStatePartial): void
  onSessionEnded(): void
}) => ReceiverEngine

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
      receiverControl: (action: string, positionMs: number) => {
        controlCalls.push({ action, positionMs })
        return true
      },
      receiverVolume: () => true,
    },
  }
  // Imported after the stubs: the module reads window/navigator at load time.
  ;({ createAndroidNativeReceiverEngine } = await import("../src/scripts/receiver/engines"))
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

function progress(contentKey: string, positionMs: number, durationMs?: number): void {
  const detail: Record<string, unknown> = { contentKey, positionMs }
  if (durationMs !== undefined) detail.durationMs = durationMs
  fakeDocument.emit("xt:android-native-progress", detail)
}

describe("createAndroidNativeReceiverEngine duration reporting", () => {
  let reports: ReceiverStatePartial[]
  let engine: ReceiverEngine

  beforeEach(() => {
    const captured: ReceiverStatePartial[] = []
    reports = captured
    controlCalls.length = 0
    engine = createAndroidNativeReceiverEngine({
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
    })
  })

  afterEach(() => {
    engine.teardown()
  })

  it("carries the sender's duration on the first report", async () => {
    await engine.play(vodDescriptor({ durationSeconds: 5400 }))
    expect(reports[0]).toMatchObject({ state: "loading", durationSeconds: 5400 })
  })

  it("omits the duration while the native player has none", async () => {
    await engine.play(vodDescriptor())
    const contentKey = "receiver-vod-1"
    progress(contentKey, 12000)
    progress(contentKey, 14000, 0)
    for (const report of reports) expect(report.durationSeconds).toBeUndefined()
  })

  it("reports a native duration once known and keeps it across later reports", async () => {
    await engine.play(vodDescriptor())
    const contentKey = "receiver-vod-1"
    progress(contentKey, 2000)
    progress(contentKey, 4000, 5400000)
    progress(contentKey, 6000)
    expect(reports.at(-1)).toMatchObject({ positionSeconds: 6, durationSeconds: 5400 })

    engine.control("pause")
    expect(reports.at(-1)).toMatchObject({ state: "paused", durationSeconds: 5400 })
    engine.control("resume")
    expect(reports.at(-1)).toMatchObject({ state: "playing", durationSeconds: 5400 })
  })

  it("echoes a seek position back so a paused scrub is reflected without a progress tick", async () => {
    await engine.play(vodDescriptor({ durationSeconds: 5400 }))
    engine.control("seek", 600)
    expect(controlCalls.at(-1)).toEqual({ action: "seek", positionMs: 600000 })
    expect(reports.at(-1)).toMatchObject({ positionSeconds: 600, durationSeconds: 5400 })
  })

  it("never reports a duration for a live cast", async () => {
    await engine.play(vodDescriptor({ isLive: true, durationSeconds: 5400 }))
    engine.control("seek", 120)
    for (const report of reports) expect(report.durationSeconds).toBeUndefined()
    expect(controlCalls.some((call) => call.action === "seek")).toBe(false)
  })
})
