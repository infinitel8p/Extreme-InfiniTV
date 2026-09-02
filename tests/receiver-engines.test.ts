import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clampReceiverVolume,
  createEmbeddedReceiverEngine,
  durationSecondsFromMs,
  mapNativeErrorCode,
  normalizeReportedDuration,
  normalizeReportedVolume,
  type EmbeddedEngineDom,
} from "../src/scripts/receiver/engines"
import { httpStatusFromErrorDetail, isConnectionLimitStatus } from "../src/scripts/lib/codec-hints"
import type { CastDescriptorV1 } from "../src/scripts/lib/tv-cast-descriptor"

vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key }))

type MountResult = { kind: "embedded"; handle: FakeEmbeddedHandle } | null
let pendingMount: { resolve: (result: MountResult) => void } | null = null

vi.mock("@/scripts/lib/player-runtime", () => ({
  mountPlayer: () => new Promise<MountResult>((resolve) => { pendingMount = { resolve } }),
  playWhenReady: () => {},
}))

let mockDnsProxyAvailable = false
let mockEnsureDnsProxyBase: string | null = null
const ensureDnsProxyMock = vi.fn(async (_sessionKey: string, _server: unknown) => mockEnsureDnsProxyBase)

vi.mock("@/scripts/lib/dns-proxy.ts", () => ({
  dnsProxyAvailable: () => mockDnsProxyAvailable,
  ensureDnsProxy: (sessionKey: string, server: unknown) => ensureDnsProxyMock(sessionKey, server),
}))

/** A function boundary so TS re-checks pendingMount instead of keeping it narrowed to its last assignment. */
function takePendingMountResolve(): (result: MountResult) => void {
  const resolve = pendingMount?.resolve
  if (!resolve) throw new Error("expected a pending mountPlayer() call")
  pendingMount = null
  return resolve
}

class FakeClassList {
  private classes = new Set<string>()
  add(...names: string[]): void {
    for (const name of names) this.classes.add(name)
  }
  remove(...names: string[]): void {
    for (const name of names) this.classes.delete(name)
  }
  toggle(name: string, force?: boolean): void {
    if (force ?? !this.classes.has(name)) this.classes.add(name)
    else this.classes.delete(name)
  }
  contains(name: string): boolean {
    return this.classes.has(name)
  }
}

class FakeElement {
  classList = new FakeClassList()
  textContent = ""
  offsetWidth = 0
  focus(): void {}
}

class FakeEmbeddedHandle {
  srcCalls: unknown[] = []
  private handlers = new Map<string, Array<() => void>>()
  on(type: string, handler: () => void): void {
    const forType = this.handlers.get(type) || []
    forType.push(handler)
    this.handlers.set(type, forType)
  }
  src(options: unknown): void {
    this.srcCalls.push(options)
  }
  pause(): void {}
  reset(): void {}
  duration(): number {
    return 0
  }
  currentTime(): void {}
  muted(): void {}
  getMediaElement(): null {
    return null
  }
  codecInfo(): { videoCodec: null; audioCodec: null; errorDetail: null } {
    return { videoCodec: null, audioCodec: null, errorDetail: null }
  }
}

function fakeElement(): HTMLElement {
  return new FakeElement() as unknown as HTMLElement
}

function embeddedDom(playerViewEl: HTMLElement): EmbeddedEngineDom {
  return {
    idleEl: fakeElement(),
    playerViewEl,
    videoEl: fakeElement() as unknown as HTMLVideoElement,
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

function liveDescriptor(title: string, dns?: string): CastDescriptorV1 {
  return {
    v: 1,
    src: `http://tv.example/live/user/pass/${title}.m3u8`,
    mime: "application/x-mpegURL",
    isLive: true,
    title,
    dns,
  } as CastDescriptorV1
}

describe("mapNativeErrorCode", () => {
  it("maps decoder/decoding/DRM codes to the video codec message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_DECODING_FAILED")).toBe("receiver.error.videoCodec")
    expect(mapNativeErrorCode("ERROR_CODE_DECODER_INIT_FAILED")).toBe("receiver.error.videoCodec")
    expect(mapNativeErrorCode("ERROR_CODE_DRM_SYSTEM_ERROR")).toBe("receiver.error.videoCodec")
  })

  it("maps audio track codes to the audio codec message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_AUDIO_TRACK_INIT_FAILED")).toBe("receiver.error.audioCodec")
  })

  it("maps parsing/container/unsupported codes to the container message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_PARSING_CONTAINER_MALFORMED")).toBe("receiver.error.container")
    expect(mapNativeErrorCode("SOURCE_UNSUPPORTED")).toBe("receiver.error.container")
  })

  it("maps IO/network codes to the network message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_IO_NETWORK_CONNECTION_FAILED")).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS")).toBe("receiver.error.network")
  })

  it("maps timeout codes to the timeout message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_TIMEOUT")).toBe("receiver.error.timeout")
  })

  it("prefers the connection-limit message when the provider refused the request", () => {
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 458)).toBe("receiver.error.connectionLimit")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 509)).toBe("receiver.error.connectionLimit")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 429)).toBe("receiver.error.connectionLimit")
    expect(mapNativeErrorCode(null, 458)).toBe("receiver.error.connectionLimit")
  })

  it("leaves unrelated HTTP failures on the network message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 404)).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 500)).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", null)).toBe("receiver.error.network")
  })

  it("falls back to the generic title for unknown or missing codes", () => {
    expect(mapNativeErrorCode("ERROR_CODE_REMOTE_ERROR")).toBe("receiver.error.title")
    expect(mapNativeErrorCode(null)).toBe("receiver.error.title")
    expect(mapNativeErrorCode(undefined)).toBe("receiver.error.title")
    expect(mapNativeErrorCode("")).toBe("receiver.error.title")
  })
})

