import { describe, it, expect, beforeEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

import { refineParseFailureKey } from "../src/scripts/receiver/engines"

function probeResponse(status: number, contentType: string | null, body: string) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  }
}

const SOURCE = { src: "http://provider.test/live/u/p/1.m3u8" }

describe("refineParseFailureKey", () => {
  beforeEach(() => {
    providerFetchMock.mockReset()
  })

  // The logged bug: a capped account made the TV report a malformed manifest, so the receiver
  // blamed the TV's file-type support.
  it("turns a container verdict into the connection-limit message when the provider refused", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, "text/html", "<html>Max connections reached</html>"))
    const refined = await refineParseFailureKey("receiver.error.container", SOURCE)
    expect(refined.messageKey).toBe("receiver.error.connectionLimit")
    expect(refined.verdict).toBe("connection-limit")
  })

  it("turns a container verdict into the provider-refused message for a non-stream response", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(403, null, ""))
    const refined = await refineParseFailureKey("receiver.error.container", SOURCE)
    expect(refined.messageKey).toBe("receiver.error.providerRefused")
  })

  it("keeps the container message when a real manifest came back", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, null, "#EXTM3U\n#EXT-X-VERSION:3\n"))
    const refined = await refineParseFailureKey("receiver.error.container", SOURCE)
    expect(refined.messageKey).toBe("receiver.error.container")
    expect(refined.verdict).toBe("manifest")
  })

  it("keeps the generic failure message refinable, since it is also a parse guess", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, "application/json", '{"error":"denied"}'))
    const refined = await refineParseFailureKey("receiver.error.title", SOURCE)
    expect(refined.messageKey).toBe("receiver.error.providerRefused")
  })

  it("never probes for a diagnosis the player already made confidently", async () => {
    for (const key of [
      "receiver.error.videoCodec",
      "receiver.error.audioCodec",
      "receiver.error.hevc",
      "receiver.error.network",
      "receiver.error.timeout",
      "receiver.error.connectionLimit",
    ]) {
      const refined = await refineParseFailureKey(key, SOURCE)
      expect(refined.messageKey).toBe(key)
      expect(refined.verdict).toBeNull()
    }
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("keeps the original message when there is no source to probe", async () => {
    const refined = await refineParseFailureKey("receiver.error.container", { src: "" })
    expect(refined.messageKey).toBe("receiver.error.container")
    expect(providerFetchMock).not.toHaveBeenCalled()
  })
})
