/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const apiCalls: Array<{ action: string; entryId?: string }> = []

vi.mock("@/scripts/lib/creds.js", () => ({
  fmtBase: () => "",
  isTauri: false,
  getEntries: async () => [{ _id: "pl-b", type: "xtream" }],
  getEntryById: async () => null,
  getActiveEntry: async () => null,
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
  xtreamApiFetch: async (action: string, _params: unknown, opts: { entryId?: string } = {}) => {
    apiCalls.push({ action, entryId: opts.entryId })
    return { ok: true, status: 200, json: async () => [] }
  },
}))

vi.mock("@/scripts/lib/catalog-ingest-client.ts", () => ({
  ingestXtreamBytes: async () => [],
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: async () => ({ ok: true, status: 200, text: async () => "" }),
  streamingText: async (response: any) => response.text(),
  streamingBytes: async () => new ArrayBuffer(0),
}))

vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key }))
vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  redactUrl: (value: string) => value,
}))

import { ensureVod, ensureSeries } from "@/scripts/lib/catalog.js"
import { ensureUserInfo } from "@/scripts/lib/account-info.js"

const creds = { host: "http://h", port: "80", user: "u", pass: "p" }

describe("playlist-targeted fetches", () => {
  beforeEach(() => {
    apiCalls.length = 0
  })

  it("ensureVod targets the given playlist", async () => {
    await ensureVod(creds, "pl-b")
    const actions = apiCalls.map((call) => call.action)
    expect(actions).toContain("get_vod_categories")
    expect(actions).toContain("get_vod_streams")
    expect(apiCalls.every((call) => call.entryId === "pl-b")).toBe(true)
  })

  it("ensureSeries targets the given playlist", async () => {
    await ensureSeries(creds, "pl-b")
    const actions = apiCalls.map((call) => call.action)
    expect(actions).toContain("get_series_categories")
    expect(actions).toContain("get_series")
    expect(apiCalls.every((call) => call.entryId === "pl-b")).toBe(true)
  })

  it("ensureUserInfo targets the given playlist", async () => {
    await ensureUserInfo(creds, "pl-b")
    expect(apiCalls).toEqual([{ action: "", entryId: "pl-b" }])
  })
})
