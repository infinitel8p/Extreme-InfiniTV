import { describe, it, expect } from "vitest"
import {
  applyTvdbTranslation,
  normalizeSeason,
  normalizeTitle,
  pickRemoteIdMatches,
  recordCarriesTmdbId,
  pickSearchMatch,
  youtubeKeyFromTvdbTrailer,
  type TvdbRawSeriesRecord,
} from "@/scripts/lib/tvdb-normalize"

const REZERO: TvdbRawSeriesRecord = {
  id: 305089,
  name: "Re:ZERO -Starting Life in Another World-",
  overview: "Subaru Natsuki is a hikikomori who suddenly finds himself transported.",
  image: "https://artworks.thetvdb.com/banners/posters/305089-1.jpg",
  year: "2016",
  firstAired: "2016-04-04",
  score: 8.4,
  status: { name: "Continuing" },
  genres: [{ name: "Animation" }, { name: "Fantasy" }, { name: "" }],
  characters: [
    { personName: "Yusuke Kobayashi", name: "Subaru Natsuki", type: 3, sort: 1, personImgURL: "https://artworks.thetvdb.com/p/1.jpg" },
    { personName: "Rie Takahashi", name: "Emilia", type: 3, sort: 2 },
    { personName: "Some Director", name: "Director", type: 1, sort: 0 },
    { personName: "", name: "Unnamed", type: 3, sort: 3 },
  ],
  artworks: [
    { image: "https://artworks.thetvdb.com/banners/posters/low.jpg", type: 2, score: 10 },
    { image: "https://artworks.thetvdb.com/banners/posters/best.jpg", type: 2, score: 900 },
    { image: "https://artworks.thetvdb.com/banners/backgrounds/bg.jpg", type: 3, score: 50 },
    { image: "https://artworks.thetvdb.com/banners/graphical/banner.jpg", type: 1, score: 999 },
  ],
  trailers: [
    { url: "https://www.youtube.com/watch?v=ENGLISHKEY1", language: "eng" },
    { url: "https://youtu.be/GERMANKEYXX", language: "deu" },
  ],
}

