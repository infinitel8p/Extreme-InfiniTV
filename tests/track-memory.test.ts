/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Node 24+ ships an experimental native `localStorage` (undefined without
// --localstorage-file) that shadows jsdom's; stub it with a real in-memory Storage.
const localStorageStore = new Map<string, string>()
const localStorageMock: Storage = {
  getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
  setItem: (key, value) => {
    localStorageStore.set(key, String(value))
  },
  removeItem: (key) => {
    localStorageStore.delete(key)
  },
  clear: () => {
    localStorageStore.clear()
  },
  key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
  get length() {
    return localStorageStore.size
  },
}

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import { clearForPlaylist } from "@/scripts/lib/preferences.js"
import {
  readTrackMemory,
  rememberAudioTrack,
  rememberSubtitleTrack,
  chooseAudioTrackId,
  chooseSubtitleTrackId,
  type TrackMemoryContext,
} from "@/scripts/lib/track-memory.ts"

const ctx: TrackMemoryContext = { playlistId: "playlist-a", kind: "vod", id: "1" }

describe("track-memory", () => {
  afterEach(() => {
    clearForPlaylist("playlist-a")
  })

  it("returns null with no context or no stored memory", () => {
    expect(readTrackMemory(null)).toBeNull()
    expect(readTrackMemory(ctx)).toBeNull()
  })

  it("no-ops remembering with a null context", () => {
    expect(() => rememberAudioTrack(null, { id: 1, lang: "en", title: "English" })).not.toThrow()
    expect(readTrackMemory(ctx)).toBeNull()
  })

  it("remembers an audio pick, normalizing the language", () => {
    rememberAudioTrack(ctx, { id: 2, lang: "ENG", title: "English 5.1" })
    expect(readTrackMemory(ctx)).toMatchObject({
      audioLang: "en",
      audioId: 2,
      audioTitle: "English 5.1",
    })
  })

  it("remembers a subtitle pick and remembers subtitles off separately", () => {
    rememberSubtitleTrack(ctx, { id: 3, lang: "fre", title: "French" })
    expect(readTrackMemory(ctx)).toMatchObject({ subOff: false, subLang: "fr", subId: 3, subTitle: "French" })

    rememberSubtitleTrack(ctx, null)
    expect(readTrackMemory(ctx)).toMatchObject({ subOff: true, subLang: null, subId: null, subTitle: null })
  })

  describe("chooseAudioTrackId", () => {
    it("returns null with no memory", () => {
      expect(chooseAudioTrackId(ctx, [{ id: 0, lang: "en", title: null }])).toBeNull()
    })

    it("matches by language first, ignoring a stale id", () => {
      rememberAudioTrack(ctx, { id: 5, lang: "de", title: "German" })
      const candidates = [
        { id: 0, lang: "en", title: null },
        { id: 1, lang: "de", title: null },
      ]
      expect(chooseAudioTrackId(ctx, candidates)).toBe(1)
    })

    it("falls back to id when no language is stored", () => {
      rememberAudioTrack(ctx, { id: 1, lang: null, title: null })
      const candidates = [
        { id: 0, lang: null, title: null },
        { id: 1, lang: null, title: null },
      ]
      expect(chooseAudioTrackId(ctx, candidates)).toBe(1)
    })
  })

  describe("chooseSubtitleTrackId", () => {
    it("returns null with no memory", () => {
      expect(chooseSubtitleTrackId(ctx, [{ id: 0, lang: "en", title: null }])).toBeNull()
    })

    it("returns \"off\" when the viewer's remembered pick was subtitles off", () => {
      rememberSubtitleTrack(ctx, null)
      expect(chooseSubtitleTrackId(ctx, [{ id: 0, lang: "en", title: null }])).toBe("off")
    })

    it("matches a remembered subtitle track by language", () => {
      rememberSubtitleTrack(ctx, { id: 4, lang: "es", title: "Spanish" })
      const candidates = [
        { id: 0, lang: "en", title: null },
        { id: 1, lang: "es", title: null },
      ]
      expect(chooseSubtitleTrackId(ctx, candidates)).toBe(1)
    })

    it("returns null when the remembered language no longer has a match", () => {
      rememberSubtitleTrack(ctx, { id: 4, lang: "es", title: "Spanish" })
      expect(chooseSubtitleTrackId(ctx, [{ id: 0, lang: "en", title: null }])).toBeNull()
    })
  })
})
