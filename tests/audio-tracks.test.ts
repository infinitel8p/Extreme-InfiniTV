import { describe, it, expect, vi } from "vitest"
import {
  labelAudioTracks,
  createHlsAudioSource,
  createShakaAudioSource,
  attachArtplayerAudioControl,
} from "../src/scripts/lib/audio-tracks"

describe("labelAudioTracks", () => {
  it("uses the provided name directly when no language is present", () => {
    const labels = labelAudioTracks([{ id: "1", name: "Director's commentary", active: false }])
    expect(labels[0]).toEqual({
      id: "1",
      label: "Director's commentary",
      language: null,
      active: false,
    })
  })

  it("maps a language code to a localized display name when no name is given", () => {
    const labels = labelAudioTracks([{ id: "1", language: "en", active: true }], "en")
    expect(labels[0].label).toContain("English")
    expect(labels[0].active).toBe(true)
  })

  it("falls back to 'Audio N' by position when name and language are missing", () => {
    const labels = labelAudioTracks([
      { id: "1", active: false },
      { id: "2", active: true },
    ])
    expect(labels.map((track) => track.label)).toEqual(["Audio 1", "Audio 2"])
  })

  it("folds an unrelated name into the resolved language display name (Surround case)", () => {
    const labels = labelAudioTracks(
      [{ id: "1", name: "Surround", language: "hi", active: false }],
      "en",
    )
    expect(labels[0].label).toBe("Hindi (Surround)")
  })

  it("uses the name alone when it is a superset of the language display name", () => {
    const labels = labelAudioTracks(
      [{ id: "1", name: "English 5.1", language: "en", active: false }],
      "en",
    )
    expect(labels[0].label).toBe("English 5.1")
  })

  it("uses the language display name alone when the name is identical", () => {
    const labels = labelAudioTracks(
      [{ id: "1", name: "English", language: "en", active: false }],
      "en",
    )
    expect(labels[0].label).toBe("English")
  })

  it("uses the language display name alone when the name is a redundant subset", () => {
    const labels = labelAudioTracks(
      [{ id: "1", name: "Eng", language: "en", active: false }],
      "en",
    )
    expect(labels[0].label).toBe("English")
  })

  it("suffixes duplicate labels with an incrementing counter", () => {
    const labels = labelAudioTracks([
      { id: "1", name: "Stereo", active: false },
      { id: "2", name: "Stereo", active: false },
      { id: "3", name: "Stereo", active: true },
    ])
    expect(labels.map((track) => track.label)).toEqual(["Stereo", "Stereo 2", "Stereo 3"])
  })

  it("distinguishes same-name tracks by language instead of an incrementing suffix", () => {
    const labels = labelAudioTracks(
      [
        { id: "1", name: "Surround", language: "hi", active: false },
        { id: "2", name: "Surround", language: "en", active: true },
      ],
      "en",
    )
    expect(labels.map((track) => track.label)).toEqual(["Hindi (Surround)", "English (Surround)"])
  })

  it("propagates the active flag per track", () => {
    const labels = labelAudioTracks([
      { id: "1", name: "English", active: false },
      { id: "2", name: "Spanish", active: true },
    ])
    expect(labels.map((track) => track.active)).toEqual([false, true])
  })
})

function createFakeHls(initialTracks: any[], initialIndex: number) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    audioTracks: initialTracks,
    audioTrack: initialIndex,
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn)
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }
}

