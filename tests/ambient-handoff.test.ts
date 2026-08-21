import { describe, expect, it } from "vitest"

import { buildAmbientHandoff, isHandoffFresh } from "../src/scripts/lib/ambient-handoff"
import type { AmbientEntry } from "../src/scripts/lib/ambient-manifest"

function makeEntry(overrides: Partial<AmbientEntry> = {}): AmbientEntry {
  return {
    kind: "vod",
    id: "1",
    title: "Some Movie",
    posterUrl: "https://x/poster.png",
    backdropUrl: null,
    logoUrl: null,
    tier: "recommended",
    ...overrides,
  }
}

describe("buildAmbientHandoff", () => {
  it("stamps the version and timestamp", () => {
    const payload = buildAmbientHandoff([makeEntry()], null, 12345)
    expect(payload.v).toBe(1)
    expect(payload.at).toBe(12345)
  })

  it("propagates a string user agent", () => {
    const payload = buildAmbientHandoff([], "VLC/3.0.20 LibVLC/3.0.20", 1)
    expect(payload.ua).toBe("VLC/3.0.20 LibVLC/3.0.20")
  })

  it("propagates a null user agent", () => {
    const payload = buildAmbientHandoff([], null, 1)
    expect(payload.ua).toBeNull()
  })

  it("drops entries with no artwork url at all", () => {
    const withArtwork = makeEntry({ id: "with" })
    const withoutArtwork = makeEntry({ id: "without", posterUrl: null, backdropUrl: null, logoUrl: null })
    const payload = buildAmbientHandoff([withArtwork, withoutArtwork], null, 1)
    expect(payload.entries).toEqual([withArtwork])
  })

  it("caps the entry list at 50", () => {
    const entries = Array.from({ length: 60 }, (_, index) => makeEntry({ id: String(index) }))
    const payload = buildAmbientHandoff(entries, null, 1)
    expect(payload.entries).toHaveLength(50)
    expect(payload.entries[0].id).toBe("0")
  })
})

describe("isHandoffFresh", () => {
  it("is fresh when written within the ttl", () => {
    expect(isHandoffFresh({ at: 1000 }, 2000, 5000)).toBe(true)
  })

  it("is stale once the ttl has elapsed", () => {
    expect(isHandoffFresh({ at: 1000 }, 7000, 5000)).toBe(false)
  })

  it("is not fresh for null", () => {
    expect(isHandoffFresh(null, 2000, 5000)).toBe(false)
  })

  it("is not fresh when the at field is missing", () => {
    expect(isHandoffFresh({}, 2000, 5000)).toBe(false)
  })

  it("is not fresh for a malformed value", () => {
    expect(isHandoffFresh("not-an-object", 2000, 5000)).toBe(false)
    expect(isHandoffFresh({ at: "1000" }, 2000, 5000)).toBe(false)
  })
})
