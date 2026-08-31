// Receiver log streaming: pushed over /events, persisted so an export survives the TV going away.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatLogLine } from "../src/scripts/lib/receiver-log-stream"
import { parseLogFrame } from "../src/scripts/lib/tv-cast-state-feed"

describe("formatLogLine", () => {
  it("stamps the line with a wall clock and the level", () => {
    const at = new Date(2026, 7, 21, 19, 53, 7)
    expect(formatLogLine("error", "[xt:receiver] native playback failed", at)).toBe(
      "[19:53:07][ERROR] [xt:receiver] native playback failed"
    )
  })

  it("zero-pads so lines stay column-aligned in the export", () => {
    const at = new Date(2026, 7, 21, 9, 4, 5)
    expect(formatLogLine("info", "ready", at)).toBe("[09:04:05][INFO] ready")
  })
})

describe("parseLogFrame", () => {
  it("reads a log frame's lines", () => {
    expect(parseLogFrame(JSON.stringify({ kind: "log", lines: ["one", "two"] }))).toEqual(["one", "two"])
  })

  it("ignores a bare playback-state frame, so old receivers keep working", () => {
    expect(parseLogFrame(JSON.stringify({ state: "playing", positionSeconds: 4 }))).toBe(null)
  })

  it("ignores frames with no usable lines", () => {
    expect(parseLogFrame(JSON.stringify({ kind: "log", lines: [] }))).toBe(null)
    expect(parseLogFrame(JSON.stringify({ kind: "log", lines: [1, null] }))).toBe(null)
    expect(parseLogFrame(JSON.stringify({ kind: "log" }))).toBe(null)
  })

  it("drops non-string entries but keeps the usable ones", () => {
    expect(parseLogFrame(JSON.stringify({ kind: "log", lines: ["keep", 7, "also"] }))).toEqual(["keep", "also"])
  })

  it("returns null on malformed input instead of throwing", () => {
    expect(parseLogFrame("not json")).toBe(null)
    expect(parseLogFrame("")).toBe(null)
    expect(parseLogFrame("null")).toBe(null)
  })
})

describe("appendStreamedReceiverLog", () => {
  let store: Record<string, string>

  beforeEach(async () => {
    store = {}
    vi.resetModules()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
    }
    ;(globalThis as { document?: unknown }).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }
  })

  it("accumulates across batches and persists each one for the export", async () => {
    const { appendStreamedReceiverLog, getStreamedReceiverLog, getReceiverLogSnapshots } = await import(
      "../src/scripts/lib/tv-cast"
    )
    appendStreamedReceiverLog("Living Room TV", ["first"])
    appendStreamedReceiverLog("Living Room TV", ["second", "third"])

    expect(getStreamedReceiverLog("Living Room TV")).toEqual(["first", "second", "third"])
    const snapshot = getReceiverLogSnapshots()["Living Room TV"]
    expect(snapshot.source).toBe("stream")
    expect(snapshot.text).toBe("first\nsecond\nthird")
  })

  it("keeps devices separate", async () => {
    const { appendStreamedReceiverLog, getStreamedReceiverLog } = await import("../src/scripts/lib/tv-cast")
    appendStreamedReceiverLog("TV A", ["a"])
    appendStreamedReceiverLog("TV B", ["b"])
    expect(getStreamedReceiverLog("TV A")).toEqual(["a"])
    expect(getStreamedReceiverLog("TV B")).toEqual(["b"])
  })

  it("caps the buffer, dropping the oldest lines", async () => {
    const { appendStreamedReceiverLog, getStreamedReceiverLog } = await import("../src/scripts/lib/tv-cast")
    const lines = Array.from({ length: 450 }, (_, index) => `line-${index}`)
    appendStreamedReceiverLog("TV", lines)
    const kept = getStreamedReceiverLog("TV")
    expect(kept.length).toBe(400)
    expect(kept[0]).toBe("line-50")
    expect(kept.at(-1)).toBe("line-449")
  })

  it("ignores empty batches so a quiet receiver doesn't churn storage", async () => {
    const { appendStreamedReceiverLog, getStreamedReceiverLog, getReceiverLogSnapshots } = await import(
      "../src/scripts/lib/tv-cast"
    )
    appendStreamedReceiverLog("TV", ["   ", ""])
    expect(getStreamedReceiverLog("TV")).toEqual([])
    expect(getReceiverLogSnapshots()["TV"]).toBeUndefined()
  })
})
