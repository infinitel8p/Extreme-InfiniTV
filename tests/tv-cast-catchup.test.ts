/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildCatchupCastDescriptor } from "@/scripts/lib/tv-cast-descriptor"

const resolveCatchupSrcMock = vi.fn()
vi.mock("@/scripts/lib/catchup-resolve.ts", () => ({
  resolveCatchupSrc: (...args: unknown[]) => resolveCatchupSrcMock(...args),
}))

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

const toastMock = vi.fn()
vi.mock("@/scripts/lib/toast.js", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}))

const getPlaylistDnsOverrideMock = vi.fn()
vi.mock("@/scripts/lib/creds.js", () => ({
  getPlaylistDnsOverride: (...args: unknown[]) => getPlaylistDnsOverrideMock(...args),
}))

import {
  catchupMimeForKindHint,
  computeCatchupTimeline,
  resolveCatchupCastDescriptor,
} from "@/scripts/lib/tv-cast-catchup.ts"
import { setCastSession, routePlayToCast, CAST_SUPERSEDED, type CastSession } from "@/scripts/lib/tv-cast"

// Node 24+ ships an experimental native `localStorage`/`sessionStorage` that shadows
// jsdom's; stub both with one in-memory Storage implementation (same pattern as
// tests/tv-cast-reattach.test.ts).
class MemoryStorage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
}

const memoryLocalStorage = new MemoryStorage()
const memorySessionStorage = new MemoryStorage()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("Storage", MemoryStorage)
  vi.stubGlobal("localStorage", memoryLocalStorage as unknown as Storage)
  vi.stubGlobal("sessionStorage", memorySessionStorage as unknown as Storage)
  memoryLocalStorage.clear()
  memorySessionStorage.clear()
  providerFetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
  getPlaylistDnsOverrideMock.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeActiveSession(overrides: Partial<CastSession> = {}): CastSession {
  return {
    deviceId: "device-1",
    deviceName: "Living Room TV",
    host: "192.168.1.50",
    port: 8765,
    key: "secret-key",
    title: "News at Noon",
    isLive: false,
    startedAt: Date.now(),
    ...overrides,
  }
}

describe("catchupMimeForKindHint", () => {
  it.each([
    ["hls", "application/x-mpegURL"],
    ["ts", "video/mp2t"],
  ] as const)("maps %s -> %s", (kindHint, expectedMime) => {
    expect(catchupMimeForKindHint(kindHint)).toBe(expectedMime)
  })
})

