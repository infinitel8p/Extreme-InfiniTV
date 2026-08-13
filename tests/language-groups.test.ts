import { describe, it, expect } from "vitest"
import {
  buildGroupingIndex,
  pickPreferredEntryId,
  groupPassesLanguageFilter,
  type GroupableEntry,
} from "@/scripts/lib/language-groups.ts"

function groupFor(index: ReturnType<typeof buildGroupingIndex>, entryId: number) {
  const key = index.keyByEntryId.get(entryId)
  return key ? index.groupsByKey.get(key) : undefined
}

describe("buildGroupingIndex", () => {
  it("groups tmdb entries sharing an id even when titles are localized", () => {
    const entries: GroupableEntry[] = [
      { id: 1, name: "EN - Project Hail Mary (2026)", tmdb: 12345 },
      { id: 2, name: "ES - Proyecto Salvación (2026)", tmdb: 12345 },
      { id: 3, name: "FR - Projet Dernière Chance (2026)", tmdb: 12345 },
    ]
    const index = buildGroupingIndex(entries)
    const group = groupFor(index, 1)
    expect(group?.key).toBe("t:12345")
    expect(group?.entryIds.sort()).toEqual([1, 2, 3])
    expect(group?.tags).toEqual(["EN", "ES", "FR"])
    expect(group?.multiVariant).toBe(true)
    expect(groupFor(index, 2)?.key).toBe("t:12345")
    expect(groupFor(index, 3)?.key).toBe("t:12345")
  })

  it("bridges a tmdb-less variant into the matching tmdb group by cleaned title + year", () => {
    const entries: GroupableEntry[] = [
      { id: 4, name: "EN - The Batman (2022)", tmdb: 500 },
      { id: 5, name: "DE - The Batman (2022)" },
    ]
    const index = buildGroupingIndex(entries)
    expect(index.keyByEntryId.get(5)).toBe("t:500")
    const group = groupFor(index, 4)
    expect(group?.entryIds.sort()).toEqual([4, 5])
    expect(group?.tags).toEqual(["EN", "DE"])
  })

  it("does not merge a tmdb-less variant when the title bridges to more than one tmdb id", () => {
    const entries: GroupableEntry[] = [
      { id: 6, name: "EN - Michael (2026)", tmdb: 900 },
      { id: 7, name: "DE - Michael (2026)", tmdb: 901 },
      { id: 8, name: "FR - Michael (2026)" },
    ]
    const index = buildGroupingIndex(entries)
    expect(groupFor(index, 6)?.key).toBe("t:900")
    expect(groupFor(index, 6)?.entryIds).toEqual([6])
    expect(groupFor(index, 7)?.key).toBe("t:901")
    expect(groupFor(index, 7)?.entryIds).toEqual([7])
    const ambiguousGroup = groupFor(index, 8)
    expect(ambiguousGroup?.key).toBe("e:8")
    expect(ambiguousGroup?.entryIds).toEqual([8])
    expect(ambiguousGroup?.tags).toEqual(["FR"])
  })

  it("keeps a lone tagged variant of a cleaned title as its own single-entry group", () => {
    const entries: GroupableEntry[] = [{ id: 9, name: "IT - Chapter Two (2019)" }]
    const index = buildGroupingIndex(entries)
    const group = groupFor(index, 9)
    expect(group?.key).toBe("e:9")
    expect(group?.entryIds).toEqual([9])
    expect(group?.tags).toEqual(["IT"])
    expect(group?.multiVariant).toBe(false)
  })

  it("groups two DISTINCT-tag variants of the same cleaned title + year together", () => {
    const entries: GroupableEntry[] = [
      { id: 10, name: "IT - Chapter Two (2019)" },
      { id: 11, name: "EN - Chapter Two (2019)" },
    ]
    const index = buildGroupingIndex(entries)
    const group = groupFor(index, 10)
    expect(group?.key).toBe(groupFor(index, 11)?.key)
    expect(group?.entryIds.sort()).toEqual([10, 11])
    expect(group?.tags).toEqual(["IT", "EN"])
    expect(group?.multiVariant).toBe(true)
  })

  it("does not merge same-tag episodic entries whose distinguishing date is stripped by title cleanup", () => {
    // Same title, same tag (EN) - only one distinct tag, so none may merge.
    const entries: GroupableEntry[] = [
      { id: 30, name: "EN - WWE Raw" },
      { id: 31, name: "EN - WWE Raw (30/06/2025)" },
      { id: 32, name: "EN - WWE Raw (07/07/2025)" },
      { id: 33, name: "EN - WWE Raw (14/07/2025)" },
    ]
    const index = buildGroupingIndex(entries)
    const keys = entries.map((entry) => index.keyByEntryId.get(entry.id))
    expect(new Set(keys).size).toBe(entries.length)
    for (const entry of entries) {
      const group = groupFor(index, entry.id)
      expect(group?.entryIds).toEqual([entry.id])
      expect(group?.multiVariant).toBe(false)
    }
  })

  it("does not merge same-tag entries for different shows whose subtitle is stripped by title cleanup", () => {
    // Different shows colliding on cleaned title, same tag (IN) - must stay separate.
    const entries: GroupableEntry[] = [
      { id: 40, name: "IN - Charmsukh (Tauba Tauba)" },
      { id: 41, name: "IN - Charmsukh (Tapan)" },
    ]
    const index = buildGroupingIndex(entries)
    expect(index.keyByEntryId.get(40)).not.toBe(index.keyByEntryId.get(41))
    expect(groupFor(index, 40)?.entryIds).toEqual([40])
    expect(groupFor(index, 41)?.entryIds).toEqual([41])
  })

  it("merges a compound-prefix variant with plain-prefix variants of the same title (no tmdb id)", () => {
    // Compound prefix + missing-space typo.
    const entries: GroupableEntry[] = [
      { id: 60, name: "4K-FR -Reacher (2022)" },
      { id: 61, name: "FR - Reacher (2022)" },
      { id: 62, name: "EN - Reacher (2022)" },
    ]
    const index = buildGroupingIndex(entries)
    const key = index.keyByEntryId.get(60)
    expect(key).toBeDefined()
    expect(index.keyByEntryId.get(61)).toBe(key)
    expect(index.keyByEntryId.get(62)).toBe(key)
    const group = groupFor(index, 60)
    expect(group?.entryIds.sort()).toEqual([60, 61, 62])
    expect(group?.multiVariant).toBe(true)
  })

  it("gives untagged entries their own group even when they share a cleaned title", () => {
    const entries: GroupableEntry[] = [
      { id: 20, name: "Chapter Two (2019)" },
      { id: 21, name: "Chapter Two (2019)" },
    ]
    const index = buildGroupingIndex(entries)
    expect(groupFor(index, 20)?.key).toBe("e:20")
    expect(groupFor(index, 21)?.key).toBe("e:21")
  })

  it("dedupes same tmdb id + same-ish quality variants into one group", () => {
    const entries: GroupableEntry[] = [
      { id: 12, name: "Michael (2026)", tmdb: 2000 },
      { id: 13, name: "Michael (2026) 4K", tmdb: 2000 },
    ]
    const index = buildGroupingIndex(entries)
    const group = groupFor(index, 12)
    expect(group?.key).toBe("t:2000")
    expect(group?.entryIds.sort()).toEqual([12, 13])
    expect(group?.multiVariant).toBe(true)
  })

  it("computes a quality rank per entry from its prefix's quality tokens", () => {
    const entries: GroupableEntry[] = [
      { id: 50, name: "AMZ - Reacher (2022)", tmdb: 108978 },
      { id: 51, name: "4K-AMZ - Reacher (2022)", tmdb: 108978 },
      { id: 52, name: "DE - Reacher (US)", tmdb: 108978 },
      { id: 53, name: "4K-DE - Reacher (US)", tmdb: 108978 },
      { id: 54, name: "EN - Reacher (2022)", tmdb: 108978 },
    ]
    const index = buildGroupingIndex(entries)
    expect(index.qualityRankByEntryId.get(50)).toBe(0)
    expect(index.qualityRankByEntryId.get(51)).toBe(1)
    expect(index.qualityRankByEntryId.get(52)).toBe(0)
    expect(index.qualityRankByEntryId.get(53)).toBe(1)
    expect(index.qualityRankByEntryId.get(54)).toBe(0)
  })
})

