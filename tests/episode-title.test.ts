import { describe, it, expect } from "vitest"
import { isGenericEpisodeTitle } from "../src/scripts/lib/episode-title"

describe("isGenericEpisodeTitle", () => {
  it("treats an empty title as generic", () => {
    expect(isGenericEpisodeTitle("")).toBe(true)
    expect(isGenericEpisodeTitle(null)).toBe(true)
  })

  it("treats the exact fallback title as generic", () => {
    expect(isGenericEpisodeTitle("Episode 1", { fallbackTitle: "Episode 1" })).toBe(true)
  })

  it("recognizes a language-prefixed, series-name-junk title (the Alphablocks case)", () => {
    expect(
      isGenericEpisodeTitle("EN - Alphablocks - S01E01", {
        seriesName: "Alphablocks",
        fallbackTitle: "Episode 1",
      })
    ).toBe(true)
  })

  it("recognizes a prefixed series name matching a prefixed title (both carry EN -)", () => {
    expect(
      isGenericEpisodeTitle("EN - Alphablocks - S01E01", {
        seriesName: "EN - Alphablocks",
        fallbackTitle: "Episode 1",
      })
    ).toBe(true)
  })

  it("recognizes a prefixed series name matching an unprefixed title", () => {
    expect(
      isGenericEpisodeTitle("Alphablocks - S01E02", {
        seriesName: "EN - Alphablocks",
        fallbackTitle: "Episode 2",
      })
    ).toBe(true)
  })

  it("leaves a real episode title untouched when the series name is prefixed", () => {
    expect(
      isGenericEpisodeTitle("EN - Alphablocks - A Is For Ant", {
        seriesName: "EN - Alphablocks",
        fallbackTitle: "Episode 1",
      })
    ).toBe(false)
  })

  it("recognizes a bare S01E01 marker with no series name needed", () => {
    expect(isGenericEpisodeTitle("S01E01", { seriesName: "Alphablocks", fallbackTitle: "Episode 1" })).toBe(true)
  })

  it("recognizes a language-prefixed series name plus a bare 1x03 shorthand", () => {
    expect(isGenericEpisodeTitle("EN - Show - 1x03", { seriesName: "Show", fallbackTitle: "Episode 3" })).toBe(true)
  })

  it("leaves a real episode title untouched", () => {
    expect(
      isGenericEpisodeTitle("The One Where It Works", { seriesName: "Friends", fallbackTitle: "Episode 1" })
    ).toBe(false)
  })

  it("treats a title that is just the series name as generic", () => {
    expect(isGenericEpisodeTitle("Alphablocks", { seriesName: "Alphablocks", fallbackTitle: "Episode 1" })).toBe(true)
  })

  it("recognizes an Episode/Ep/Folge word marker", () => {
    expect(isGenericEpisodeTitle("Folge 12", { seriesName: "Show" })).toBe(true)
    expect(isGenericEpisodeTitle("Ep 5", { seriesName: "Show" })).toBe(true)
  })

  it("recognizes a bare number as generic", () => {
    expect(isGenericEpisodeTitle("12", { seriesName: "Show" })).toBe(true)
  })

  it("does not treat a non-language acronym prefix as strippable", () => {
    expect(isGenericEpisodeTitle("US - 1x03", { seriesName: "Show", fallbackTitle: "Episode 3" })).toBe(false)
  })
})
