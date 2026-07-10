import { describe, it, expect } from "vitest"
import { redactUrl } from "../src/scripts/lib/log"

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
})