// TheTVDB score is a popularity weight in the hundreds of thousands, so it is
// deliberately not mapped to a 0-10 rating.
describe("normalizeTitle", () => {
  it("maps a series record onto the contract", () => {
    const title = normalizeTitle(REZERO, "eng", "series")!
    expect(title.tvdbId).toBe(305089)
    expect(title.title).toBe("Re:ZERO -Starting Life in Another World-")
    expect(title.year).toBe(2016)
    expect(title.status).toBe("continuing")
    expect(title.genres).toEqual(["Animation", "Fantasy"])
  })

  it("prefers the highest-scoring poster artwork over the base image", () => {
    expect(normalizeTitle(REZERO, "eng", "series")!.posterUrl).toBe(
      "https://artworks.thetvdb.com/banners/posters/best.jpg"
    )
  })

  it("ignores banners, which are neither poster nor backdrop", () => {
    const title = normalizeTitle(REZERO, "eng", "series")!
    expect(title.posterUrl).not.toContain("banner.jpg")
    expect(title.backdropUrl).toBe("https://artworks.thetvdb.com/banners/backgrounds/bg.jpg")
  })

  it("uses movie artwork type ids when the kind is movie", () => {
    const movie = {
      id: 550,
      artworks: [
        { image: "https://artworks.thetvdb.com/m/poster.jpg", type: 14, score: 10 },
        { image: "https://artworks.thetvdb.com/m/bg.jpg", type: 15, score: 10 },
        { image: "https://artworks.thetvdb.com/m/series-poster.jpg", type: 2, score: 900 },
      ],
    }
    const title = normalizeTitle(movie, "eng", "movie")!
    expect(title.posterUrl).toBe("https://artworks.thetvdb.com/m/poster.jpg")
    expect(title.backdropUrl).toBe("https://artworks.thetvdb.com/m/bg.jpg")
  })

  it("falls back to the base image when no poster artwork exists", () => {
    const title = normalizeTitle({ ...REZERO, artworks: [] }, "eng", "series")!
    expect(title.posterUrl).toBe("https://artworks.thetvdb.com/banners/posters/305089-1.jpg")
    expect(title.backdropUrl).toBeNull()
  })

  it("keeps only acting roles, ordered by sort, and drops nameless entries", () => {
    const cast = normalizeTitle(REZERO, "eng", "series")!.cast
    expect(cast.map((member) => member.name)).toEqual(["Yusuke Kobayashi", "Rie Takahashi"])
    expect(cast[0]).toEqual({
      name: "Yusuke Kobayashi",
      character: "Subaru Natsuki",
      profileUrl: "https://artworks.thetvdb.com/p/1.jpg",
    })
    expect(cast[1].profileUrl).toBeNull()
  })

  it("prefers a trailer in the requested language", () => {
    expect(normalizeTitle(REZERO, "deu", "series")!.trailerYoutubeKey).toBe("GERMANKEYXX")
    expect(normalizeTitle(REZERO, "fra", "series")!.trailerYoutubeKey).toBe("ENGLISHKEY1")
  })

  it.each([
    ["Ended", "ended"],
    ["Completed", "ended"],
    ["Continuing", "continuing"],
    ["Upcoming", "continuing"],
    ["Whatever", "unknown"],
  ])("maps status %s to %s", (name, expected) => {
    expect(normalizeTitle({ ...REZERO, status: { name } }, "eng", "series")!.status).toBe(expected)
  })

  it("derives the year from firstAired when the year field is unusable", () => {
    expect(normalizeTitle({ ...REZERO, year: null }, "eng", "series")!.year).toBe(2016)
    expect(normalizeTitle({ ...REZERO, year: "n/a", firstAired: "" }, "eng", "series")!.year).toBeNull()
  })

  it("rejects non-https image values rather than passing them through", () => {
    const title = normalizeTitle(
      { ...REZERO, image: "javascript:alert(1)", artworks: [] },
      "eng",
      "series"
    )!
    expect(title.posterUrl).toBeNull()
  })

  it.each([[null], [undefined], [{}], [{ id: 0 }], [{ id: "abc" }]])(
    "returns null for an unusable record (%s)",
    (record) => {
      expect(normalizeTitle(record as TvdbRawSeriesRecord, "eng", "series")).toBeNull()
    }
  )

  it("survives a record with every optional field absent", () => {
    const title = normalizeTitle({ id: 1 }, "eng", "series")!
    expect(title).toEqual({
      tvdbId: 1,
      title: "",
      overview: "",
      posterUrl: null,
      backdropUrl: null,
      logoUrl: null,
      cast: [],
      genres: [],
      year: null,
      status: "unknown",
      trailerYoutubeKey: null,
    })
  })

  it("leaves logoUrl null when no logo artwork type id is given", () => {
    const withLogoArtwork = {
      ...REZERO,
      artworks: [...REZERO.artworks!, { image: "https://artworks.thetvdb.com/logo.png", type: 23, score: 5 }],
    }
    expect(normalizeTitle(withLogoArtwork, "eng", "series")!.logoUrl).toBeNull()
  })

  it("picks the clearlogo artwork by the resolved type id", () => {
    const withLogoArtwork = {
      ...REZERO,
      artworks: [...REZERO.artworks!, { image: "https://artworks.thetvdb.com/logo.png", type: 23, score: 5 }],
    }
    expect(normalizeTitle(withLogoArtwork, "eng", "series", 23)!.logoUrl).toBe(
      "https://artworks.thetvdb.com/logo.png"
    )
  })

  it("does not match a differently-typed artwork against the logo type id", () => {
    expect(normalizeTitle(REZERO, "eng", "series", 23)!.logoUrl).toBeNull()
  })
})