describe("pickPreferredEntryId", () => {
  const tagByEntryId = new Map<number, string | null>([
    [100, "DE"],
    [101, "EN"],
    [102, null],
  ])

  it("picks the first entry matching a preferred tag in order", () => {
    expect(pickPreferredEntryId([100, 101, 102], tagByEntryId, ["FR", "EN"])).toBe(101)
  })

  it("falls back to the null-tag entry when no preferred tag matches", () => {
    expect(pickPreferredEntryId([100, 101, 102], tagByEntryId, ["FR"])).toBe(102)
  })

  it("falls back to the first entry id when nothing else matches", () => {
    const allTagged = new Map<number, string | null>([
      [200, "DE"],
      [201, "FR"],
    ])
    expect(pickPreferredEntryId([200, 201], allTagged, ["EN"])).toBe(200)
  })

  it("prefers the lowest quality rank within the matched preferred-tag bucket, even when the 4K entry is listed first", () => {
    const deVariants = new Map<number, string | null>([
      [53, "DE"], // 4K-DE
      [52, "DE"], // plain DE
    ])
    const qualityRankByEntryId = new Map<number, number>([
      [53, 1],
      [52, 0],
    ])
    expect(pickPreferredEntryId([53, 52], deVariants, ["DE"], qualityRankByEntryId)).toBe(52)
  })

  it("prefers the lowest quality rank within the null-tag bucket", () => {
    const untagged = new Map<number, string | null>([
      [61, null],
      [60, null],
    ])
    const qualityRankByEntryId = new Map<number, number>([
      [61, 1],
      [60, 0],
    ])
    expect(pickPreferredEntryId([61, 60], untagged, [], qualityRankByEntryId)).toBe(60)
  })

  it("prefers the lowest quality rank in the final fallback bucket", () => {
    const noPreferredMatch = new Map<number, string | null>([
      [71, "FR"],
      [70, "DE"],
    ])
    const qualityRankByEntryId = new Map<number, number>([
      [71, 0],
      [70, 1],
    ])
    expect(pickPreferredEntryId([70, 71], noPreferredMatch, ["EN"], qualityRankByEntryId)).toBe(71)
  })

  it("breaks a quality-rank tie by first-seen order", () => {
    const tiedRanks = new Map<number, string | null>([
      [80, "DE"],
      [81, "DE"],
    ])
    const qualityRankByEntryId = new Map<number, number>([
      [80, 0],
      [81, 0],
    ])
    expect(pickPreferredEntryId([80, 81], tiedRanks, ["DE"], qualityRankByEntryId)).toBe(80)
  })

  it("keeps the old first-match behavior when qualityRankByEntryId is omitted", () => {
    const bothDe = new Map<number, string | null>([
      [90, "DE"],
      [91, "DE"],
    ])
    expect(pickPreferredEntryId([90, 91], bothDe, ["DE"])).toBe(90)
  })
})

describe("groupPassesLanguageFilter", () => {
  it("always passes when no language is selected", () => {
    expect(groupPassesLanguageFilter(["EN", "DE"], "")).toBe(true)
  })

  it("passes when the selected tag is present", () => {
    expect(groupPassesLanguageFilter(["EN", "DE"], "DE")).toBe(true)
  })

  it("fails when the selected tag is absent", () => {
    expect(groupPassesLanguageFilter(["EN", "DE"], "FR")).toBe(false)
  })

  it("never hides a group with unknown language tags", () => {
    expect(groupPassesLanguageFilter([], "DE")).toBe(true)
  })
})
