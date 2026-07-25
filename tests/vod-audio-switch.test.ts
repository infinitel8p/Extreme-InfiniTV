import { describe, it, expect, vi, beforeEach } from "vitest"

const startVodAudioRemuxMock = vi.fn()
const stopVodAudioRemuxMock = vi.fn()
const onVodAudioErrorMock = vi.fn()
onVodAudioErrorMock.mockImplementation(() => () => {})

vi.mock("@/scripts/lib/vod-audio-proxy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scripts/lib/vod-audio-proxy")>()
  return {
    ...actual,
    startVodAudioRemux: (...args: unknown[]) => startVodAudioRemuxMock(...args),
    stopVodAudioRemux: (...args: unknown[]) => stopVodAudioRemuxMock(...args),
    onVodAudioError: (...args: unknown[]) => onVodAudioErrorMock(...args),
  }
})

import {
  isSeekOutsideBufferedRanges,
  timeRangesToArray,
  buildVodAudioRemuxRequest,
  resolveVodAudioRemuxInput,
  createVodAudioSwitcher,
  type VodAudioTrackOption,
} from "../src/scripts/lib/vod-audio-switch"

describe("isSeekOutsideBufferedRanges", () => {
  it("returns false for a target inside a buffered range", () => {
    expect(isSeekOutsideBufferedRanges(50, [{ start: 10, end: 100 }])).toBe(false)
  })

  it("returns false for a target within the before-slack of a range", () => {
    expect(isSeekOutsideBufferedRanges(9, [{ start: 10, end: 100 }])).toBe(false)
  })

  it("returns false for a target within the after-slack of a range", () => {
    expect(isSeekOutsideBufferedRanges(101.5, [{ start: 10, end: 100 }])).toBe(false)
  })

  it("returns true for a target well outside every range", () => {
    expect(isSeekOutsideBufferedRanges(500, [{ start: 10, end: 100 }])).toBe(true)
  })

  it("returns true when there are no buffered ranges at all", () => {
    expect(isSeekOutsideBufferedRanges(10, [])).toBe(true)
  })

  it("checks every range, not just the first", () => {
    const ranges = [
      { start: 0, end: 10 },
      { start: 200, end: 300 },
    ]
    expect(isSeekOutsideBufferedRanges(250, ranges)).toBe(false)
    expect(isSeekOutsideBufferedRanges(150, ranges)).toBe(true)
  })

  it("respects custom slack overrides", () => {
    expect(isSeekOutsideBufferedRanges(105, [{ start: 10, end: 100 }], 1, 10)).toBe(false)
    expect(isSeekOutsideBufferedRanges(105, [{ start: 10, end: 100 }], 1, 2)).toBe(true)
  })
})

describe("timeRangesToArray", () => {
  function fakeTimeRanges(pairs: Array<[number, number]>): TimeRanges {
    return {
      length: pairs.length,
      start: (i: number) => pairs[i][0],
      end: (i: number) => pairs[i][1],
    } as unknown as TimeRanges
  }

  it("converts a TimeRanges-like object into a plain array", () => {
    const ranges = fakeTimeRanges([[0, 10], [20, 30]])
    expect(timeRangesToArray(ranges)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ])
  })

  it("returns an empty array for null/undefined input", () => {
    expect(timeRangesToArray(null)).toEqual([])
    expect(timeRangesToArray(undefined)).toEqual([])
  })

  it("returns an empty array for an empty TimeRanges object", () => {
    expect(timeRangesToArray(fakeTimeRanges([]))).toEqual([])
  })
})

describe("buildVodAudioRemuxRequest", () => {
  const track: VodAudioTrackOption = {
    id: "mkv:2",
    audioStreamIndex: 1,
    codec: "A_DTS",
    language: "en",
    name: "Commentary",
    isDefault: false,
  }

  it("carries the track's audioStreamIndex and derives transcodeAudio from its codec", () => {
    const request = buildVodAudioRemuxRequest(track, "https://host.example/movie.mkv", 42, "UA/1.0", null)
    expect(request).toEqual({
      url: "https://host.example/movie.mkv",
      userAgent: "UA/1.0",
      authorization: null,
      audioStreamIndex: 1,
      startSeconds: 42,
      transcodeAudio: true,
    })
  })

  it("clamps a negative startSeconds to zero", () => {
    const request = buildVodAudioRemuxRequest(track, "https://host.example/movie.mkv", -5, null, null)
    expect(request.startSeconds).toBe(0)
  })

  it("copies transcodeAudio false for an AAC track", () => {
    const aacTrack: VodAudioTrackOption = { ...track, codec: "A_AAC" }
    const request = buildVodAudioRemuxRequest(aacTrack, "https://host.example/movie.mkv", 0, null, null)
    expect(request.transcodeAudio).toBe(false)
  })

  it("passes authorization through unchanged", () => {
    const request = buildVodAudioRemuxRequest(
      track,
      "https://host.example/movie.mkv",
      0,
      null,
      "Basic dXNlcjpwYXNz",
    )
    expect(request.authorization).toBe("Basic dXNlcjpwYXNz")
  })
})

