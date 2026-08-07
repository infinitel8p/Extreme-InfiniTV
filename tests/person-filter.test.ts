import { describe, it, expect } from "vitest"
import { titleIdsForPersonLocal } from "../src/scripts/lib/person-filter.ts"
import { parseProviderPeople, type LocalSimilarInfo } from "../src/scripts/lib/similar-local.ts"

function vodParse(data: unknown): LocalSimilarInfo {
  const record = data as { info?: unknown; movie_data?: unknown } | null
  return parseProviderPeople((record?.info || record?.movie_data || record) as Parameters<typeof parseProviderPeople>[0])
}

function seriesParse(data: unknown): LocalSimilarInfo {
  const record = data as { info?: unknown } | null
  return parseProviderPeople(record?.info as Parameters<typeof parseProviderPeople>[0])
}

describe("titleIdsForPersonLocal", () => {
  it("matches a cast member case-insensitively and trims whitespace", () => {
    const cachedInfos = [
      { kind: "vod_info_42", data: { info: { cast: " Keanu Reeves , Carrie-Anne Moss" } } },
    ]
    expect(titleIdsForPersonLocal("keanu reeves", cachedInfos, vodParse)).toEqual(new Set([42]))
    expect(titleIdsForPersonLocal("  KEANU REEVES  ", cachedInfos, vodParse)).toEqual(new Set([42]))
  })

  it("matches a director", () => {
    const cachedInfos = [{ kind: "series_info_7", data: { info: { director: "Denis Villeneuve" } } }]
    expect(titleIdsForPersonLocal("Denis Villeneuve", cachedInfos, seriesParse)).toEqual(new Set([7]))
  })

  it("derives the numeric id from vod_info_/series_info_ cache kinds", () => {
    const cachedInfos = [
      { kind: "vod_info_101", data: { info: { cast: "Actor One" } } },
      { kind: "series_info_202", data: { info: { cast: "Actor One" } } },
    ]
    const ids = titleIdsForPersonLocal("Actor One", cachedInfos, (data) => {
      const record = data as { info?: unknown }
      return parseProviderPeople(record.info as Parameters<typeof parseProviderPeople>[0])
    })
    expect(ids).toEqual(new Set([101, 202]))
  })

  it("skips cache entries whose kind carries no trailing id", () => {
    const cachedInfos = [{ kind: "vod_info_", data: { info: { cast: "Actor One" } } }]
    expect(titleIdsForPersonLocal("Actor One", cachedInfos, vodParse)).toEqual(new Set())
  })

  it("returns an empty set for an empty person name", () => {
    const cachedInfos = [{ kind: "vod_info_1", data: { info: { cast: "Actor One" } } }]
    expect(titleIdsForPersonLocal("   ", cachedInfos, vodParse)).toEqual(new Set())
  })

  it("returns an empty set for empty cachedInfos", () => {
    expect(titleIdsForPersonLocal("Actor One", [], vodParse)).toEqual(new Set())
  })

  it("does not match a name that only partially overlaps", () => {
    const cachedInfos = [{ kind: "vod_info_1", data: { info: { cast: "Keanu Reeves" } } }]
    expect(titleIdsForPersonLocal("Keanu", cachedInfos, vodParse)).toEqual(new Set())
  })

  it("unions cast and director matches across multiple entries into one id set", () => {
    const cachedInfos = [
      { kind: "vod_info_1", data: { info: { cast: "Actor One, Actor Two" } } },
      { kind: "vod_info_2", data: { info: { director: "Actor One" } } },
      { kind: "vod_info_3", data: { info: { cast: "Someone Else" } } },
    ]
    expect(titleIdsForPersonLocal("Actor One", cachedInfos, vodParse)).toEqual(new Set([1, 2]))
  })
})
