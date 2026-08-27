import { describe, it, expect } from "vitest"
import { parsePlaylistLink } from "../src/scripts/lib/playlist-link"

describe("parsePlaylistLink", () => {
  it("parses a get.php-style Xtream link", () => {
    expect(parsePlaylistLink("http://demo.example:8080/get.php?username=u1&password=p1")).toEqual({
      type: "xtream",
      serverUrl: "http://demo.example:8080",
      username: "u1",
      password: "p1",
    })
  })

  it("parses a player_api.php-style Xtream link", () => {
    expect(parsePlaylistLink("https://provider.tv/player_api.php?username=alice&password=secret")).toEqual({
      type: "xtream",
      serverUrl: "https://provider.tv",
      username: "alice",
      password: "secret",
    })
  })

  it("drops extra path segments from the server URL", () => {
    expect(parsePlaylistLink("http://host:8080/get.php?username=u&password=p&type=m3u_plus&output=ts")).toEqual({
      type: "xtream",
      serverUrl: "http://host:8080",
      username: "u",
      password: "p",
    })
  })

  it("parses a bare .m3u8 URL", () => {
    expect(parsePlaylistLink("https://example.com/playlist.m3u8")).toEqual({
      type: "m3u",
      url: "https://example.com/playlist.m3u8",
    })
  })

  it("parses a bare .m3u URL", () => {
    expect(parsePlaylistLink("https://example.com/playlist.m3u")).toEqual({
      type: "m3u",
      url: "https://example.com/playlist.m3u",
    })
  })

  it("parses a URL with type=m3u in the query", () => {
    expect(parsePlaylistLink("http://example.com/get.php?type=m3u&output=ts")).toEqual({
      type: "m3u",
      url: "http://example.com/get.php?type=m3u&output=ts",
    })
  })

  it("adds http:// to scheme-less input", () => {
    expect(parsePlaylistLink("example.com/playlist.m3u8")).toEqual({
      type: "m3u",
      url: "http://example.com/playlist.m3u8",
    })
    expect(parsePlaylistLink("demo.example:8080/get.php?username=u1&password=p1")).toEqual({
      type: "xtream",
      serverUrl: "http://demo.example:8080",
      username: "u1",
      password: "p1",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(parsePlaylistLink("  http://demo.example:8080/get.php?username=u1&password=p1  ")).toEqual({
      type: "xtream",
      serverUrl: "http://demo.example:8080",
      username: "u1",
      password: "p1",
    })
  })

  it("accepts an uppercase scheme", () => {
    expect(parsePlaylistLink("HTTP://demo.example:8080/get.php?username=u1&password=p1")).toEqual({
      type: "xtream",
      serverUrl: "http://demo.example:8080",
      username: "u1",
      password: "p1",
    })
  })

  it("returns null when the password is missing", () => {
    expect(parsePlaylistLink("http://demo.example:8080/get.php?username=u1")).toBeNull()
  })

  it("returns null for plain text", () => {
    expect(parsePlaylistLink("hello world")).toBeNull()
  })

  it("returns null for empty input", () => {
    expect(parsePlaylistLink("")).toBeNull()
    expect(parsePlaylistLink("   ")).toBeNull()
  })

  it("returns null for a non-http(s) scheme", () => {
    expect(parsePlaylistLink("ftp://example.com/playlist.m3u")).toBeNull()
  })
})
