import { describe, it, expect } from "vitest"
import { normalizeLang, pickTrack } from "@/scripts/lib/track-match"

describe("normalizeLang", () => {
  it("lowercases and trims", () => {
    expect(normalizeLang("  EN  ")).toBe("en")
  })

  it("strips a region suffix", () => {
    expect(normalizeLang("en-US")).toBe("en")
  })

  it("strips an underscore-separated region suffix", () => {
    expect(normalizeLang("pt_BR")).toBe("pt")
  })

  it("maps ISO 639-2/B and 639-2/T three-letter codes", () => {
    expect(normalizeLang("eng")).toBe("en")
    expect(normalizeLang("ger")).toBe("de")
    expect(normalizeLang("deu")).toBe("de")
    expect(normalizeLang("fre")).toBe("fr")
    expect(normalizeLang("fra")).toBe("fr")
    expect(normalizeLang("chi")).toBe("zh")
    expect(normalizeLang("zho")).toBe("zh")
    expect(normalizeLang("cze")).toBe("cs")
    expect(normalizeLang("ces")).toBe("cs")
  })

  it("passes through an unmapped three-letter code unchanged", () => {
    expect(normalizeLang("xyz")).toBe("xyz")
  })

  it("returns null for empty, und, unknown, mul, zxx", () => {
    expect(normalizeLang("")).toBeNull()
    expect(normalizeLang(null)).toBeNull()
    expect(normalizeLang(undefined)).toBeNull()
    expect(normalizeLang("und")).toBeNull()
    expect(normalizeLang("unknown")).toBeNull()
    expect(normalizeLang("mul")).toBeNull()
    expect(normalizeLang("zxx")).toBeNull()
  })
})

describe("pickTrack", () => {
  it("returns null when pref is null", () => {
    expect(pickTrack([{ id: 1, lang: "en", title: null }], null)).toBeNull()
  })

  it("matches by language, using id as a tiebreak among same-language tracks", () => {
    const tracks = [
      { id: 1, lang: "en", title: "English" },
      { id: 2, lang: "en", title: "English commentary" },
      { id: 3, lang: "de", title: "German" },
    ]
    expect(pickTrack(tracks, { lang: "en", id: 2, title: null })).toBe(2)
  })

  it("matches by language without an id, falling back to the first same-language track", () => {
    const tracks = [
      { id: 1, lang: "fr", title: null },
      { id: 2, lang: "en", title: null },
    ]
    expect(pickTrack(tracks, { lang: "en", id: null, title: null })).toBe(2)
  })

  it("returns null when the preferred language has no matching track", () => {
    const tracks = [{ id: 1, lang: "en", title: null }]
    expect(pickTrack(tracks, { lang: "de", id: 1, title: null })).toBeNull()
  })

  it("falls back to id when lang is null", () => {
    const tracks = [
      { id: 1, lang: "en", title: null },
      { id: 2, lang: "de", title: null },
    ]
    expect(pickTrack(tracks, { lang: null, id: 2, title: null })).toBe(2)
  })

  it("falls back to title when lang is null and id doesn't match", () => {
    const tracks = [
      { id: 1, lang: "en", title: "Commentary" },
      { id: 2, lang: "de", title: "Director's cut" },
    ]
    expect(pickTrack(tracks, { lang: null, id: 99, title: "director's cut" })).toBe(2)
  })

  it("returns null when lang is null and neither id nor title match", () => {
    const tracks = [{ id: 1, lang: "en", title: "Commentary" }]
    expect(pickTrack(tracks, { lang: null, id: 99, title: "missing" })).toBeNull()
  })
})
