/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

const getServerInfoSyncMock = vi.fn()
const getCachedUserInfoSyncMock = vi.fn()
const ensureUserInfoMock = vi.fn()
vi.mock("@/scripts/lib/account-info.js", () => ({
  getServerInfoSync: (...args: unknown[]) => getServerInfoSyncMock(...args),
  getCachedUserInfoSync: (...args: unknown[]) => getCachedUserInfoSyncMock(...args),
  ensureUserInfo: (...args: unknown[]) => ensureUserInfoMock(...args),
}))

import { resolveCatchupSrc } from "@/scripts/lib/catchup-resolve.ts"
import { streamProfileFor, XTREAM_STREAM_PROFILE } from "@/scripts/lib/catchup.ts"
import { splitMountStart } from "@/scripts/lib/timeshift-math.ts"

const creds = { host: "iptv.example.com", port: "8080", user: "alice", pass: "secret" }

function okResponse(): { ok: boolean; status: number; body: null } {
  return { ok: true, status: 200, body: null }
}

// Node 24+ ships an experimental native `localStorage` (undefined without
// --localstorage-file) that shadows jsdom's; stub it with a real in-memory Storage.
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
  vi.clearAllMocks()
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("resolveCatchupSrc: M3U branch (mode !== xc, channel.url present)", () => {
  const startUtcMs = Date.UTC(2024, 0, 1, 12, 0, 0, 250)
  const stopUtcMs = startUtcMs + 3600_000

  it("returns hls kindHint for a catch-up URL ending in .m3u8", async () => {
    const channel = { id: 1, url: "http://host/live.m3u8", catchup: "shift" }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution).not.toBeNull()
    expect(resolution!.kindHint).toBe("hls")
    expect(resolution!.src).toMatch(/^http:\/\/host\/live\.m3u8\?utc=\d+&lutc=\d+$/)
    expect(resolution!.profile).toEqual(streamProfileFor(channel))
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("returns ts kindHint for a catch-up URL not ending in .m3u8", async () => {
    const channel = { id: 2, url: "http://host/live.ts", catchup: "shift" }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution).not.toBeNull()
    expect(resolution!.kindHint).toBe("ts")
  })

  it("floors effectiveStartUtcMs to the whole second via splitMountStart", async () => {
    const channel = { id: 3, url: "http://host/live.m3u8", catchup: "shift" }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution!.effectiveStartUtcMs).toBe(splitMountStart(startUtcMs, "second").mountStartUtcMs)
    expect(resolution!.effectiveStartUtcMs).toBe(startUtcMs - 250)
  })

  it("returns null when buildM3uCatchupUrl can't build a URL (vod mode, no source or catchupId)", async () => {
    const channel = { id: 4, url: "http://host/live.m3u8", catchup: "vod" }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution).toBeNull()
  })

  it("keeps effectiveStartUtcMs on the true programme start even with catchupCorrection set (Kodi parity: correction is provider-facing only)", async () => {
    const channel = {
      id: 5,
      url: "http://host/live.m3u8",
      catchup: "shift",
      catchupCorrection: 2,
    }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution!.effectiveStartUtcMs).toBe(splitMountStart(startUtcMs, "second").mountStartUtcMs)
    const correctedStartSec = Math.floor((startUtcMs - 2 * 3600_000) / 1000)
    expect(resolution!.src).toContain(`utc=${correctedStartSec}`)
  })
})

