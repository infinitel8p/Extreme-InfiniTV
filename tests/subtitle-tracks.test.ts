import { describe, it, expect, beforeEach, vi } from "vitest"
import { createSubtitleManager, createNativeTrackRegistrar } from "../src/scripts/lib/subtitle-tracks"
import type { MkvCue, MkvSubtitleSession, MkvSubtitleTrackInfo } from "../src/scripts/lib/vod-proxy"

class FakeVTTCue {
  constructor(
    public startTime: number,
    public endTime: number,
    public text: string,
  ) {}
}

class FakeTextTrack {
  mode: TextTrackMode = "disabled"
  private cueList: FakeVTTCue[] = []
  constructor(
    public kind: string,
    public label: string,
    public language: string,
  ) {}
  get cues(): FakeVTTCue[] | null {
    return this.mode === "disabled" ? null : this.cueList
  }
  addCue(cue: FakeVTTCue): void {
    this.cueList.push(cue)
  }
  removeCue(cue: FakeVTTCue): void {
    this.cueList = this.cueList.filter((entry) => entry !== cue)
  }
  visibleTexts(): string[] {
    return this.mode === "showing" ? this.cueList.map((cue) => cue.text) : []
  }
}

class FakeVideo {
  textTracks = new EventTarget()
  tracks: FakeTextTrack[] = []
  addTextTrack(kind: string, label: string, language: string): FakeTextTrack {
    const track = new FakeTextTrack(kind, label, language)
    this.tracks.push(track)
    return track
  }
}

function createFakeMkvSession(trackInfos: MkvSubtitleTrackInfo[]) {
  const history: Array<{ trackNumber: number; cues: MkvCue[] }> = []
  let listener: ((trackNumber: number, cues: MkvCue[]) => void) | null = null
  const session: MkvSubtitleSession = {
    tracks: async () => trackInfos,
    audioTracks: async () => [],
    onCues(next) {
      listener = next
      for (const batch of history) next(batch.trackNumber, batch.cues)
    },
    stop() {},
  }
  return {
    session,
    emit(trackNumber: number, cues: MkvCue[]) {
      history.push({ trackNumber, cues })
      listener?.(trackNumber, cues)
    },
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("createSubtitleManager MKV push cues", () => {
  let video: FakeVideo

  beforeEach(() => {
    video = new FakeVideo()
    vi.stubGlobal("window", { VTTCue: FakeVTTCue })
  })

  function mountManager() {
    const readyTracks: { index: number; label: string; language: string }[][] = []
    const activeIndexes: number[] = []
    const manager = createSubtitleManager({
      registrar: createNativeTrackRegistrar(() => video as unknown as HTMLVideoElement),
      getCurrentTime: () => 0,
      onTracksReady: (tracks, activeIndex) => {
        readyTracks.push(tracks)
        activeIndexes.push(activeIndex)
      },
    })
    return { manager, readyTracks, activeIndexes }
  }

  it("shows cues buffered while the track was off once it is enabled", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "before enabling" }])

    manager.select(0)
    expect(video.tracks[0]!.visibleTexts()).toEqual(["before enabling"])
  })

  it("keeps cues reaching the enabled track after a same-session remount", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager, readyTracks } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "scanned before the switch" }])
    manager.select(0)
    expect(video.tracks[0]!.visibleTexts()).toEqual(["scanned before the switch"])

    manager.setSource("http://127.0.0.1:2/remux/stream.ts", "video/mp2t", session)
    await flush()
    emit(2, [{ startMs: 8000, endMs: 9000, text: "scanned after the switch" }])

    const remountedIndex = readyTracks.at(-1)![0]!.index
    manager.select(remountedIndex)
    const enabled = video.tracks.filter((track) => track.mode === "showing")
    expect(enabled).toHaveLength(1)
    expect(enabled[0]!.visibleTexts()).toEqual([
      "scanned before the switch",
      "scanned after the switch",
    ])
  })

  it("keeps the enabled track showing across a remount of the same session", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
      { number: 3, codec: "S_TEXT/UTF8", language: "fre", name: null },
    ])
    const { manager, readyTracks } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    manager.select(1)
    emit(3, [{ startMs: 1000, endMs: 2000, text: "french cue" }])

    manager.setSource("http://127.0.0.1:2/remux/stream.ts", "video/mp2t", session)
    await flush()

    const showing = video.tracks.filter((track) => track.mode === "showing")
    expect(showing).toHaveLength(1)
    expect(showing[0]!.language).toBe("fre")
    expect(showing[0]!.visibleTexts()).toEqual(["french cue"])
    expect(readyTracks.at(-1)).toEqual([
      { index: 0, label: "English", language: "eng" },
      { index: 1, label: "French", language: "fre" },
    ])
  })

  it("reports the carried-over selection to onTracksReady, and -1 on a fresh source", async () => {
    const trackInfos = [{ number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null }]
    const first = createFakeMkvSession(trackInfos)
    const second = createFakeMkvSession(trackInfos)
    const { manager, activeIndexes } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", first.session)
    await flush()
    manager.select(0)
    manager.setSource("http://127.0.0.1:2/remux/stream.ts", "video/mp2t", first.session)
    await flush()
    manager.setSource("http://127.0.0.1:3/tee/other.mkv", "video/x-matroska", second.session)
    await flush()

    expect(activeIndexes).toEqual([-1, 0, -1])
  })

  it("starts a different session with subtitles off", async () => {
    const first = createFakeMkvSession([{ number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null }])
    const second = createFakeMkvSession([{ number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null }])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", first.session)
    await flush()
    manager.select(0)

    manager.setSource("http://127.0.0.1:2/tee/other.mkv", "video/x-matroska", second.session)
    await flush()
    expect(video.tracks.filter((track) => track.mode === "showing")).toHaveLength(0)
  })

  it("stays off after a remount when the viewer turned subtitles off", async () => {
    const { session } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    manager.select(0)
    manager.select(-1)

    manager.setSource("http://127.0.0.1:2/remux/stream.ts", "video/mp2t", session)
    await flush()
    expect(video.tracks.filter((track) => track.mode === "showing")).toHaveLength(0)
  })

  it("forgets the selection once the player detaches", async () => {
    const { session } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    manager.select(0)
    manager.detach()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    expect(video.tracks.filter((track) => track.mode === "showing")).toHaveLength(0)
  })

  it("does not duplicate a cue delivered both by the history replay and live", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "only once" }])
    manager.setSource("http://127.0.0.1:2/remux/stream.ts", "video/mp2t", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "only once" }])

    manager.select(0)
    const enabled = video.tracks.filter((track) => track.mode === "showing")
    expect(enabled[0]!.visibleTexts()).toEqual(["only once"])
  })
})
