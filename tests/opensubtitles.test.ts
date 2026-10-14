import { describe, it, expect, vi } from "vitest"

vi.mock("@/scripts/lib/provider-fetch.js", () => ({ providerFetch: vi.fn() }))
vi.mock("@/scripts/lib/cache.js", () => ({ getCached: vi.fn(), hydrate: vi.fn(), setCached: vi.fn() }))
vi.mock("@/scripts/lib/app-settings.js", () => ({
  clearOpenSubtitlesSession: vi.fn(),
  getOpenSubtitlesSession: vi.fn(() => null),
  setOpenSubtitlesSession: vi.fn(),
}))
vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key }))
vi.mock("@/scripts/lib/toast.js", () => ({ toastWarn: vi.fn() }))

import { isSafeDownloadLink, resolveApiBase } from "../src/scripts/lib/opensubtitles"

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
