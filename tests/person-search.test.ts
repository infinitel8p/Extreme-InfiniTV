import { describe, it, expect } from "vitest"
import { mergePeopleCandidates } from "../src/scripts/lib/person-search"
import type { TmdbPersonResult } from "../src/scripts/lib/tmdb"

function tmdbResult(overrides: Partial<TmdbPersonResult> = {}): TmdbPersonResult {
  return {
    id: 1,
    name: "Penélope Cruz",
    profileUrl: "https://image.tmdb.org/t/p/w185/profile.jpg",
    knownFor: "Volver",
    popularity: 10,
    ...overrides,
  }
}

describe("mergePeopleCandidates", () => {
  it("returns [] for an empty query", () => {
    expect(mergePeopleCandidates(["Penelope Cruz"], [tmdbResult()], "")).toEqual([])
  })

  it("returns [] for a whitespace-only query", () => {
    expect(mergePeopleCandidates(["Penelope Cruz"], [tmdbResult()], "   ")).toEqual([])
  })

  it("dedupes a local + tmdb match into one 'both' candidate keeping the tmdb id and photo", () => {
    const results = mergePeopleCandidates(["Penelope Cruz"], [tmdbResult({ id: 42 })], "Penelope Cruz")
    expect(results).toHaveLength(1)
    expect(results[0].source).toBe("both")
    expect(results[0].tmdbId).toBe(42)
    expect(results[0].profileUrl).toBe("https://image.tmdb.org/t/p/w185/profile.jpg")
  })

  it("matches diacritics: query 'Penelope Cruz' matches local name 'Penélope Cruz'", () => {
    const results = mergePeopleCandidates(["Penélope Cruz"], [], "Penelope Cruz")
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("Penélope Cruz")
    expect(results[0].source).toBe("local")
  })

  it("is case-insensitive", () => {
    const results = mergePeopleCandidates(["penelope CRUZ"], [], "PENELOPE cruz")
    expect(results).toHaveLength(1)
  })

  it("returns a local-only match with no tmdb results", () => {
    const results = mergePeopleCandidates(["Local Only Actor"], [], "local")
    expect(results).toEqual([
      { name: "Local Only Actor", tmdbId: null, profileUrl: null, knownFor: null, source: "local" },
    ])
  })

  it("returns a tmdb-only match with no local names", () => {
    const results = mergePeopleCandidates([], [tmdbResult({ name: "Javier Bardem" })], "Javier")
    expect(results[0].source).toBe("tmdb")
    expect(results[0].name).toBe("Javier Bardem")
  })

  it("ranks 'both' before local-only before tmdb-only", () => {
    const results = mergePeopleCandidates(
      ["Marco Both", "Marco Local"],
      [tmdbResult({ id: 1, name: "Marco Both" }), tmdbResult({ id: 2, name: "Marco Tmdb" })],
      "Marco"
    )
    expect(results.map((candidate) => candidate.source)).toEqual(["both", "local", "tmdb"])
  })

  it("tie-breaks same-source candidates by tmdb popularity", () => {
    const results = mergePeopleCandidates(
      [],
      [
        tmdbResult({ id: 1, name: "Marco Low", popularity: 1 }),
        tmdbResult({ id: 2, name: "Marco High", popularity: 99 }),
      ],
      "Marco"
    )
    expect(results.map((candidate) => candidate.name)).toEqual(["Marco High", "Marco Low"])
  })

  it("tie-breaks equal popularity by earlier match position", () => {
    const results = mergePeopleCandidates(
      [],
      [
        tmdbResult({ id: 1, name: "Not Marco First", popularity: 5 }),
        tmdbResult({ id: 2, name: "Marco Leads", popularity: 5 }),
      ],
      "Marco"
    )
    expect(results.map((candidate) => candidate.name)).toEqual(["Marco Leads", "Not Marco First"])
  })

  it("caps results at the given limit", () => {
    const localNames = ["Marco One", "Marco Two", "Marco Three", "Marco Four"]
    const results = mergePeopleCandidates(localNames, [], "Marco", 2)
    expect(results).toHaveLength(2)
  })

  it("excludes names that don't match the query", () => {
    const results = mergePeopleCandidates(["Someone Else"], [tmdbResult({ name: "Also Unrelated" })], "Marco")
    expect(results).toEqual([])
  })
})
