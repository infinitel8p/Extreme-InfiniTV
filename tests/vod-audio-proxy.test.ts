import { describe, it, expect } from "vitest"
import { shouldTranscodeVodAudio, peekVodAudioRemuxAvailable } from "../src/scripts/lib/vod-audio-proxy"

describe("shouldTranscodeVodAudio", () => {
  it("copies plain aac/mp3 codec ids", () => {
    expect(shouldTranscodeVodAudio("aac")).toBe(false)
    expect(shouldTranscodeVodAudio("mp3")).toBe(false)
  })

  it("copies Matroska AAC codec ids, including sub-variants", () => {
    expect(shouldTranscodeVodAudio("A_AAC")).toBe(false)
    expect(shouldTranscodeVodAudio("A_AAC/MPEG4/LC/SBR")).toBe(false)
  })

  it("copies the Matroska MP3 codec id", () => {
    expect(shouldTranscodeVodAudio("A_MPEG/L3")).toBe(false)
  })

  it("copies MP4 AAC codec ids, including object-type suffixes", () => {
    expect(shouldTranscodeVodAudio("mp4a")).toBe(false)
    expect(shouldTranscodeVodAudio("mp4a.40.2")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(shouldTranscodeVodAudio("AAC")).toBe(false)
    expect(shouldTranscodeVodAudio("Mp4A.40.2")).toBe(false)
    expect(shouldTranscodeVodAudio("a_aac")).toBe(false)
  })

  it("transcodes everything else", () => {
    expect(shouldTranscodeVodAudio("ac3")).toBe(true)
    expect(shouldTranscodeVodAudio("eac3")).toBe(true)
    expect(shouldTranscodeVodAudio("dts")).toBe(true)
    expect(shouldTranscodeVodAudio("opus")).toBe(true)
    expect(shouldTranscodeVodAudio("vorbis")).toBe(true)
    expect(shouldTranscodeVodAudio("flac")).toBe(true)
    expect(shouldTranscodeVodAudio("truehd")).toBe(true)
    expect(shouldTranscodeVodAudio("pcm")).toBe(true)
  })

  it("defaults an unknown/empty codec to true", () => {
    expect(shouldTranscodeVodAudio("")).toBe(true)
    expect(shouldTranscodeVodAudio("something_unrecognized")).toBe(true)
  })
})

describe("peekVodAudioRemuxAvailable", () => {
  it("returns synchronously without forcing a probe outside a Tauri desktop context", () => {
    expect(peekVodAudioRemuxAvailable()).toBe(false)
  })
})