describe("computeCatchupTimeline", () => {
  const startUtcMs = Date.UTC(2024, 0, 1, 12, 0, 0)
  const stopUtcMs = startUtcMs + 30 * 60_000
  const nowUtcMs = stopUtcMs + 10 * 60_000

  it("uses the requested window as the timeline for a terminating programme replay", () => {
    const timeline = computeCatchupTimeline({
      kind: "programme",
      startUtcMs,
      stopUtcMs,
      effectiveStartUtcMs: startUtcMs,
      timelineStartUtcMs: startUtcMs,
      timelineStartUtcMsWasExplicit: false,
      profileTerminates: true,
      seekSeconds: 0,
      nowUtcMs,
    })
    expect(timeline.timelineStartUtcMs).toBe(startUtcMs)
    expect(timeline.timelineStopUtcMs).toBeNull()
    expect(timeline.timelineOffsetSeconds).toBe(0)
    expect(timeline.timelineSpanSeconds).toBe(30 * 60)
    expect(timeline.initialPositionSeconds).toBe(0)
  })

  it("clamps a negative offset to 0 when the mounted start lands before the timeline start", () => {
    const timeline = computeCatchupTimeline({
      kind: "programme",
      startUtcMs,
      stopUtcMs,
      effectiveStartUtcMs: startUtcMs - 5000,
      timelineStartUtcMs: startUtcMs,
      timelineStartUtcMsWasExplicit: false,
      profileTerminates: true,
      seekSeconds: 0,
      nowUtcMs,
    })
    expect(timeline.timelineOffsetSeconds).toBe(0)
  })

  it("adds seekSeconds on top of the requested-start offset for the initial position", () => {
    const timeline = computeCatchupTimeline({
      kind: "programme",
      startUtcMs,
      stopUtcMs,
      effectiveStartUtcMs: startUtcMs,
      timelineStartUtcMs: startUtcMs - 60_000,
      timelineStartUtcMsWasExplicit: true,
      profileTerminates: true,
      seekSeconds: 15,
      nowUtcMs,
    })
    // startUtcMs is 60s after timelineStartUtcMs, plus a 15s seek.
    expect(timeline.initialPositionSeconds).toBe(75)
  })

  it("extends the timeline to the anchor window for a non-terminating programme still mid-broadcast", () => {
    const anchorStart = startUtcMs - 5 * 60_000
    const anchorStop = stopUtcMs + 5 * 60_000
    const timeline = computeCatchupTimeline({
      kind: "timeshift",
      startUtcMs,
      stopUtcMs,
      effectiveStartUtcMs: startUtcMs,
      timelineStartUtcMs: startUtcMs,
      timelineStartUtcMsWasExplicit: false,
      profileTerminates: false,
      timeshiftAnchorWindow: { startUtcMs: anchorStart, stopUtcMs: anchorStop },
      seekSeconds: 0,
      nowUtcMs: anchorStop - 60_000,
    })
    expect(timeline.timelineStartUtcMs).toBe(anchorStart)
    expect(timeline.timelineStopUtcMs).toBe(anchorStop)
    expect(timeline.timelineSpanSeconds).toBe((anchorStop - anchorStart) / 1000)
  })

  it("keeps an explicit timelineStartUtcMs even when the anchor window would move it", () => {
    const explicitTimelineStart = startUtcMs - 10 * 60_000
    const anchorStart = startUtcMs - 5 * 60_000
    const anchorStop = stopUtcMs + 5 * 60_000
    const timeline = computeCatchupTimeline({
      kind: "timeshift",
      startUtcMs,
      stopUtcMs,
      effectiveStartUtcMs: startUtcMs,
      timelineStartUtcMs: explicitTimelineStart,
      timelineStartUtcMsWasExplicit: true,
      profileTerminates: false,
      timeshiftAnchorWindow: { startUtcMs: anchorStart, stopUtcMs: anchorStop },
      seekSeconds: 0,
      nowUtcMs: anchorStop - 60_000,
    })
    expect(timeline.timelineStartUtcMs).toBe(explicitTimelineStart)
    expect(timeline.timelineStopUtcMs).toBe(anchorStop)
  })

  it("ignores the anchor window once the programme has already ended", () => {
    const anchorStart = startUtcMs - 5 * 60_000
    const anchorStop = stopUtcMs + 5 * 60_000
    const timeline = computeCatchupTimeline({
      kind: "timeshift",
      startUtcMs,
      stopUtcMs,
      effectiveStartUtcMs: startUtcMs,
      timelineStartUtcMs: startUtcMs,
      timelineStartUtcMsWasExplicit: false,
      profileTerminates: false,
      timeshiftAnchorWindow: { startUtcMs: anchorStart, stopUtcMs: anchorStop },
      seekSeconds: 0,
      nowUtcMs: anchorStop + 60_000,
    })
    expect(timeline.timelineStartUtcMs).toBe(startUtcMs)
    expect(timeline.timelineStopUtcMs).toBeNull()
    expect(timeline.timelineSpanSeconds).toBe(Math.round((Math.min(stopUtcMs, anchorStop + 60_000) - startUtcMs) / 1000))
  })

  it("honors an explicit timelineStopUtcMs override and skips the anchor-window lookup", () => {
    const overrideStop = stopUtcMs + 20 * 60_000
    const timeline = computeCatchupTimeline({
      kind: "timeshift",
      startUtcMs,
      stopUtcMs,
      effectiveStartUtcMs: startUtcMs,
      timelineStartUtcMs: startUtcMs,
      timelineStartUtcMsWasExplicit: false,
      timelineStopUtcMsOverride: overrideStop,
      profileTerminates: false,
      timeshiftAnchorWindow: { startUtcMs: startUtcMs - 60_000, stopUtcMs: overrideStop + 60_000 },
      seekSeconds: 0,
      nowUtcMs,
    })
    expect(timeline.timelineStartUtcMs).toBe(startUtcMs)
    expect(timeline.timelineStopUtcMs).toBe(overrideStop)
    expect(timeline.timelineSpanSeconds).toBe((overrideStop - startUtcMs) / 1000)
  })
})

