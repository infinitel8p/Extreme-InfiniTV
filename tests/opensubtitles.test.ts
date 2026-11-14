import { describe, it, expect, vi, beforeEach } from "vitest"

const secretStore = vi.hoisted(() => ({ value: "" }))
const sessionStore = vi.hoisted(() => ({ value: null as unknown }))

vi.mock("@/scripts/lib/creds.js", () => ({
  readSecret: vi.fn(async () => secretStore.value),
  writeSecret: vi.fn(async (_key: string, value: string) => {
    secretStore.value = value
  }),
}))
vi.mock("@/scripts/lib/provider-fetch.js", () => ({ providerFetch: vi.fn() }))
vi.mock("@/scripts/lib/cache.js", () => ({ getCached: vi.fn(), hydrate: vi.fn(), setCached: vi.fn() }))
vi.mock("@/scripts/lib/app-settings.js", () => ({
  clearOpenSubtitlesSession: vi.fn(() => {
    sessionStore.value = null
  }),
  getOpenSubtitlesSession: vi.fn(() => sessionStore.value),
  setOpenSubtitlesSession: vi.fn((session: unknown) => {
    sessionStore.value = session
  }),
}))
vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key }))
vi.mock("@/scripts/lib/toast.js", () => ({ toastWarn: vi.fn() }))

import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import {
  fetchOpenSubtitlesUserInfo,
  isSafeDownloadLink,
  loginOpenSubtitles,
  logoutOpenSubtitles,
  resolveApiBase,
} from "../src/scripts/lib/opensubtitles"

const DEFAULT_BASE = "https://api.opensubtitles.com/api/v1"

describe("resolveApiBase", () => {
  it("accepts opensubtitles hosts", () => {
    expect(resolveApiBase("vip-api.opensubtitles.com")).toBe("https://vip-api.opensubtitles.com/api/v1")
    expect(resolveApiBase("https://api.opensubtitles.org/")).toBe("https://api.opensubtitles.org/api/v1")
  })

  it("falls back for other hosts, schemes and junk", () => {
    expect(resolveApiBase("evil.example.com")).toBe(DEFAULT_BASE)
    expect(resolveApiBase("opensubtitles.com.evil.io")).toBe(DEFAULT_BASE)
    expect(resolveApiBase("http://api.opensubtitles.com")).toBe(DEFAULT_BASE)
    expect(resolveApiBase("")).toBe(DEFAULT_BASE)
    expect(resolveApiBase(null)).toBe(DEFAULT_BASE)
  })
})

describe("isSafeDownloadLink", () => {
  it("only allows https", () => {
    expect(isSafeDownloadLink("https://dl.opensubtitles.com/x.srt")).toBe(true)
    expect(isSafeDownloadLink("http://dl.opensubtitles.com/x.srt")).toBe(false)
    expect(isSafeDownloadLink("file:///etc/passwd")).toBe(false)
    expect(isSafeDownloadLink("nonsense")).toBe(false)
  })
})

describe("silent re-login", () => {
  const fetchMock = vi.mocked(providerFetch)
  const expiredSession = {
    token: "old",
    baseUrl: "",
    username: "user",
    allowedDownloads: null,
    level: null,
    vip: false,
    expiresAt: Date.now() - 1000,
  }

  function reply(status: number, body: unknown): Response {
    return { status, json: async () => body } as unknown as Response
  }

  function routeByPath(handlers: Record<string, () => Response>) {
    fetchMock.mockImplementation((async (url: string) => {
      const path = Object.keys(handlers).find((key) => String(url).includes(key))
      if (!path) throw new Error(`unexpected ${url}`)
      return handlers[path]()
    }) as unknown as typeof providerFetch)
  }

  function loginCalls(): number {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes("/login")).length
  }

  beforeEach(async () => {
    vi.stubEnv("PUBLIC_OPENSUBTITLES_API_KEY", "test-key")
    fetchMock.mockReset()
    routeByPath({ "/login": () => reply(200, { token: "t1", user: {} }), "/logout": () => reply(200, {}) })
    await logoutOpenSubtitles()
  })

  it("saves credentials on login and drops them on logout", async () => {
    await loginOpenSubtitles("user", "pw")
    expect(secretStore.value).toContain("pw")
    await logoutOpenSubtitles()
    expect(secretStore.value).toBe("")
  })

  it("re-logs in once for concurrent requests on an expired session", async () => {
    await loginOpenSubtitles("user", "pw")
    sessionStore.value = expiredSession
    fetchMock.mockReset()
    routeByPath({
      "/login": () => reply(200, { token: "t2", user: {} }),
      "/infos/user": () => reply(200, { data: { allowed_downloads: 5 } }),
    })
    const results = await Promise.all([fetchOpenSubtitlesUserInfo(), fetchOpenSubtitlesUserInfo()])
    expect(results[0].allowedDownloads).toBe(5)
    expect(loginCalls()).toBe(1)
  })

  it("keeps credentials after a transient failure and honours the cooldown", async () => {
    await loginOpenSubtitles("user", "pw")
    sessionStore.value = expiredSession
    fetchMock.mockReset()
    routeByPath({ "/login": () => reply(500, {}), "/infos/user": () => reply(401, {}) })
    await expect(fetchOpenSubtitlesUserInfo()).rejects.toMatchObject({ code: "unauthorized" })
    await expect(fetchOpenSubtitlesUserInfo()).rejects.toMatchObject({ code: "unauthorized" })
    expect(secretStore.value).toContain("pw")
    expect(loginCalls()).toBe(1)
  })

  it("clears credentials when the login is refused", async () => {
    await loginOpenSubtitles("user", "pw")
    sessionStore.value = { ...expiredSession }
    secretStore.value = JSON.stringify({ username: "user", password: "changed" })
    fetchMock.mockReset()
    routeByPath({ "/login": () => reply(401, { message: "bad" }) })
    await expect(fetchOpenSubtitlesUserInfo()).rejects.toMatchObject({ code: "unauthorized" })
    expect(secretStore.value).toBe("")
    expect(sessionStore.value).toBeNull()
  })
})
