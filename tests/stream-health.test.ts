/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  appendHealthEntry,
  summarizeSession,
  formatEntryOffset,
  redactHealthDetail,
  isAutomaticRetuneReason,
  type HealthEntry,
  type HealthSession,
} from "@/scripts/lib/stream-health.js"

function makeEntry(overrides: Partial<HealthEntry> = {}): HealthEntry {
  return { at: 0, kind: "waiting", detail: "", count: 1, ...overrides }
}

describe("appendHealthEntry", () => {
  it("coalesces same kind+detail within the window", () => {
    const first = [makeEntry({ at: 1000, kind: "stalled", detail: "buffer empty" })]
    const next = appendHealthEntry(first, makeEntry({ at: 1500, kind: "stalled", detail: "buffer empty" }))
    expect(next).toHaveLength(1)
    expect(next[0].count).toBe(2)
    expect(next[0].at).toBe(1500)
  })

  it("does not coalesce entries outside the window", () => {
    const first = [makeEntry({ at: 1000, kind: "stalled", detail: "buffer empty" })]
    const next = appendHealthEntry(
      first,
      makeEntry({ at: 4000, kind: "stalled", detail: "buffer empty" }),
      { coalesceWindowMs: 2000 },
    )
    expect(next).toHaveLength(2)
  })

  it("does not coalesce across different kinds", () => {
    const first = [makeEntry({ at: 1000, kind: "stalled", detail: "x" })]
    const next = appendHealthEntry(first, makeEntry({ at: 1100, kind: "waiting", detail: "x" }))
    expect(next).toHaveLength(2)
  })

  it("does not coalesce across different details", () => {
    const first = [makeEntry({ at: 1000, kind: "stalled", detail: "a" })]
    const next = appendHealthEntry(first, makeEntry({ at: 1100, kind: "stalled", detail: "b" }))
    expect(next).toHaveLength(2)
  })

  it("evicts from the front once over the cap", () => {
    let entries: HealthEntry[] = []
    for (let index = 0; index < 5; index++) {
      entries = appendHealthEntry(entries, makeEntry({ at: index * 10_000, kind: "variant", detail: `v${index}` }), {
        maxEntries: 3,
      })
    }
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.detail)).toEqual(["v2", "v3", "v4"])
  })

  it("does not mutate the input array", () => {
    const first = [makeEntry({ at: 1000, kind: "stalled", detail: "a" })]
    const snapshotBeforeCall = [...first]
    appendHealthEntry(first, makeEntry({ at: 1100, kind: "waiting", detail: "b" }))
    expect(first).toEqual(snapshotBeforeCall)
  })
})

function makeSession(overrides: Partial<HealthSession> = {}): HealthSession {
  return {
    id: 1,
    seq: null,
    startedAt: 0,
    endedAt: null,
    label: "Test channel",
    kind: "live",
    backend: "videojs",
    engine: "hls.js",
    entries: [],
    ...overrides,
  }
}

describe("summarizeSession", () => {
  it("sums entry counts, not entry length", () => {
    const session = makeSession({
      startedAt: 0,
      endedAt: 10_000,
      entries: [
        makeEntry({ kind: "variant", count: 3 }),
        makeEntry({ kind: "stalled", count: 2 }),
        makeEntry({ kind: "waiting", count: 4 }),
        makeEntry({ kind: "error", count: 1 }),
        makeEntry({ kind: "giveup", count: 1 }),
      ],
    })
    const summary = summarizeSession(session)
    expect(summary.variants).toBe(3)
    expect(summary.stalls).toBe(2)
    expect(summary.waits).toBe(4)
    expect(summary.errors).toBe(2)
    expect(summary.durationMs).toBe(10_000)
  })

  it("returns all zeros for an empty session", () => {
    const session = makeSession({ startedAt: 0, endedAt: 0, entries: [] })
    expect(summarizeSession(session)).toEqual({
      variants: 0,
      stalls: 0,
      waits: 0,
      errors: 0,
      droppedFrames: 0,
      durationMs: 0,
    })
  })

  it("computes duration against now for an open session", () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    const session = makeSession({ startedAt: 1000, endedAt: null, entries: [] })
    const summary = summarizeSession(session)
    expect(summary.durationMs).toBe(4000)
    vi.useRealTimers()
  })
})

describe("formatEntryOffset", () => {
  it("formats seconds under a minute", () => {
    expect(formatEntryOffset(12_000, 0)).toBe("+00:12")
  })

  it("formats minutes and seconds", () => {
    expect(formatEntryOffset(65_000, 0)).toBe("+01:05")
  })

  it("rolls over into hours past 60 minutes", () => {
    expect(formatEntryOffset(3_660_000, 0)).toBe("+1:01:00")
  })

  it("keeps zero-padded minutes and seconds within an hour rollover", () => {
    expect(formatEntryOffset(7_533_000, 0)).toBe("+2:05:33")
  })

  it("clamps negative deltas to +00:00", () => {
    expect(formatEntryOffset(0, 10_000)).toBe("+00:00")
  })

  it("clamps non-finite deltas to +00:00", () => {
    expect(formatEntryOffset(NaN, 0)).toBe("+00:00")
  })
})

