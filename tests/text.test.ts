import { describe, it, expect } from "vitest"
import { normalize, parseSearchQuery, scoreNormMatch, matchesNormQuery } from "@/scripts/lib/text.ts"

describe("parseSearchQuery", () => {
  it("marks a trailing-delimiter word as whole-word with a literal", () => {
    expect(parseSearchQuery("AT|")).toEqual([{ text: "at", wholeWord: true, literal: "at|" }])
  })

  it("marks a leading-delimiter word as whole-word with a literal", () => {
    expect(parseSearchQuery("|AT")).toEqual([{ text: "at", wholeWord: true, literal: "|at" }])
  })

  it("leaves a plain word as a substring token", () => {
    expect(parseSearchQuery("at")).toEqual([{ text: "at", wholeWord: false }])
  })

  it("marks a parenthesized word as whole-word with a literal", () => {
    expect(parseSearchQuery("(AT)")).toEqual([{ text: "at", wholeWord: true, literal: "(at)" }])
  })

  it("joins a mid-word delimiter into one literal whole-word token", () => {
    expect(parseSearchQuery("AT|ARCADIA")).toEqual([
      { text: "at arcadia", wholeWord: true, literal: "at|arcadia" },
    ])
  })

  it("joins a hyphenated prefix into one literal whole-word token", () => {
    expect(parseSearchQuery("sky-spo")).toEqual([
      { text: "sky spo", wholeWord: true, literal: "sky-spo" },
    ])
  })

  it("turns a quoted phrase into one whole-word token with internal spaces", () => {
    expect(parseSearchQuery('"AT| ARCADIA"')).toEqual([
      { text: "at arcadia", wholeWord: true, literal: "at| arcadia" },
    ])
  })

  it("drops a lone unmatched quote without crashing", () => {
    expect(parseSearchQuery('AT|"')).toEqual([{ text: "at", wholeWord: true, literal: "at|" }])
  })

  it("returns an empty list for an empty query", () => {
    expect(parseSearchQuery("")).toEqual([])
  })

  it("combines a quoted phrase with trailing unquoted words", () => {
    expect(parseSearchQuery('"AT| ARCADIA" HD')).toEqual([
      { text: "at arcadia", wholeWord: true, literal: "at| arcadia" },
      { text: "hd", wholeWord: false },
    ])
  })
})

describe("scoreNormMatch", () => {
  it("substring-matches a plain string token as before", () => {
    expect(scoreNormMatch("national geographic", ["at"])).toBeGreaterThan(0)
  })

  it("substring-matches a plain non-whole-word SearchToken", () => {
    expect(scoreNormMatch("national geographic", [{ text: "at", wholeWord: false }])).toBeGreaterThan(0)
  })

  it("does not match a whole-word token against a mid-word substring", () => {
    expect(scoreNormMatch("national geographic", [{ text: "at", wholeWord: true }])).toBe(0)
  })

  it("matches a whole-word token against a real word in the string", () => {
    expect(scoreNormMatch("at arcadia world hd", [{ text: "at", wholeWord: true }])).toBeGreaterThan(0)
  })

  it("matches a whole-word phrase token against the same word order", () => {
    expect(
      scoreNormMatch("at arcadia world hd", [{ text: "at arcadia", wholeWord: true }])
    ).toBeGreaterThan(0)
  })

  it("does not match a whole-word phrase token against reversed word order", () => {
    expect(scoreNormMatch("arcadia at", [{ text: "at arcadia", wholeWord: true }])).toBe(0)
  })

  it("returns 0 when any token misses", () => {
    expect(scoreNormMatch("arcadia world hd", [{ text: "at", wholeWord: true }, "nope"])).toBe(0)
  })

  it("rejects the AT| channel bug case against unrelated channel names via the norm fallback", () => {
    const tokens = parseSearchQuery("AT|")
    expect(scoreNormMatch(normalize("national geographic"), tokens)).toBe(0)
    expect(scoreNormMatch(normalize("arcadia"), tokens)).toBe(0)
    expect(scoreNormMatch(normalize("AT| ARCADIA WORLD HD"), tokens)).toBeGreaterThan(0)
  })

  it("rejects a delimiter literal against a raw name that only contains the word alone", () => {
    const tokens = parseSearchQuery("AT|")
    expect(scoreNormMatch(normalize("men at work"), tokens, "24/7 MEN AT WORK")).toBe(0)
  })

  it("matches a delimiter literal against a raw name carrying the literal punctuation", () => {
    const tokens = parseSearchQuery("AT|")
    expect(scoreNormMatch(normalize("at arcadia world hd"), tokens, "AT| ARCADIA WORLD HD")).toBeGreaterThan(0)
  })

  it("falls back to the normalized whole-word match when no raw name is given", () => {
    const tokens = parseSearchQuery("AT|")
    expect(scoreNormMatch("at arcadia world hd", tokens)).toBeGreaterThan(0)
  })

  it("still matches a plain word by substring", () => {
    expect(scoreNormMatch(normalize("national geographic"), parseSearchQuery("at"))).toBeGreaterThan(0)
  })

  it("still matches plain words against a normalized delimiter-bearing name", () => {
    expect(scoreNormMatch(normalize("SKY|SPORTS"), parseSearchQuery("sky sports"))).toBeGreaterThan(0)
  })

  it("keeps live prefix typing working for a hyphenated query via the raw-name literal", () => {
    const tokens = parseSearchQuery("sky-spo")
    expect(scoreNormMatch(normalize("sky-sports"), tokens, "Sky-Sports")).toBeGreaterThan(0)
  })

  it("keeps a full hyphenated word matching by substring via the raw-name literal", () => {
    const tokens = parseSearchQuery("sky-sport")
    expect(scoreNormMatch(normalize("sky-sports"), tokens, "Sky-Sports")).toBeGreaterThan(0)
  })
})

describe("matchesNormQuery", () => {
  it("returns true for an empty token list", () => {
    expect(matchesNormQuery("anything", [])).toBe(true)
  })

  it("returns true when scoreNormMatch is positive", () => {
    expect(matchesNormQuery("arcadia world hd", ["arcadia"])).toBe(true)
  })

  it("returns false when scoreNormMatch is zero", () => {
    expect(matchesNormQuery("national geographic", [{ text: "at", wholeWord: true }])).toBe(false)
  })
})
