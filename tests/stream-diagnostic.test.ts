import { beforeEach, describe, expect, it, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))
vi.mock("@/scripts/lib/creds.js", () => ({ isTauri: false }))

const { isMixedContentBlocked, probeStreamHead } = await import(
  "../src/scripts/lib/stream-diagnostic.js"
)

function fakeResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: "http://provider.example/live/1.m3u8",
    headers: { get: () => null },
  }
}

describe("probeStreamHead dns forwarding", () => {
  beforeEach(() => {
    providerFetchMock.mockReset()
    providerFetchMock.mockResolvedValue(fakeResponse())
  })

  it("forwards options.dns onto the providerFetch init", async () => {
    const dnsServer = { kind: "ip", host: "1.1.1.1", port: 53, raw: "1.1.1.1" }
    await probeStreamHead("http://provider.example/live/1.m3u8", undefined, "media", { dns: dnsServer })
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = providerFetchMock.mock.calls[0]
    expect(init.dns).toBe(dnsServer)
  })

  it("leaves dns undefined when no options are passed", async () => {
    await probeStreamHead("http://provider.example/live/1.m3u8", undefined, "media")
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = providerFetchMock.mock.calls[0]
    expect(init.dns).toBeUndefined()
  })
})

describe("isMixedContentBlocked", () => {
  it("does not flag http streams inside the Tauri app, even in a secure context", () => {
    expect(isMixedContentBlocked(true, true, "http://provider.example/live/1.m3u8")).toBe(false)
  })

  it("flags http streams in the real web deployment when the page is secure", () => {
    expect(isMixedContentBlocked(false, true, "http://provider.example/live/1.m3u8")).toBe(true)
  })

  it("does not flag http streams when the web page itself isn't a secure context", () => {
    expect(isMixedContentBlocked(false, false, "http://provider.example/live/1.m3u8")).toBe(false)
  })

  it("never flags https streams", () => {
    expect(isMixedContentBlocked(false, true, "https://provider.example/live/1.m3u8")).toBe(false)
    expect(isMixedContentBlocked(true, true, "https://provider.example/live/1.m3u8")).toBe(false)
  })
})
