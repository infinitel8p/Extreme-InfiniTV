// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getUserAgent: () => "",
  getNetworkTimeoutSeconds: () => 15,
}))

vi.mock("@/scripts/lib/log.js", async () => {
  const actual = await vi.importActual<typeof import("@/scripts/lib/log")>("@/scripts/lib/log.js")
  return {
    ...actual,
    log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
  }
})

let tauriFetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response(null, { status: 200 })

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: RequestInit) => tauriFetchImpl(url, init),
}))

async function loadProviderFetch(tauri: boolean) {
  if (tauri) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  return import("@/scripts/lib/provider-fetch.js")
}

function loadNetLog() {
  return import("@/scripts/lib/net-log")
}

beforeEach(() => {
  vi.resetModules()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  delete (window as unknown as Record<string, unknown>).__TAURI__
  tauriFetchImpl = async () => new Response(null, { status: 200 })
})

describe("providerFetch net-log instrumentation", () => {
  it("records one entry for a successful native fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(false)
    const { getNetworkLog } = await loadNetLog()

    await providerFetch("https://x.test/api?username=alice&password=hunter2", { method: "GET" })

    const { entries } = getNetworkLog()
    expect(entries.length).toBe(1)
    const [entry] = entries
    expect(entry.method).toBe("GET")
    expect(entry.url).not.toContain("hunter2")
    expect(entry.status).toBe(200)
    expect(entry.ok).toBe(true)
    expect(entry.transport).toBe("native")
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(entry.durationMs)).toBe(true)
  })

  it("records one error entry for a failing native fetch", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(false)
    const { getNetworkLog } = await loadNetLog()

    await expect(providerFetch("https://x.test/api")).rejects.toThrow("network down")

    const { entries } = getNetworkLog()
    expect(entries.length).toBe(1)
    const [entry] = entries
    expect(entry.outcome).toBe("error")
    expect(entry.status).toBe(null)
    expect(entry.error).toBe("network down")
  })

  it("records an aborted entry without counting it as a failure", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
      throw new Error("should not reach here")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { providerFetch, getProviderStats } = await loadProviderFetch(false)
    const { getNetworkLog } = await loadNetLog()

    const controller = new AbortController()
    controller.abort()

    await expect(
      providerFetch("https://x.test/api", { signal: controller.signal }),
    ).rejects.toThrow()

    const { entries } = getNetworkLog()
    expect(entries.length).toBe(1)
    expect(entries[0].outcome).toBe("aborted")
    expect(getProviderStats().failures).toBe(0)
  })

  it("records transport tauri when the tauri path succeeds", async () => {
    tauriFetchImpl = async () => new Response(null, { status: 200 })

    const { providerFetch } = await loadProviderFetch(true)
    const { getNetworkLog } = await loadNetLog()

    await providerFetch("https://x.test/api")

    const { entries } = getNetworkLog()
    expect(entries.length).toBe(1)
    expect(entries[0].transport).toBe("tauri")
    expect(entries[0].outcome).toBe("ok")
  })

  it("records exactly one tauri-fallback entry when tauri fails and native succeeds", async () => {
    tauriFetchImpl = async () => {
      throw new Error("plugin-http failed")
    }
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(true)
    const { getNetworkLog } = await loadNetLog()

    await providerFetch("https://x.test/api")

    const { entries } = getNetworkLog()
    expect(entries.length).toBe(1)
    expect(entries[0].transport).toBe("tauri-fallback")
    expect(entries[0].outcome).toBe("ok")
  })

  it("respects logKind and strips it from the init passed to fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { providerFetch } = await loadProviderFetch(false)
    const { getNetworkLog } = await loadNetLog()

    await providerFetch("https://x.test/movie.mkv", { logKind: "media" } as RequestInit)

    const { entries } = getNetworkLog()
    expect(entries[0].kind).toBe("media")

    const passedInit = fetchMock.mock.calls[0][1] as Record<string, unknown> | undefined
    expect(passedInit).toBeDefined()
    expect(passedInit).not.toHaveProperty("logKind")
  })
})
