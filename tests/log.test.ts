import { describe, it, expect } from "vitest"
import { redactUrl, redactArg, redactDeep } from "../src/scripts/lib/log"

describe("redactUrl", () => {
  it("strips Xtream username and password from query strings", () => {
    const out = redactUrl(
      "https://provider.tld:8080/player_api.php?username=alice&password=hunter2",
    )
    expect(out).toBe(
      "https://provider.tld:8080/player_api.php?username=***&password=***",
    )
    expect(out).not.toContain("alice")
    expect(out).not.toContain("hunter2")
  })

  it("redacts in either order and with arbitrary additional params", () => {
    const out = redactUrl(
      "https://x.test/?password=secret&action=get_live_categories&username=bob",
    )
    expect(out).toContain("password=***")
    expect(out).toContain("username=***")
    expect(out).toContain("action=get_live_categories")
  })

  it("redacts auth-bearing params and path-segment creds on the live stream URL", () => {
    const out = redactUrl(
      "https://provider.tld:8080/live/alice/hunter2/1234.m3u8?token=abcdef",
    )
    // The /live/<user>/<pass>/ path segments are masked alongside query params.
    expect(out).toBe(
      "https://provider.tld:8080/live/***/***/1234.m3u8?token=***",
    )
    expect(out).not.toContain("alice")
    expect(out).not.toContain("hunter2")
    expect(out).not.toContain("abcdef")
  })

  it("redacts credentials from other Xtream path kinds (movie/series/timeshift/hls/hlsr)", () => {
    expect(redactUrl("https://x.test/movie/alice/hunter2/9.mp4")).toBe(
      "https://x.test/movie/***/***/9.mp4",
    )
    expect(redactUrl("https://x.test/series/alice/hunter2/9.mp4")).toBe(
      "https://x.test/series/***/***/9.mp4",
    )
    expect(redactUrl("https://x.test/timeshift/alice/hunter2/60/2024-01-01:00-00/1.ts")).toBe(
      "https://x.test/timeshift/***/***/60/2024-01-01:00-00/1.ts",
    )
    expect(redactUrl("https://x.test/hls/alice/hunter2/index.m3u8")).toBe(
      "https://x.test/hls/***/***/index.m3u8",
    )
    expect(redactUrl("https://x.test/hlsr/alice/hunter2/token/index.m3u8")).toBe(
      "https://x.test/hlsr/***/***/token/index.m3u8",
    )
  })

  it("redacts common credential param names", () => {
    expect(redactUrl("https://x.test/?api_key=AKIA...")).toBe(
      "https://x.test/?api_key=***",
    )
    expect(redactUrl("https://x.test/?apikey=zzz")).toBe(
      "https://x.test/?apikey=***",
    )
    expect(redactUrl("https://x.test/?auth=Bearer+xyz")).toBe(
      "https://x.test/?auth=***",
    )
    expect(redactUrl("https://x.test/?key=abc")).toBe(
      "https://x.test/?key=***",
    )
  })

  it("returns the original string for URLs without credentials", () => {
    const safe = "https://provider.tld:8080/m3u_plus.php?type=m3u_plus"
    expect(redactUrl(safe)).toBe(safe)
  })

  it("handles missing / non-string inputs", () => {
    expect(redactUrl(null)).toBe("")
    expect(redactUrl(undefined)).toBe("")
    expect(redactUrl(42)).toBe("42")
  })

  it("is case-insensitive on the param name", () => {
    const out = redactUrl(
      "https://x.test/?Password=A&USERNAME=B&Token=C",
    )
    expect(out).toContain("Password=***")
    expect(out).toContain("USERNAME=***")
    expect(out).toContain("Token=***")
  })

  it("stops at the next & boundary so unrelated params survive", () => {
    const out = redactUrl(
      "https://x.test/?username=alice&action=get_series",
    )
    expect(out).toBe("https://x.test/?username=***&action=get_series")
  })

  it("redacts user:pass userinfo embedded in the URL", () => {
    const out = redactUrl("https://user:password@host/path")
    expect(out).toBe("https://***@host/path")
    expect(out).not.toContain("password")
  })

  it("redacts bare username userinfo", () => {
    expect(redactUrl("https://user@host/path")).toBe("https://***@host/path")
  })

  it("redacts userinfo and sensitive query params together", () => {
    const out = redactUrl(
      "https://alice:hunter2@provider.tld:8080/get.php?token=abcdef",
    )
    expect(out).toBe("https://***@provider.tld:8080/get.php?token=***")
    expect(out).not.toContain("alice")
    expect(out).not.toContain("hunter2")
    expect(out).not.toContain("abcdef")
  })

  it("does not treat an email-like @ in a query value as userinfo", () => {
    const safe = "https://x.test/subscribe?email=alice@example.com"
    expect(redactUrl(safe)).toBe(safe)
  })

  it("leaves non-URL strings with an @ unchanged", () => {
    const plain = "contact alice@example.com for support"
    expect(redactUrl(plain)).toBe(plain)
  })

  it("redacts sensitive keys in JSON-shaped text", () => {
    const out = redactUrl('{"username":"alice","password":"hunter2","other":"kept"}')
    expect(out).toBe('{"username":"***","password":"***","other":"kept"}')
  })

  it("redacts JSON-shaped keys case-insensitively and with spacing around the colon", () => {
    const out = redactUrl('{"Password": "hunter2", "Token" : "abcdef"}')
    expect(out).toBe('{"Password": "***", "Token" : "***"}')
  })

  it("redacts JSON-shaped credentials nested inside a larger log payload", () => {
    const out = redactUrl(
      JSON.stringify({ contentKey: "movie:42", mirrors: [{ username: "alice", password: "hunter2" }] }),
    )
    expect(out).not.toContain("alice")
    expect(out).not.toContain("hunter2")
    expect(out).toContain("movie:42")
  })

  it("redacts an Authorization key in JSON-shaped text", () => {
    const out = redactUrl('{"Authorization":"Basic dXNlcjpwYXNz"}')
    expect(out).toBe('{"Authorization":"***"}')
    expect(out).not.toContain("dXNlcjpwYXNz")
  })

  it("redacts a lowercase authorization query param", () => {
    const out = redactUrl("https://x.test/get.php?authorization=Basic+dXNlcjpwYXNz")
    expect(out).toBe("https://x.test/get.php?authorization=***")
    expect(out).not.toContain("dXNlcjpwYXNz")
  })

  it("still redacts auth/token/password params unaffected by the authorization addition", () => {
    expect(redactUrl("https://x.test/?auth=Bearer+xyz")).toBe("https://x.test/?auth=***")
    expect(redactUrl("https://x.test/?token=abcdef")).toBe("https://x.test/?token=***")
    expect(redactUrl("https://x.test/?password=hunter2")).toBe("https://x.test/?password=***")
  })
})