describe("clampReceiverVolume", () => {
  it("passes through values already within [0, 1]", () => {
    expect(clampReceiverVolume(0)).toBe(0)
    expect(clampReceiverVolume(0.4)).toBe(0.4)
    expect(clampReceiverVolume(1)).toBe(1)
  })

  it("clamps out-of-range values to the nearest bound", () => {
    expect(clampReceiverVolume(-0.5)).toBe(0)
    expect(clampReceiverVolume(1.5)).toBe(1)
  })

  it("treats non-finite input as silence", () => {
    expect(clampReceiverVolume(Number.NaN)).toBe(0)
    expect(clampReceiverVolume(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampReceiverVolume(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe("isConnectionLimitStatus", () => {
  it("recognizes the statuses panels use to refuse an extra stream", () => {
    expect(isConnectionLimitStatus(458)).toBe(true)
    expect(isConnectionLimitStatus(429)).toBe(true)
    expect(isConnectionLimitStatus(509)).toBe(true)
  })

  it("rejects other statuses and missing input", () => {
    expect(isConnectionLimitStatus(200)).toBe(false)
    expect(isConnectionLimitStatus(403)).toBe(false)
    expect(isConnectionLimitStatus(null)).toBe(false)
    expect(isConnectionLimitStatus(undefined)).toBe(false)
  })
})

describe("httpStatusFromErrorDetail", () => {
  it("reads the status our hls.js path appends", () => {
    expect(httpStatusFromErrorDetail("manifestLoadError (HTTP 458)")).toBe(458)
  })

  it("reads the status out of a shaka BAD_HTTP_STATUS payload", () => {
    expect(
      httpStatusFromErrorDetail('shaka:network:1001 ["http://host/live/u/p/1.m3u8",458,"",{},1]')
    ).toBe(458)
  })

  it("returns null when no status is present", () => {
    expect(httpStatusFromErrorDetail("bufferStalledError")).toBe(null)
    expect(httpStatusFromErrorDetail("")).toBe(null)
    expect(httpStatusFromErrorDetail(null)).toBe(null)
  })
})

describe("normalizeReportedDuration", () => {
  it("passes through a finite positive duration", () => {
    expect(normalizeReportedDuration(5400)).toBe(5400)
    expect(normalizeReportedDuration(0.5)).toBe(0.5)
  })

  it("drops the values a player reports before it knows the timeline", () => {
    expect(normalizeReportedDuration(0)).toBeUndefined()
    expect(normalizeReportedDuration(-1)).toBeUndefined()
    expect(normalizeReportedDuration(Number.NaN)).toBeUndefined()
    expect(normalizeReportedDuration(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(normalizeReportedDuration(null)).toBeUndefined()
    expect(normalizeReportedDuration(undefined)).toBeUndefined()
  })
})

describe("durationSecondsFromMs", () => {
  it("converts a known native duration to whole seconds", () => {
    expect(durationSecondsFromMs(5400000)).toBe(5400)
    expect(durationSecondsFromMs(1500)).toBe(1)
  })

  it("drops a missing or unset native duration instead of reporting zero", () => {
    expect(durationSecondsFromMs(0)).toBeUndefined()
    expect(durationSecondsFromMs(Number.MIN_SAFE_INTEGER)).toBeUndefined()
    expect(durationSecondsFromMs(Number.NaN)).toBeUndefined()
    expect(durationSecondsFromMs(undefined)).toBeUndefined()
  })
})

describe("normalizeReportedVolume", () => {
  it("passes through a real level, including silence", () => {
    expect(normalizeReportedVolume(0)).toBe(0)
    expect(normalizeReportedVolume(0.35)).toBe(0.35)
    expect(normalizeReportedVolume(1)).toBe(1)
  })

  it("treats an out-of-range or missing level as no volume surface at all", () => {
    expect(normalizeReportedVolume(-0.1)).toBeUndefined()
    expect(normalizeReportedVolume(1.5)).toBeUndefined()
    expect(normalizeReportedVolume(Number.NaN)).toBeUndefined()
    expect(normalizeReportedVolume(null)).toBeUndefined()
    expect(normalizeReportedVolume(undefined)).toBeUndefined()
  })
})

describe("createEmbeddedReceiverEngine play() staleness", () => {
  beforeEach(() => {
    pendingMount = null
  })

  it("does not resume a play() that was superseded by a teardown during its mount", async () => {
    const playerViewEl = fakeElement()
    const dom = embeddedDom(playerViewEl)
    const engine = createEmbeddedReceiverEngine(dom, { report: () => {}, onSessionEnded: () => {} })

    const firstPlay = engine.play(liveDescriptor("A"))
    await Promise.resolve()
    const resolveMount = takePendingMountResolve()

    engine.teardown()

    const handle = new FakeEmbeddedHandle()
    resolveMount({ kind: "embedded", handle })
    const firstResult = await firstPlay

    expect(firstResult).toBe(false)
    expect(handle.srcCalls).toHaveLength(0)
    expect(playerViewEl.classList.contains("hidden")).toBe(true)
  })

  it("does not resume a play() that was superseded by a second play() during its mount", async () => {
    const playerViewEl = fakeElement()
    const dom = embeddedDom(playerViewEl)
    const engine = createEmbeddedReceiverEngine(dom, { report: () => {}, onSessionEnded: () => {} })

    const firstPlay = engine.play(liveDescriptor("A"))
    await Promise.resolve()
    const resolveFirstMount = takePendingMountResolve()

    const secondPlay = engine.play(liveDescriptor("B"))
    await Promise.resolve()
    const resolveSecondMount = takePendingMountResolve()

    const firstHandle = new FakeEmbeddedHandle()
    resolveFirstMount({ kind: "embedded", handle: firstHandle })
    expect(await firstPlay).toBe(false)
    expect(firstHandle.srcCalls).toHaveLength(0)

    const secondHandle = new FakeEmbeddedHandle()
    resolveSecondMount({ kind: "embedded", handle: secondHandle })
    expect(await secondPlay).toBe(true)
    expect(secondHandle.srcCalls).toHaveLength(1)
  })
})

describe("createEmbeddedReceiverEngine play() DNS proxy wrapping", () => {
  beforeEach(() => {
    pendingMount = null
    mockDnsProxyAvailable = false
    mockEnsureDnsProxyBase = null
    ensureDnsProxyMock.mockClear()
  })

  async function playAndMount(descriptor: CastDescriptorV1): Promise<FakeEmbeddedHandle> {
    const dom = embeddedDom(fakeElement())
    const engine = createEmbeddedReceiverEngine(dom, { report: () => {}, onSessionEnded: () => {} })
    const playPromise = engine.play(descriptor)
    await Promise.resolve()
    const handle = new FakeEmbeddedHandle()
    takePendingMountResolve()({ kind: "embedded", handle })
    await playPromise
    return handle
  }

  it("mounts the raw src when the descriptor carries no dns override", async () => {
    const handle = await playAndMount(liveDescriptor("A"))
    expect(ensureDnsProxyMock).not.toHaveBeenCalled()
    expect((handle.srcCalls[0] as { src: string }).src).toBe("http://tv.example/live/user/pass/A.m3u8")
  })

  it("mounts the raw src when the dns proxy is unavailable on this platform", async () => {
    mockDnsProxyAvailable = false
    const handle = await playAndMount(liveDescriptor("A", "1.1.1.1"))
    expect(ensureDnsProxyMock).not.toHaveBeenCalled()
    expect((handle.srcCalls[0] as { src: string }).src).toBe("http://tv.example/live/user/pass/A.m3u8")
  })

  it("wraps the src through the registered proxy base when a dns override resolves", async () => {
    mockDnsProxyAvailable = true
    mockEnsureDnsProxyBase = "http://127.0.0.1:5321/abc123"
    const handle = await playAndMount(liveDescriptor("A", "1.1.1.1"))
    expect(ensureDnsProxyMock).toHaveBeenCalledWith("dns:1.1.1.1", expect.objectContaining({ raw: "1.1.1.1" }))
    expect((handle.srcCalls[0] as { src: string }).src).toBe(
      "http://127.0.0.1:5321/abc123/http/tv.example/live/user/pass/A.m3u8"
    )
  })

  it("falls back to the raw src when proxy registration fails", async () => {
    mockDnsProxyAvailable = true
    mockEnsureDnsProxyBase = null
    const handle = await playAndMount(liveDescriptor("A", "1.1.1.1"))
    expect(ensureDnsProxyMock).toHaveBeenCalled()
    expect((handle.srcCalls[0] as { src: string }).src).toBe("http://tv.example/live/user/pass/A.m3u8")
  })
})
