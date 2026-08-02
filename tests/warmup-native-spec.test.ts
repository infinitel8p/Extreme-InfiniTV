/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest"
import { buildWarmupSpec, decideNativeKinds, wrapJsKind } from "@/scripts/lib/warmup-native.ts"
import type { DecideNativeKindsInput } from "@/scripts/lib/warmup-native.ts"
import { splitUrlAuth } from "@/scripts/lib/url-auth.ts"

const baseDecideInput: DecideNativeKindsInput = {
  isM3U: false,
  force: false,
  allHot: false,
  liveCached: false,
  liveInflightJs: false,
  vodCached: false,
  vodInflightJs: false,
  seriesCached: false,
  seriesInflightJs: false,
  runningStatusKinds: null,
}

const xtreamCandidates = [
  { host: "http://a.test", port: "", user: "user-a", pass: "pass-a" },
  { host: "http://b.test", port: "", user: "user-b", pass: "pass-b" },
  { host: "http://c.test", port: "", user: "user-c", pass: "pass-c" },
]

describe("buildWarmupSpec (xtream)", () => {
  it("builds two steps per kind with the right names and emitBytes flags", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-1",
      force: false,
      timeoutSeconds: 15,
      userAgent: "Xtream/1",
      kinds: ["live"],
      source: { type: "xtream", candidates: xtreamCandidates, startIndex: 0 },
    })
    expect(spec.kinds).toHaveLength(1)
    const [liveKind] = spec.kinds
    expect(liveKind.kind).toBe("live")
    expect(liveKind.steps).toHaveLength(2)
    expect(liveKind.steps[0].name).toBe("categories")
    expect(liveKind.steps[0].emitBytes).toBe(false)
    expect(liveKind.steps[1].name).toBe("streams")
    expect(liveKind.steps[1].emitBytes).toBe(true)
  })

  it("builds all three kinds when requested with correct action names", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-1",
      force: false,
      timeoutSeconds: 15,
      userAgent: "Xtream/1",
      kinds: ["live", "vod", "series"],
      source: { type: "xtream", candidates: xtreamCandidates, startIndex: 0 },
    })
    expect(spec.kinds.map((kindSpec) => kindSpec.kind)).toEqual(["live", "vod", "series"])

    const liveKind = spec.kinds.find((kindSpec) => kindSpec.kind === "live")!
    expect(new URL(liveKind.steps[0].candidates[0].url).searchParams.get("action")).toBe("get_live_categories")
    expect(new URL(liveKind.steps[1].candidates[0].url).searchParams.get("action")).toBe("get_live_streams")

    const vodKind = spec.kinds.find((kindSpec) => kindSpec.kind === "vod")!
    expect(new URL(vodKind.steps[0].candidates[0].url).searchParams.get("action")).toBe("get_vod_categories")
    expect(new URL(vodKind.steps[1].candidates[0].url).searchParams.get("action")).toBe("get_vod_streams")

    const seriesKind = spec.kinds.find((kindSpec) => kindSpec.kind === "series")!
    expect(new URL(seriesKind.steps[0].candidates[0].url).searchParams.get("action")).toBe("get_series_categories")
    expect(new URL(seriesKind.steps[1].candidates[0].url).searchParams.get("action")).toBe("get_series")
  })

  it("rotates candidates so index 0 is candidates[startIndex], preserving original mirrorIndex", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-1",
      force: false,
      timeoutSeconds: 15,
      userAgent: "Xtream/1",
      kinds: ["live"],
      source: { type: "xtream", candidates: xtreamCandidates, startIndex: 1 },
    })
    const streamsCandidates = spec.kinds[0].steps[1].candidates
    expect(streamsCandidates.map((candidate) => candidate.mirrorIndex)).toEqual([1, 2, 0])
    expect(streamsCandidates.map((candidate) => new URL(candidate.url).hostname)).toEqual([
      "b.test",
      "c.test",
      "a.test",
    ])
  })

  it("applies userAgent to every candidate", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-1",
      force: false,
      timeoutSeconds: 15,
      userAgent: "Xtream/custom-ua",
      kinds: ["live", "vod"],
      source: { type: "xtream", candidates: xtreamCandidates, startIndex: 0 },
    })
    for (const kindSpec of spec.kinds) {
      for (const step of kindSpec.steps) {
        for (const candidate of step.candidates) {
          expect(candidate.userAgent).toBe("Xtream/custom-ua")
        }
      }
    }
  })
})