describe("isAutomaticRetuneReason", () => {
  it("recognizes every auto: reason emitted by the recovery paths", () => {
    for (const reason of [
      "auto:m3u8-container-fallback",
      "auto:native-audio-fallback",
      "auto:gdr-relatch",
      "auto:audio-fix",
      "auto:proxy-stall-retune",
      "auto:proxy-error-fallback",
      "auto:mkv-remux-fallback",
    ]) {
      expect(isAutomaticRetuneReason(reason)).toBe(true)
    }
  })

  it("treats a user-initiated tune as not automatic", () => {
    expect(isAutomaticRetuneReason("user")).toBe(false)
  })
})

describe("redactHealthDetail", () => {
  it("masks a credentialed path", () => {
    const out = redactHealthDetail("https://provider.tld/live/alice/hunter2/1.m3u8")
    expect(out).not.toContain("alice")
    expect(out).not.toContain("hunter2")
  })

  it("masks a credentialed query string", () => {
    const out = redactHealthDetail("https://x.test/?username=bob&password=secret")
    expect(out).toContain("username=***")
    expect(out).toContain("password=***")
  })
})

describe("stream health store", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs the start/record/end lifecycle", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    const session = health.startHealthSession({ label: "Channel A", kind: "live", backend: "videojs" })
    expect(health.getActiveHealthSession()?.id).toBe(session.id)
    health.recordHealth("playing", "started")
    health.recordHealth("waiting")
    const active = health.getActiveHealthSession()
    expect(active?.entries.length).toBeGreaterThan(0)
    health.endHealthSession("finished")
    expect(health.getActiveHealthSession()).toBeNull()
    const sessions = health.listHealthSessions()
    expect(sessions[0].endedAt).not.toBeNull()
  })

  it("reports hasActiveHealthSession without cloning", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    expect(health.hasActiveHealthSession()).toBe(false)
    health.startHealthSession({ label: "Channel A", kind: "live", backend: "videojs" })
    expect(health.hasActiveHealthSession()).toBe(true)
    health.endHealthSession()
    expect(health.hasActiveHealthSession()).toBe(false)
  })

  it("no-ops recordHealth when no session is open", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    expect(() => health.recordHealth("waiting")).not.toThrow()
    expect(health.getActiveHealthSession()).toBeNull()
  })

  it("is idempotent when ending an already-ended session", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    health.startHealthSession({ label: "Channel A", kind: "live", backend: "videojs" })
    health.endHealthSession("first")
    const sessions = health.listHealthSessions()
    const endedAtFirst = sessions[0].endedAt
    health.endHealthSession("second")
    const sessionsAfter = health.listHealthSessions()
    expect(sessionsAfter[0].endedAt).toBe(endedAtFirst)
  })

  it("evicts the oldest session once past MAX_SESSIONS", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    for (let index = 0; index < 10; index++) {
      health.startHealthSession({ label: `Channel ${index}`, kind: "live", backend: "videojs" })
      health.endHealthSession()
    }
    const sessions = health.listHealthSessions()
    expect(sessions).toHaveLength(8)
    expect(sessions[0].label).toBe("Channel 9")
    expect(sessions[sessions.length - 1].label).toBe("Channel 2")
  })

  it("returns listHealthSessions newest first with copies callers cannot mutate", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    health.startHealthSession({ label: "First", kind: "live", backend: "videojs" })
    health.endHealthSession()
    health.startHealthSession({ label: "Second", kind: "live", backend: "videojs" })
    health.endHealthSession()
    const sessions = health.listHealthSessions()
    expect(sessions[0].label).toBe("Second")
    expect(sessions[1].label).toBe("First")
    sessions[0].entries.push(makeEntry())
    const sessionsAgain = health.listHealthSessions()
    expect(sessionsAgain[0].entries).toHaveLength(0)
  })

  it("records the existing xt:player-fallback document event", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    health.startHealthSession({ label: "Channel A", kind: "live", backend: "mpv" })
    document.dispatchEvent(
      new CustomEvent("xt:player-fallback", { detail: { requested: "mpv", used: "artplayer" } }),
    )
    const active = health.getActiveHealthSession()
    const fallbackEntry = active?.entries.find((entry) => entry.kind === "fallback")
    expect(fallbackEntry).toBeDefined()
    expect(fallbackEntry?.detail).toContain("mpv")
    expect(fallbackEntry?.detail).toContain("artplayer")
  })

  it("keeps a single session across an automatic retune instead of fragmenting it", async () => {
    const health = await import("@/scripts/lib/stream-health.js")
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const session = health.startHealthSession({ label: "Channel A", kind: "live", backend: "videojs" })
    health.recordHealth("giveup", "audio")
    // The page bundle's recovery path appends to the open session instead of starting a new one.
    vi.setSystemTime(2000)
    health.recordHealth("fallback", "auto:m3u8-container-fallback")

    const active = health.getActiveHealthSession()
    expect(active?.id).toBe(session.id)
    expect(health.listHealthSessions()).toHaveLength(1)
    const fallbackEntry = active?.entries.find((entry) => entry.kind === "fallback")
    expect(fallbackEntry?.detail).toBe("auto:m3u8-container-fallback")

    vi.setSystemTime(6000)
    health.endHealthSession("giveup")
    const finished = health.listHealthSessions()[0]
    expect(finished.id).toBe(session.id)
    expect(finished.entries.some((entry) => entry.kind === "fallback")).toBe(true)
    expect(summarizeSession(finished).durationMs).toBe(5000)
  })
})
