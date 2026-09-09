import { describe, it, expect } from "vitest"
import { applyExternalFrame, type ExternalSession } from "@/scripts/lib/external-progress"
import type { ExternalPlayerStateFrame } from "@/scripts/lib/player-runtime"

function baseSession(overrides: Partial<ExternalSession> = {}): ExternalSession {
  return {
    sessionId: "session-1",
    kind: "mpv",
    src: "https://provider.tld/movie/u/p/123.mp4",
    playlistId: "playlist-1",
    contentKind: "vod",
    contentId: "123",
    extras: { name: "The Movie", logo: null },
    startedAt: Date.now(),
    ...overrides,
  }
}

function baseFrame(overrides: Partial<ExternalPlayerStateFrame> = {}): ExternalPlayerStateFrame {
  return {
    sessionId: "session-1",
    kind: "mpv",
    path: null,
    position: null,
    duration: null,
    audio: null,
    sub: null,
    subOff: false,
    tracks: null,
    eof: false,
    final: false,
    ...overrides,
  }
}

const noPrefs = { getTrackPrefs: () => null }

describe("applyExternalFrame", () => {
  it("writes progress when position and duration are sane", () => {
    const session = baseSession()
    const result = applyExternalFrame(session, baseFrame({ position: 30, duration: 1200 }), noPrefs)
    expect(result.session).toEqual(session)
    expect(result.writes).toEqual([{ type: "progress", position: 30, duration: 1200 }])
  })

  it("marks completed on an eof frame even without a sane duration", () => {
    const session = baseSession()
    const result = applyExternalFrame(session, baseFrame({ eof: true }), noPrefs)
    expect(result.writes).toContainEqual({ type: "completed", duration: 0 })
  })

  it("marks completed at 95% progress without eof", () => {
    const session = baseSession()
    const result = applyExternalFrame(session, baseFrame({ position: 1150, duration: 1200 }), noPrefs)
    expect(result.writes).toContainEqual({ type: "progress", position: 1150, duration: 1200 })
    expect(result.writes).toContainEqual({ type: "completed", duration: 1200 })
  })

  it("does not mark completed below the 95% threshold", () => {
    const session = baseSession()
    const result = applyExternalFrame(session, baseFrame({ position: 600, duration: 1200 }), noPrefs)
    expect(result.writes.some((write) => write.type === "completed")).toBe(false)
  })

  it("ignores a frame carrying a foreign sessionId", () => {
    const session = baseSession()
    const result = applyExternalFrame(
      session,
      baseFrame({ sessionId: "other-session", position: 30, duration: 1200 }),
      noPrefs,
    )
    expect(result.session).toEqual(session)
    expect(result.writes).toEqual([])
  })

  it("ignores a path mismatch and keeps the session", () => {
    const session = baseSession()
    const result = applyExternalFrame(
      session,
      baseFrame({ path: "https://provider.tld/movie/u/p/456.mp4", position: 30, duration: 1200 }),
      noPrefs,
    )
    expect(result.session).toEqual(session)
    expect(result.writes).toEqual([])
  })

  it("tolerates a trailing-slash-only difference between path and src", () => {
    const session = baseSession({ src: "https://provider.tld/movie/u/p/123.mp4/" })
    const result = applyExternalFrame(
      session,
      baseFrame({ path: "https://provider.tld/movie/u/p/123.mp4", position: 30, duration: 1200 }),
      noPrefs,
    )
    expect(result.session).not.toBeNull()
  })

  it("ignores frames on a stale (12h+) session", () => {
    const session = baseSession({ startedAt: Date.now() - 13 * 60 * 60 * 1000 })
    const result = applyExternalFrame(session, baseFrame({ position: 30, duration: 1200 }), noPrefs)
    expect(result.session).toEqual(session)
    expect(result.writes).toEqual([])
  })

  it("corrects the audio/sub track to the stored preference on the first tracks frame", () => {
    const session = baseSession()
    const deps = {
      getTrackPrefs: () => ({
        audioLang: "de",
        audioId: null,
        audioTitle: null,
        subLang: null,
        subId: null,
        subTitle: null,
        subOff: false,
      }),
    }
    const frame = baseFrame({
      tracks: [
        { type: "audio" as const, id: 1, lang: "en", title: null, selected: true },
        { type: "audio" as const, id: 2, lang: "de", title: null, selected: false },
      ],
    })
    const result = applyExternalFrame(session, frame, deps)
    expect(result.writes).toContainEqual({ type: "setProperty", name: "aid", value: 2 })
    expect(result.session?.trackCorrected).toBe(true)
  })

  it("skips the setProperty write when the picked track is already selected", () => {
    const session = baseSession()
    const deps = {
      getTrackPrefs: () => ({
        audioLang: "en",
        audioId: null,
        audioTitle: null,
        subLang: null,
        subId: null,
        subTitle: null,
        subOff: false,
      }),
    }
    const frame = baseFrame({
      tracks: [{ type: "audio" as const, id: 1, lang: "en", title: null, selected: true }],
    })
    const result = applyExternalFrame(session, frame, deps)
    expect(result.writes.some((write) => write.type === "setProperty")).toBe(false)
    expect(result.session?.trackCorrected).toBe(true)
  })

  it("turns subtitles off when the stored preference has subOff set", () => {
    const session = baseSession()
    const deps = {
      getTrackPrefs: () => ({
        audioLang: null,
        audioId: null,
        audioTitle: null,
        subLang: null,
        subId: null,
        subTitle: null,
        subOff: true,
      }),
    }
    const frame = baseFrame({
      tracks: [{ type: "sub" as const, id: 1, lang: "en", title: null, selected: true }],
    })
    const result = applyExternalFrame(session, frame, deps)
    expect(result.writes).toContainEqual({ type: "setProperty", name: "sid", value: "no" })
  })

  it("does not record a tracks patch on the correcting frame itself", () => {
    const session = baseSession()
    const deps = { getTrackPrefs: () => null }
    const frame = baseFrame({
      tracks: [{ type: "audio" as const, id: 1, lang: "en", title: "English", selected: true }],
      audio: { id: 1, lang: "en", title: "English" },
    })
    const result = applyExternalFrame(session, frame, deps)
    expect(result.writes.some((write) => write.type === "tracks")).toBe(false)
    expect(result.session?.trackCorrected).toBe(true)
  })

  it("sets the lastSeen baseline on the first post-correction frame without writing", () => {
    const correctedSession = baseSession({ trackCorrected: true })
    const frame = baseFrame({ audio: { id: 1, lang: "en", title: "English" } })
    const result = applyExternalFrame(correctedSession, frame, noPrefs)
    expect(result.writes).toEqual([])
    expect(result.session?.lastSeenAudioId).toBe(1)
    expect(result.session?.lastSeenSubId).toBeNull()
  })

  it("writes nothing when the next frame repeats the same tracks", () => {
    const session = baseSession({ trackCorrected: true, lastSeenAudioId: 1, lastSeenSubId: null })
    const frame = baseFrame({ audio: { id: 1, lang: "en", title: "English" } })
    const result = applyExternalFrame(session, frame, noPrefs)
    expect(result.writes).toEqual([])
  })

  it("records a tracks patch when the sub id changes after the baseline is set", () => {
    const session = baseSession({ trackCorrected: true, lastSeenAudioId: 1, lastSeenSubId: null })
    const frame = baseFrame({ sub: { id: 5, lang: "de", title: "German" } })
    const result = applyExternalFrame(session, frame, noPrefs)
    expect(result.writes).toContainEqual({
      type: "tracks",
      patch: { subLang: "de", subId: 5, subTitle: "German", subOff: false },
    })
  })

  it("records subOff true when subtitles are turned off after a sub was selected", () => {
    const session = baseSession({ trackCorrected: true, lastSeenAudioId: 1, lastSeenSubId: 5 })
    const frame = baseFrame({ audio: { id: 1, lang: "en", title: "English" }, sub: null, subOff: true })
    const result = applyExternalFrame(session, frame, noPrefs)
    expect(result.writes).toContainEqual(
      expect.objectContaining({ type: "tracks", patch: expect.objectContaining({ subOff: true }) }),
    )
  })
})
