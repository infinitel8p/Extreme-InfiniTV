import { describe, it, expect } from "vitest"

import { computeNowNext, formatTimeRange, programmesForDay, type Programme } from "@/scripts/lib/now-next"

const PLAYLIST_ID = "pl1"

function channel(tvgId: string) {
  return { id: 1, name: "Test channel", tvgId }
}

describe("computeNowNext", () => {
  it("returns current + next when both exist", () => {
    const nowMs = new Date(2026, 0, 15, 20, 30).getTime()
    const programmes = new Map<string, Programme[]>([
      [
        "test",
        [
          { start: nowMs - 30 * 60_000, stop: nowMs + 30 * 60_000, title: "Now show" },
          { start: nowMs + 30 * 60_000, stop: nowMs + 90 * 60_000, title: "Next show" },
        ],
      ],
    ])
    const slot = computeNowNext(programmes, channel("test"), PLAYLIST_ID, nowMs)
    expect(slot.current?.title).toBe("Now show")
    expect(slot.next?.title).toBe("Next show")
  })

  it("returns only next when nothing is airing yet", () => {
    const nowMs = new Date(2026, 0, 15, 20, 0).getTime()
    const programmes = new Map<string, Programme[]>([
      ["test", [{ start: nowMs + 10 * 60_000, stop: nowMs + 40 * 60_000, title: "Upcoming" }]],
    ])
    const slot = computeNowNext(programmes, channel("test"), PLAYLIST_ID, nowMs)
    expect(slot.current).toBeNull()
    expect(slot.next?.title).toBe("Upcoming")
  })

  it("returns nulls when there is no guide data for the channel", () => {
    const nowMs = Date.now()
    expect(computeNowNext(null, channel("test"), PLAYLIST_ID, nowMs)).toEqual({ current: null, next: null })
    expect(computeNowNext(new Map(), channel("test"), PLAYLIST_ID, nowMs)).toEqual({ current: null, next: null })
    expect(computeNowNext(new Map([["test", []]]), channel("test"), PLAYLIST_ID, nowMs)).toEqual({
      current: null,
      next: null,
    })
  })

  it("clamps progress to 0..1 across the current programme's span", () => {
    const start = new Date(2026, 0, 15, 20, 0).getTime()
    const stop = new Date(2026, 0, 15, 21, 0).getTime()
    const programmes = new Map<string, Programme[]>([["test", [{ start, stop, title: "Show" }]]])

    const atStart = computeNowNext(programmes, channel("test"), PLAYLIST_ID, start)
    expect(atStart.current?.progress).toBe(0)

    const almostDone = computeNowNext(programmes, channel("test"), PLAYLIST_ID, stop - 1)
    expect(almostDone.current?.progress).toBeGreaterThan(0.99)
    expect(almostDone.current?.progress).toBeLessThanOrEqual(1)
  })
})

describe("formatTimeRange", () => {
  it("formats an hour:minute range in the given locale", () => {
    const start = new Date(2026, 0, 15, 20, 0).getTime()
    const stop = new Date(2026, 0, 15, 21, 30).getTime()
    expect(formatTimeRange(start, stop, "en-US")).toBe("8:00 PM–9:30 PM")
  })

  it("returns an empty string on a formatting error", () => {
    const start = new Date(2026, 0, 15, 20, 0).getTime()
    expect(formatTimeRange(start, start, "???")).toBe("")
  })
})

describe("programmesForDay", () => {
  const dayStart = new Date(2026, 0, 15, 0, 0).getTime()
  const dayEnd = dayStart + 24 * 60 * 60 * 1000

  const programmes: Programme[] = [
    { start: dayEnd - 30 * 60_000, stop: dayEnd + 30 * 60_000, title: "Straddles midnight" },
    { start: dayStart + 60 * 60_000, stop: dayStart + 120 * 60_000, title: "Mid morning" },
    { start: dayStart - 60 * 60_000, stop: dayStart + 30 * 60_000, title: "Straddles start" },
    { start: dayEnd + 60 * 60_000, stop: dayEnd + 120 * 60_000, title: "Next day" },
    { start: dayStart - 120 * 60_000, stop: dayStart - 60 * 60_000, title: "Previous day" },
  ]

  it("keeps only programmes overlapping the day window, sorted by start", () => {
    const result = programmesForDay(programmes, dayStart)
    expect(result.map((programme) => programme.title)).toEqual([
      "Straddles start",
      "Mid morning",
      "Straddles midnight",
    ])
  })

  it("returns an empty array with no programmes", () => {
    expect(programmesForDay(undefined, dayStart)).toEqual([])
    expect(programmesForDay([], dayStart)).toEqual([])
  })
})
