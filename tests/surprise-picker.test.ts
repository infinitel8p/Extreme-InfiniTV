import { describe, it, expect } from "vitest"
import {
  availableYearBuckets,
  bucketForYear,
  eligibleEntries,
  parseEntryYear,
  pickSurprise,
  type SurpriseEntry,
} from "../src/scripts/lib/surprise-picker.ts"

function entry(id: number, year?: string, name = `Title ${id}`): SurpriseEntry {
  return { id, name, year }
}

describe("parseEntryYear", () => {
  it("reads a bare year", () => {
    expect(parseEntryYear(entry(1, "1999"))).toBe(1999)
  })

  it("reads a year out of a release date", () => {
    expect(parseEntryYear(entry(1, "2018-04-27"))).toBe(2018)
  })

  it("returns null for missing or unparseable years", () => {
    expect(parseEntryYear(entry(1))).toBeNull()
    expect(parseEntryYear(entry(1, ""))).toBeNull()
    expect(parseEntryYear(entry(1, "N/A"))).toBeNull()
    expect(parseEntryYear(entry(1, "12"))).toBeNull()
  })

  it("ignores years outside the plausible range", () => {
    expect(parseEntryYear(entry(1, "1850"))).toBeNull()
  })
})

describe("bucketForYear", () => {
  it("maps years to decade buckets", () => {
    expect(bucketForYear(2024)?.id).toBe("2020s")
    expect(bucketForYear(2019)?.id).toBe("2010s")
    expect(bucketForYear(2000)?.id).toBe("2000s")
    expect(bucketForYear(1995)?.id).toBe("1990s")
    expect(bucketForYear(1975)?.id).toBe("older")
  })

  it("returns null without a year", () => {
    expect(bucketForYear(null)).toBeNull()
  })
})

describe("availableYearBuckets", () => {
  it("only offers buckets that have titles", () => {
    const buckets = availableYearBuckets([entry(1, "2021"), entry(2, "1994"), entry(3)])
    expect(buckets.map((bucket) => bucket.id)).toEqual(["2020s", "1990s"])
  })

  it("is empty when no entry carries a year", () => {
    expect(availableYearBuckets([entry(1), entry(2, "unknown")])).toEqual([])
  })

  it("keeps buckets in newest-first order", () => {
    const buckets = availableYearBuckets([entry(1, "1985"), entry(2, "2023"), entry(3, "2005")])
    expect(buckets.map((bucket) => bucket.id)).toEqual(["2020s", "2000s", "older"])
  })
})

describe("eligibleEntries", () => {
  const pool = [entry(1, "2022"), entry(2, "2014"), entry(3), entry(4, "2020")]

  it("passes everything through with no constraints", () => {
    expect(eligibleEntries(pool)).toHaveLength(4)
  })

  it("filters to a year bucket", () => {
    expect(eligibleEntries(pool, { yearBucket: "2020s" }).map((item) => item.id)).toEqual([1, 4])
  })

  it("drops entries with no year when a bucket is chosen", () => {
    expect(eligibleEntries(pool, { yearBucket: "2010s" }).map((item) => item.id)).toEqual([2])
  })

  it("ignores an unknown bucket id rather than emptying the pool", () => {
    expect(eligibleEntries(pool, { yearBucket: "1880s" })).toHaveLength(4)
  })

  it("filters watched entries only when asked", () => {
    const isWatched = (item: SurpriseEntry) => item.id === 1 || item.id === 3
    expect(eligibleEntries(pool, { isWatched }).map((item) => item.id)).toEqual([1, 2, 3, 4])
    expect(
      eligibleEntries(pool, { unwatchedOnly: true, isWatched }).map((item) => item.id)
    ).toEqual([2, 4])
  })

  it("combines a bucket and the watched filter", () => {
    const isWatched = (item: SurpriseEntry) => item.id === 1
    expect(
      eligibleEntries(pool, { yearBucket: "2020s", unwatchedOnly: true, isWatched }).map(
        (item) => item.id
      )
    ).toEqual([4])
  })
})

describe("pickSurprise", () => {
  const pool = [entry(1), entry(2), entry(3), entry(4)]

  it("returns null for an empty pool", () => {
    expect(pickSurprise([])).toBeNull()
  })

  it("returns the only eligible entry", () => {
    expect(pickSurprise([entry(7, "2001")], { yearBucket: "2000s" })?.id).toBe(7)
  })

  it("returns null when constraints exclude everything", () => {
    expect(pickSurprise(pool, { yearBucket: "2020s" })).toBeNull()
    expect(pickSurprise(pool, { unwatchedOnly: true, isWatched: () => true })).toBeNull()
  })

  it("indexes the candidate list by the injected random source", () => {
    expect(pickSurprise(pool, { random: () => 0 })?.id).toBe(1)
    expect(pickSurprise(pool, { random: () => 0.5 })?.id).toBe(3)
  })

  it("never runs off the end when random returns 1", () => {
    expect(pickSurprise(pool, { random: () => 1 })?.id).toBe(4)
  })

  it("skips recently picked entries", () => {
    const picked = pickSurprise(pool, { excludeIds: ["1", "2"], random: () => 0 })
    expect(picked?.id).toBe(3)
  })

  it("reuses excluded entries once everything eligible is excluded", () => {
    const picked = pickSurprise(pool, { excludeIds: ["1", "2", "3", "4"], random: () => 0 })
    expect(picked?.id).toBe(1)
  })

  it("applies exclusions after the constraints, not before", () => {
    const yearPool = [entry(1, "2021"), entry(2, "2022"), entry(3, "1999")]
    const picked = pickSurprise(yearPool, {
      yearBucket: "2020s",
      excludeIds: ["1"],
      random: () => 0,
    })
    expect(picked?.id).toBe(2)
  })
})
