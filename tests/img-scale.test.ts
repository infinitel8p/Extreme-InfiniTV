import { describe, it, expect } from "vitest"
import { scaleToFit, imgCacheKey, isCacheableImageUrl } from "../src/scripts/lib/img-scale"

describe("scaleToFit", () => {
  it("downscales a landscape image", () => {
    expect(scaleToFit(2000, 1000, 576)).toEqual({ width: 576, height: 288 })
  })

  it("downscales a portrait image", () => {
    expect(scaleToFit(1000, 1500, 576)).toEqual({ width: 384, height: 576 })
  })

  it("downscales a square image", () => {
    expect(scaleToFit(1000, 1000, 576)).toEqual({ width: 576, height: 576 })
  })

  it("returns null when already exactly at maxDim", () => {
    expect(scaleToFit(576, 288, 576)).toBeNull()
  })

  it("returns null when smaller than maxDim", () => {
    expect(scaleToFit(100, 50, 576)).toBeNull()
  })

  it("returns null for zero dimensions", () => {
    expect(scaleToFit(0, 100, 576)).toBeNull()
    expect(scaleToFit(100, 0, 576)).toBeNull()
  })

  it("returns null for negative dimensions", () => {
    expect(scaleToFit(-100, 100, 576)).toBeNull()
  })

  it("returns null for NaN dimensions", () => {
    expect(scaleToFit(NaN, 100, 576)).toBeNull()
  })

  it("returns null for Infinity dimensions", () => {
    expect(scaleToFit(Infinity, 100, 576)).toBeNull()
  })

  it("clamps tiny aspect ratios to a minimum of 1", () => {
    expect(scaleToFit(10000, 1, 576)).toEqual({ width: 576, height: 1 })
  })
})

describe("imgCacheKey", () => {
  it("builds a kind-prefixed key", () => {
    expect(imgCacheKey("logo", "https://example.com/a.png")).toBe(
      "logo:https://example.com/a.png"
    )
  })
})

describe("isCacheableImageUrl", () => {
  it("accepts https URLs", () => {
    expect(isCacheableImageUrl("https://example.com/logo.png")).toBe(true)
  })

  it("accepts http URLs", () => {
    expect(isCacheableImageUrl("http://example.com/logo.png")).toBe(true)
  })

  it("accepts a provider host with port and path", () => {
    expect(isCacheableImageUrl("http://provider.example.com:8080/logos/1.png")).toBe(true)
  })

  it("rejects data: URLs", () => {
    expect(isCacheableImageUrl("data:image/png;base64,abcd")).toBe(false)
  })

  it("rejects blob: URLs", () => {
    expect(isCacheableImageUrl("blob:https://example.com/uuid")).toBe(false)
  })

  it("rejects file: URLs", () => {
    expect(isCacheableImageUrl("file:///home/user/logo.png")).toBe(false)
  })

  it("rejects malformed URLs", () => {
    expect(isCacheableImageUrl("not a url")).toBe(false)
    expect(isCacheableImageUrl("")).toBe(false)
  })

  it("rejects localhost", () => {
    expect(isCacheableImageUrl("http://localhost:1420/logo.png")).toBe(false)
  })

  it("rejects 127.0.0.1", () => {
    expect(isCacheableImageUrl("http://127.0.0.1:1420/logo.png")).toBe(false)
  })

  it("rejects asset.localhost", () => {
    expect(isCacheableImageUrl("https://asset.localhost/logo.png")).toBe(false)
  })

  it("rejects any *.localhost host", () => {
    expect(isCacheableImageUrl("http://foo.localhost/logo.png")).toBe(false)
  })
})