describe("buildCatchupCastDescriptor", () => {
  it("builds a non-live descriptor with the given mime and title", () => {
    const descriptor = buildCatchupCastDescriptor({
      src: "https://provider.example/timeshift/user/pass/1/1700000000/60.m3u8",
      mime: "application/x-mpegURL",
      title: "News at Noon",
    })
    expect(descriptor).toEqual({
      v: 1,
      src: "https://provider.example/timeshift/user/pass/1/1700000000/60.m3u8",
      mime: "application/x-mpegURL",
      isLive: false,
      title: "News at Noon",
    })
  })

  it("includes optional fields only when provided", () => {
    const descriptor = buildCatchupCastDescriptor({
      src: "https://provider.example/timeshift.ts",
      mime: "video/mp2t",
      title: "News at Noon",
      logo: "https://provider.example/logo.png",
      headers: { userAgent: "custom-ua" },
      durationSeconds: 1800,
      timelineOffsetSeconds: 120,
      resumeSeconds: 45,
    })
    expect(descriptor.logo).toBe("https://provider.example/logo.png")
    expect(descriptor.headers).toEqual({ userAgent: "custom-ua" })
    expect(descriptor.durationSeconds).toBe(1800)
    expect(descriptor.timelineOffsetSeconds).toBe(120)
    expect(descriptor.resumeSeconds).toBe(45)
  })

  it.each([
    ["negative offset", -1, undefined],
    ["NaN offset", Number.NaN, undefined],
    ["Infinity offset", Number.POSITIVE_INFINITY, undefined],
    ["zero offset", 0, 0],
    ["valid offset", 90, 90],
  ])("clamps timelineOffsetSeconds: %s", (_label, input, expected) => {
    const descriptor = buildCatchupCastDescriptor({
      src: "https://provider.example/timeshift.ts",
      mime: "video/mp2t",
      title: "News at Noon",
      timelineOffsetSeconds: input,
    })
    expect(descriptor.timelineOffsetSeconds).toBe(expected)
  })
})

describe("resolveCatchupCastDescriptor", () => {
  beforeEach(() => {
    resolveCatchupSrcMock.mockReset()
  })

  const creds = { host: "iptv.example.com", port: "8080", user: "alice", pass: "secret" }
  const channel = { id: 1, name: "News Channel" }
  const startUtcMs = Date.UTC(2024, 0, 1, 12, 0, 0)
  const stopUtcMs = startUtcMs + 30 * 60_000

  it("returns null when the resolver can't find a playable src", async () => {
    resolveCatchupSrcMock.mockResolvedValue(null)
    const descriptor = await resolveCatchupCastDescriptor({
      playlistId: "playlist-1",
      creds,
      channel,
      startUtcMs,
      stopUtcMs,
      title: "News at Noon",
    })
    expect(descriptor).toBeNull()
  })

  it("builds a descriptor from the resolution, with resumeSeconds only when the seek is beyond zero", async () => {
    resolveCatchupSrcMock.mockResolvedValue({
      src: "https://provider.example/timeshift.m3u8",
      kindHint: "hls",
      effectiveStartUtcMs: startUtcMs,
      profile: { terminates: true },
    })
    const descriptor = await resolveCatchupCastDescriptor({
      playlistId: "playlist-1",
      creds,
      channel,
      startUtcMs,
      stopUtcMs,
      title: "News at Noon",
      logo: "https://provider.example/logo.png",
    })
    expect(descriptor).toEqual({
      v: 1,
      src: "https://provider.example/timeshift.m3u8",
      mime: "application/x-mpegURL",
      isLive: false,
      title: "News at Noon",
      logo: "https://provider.example/logo.png",
      dns: null,
      durationSeconds: 30 * 60,
      timelineOffsetSeconds: 0,
    })
  })

  it("carries resumeSeconds when seekSeconds pushes the initial position past zero", async () => {
    resolveCatchupSrcMock.mockResolvedValue({
      src: "https://provider.example/timeshift.ts",
      kindHint: "ts",
      effectiveStartUtcMs: startUtcMs,
      profile: { terminates: true },
    })
    const descriptor = await resolveCatchupCastDescriptor({
      playlistId: "playlist-1",
      creds,
      channel,
      startUtcMs,
      stopUtcMs,
      seekSeconds: 30,
      title: "News at Noon",
    })
    expect(descriptor?.mime).toBe("video/mp2t")
    expect(descriptor?.resumeSeconds).toBe(30)
  })
})

describe("CAST_SUPERSEDED (a newer catch-up pick beats a slow resolveCatchupSrc)", () => {
  it("does not toast a failure when buildDescriptor reports CAST_SUPERSEDED", async () => {
    setCastSession(makeActiveSession())

    const result = await routePlayToCast({ buildDescriptor: () => CAST_SUPERSEDED })

    expect(result).toBe(false)
    expect(toastMock).not.toHaveBeenCalled()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("still toasts a failure for a genuine build failure (null), distinct from being superseded", async () => {
    setCastSession(makeActiveSession())

    const result = await routePlayToCast({ buildDescriptor: () => null })

    expect(result).toBe(false)
    expect(toastMock).toHaveBeenCalledTimes(1)
  })
})
