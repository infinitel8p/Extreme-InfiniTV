import { describe, it, expect, beforeEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

import {
  classifyProbedManifest,
  messageKeyForProbeVerdict,
  probeManifestSource,
} from "../src/scripts/lib/manifest-probe"

function probeResponse(status: number, contentType: string | null, body: string) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  }
}

describe("classifyProbedManifest", () => {
  it("reads a connection-cap status as a refusal to open another stream", () => {
    for (const status of [429, 458, 509]) {
      expect(classifyProbedManifest({ status, contentType: null, bodyPrefix: "" })).toBe("connection-limit")
    }
  })

  // The bug this exists for: the panel serves its refusal with a 200 and the TV blames the file type.
  it("reads a connection-cap body served with a 200 as a refusal", () => {
    const bodies = [
      "Maximum connections reached",
      "MAX CONNECTIONS",
      "Connection limit exceeded for this account",
      "Too many connections",
      "No free connection available",
    ]
    for (const body of bodies) {
      expect(classifyProbedManifest({ status: 200, contentType: "text/plain", bodyPrefix: body })).toBe(
        "connection-limit"
      )
    }
  })

  it("reads an HTTP error as the provider not serving a stream", () => {
    expect(classifyProbedManifest({ status: 403, contentType: null, bodyPrefix: "" })).toBe("refused")
    expect(classifyProbedManifest({ status: 500, contentType: null, bodyPrefix: "" })).toBe("refused")
  })

  it("reads an error page or JSON served with a 200 as the provider not serving a stream", () => {
    expect(
      classifyProbedManifest({ status: 200, contentType: "text/html", bodyPrefix: "<!DOCTYPE html><html>..." })
    ).toBe("refused")
    expect(classifyProbedManifest({ status: 200, contentType: null, bodyPrefix: '{"error":"denied"}' })).toBe(
      "refused"
    )
    expect(classifyProbedManifest({ status: 200, contentType: "text/html; charset=utf-8", bodyPrefix: "nope" })).toBe(
      "refused"
    )
  })

  it("confirms a real manifest so a genuine parse failure keeps its message", () => {
    expect(
      classifyProbedManifest({
        status: 200,
        contentType: "application/vnd.apple.mpegurl",
        bodyPrefix: "#EXTM3U\n#EXT-X-VERSION:3\n",
      })
    ).toBe("manifest")
    expect(
      classifyProbedManifest({
        status: 200,
        contentType: "application/dash+xml",
        bodyPrefix: '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">',
      })
    ).toBe("manifest")
  })

  it("stays inconclusive for raw media bytes", () => {
    const transportStream = String.fromCharCode(0x47) + " ceci n'est pas un manifeste"
    expect(classifyProbedManifest({ status: 200, contentType: "video/mp2t", bodyPrefix: transportStream })).toBe(
      "inconclusive"
    )
    // Four size bytes then the box type, as an MP4/fMP4 segment actually starts.
    const mp4 = "AAAAftypmp42"
    expect(classifyProbedManifest({ status: 200, contentType: "video/mp4", bodyPrefix: mp4 })).toBe("inconclusive")
  })

  it("reads a NUL-bearing body as binary rather than a refusal", () => {
    const withNulBytes = "\u0000\u0000\u0000\u0018ftypisom"
    expect(classifyProbedManifest({ status: 200, contentType: null, bodyPrefix: withNulBytes })).toBe("inconclusive")
  })

  it("does not read a connection-cap phrase out of binary media bytes", () => {
    const transportStream = String.fromCharCode(0x47) + " max connections"
    expect(classifyProbedManifest({ status: 200, contentType: "video/mp2t", bodyPrefix: transportStream })).toBe(
      "inconclusive"
    )
  })

  it("stays inconclusive when nothing identifies the body", () => {
    expect(classifyProbedManifest({ status: 200, contentType: null, bodyPrefix: "" })).toBe("inconclusive")
  })
})

describe("messageKeyForProbeVerdict", () => {
  it("maps only the conclusive verdicts to a replacement message", () => {
    expect(messageKeyForProbeVerdict("connection-limit")).toBe("receiver.error.connectionLimit")
    expect(messageKeyForProbeVerdict("refused")).toBe("receiver.error.providerRefused")
    expect(messageKeyForProbeVerdict("manifest")).toBeNull()
    expect(messageKeyForProbeVerdict("inconclusive")).toBeNull()
  })
})

describe("probeManifestSource", () => {
  beforeEach(() => {
    providerFetchMock.mockReset()
  })

  it("classifies what the provider actually served", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, "text/html", "<html>Max connections reached</html>"))
    await expect(probeManifestSource("http://provider.test/live/u/p/1.m3u8")).resolves.toBe("connection-limit")
  })

  it("asks for only the head of the source", async () => {
    providerFetchMock.mockResolvedValue(probeResponse(200, null, "#EXTM3U"))
    await probeManifestSource("http://provider.test/live/u/p/1.m3u8", { userAgent: "TestAgent/1.0" })
    const [, init] = providerFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers.Range).toBe("bytes=0-2047")
    expect(init.headers["User-Agent"]).toBe("TestAgent/1.0")
  })

  it("stays inconclusive when the probe itself fails", async () => {
    providerFetchMock.mockRejectedValue(new Error("timed out"))
    await expect(probeManifestSource("http://provider.test/live/u/p/1.m3u8")).resolves.toBe("inconclusive")
  })

  it("skips the request entirely without a source", async () => {
    await expect(probeManifestSource("")).resolves.toBe("inconclusive")
    expect(providerFetchMock).not.toHaveBeenCalled()
  })
})