describe("resolveVodAudioRemuxInput", () => {
  it("uses the local tee URL and drops userAgent/authorization when a remuxInputUrl is set", () => {
    const resolution = resolveVodAudioRemuxInput(
      "http://127.0.0.1:5000/live/session-1",
      "https://user:pass@host.example/movie.mkv",
      "Mozilla/5.0",
    )
    expect(resolution).toEqual({
      cleanUrl: "http://127.0.0.1:5000/live/session-1",
      userAgent: null,
      authorization: null,
    })
  })

  it("splits the upstream URL and keeps the resolved userAgent when there is no remuxInputUrl", () => {
    const resolution = resolveVodAudioRemuxInput(null, "https://user:pass@host.example/movie.mp4", "Mozilla/5.0")
    expect(resolution.cleanUrl).toBe("https://host.example/movie.mp4")
    expect(resolution.userAgent).toBe("Mozilla/5.0")
    expect(resolution.authorization).toMatch(/^Basic /)
  })

  it("treats an empty remuxInputUrl the same as no remuxInputUrl", () => {
    const resolution = resolveVodAudioRemuxInput("", "https://host.example/movie.mp4", null)
    expect(resolution.cleanUrl).toBe("https://host.example/movie.mp4")
  })
})

interface FakeHandle {
  currentTime: ReturnType<typeof vi.fn>
  src: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  one: ReturnType<typeof vi.fn>
  getMediaElement: () => null
}

function createFakeHandle(): FakeHandle {
  let currentTimeValue = 0
  return {
    currentTime: vi.fn((value?: number) => {
      if (value !== undefined) {
        currentTimeValue = value
        return value
      }
      return currentTimeValue
    }),
    src: vi.fn(),
    play: vi.fn(),
    one: vi.fn(),
    getMediaElement: () => null,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeTracks(): { trackDefault: VodAudioTrackOption; trackA: VodAudioTrackOption; trackB: VodAudioTrackOption } {
  return {
    trackDefault: { id: "default", audioStreamIndex: 0, codec: "aac", isDefault: true },
    trackA: { id: "a", audioStreamIndex: 1, codec: "ac3", isDefault: false },
    trackB: { id: "b", audioStreamIndex: 2, codec: "ac3", isDefault: false },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("createVodAudioSwitcher async state machine", () => {
  beforeEach(() => {
    startVodAudioRemuxMock.mockReset()
    stopVodAudioRemuxMock.mockReset()
    onVodAudioErrorMock.mockReset().mockImplementation(() => () => {})
  })

  it("ignores a stale register resolution when a second switch already superseded it", async () => {
    const handle = createFakeHandle()
    const { trackDefault, trackA, trackB } = makeTracks()
    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "https://host.example/movie.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault, trackA, trackB],
    })

    const deferredA = deferred<{ sessionId: string; playbackUrl: string }>()
    const deferredB = deferred<{ sessionId: string; playbackUrl: string }>()
    startVodAudioRemuxMock.mockReturnValueOnce(deferredA.promise)
    startVodAudioRemuxMock.mockReturnValueOnce(deferredB.promise)

    switcher.source.select("a")
    switcher.source.select("b")

    deferredB.resolve({ sessionId: "session-b", playbackUrl: "http://127.0.0.1/live/session-b" })
    await flushMicrotasks()

    deferredA.resolve({ sessionId: "session-a", playbackUrl: "http://127.0.0.1/live/session-a" })
    await flushMicrotasks()

    expect(stopVodAudioRemuxMock).toHaveBeenCalledWith("session-a")
    expect(handle.src).not.toHaveBeenCalledWith(
      expect.objectContaining({ src: "http://127.0.0.1/live/session-a" }),
    )
    expect(handle.src).toHaveBeenCalledWith(
      expect.objectContaining({ src: "http://127.0.0.1/live/session-b" }),
    )
    expect(switcher.source.list().find((track) => track.active)?.id).toBe("b")

    switcher.dispose()
  })

  it("stops a late-resolving switch when the user reverted to the default track first", async () => {
    const handle = createFakeHandle()
    const { trackDefault, trackA, trackB } = makeTracks()
    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "https://host.example/movie.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault, trackA, trackB],
    })

    const deferredA = deferred<{ sessionId: string; playbackUrl: string }>()
    startVodAudioRemuxMock.mockReturnValueOnce(deferredA.promise)

    switcher.source.select("a")
    switcher.source.select("default")

    const srcCallCountAfterRevert = handle.src.mock.calls.length

    deferredA.resolve({ sessionId: "session-a", playbackUrl: "http://127.0.0.1/live/session-a" })
    await flushMicrotasks()

    expect(stopVodAudioRemuxMock).toHaveBeenCalledWith("session-a")
    expect(handle.src.mock.calls.length).toBe(srcCallCountAfterRevert)
    expect(switcher.source.list().find((track) => track.active)?.id).toBe("default")

    switcher.dispose()
  })

  it("stops a session that resolves after dispose and mutates no further state", async () => {
    const handle = createFakeHandle()
    const { trackDefault, trackA, trackB } = makeTracks()
    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "https://host.example/movie.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault, trackA, trackB],
    })

    const deferredA = deferred<{ sessionId: string; playbackUrl: string }>()
    startVodAudioRemuxMock.mockReturnValueOnce(deferredA.promise)

    switcher.source.select("a")
    const srcCallCountBeforeDispose = handle.src.mock.calls.length
    switcher.dispose()

    deferredA.resolve({ sessionId: "session-a", playbackUrl: "http://127.0.0.1/live/session-a" })
    await flushMicrotasks()

    expect(stopVodAudioRemuxMock).toHaveBeenCalledWith("session-a")
    expect(handle.src.mock.calls.length).toBe(srcCallCountBeforeDispose)
  })
})
