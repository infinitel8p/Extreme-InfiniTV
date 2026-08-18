import { describe, it, expect } from "vitest"
import { bufferedAheadSeconds, deriveFps } from "@/scripts/lib/player-telemetry.js"
import {
  formatBitrate,
  formatVariantLabel,
  formatDroppedFrames,
  formatSeconds,
  statsRows,
} from "@/scripts/lib/player-stats.js"
import type { EngineStats } from "@/scripts/lib/player-telemetry.js"

const translate = (key: string, params?: Record<string, string | number>): string => {
  if (key === "player.stats.unavailable") return "-"
  if (key === "player.stats.auto") return "auto"
  if (params) return `${key}(${JSON.stringify(params)})`
  return key
}

describe("bufferedAheadSeconds", () => {
  it("returns 0 for an empty ranges array", () => {
    expect(bufferedAheadSeconds([], 10)).toBe(0)
  })

  it("returns the remaining buffer inside a range", () => {
    expect(bufferedAheadSeconds([{ start: 0, end: 20 }], 10)).toBe(10)
  })

  it("picks the range containing the position when there is a gap", () => {
    const ranges = [{ start: 0, end: 5 }, { start: 30, end: 40 }]
    expect(bufferedAheadSeconds(ranges, 32)).toBe(8)
  })

  it("returns 0 when no range contains the position", () => {
    const ranges = [{ start: 0, end: 5 }, { start: 30, end: 40 }]
    expect(bufferedAheadSeconds(ranges, 15)).toBe(0)
  })

  it("applies the +/-1s tolerance just before a range starts", () => {
    expect(bufferedAheadSeconds([{ start: 10, end: 20 }], 9.5)).toBeCloseTo(10.5)
  })

  it("applies the +/-1s tolerance just after a range ends", () => {
    expect(bufferedAheadSeconds([{ start: 10, end: 20 }], 20.5)).toBe(0)
  })

  it("returns 0 for a NaN currentTime", () => {
    expect(bufferedAheadSeconds([{ start: 0, end: 20 }], NaN)).toBe(0)
  })

  it("returns 0 for a negative currentTime outside every range", () => {
    expect(bufferedAheadSeconds([{ start: 0, end: 20 }], -10)).toBe(0)
  })
})

describe("deriveFps", () => {
  it("returns null when there is no previous sample", () => {
    expect(deriveFps(null, { frames: 100, at: 1000 })).toBeNull()
  })

  it("computes fps from a normal sample pair", () => {
    const fps = deriveFps({ frames: 0, at: 0 }, { frames: 25, at: 1000 })
    expect(fps).toBe(25)
  })

  it("returns null when elapsed time is 0", () => {
    expect(deriveFps({ frames: 0, at: 1000 }, { frames: 10, at: 1000 })).toBeNull()
  })

  it("returns null when elapsed time is negative", () => {
    expect(deriveFps({ frames: 0, at: 1000 }, { frames: 10, at: 900 })).toBeNull()
  })

  it("returns null when the frame counter went backwards", () => {
    expect(deriveFps({ frames: 500, at: 0 }, { frames: 10, at: 1000 })).toBeNull()
  })
})

describe("formatBitrate", () => {
  it("formats sub-Mbps values as kbps", () => {
    expect(formatBitrate(812_000)).toBe("812 kbps")
  })

  it("formats Mbps-and-above values with one decimal", () => {
    expect(formatBitrate(5_200_000)).toBe("5.2 Mbps")
  })

  it("returns unavailable for null", () => {
    expect(formatBitrate(null)).toBe("-")
  })

  it("returns unavailable for zero", () => {
    expect(formatBitrate(0)).toBe("-")
  })

  it("returns unavailable for negative values", () => {
    expect(formatBitrate(-100)).toBe("-")
  })

  it("returns unavailable for non-finite values", () => {
    expect(formatBitrate(Infinity)).toBe("-")
    expect(formatBitrate(NaN)).toBe("-")
  })
})

