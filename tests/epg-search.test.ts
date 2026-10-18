import { describe, it, expect } from "vitest"
import {
  searchProgrammes,
  tokenizeEpgQuery,
  type EpgSearchChannel,
  type EpgSearchProgramme,
} from "../src/scripts/lib/epg-search.ts"

const H = 60 * 60 * 1000

function prog(title: string, startH: number, stopH: number, desc = ""): EpgSearchProgramme {
  return { title, desc, start: startH * H, stop: stopH * H }
}

const channels: EpgSearchChannel[] = [
  { id: 1, name: "Sports One", tvgId: "sports1" },
  { id: 2, name: "News 24", tvgId: "NEWS24" },
  { id: 3, name: "Sports Two HD", tvgId: "sports2", tvgShift: 1 },
  { id: 4, name: "No EPG" },
]

const programmes = new Map<string, EpgSearchProgramme[]>([
  [
    "sports1",
    [
      prog("Champions League Live", 10, 12),
      prog("Football Tonight", 12, 13, "Highlights from the Champions League"),
      prog("Tennis", 13, 15),
    ],
  ],
  ["news24", [prog("Morning News", 8, 10), prog("Évening Néws", 18, 19)]],
  ["sports2", [prog("Champions League Classics", 9, 11)]],
])

const resolveTvgId = (channel: EpgSearchChannel) => channel.tvgId

describe("tokenizeEpgQuery", () => {
  it("ignores queries shorter than two normalized characters", () => {
    expect(tokenizeEpgQuery("")).toEqual([])
    expect(tokenizeEpgQuery(" a ")).toEqual([])
    expect(tokenizeEpgQuery("Champions-League")).toEqual(["champions", "league"])
  })
})

describe("searchProgrammes", () => {
  it("matches titles across channels and sorts chronologically with tvg-shift applied", () => {
    const { hits, total } = searchProgrammes(channels, programmes, "champions league", { resolveTvgId })
    expect(total).toBe(3)
    expect(hits.map((hit) => [hit.channel.id, hit.programme.title, hit.programme.start / H])).toEqual([
      [1, "Champions League Live", 10],
      // sports2 airs 9–11 raw, shown at 10–12 after the +1h tvg-shift
      [3, "Champions League Classics", 10],
      [1, "Football Tonight", 12],
    ])
    const shifted = hits.find((hit) => hit.channel.id === 3)!
    expect(shifted.programme.rawStart).toBe(9 * H)
    expect(shifted.programme.rawStop).toBe(11 * H)
  })

  it("flags description-only matches and ranks them below title matches", () => {
    const { hits } = searchProgrammes(channels, programmes, "champions", { resolveTvgId })
    const desc = hits.find((hit) => hit.programme.title === "Football Tonight")!
    const title = hits.find((hit) => hit.programme.title === "Champions League Live")!
    expect(desc.inDescription).toBe(true)
    expect(title.inDescription).toBe(false)
    expect(desc.score).toBeLessThan(title.score)
  })

  it("is accent- and case-insensitive and resolves tvg-ids case-insensitively", () => {
    const { hits } = searchProgrammes(channels, programmes, "EVENING news", { resolveTvgId })
    expect(hits.map((hit) => hit.programme.title)).toEqual(["Évening Néws"])
  })

  it("matches on channel name combined with title tokens", () => {
    const { hits } = searchProgrammes(channels, programmes, "sports tennis", { resolveTvgId })
    expect(hits.map((hit) => hit.programme.title)).toEqual(["Tennis"])
  })

  it("never matches on the channel name alone", () => {
    expect(searchProgrammes(channels, programmes, "sports", { resolveTvgId }).hits).toEqual([])
    const { hits } = searchProgrammes(channels, programmes, "news", { resolveTvgId })
    expect(hits.map((hit) => hit.programme.title)).toEqual(["Morning News", "Évening Néws"])
  })

  it("honours the from/to window and the keep predicate", () => {
    const windowed = searchProgrammes(channels, programmes, "news", {
      resolveTvgId,
      from: 10 * H,
      to: 24 * H,
    })
    expect(windowed.hits.map((hit) => hit.programme.title)).toEqual(["Évening Néws"])

    const kept = searchProgrammes(channels, programmes, "champions", {
      resolveTvgId,
      keep: (channel) => channel.id !== 3,
    })
    expect(kept.hits.every((hit) => hit.channel.id !== 3)).toBe(true)
  })

  it("keeps the best-scoring hits when over the limit and reports the full total", () => {
    const { hits, total } = searchProgrammes(channels, programmes, "champions", {
      resolveTvgId,
      limit: 2,
    })
    expect(total).toBe(3)
    expect(hits).toHaveLength(2)
    expect(hits.some((hit) => hit.inDescription)).toBe(false)
  })

  it("returns nothing for short queries or channels without EPG", () => {
    expect(searchProgrammes(channels, programmes, "c", { resolveTvgId }).hits).toEqual([])
    expect(
      searchProgrammes([channels[3]], programmes, "news", { resolveTvgId }).hits
    ).toEqual([])
  })
})
