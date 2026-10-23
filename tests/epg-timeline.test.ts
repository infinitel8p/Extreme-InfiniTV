import { describe, it, expect } from "vitest"
import { createTimeline } from "@/scripts/lib/epg-timeline.ts"

const HOUR = 3600_000
const DAY = 24 * HOUR

// Fake zone: UTC+1 until 2026-03-29T01:00Z, UTC+2 after (spring-forward day is 23h).
const DST_SWITCH = Date.UTC(2026, 2, 29, 1)
const offsetAt = (ts: number) => (ts < DST_SWITCH ? HOUR : 2 * HOUR)
function zoneStartOfDay(ts: number): number {
  let candidate = Math.floor((ts + offsetAt(ts)) / DAY) * DAY - offsetAt(ts)
  candidate = Math.floor((ts + offsetAt(candidate)) / DAY) * DAY - offsetAt(candidate)
  return candidate
}

const flatStartOfDay = (ts: number) => Math.floor(ts / DAY) * DAY
const railStart = Date.UTC(2026, 0, 8)
const railEnd = Date.UTC(2026, 0, 17)

function flat() {
  return createTimeline({ railStart, railEnd, pxPerHour: 200, startOfDay: flatStartOfDay })
}

describe("epg-timeline", () => {
  it("maps time to x and back from a single origin", () => {
    const timeline = flat()
    expect(timeline.timeToX(railStart)).toBe(0)
    expect(timeline.timeToX(railStart + 2 * HOUR)).toBe(400)
    expect(timeline.xToTime(400)).toBe(railStart + 2 * HOUR)
    expect(timeline.xToTime(timeline.timeToX(railStart + 5 * DAY))).toBe(railStart + 5 * DAY)
  })

  it("reports total width for the whole rail", () => {
    expect(flat().width).toBe(9 * 24 * 200)
  })

  it("clamps scroll within the rail", () => {
    const timeline = flat()
    expect(timeline.clampScroll(-50, 1000)).toBe(0)
    expect(timeline.clampScroll(1e9, 1000)).toBe(timeline.width - 1000)
    expect(timeline.clampScroll(500, 1000)).toBe(500)
  })

  it("computes the visible window with overscan clamped to the rail", () => {
    const timeline = flat()
    const window = timeline.visibleWindow(100, 1000, 1000)
    expect(window.fromX).toBe(0)
    expect(window.toX).toBe(2100)
    expect(window.fromTs).toBe(railStart)
    expect(window.toTs).toBe(timeline.xToTime(2100))
    expect(timeline.visibleWindow(timeline.width - 10, 1000, 1000).toX).toBe(timeline.width)
  })

  it("derives the day label from the left edge plus an inset", () => {
    const timeline = flat()
    const midnightX = timeline.timeToX(railStart + DAY)
    expect(timeline.dayLabelForScroll(midnightX - 300)).toBe(railStart)
    expect(timeline.dayLabelForScroll(midnightX - 300, 4 * HOUR)).toBe(railStart + DAY)
    expect(timeline.dayLabelForScroll(midnightX - 100, 2 * HOUR)).toBe(railStart + DAY)
    expect(timeline.dayLabelForScroll(midnightX)).toBe(railStart + DAY)
  })

  it("never labels a day past the rail end", () => {
    const timeline = flat()
    expect(timeline.dayLabelForScroll(timeline.width + 5000)).toBe(railEnd - DAY)
  })

  it("emits half-hour ruler ticks aligned to the rail origin", () => {
    const timeline = flat()
    const ticks = timeline.rulerTicks(railStart + 10 * 60_000, railStart + 2 * HOUR, 30)
    expect(ticks.map((tick) => tick.ts)).toEqual([
      railStart + 30 * 60_000,
      railStart + HOUR,
      railStart + 90 * 60_000,
      railStart + 2 * HOUR,
    ])
    expect(ticks[0].x).toBe(100)
  })

  it("flags midnight ticks", () => {
    const timeline = flat()
    const ticks = timeline.rulerTicks(railStart + 22 * HOUR, railStart + 26 * HOUR, 60)
    const midnights = ticks.filter((tick) => tick.isMidnight)
    expect(midnights).toHaveLength(1)
    expect(midnights[0].ts).toBe(railStart + DAY)
  })

  it("clamps ticks to the rail", () => {
    const timeline = flat()
    const head = timeline.rulerTicks(railStart - 5 * HOUR, railStart + HOUR, 60)
    expect(head[0].ts).toBe(railStart)
    const tail = timeline.rulerTicks(railEnd - HOUR, railEnd + 5 * HOUR, 60)
    expect(tail[tail.length - 1].ts).toBe(railEnd)
  })

  it("keeps real local midnights on a spring-forward day", () => {
    const start = zoneStartOfDay(Date.UTC(2026, 2, 27, 12))
    const end = zoneStartOfDay(Date.UTC(2026, 3, 1, 12))
    const timeline = createTimeline({
      railStart: start,
      railEnd: end,
      pxPerHour: 200,
      startOfDay: zoneStartOfDay,
    })
    const midnights = timeline
      .rulerTicks(start, end, 60)
      .filter((tick) => tick.isMidnight)
      .map((tick) => tick.ts)
    const springDay = zoneStartOfDay(Date.UTC(2026, 2, 29, 12))
    const nextDay = zoneStartOfDay(Date.UTC(2026, 2, 30, 12))
    expect(nextDay - springDay).toBe(23 * HOUR)
    expect(midnights).toContain(springDay)
    expect(midnights).toContain(nextDay)
    expect(timeline.timeToX(nextDay) - timeline.timeToX(springDay)).toBe(23 * 200)
  })

  it("labels the day by real local midnight across DST", () => {
    const start = zoneStartOfDay(Date.UTC(2026, 2, 27, 12))
    const timeline = createTimeline({
      railStart: start,
      railEnd: start + 6 * DAY,
      pxPerHour: 200,
      startOfDay: zoneStartOfDay,
    })
    const springDay = zoneStartOfDay(Date.UTC(2026, 2, 29, 12))
    expect(timeline.dayLabelForScroll(timeline.timeToX(springDay) + 50, 0)).toBe(springDay)
    expect(timeline.dayAt(springDay + 23 * HOUR - 1)).toBe(springDay)
  })

  it("returns only programmes overlapping the window", () => {
    const timeline = flat()
    const list = [
      { start: railStart, stop: railStart + HOUR },
      { start: railStart + HOUR, stop: railStart + 2 * HOUR },
      { start: railStart + 2 * HOUR, stop: railStart + 3 * HOUR },
    ]
    const cells = timeline.programmeCellsInWindow(list, railStart + HOUR, railStart + 2 * HOUR)
    expect(cells).toHaveLength(1)
    expect(cells[0]).toMatchObject({ x: 200, width: 200, clippedLeft: false, clippedRight: false })
    expect(cells[0].programme).toBe(list[1])
  })

  it("flags programmes clipped by the rail ends", () => {
    const timeline = flat()
    const list = [
      { start: railStart - HOUR, stop: railStart + HOUR },
      { start: railEnd - HOUR, stop: railEnd + HOUR },
    ]
    const cells = timeline.programmeCellsInWindow(list, railStart - DAY, railEnd + DAY)
    expect(cells[0]).toMatchObject({ x: 0, width: 200, clippedLeft: true, clippedRight: false })
    expect(cells[1]).toMatchObject({ clippedLeft: false, clippedRight: true, width: 200 })
  })

  it("gives tiny programmes a minimum width", () => {
    const timeline = flat()
    const cells = timeline.programmeCellsInWindow(
      [{ start: railStart + HOUR, stop: railStart + HOUR + 1000 }],
      railStart,
      railEnd
    )
    expect(cells[0].width).toBe(2)
  })
})
