/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const providerFetch = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({ providerFetch: (...args: unknown[]) => providerFetch(...args) }))
vi.mock("@/scripts/lib/app-settings.js", () => ({
  getNetworkTimeoutSeconds: () => 20,
  ACCENT_PRESETS: ["fuchsia"],
}))

let activeEntry: Record<string, unknown> | null = null
const candidates: Array<{ host: string; port: string; user: string; pass: string }> = []
let mirrorPin = 0
const setMirrorPin = vi.fn((_entryId: string, index: number) => {
  mirrorPin = index
})
vi.mock("@/scripts/lib/creds.js", () => ({
  getActiveEntry: async () => activeEntry,
  getEntries: async () => (activeEntry ? [activeEntry] : []),
  buildApiUrl: () => "http://primary.example/player_api.php",
  xtreamCandidatesFor: () => candidates,
  getMirrorPin: () => mirrorPin,
  setMirrorPin: (entryId: string, index: number) => setMirrorPin(entryId, index),
}))

import { advanceMirror, resolveStreamUrl } from "@/scripts/lib/xtream-api.js"

function probeResponse(status: number) {
  return { ok: status >= 200 && status < 300, status, body: { cancel: vi.fn().mockResolvedValue(undefined) } }
}

describe("advanceMirror", () => {
  beforeEach(() => {
    providerFetch.mockReset()
    setMirrorPin.mockClear()
    mirrorPin = 0
    activeEntry = { _id: "entry", type: "xtream" }
    candidates.length = 0
    candidates.push(
      { host: "http://primary.example", port: "", user: "user", pass: "pass" },
      { host: "http://backup.example", port: "", user: "user", pass: "pass" }
    )
    document.dispatchEvent(new Event("xt:entries-updated"))
  })

  it("returns null when the entry has fewer than 2 candidates", async () => {
    candidates.length = 1
    const url = await advanceMirror((creds) => `${creds.host}/live/x.m3u8`)
    expect(url).toBe(null)
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it("returns null once the hop budget is spent", async () => {
    const url = await advanceMirror((creds) => `${creds.host}/live/x.m3u8`, { hopsUsed: 1 })
    expect(url).toBe(null)
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it("skips the pinned candidate and probes the next one", async () => {
    providerFetch.mockResolvedValue(probeResponse(200))
    const url = await advanceMirror((creds) => `${creds.host}/live/x.m3u8`)
    expect(url).toBe("http://backup.example/live/x.m3u8")
    expect(providerFetch).toHaveBeenCalledTimes(1)
  })

  it("re-pins the entry by default (repin omitted)", async () => {
    providerFetch.mockResolvedValue(probeResponse(200))
    await advanceMirror((creds) => `${creds.host}/live/x.m3u8`)
    expect(setMirrorPin).toHaveBeenCalledWith("entry", 1)
  })

  it("does not re-pin the entry when repin is false", async () => {
    providerFetch.mockResolvedValue(probeResponse(200))
    const url = await advanceMirror((creds) => `${creds.host}/live/x.m3u8`, { repin: false })
    expect(url).toBe("http://backup.example/live/x.m3u8")
    expect(setMirrorPin).not.toHaveBeenCalled()
  })

  it("leaves the pin untouched after a non-repinning hop, so the next resolveStreamUrl call still probes the primary first", async () => {
    providerFetch.mockResolvedValue(probeResponse(200))
    await advanceMirror((creds) => `${creds.host}/live/x.m3u8`, { repin: false })
    providerFetch.mockReset()
    providerFetch.mockResolvedValue(probeResponse(200))
    const url = await resolveStreamUrl((creds) => `${creds.host}/live/y.m3u8`)
    expect(url).toBe("http://primary.example/live/y.m3u8")
  })

  it("returns null when every other candidate is unreachable", async () => {
    providerFetch.mockResolvedValue(probeResponse(458))
    const url = await advanceMirror((creds) => `${creds.host}/live/x.m3u8`)
    expect(url).toBe(null)
    expect(setMirrorPin).not.toHaveBeenCalled()
  })

  it("wraps past the end of the candidate list back to lower indices", async () => {
    candidates.push({ host: "http://backup2.example", port: "", user: "user", pass: "pass" })
    mirrorPin = 2
    providerFetch.mockResolvedValueOnce(probeResponse(458)).mockResolvedValueOnce(probeResponse(200))
    const url = await advanceMirror((creds) => `${creds.host}/live/x.m3u8`)
    expect(url).toBe("http://backup.example/live/x.m3u8")
  })
})
