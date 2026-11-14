import { describe, it, expect } from "vitest"
import { detailHrefFor, readDetailPlaylistParam } from "@/scripts/lib/detail-href.ts"

describe("detailHrefFor", () => {
  it("builds plain movie and series links", () => {
    expect(detailHrefFor("vod", 12)).toBe("/movies/detail?id=12")
    expect(detailHrefFor("series", "34")).toBe("/series/detail?id=34")
  })

  it("adds the tv prefix", () => {
    expect(detailHrefFor("vod", 1, { tv: true })).toBe("/tv/movies/detail?id=1")
  })

  it("orders params id, pl, autoplay, episode, download", () => {
    expect(
      detailHrefFor("series", 5, {
        playlistId: "abc-def",
        autoplay: true,
        episode: 99,
        download: true,
      }),
    ).toBe("/series/detail?id=5&pl=abc-def&autoplay=1&episode=99&download=1")
  })

  it("omits empty playlist and episode", () => {
    expect(detailHrefFor("vod", 1, { playlistId: "", episode: "", autoplay: false })).toBe(
      "/movies/detail?id=1",
    )
  })

  it("encodes values", () => {
    expect(detailHrefFor("vod", "a b", { playlistId: "x&y" })).toBe("/movies/detail?id=a+b&pl=x%26y")
  })
})

describe("readDetailPlaylistParam", () => {
  it("reads the pl param", () => {
    expect(readDetailPlaylistParam("?id=1&pl=abc")).toBe("abc")
  })

  it("returns empty when absent", () => {
    expect(readDetailPlaylistParam("?id=1")).toBe("")
    expect(readDetailPlaylistParam("")).toBe("")
  })
})