describe("createHlsAudioSource", () => {
  it("lists tracks built from hls.audioTracks with the active index flagged", () => {
    const hls = createFakeHls(
      [
        { id: 0, name: "English", lang: "en" },
        { id: 1, name: "Spanish", lang: "es" },
      ],
      0,
    )
    const source = createHlsAudioSource(hls)
    const tracks = source.list()
    expect(tracks).toEqual([
      { id: "0", label: "English", language: "en", active: true },
      { id: "1", label: "Spanish", language: "es", active: false },
    ])
  })

  it("select() sets hls.audioTrack to the matching index", () => {
    const hls = createFakeHls(
      [
        { id: 0, name: "English", lang: "en" },
        { id: 1, name: "Spanish", lang: "es" },
      ],
      0,
    )
    const source = createHlsAudioSource(hls)
    source.select("1")
    expect(hls.audioTrack).toBe(1)
  })

  it("subscribe() fires the listener when hls emits hlsAudioTracksUpdated", () => {
    const hls = createFakeHls([{ id: 0, name: "English", lang: "en" }], 0)
    const source = createHlsAudioSource(hls)
    const listener = vi.fn()
    source.subscribe(listener)
    hls.emit("hlsAudioTracksUpdated")
    expect(listener).toHaveBeenCalledTimes(1)
    hls.emit("hlsAudioTrackSwitched")
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("unsubscribe stops further notifications", () => {
    const hls = createFakeHls([{ id: 0, name: "English", lang: "en" }], 0)
    const source = createHlsAudioSource(hls)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    unsubscribe()
    hls.emit("hlsAudioTracksUpdated")
    expect(listener).not.toHaveBeenCalled()
  })

  it("dispose() removes the hls event listeners", () => {
    const hls = createFakeHls([{ id: 0, name: "English", lang: "en" }], 0)
    const source = createHlsAudioSource(hls)
    const listener = vi.fn()
    source.subscribe(listener)
    source.dispose()
    hls.emit("hlsAudioTracksUpdated")
    expect(listener).not.toHaveBeenCalled()
  })
})

function createFakeShakaPlayer(tracks: any[]) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    getAudioTracks: () => tracks,
    selectAudioTrack: vi.fn(),
    addEventListener(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    removeEventListener(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn)
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }
}

describe("createShakaAudioSource", () => {
  it("retains a safe forward buffer while switching with the audio-track API", () => {
    const tracks = [
      { id: "a", label: "English", language: "en", active: true },
      { id: "b", label: "Italian", language: "it", active: false },
    ]
    const player = createFakeShakaPlayer(tracks)
    const source = createShakaAudioSource(player)

    source.select("b")

    expect(player.selectAudioTrack).toHaveBeenCalledWith(tracks[1], 4)
  })

  it("retains the same safe margin with Shaka's legacy variant API", () => {
    const variants = [
      { id: 10, audioId: "a", language: "en", roles: [], active: true },
      { id: 20, audioId: "b", language: "it", roles: [], active: false },
    ]
    const player = {
      getVariantTracks: () => variants,
      selectAudioLanguage: vi.fn(),
      selectVariantTrack: vi.fn(),
      configure: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const source = createShakaAudioSource(player)

    source.select("b")

    expect(player.selectAudioLanguage).toHaveBeenCalledWith("it", undefined)
    expect(player.selectVariantTrack).toHaveBeenCalledWith(variants[1], true, 4)
  })

  it("suppresses notify for an event whose track list signature is unchanged (video-only adaptation)", () => {
    const tracks = [
      { id: "a", label: "English", language: "en", active: true },
      { id: "b", label: "Spanish", language: "es", active: false },
    ]
    const player = createFakeShakaPlayer(tracks)
    const source = createShakaAudioSource(player)
    const listener = vi.fn()
    source.subscribe(listener)
    player.emit("adaptation")
    expect(listener).not.toHaveBeenCalled()
  })

  it("notifies when the active track changes", () => {
    const tracks = [
      { id: "a", label: "English", language: "en", active: true },
      { id: "b", label: "Spanish", language: "es", active: false },
    ]
    const player = createFakeShakaPlayer(tracks)
    const source = createShakaAudioSource(player)
    const listener = vi.fn()
    source.subscribe(listener)
    tracks[0].active = false
    tracks[1].active = true
    player.emit("variantchanged")
    expect(listener).toHaveBeenCalledTimes(1)
    player.emit("adaptation")
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("attachArtplayerAudioControl", () => {
  function createFakeArt() {
    return {
      isReady: true,
      controls: { add: vi.fn(), remove: vi.fn() },
      on: vi.fn(),
    }
  }

  function createFakeSource(tracks: { id: string; label: string; language: string | null; active: boolean }[]) {
    return {
      list: () => tracks,
      select: vi.fn(),
      subscribe: () => () => {},
      dispose: vi.fn(),
    }
  }

  it("disposes the previous source when a new one is set", () => {
    const art = createFakeArt()
    const control = attachArtplayerAudioControl(art, (key) => key)
    const firstSource = createFakeSource([
      { id: "1", label: "English", language: "en", active: true },
      { id: "2", label: "Spanish", language: "es", active: false },
    ])
    const secondSource = createFakeSource([
      { id: "1", label: "English", language: "en", active: true },
      { id: "2", label: "German", language: "de", active: false },
    ])
    control.setSource(firstSource as any)
    control.setSource(secondSource as any)
    expect(firstSource.dispose).toHaveBeenCalledTimes(1)
    expect(secondSource.dispose).not.toHaveBeenCalled()
  })

  it("registers the ready listener once and adds the control with the latest tracks", () => {
    const readyHandlers: (() => void)[] = []
    const art = {
      isReady: false,
      controls: { add: vi.fn(), remove: vi.fn() },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "ready") readyHandlers.push(handler)
      }),
    }
    const control = attachArtplayerAudioControl(art as any, (key) => key)
    control.setSource(createFakeSource([
      { id: "1", label: "English", language: "en", active: true },
      { id: "2", label: "Spanish", language: "es", active: false },
    ]) as any)
    control.setSource(createFakeSource([
      { id: "1", label: "English", language: "en", active: true },
      { id: "2", label: "German", language: "de", active: false },
    ]) as any)
    expect(readyHandlers).toHaveLength(1)
    art.isReady = true
    for (const handler of readyHandlers) handler()
    expect(art.controls.add).toHaveBeenCalledTimes(1)
    const selector = art.controls.add.mock.calls[0][0].selector
    expect(selector.map((item: { html: string }) => item.html)).toEqual(["English", "German"])
  })

  it("disposes the active source on dispose()", () => {
    const art = createFakeArt()
    const control = attachArtplayerAudioControl(art, (key) => key)
    const source = createFakeSource([
      { id: "1", label: "English", language: "en", active: true },
      { id: "2", label: "Spanish", language: "es", active: false },
    ])
    control.setSource(source as any)
    control.dispose()
    expect(source.dispose).toHaveBeenCalledTimes(1)
  })
})
