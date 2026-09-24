/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest"

// stampCustomSourceIdentity is pure; these mocks just let catalog.js's heavy
// import chain resolve, mirroring tests/catalog-custom-sources.test.ts.
vi.mock("@/scripts/lib/creds.js", () => ({
  fmtBase: () => "",
  isTauri: false,
  getEntries: async () => [],
  loadCreds: async () => ({ host: "", port: "", user: "", pass: "", liveContainer: "m3u8" }),
  entryToCreds: () => ({ host: "", port: "", user: "", pass: "", liveContainer: "m3u8" }),
  getMirrorPin: () => 0,
  setMirrorPin: () => {},
  isLikelyM3USource: () => false,
  isLocalM3UHost: () => false,
  isCustomHost: () => false,
  readLocalM3UContent: async () => "",
  getEntryDnsOverride: () => null,
}))

vi.mock("@/scripts/lib/cache.js", () => ({
  cachedFetch: async (_entryId: string, _kind: string, _ttl: number, fetcher: () => Promise<any>) => ({
    data: await fetcher(),
    fromCache: false,
    age: 0,
    stale: false,
  }),
  getCached: () => null,
  hydrate: async () => {},
  invalidateCustomDependents: async () => [],
}))

vi.mock("@/scripts/lib/xtream-api.js", () => ({
  xtreamApiFetch: async () => ({ ok: true, status: 200, json: async () => [] }),
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: async () => ({ ok: true, status: 200, text: async () => "" }),
  streamingText: async (response: any) => response.text(),
  streamingBytes: async (response: any) => response.arrayBuffer(),
}))

vi.mock("@/scripts/lib/account-info.js", () => ({ ensureUserInfo: async () => null }))
vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key }))
vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  redactUrl: (value: string) => value,
}))

import { stampCustomSourceIdentity } from "@/scripts/lib/catalog.js"
import { addChannel, emptyCustomDoc } from "@/scripts/lib/custom-playlist.ts"

describe("stampCustomSourceIdentity", () => {
  it("stamps sourceEntryId/sourceStreamId onto a channel resolved from an xtream source", () => {
    const { doc, channel } = addChannel(
      emptyCustomDoc(),
      { kind: "xtream", entryId: "src-1", streamId: 42 },
      { group: "News" }
    )
    const resolved = [{ id: channel.id, name: "BBC One" }]
    const stamped = stampCustomSourceIdentity(resolved, doc)
    expect(stamped[0]).toMatchObject({ sourceEntryId: "src-1", sourceStreamId: 42 })
  })

  it("leaves a channel resolved from an m3u source untouched", () => {
    const { doc, channel } = addChannel(
      emptyCustomDoc(),
      { kind: "m3u", entryId: "src-2", url: "http://example.com/a.m3u8", name: "A" },
      { group: "News" }
    )
    const resolved = [{ id: channel.id, name: "A" }]
    const stamped = stampCustomSourceIdentity(resolved, doc)
    expect(stamped[0]).toEqual(resolved[0])
    expect(stamped[0]).not.toHaveProperty("sourceEntryId")
  })

  it("leaves a channel resolved from a direct source untouched", () => {
    const { doc, channel } = addChannel(
      emptyCustomDoc(),
      {
        kind: "direct",
        url: "http://example.com/stream.m3u8",
        userAgent: null,
        referer: null,
        manifestType: null,
        drmScheme: null,
        licenseKey: null,
      },
      { group: "News" }
    )
    const resolved = [{ id: channel.id, name: "Direct" }]
    const stamped = stampCustomSourceIdentity(resolved, doc)
    expect(stamped[0]).toEqual(resolved[0])
    expect(stamped[0]).not.toHaveProperty("sourceEntryId")
  })

  it("passes through a resolved channel with no matching doc channel", () => {
    const doc = emptyCustomDoc()
    const resolved = [{ id: 999, name: "Orphan" }]
    const stamped = stampCustomSourceIdentity(resolved, doc)
    expect(stamped[0]).toEqual(resolved[0])
  })
})
