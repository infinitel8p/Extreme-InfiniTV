import { describe, it, expect } from "vitest"
import {
  parseNamePrefix,
  languageTagLabel,
  preferredTagsForLocale,
  effectivePreferredTags,
  prefixQualityTokens,
} from "@/scripts/lib/language-tags.ts"

describe("parseNamePrefix", () => {
  it("finds a plain two-letter language prefix", () => {
    expect(parseNamePrefix("EN - It Ends (2025)")).toEqual({ tag: "EN", rest: "It Ends (2025)" })
    expect(parseNamePrefix("DE - Wenn das Licht zerbricht (2024)")).toEqual({
      tag: "DE",
      rest: "Wenn das Licht zerbricht (2024)",
    })
  })

  it("finds the first known language token in a compound prefix", () => {
    expect(parseNamePrefix("4K-FR-HDR - Projet Dernière Chance (2026)")).toEqual({
      tag: "FR",
      rest: "Projet Dernière Chance (2026)",
    })
    expect(parseNamePrefix("AR-SUBS - Silver Star (2025)")).toEqual({
      tag: "AR",
      rest: "Silver Star (2025)",
    })
    expect(parseNamePrefix("ES-DO - Noche de bodas 2 (2026)")).toEqual({
      tag: "ES",
      rest: "Noche de bodas 2 (2026)",
    })
    expect(parseNamePrefix("IN-TL - Some Title")).toEqual({ tag: "IN", rest: "Some Title" })
    expect(parseNamePrefix("KU-S - Some Title")).toEqual({ tag: "KU", rest: "Some Title" })
    expect(parseNamePrefix("KU-B - Some Title")).toEqual({ tag: "KU", rest: "Some Title" })
    expect(parseNamePrefix("AR-IN-S - name")).toEqual({ tag: "AR", rest: "name" })
    expect(parseNamePrefix("AF-EN - name")).toEqual({ tag: "EN", rest: "name" })
  })

  it("tolerates extra whitespace around the separator", () => {
    expect(parseNamePrefix("EN - It Ends  (2025)")).toEqual({ tag: "EN", rest: "It Ends  (2025)" })
  })

  it("tolerates a missing space after the dash (provider typo)", () => {
    expect(parseNamePrefix("4K-FR -Reacher (2022) (US)")).toEqual({
      tag: "FR",
      rest: "Reacher (2022) (US)",
    })
  })

  it("still requires whitespace before the dash, so hyphenated names don't false-positive", () => {
    expect(parseNamePrefix("Al-Jazeera News")).toEqual({ tag: null, rest: "Al-Jazeera News" })
  })

  it("returns tag null and the untouched name for non-language prefixes", () => {
    expect(parseNamePrefix("NF - My Brilliant Career (2026) (AU)")).toEqual({
      tag: null,
      rest: "NF - My Brilliant Career (2026) (AU)",
    })
    expect(parseNamePrefix("TOP - Some Title")).toEqual({ tag: null, rest: "TOP - Some Title" })
  })

  it("returns tag null when the whole name is mixed case", () => {
    expect(parseNamePrefix("Avatar Aang: l'ultimo dominatore dell'aria (2026)")).toEqual({
      tag: null,
      rest: "Avatar Aang: l'ultimo dominatore dell'aria (2026)",
    })
  })

  it("returns tag null when the prefix candidate has no space before the separator content", () => {
    expect(parseNamePrefix("Lupin III - Part 6")).toEqual({ tag: null, rest: "Lupin III - Part 6" })
  })

  it("returns tag null for a single unknown letter prefix", () => {
    expect(parseNamePrefix("V - The Series")).toEqual({ tag: null, rest: "V - The Series" })
  })

  it("returns tag null when the matched prefix consumes the whole name", () => {
    expect(parseNamePrefix("EN - ")).toEqual({ tag: null, rest: "EN -" })
  })

  it("returns tag null and the trimmed raw name for a plain title with no prefix", () => {
    expect(parseNamePrefix("The Batman")).toEqual({ tag: null, rest: "The Batman" })
  })

  it("handles empty input", () => {
    expect(parseNamePrefix("")).toEqual({ tag: null, rest: "" })
  })
})

describe("languageTagLabel", () => {
  it("returns an Intl display name for a plain bcp47 tag", () => {
    expect(languageTagLabel("DE", "en")).toBe("German")
    expect(languageTagLabel("FR", "en")).toBe("French")
  })

  it("uses the static label for tokens without a real bcp47 code", () => {
    expect(languageTagLabel("SC", "en")).toBe("Nordic")
  })

  it("uses the static label for tokens whose bcp47 code would mislead", () => {
    expect(languageTagLabel("IN", "en")).toBe("Indian")
  })

  it("falls back to the raw tag for a completely unknown token", () => {
    expect(languageTagLabel("ZZ", "en")).toBe("ZZ")
  })
})

describe("preferredTagsForLocale", () => {
  it("maps known app locales to their ordered candidate tags", () => {
    expect(preferredTagsForLocale("en")).toEqual(["EN"])
    expect(preferredTagsForLocale("de")).toEqual(["DE"])
    expect(preferredTagsForLocale("fr")).toEqual(["FR", "QC"])
    expect(preferredTagsForLocale("es")).toEqual(["ES", "LA"])
    expect(preferredTagsForLocale("pt-BR")).toEqual(["BR", "PT"])
    expect(preferredTagsForLocale("ur")).toEqual(["UR", "PK"])
    expect(preferredTagsForLocale("hi")).toEqual(["HI", "IN"])
  })

  it("falls back to the uppercased primary subtag when it is a known token", () => {
    expect(preferredTagsForLocale("nl-BE")).toEqual(["NL"])
    expect(preferredTagsForLocale("he")).toEqual(["HE"])
  })

  it("returns an empty array for a locale with no matching token", () => {
    expect(preferredTagsForLocale("xx")).toEqual([])
  })
})

describe("prefixQualityTokens", () => {
  it("returns the quality tokens from a compound prefix in order", () => {
    expect(prefixQualityTokens("4K-AMZ - Reacher (2022)")).toEqual(["4K"])
    expect(prefixQualityTokens("4K-DE - Reacher (US)")).toEqual(["4K"])
  })

  it("returns every quality token when more than one is present", () => {
    expect(prefixQualityTokens("4K-HDR-DE - Some Title")).toEqual(["4K", "HDR"])
  })

  it("returns an empty array when the prefix has no quality token", () => {
    expect(prefixQualityTokens("DE - Reacher (US)")).toEqual([])
    expect(prefixQualityTokens("AMZ - Reacher (2022)")).toEqual([])
  })

  it("returns an empty array when the name has no recognized prefix at all", () => {
    expect(prefixQualityTokens("The Batman")).toEqual([])
    expect(prefixQualityTokens("")).toEqual([])
  })

  it("still finds the quality token when the dash has no trailing space (provider typo)", () => {
    expect(prefixQualityTokens("4K-FR -Reacher (2022) (US)")).toEqual(["4K"])
  })
})

describe("effectivePreferredTags", () => {
  it("puts the explicit content language first, then the locale tags, then EN", () => {
    expect(effectivePreferredTags("FR", "de")).toEqual(["FR", "DE", "EN"])
  })

  it("dedupes overlapping tags while preserving order", () => {
    expect(effectivePreferredTags("EN", "en")).toEqual(["EN"])
    expect(effectivePreferredTags("", "en")).toEqual(["EN"])
  })

  it("falls back to locale tags plus EN when no content language is set", () => {
    expect(effectivePreferredTags("", "fr")).toEqual(["FR", "QC", "EN"])
  })
})
