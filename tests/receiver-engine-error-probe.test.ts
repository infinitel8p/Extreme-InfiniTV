// A provider refusal reaches ExoPlayer as a malformed manifest, so the engine probes the source
// before blaming the TV's file-type support.
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

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

// The engine reports translated text; keying on the id keeps the assertions readable.
vi.mock("@/scripts/lib/i18n.js", () => ({
  t: (key: string) => key,
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
    title: "DE: DAZN 1",
  } as CastDescriptorV1
}

function probeResponse(status: number, contentType: string | null, body: string) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  }
}

function malformedManifestError() {
  return {
    contentKey: "receiver-live-1",
    code: "ERROR_CODE_PARSING_MANIFEST_MALFORMED",
    message: "Source error",
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("native receiver engine error reporting", () => {
  let reports: ReceiverStatePartial[]
  let engine: ReceiverEngine

  beforeEach(() => {
    providerFetchMock.mockReset()
    const captured: ReceiverStatePartial[] = []
    reports = captured
    engine = createAndroidNativeReceiverEngine({
      report: (partial) => captured.push(partial),
      onSessionEnded: () => {},
    })
  })

  it("blames the provider, not the TV, when the source is a refusal page", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, "text/html", "<html>Max connections reached</html>"))
    await engine.play(liveDescriptor())
    fakeDocument.emit("xt:android-native-error", malformedManifestError())
    await settle()
    const errorReport = reports.filter((report) => report.state === "error").at(-1)
    expect(errorReport?.error).toContain("receiver.error.connectionLimit")
    expect(errorReport?.error).toContain("probe connection-limit")
  })

  it("keeps the container message when the source really is a malformed manifest", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, null, "#EXTM3U\n#EXT-X-GARBAGE\n"))
    await engine.play(liveDescriptor())
    fakeDocument.emit("xt:android-native-error", malformedManifestError())
    await settle()
    const errorReport = reports.filter((report) => report.state === "error").at(-1)
    expect(errorReport?.error).toContain("receiver.error.container")
  })

  it("trusts a connection-cap HTTP status without probing at all", async () => {
    await engine.play(liveDescriptor())
    fakeDocument.emit("xt:android-native-error", {
      contentKey: "receiver-live-1",
      code: "ERROR_CODE_IO_BAD_HTTP_STATUS",
      httpStatus: 458,
    })
    await settle()
    const errorReport = reports.filter((report) => report.state === "error").at(-1)
    expect(errorReport?.error).toContain("receiver.error.connectionLimit")
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("probes once for a flapping stream, not once per error event", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, "text/html", "<html>Max connections reached</html>"))
    await engine.play(liveDescriptor())
    for (let i = 0; i < 5; i++) fakeDocument.emit("xt:android-native-error", malformedManifestError())
    await settle()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
    expect(reports.filter((report) => report.state === "error")).toHaveLength(1)
  })

  it("stays quiet when the probe cannot reach the provider", async () => {
    providerFetchMock.mockRejectedValue(new Error("timed out"))
    await engine.play(liveDescriptor())
    fakeDocument.emit("xt:android-native-error", malformedManifestError())
    await settle()
    const errorReport = reports.filter((report) => report.state === "error").at(-1)
    expect(errorReport?.error).toContain("receiver.error.container")
    expect(errorReport?.error).not.toContain("probe")
  })
})