describe("buildWarmupSpec (m3u)", () => {
  it("builds a single playlist step with emitBytes true", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-2",
      force: false,
      timeoutSeconds: 15,
      userAgent: "M3U/1",
      kinds: ["live"],
      source: { type: "m3u", url: "https://host.test/list.m3u" },
    })
    expect(spec.kinds).toHaveLength(1)
    expect(spec.kinds[0].kind).toBe("live")
    expect(spec.kinds[0].steps).toHaveLength(1)
    expect(spec.kinds[0].steps[0].name).toBe("playlist")
    expect(spec.kinds[0].steps[0].emitBytes).toBe(true)
    expect(spec.kinds[0].steps[0].candidates).toHaveLength(1)
    expect(spec.kinds[0].steps[0].candidates[0].mirrorIndex).toBe(0)
  })

  it("extracts the Authorization header from a user:pass@ URL, matching splitUrlAuth", () => {
    const rawUrl = "https://user:secret@host.test/list.m3u"
    const expected = splitUrlAuth(rawUrl)
    const spec = buildWarmupSpec({
      playlistId: "pl-2",
      force: false,
      timeoutSeconds: 15,
      userAgent: "M3U/1",
      kinds: ["live"],
      source: { type: "m3u", url: rawUrl },
    })
    const candidate = spec.kinds[0].steps[0].candidates[0]
    expect(candidate.url).toBe(expected.url)
    expect(candidate.authorization).toBe(expected.authorization)
    expect(candidate.authorization).toMatch(/^Basic /)
  })

  it("applies userAgent to the m3u candidate", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-2",
      force: false,
      timeoutSeconds: 15,
      userAgent: "M3U/custom-ua",
      kinds: ["live"],
      source: { type: "m3u", url: "https://host.test/list.m3u" },
    })
    expect(spec.kinds[0].steps[0].candidates[0].userAgent).toBe("M3U/custom-ua")
  })
})

describe("buildWarmupSpec timeoutMs floor", () => {
  it("floors at 8000ms for a 5 second timeout", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-1",
      force: false,
      timeoutSeconds: 5,
      userAgent: "ua",
      kinds: ["live"],
      source: { type: "xtream", candidates: xtreamCandidates, startIndex: 0 },
    })
    expect(spec.timeoutMs).toBe(8000)
  })

  it("scales past the floor for a 20 second timeout", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-1",
      force: false,
      timeoutSeconds: 20,
      userAgent: "ua",
      kinds: ["live"],
      source: { type: "xtream", candidates: xtreamCandidates, startIndex: 0 },
    })
    expect(spec.timeoutMs).toBe(20000)
  })
})

describe("buildWarmupSpec passthrough", () => {
  it("passes force and playlistId through untouched", () => {
    const spec = buildWarmupSpec({
      playlistId: "pl-force-check",
      force: true,
      timeoutSeconds: 10,
      userAgent: "ua",
      kinds: ["live"],
      source: { type: "xtream", candidates: xtreamCandidates, startIndex: 0 },
    })
    expect(spec.playlistId).toBe("pl-force-check")
    expect(spec.force).toBe(true)
  })
})

