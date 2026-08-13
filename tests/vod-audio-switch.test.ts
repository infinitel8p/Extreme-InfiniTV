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

  it("restarts a dead mandatory remux session up to twice before reporting unrecoverable", async () => {
    const handle = createFakeHandle()
    const { trackDefault } = makeTracks()
    const captured: { listener: ((payload: { sessionId: string; detail: string }) => void) | null } = { listener: null }
    onVodAudioErrorMock.mockImplementation((listener: (payload: { sessionId: string; detail: string }) => void) => {
      captured.listener = listener
      return () => {}
    })
    startVodAudioRemuxMock
      .mockResolvedValueOnce({ sessionId: "session-0", playbackUrl: "http://127.0.0.1/live/session-0" })
      .mockResolvedValueOnce({ sessionId: "session-1", playbackUrl: "http://127.0.0.1/live/session-1" })
      .mockResolvedValueOnce({ sessionId: "session-2", playbackUrl: "http://127.0.0.1/live/session-2" })
    const unrecoverable = vi.fn()

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee-token/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      remuxInputUrl: "http://127.0.0.1/tee-token/stream.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault],
      mountRemuxImmediately: true,
      initialStartSeconds: 12,
      onRemuxUnrecoverable: unrecoverable,
    })
    await flushMicrotasks()

    expect(handle.src).toHaveBeenCalledWith(
      expect.objectContaining({ src: "http://127.0.0.1/live/session-0" }),
    )

    // attempt 1/2
    captured.listener?.({ sessionId: "session-0", detail: "OTHER:ffmpeg exited with exit status: 8" })
    await flushMicrotasks()
    expect(stopVodAudioRemuxMock).toHaveBeenCalledWith("session-0")
    expect(handle.src).toHaveBeenCalledWith(
      expect.objectContaining({ src: "http://127.0.0.1/live/session-1" }),
    )
    expect(unrecoverable).not.toHaveBeenCalled()

    // attempt 2/2
    captured.listener?.({ sessionId: "session-1", detail: "OTHER:ffmpeg exited with exit status: 8" })
    await flushMicrotasks()
    expect(stopVodAudioRemuxMock).toHaveBeenCalledWith("session-1")
    expect(handle.src).toHaveBeenCalledWith(
      expect.objectContaining({ src: "http://127.0.0.1/live/session-2" }),
    )
    expect(unrecoverable).not.toHaveBeenCalled()

    // attempts exhausted
    const srcCallCountBeforeGiveUp = handle.src.mock.calls.length
    // The tee relays the provider's status verbatim, so a dead source shows up as an ffmpeg exit.
    captured.listener?.({ sessionId: "session-2", detail: "OTHER:ffmpeg exited with exit status: 8 (404 Not Found)" })
    await flushMicrotasks()

    expect(unrecoverable).toHaveBeenCalledTimes(1)
    expect(unrecoverable.mock.calls[0][0]).toContain("404")
    expect(handle.src.mock.calls.length).toBe(srcCallCountBeforeGiveUp)

    switcher.dispose()
  })

  it("resets the restart budget after the session has been healthy for a while", async () => {
    vi.useFakeTimers()
    try {
      const handle = createFakeHandle()
      const { trackDefault } = makeTracks()
      const captured: { listener: ((payload: { sessionId: string; detail: string }) => void) | null } = { listener: null }
      onVodAudioErrorMock.mockImplementation((listener: (payload: { sessionId: string; detail: string }) => void) => {
        captured.listener = listener
        return () => {}
      })
      startVodAudioRemuxMock
        .mockResolvedValueOnce({ sessionId: "session-0", playbackUrl: "http://127.0.0.1/live/session-0" })
        .mockResolvedValueOnce({ sessionId: "session-1", playbackUrl: "http://127.0.0.1/live/session-1" })
        .mockResolvedValueOnce({ sessionId: "session-2", playbackUrl: "http://127.0.0.1/live/session-2" })
        .mockResolvedValueOnce({ sessionId: "session-3", playbackUrl: "http://127.0.0.1/live/session-3" })
      const unrecoverable = vi.fn()

      const switcher = createVodAudioSwitcher({
        handle: handle as any,
        originalSrc: "http://127.0.0.1/tee-token/stream.mkv",
        originalMime: "video/x-matroska",
        sourceUrl: "https://host.example/movie.mkv",
        remuxInputUrl: "http://127.0.0.1/tee-token/stream.mkv",
        getKnownDurationSeconds: () => 100,
        tracks: [trackDefault],
        mountRemuxImmediately: true,
        onRemuxUnrecoverable: unrecoverable,
      })
      await flushMicrotasks()

      // Use up both restart attempts.
      captured.listener?.({ sessionId: "session-0", detail: "died once" })
      await flushMicrotasks()
      captured.listener?.({ sessionId: "session-1", detail: "died twice" })
      await flushMicrotasks()
      expect(unrecoverable).not.toHaveBeenCalled()

      // session-2 outlives the reset window
      await vi.advanceTimersByTimeAsync(60000)

      captured.listener?.({ sessionId: "session-2", detail: "died a third time, well after recovering" })
      await flushMicrotasks()

      expect(unrecoverable).not.toHaveBeenCalled()
      expect(handle.src).toHaveBeenCalledWith(
        expect.objectContaining({ src: "http://127.0.0.1/live/session-3" }),
      )

      switcher.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores a stall recovery call while a mid-play restart is already in flight", async () => {
    const handle = createFakeHandle()
    const { trackDefault } = makeTracks()
    const captured: { listener: ((payload: { sessionId: string; detail: string }) => void) | null } = { listener: null }
    onVodAudioErrorMock.mockImplementation((listener: (payload: { sessionId: string; detail: string }) => void) => {
      captured.listener = listener
      return () => {}
    })
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-0",
      playbackUrl: "http://127.0.0.1/live/session-0",
    })
    const restartDeferred = deferred<{ sessionId: string; playbackUrl: string }>()
    startVodAudioRemuxMock.mockReturnValueOnce(restartDeferred.promise)
    const unrecoverable = vi.fn()

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee-token/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      remuxInputUrl: "http://127.0.0.1/tee-token/stream.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault],
      mountRemuxImmediately: true,
      onRemuxUnrecoverable: unrecoverable,
    })
    await flushMicrotasks()

    // a restart is left unresolved in flight
    captured.listener?.({ sessionId: "session-0", detail: "died mid-play" })
    await flushMicrotasks()
    const registerCallCountWhileInFlight = startVodAudioRemuxMock.mock.calls.length

    // the watchdog's recovery must no-op instead of racing a second register
    switcher.recoverRemuxStall()
    await flushMicrotasks()
    expect(startVodAudioRemuxMock.mock.calls.length).toBe(registerCallCountWhileInFlight)

    restartDeferred.resolve({ sessionId: "session-1", playbackUrl: "http://127.0.0.1/live/session-1" })
    await flushMicrotasks()
    expect(handle.src).toHaveBeenCalledWith(
      expect.objectContaining({ src: "http://127.0.0.1/live/session-1" }),
    )

    switcher.dispose()
  })

  it("isRecovering reflects a mid-play restart in flight and settles once it resolves", async () => {
    const handle = createFakeHandle()
    const { trackDefault } = makeTracks()
    const captured: { listener: ((payload: { sessionId: string; detail: string }) => void) | null } = { listener: null }
    onVodAudioErrorMock.mockImplementation((listener: (payload: { sessionId: string; detail: string }) => void) => {
      captured.listener = listener
      return () => {}
    })
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-0",
      playbackUrl: "http://127.0.0.1/live/session-0",
    })
    const restartDeferred = deferred<{ sessionId: string; playbackUrl: string }>()
    startVodAudioRemuxMock.mockReturnValueOnce(restartDeferred.promise)

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee-token/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      remuxInputUrl: "http://127.0.0.1/tee-token/stream.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault],
      mountRemuxImmediately: true,
    })
    await flushMicrotasks()
    expect(switcher.isRecovering()).toBe(false)

    captured.listener?.({ sessionId: "session-0", detail: "died mid-play" })
    await flushMicrotasks()
    expect(switcher.isRecovering()).toBe(true)

    restartDeferred.resolve({ sessionId: "session-1", playbackUrl: "http://127.0.0.1/live/session-1" })
    await flushMicrotasks()
    expect(switcher.isRecovering()).toBe(false)

    switcher.dispose()
  })

  it("recoverRemuxStall no-ops without an active session or outside the mandatory remux path", async () => {
    const handle = createFakeHandle()
    const { trackDefault, trackA } = makeTracks()

    const directSwitcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "https://host.example/movie.mp4",
      originalMime: "video/mp4",
      sourceUrl: "https://host.example/movie.mp4",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault, trackA],
    })
    directSwitcher.recoverRemuxStall()
    expect(startVodAudioRemuxMock).not.toHaveBeenCalled()
    directSwitcher.dispose()

    startVodAudioRemuxMock.mockResolvedValueOnce(null)
    const unrecoverable = vi.fn()
    const remuxSwitcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee-token/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault],
      mountRemuxImmediately: true,
      onRemuxUnrecoverable: unrecoverable,
    })
    await flushMicrotasks()
    // Registration failed, so there is no active session to restart.
    const registerCallCount = startVodAudioRemuxMock.mock.calls.length
    remuxSwitcher.recoverRemuxStall()
    await flushMicrotasks()
    expect(startVodAudioRemuxMock.mock.calls.length).toBe(registerCallCount)

    remuxSwitcher.dispose()
  })

  it("reports an unrecoverable failure when the mandatory remux never registers", async () => {
    const handle = createFakeHandle()
    const { trackDefault } = makeTracks()
    startVodAudioRemuxMock.mockResolvedValueOnce(null)
    const unrecoverable = vi.fn()

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee-token/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault],
      mountRemuxImmediately: true,
      onRemuxUnrecoverable: unrecoverable,
    })
    await flushMicrotasks()

    expect(unrecoverable).toHaveBeenCalledTimes(1)
    expect(handle.src).not.toHaveBeenCalled()

    switcher.dispose()
  })

  it("still falls back to the original audio mid-play when the container plays natively", async () => {
    const handle = createFakeHandle()
    const { trackDefault, trackA } = makeTracks()
    const captured: { listener: ((payload: { sessionId: string; detail: string }) => void) | null } = { listener: null }
    onVodAudioErrorMock.mockImplementation((listener: (payload: { sessionId: string; detail: string }) => void) => {
      captured.listener = listener
      return () => {}
    })
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-a",
      playbackUrl: "http://127.0.0.1/live/session-a",
    })
    const unrecoverable = vi.fn()

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "https://host.example/movie.mp4",
      originalMime: "video/mp4",
      sourceUrl: "https://host.example/movie.mp4",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault, trackA],
      onRemuxUnrecoverable: unrecoverable,
    })

    switcher.source.select("a")
    await flushMicrotasks()

    captured.listener?.({ sessionId: "session-a", detail: "OTHER:ffmpeg exited with exit status: 1" })

    expect(unrecoverable).not.toHaveBeenCalled()
    expect(handle.src).toHaveBeenCalledWith(
      expect.objectContaining({ src: "https://host.example/movie.mp4" }),
    )

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

  // register_vod_audio_remux is one session at a time, so disposing during a switch tears the
  // old ffmpeg down and its error must not reach the caller's UI.
  it("detaches its error listener on dispose and reports nothing for a late error on its own session", async () => {
    const handle = createFakeHandle()
    const { trackDefault } = makeTracks()
    const captured: { listener: ((payload: { sessionId: string; detail: string }) => void) | null } = { listener: null }
    const unsubscribe = vi.fn()
    onVodAudioErrorMock.mockImplementation((listener: (payload: { sessionId: string; detail: string }) => void) => {
      captured.listener = listener
      return unsubscribe
    })
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-old",
      playbackUrl: "http://127.0.0.1/live/session-old",
    })
    const unrecoverable = vi.fn()

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee-old/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/episode2.mkv",
      remuxInputUrl: "http://127.0.0.1/tee-old/stream.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault],
      mountRemuxImmediately: true,
      onRemuxUnrecoverable: unrecoverable,
    })
    await flushMicrotasks()

    switcher.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const srcCallCountAfterDispose = handle.src.mock.calls.length

    // The unlisten round-trip is async on the Tauri side, so a late event can still land after dispose.
    captured.listener?.({ sessionId: "session-old", detail: "OTHER:ffmpeg exited with exit status: 255" })
    await flushMicrotasks()

    expect(unrecoverable).not.toHaveBeenCalled()
    expect(handle.src.mock.calls.length).toBe(srcCallCountAfterDispose)
  })

  it("ignores an error for a foreign session id", async () => {
    const handle = createFakeHandle()
    const { trackDefault } = makeTracks()
    const captured: { listener: ((payload: { sessionId: string; detail: string }) => void) | null } = { listener: null }
    onVodAudioErrorMock.mockImplementation((listener: (payload: { sessionId: string; detail: string }) => void) => {
      captured.listener = listener
      return () => {}
    })
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-mine",
      playbackUrl: "http://127.0.0.1/live/session-mine",
    })
    const unrecoverable = vi.fn()

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee-mine/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/episode3.mkv",
      remuxInputUrl: "http://127.0.0.1/tee-mine/stream.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [trackDefault],
      mountRemuxImmediately: true,
      onRemuxUnrecoverable: unrecoverable,
    })
    await flushMicrotasks()
    const srcCallCountBeforeError = handle.src.mock.calls.length

    captured.listener?.({ sessionId: "session-someone-else", detail: "OTHER:ffmpeg exited with exit status: 8" })
    await flushMicrotasks()

    expect(unrecoverable).not.toHaveBeenCalled()
    expect(handle.src.mock.calls.length).toBe(srcCallCountBeforeError)
    expect(stopVodAudioRemuxMock).not.toHaveBeenCalledWith("session-someone-else")

    switcher.dispose()
  })
})