describe("formatVariantLabel", () => {
  it("shows auto plus index/count plus resolution", () => {
    const label = formatVariantLabel(
      { levelIndex: 2, levelCount: 5, autoLevel: true, videoHeight: 1080, videoWidth: 1920 },
      translate,
    )
    expect(label).toBe("auto · 3/5 · 1080p")
  })

  it("falls back to WxH when only width is known", () => {
    const label = formatVariantLabel(
      { levelIndex: null, levelCount: null, autoLevel: null, videoHeight: null, videoWidth: 1920 },
      translate,
    )
    expect(label).toBe("1920x0")
  })

  it("returns unavailable when everything is unknown", () => {
    const label = formatVariantLabel(
      { levelIndex: null, levelCount: null, autoLevel: null, videoHeight: null, videoWidth: null },
      translate,
    )
    expect(label).toBe("-")
  })
})

describe("formatDroppedFrames", () => {
  it("formats dropped/total with a one-decimal percentage", () => {
    expect(formatDroppedFrames(12, 4310)).toBe("12 / 4310 (0.3%)")
  })

  it("shows just the count when the total is unknown", () => {
    expect(formatDroppedFrames(7, null)).toBe("7")
  })

  it("returns unavailable when both are unknown", () => {
    expect(formatDroppedFrames(null, null)).toBe("-")
  })
})

describe("formatSeconds", () => {
  it("formats with one decimal", () => {
    expect(formatSeconds(4.8)).toBe("4.8s")
  })

  it("returns unavailable for null", () => {
    expect(formatSeconds(null)).toBe("-")
  })

  it("returns unavailable for non-finite values", () => {
    expect(formatSeconds(NaN)).toBe("-")
    expect(formatSeconds(Infinity)).toBe("-")
  })

  it("returns unavailable for negative values", () => {
    expect(formatSeconds(-1)).toBe("-")
  })
})

describe("statsRows", () => {
  const labels = [
    "player.stats.engine",
    "player.stats.bitrate",
    "player.stats.variant",
    "player.stats.resolution",
    "player.stats.fps",
    "player.stats.dropped",
    "player.stats.buffered",
    "player.stats.segment",
  ]

  it("returns a stable row order and count for a full stats object", () => {
    const stats: EngineStats = {
      engine: "hls.js",
      declaredBitrateBps: 5_000_000,
      measuredBitrateBps: 4_800_000,
      levelIndex: 1,
      levelCount: 4,
      autoLevel: true,
      videoWidth: 1920,
      videoHeight: 1080,
      segmentDurationSeconds: 6,
      bufferedAheadSeconds: 12.4,
      droppedFrames: 3,
      totalFrames: 900,
      stalls: 0,
    }
    const rows = statsRows(stats, translate, { fps: 25 })
    expect(rows).toHaveLength(labels.length)
    expect(rows.map((row) => row.label)).toEqual(labels.map((key) => translate(key)))
    const bitrateRow = rows.find((row) => row.label === translate("player.stats.bitrate"))
    expect(bitrateRow?.value).toContain("5.0 Mbps")
    expect(bitrateRow?.value).toContain("player.stats.estimated")
  })

  it("returns the same row count and order with an all-null stats object", () => {
    const rows = statsRows(null, translate)
    expect(rows).toHaveLength(labels.length)
    expect(rows.map((row) => row.label)).toEqual(labels.map((key) => translate(key)))
    for (const row of rows) expect(row.value).toBe("-")
  })

  it("returns the same row count and order for an mpegts-shaped object with no level data", () => {
    const stats: EngineStats = {
      engine: "mpegts.js",
      declaredBitrateBps: null,
      measuredBitrateBps: 3_100_000,
      levelIndex: null,
      levelCount: null,
      autoLevel: null,
      videoWidth: 1280,
      videoHeight: 720,
      segmentDurationSeconds: null,
      bufferedAheadSeconds: 2,
      droppedFrames: null,
      totalFrames: null,
      stalls: null,
    }
    const rows = statsRows(stats, translate)
    expect(rows).toHaveLength(labels.length)
    expect(rows.map((row) => row.label)).toEqual(labels.map((key) => translate(key)))
    const variantRow = rows.find((row) => row.label === translate("player.stats.variant"))
    expect(variantRow?.value).toBe("720p")
    const droppedRow = rows.find((row) => row.label === translate("player.stats.dropped"))
    expect(droppedRow?.value).toBe("-")
  })
})
