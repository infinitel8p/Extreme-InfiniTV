import { describe, it, expect, beforeEach, vi } from "vitest"

const SESSION_ID = "session-abc"

const eventHandlers = new Map<string, (event: { payload: unknown }) => void>()
const invokeCalls: { command: string; args: unknown }[] = []

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    eventHandlers.set(eventName, handler)
    return () => eventHandlers.delete(eventName)
  },
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invokeCalls.push({ command, args })
    if (command === "register_vod_proxy") {
      return { sessionId: SESSION_ID, proxyUrl: "http://127.0.0.1:41234/token/stream.mkv" }
    }
    return null
  },
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({ getUserAgent: () => null }))

const resolveDnsRoutedUrl = vi.fn(async (url: string) => ({ url, server: null }))
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  resolveDnsRoutedUrl: (url: string, explicitServer: unknown) => resolveDnsRoutedUrl(url, explicitServer),
}))

function emitTracks(payload: unknown): void {
  eventHandlers.get("xt:vodproxy-tracks")?.({ payload })
}

function emitCues(trackNumber: number, cues: unknown[]): void {
  eventHandlers.get("xt:vodproxy-cues")?.({ payload: { sessionId: SESSION_ID, trackNumber, cues } })
}

async function openSession() {
  const { prepareVodPlayback } = await import("../src/scripts/lib/vod-proxy")
  const prepared = await prepareVodPlayback("https://example.test/movie.mkv")
  return prepared
}

describe("prepareVodPlayback cue delivery", () => {
  beforeEach(() => {
    eventHandlers.clear()
    invokeCalls.length = 0
    resolveDnsRoutedUrl.mockClear()
    resolveDnsRoutedUrl.mockImplementation(async (url: string) => ({ url, server: null }))
    vi.resetModules()
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
  })

  it("replays already-received cues to a listener that subscribes after a remount", async () => {
    const { mkvSession } = await openSession()
    expect(mkvSession).not.toBeNull()

    emitTracks({ sessionId: SESSION_ID, tracks: [{ number: 2, codec: "S_TEXT/UTF8", language: "eng", name: null }] })

    const firstMountCues: { trackNumber: number; startMs: number }[] = []
    mkvSession!.onCues((trackNumber, cues) => {
      for (const cue of cues) firstMountCues.push({ trackNumber, startMs: cue.startMs })
    })

    emitCues(2, [{ startMs: 1000, endMs: 3000, text: "first" }])
    emitCues(2, [{ startMs: 4000, endMs: 6000, text: "second" }])
    expect(firstMountCues).toEqual([
      { trackNumber: 2, startMs: 1000 },
      { trackNumber: 2, startMs: 4000 },
    ])

    const secondMountCues: { trackNumber: number; startMs: number }[] = []
    mkvSession!.onCues((trackNumber, cues) => {
      for (const cue of cues) secondMountCues.push({ trackNumber, startMs: cue.startMs })
    })

    expect(secondMountCues).toEqual([
      { trackNumber: 2, startMs: 1000 },
      { trackNumber: 2, startMs: 4000 },
    ])
  })

  it("registers the dns-proxy-routed url returned by resolveDnsRoutedUrl", async () => {
    const routedUrl = "http://127.0.0.1:9000/tok/https/example.test/movie.mkv"
    resolveDnsRoutedUrl.mockImplementation(async () => ({
      url: routedUrl,
      server: { raw: "1.1.1.1" },
    }))

    await openSession()

    const call = invokeCalls.find((entry) => entry.command === "register_vod_proxy")
    expect((call?.args as { url?: string })?.url).toBe(routedUrl)
  })

  it("skips dns routing and stays direct when the url carries credentials", async () => {
    const { prepareVodPlayback } = await import("../src/scripts/lib/vod-proxy")
    await prepareVodPlayback("https://user:pass@example.test/movie.mkv")

    expect(resolveDnsRoutedUrl).not.toHaveBeenCalled()
    const call = invokeCalls.find((entry) => entry.command === "register_vod_proxy")
    expect((call?.args as { url?: string })?.url).toBe("https://user:pass@example.test/movie.mkv")
  })
})