describe("createVodAudioSwitcher.setTracks", () => {
  beforeEach(() => {
    startVodAudioRemuxMock.mockReset()
    stopVodAudioRemuxMock.mockReset()
    onVodAudioErrorMock.mockReset().mockImplementation(() => () => {})
  })

  it("replaces the synthetic default track with the discovered list and marks the currently playing stream active, without remounting", async () => {
    const handle = createFakeHandle()
    const { trackDefault, trackA, trackB } = makeTracks()
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-initial",
      playbackUrl: "http://127.0.0.1/live/session-initial",
    })

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      remuxInputUrl: "http://127.0.0.1/tee/stream.mkv",
      getKnownDurationSeconds: () => 100,
      // No tracks yet: the switcher mounts against the synthetic default (audioStreamIndex 0).
      tracks: [],
      mountRemuxImmediately: true,
    })
    await flushMicrotasks()
    const srcCallCountBeforeSetTracks = handle.src.mock.calls.length

    // trackDefault also has audioStreamIndex 0, so it matches what the synthetic default was streaming.
    switcher.setTracks([trackDefault, trackA, trackB])

    const list = switcher.source.list()
    expect(list.map((track) => track.id)).toEqual(["default", "a", "b"])
    expect(list.find((track) => track.active)?.id).toBe("default")
    expect(handle.src.mock.calls.length).toBe(srcCallCountBeforeSetTracks)

    switcher.dispose()
  })

  it("ignores an empty track list", async () => {
    const handle = createFakeHandle()
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-initial",
      playbackUrl: "http://127.0.0.1/live/session-initial",
    })

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      remuxInputUrl: "http://127.0.0.1/tee/stream.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [],
      mountRemuxImmediately: true,
    })
    await flushMicrotasks()

    switcher.setTracks([])

    expect(switcher.source.list().map((track) => track.id)).toEqual(["default"])

    switcher.dispose()
  })

  it("is a no-op after dispose", async () => {
    const handle = createFakeHandle()
    const { trackDefault, trackA, trackB } = makeTracks()
    startVodAudioRemuxMock.mockResolvedValueOnce({
      sessionId: "session-initial",
      playbackUrl: "http://127.0.0.1/live/session-initial",
    })

    const switcher = createVodAudioSwitcher({
      handle: handle as any,
      originalSrc: "http://127.0.0.1/tee/stream.mkv",
      originalMime: "video/x-matroska",
      sourceUrl: "https://host.example/movie.mkv",
      remuxInputUrl: "http://127.0.0.1/tee/stream.mkv",
      getKnownDurationSeconds: () => 100,
      tracks: [],
      mountRemuxImmediately: true,
    })
    await flushMicrotasks()
    switcher.dispose()

    switcher.setTracks([trackDefault, trackA, trackB])

    expect(switcher.source.list().map((track) => track.id)).toEqual(["default"])
  })
})