describe("normalizeSeason", () => {
  const flatRun = [
    { number: 25, seasonNumber: 1, name: "S1 finale", aired: "2016-09-19" },
    { number: 1, seasonNumber: 2, name: "S2 opener", overview: "Plot", image: "/banners/series/305089/episodes/5f04819bc613b.jpg", aired: "2020-07-08" },
    { number: 3, seasonNumber: 2, name: "S2 third" },
    { number: 2, seasonNumber: 2, name: "S2 second" },
    { number: 1, seasonNumber: 3, name: "S3 opener" },
  ]

  it("keeps only the requested season and sorts by episode number", () => {
    const season = normalizeSeason(flatRun, 2, "official")
    expect(season.seasonNumber).toBe(2)
    expect(season.order).toBe("official")
    expect(season.episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2, 3])
    expect(season.episodes[0]).toEqual({
      episodeNumber: 1,
      name: "S2 opener",
      overview: "Plot",
      stillUrl: "https://artworks.thetvdb.com/banners/series/305089/episodes/5f04819bc613b.jpg",
      airedAt: "2020-07-08",
    })
  })

  it("returns an empty season rather than throwing for an unknown season", () => {
    expect(normalizeSeason(flatRun, 9, "official").episodes).toEqual([])
    expect(normalizeSeason(null, 1, "absolute").episodes).toEqual([])
  })

  it("drops episodes with no usable number", () => {
    const season = normalizeSeason(
      [{ number: null, seasonNumber: 1 }, { number: 0, seasonNumber: 1 }, { number: 4, seasonNumber: 1 }],
      1,
      "official"
    )
    expect(season.episodes.map((episode) => episode.episodeNumber)).toEqual([4])
  })
})

describe("youtubeKeyFromTvdbTrailer", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://vimeo.com/12345", null],
    ["", null],
    [null, null],
  ])("extracts from %s", (url, expected) => {
    expect(youtubeKeyFromTvdbTrailer(url)).toBe(expected)
  })
})

describe("pickRemoteIdMatches", () => {
  it("collects every record of the requested kind, not just the first", () => {
    const results = [{ movie: { id: 9 } }, { series: { id: 305089 } }, { series: { id: 42 } }]
    expect(pickRemoteIdMatches(results, "series").map((record) => record.id)).toEqual([305089, 42])
    expect(pickRemoteIdMatches(results, "movie").map((record) => record.id)).toEqual([9])
  })

  it.each([[[{ people: { id: 1 } }]], [[]], [null]])("returns an empty list for %s", (results) => {
    expect(pickRemoteIdMatches(results, "series")).toEqual([])
  })
})

describe("recordCarriesTmdbId", () => {
  // A bare integer matches other numeric sources too, so this is the only proof.
  const record = {
    id: 81189,
    remoteIds: [
      { id: "tt0903747", sourceName: "IMDB" },
      { id: "1396", sourceName: "TheMovieDB.com" },
    ],
  }

  it("accepts a record whose TheMovieDB id is the one requested", () => {
    expect(recordCarriesTmdbId(record, 1396)).toBe(true)
  })

  it("rejects a record that matched through another source", () => {
    expect(recordCarriesTmdbId(record, 1395)).toBe(false)
    expect(recordCarriesTmdbId({ id: 1, remoteIds: [{ id: "1396", sourceName: "TVmaze" }] }, 1396)).toBe(false)
  })

  it.each([[null], [undefined], [{ id: 1 }], [{ id: 1, remoteIds: [] }]])(
    "rejects %s rather than assuming a match",
    (value) => {
      expect(recordCarriesTmdbId(value as never, 1396)).toBe(false)
    }
  )
})

describe("applyTvdbTranslation", () => {
  const title = normalizeTitle(REZERO, "eng", "series")!

  it("overlays name and overview when both are present", () => {
    const localized = applyTvdbTranslation(title, { name: "Re:ZERO", overview: "Deutsche Beschreibung" })
    expect(localized.title).toBe("Re:ZERO")
    expect(localized.overview).toBe("Deutsche Beschreibung")
  })

  it("keeps the original for whichever field the translation lacks", () => {
    expect(applyTvdbTranslation(title, { name: "Nur Titel" }).overview).toBe(title.overview)
    expect(applyTvdbTranslation(title, { overview: "Nur Text" }).title).toBe(title.title)
  })

  it.each([[null], [undefined], [{}], [{ name: "   " }]])(
    "returns the title unchanged for %s",
    (translation) => {
      expect(applyTvdbTranslation(title, translation)).toEqual(title)
    }
  )

  it("does not mutate the input", () => {
    const before = { ...title }
    applyTvdbTranslation(title, { name: "Changed" })
    expect(title).toEqual(before)
  })
})