describe("resolveCatchupSrc: xc branch (Xtream-style live URL recovered from an M3U entry)", () => {
  const startUtcMs = Date.UTC(2024, 0, 1, 12, 0, 0)
  const stopUtcMs = startUtcMs + 3600_000

  it("returns null when the channel URL doesn't parse as an Xtream-style live URL", async () => {
    const channel = { id: 501, url: "http://provider.example/not/enough", catchup: "xc" }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution).toBeNull()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("parses the credentials + streamId and probes the rest+m3u8 variant first", async () => {
    getServerInfoSyncMock.mockReturnValue({ timezone: "UTC" })
    getCachedUserInfoSyncMock.mockReturnValue({ user_info: { allowed_output_formats: ["m3u8", "ts"] } })
    providerFetchMock.mockResolvedValue(okResponse())

    const channel = {
      id: 501,
      url: "http://provider.example:8080/live/bob/hunter2/501.m3u8",
      catchup: "xc",
    }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })

    expect(resolution).not.toBeNull()
    expect(resolution!.kindHint).toBe("hls")
    expect(resolution!.src).toContain("provider.example:8080/timeshift/bob/hunter2/")
    expect(resolution!.profile).toEqual(XTREAM_STREAM_PROFILE)
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })

  it("floors effectiveStartUtcMs to the whole minute (Xtream mount granularity)", async () => {
    getServerInfoSyncMock.mockReturnValue({ timezone: "UTC" })
    getCachedUserInfoSyncMock.mockReturnValue(null)
    providerFetchMock.mockResolvedValue(okResponse())

    const channel = {
      id: 501,
      url: "http://provider.example:8080/live/bob/hunter2/501.m3u8",
      catchup: "xc",
    }
    const offsetStartUtcMs = startUtcMs + 30_000
    const resolution = await resolveCatchupSrc("playlist-1", creds, {
      channel,
      startUtcMs: offsetStartUtcMs,
      stopUtcMs,
    })
    expect(resolution!.effectiveStartUtcMs).toBe(splitMountStart(offsetStartUtcMs, "minute").mountStartUtcMs)
  })

  it("keeps effectiveStartUtcMs on the true programme start even with catchupCorrection set", async () => {
    getServerInfoSyncMock.mockReturnValue({ timezone: "UTC" })
    getCachedUserInfoSyncMock.mockReturnValue(null)
    providerFetchMock.mockResolvedValue(okResponse())

    const channel = {
      id: 501,
      url: "http://provider.example:8080/live/bob/hunter2/501.m3u8",
      catchup: "xc",
      catchupCorrection: 3,
    }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution!.effectiveStartUtcMs).toBe(splitMountStart(startUtcMs, "minute").mountStartUtcMs)
  })

  it("falls through the fixed variant order and returns null when every candidate probe fails", async () => {
    getServerInfoSyncMock.mockReturnValue({ timezone: "UTC" })
    getCachedUserInfoSyncMock.mockReturnValue(null)
    providerFetchMock.mockResolvedValue({ ok: false, status: 404, body: null })

    const channel = {
      id: 502,
      url: "http://provider.example:8080/live/bob/hunter2/502.m3u8",
      catchup: "xc",
    }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(4)
  })

  it("caches the winning variant to localStorage and reuses it as the sole probe on a later call", async () => {
    getServerInfoSyncMock.mockReturnValue({ timezone: "UTC" })
    getCachedUserInfoSyncMock.mockReturnValue(null)

    let callCount = 0
    providerFetchMock.mockImplementation(async () => {
      callCount++
      // only the 4th fixed-order candidate (legacy + ts) succeeds
      return callCount === 4 ? okResponse() : { ok: false, status: 404, body: null }
    })

    const channel = {
      id: 900,
      url: "http://provider.example:8080/live/bob/hunter2/900.m3u8",
      catchup: "xc",
    }
    const request = { channel, startUtcMs, stopUtcMs }

    const first = await resolveCatchupSrc("playlist-cache-test", creds, request)
    expect(first).not.toBeNull()
    expect(first!.kindHint).toBe("ts")
    expect(providerFetchMock).toHaveBeenCalledTimes(4)
    expect(localStorage.getItem("xt_catchup_variant:playlist-cache-test")).toBe(
      JSON.stringify({ form: "legacy", extension: "ts" }),
    )

    providerFetchMock.mockClear()
    providerFetchMock.mockResolvedValue(okResponse())
    const second = await resolveCatchupSrc("playlist-cache-test", creds, request)
    expect(second).not.toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("resolveCatchupSrc: plain Xtream credentials path (channel has no url)", () => {
  const startUtcMs = Date.UTC(2024, 0, 1, 12, 0, 0)
  const stopUtcMs = startUtcMs + 3600_000

  it("builds a timeshift URL from creds + channel.id", async () => {
    getServerInfoSyncMock.mockReturnValue({ timezone: "UTC" })
    getCachedUserInfoSyncMock.mockReturnValue(null)
    providerFetchMock.mockResolvedValue(okResponse())

    const channel = { id: 777 }
    const resolution = await resolveCatchupSrc("playlist-1", creds, { channel, startUtcMs, stopUtcMs })
    expect(resolution).not.toBeNull()
    expect(resolution!.src).toContain("iptv.example.com:8080/timeshift/alice/secret/")
  })

  it("returns null when creds are incomplete", async () => {
    const channel = { id: 778 }
    const resolution = await resolveCatchupSrc(
      "playlist-1",
      { host: "", port: "", user: "", pass: "" },
      { channel, startUtcMs, stopUtcMs },
    )
    expect(resolution).toBeNull()
    expect(providerFetchMock).not.toHaveBeenCalled()
  })
})
