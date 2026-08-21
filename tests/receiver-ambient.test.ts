import { describe, expect, it, vi } from "vitest"

vi.mock("@/scripts/lib/ambient-manifest", () => ({
  buildAmbientManifest: vi.fn(async () => []),
}))

import {
  ambientEntryKey,
  appendCastHistory,
  buildAmbientRenderModel,
  canEnterAmbient,
  castHistoryToAmbientEntries,
  nextRotationIndex,
  playableAmbientEntries,
  recordArtworkFailure,
  type CastHistoryEntry,
} from "../src/scripts/receiver/ambient"
import type { AmbientEntry } from "../src/scripts/lib/ambient-manifest"

function makeEntry(overrides: Partial<AmbientEntry> = {}): AmbientEntry {
  return {
    kind: "vod",
    id: "1",
    title: "Some Movie",
    posterUrl: null,
    backdropUrl: null,
    logoUrl: null,
    tier: "recommended",
    ...overrides,
  }
}

describe("appendCastHistory", () => {
  it("rejects empty titles and non-http logos", () => {
    const list: CastHistoryEntry[] = []
    expect(appendCastHistory(list, { title: "", logo: "https://x/img.png" })).toBe(list)
    expect(appendCastHistory(list, { title: "Movie", logo: "data:image/png;base64,abc" })).toBe(list)
    expect(appendCastHistory(list, { title: "Movie", logo: "" })).toBe(list)
  })

  it("adds a new entry to the front", () => {
    const list: CastHistoryEntry[] = [{ title: "Old", logo: "https://x/old.png", at: 1 }]
    const result = appendCastHistory(list, { title: "New", logo: "https://x/new.png" })
    expect(result[0].title).toBe("New")
    expect(result[1].title).toBe("Old")
  })

  it("dedupes by title+logo, refreshes the timestamp and moves the entry to the front", () => {
    const list: CastHistoryEntry[] = [
      { title: "New", logo: "https://x/new.png", at: 1 },
      { title: "Old", logo: "https://x/old.png", at: 2 },
    ]
    const result = appendCastHistory(list, { title: "Old", logo: "https://x/old.png" })
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe("Old")
    expect(result[0].at).toBeGreaterThan(2)
    expect(result[1].title).toBe("New")
  })

  it("caps the list length, dropping the oldest entries", () => {
    const list: CastHistoryEntry[] = [
      { title: "Movie 2", logo: "https://x/2.png", at: 2 },
      { title: "Movie 1", logo: "https://x/1.png", at: 1 },
      { title: "Movie 0", logo: "https://x/0.png", at: 0 },
    ]
    const result = appendCastHistory(list, { title: "Newest", logo: "https://x/newest.png" }, 2)
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe("Newest")
    expect(result[1].title).toBe("Movie 2")
  })
})

describe("castHistoryToAmbientEntries", () => {
  it("maps history entries into watching-tier ambient entries", () => {
    const history: CastHistoryEntry[] = [{ title: "Movie", logo: "https://x/movie.png", at: 1 }]
    const entries = castHistoryToAmbientEntries(history)
    expect(entries).toEqual([
      {
        kind: "vod",
        id: expect.stringContaining("history:0:"),
        title: "Movie",
        posterUrl: "https://x/movie.png",
        backdropUrl: null,
        logoUrl: null,
        tier: "watching",
      },
    ])
  })
})

describe("buildAmbientRenderModel", () => {
  it("prefers the backdrop as a full-bleed cover with ken burns enabled", () => {
    const model = buildAmbientRenderModel(makeEntry({ backdropUrl: "https://x/backdrop.png", posterUrl: "https://x/poster.png" }))
    expect(model).toEqual({ coverImageUrl: "https://x/backdrop.png", posterUrl: null, kenBurns: true })
  })

  it("falls back to the poster as both the blurred cover and the sharp panel", () => {
    const model = buildAmbientRenderModel(makeEntry({ posterUrl: "https://x/poster.png" }))
    expect(model).toEqual({ coverImageUrl: "https://x/poster.png", posterUrl: "https://x/poster.png", kenBurns: false })
  })

  it("returns null when neither image is available", () => {
    expect(buildAmbientRenderModel(makeEntry())).toBeNull()
  })
})

describe("playableAmbientEntries", () => {
  it("drops entries with no artwork", () => {
    const withArtwork = makeEntry({ id: "with", posterUrl: "https://x/p.png" })
    const withoutArtwork = makeEntry({ id: "without" })
    expect(playableAmbientEntries([withArtwork, withoutArtwork])).toEqual([withArtwork])
  })
})

describe("canEnterAmbient", () => {
  const entries = [makeEntry({ posterUrl: "https://x/p.png" })]

  it("allows entering from idle, ended or error states with entries available", () => {
    expect(canEnterAmbient("idle", entries)).toBe(true)
    expect(canEnterAmbient("ended", entries)).toBe(true)
    expect(canEnterAmbient("error", entries)).toBe(true)
  })

  it("blocks entering while actively playing", () => {
    expect(canEnterAmbient("playing", entries)).toBe(false)
    expect(canEnterAmbient("loading", entries)).toBe(false)
    expect(canEnterAmbient("buffering", entries)).toBe(false)
    expect(canEnterAmbient("paused", entries)).toBe(false)
  })

  it("blocks entering with no artwork available", () => {
    expect(canEnterAmbient("idle", [])).toBe(false)
  })
})

describe("nextRotationIndex", () => {
  it("advances and wraps around", () => {
    expect(nextRotationIndex(3, -1)).toBe(0)
    expect(nextRotationIndex(3, 0)).toBe(1)
    expect(nextRotationIndex(3, 2)).toBe(0)
  })

  it("returns 0 for an empty list", () => {
    expect(nextRotationIndex(0, 5)).toBe(0)
  })
})

describe("recordArtworkFailure", () => {
  it("drops an entry only after it hits the failure cap", () => {
    const failures = new Map<string, number>()
    expect(recordArtworkFailure(failures, "vod:1")).toBe(false)
    expect(recordArtworkFailure(failures, "vod:1")).toBe(true)
  })

  it("tracks failures independently per key", () => {
    const failures = new Map<string, number>()
    recordArtworkFailure(failures, "vod:1")
    expect(recordArtworkFailure(failures, "vod:2")).toBe(false)
  })
})

describe("ambientEntryKey", () => {
  it("combines kind and id", () => {
    expect(ambientEntryKey(makeEntry({ kind: "series", id: "42" }))).toBe("series:42")
  })
})
