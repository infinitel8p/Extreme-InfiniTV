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
vi.mock("@/scripts/lib/creds.js", () => ({
  getActiveEntry: async () => activeEntry,
  getEntries: async () => (activeEntry ? [activeEntry] : []),
  buildApiUrl: () => "http://primary.example/player_api.php",
  xtreamCandidatesFor: () => candidates,
  getMirrorPin: () => 0,
  setMirrorPin: () => {},
}))

import { resolveStreamUrl } from "@/scripts/lib/xtream-api.js"

function probeResponse(status: number) {
  const cancel = vi.fn().mockResolvedValue(undefined)
  return {
    response: { ok: status >= 200 && status < 300, status, body: { cancel } },
    cancel,
  }
}

describe("resolveStreamUrl stream probe releases its connection", () => {
  beforeEach(() => {
    providerFetch.mockReset()
    activeEntry = { _id: "entry", type: "xtream" }
    candidates.length = 0
    candidates.push(
      { host: "http://primary.example", port: "", user: "user", pass: "pass" },
      { host: "http://backup.example", port: "", user: "user", pass: "pass" }
    )
    document.dispatchEvent(new Event("xt:entries-updated"))
  })

  it("cancels the probe body on a successful probe", async () => {
    const probe = probeResponse(200)
    providerFetch.mockResolvedValue(probe.response)

    const url = await resolveStreamUrl((creds) => `${creds.host}/live/x.m3u8`)

    expect(url).toBe("http://primary.example/live/x.m3u8")
    expect(providerFetch).toHaveBeenCalledTimes(1)
    expect(probe.cancel).toHaveBeenCalledTimes(1)
  })

  it("cancels the probe body on a 206 partial-content probe", async () => {
    const probe = probeResponse(206)
    providerFetch.mockResolvedValue(probe.response)

    await resolveStreamUrl((creds) => `${creds.host}/live/x.ts`)

    expect(probe.cancel).toHaveBeenCalledTimes(1)
  })

  it("cancels every probe body when falling through to a mirror", async () => {
    const failed = probeResponse(458)
    const ok = probeResponse(200)
    providerFetch.mockResolvedValueOnce(failed.response).mockResolvedValueOnce(ok.response)

    const url = await resolveStreamUrl((creds) => `${creds.host}/live/x.m3u8`)

    expect(url).toBe("http://backup.example/live/x.m3u8")
    expect(failed.cancel).toHaveBeenCalledTimes(1)
    expect(ok.cancel).toHaveBeenCalledTimes(1)
  })

  it("aborts the probe request signal once the probe has answered", async () => {
    let seenSignal: AbortSignal | undefined
    providerFetch.mockImplementation(async (_url: string, init: { signal?: AbortSignal }) => {
      seenSignal = init?.signal
      return probeResponse(200).response
    })

    await resolveStreamUrl((creds) => `${creds.host}/live/x.m3u8`)

    expect(seenSignal?.aborted).toBe(true)
  })

  it("skips the probe entirely when the entry has no mirrors", async () => {
    candidates.length = 1
    providerFetch.mockResolvedValue(probeResponse(200).response)

    const url = await resolveStreamUrl((creds) => `${creds.host}/live/x.m3u8`)

    expect(url).toBe("http://primary.example/live/x.m3u8")
    expect(providerFetch).not.toHaveBeenCalled()
  })
})
