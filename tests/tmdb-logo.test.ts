import { describe, it, expect } from "vitest"
import { pickTmdbLogo } from "../src/scripts/lib/tmdb-enrich"
import type { TmdbLogo } from "../src/scripts/lib/tmdb"

function logo(
  filePath: string,
  isoLang: string | null,
  voteAverage = 0,
  voteCount = 0
): TmdbLogo {
  return { file_path: filePath, iso_639_1: isoLang, vote_average: voteAverage, vote_count: voteCount }
}

describe("pickTmdbLogo", () => {
  it("returns null for undefined or empty input", () => {
    expect(pickTmdbLogo(undefined, "de")).toBeNull()
    expect(pickTmdbLogo([], "de")).toBeNull()
  })

  it("excludes svg logos", () => {
    const logos = [logo("/a.svg", "en", 5, 5)]
    expect(pickTmdbLogo(logos, "en")).toBeNull()
  })

  it("prefers the preferred language over English", () => {
    const logos = [logo("/en.png", "en", 5, 5), logo("/de.png", "de", 1, 1)]
    expect(pickTmdbLogo(logos, "de")).toBe("/de.png")
  })

  it("prefers English over a null-language logo", () => {
    const logos = [logo("/null.png", null, 9, 9), logo("/en.png", "en", 1, 1)]
    expect(pickTmdbLogo(logos, "fr")).toBe("/en.png")
  })

  it("prefers a null-language logo over an unrelated language", () => {
    const logos = [logo("/it.png", "it", 9, 9), logo("/null.png", null, 1, 1)]
    expect(pickTmdbLogo(logos, "fr")).toBe("/null.png")
  })

  it("breaks a language tie by vote_average", () => {
    const logos = [logo("/low.png", "de", 3), logo("/high.png", "de", 8)]
    expect(pickTmdbLogo(logos, "de")).toBe("/high.png")
  })

  it("breaks a vote_average tie by vote_count", () => {
    const logos = [logo("/few.png", "de", 5, 2), logo("/many.png", "de", 5, 20)]
    expect(pickTmdbLogo(logos, "de")).toBe("/many.png")
  })

  it("lets a low-vote preferred-language logo beat a high-vote English one", () => {
    const logos = [logo("/en.png", "en", 10, 100), logo("/de.png", "de", 0, 0)]
    expect(pickTmdbLogo(logos, "de")).toBe("/de.png")
  })
})