describe("redactArg", () => {
  it("passes non-string, non-object, non-Error values through unchanged", () => {
    expect(redactArg(42)).toBe(42)
    expect(redactArg(true)).toBe(true)
    expect(redactArg(null)).toBe(null)
    expect(redactArg(undefined)).toBe(undefined)
  })

  it("redacts a URL string argument", () => {
    expect(redactArg("https://x.test/?password=hunter2")).toBe("https://x.test/?password=***")
  })

  it("redacts an Error argument via its message", () => {
    const out = redactArg(new Error("failed for https://x.test/?password=hunter2"))
    expect(out).not.toContain("hunter2")
  })

  it("redacts sensitive fields inside an object argument while keeping it a structured object", () => {
    const out = redactArg({ contentKey: "movie:42", password: "hunter2" })
    expect(out).toEqual({ contentKey: "movie:42", password: "***" })
  })

  it("redacts sensitive fields inside a nested object argument", () => {
    const out = redactArg({
      contentKey: "episode:7",
      mirrors: [{ serverUrl: "http://mirror.test", username: "alice", password: "hunter2" }],
    })
    expect(out).toEqual({
      contentKey: "episode:7",
      mirrors: [{ serverUrl: "http://mirror.test", username: "***", password: "***" }],
    })
  })

  it("returns the same object reference when nothing needs redaction", () => {
    const date = new Date("2024-01-01T00:00:00.000Z")
    const arg = { contentKey: "movie:42", when: date }
    expect(redactArg(arg)).toBe(arg)
    expect((redactArg(arg) as { when: Date }).when).toBe(date)
  })

  it("falls back to a redacted string for a value JSON can't serialize", () => {
    const circular: Record<string, unknown> = { password: "hunter2" }
    circular.self = circular
    const out = redactArg(circular)
    expect(typeof out).toBe("string")
    expect(out).not.toContain("hunter2")
  })
})

describe("redactDeep", () => {
  it("masks a credentialed URL nested inside an object", () => {
    const out = redactDeep({ diagnostics: { url: "https://x.test/?password=hunter2" } })
    expect(out).toEqual({ diagnostics: { url: "https://x.test/?password=***" } })
  })

  it("masks a credentialed URL inside an array", () => {
    const out = redactDeep(["https://x.test/?password=hunter2", "https://x.test/safe"])
    expect(out).toEqual(["https://x.test/?password=***", "https://x.test/safe"])
  })

  it("masks a password-style JSON value embedded as raw text", () => {
    const out = redactDeep({ requestBody: '{"password":"hunter2"}' })
    expect(out).toEqual({ requestBody: '{"password":"***"}' })
  })

  it("leaves plain strings, numbers, and null untouched", () => {
    expect(redactDeep("hello")).toBe("hello")
    expect(redactDeep(42)).toBe(42)
    expect(redactDeep(null)).toBe(null)
    expect(redactDeep(undefined)).toBe(undefined)
  })

  it("handles a circular object without throwing", () => {
    const circular: Record<string, unknown> = { password: "hunter2" }
    circular.self = circular
    expect(() => redactDeep(circular)).not.toThrow()
  })

  it("masks an Authorization-style JSON value embedded as raw text inside a nested object", () => {
    const out = redactDeep({ requestBody: '{"Authorization":"Basic dXNlcjpwYXNz"}' })
    expect(out).toEqual({ requestBody: '{"Authorization":"***"}' })
  })
})
