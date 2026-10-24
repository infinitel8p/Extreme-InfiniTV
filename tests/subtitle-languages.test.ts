import { describe, expect, it } from "vitest"
import { SUBTITLE_LANGUAGES, subtitleLanguageName } from "@/scripts/lib/subtitle-languages"

describe("subtitle-languages", () => {
  it("has unique lowercase codes", () => {
    const codes = SUBTITLE_LANGUAGES.map((language) => language.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toBe(code.toLowerCase())
  })

  it("names known codes in English", () => {
    expect(subtitleLanguageName("en", "en")).toBe("English")
    expect(subtitleLanguageName("de", "en")).toBe("German")
  })

  it("localizes names", () => {
    expect(subtitleLanguageName("de", "de")).toBe("Deutsch")
  })

  it("handles regional codes", () => {
    expect(subtitleLanguageName("pt-br", "en")).toMatch(/Portuguese/)
    expect(subtitleLanguageName("zh-tw", "en")).toMatch(/Chinese/)
  })

  it("falls back to the code for unknown input", () => {
    expect(subtitleLanguageName("zz-unknown-code!", "en")).toBeTruthy()
  })
})
