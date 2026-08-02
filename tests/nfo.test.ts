import { describe, it, expect } from "vitest"
import { buildNfo, escapeXml } from "../src/scripts/lib/nfo"

describe("buildNfo", () => {
  it("builds a full movie nfo", () => {
    const xml = buildNfo({
      type: "movie",
      title: "Example Movie",
      year: "2010-07-16",
      plot: "A movie about examples.",
      genre: "Action / Sci-Fi",
      rating: "8.8",
      runtimeMinutes: 148,
      poster: "https://example.com/poster.jpg",
    })
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Example Movie</title>
  <year>2010</year>
  <premiered>2010-07-16</premiered>
  <plot>A movie about examples.</plot>
  <genre>Action</genre>
  <genre>Sci-Fi</genre>
  <rating>8.8</rating>
  <runtime>148</runtime>
  <thumb aspect="poster">https://example.com/poster.jpg</thumb>
</movie>
`
    )
  })

  it("builds a minimal movie nfo with only the title", () => {
    const xml = buildNfo({ type: "movie", title: "Bare Movie" })
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Bare Movie</title>
</movie>
`
    )
  })

  it("builds an episode nfo", () => {
    const xml = buildNfo({
      type: "episode",
      showTitle: "Example Show",
      title: "Pilot",
      season: 1,
      episode: 1,
      aired: "2019-03-01",
    })
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>Pilot</title>
  <showtitle>Example Show</showtitle>
  <season>1</season>
  <episode>1</episode>
  <aired>2019-03-01</aired>
</episodedetails>
`
    )
  })

  it("escapes XML special characters", () => {
    expect(escapeXml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;")
    const xml = buildNfo({ type: "movie", title: `Rock & Roll <2> "Live" 'Take'` })
    expect(xml).toContain("<title>Rock &amp; Roll &lt;2&gt; &quot;Live&quot; &apos;Take&apos;</title>")
  })

  it("splits genres on commas, semicolons, pipes and slashes", () => {
    const xml = buildNfo({
      type: "movie",
      title: "Multi Genre",
      genre: "Action, Drama; Comedy|Horror/Thriller",
    })
    expect(xml).toContain("<genre>Action</genre>")
    expect(xml).toContain("<genre>Drama</genre>")
    expect(xml).toContain("<genre>Comedy</genre>")
    expect(xml).toContain("<genre>Horror</genre>")
    expect(xml).toContain("<genre>Thriller</genre>")
  })

  it("extracts a plain numeric year", () => {
    const xml = buildNfo({ type: "movie", title: "Numeric Year", year: 2010 })
    expect(xml).toContain("<year>2010</year>")
  })

  it("extracts a year from a year-only string", () => {
    const xml = buildNfo({ type: "movie", title: "String Year", year: "2010" })
    expect(xml).toContain("<year>2010</year>")
  })

  it("omits year when nothing plausible is found", () => {
    const xml = buildNfo({ type: "movie", title: "No Year", year: "unknown" })
    expect(xml).not.toContain("<year>")
  })

  it("omits rating for 0, empty string and '0'", () => {
    for (const rating of [0, "", "0"]) {
      const xml = buildNfo({ type: "movie", title: "Rating Test", rating })
      expect(xml).not.toContain("<rating>")
    }
  })

  it("formats an integer rating without a trailing .0", () => {
    const xml = buildNfo({ type: "movie", title: "Rating Test", rating: "8" })
    expect(xml).toContain("<rating>8</rating>")
  })

  it("rounds a fractional rating to one decimal", () => {
    const xml = buildNfo({ type: "movie", title: "Rating Test", rating: 8.75 })
    expect(xml).toContain("<rating>8.8</rating>")
  })

  it("omits season and episode when null or undefined", () => {
    const xml = buildNfo({
      type: "episode",
      showTitle: "Show",
      season: null,
      episode: undefined,
    })
    expect(xml).not.toContain("<season>")
    expect(xml).not.toContain("<episode>")
  })

  it("emits season and episode zero", () => {
    const xml = buildNfo({
      type: "episode",
      showTitle: "Show",
      season: 0,
      episode: 0,
    })
    expect(xml).toContain("<season>0</season>")
    expect(xml).toContain("<episode>0</episode>")
  })
})
