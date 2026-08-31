import { describe, it, expect } from "vitest"
import { backdropFromInfoPayload } from "../src/scripts/lib/backdrop"

describe("backdropFromInfoPayload", () => {
  it("reads a string backdrop_path off info", () => {
    expect(backdropFromInfoPayload({ info: { backdrop_path: "https://example.com/a.jpg" } })).toBe(
      "https://example.com/a.jpg"
    )
  })

  it("reads the first entry of an array backdrop_path", () => {
    expect(
      backdropFromInfoPayload({ info: { backdrop_path: ["https://example.com/a.jpg", "https://example.com/b.jpg"] } })
    ).toBe("https://example.com/a.jpg")
  })

  it("falls back to movie_data when info is absent", () => {
    expect(backdropFromInfoPayload({ movie_data: { backdrop_path: "https://example.com/c.jpg" } })).toBe(
      "https://example.com/c.jpg"
    )
  })

  it("returns null for an empty array", () => {
    expect(backdropFromInfoPayload({ info: { backdrop_path: [] } })).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(backdropFromInfoPayload({ info: { backdrop_path: "" } })).toBeNull()
  })

  it("returns null when backdrop_path is missing", () => {
    expect(backdropFromInfoPayload({ info: {} })).toBeNull()
  })

  it("returns null for null/undefined payloads", () => {
    expect(backdropFromInfoPayload(null)).toBeNull()
    expect(backdropFromInfoPayload(undefined)).toBeNull()
  })
})
