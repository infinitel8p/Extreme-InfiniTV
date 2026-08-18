import { describe, it, expect } from "vitest"
import { sanitizeProviderBackdropUrl } from "../src/scripts/lib/morph-detail"

describe("sanitizeProviderBackdropUrl", () => {
  it("accepts a real 16:9 TMDb backdrop (KoolWebTV)", () => {
    const url = sanitizeProviderBackdropUrl(
      ["https://image.tmdb.org/t/p/w1280/11kSpoQwxoBT4KQfgBMCsRPFYKW.jpg"],
      "https://example.com/poster.jpg"
    )
    expect(url).toBe("https://image.tmdb.org/t/p/w1280/11kSpoQwxoBT4KQfgBMCsRPFYKW.jpg")
  })

  it("rejects a portrait poster URL mislabeled as a backdrop (Strong8k)", () => {
    const url = sanitizeProviderBackdropUrl(
      ["https://image.tmdb.org/t/p/w600_and_h900_bestv2/4HodYYKEIsGOdinkGi2Ucz6X9i0.jpg"],
      "https://example.com/poster.jpg"
    )
    expect(url).toBeNull()
  })

  it("accepts a non-TMDb host whose shape is unknowable from the URL (apolloios)", () => {
    const url = sanitizeProviderBackdropUrl(
      ["https://myapollopanel.com:443/images/opaque-id"],
      "https://example.com/poster.jpg"
    )
    expect(url).toBe("https://myapollopanel.com:443/images/opaque-id")
  })

  it("accepts a string input, not just an array", () => {
    const url = sanitizeProviderBackdropUrl(
      "https://image.tmdb.org/t/p/original/backdrop.jpg",
      "https://example.com/poster.jpg"
    )
    expect(url).toBe("https://image.tmdb.org/t/p/original/backdrop.jpg")
  })

  it("rejects a backdrop URL identical to the chosen poster URL", () => {
    const posterUrl = "https://example.com/same.jpg"
    const url = sanitizeProviderBackdropUrl([posterUrl], posterUrl)
    expect(url).toBeNull()
  })

  it.each(["w92", "w154", "w185", "w342", "w500"])(
    "rejects the TMDb portrait size %s",
    (size) => {
      const url = sanitizeProviderBackdropUrl(
        [`https://image.tmdb.org/t/p/${size}/abc.jpg`],
        "https://example.com/poster.jpg"
      )
      expect(url).toBeNull()
    }
  )

  it("returns null for an empty array", () => {
    expect(sanitizeProviderBackdropUrl([], "https://example.com/poster.jpg")).toBeNull()
  })

  it("returns null for null / undefined / non-string entries", () => {
    expect(sanitizeProviderBackdropUrl(null, "https://example.com/poster.jpg")).toBeNull()
    expect(sanitizeProviderBackdropUrl(undefined, "https://example.com/poster.jpg")).toBeNull()
    expect(sanitizeProviderBackdropUrl([42], "https://example.com/poster.jpg")).toBeNull()
    expect(sanitizeProviderBackdropUrl("", "https://example.com/poster.jpg")).toBeNull()
  })

  it("accepts a backdrop even when there is no poster to compare against", () => {
    const url = sanitizeProviderBackdropUrl(
      ["https://image.tmdb.org/t/p/w1280/11kSpoQwxoBT4KQfgBMCsRPFYKW.jpg"],
      null
    )
    expect(url).toBe("https://image.tmdb.org/t/p/w1280/11kSpoQwxoBT4KQfgBMCsRPFYKW.jpg")
  })
})
