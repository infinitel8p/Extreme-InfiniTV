/**
 * @vitest-environment jsdom
 *
 * Exercises awaitNativeKind's same-job merge fix end to end: joining a kind
 * that isn't tracked yet on the active job must not supersede/force-settle
 * the kinds already in flight on that same job.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const eventHandlers = new Map<string, (event: { payload: unknown }) => void>()
let listenCallCount = 0
const invokeCalls: { command: string; args: unknown }[] = []
let statusQueue: unknown[] = []

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    listenCallCount += 1
    eventHandlers.set(eventName, handler)
    return () => eventHandlers.delete(eventName)
  },
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invokeCalls.push({ command, args })
    if (command === "warmup_start") {
      return {
        jobId: "job-1",
        joined: false,
        status: {
          jobId: "job-1",
          playlistId: "pl-1",
          force: true,
          state: "running",
          kinds: [
            { kind: "vod", state: "pending", bytes: 0, totalBytes: 0, winningMirrorIndex: null, stagedFiles: [], error: null },
          ],
        },
      }
    }
    if (command === "warmup_status") return statusQueue.shift() ?? null
    if (command === "warmup_read_staged") return "[]"
    return null
  },
}))

vi.mock("@/scripts/lib/creds.js", () => ({
  isTauri: true,
  getEntries: async () => [{ _id: "pl-1", type: "xtream" }],
  entryToCreds: () => ({ host: "http://provider.test", port: "", user: "user", pass: "pass" }),
  xtreamCandidatesFor: () => [{ host: "http://provider.test", port: "", user: "user", pass: "pass" }],
  getMirrorPin: () => 0,
  setMirrorPin: () => {},
  isLikelyM3USource: () => false,
  isLocalM3UHost: () => false,
  isCustomHost: () => false,
  buildApiUrl: (candidate: { host: string }, action: string) => `${candidate.host}/player_api.php?action=${action}`,
}))

vi.mock("@/scripts/lib/cache.js", () => ({
  hydrate: async () => {},
  getCached: () => null,
  setCached: () => {},
  invalidateCustomDependents: async () => [],
  hasInflightFetch: () => false,
}))

vi.mock("@/scripts/lib/catalog.js", () => ({
  ensureLive: async () => [],
  ensureVod: async () => [],
  ensureSeries: async () => [],
  m3uToChannelList: () => [],
  CHANNELS_TTL_MS: 1000,
  VOD_TTL_MS: 1000,
  SERIES_TTL_MS: 1000,
  CATALOG_WARMED_EVENT: "xt:catalog-warmed",
  CATALOG_WARMING_START_EVENT: "xt:catalog-warming-start",
  CATALOG_WARMING_PROGRESS_EVENT: "xt:catalog-warming-progress",
  CATALOG_WARMING_BYTES_EVENT: "xt:catalog-warming-bytes",
}))

vi.mock("@/scripts/lib/catalog-mappers.js", () => ({
  parseCategoriesToMap: () => ({}),
  mapXtreamLiveRows: () => [],
  mapXtreamVodRows: () => [],
  mapXtreamSeriesRows: () => [],
}))

vi.mock("@/scripts/lib/account-info.js", () => ({ ensureUserInfo: async () => null }))
vi.mock("@/scripts/lib/app-settings.js", () => ({ getUserAgent: () => "UA", getNetworkTimeoutSeconds: () => 15 }))
vi.mock("@/scripts/lib/provider-fetch.js", () => ({ DEFAULT_BROWSER_UA: "Mozilla/5.0" }))
vi.mock("@/scripts/lib/url-auth.ts", () => ({ splitUrlAuth: (url: string) => ({ url, authorization: null }) }))
vi.mock("@/scripts/lib/m3u-parser.ts", () => ({ parseM3U: () => ({ epgUrl: null, epgUrls: [], entries: [] }) }))
vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
}))

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.resetModules()
  eventHandlers.clear()
  listenCallCount = 0
  invokeCalls.length = 0
  statusQueue = []
})

describe("awaitNativeKind same-job merge", () => {
  it("merges a joining kind into the active job instead of superseding its other trackers", async () => {
    const warmupNative = await import("@/scripts/lib/warmup-native.ts")

    const vodEvents: Array<{ status: string }> = []
    document.addEventListener("xt:catalog-warming-progress", (event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.kind === "vod") vodEvents.push(detail)
    })

    const vodPromise = warmupNative.retryKindNative("pl-1", "vod")
    await flushAsync()
    expect(listenCallCount).toBe(3)

    statusQueue.push({
      jobId: "job-1",
      playlistId: "pl-1",
      force: true,
      state: "running",
      kinds: [
        { kind: "vod", state: "downloading", bytes: 0, totalBytes: 0, winningMirrorIndex: null, stagedFiles: [], error: null },
        { kind: "live", state: "downloading", bytes: 0, totalBytes: 0, winningMirrorIndex: null, stagedFiles: [], error: null },
      ],
    })
    const livePromise = warmupNative.awaitNativeKind("pl-1", "live")
    await flushAsync()

    // Merging "live" must not spin up a second job (no extra listen() calls).
    expect(listenCallCount).toBe(3)

    let vodSettledEarly = false
    vodPromise.then(() => {
      vodSettledEarly = true
    })
    await flushAsync()
    expect(vodSettledEarly).toBe(false)

    eventHandlers.get("xt:warmup-kind-done")?.({
      payload: { jobId: "job-1", playlistId: "pl-1", kind: "vod", winningMirrorIndex: 0, stagedFiles: [] },
    })
    eventHandlers.get("xt:warmup-kind-done")?.({
      payload: { jobId: "job-1", playlistId: "pl-1", kind: "live", winningMirrorIndex: 0, stagedFiles: [] },
    })

    const [vodResult] = await Promise.all([vodPromise, livePromise])
    expect(vodResult).toBe(true)
    expect(vodEvents.some((detail) => detail.status === "error")).toBe(false)
    expect(vodEvents.some((detail) => detail.status === "done")).toBe(true)
  })
})
