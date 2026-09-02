/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const localStorageStore = new Map<string, string>()
const localStorageMock: Storage = {
  getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
  setItem: (key, value) => {
    localStorageStore.set(key, String(value))
  },
  removeItem: (key) => {
    localStorageStore.delete(key)
  },
  clear: () => {
    localStorageStore.clear()
  },
  key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
  get length() {
    return localStorageStore.size
  },
}

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const ensureDnsProxyMock = vi.fn(async () => "http://127.0.0.1:9000/tok")
const releaseDnsProxyMock = vi.fn(async () => {})

vi.mock("@/scripts/lib/dns-proxy.ts", () => ({
  dnsProxyAvailable: () => true,
  ensureDnsProxy: (sessionKey: string, server: unknown) => ensureDnsProxyMock(sessionKey, server),
  releaseDnsProxy: (sessionKey: string) => releaseDnsProxyMock(sessionKey),
}))

import {
  addEntry,
  restoreState,
  warmDnsProxyForActive,
  ensureDnsProxyReady,
  getActiveDnsOverrideAsync,
} from "@/scripts/lib/creds.js"
import { setGlobalDns } from "@/scripts/lib/app-settings.js"

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("warmDnsProxyForActive", () => {
  beforeEach(async () => {
    ensureDnsProxyMock.mockClear()
    await restoreState({ entries: [], selectedId: "" })
  })

  it("does nothing when the active entry has no dns override", async () => {
    await addEntry({ type: "m3u", url: "http://example.com/list.m3u" })
    await flushMicrotasks()
    expect(ensureDnsProxyMock).not.toHaveBeenCalled()
  })

  it("registers the proxy session for the active entry's dns override on xt:active-changed", async () => {
    await addEntry({ type: "m3u", url: "http://example.com/list.m3u", dns: "1.1.1.1" })
    await vi.waitFor(() => expect(ensureDnsProxyMock).toHaveBeenCalled())
    expect(ensureDnsProxyMock).toHaveBeenCalledWith("dns:1.1.1.1", expect.objectContaining({ raw: "1.1.1.1" }))
  })

  it("is a no-op when called directly with no active entry", async () => {
    warmDnsProxyForActive()
    await flushMicrotasks()
    expect(ensureDnsProxyMock).not.toHaveBeenCalled()
  })
})

describe("ensureDnsProxyReady", () => {
  beforeEach(async () => {
    ensureDnsProxyMock.mockClear()
    releaseDnsProxyMock.mockClear()
    await restoreState({ entries: [], selectedId: "" })
  })

  it("resolves the stored active entry's override instead of the sync mirror", async () => {
    const entry = await addEntry({ type: "m3u", url: "http://example.com/list.m3u", dns: "9.9.9.9" })
    await restoreState({ entries: [entry], selectedId: entry._id })
    ensureDnsProxyMock.mockClear()
    expect(await getActiveDnsOverrideAsync()).toMatchObject({ raw: "9.9.9.9" })
    const override = await ensureDnsProxyReady()
    expect(override).toMatchObject({ raw: "9.9.9.9" })
    expect(ensureDnsProxyMock).toHaveBeenCalledWith("dns:9.9.9.9", expect.objectContaining({ raw: "9.9.9.9" }))
  })

  it("returns null when no override applies", async () => {
    await addEntry({ type: "m3u", url: "http://example.com/list.m3u" })
    expect(await ensureDnsProxyReady()).toBeNull()
    expect(ensureDnsProxyMock).not.toHaveBeenCalled()
  })
})

describe("global default DNS changes", () => {
  beforeEach(async () => {
    ensureDnsProxyMock.mockClear()
    releaseDnsProxyMock.mockClear()
    await restoreState({ entries: [], selectedId: "" })
  })

  it("releases the previous default's session when it changes and when it is cleared", async () => {
    setGlobalDns("8.8.8.8")
    await flushMicrotasks()
    expect(releaseDnsProxyMock).not.toHaveBeenCalled()

    setGlobalDns("1.1.1.1")
    await vi.waitFor(() => expect(releaseDnsProxyMock).toHaveBeenCalledWith("dns:8.8.8.8"))

    setGlobalDns(null)
    await vi.waitFor(() => expect(releaseDnsProxyMock).toHaveBeenCalledWith("dns:1.1.1.1"))
  })
})
