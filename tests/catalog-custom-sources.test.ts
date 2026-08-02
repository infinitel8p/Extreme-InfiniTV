/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const mirrorPin = new Map<string, number>()
let storedEntries: any[] = []

function fmtBaseImpl(host: string, port?: string) {
  if (!host) return ""
  const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`
  const trimmed = withScheme.replace(/\/+$/, "")
  const authority = trimmed.replace(/^https?:\/\//i, "").split("/")[0]
  const hasPort = /:\d+$/.test(authority)
  return port && !hasPort ? `${trimmed}:${port}` : trimmed
}

function candidatesFor(entry: any) {
  const out = [
    { host: entry.serverUrl, port: "", user: entry.username, pass: entry.password, liveContainer: "m3u8" },
  ]
  for (const mirror of entry.mirrors || []) {
    out.push({
      host: mirror.serverUrl,
      port: "",
      user: mirror.username,
      pass: mirror.password,
      liveContainer: "m3u8",
    })
  }
  return out
}

vi.mock("@/scripts/lib/creds.js", () => ({
  fmtBase: fmtBaseImpl,
  isTauri: false,
  getEntries: async () => storedEntries,
  loadCreds: async () => ({ host: "", port: "", user: "", pass: "", liveContainer: "m3u8" }),
  // Mirrors the real implementation: the pin is read at call time, not baked in.
  entryToCreds: (entry: any) => {
    if (!entry) return { host: "", port: "", user: "", pass: "", liveContainer: "m3u8" }
    if (entry.type === "m3u") {
      return { host: entry.url, port: "", user: "", pass: "", liveContainer: "m3u8" }
    }
    const candidates = candidatesFor(entry)
    const pin = mirrorPin.get(entry._id) || 0
    return candidates[Math.min(pin, candidates.length - 1)]
  },
  getMirrorPin: (entryId: string) => mirrorPin.get(entryId) || 0,
  setMirrorPin: (entryId: string, index: number) => {
    if (index > 0) mirrorPin.set(entryId, index)
    else mirrorPin.delete(entryId)
  },
  isLikelyM3USource: (host: string, user: string, pass: string) =>
    /^(https?:\/\/|xt-custom:\/\/|xt-local:\/\/)/i.test(String(host)) && !user && !pass,
  isLocalM3UHost: () => false,
  isCustomHost: (host: string) => String(host).startsWith("xt-custom://"),
  readLocalM3UContent: async () => "",
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

const liveStreams = [{ stream_id: 10, name: "BBC One", num: 1 }]

// Simulates xtream-api.js failing over to mirror index 1 while the catalog loads.
let failoverOnFetch = false
vi.mock("@/scripts/lib/xtream-api.js", () => ({
  xtreamApiFetch: async (action: string, _params: any, opts: any = {}) => {
    if (failoverOnFetch) mirrorPin.set(opts.entryId, 1)
    if (action === "get_live_categories") {
      return { ok: true, status: 200, json: async () => [] }
    }
    const body = JSON.stringify(liveStreams)
    return { ok: true, status: 200, text: async () => body }
  },
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: async () => ({ ok: true, status: 200, text: async () => "" }),
  streamingText: async (response: any) => response.text(),
}))

vi.mock("@/scripts/lib/account-info.js", () => ({ ensureUserInfo: async () => null }))
vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key }))
vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
  redactUrl: (value: string) => value,
}))

import { buildCustomSourcePools } from "@/scripts/lib/catalog.js"
import { addChannel, emptyCustomDoc } from "@/scripts/lib/custom-playlist.ts"

const sourceEntry = {
  _id: "src-1",
  type: "xtream",
  serverUrl: "http://primary.example",
  username: "alice",
  password: "secret",
  mirrors: [{ serverUrl: "http://mirror.example", username: "bob", password: "hunter2" }],
}

function docWithXtreamChannel() {
  return addChannel(
    emptyCustomDoc(),
    { kind: "xtream", entryId: "src-1", streamId: 10 },
    { group: "News" }
  ).doc
}

beforeEach(() => {
  mirrorPin.clear()
  storedEntries = [sourceEntry]
  failoverOnFetch = false
})

describe("buildCustomSourcePools: xtream mirror pin", () => {
  it("builds stream URLs on the primary when no failover happened", async () => {
    const pools = await buildCustomSourcePools(docWithXtreamChannel())
    const pool = pools.get("src-1")
    expect(pool?.kind).toBe("xtream")
    expect((pool as any).buildUrl(10)).toBe("http://primary.example/live/alice/secret/10.m3u8")
  })

  it("builds stream URLs on the winning mirror when a failover happened during hydration", async () => {
    failoverOnFetch = true
    const pools = await buildCustomSourcePools(docWithXtreamChannel())
    expect(mirrorPin.get("src-1")).toBe(1)
    expect((pools.get("src-1") as any).buildUrl(10)).toBe(
      "http://mirror.example/live/bob/hunter2/10.m3u8"
    )
  })

  it("picks up a failover that happens after the pools were built", async () => {
    const pools = await buildCustomSourcePools(docWithXtreamChannel())
    const pool = pools.get("src-1") as any
    expect(pool.buildUrl(10)).toBe("http://primary.example/live/alice/secret/10.m3u8")
    mirrorPin.set("src-1", 1)
    expect(pool.buildUrl(10)).toBe("http://mirror.example/live/bob/hunter2/10.m3u8")
  })

  it("skips custom source entries instead of recursing into them", async () => {
    storedEntries = [{ _id: "src-custom", type: "custom" }]
    const doc = addChannel(
      emptyCustomDoc(),
      { kind: "xtream", entryId: "src-custom", streamId: 10 },
      { group: "News" }
    ).doc
    const pools = await buildCustomSourcePools(doc)
    expect(pools.size).toBe(0)
  })
})
