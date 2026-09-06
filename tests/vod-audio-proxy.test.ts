import { describe, it, expect, beforeEach, vi } from "vitest"
import { shouldTranscodeVodAudio, peekVodAudioRemuxAvailable } from "../src/scripts/lib/vod-audio-proxy"

const invokeCalls: { command: string; args: unknown }[] = []
const resolveDnsRoutedUrl = vi.fn(async (url: string) => ({ url, server: null }))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invokeCalls.push({ command, args })
    if (command === "register_vod_audio_remux") {
      return { sessionId: "sess", playbackUrl: "http://127.0.0.1:9000/live/sess" }
    }
    return null
  },
}))
vi.mock("@/scripts/lib/app-settings.js", () => ({
  getFfmpegPath: () => null,
  SETTINGS_EVENT: "xt:settings-changed",
}))
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  resolveDnsRoutedUrl: (url: string, explicitServer: unknown) => resolveDnsRoutedUrl(url, explicitServer),
}))

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

describe("startVodAudioRemux dns routing", () => {
  beforeEach(() => {
    invokeCalls.length = 0
    resolveDnsRoutedUrl.mockClear()
    resolveDnsRoutedUrl.mockImplementation(async (url: string) => ({ url, server: null }))
    vi.resetModules()
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
  })

  it("registers the dns-proxy-routed url returned by resolveDnsRoutedUrl", async () => {
    const routedUrl = "http://127.0.0.1:9000/tok/https/example.test/movie.mkv"
    resolveDnsRoutedUrl.mockImplementation(async () => ({
      url: routedUrl,
      server: { raw: "1.1.1.1" },
    }))

    const { startVodAudioRemux } = await import("../src/scripts/lib/vod-audio-proxy")
    await startVodAudioRemux({
      url: "https://example.test/movie.mkv",
      audioStreamIndex: 0,
      startSeconds: 0,
      transcodeAudio: false,
    })

    const call = invokeCalls.find((entry) => entry.command === "register_vod_audio_remux")
    expect((call?.args as { url?: string })?.url).toBe(routedUrl)
  })

  it("splits embedded credentials before routing and forwards them as authorization", async () => {
    const { startVodAudioRemux } = await import("../src/scripts/lib/vod-audio-proxy")
    await startVodAudioRemux({
      url: "https://user:pass@example.test/movie.mkv",
      audioStreamIndex: 0,
      startSeconds: 0,
      transcodeAudio: false,
    })

    expect(resolveDnsRoutedUrl).toHaveBeenCalledWith("https://example.test/movie.mkv", undefined)
    const call = invokeCalls.find((entry) => entry.command === "register_vod_audio_remux")
    expect((call?.args as { authorization?: string })?.authorization).toMatch(/^Basic /)
  })
})
