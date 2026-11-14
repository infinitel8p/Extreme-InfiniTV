import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getCaptionsAutoEnabled: vi.fn(() => false),
}))
vi.mock("@/scripts/lib/i18n.js", () => ({
  t: (key: string) => key,
  getActiveLocale: vi.fn(() => "en"),
}))
vi.mock("@/scripts/lib/toast.js", () => ({ toastError: vi.fn() }))

import { createSubtitleManager, type SubtitleRegistrar } from "../src/scripts/lib/subtitle-tracks"
import type { SubtitleCue } from "../src/scripts/lib/mp4-subtitles"

class FakeVTTCue {
  constructor(public startTime: number, public endTime: number, public text: string) {}
}

class FakeTextTrack {
  mode: TextTrackMode = "disabled"
  cueList: FakeVTTCue[] = []
  constructor(public label: string, public language: string) {}
  get cues(): FakeVTTCue[] | null {
    return this.mode === "disabled" ? null : this.cueList
  }
  addCue(cue: FakeVTTCue): void {
    this.cueList.push(cue)
  }
  removeCue(cue: FakeVTTCue): void {
    this.cueList = this.cueList.filter((entry) => entry !== cue)
  }
}

function createFakeRegistrar() {
  const tracks: FakeTextTrack[] = []
  const target = new EventTarget()
  const registrar: SubtitleRegistrar = {
    addTrack(label, language) {
      const track = new FakeTextTrack(label, language)
      tracks.push(track)
      return track as unknown as TextTrack
    },
    removeAllTracks() {
      tracks.length = 0
    },
    removeTrack(track) {
      const position = tracks.indexOf(track as unknown as FakeTextTrack)
      if (position >= 0) tracks.splice(position, 1)
    },
    trackListTarget() {
      return target
    },
  }
  return { registrar, tracks }
}

const sampleCues: SubtitleCue[] = [{ startSeconds: 1, endSeconds: 2, text: "Hi" }]

describe("createSubtitleManager external tracks", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { VTTCue: FakeVTTCue })
  })

  function mount() {
    const { registrar, tracks } = createFakeRegistrar()
    const ready: { index: number; label: string; language: string }[][] = []
    const manager = createSubtitleManager({
      registrar,
      getCurrentTime: () => 0,
      onTracksReady: (list) => ready.push(list),
    })
    return { manager, tracks, ready }
  }

  it("registers a track without any source and loads lazily on select", async () => {
    const { manager, tracks, ready } = mount()
    const load = vi.fn(async () => sampleCues)
    const id = manager.addExternalTrack({ label: "English", language: "en", load })
    expect(ready.at(-1)).toEqual([{ index: 0, label: "English", language: "en" }])
    expect(load).not.toHaveBeenCalled()

    expect(manager.selectExternal(id)).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    expect(tracks[0]!.cueList.map((cue) => cue.text)).toEqual(["Hi"])
  })

  it("does not reload after the cues are cached", async () => {
    const { manager } = mount()
    const load = vi.fn(async () => sampleCues)
    manager.addExternalTrack({ label: "English", language: "en", load })
    manager.select(0)
    await Promise.resolve()
    await Promise.resolve()
    manager.select(-1)
    manager.select(0)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("keeps externals and cached cues across setSource", async () => {
    const { manager, tracks } = mount()
    const load = vi.fn(async () => sampleCues)
    manager.addExternalTrack({ label: "English", language: "en", load })
    manager.select(0)
    await Promise.resolve()
    await Promise.resolve()

    manager.setSource(null)
    await manager.ready()
    expect(tracks).toHaveLength(1)
    manager.select(0)
    expect(tracks[0]!.cueList.map((cue) => cue.text)).toEqual(["Hi"])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("removeExternalTracks clears the list and refires onTracksReady", () => {
    const { manager, tracks, ready } = mount()
    manager.addExternalTrack({ label: "A", language: "en", load: async () => [] })
    manager.addExternalTrack({ label: "B", language: "de", load: async () => [] })
    expect(tracks).toHaveLength(2)
    manager.removeExternalTracks()
    expect(tracks).toHaveLength(0)
    expect(ready.at(-1)).toEqual([])
  })

  it("returns stable ids and resolves the index at select time", () => {
    const { manager, tracks } = mount()
    const first = manager.addExternalTrack({ label: "A", language: "en", load: async () => [] })
    const second = manager.addExternalTrack({ label: "B", language: "de", load: async () => [] })
    expect(second).not.toBe(first)
    expect(manager.selectExternal(second)).toBe(true)
    expect(tracks[1]!.mode).toBe("showing")
    expect(manager.selectExternal(9999)).toBe(false)
  })
})
