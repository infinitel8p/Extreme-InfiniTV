import { describe, it, expect, beforeEach, vi } from "vitest"
import { createSubtitleManager, createNativeTrackRegistrar } from "../src/scripts/lib/subtitle-tracks"
import type { MkvCue, MkvSubtitleSession, MkvSubtitleTrackInfo } from "../src/scripts/lib/vod-proxy"

// Setters trigger a resort, mirroring real TextTrackCueList's live time-sort.
class FakeVTTCue {
  onTimeChanged: (() => void) | null = null
  private startTimeValue: number
  private endTimeValue: number
  constructor(startTime: number, endTime: number, public text: string) {
    this.startTimeValue = startTime
    this.endTimeValue = endTime
  }
  get startTime(): number {
    return this.startTimeValue
  }
  set startTime(value: number) {
    this.startTimeValue = value
    this.onTimeChanged?.()
  }
  get endTime(): number {
    return this.endTimeValue
  }
  set endTime(value: number) {
    this.endTimeValue = value
    this.onTimeChanged?.()
  }
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
    cue.onTimeChanged = () => this.resort()
    this.cueList.push(cue)
    this.resort()
  }
  removeCue(cue: FakeVTTCue): void {
    this.cueList = this.cueList.filter((entry) => entry !== cue)
  }
  visibleTexts(): string[] {
    return this.mode === "showing" ? this.cueList.map((cue) => cue.text) : []
  }
  private resort(): void {
    // In-place sort: same array reference a caller's `cues` snapshot would already hold.
    this.cueList.sort((a, b) => a.startTime - b.startTime)
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

describe("createSubtitleManager subtitle delay", () => {
  let video: FakeVideo

  beforeEach(() => {
    video = new FakeVideo()
    vi.stubGlobal("window", { VTTCue: FakeVTTCue })
  })

  function mountManager() {
    const manager = createSubtitleManager({
      registrar: createNativeTrackRegistrar(() => video as unknown as HTMLVideoElement),
      getCurrentTime: () => 0,
    })
    return { manager }
  }

  it("returns null when no track is showing", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "hidden cue" }])

    expect(manager.nudgeDelay(0.1)).toBeNull()
  })

  it("shifts existing cues in place and accumulates the offset across calls", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "shifted cue" }])
    manager.select(0)

    expect(manager.nudgeDelay(0.1)).toBeCloseTo(0.1)
    const cue = video.tracks[0]!.cues![0]!
    expect(cue.startTime).toBeCloseTo(1.1)
    expect(cue.endTime).toBeCloseTo(3.1)

    expect(manager.nudgeDelay(-0.1)).toBeCloseTo(0)
    expect(cue.startTime).toBeCloseTo(1)
    expect(cue.endTime).toBeCloseTo(3)
  })

  it("applies the accumulated offset to cues added after a nudge", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "before nudge" }])
    manager.select(0)
    manager.nudgeDelay(0.2)

    emit(2, [{ startMs: 5000, endMs: 6000, text: "after nudge" }])
    const cues = video.tracks[0]!.cues!
    const lateCue = cues.find((entry) => entry.text === "after nudge")!
    expect(lateCue.startTime).toBeCloseTo(5.2)
    expect(lateCue.endTime).toBeCloseTo(6.2)
  })

  it("probes the accumulated offset with a zero delta without shifting cues", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "probed cue" }])
    manager.select(0)
    manager.nudgeDelay(0.3)

    expect(manager.nudgeDelay(0)).toBeCloseTo(0.3)
    const cue = video.tracks[0]!.cues![0]!
    expect(cue.startTime).toBeCloseTo(1.3)
    expect(cue.endTime).toBeCloseTo(3.3)
  })

  it("probe returns null when nothing is showing", async () => {
    const { manager } = mountManager()
    expect(manager.nudgeDelay(0)).toBeNull()
  })

  // FakeTextTrack.cues returns null while disabled, per the real TextTrack spec.
  it("shifts cues on a track that is currently disabled", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
      { number: 3, codec: "S_TEXT/UTF8", language: "fre", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    emit(2, [{ startMs: 1000, endMs: 3000, text: "english cue" }])
    emit(3, [{ startMs: 2000, endMs: 4000, text: "french cue" }])
    // select(1) then (0): flushes french's cues before it goes disabled.
    manager.select(1)
    manager.select(0)

    expect(manager.nudgeDelay(0.1)).toBeCloseTo(0.1)

    const frenchTrack = video.tracks[1]!
    expect(frenchTrack.mode).toBe("disabled")
    frenchTrack.mode = "hidden"
    const frenchCue = frenchTrack.cues![0]!
    expect(frenchCue.startTime).toBeCloseTo(2.1)
    expect(frenchCue.endTime).toBeCloseTo(4.1)
    frenchTrack.mode = "disabled"
  })

  it("shifts every cue exactly once per nudge even as the live list resorts mid-shift", async () => {
    const { session, emit } = createFakeMkvSession([
      { number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null },
    ])
    const { manager } = mountManager()

    manager.setSource("http://127.0.0.1:1/tee/stream.mkv", "video/x-matroska", session)
    await flush()
    // Tightly spaced so a same-direction shift crosses neighboring cues and forces a resort.
    const cueDefs = [
      { startMs: 1000, endMs: 1500, text: "cue A" },
      { startMs: 1050, endMs: 1550, text: "cue B" },
      { startMs: 1100, endMs: 1600, text: "cue C" },
      { startMs: 1150, endMs: 1650, text: "cue D" },
      { startMs: 1200, endMs: 1700, text: "cue E" },
    ]
    emit(2, cueDefs)
    manager.select(0)

    function startTimesByText(): Map<string, number> {
      const result = new Map<string, number>()
      for (const cue of video.tracks[0]!.cues!) result.set(cue.text, cue.startTime)
      return result
    }

    let accumulatedOffset = 0
    for (const delta of [0.2, 0.2, -0.35, -0.1]) {
      manager.nudgeDelay(delta)
      accumulatedOffset += delta
      const actual = startTimesByText()
      for (const cueDef of cueDefs) {
        expect(actual.get(cueDef.text)).toBeCloseTo(cueDef.startMs / 1000 + accumulatedOffset)
      }
    }
  })
})
