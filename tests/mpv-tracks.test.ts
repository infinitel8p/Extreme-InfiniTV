import { describe, it, expect } from "vitest"
import {
  parseMpvAudioTracks,
  parseMpvSubtitleTracks,
  isMpvSubtitleActive,
  mpvTrackChoiceAvailable,
} from "../src/scripts/lib/mpv-tracks"

describe("parseMpvAudioTracks", () => {
  it("returns an empty list for an empty or missing track-list", () => {
    expect(parseMpvAudioTracks([], null)).toEqual([])
    expect(parseMpvAudioTracks(undefined, null)).toEqual([])
    expect(parseMpvAudioTracks(null, null)).toEqual([])
  })

  it("ignores non-audio track-list entries", () => {
    const trackList = [
      { id: 1, type: "video" },
      { id: 2, type: "sub", lang: "en" },
    ]
    expect(parseMpvAudioTracks(trackList, null)).toEqual([])
  })

  it("labels a track with no title and no language as a fallback", () => {
    const trackList = [{ id: 1, type: "audio" }]
    expect(parseMpvAudioTracks(trackList, null)).toEqual([
      { id: "1", label: "Audio 1", language: null, active: false },
    ])
  })

  it("marks the track matching the observed aid as active", () => {
    const trackList = [
      { id: 1, type: "audio", lang: "en" },
      { id: 2, type: "audio", lang: "de" },
    ]
    const tracks = parseMpvAudioTracks(trackList, 2, "en")
    expect(tracks.find((track) => track.id === "1")?.active).toBe(false)
    expect(tracks.find((track) => track.id === "2")?.active).toBe(true)
  })

  it("tolerates a numeric-string aid", () => {
    const trackList = [{ id: 3, type: "audio", lang: "fr" }]
    expect(parseMpvAudioTracks(trackList, "3")[0]?.active).toBe(true)
  })

  it("has no active track when aid is 'no' or missing", () => {
    const trackList = [{ id: 1, type: "audio" }]
    expect(parseMpvAudioTracks(trackList, "no")[0]?.active).toBe(false)
    expect(parseMpvAudioTracks(trackList, undefined)[0]?.active).toBe(false)
  })

  it("skips entries without a valid numeric id", () => {
    const trackList = [{ id: "not-a-number", type: "audio" }, { type: "audio" }]
    expect(parseMpvAudioTracks(trackList, null)).toEqual([])
  })
})

describe("parseMpvSubtitleTracks", () => {
  it("returns an empty list for an empty or missing track-list", () => {
    expect(parseMpvSubtitleTracks([], null)).toEqual([])
    expect(parseMpvSubtitleTracks(undefined, null)).toEqual([])
  })

  it("ignores non-subtitle track-list entries", () => {
    const trackList = [
      { id: 1, type: "video" },
      { id: 2, type: "audio", lang: "en" },
    ]
    expect(parseMpvSubtitleTracks(trackList, null)).toEqual([])
  })

  it("labels a track with no title and no language as Unknown", () => {
    const trackList = [{ id: 1, type: "sub" }]
    expect(parseMpvSubtitleTracks(trackList, null)).toEqual([{ id: 1, label: "Unknown", active: false }])
  })

  it("marks the track matching the observed sid as active", () => {
    const trackList = [
      { id: 1, type: "sub", lang: "en" },
      { id: 2, type: "sub", lang: "de" },
    ]
    const tracks = parseMpvSubtitleTracks(trackList, 2, "en")
    expect(tracks.find((track) => track.id === 1)?.active).toBe(false)
    expect(tracks.find((track) => track.id === 2)?.active).toBe(true)
  })

  it("has no active track when sid is 'no' (subtitles off)", () => {
    const trackList = [{ id: 1, type: "sub", lang: "en" }]
    expect(parseMpvSubtitleTracks(trackList, "no")[0]?.active).toBe(false)
  })

  it("skips entries without a valid numeric id", () => {
    const trackList = [{ id: "not-a-number", type: "sub" }, { type: "sub" }]
    expect(parseMpvSubtitleTracks(trackList, null)).toEqual([])
  })
})

describe("isMpvSubtitleActive", () => {
  it("is true for a numeric sid", () => {
    expect(isMpvSubtitleActive(1)).toBe(true)
    expect(isMpvSubtitleActive(0)).toBe(true)
  })

  it("is true for a numeric-string sid", () => {
    expect(isMpvSubtitleActive("2")).toBe(true)
  })

  it("is false for 'no', false, undefined, or null", () => {
    expect(isMpvSubtitleActive("no")).toBe(false)
    expect(isMpvSubtitleActive(false)).toBe(false)
    expect(isMpvSubtitleActive(undefined)).toBe(false)
    expect(isMpvSubtitleActive(null)).toBe(false)
  })
})

describe("mpvTrackChoiceAvailable", () => {
  it("needs at least 2 audio tracks to offer a choice", () => {
    const oneTrack = [{ id: 1, type: "audio" }]
    const twoTracks = [{ id: 1, type: "audio" }, { id: 2, type: "audio" }]
    expect(mpvTrackChoiceAvailable([], "audio")).toBe(false)
    expect(mpvTrackChoiceAvailable(oneTrack, "audio")).toBe(false)
    expect(mpvTrackChoiceAvailable(twoTracks, "audio")).toBe(true)
  })

  it("needs at least 1 subtitle track to offer a choice", () => {
    const oneTrack = [{ id: 1, type: "sub" }]
    expect(mpvTrackChoiceAvailable([], "sub")).toBe(false)
    expect(mpvTrackChoiceAvailable(oneTrack, "sub")).toBe(true)
  })

  it("ignores tracks of the other kind", () => {
    const videoOnly = [{ id: 1, type: "video" }]
    expect(mpvTrackChoiceAvailable(videoOnly, "audio")).toBe(false)
    expect(mpvTrackChoiceAvailable(videoOnly, "sub")).toBe(false)
  })

  it("treats a missing or malformed track-list as no choice", () => {
    expect(mpvTrackChoiceAvailable(null, "audio")).toBe(false)
    expect(mpvTrackChoiceAvailable(undefined, "sub")).toBe(false)
  })
})
