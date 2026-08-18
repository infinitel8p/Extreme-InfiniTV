import { describe, it, expect } from "vitest"
import { youtubeUrlFromTrailer, youtubeKeyFromUrl } from "../src/scripts/lib/detail-chrome"

describe("youtubeUrlFromTrailer", () => {
  it("wraps a bare 11-char id into a watch URL", () => {
    expect(youtubeUrlFromTrailer("dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )
  })

  it("passes a full URL through unchanged", () => {
    expect(youtubeUrlFromTrailer("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://youtu.be/dQw4w9WgXcQ"
    )
  })

  it("returns empty for anything else", () => {
    expect(youtubeUrlFromTrailer("")).toBe("")
    expect(youtubeUrlFromTrailer("not-a-valid-id")).toBe("")
    expect(youtubeUrlFromTrailer(null)).toBe("")
  })
})

describe("youtubeKeyFromUrl", () => {
  it("accepts a bare 11-char id", () => {
    expect(youtubeKeyFromUrl("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
  })

  it("extracts the key from a watch URL with extra params", () => {
    expect(
      youtubeKeyFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD123&t=45s")
    ).toBe("dQw4w9WgXcQ")
  })

  it("extracts the key from a youtu.be short link", () => {
    expect(youtubeKeyFromUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
  })

  it("extracts the key from an /embed/ URL", () => {
    expect(youtubeKeyFromUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    )
  })

  it("extracts the key from a /shorts/ URL", () => {
    expect(youtubeKeyFromUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    )
  })

  it("extracts the key from a /v/ URL", () => {
    expect(youtubeKeyFromUrl("https://www.youtube.com/v/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    )
  })

  it("is case-insensitive on the scheme", () => {
    expect(youtubeKeyFromUrl("HTTPS://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    )
  })

  it("returns empty for a non-YouTube host", () => {
    expect(youtubeKeyFromUrl("https://vimeo.com/watch?v=dQw4w9WgXcQ")).toBe("")
  })

  it("returns empty for garbage input", () => {
    expect(youtubeKeyFromUrl("not a url at all")).toBe("")
  })

  it("returns empty for an empty string", () => {
    expect(youtubeKeyFromUrl("")).toBe("")
  })
})
