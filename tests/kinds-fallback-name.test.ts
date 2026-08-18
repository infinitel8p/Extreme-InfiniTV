import { describe, it, expect } from "vitest"

import { isKindFallbackName } from "@/scripts/lib/kinds.ts"

describe("isKindFallbackName", () => {
  it("matches the localized series detail-page stub", () => {
    expect(isKindFallbackName("series", 21576, "Series 21576")).toBe(true)
  })

  it("matches the localized movie detail-page stub", () => {
    expect(isKindFallbackName("vod", 42, "Movie 42")).toBe(true)
  })

  it("matches the `${kindLabel} ${id}` form used by hub strips (kinds with no dedicated stub key)", () => {
    expect(isKindFallbackName("live", 7, "Live channel 7")).toBe(true)
  })

  it("does not match a real title", () => {
    expect(isKindFallbackName("series", 21576, "Breaking Bad")).toBe(false)
    expect(isKindFallbackName("vod", 42, "The Matrix")).toBe(false)
  })

  it("does not match the fallback name for a different id", () => {
    expect(isKindFallbackName("series", 21576, "Series 99999")).toBe(false)
    expect(isKindFallbackName("vod", 42, "Movie 99999")).toBe(false)
  })

  it("returns false for an empty name", () => {
    expect(isKindFallbackName("series", 21576, "")).toBe(false)
  })
})
