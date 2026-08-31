import { describe, it, expect } from "vitest"
import { parsePlaylistLink, parsePlaylistLinks } from "../src/scripts/lib/playlist-link"

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

describe("parsePlaylistLinks", () => {
  it("treats a single Xtream link the same as parsePlaylistLink", () => {
    expect(parsePlaylistLinks("http://demo.example:8080/get.php?username=u1&password=p1")).toEqual({
      type: "xtream",
      entries: [{ serverUrl: "http://demo.example:8080", username: "u1", password: "p1" }],
    })
  })

  it("treats a single M3U link the same as parsePlaylistLink", () => {
    expect(parsePlaylistLinks("https://example.com/playlist.m3u8")).toEqual({
      type: "m3u",
      url: "https://example.com/playlist.m3u8",
    })
  })

  it("splits three Xtream links into a primary plus two mirrors", () => {
    const input = [
      "http://primary.example:8080/get.php?username=u1&password=p1",
      "http://mirror1.example:8080/get.php?username=u2&password=p2",
      "http://mirror2.example:8080/get.php?username=u3&password=p3",
    ].join("\n")
    expect(parsePlaylistLinks(input)).toEqual({
      type: "xtream",
      entries: [
        { serverUrl: "http://primary.example:8080", username: "u1", password: "p1" },
        { serverUrl: "http://mirror1.example:8080", username: "u2", password: "p2" },
        { serverUrl: "http://mirror2.example:8080", username: "u3", password: "p3" },
      ],
    })
  })

  it("splits on plain whitespace as well as newlines", () => {
    const input = "http://a.example/get.php?username=u1&password=p1 http://b.example/get.php?username=u2&password=p2"
    expect(parsePlaylistLinks(input)).toEqual({
      type: "xtream",
      entries: [
        { serverUrl: "http://a.example", username: "u1", password: "p1" },
        { serverUrl: "http://b.example", username: "u2", password: "p2" },
      ],
    })
  })

  it("skips invalid tokens mixed in with valid Xtream links", () => {
    const input = [
      "http://primary.example:8080/get.php?username=u1&password=p1",
      "not a link",
      "http://mirror.example:8080/get.php?username=u2&password=p2",
    ].join("\n")
    expect(parsePlaylistLinks(input)).toEqual({
      type: "xtream",
      entries: [
        { serverUrl: "http://primary.example:8080", username: "u1", password: "p1" },
        { serverUrl: "http://mirror.example:8080", username: "u2", password: "p2" },
      ],
    })
  })

  it("falls back to the first entry when the links are a mix of Xtream and M3U", () => {
    const input = [
      "http://primary.example:8080/get.php?username=u1&password=p1",
      "https://example.com/playlist.m3u8",
    ].join("\n")
    expect(parsePlaylistLinks(input)).toEqual({
      type: "xtream",
      entries: [{ serverUrl: "http://primary.example:8080", username: "u1", password: "p1" }],
    })
  })

  it("falls back to the first entry when an M3U link leads a mixed list", () => {
    const input = [
      "https://example.com/playlist.m3u8",
      "http://primary.example:8080/get.php?username=u1&password=p1",
    ].join("\n")
    expect(parsePlaylistLinks(input)).toEqual({
      type: "m3u",
      url: "https://example.com/playlist.m3u8",
    })
  })

  it("returns null when every token is invalid", () => {
    expect(parsePlaylistLinks("hello world")).toBeNull()
  })

  it("returns null for empty input", () => {
    expect(parsePlaylistLinks("")).toBeNull()
    expect(parsePlaylistLinks("   ")).toBeNull()
  })
})
