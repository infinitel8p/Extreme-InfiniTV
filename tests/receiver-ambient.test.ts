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
  resolveAmbientMode,
  sanitizePushedAmbientEntries,
  selectAmbientArtwork,
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
  it("prefers the backdrop as a full-bleed cover with ken burns enabled, carrying the poster for the card", () => {
    const model = buildAmbientRenderModel(makeEntry({ backdropUrl: "https://x/backdrop.png", posterUrl: "https://x/poster.png" }))
    expect(model).toEqual({ coverImageUrl: "https://x/backdrop.png", posterUrl: "https://x/poster.png", kenBurns: true })
  })

  it("uses the backdrop with no poster card when the entry has no poster", () => {
    const model = buildAmbientRenderModel(makeEntry({ backdropUrl: "https://x/backdrop.png" }))
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

describe("resolveAmbientMode", () => {
  const entries = [makeEntry({ posterUrl: "https://x/p.png" })]

  it("resolves to artwork when eligible and entries are playable", () => {
    expect(resolveAmbientMode("idle", entries)).toBe("artwork")
    expect(resolveAmbientMode("ended", entries)).toBe("artwork")
    expect(resolveAmbientMode("error", entries)).toBe("artwork")
  })

  it("resolves to brand when eligible but no artwork is available", () => {
    expect(resolveAmbientMode("idle", [])).toBe("brand")
    expect(resolveAmbientMode("ended", [])).toBe("brand")
    expect(resolveAmbientMode("error", [])).toBe("brand")
  })

  it("resolves to none while actively playing, regardless of artwork", () => {
    expect(resolveAmbientMode("playing", entries)).toBe("none")
    expect(resolveAmbientMode("playing", [])).toBe("none")
    expect(resolveAmbientMode("paused", entries)).toBe("none")
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

describe("sanitizePushedAmbientEntries", () => {
  it("returns an empty list for a non-array", () => {
    expect(sanitizePushedAmbientEntries(null)).toEqual([])
    expect(sanitizePushedAmbientEntries({ entries: [] })).toEqual([])
  })

  it("keeps a well-formed entry", () => {
    const entries = sanitizePushedAmbientEntries([
      { kind: "vod", id: "1", title: "Some Movie", posterUrl: "https://x/p.png", tier: "recent" },
    ])
    expect(entries).toEqual([
      { kind: "vod", id: "1", title: "Some Movie", posterUrl: "https://x/p.png", backdropUrl: null, logoUrl: null, tier: "recent" },
    ])
  })

  it("drops an entry with an unknown kind, a blank id, or a blank title", () => {
    const entries = sanitizePushedAmbientEntries([
      { kind: "channel", id: "1", title: "Bad kind", posterUrl: "https://x/p.png", tier: "catalog" },
      { kind: "vod", id: "", title: "Blank id", posterUrl: "https://x/p.png", tier: "catalog" },
      { kind: "vod", id: "2", title: "   ", posterUrl: "https://x/p.png", tier: "catalog" },
    ])
    expect(entries).toEqual([])
  })

  it("drops an entry with no artwork url at all", () => {
    expect(sanitizePushedAmbientEntries([{ kind: "vod", id: "1", title: "No art", tier: "catalog" }])).toEqual([])
  })

  it("nulls non-http posterUrl/backdropUrl/logoUrl values", () => {
    const entries = sanitizePushedAmbientEntries([
      {
        kind: "vod",
        id: "1",
        title: "Local file art",
        posterUrl: "file:///etc/passwd",
        backdropUrl: "javascript:alert(1)",
        logoUrl: "https://x/logo.png",
        tier: "catalog",
      },
    ])
    expect(entries).toEqual([
      { kind: "vod", id: "1", title: "Local file art", posterUrl: null, backdropUrl: null, logoUrl: "https://x/logo.png", tier: "catalog" },
    ])
  })

  it("drops an entry whose artwork urls are all non-http", () => {
    const entries = sanitizePushedAmbientEntries([
      { kind: "vod", id: "1", title: "All local", posterUrl: "file:///poster.png", backdropUrl: "data:image/png;base64,abc", tier: "catalog" },
    ])
    expect(entries).toEqual([])
  })

  it("falls back to the catalog tier for an unknown tier", () => {
    const entries = sanitizePushedAmbientEntries([
      { kind: "vod", id: "1", title: "Movie", posterUrl: "https://x/p.png", tier: "trending" },
    ])
    expect(entries[0].tier).toBe("catalog")
  })

  it("caps the result at the given limit", () => {
    const source = Array.from({ length: 5 }, (_, index) => ({
      kind: "vod",
      id: String(index),
      title: `Movie ${index}`,
      posterUrl: "https://x/p.png",
      tier: "catalog",
    }))
    expect(sanitizePushedAmbientEntries(source, 2)).toHaveLength(2)
  })
})

describe("selectAmbientArtwork", () => {
  const libraryEntries = [makeEntry({ id: "library" })]
  const pushedEntries = [makeEntry({ id: "pushed" })]
  const castHistoryEntries = [makeEntry({ id: "history" })]

  it("prefers local library artwork when it is non-empty", () => {
    const selected = selectAmbientArtwork({
      libraryEntries,
      pushedManifest: { at: Date.now(), entries: pushedEntries },
      castHistoryEntries,
    })
    expect(selected).toBe(libraryEntries)
  })

  it("falls back to a fresh pushed manifest when the library is empty", () => {
    const selected = selectAmbientArtwork({
      libraryEntries: [],
      pushedManifest: { at: Date.now(), entries: pushedEntries },
      castHistoryEntries,
    })
    expect(selected).toBe(pushedEntries)
  })

  it("ignores a pushed manifest older than 7 days", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    const selected = selectAmbientArtwork({
      libraryEntries: [],
      pushedManifest: { at: eightDaysAgo, entries: pushedEntries },
      castHistoryEntries,
      now: Date.now(),
    })
    expect(selected).toBe(castHistoryEntries)
  })

  it("falls back to cast history when there is no pushed manifest", () => {
    const selected = selectAmbientArtwork({ libraryEntries: [], pushedManifest: null, castHistoryEntries })
    expect(selected).toBe(castHistoryEntries)
  })
})