describe("decideNativeKinds", () => {
  it("sends every uncached kind native and shows warming when not all hot", () => {
    const result = decideNativeKinds(baseDecideInput)
    expect(result.nativeKinds.sort()).toEqual(["live", "series", "vod"])
    expect(result.cachedKinds).toEqual([])
    expect(result.jsKinds).toEqual([])
    expect(result.showWarming).toBe(true)
    expect(result.joinedRunningJob).toBe(false)
  })

  it("needs nothing and hides warming when every kind is cached and hot with no running job", () => {
    const result = decideNativeKinds({
      ...baseDecideInput,
      allHot: true,
      liveCached: true,
      vodCached: true,
      seriesCached: true,
    })
    expect(result.nativeKinds).toEqual([])
    expect(result.cachedKinds.sort()).toEqual(["live", "series", "vod"])
    expect(result.showWarming).toBe(false)
  })

  // BUG 1 repro: cache says everything is hot, but a job is still downloading -
  // must join it instead of silently reporting stale cached data as done.
  it("adopts a running job's non-ingested kinds when local cache looks fully satisfied", () => {
    const result = decideNativeKinds({
      ...baseDecideInput,
      allHot: true,
      liveCached: true,
      vodCached: true,
      seriesCached: true,
      runningStatusKinds: [
        { kind: "live", state: "downloading" },
        { kind: "vod", state: "ingested" },
        { kind: "series", state: "done" },
      ],
    })
    expect(result.nativeKinds.sort()).toEqual(["live", "series"])
    expect(result.cachedKinds).toEqual(["vod"])
    expect(result.showWarming).toBe(true)
    expect(result.joinedRunningJob).toBe(true)
  })

  it("does not adopt a running job whose kinds are all already ingested", () => {
    const result = decideNativeKinds({
      ...baseDecideInput,
      allHot: true,
      liveCached: true,
      vodCached: true,
      seriesCached: true,
      runningStatusKinds: [
        { kind: "live", state: "ingested" },
        { kind: "vod", state: "ingested" },
      ],
    })
    expect(result.nativeKinds).toEqual([])
    expect(result.joinedRunningJob).toBe(false)
    expect(result.showWarming).toBe(false)
  })

  it("never sends vod/series native for an m3u source, always routing them through jsKinds", () => {
    const result = decideNativeKinds({ ...baseDecideInput, isM3U: true })
    expect(result.nativeKinds).toEqual(["live"])
    expect(result.jsKinds.sort()).toEqual(["series", "vod"])
    expect(result.cachedKinds).toEqual([])
  })

  it("ignores a running job's adopted vod/series kinds for an m3u source", () => {
    const result = decideNativeKinds({
      ...baseDecideInput,
      isM3U: true,
      allHot: true,
      liveCached: true,
      runningStatusKinds: [
        { kind: "vod", state: "downloading" },
        { kind: "series", state: "downloading" },
      ],
    })
    expect(result.nativeKinds).toEqual([])
    expect(result.joinedRunningJob).toBe(false)
  })

  it("excludes a kind that already has a non-forced JS fetch in flight", () => {
    const result = decideNativeKinds({ ...baseDecideInput, liveInflightJs: true })
    expect(result.nativeKinds.sort()).toEqual(["series", "vod"])
    expect(result.cachedKinds).toEqual(["live"])
  })

  it("forces every non-inflight kind native even when cached", () => {
    const result = decideNativeKinds({
      ...baseDecideInput,
      force: true,
      allHot: false,
      liveCached: true,
      vodCached: true,
      seriesCached: true,
    })
    expect(result.nativeKinds.sort()).toEqual(["live", "series", "vod"])
  })

  // BUG 2 repro: force must win over an in-flight JS fetch, not get downgraded to a cache hit.
  it("still forces a kind native when a background JS fetch is in flight for it", () => {
    const result = decideNativeKinds({
      ...baseDecideInput,
      force: true,
      liveInflightJs: true,
    })
    expect(result.nativeKinds.sort()).toEqual(["live", "series", "vod"])
    expect(result.cachedKinds).toEqual([])
  })

  it("without force, an in-flight JS fetch still excludes the kind from native", () => {
    const result = decideNativeKinds({ ...baseDecideInput, force: false, liveInflightJs: true })
    expect(result.nativeKinds.sort()).toEqual(["series", "vod"])
    expect(result.cachedKinds).toEqual(["live"])
  })
})

// Regression: wrapJsKind's dispatch gate must follow showWarming, not its old
// inverted allHot sense - both call sites now pass showWarming=true, and a
// still-inverted `if (!showWarming)` would silently drop every event here.
describe("wrapJsKind", () => {
  function collectEvents(): { done: CustomEvent[]; error: CustomEvent[] } {
    const done: CustomEvent[] = []
    const error: CustomEvent[] = []
    document.addEventListener("xt:catalog-warming-progress", (event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.status === "done") done.push(event as CustomEvent)
      if (detail?.status === "error") error.push(event as CustomEvent)
    })
    return { done, error }
  }

  it("dispatches a done progress event when showWarming is true", async () => {
    const { done } = collectEvents()
    const rows = await wrapJsKind("pl-1", "vod", async () => [1, 2, 3], {}, true)
    expect(rows).toEqual([1, 2, 3])
    expect(done).toHaveLength(1)
    expect(done[0].detail).toMatchObject({ playlistId: "pl-1", kind: "vod", status: "done", count: 3 })
  })

  it("dispatches an error progress event when showWarming is true and the fetch rejects", async () => {
    const { error } = collectEvents()
    const errors: Record<string, string> = {}
    const rows = await wrapJsKind("pl-1", "series", async () => Promise.reject(new Error("boom")), errors, true)
    expect(rows).toEqual([])
    expect(errors.series).toContain("boom")
    expect(error).toHaveLength(1)
    expect(error[0].detail).toMatchObject({ playlistId: "pl-1", kind: "series", status: "error" })
  })

  it("stays silent when showWarming is false", async () => {
    const { done, error } = collectEvents()
    await wrapJsKind("pl-1", "vod", async () => [1], {}, false)
    expect(done).toHaveLength(0)
    expect(error).toHaveLength(0)
  })
})
