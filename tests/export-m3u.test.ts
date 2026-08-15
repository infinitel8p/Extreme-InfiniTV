import { describe, it, expect, beforeEach, vi } from "vitest"

const ensureLiveMock = vi.fn()
vi.mock("@/scripts/lib/catalog.js", () => ({
  ensureLive: (...args: unknown[]) => ensureLiveMock(...args),
}))

const entryToCredsMock = vi.fn()
vi.mock("@/scripts/lib/creds.js", () => ({
  entryToCreds: (...args: unknown[]) => entryToCredsMock(...args),
  // Minimal real behavior - stream-urls.ts's buildLiveStreamUrl depends on it.
  fmtBase: (host: string, port?: string) => {
    if (!host) return ""
    const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`
    const trimmed = withScheme.replace(/\/+$/, "")
    const authority = trimmed.replace(/^https?:\/\//i, "").split("/")[0]
    const hasPort = /:\d+$/.test(authority)
    return port && !hasPort ? `${trimmed}:${port}` : trimmed
  },
}))

import { buildM3UEntriesForEntry } from "@/scripts/lib/export-m3u.ts"

const xtreamCreds = {
  host: "http://iptv.example.com",
  port: "",
  user: "alice",
  pass: "secret",
  liveContainer: "m3u8",
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("buildM3UEntriesForEntry: xtream entries", () => {
  it("builds a live stream URL for channels that don't carry one, and translates tvArchive to catchup", async () => {
    entryToCredsMock.mockReturnValue(xtreamCreds)
    ensureLiveMock.mockResolvedValue([
      {
        id: 101,
        name: "Channel One",
        category: "News",
        logo: null,
        tvgId: "one.id",
        chno: 1,
        tvArchive: 1,
        tvArchiveDuration: 7,
      },
    ])

    const entry = { _id: "e1", type: "xtream" }
    const result = await buildM3UEntriesForEntry(entry)

    expect(result.skippedCount).toBe(0)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].url).toBe("http://iptv.example.com/live/alice/secret/101.m3u8")
    expect(result.entries[0].catchup).toBe("xc")
    expect(result.entries[0].catchupDays).toBe(7)
  })

  it("leaves catchup null when tvArchive is falsy", async () => {
    entryToCredsMock.mockReturnValue(xtreamCreds)
    ensureLiveMock.mockResolvedValue([
      { id: 202, name: "Channel Two", category: "Sports", tvArchive: 0, tvArchiveDuration: 0 },
    ])

    const result = await buildM3UEntriesForEntry({ _id: "e1", type: "xtream" })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].catchup).toBeNull()
    expect(result.entries[0].catchupDays).toBeNull()
  })
})

describe("buildM3UEntriesForEntry: m3u entries", () => {
  it("keeps the channel's own url and catchup fields untouched", async () => {
    entryToCredsMock.mockReturnValue({ host: "http://example.com/list.m3u8", port: "", user: "", pass: "", liveContainer: "m3u8" })
    ensureLiveMock.mockResolvedValue([
      {
        id: 1,
        name: "Chan",
        url: "http://host/chan.m3u8",
        catchup: "append",
        catchupDays: 3,
      },
    ])

    const result = await buildM3UEntriesForEntry({ _id: "e2", type: "m3u" })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].url).toBe("http://host/chan.m3u8")
    expect(result.entries[0].catchup).toBe("append")
    expect(result.entries[0].catchupDays).toBe(3)
    expect(result.skippedCount).toBe(0)
  })
})

describe("buildM3UEntriesForEntry: tvgShift", () => {
  it("carries the channel's tvgShift through to the exported entry", async () => {
    entryToCredsMock.mockReturnValue({ host: "http://example.com/list.m3u8", port: "", user: "", pass: "", liveContainer: "m3u8" })
    ensureLiveMock.mockResolvedValue([
      { id: 1, name: "Chan", url: "http://host/chan.m3u8", tvgShift: -1 },
    ])

    const result = await buildM3UEntriesForEntry({ _id: "e5", type: "m3u" })

    expect(result.entries[0].tvgShift).toBe(-1)
  })

  it("defaults tvgShift to null when the channel doesn't carry one", async () => {
    entryToCredsMock.mockReturnValue({ host: "http://example.com/list.m3u8", port: "", user: "", pass: "", liveContainer: "m3u8" })
    ensureLiveMock.mockResolvedValue([{ id: 1, name: "Chan", url: "http://host/chan.m3u8" }])

    const result = await buildM3UEntriesForEntry({ _id: "e6", type: "m3u" })

    expect(result.entries[0].tvgShift).toBeNull()
  })
})

describe("buildM3UEntriesForEntry: dropped channels", () => {
  it("drops unresolved channels and counts them as skipped", async () => {
    entryToCredsMock.mockReturnValue({ host: "http://example.com/list.m3u8", port: "", user: "", pass: "", liveContainer: "m3u8" })
    ensureLiveMock.mockResolvedValue([
      { id: 1, name: "Resolved", url: "http://host/resolved.m3u8" },
      { id: 2, name: "Unresolved", url: "http://host/unresolved.m3u8", unresolved: true },
    ])

    const result = await buildM3UEntriesForEntry({ _id: "e3", type: "custom" })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe("Resolved")
    expect(result.skippedCount).toBe(1)
  })

  it("drops channels with no resolvable url and counts them as skipped", async () => {
    entryToCredsMock.mockReturnValue({ host: "http://example.com/list.m3u8", port: "", user: "", pass: "", liveContainer: "m3u8" })
    ensureLiveMock.mockResolvedValue([
      { id: 1, name: "No URL" },
      { id: 2, name: "Has URL", url: "http://host/has-url.m3u8" },
    ])

    const result = await buildM3UEntriesForEntry({ _id: "e4", type: "m3u" })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe("Has URL")
    expect(result.skippedCount).toBe(1)
  })
})
