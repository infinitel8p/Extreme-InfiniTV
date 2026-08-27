import { describe, it, expect } from "vitest"
import {
  fillHeroGaps,
  heroFieldsNeedFill,
  patchEpisodeFromTvdb,
  type DetailHeroFields,
} from "@/scripts/tv/detail-enrich"
import type { TmdbTitleEnrichment } from "@/scripts/lib/tmdb-enrich"
import type { TvdbEpisode } from "@/scripts/lib/tvdb-contract"

function makeEnrichment(overrides: Partial<TmdbTitleEnrichment> = {}): TmdbTitleEnrichment {
  return {
    tmdbId: 1,
    title: "Fallback Title",
    overview: "TheTVDB overview",
    posterUrl: "https://example.com/poster.jpg",
    backdropUrl: "https://example.com/backdrop.jpg",
    logoUrl: null,
    director: null,
    directorPersonId: null,
    cast: [],
    trailerYoutubeKey: null,
    recommendations: [],
    voteAverage: 7.5,
    genres: ["Drama", "Thriller"],
    tagline: null,
    year: 2019,
    ...overrides,
  }
}

function emptyFields(): DetailHeroFields {
  return { backdropUrl: null, overview: "", genres: "", ratingText: "", yearText: "" }
}

describe("fillHeroGaps", () => {
  it("fills every empty field from the enrichment", () => {
    const result = fillHeroGaps(emptyFields(), makeEnrichment())
    expect(result).toEqual({
      backdropUrl: "https://example.com/backdrop.jpg",
      overview: "TheTVDB overview",
      genres: "Drama, Thriller",
      ratingText: "7.5",
      yearText: "2019",
    })
  })

  it("never overwrites a field that is already set", () => {
    const current: DetailHeroFields = {
      backdropUrl: "https://example.com/existing-backdrop.jpg",
      overview: "Existing overview",
      genres: "Comedy",
      ratingText: "8.0",
      yearText: "2020",
    }
    const result = fillHeroGaps(current, makeEnrichment())
    expect(result).toEqual(current)
  })

  it("returns the current fields unchanged when there is no enrichment", () => {
    const current = emptyFields()
    expect(fillHeroGaps(current, null)).toBe(current)
  })

  it("leaves a field empty when the enrichment has nothing for it", () => {
    const result = fillHeroGaps(emptyFields(), makeEnrichment({ backdropUrl: null, genres: [], voteAverage: 0, year: null }))
    expect(result.backdropUrl).toBeNull()
    expect(result.genres).toBe("")
    expect(result.ratingText).toBe("")
    expect(result.yearText).toBe("")
    expect(result.overview).toBe("TheTVDB overview")
  })
})

describe("heroFieldsNeedFill", () => {
  it("is true when any field is empty", () => {
    expect(heroFieldsNeedFill(emptyFields())).toBe(true)
  })

  it("is false once every field is set", () => {
    const fields: DetailHeroFields = {
      backdropUrl: "url",
      overview: "text",
      genres: "Drama",
      ratingText: "7.0",
      yearText: "2020",
    }
    expect(heroFieldsNeedFill(fields)).toBe(false)
  })
})

function makeTvdbEpisode(overrides: Partial<TvdbEpisode> = {}): TvdbEpisode {
  return {
    episodeNumber: 1,
    name: "The Pilot",
    overview: "A TheTVDB overview.",
    stillUrl: "https://example.com/still.jpg",
    airedAt: "2020-01-01",
    ...overrides,
  }
}

describe("patchEpisodeFromTvdb", () => {
  it("replaces a generic title but keeps a real one", () => {
    const generic = patchEpisodeFromTvdb({ title: "Episode 1", thumbUrl: null, plot: "" }, makeTvdbEpisode(), true)
    expect(generic.title).toBe("The Pilot")

    const real = patchEpisodeFromTvdb({ title: "The Real Title", thumbUrl: null, plot: "" }, makeTvdbEpisode(), false)
    expect(real.title).toBe("The Real Title")
  })

  it("only fills thumbUrl and plot when they are missing", () => {
    const filled = patchEpisodeFromTvdb({ title: null, thumbUrl: "existing.jpg", plot: "existing plot" }, makeTvdbEpisode(), true)
    expect(filled.thumbUrl).toBe("existing.jpg")
    expect(filled.plot).toBe("existing plot")

    const empty = patchEpisodeFromTvdb({ title: null, thumbUrl: null, plot: "" }, makeTvdbEpisode(), true)
    expect(empty.thumbUrl).toBe("https://example.com/still.jpg")
    expect(empty.plot).toBe("A TheTVDB overview.")
  })
})