describe("image URL handling", () => {
  it("keeps absolute artwork URLs and resolves relative ones", () => {
    const absolute = normalizeSeason([{ number: 1, seasonNumber: 1, image: "https://artworks.thetvdb.com/a.jpg" }], 1, "official")
    expect(absolute.episodes[0].stillUrl).toBe("https://artworks.thetvdb.com/a.jpg")
    const relative = normalizeSeason([{ number: 1, seasonNumber: 1, image: "/banners/x.jpg" }], 1, "official")
    expect(relative.episodes[0].stillUrl).toBe("https://artworks.thetvdb.com/banners/x.jpg")
  })

  it.each([["javascript:alert(1)"], ["http://insecure.example/a.jpg"], ["//evil.example/a.jpg"], ["banners/x.jpg"], [""]])(
    "rejects %s",
    (image) => {
      expect(normalizeSeason([{ number: 1, seasonNumber: 1, image }], 1, "official").episodes[0].stillUrl).toBeNull()
    }
  )
})

describe("pickSearchMatch", () => {
  it("strips the entity prefix off a search id", () => {
    expect(pickSearchMatch([{ tvdb_id: "series-305089", type: "series" }], "series", null)).toBe(305089)
    expect(pickSearchMatch([{ tvdb_id: 305089, type: "series" }], "series", null)).toBe(305089)
  })

  it("ignores results of another entity type", () => {
    const results = [
      { tvdb_id: "person-1", type: "person" },
      { tvdb_id: "series-2", type: "series" },
    ]
    expect(pickSearchMatch(results, "series", null)).toBe(2)
  })

  it("prefers a year match but does not require one", () => {
    const results = [
      { tvdb_id: "series-1", type: "series", year: "2001" },
      { tvdb_id: "series-2", type: "series", year: "2016" },
    ]
    expect(pickSearchMatch(results, "series", 2016)).toBe(2)
    expect(pickSearchMatch(results, "series", 1999)).toBe(1)
    expect(pickSearchMatch(results, "series", null)).toBe(1)
  })

  it.each([[null], [undefined], [[]], [[{ tvdb_id: "series-abc", type: "series" }]], [[{ type: "series" }]]])(
    "returns null for %s",
    (results) => {
      expect(pickSearchMatch(results, "series", null)).toBeNull()
    }
  )
})

describe("pickSearchMatch title verification", () => {
  const results = [
    { tvdb_id: "series-1", type: "series", year: "2016", name: "Autopsia del genero negro" },
    { tvdb_id: "series-305089", type: "series", year: "2016", name: "Re：ゼロから始める異世界生活", translations: { eng: "Re:ZERO -Starting Life in Another World-" } },
  ]

  it("skips a year-matching result whose title is unrelated", () => {
    expect(pickSearchMatch(results, "series", 2016, "Re ZERO")).toBe(305089)
  })

  it("matches through a translation when the name is in another language", () => {
    expect(pickSearchMatch(results, "series", null, "Re ZERO Starting Life in Another World")).toBe(305089)
  })

  it("matches through an alias", () => {
    const aliased = [{ tvdb_id: "series-7", type: "series", name: "Original", aliases: ["Breaking Bad"] }]
    expect(pickSearchMatch(aliased, "series", null, "Breaking Bad")).toBe(7)
  })

  it("returns null rather than adopting an unrelated work", () => {
    expect(pickSearchMatch(results, "series", null, "Completely Different Show")).toBeNull()
  })

  it("requires a substantial overlap, not an incidental short one", () => {
    const shortish = [{ tvdb_id: "series-8", type: "series", name: "The Office Reunion Special" }]
    expect(pickSearchMatch(shortish, "series", null, "The Off")).toBeNull()
  })

  it("keeps the old behaviour when no query is supplied", () => {
    expect(pickSearchMatch(results, "series", 2016)).toBe(1)
  })
})
