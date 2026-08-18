import { describe, it, expect } from "vitest"
import {
  CANONICAL_GENRES,
  parseGenreString,
  genreForCategoryName,
  genresForTmdbIds,
} from "../src/scripts/lib/genres"

describe("CANONICAL_GENRES", () => {
  it("has 18 genres with genres.<id> label keys", () => {
    expect(CANONICAL_GENRES).toHaveLength(18)
    for (const genre of CANONICAL_GENRES) {
      expect(genre.labelKey).toBe(`genres.${genre.id}`)
    }
  })
})

describe("genreForCategoryName", () => {
  it("matches a single English genre word", () => {
    expect(genreForCategoryName("EN - HORROR")).toEqual(["horror"])
  })

  it("matches a French synonym", () => {
    expect(genreForCategoryName("FR - HORREUR")).toEqual(["horror"])
  })

  it("matches an English word behind an unrelated language prefix", () => {
    expect(genreForCategoryName("GR - HORROR")).toEqual(["horror"])
  })

  it("matches multiple genres separated by a slash", () => {
    expect(genreForCategoryName("IT - HORROR/THRILLER")).toEqual(["horror", "thriller"])
  })

  it("returns no genres for a release-type category", () => {
    expect(genreForCategoryName("EN - NEW RELEASE")).toEqual([])
  })

  it("returns no genres for a resolution-only category", () => {
    expect(genreForCategoryName("4K ULTRA HD")).toEqual([])
  })

  it("returns no genres for a non-genre Arabic category", () => {
    expect(genreForCategoryName("أفلام أجنبيه فائقة الوضوح")).toEqual([])
  })

  it("matches genres joined by an ampersand", () => {
    expect(genreForCategoryName("Action & Adventure")).toEqual(["action", "adventure"])
  })

  it("matches a hyphenated genre", () => {
    expect(genreForCategoryName("Sci-Fi")).toEqual(["sci-fi"])
  })

  it("does not match action inside an unrelated word", () => {
    expect(genreForCategoryName("SATISFACTION TV")).toEqual([])
  })

  it("returns no genres for null or empty input", () => {
    expect(genreForCategoryName(null)).toEqual([])
    expect(genreForCategoryName("")).toEqual([])
  })
})

describe("parseGenreString", () => {
  it("parses a comma-separated provider genre list", () => {
    expect(parseGenreString("Action, Crime, Comedy, Thriller")).toEqual([
      "action",
      "comedy",
      "crime",
      "thriller",
    ])
  })

  it("parses a two-word synonym", () => {
    expect(parseGenreString("Science Fiction")).toEqual(["sci-fi"])
  })

  it("returns no genres for null or empty input", () => {
    expect(parseGenreString(null)).toEqual([])
    expect(parseGenreString(undefined)).toEqual([])
    expect(parseGenreString("")).toEqual([])
  })

  it("dedupes a genre matched by two language synonyms", () => {
    expect(parseGenreString("Horror, Horreur")).toEqual(["horror"])
  })
})

describe("genresForTmdbIds", () => {
  it("maps movie genre ids", () => {
    expect(genresForTmdbIds("vod", [27, 53])).toEqual(["horror", "thriller"])
  })

  it("maps a TV genre id shared by two canonical genres", () => {
    expect(genresForTmdbIds("series", [10759])).toEqual(["action", "adventure"])
  })

  it("maps another TV genre id shared by two canonical genres", () => {
    expect(genresForTmdbIds("series", [10765])).toEqual(["sci-fi", "fantasy"])
  })

  it("ignores unmapped ids", () => {
    expect(genresForTmdbIds("vod", [10770])).toEqual([])
    expect(genresForTmdbIds("series", [10763, 10764, 10766, 10767])).toEqual([])
  })
})
