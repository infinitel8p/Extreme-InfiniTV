import { describe, it, expect } from "vitest"
import {
  wrapProxyUrl,
  wrapProxyUrlKeepingUserinfo,
  unwrapProxyUrl,
  isProxyUrl,
} from "../src/scripts/lib/dns-proxy-url"

const BASE_URL = "http://127.0.0.1:41234/abc123token"

describe("wrapProxyUrl", () => {
  it("wraps a plain http URL", () => {
    expect(wrapProxyUrl(BASE_URL, "http://provider.example/live/stream.m3u8")).toBe(
      `${BASE_URL}/http/provider.example/live/stream.m3u8`,
    )
  })

  it("wraps an https URL", () => {
    expect(wrapProxyUrl(BASE_URL, "https://provider.example/live/stream.m3u8")).toBe(
      `${BASE_URL}/https/provider.example/live/stream.m3u8`,
    )
  })

  it("keeps a non-default port on the host segment", () => {
    expect(wrapProxyUrl(BASE_URL, "http://provider.example:8080/path")).toBe(
      `${BASE_URL}/http/provider.example:8080/path`,
    )
  })

  it("drops the default port for the scheme", () => {
    expect(wrapProxyUrl(BASE_URL, "https://provider.example:443/path")).toBe(
      `${BASE_URL}/https/provider.example/path`,
    )
  })

  it("preserves the query string verbatim", () => {
    expect(wrapProxyUrl(BASE_URL, "http://provider.example/path?token=abc&x=1")).toBe(
      `${BASE_URL}/http/provider.example/path?token=abc&x=1`,
    )
  })

  it("keeps an IPv6 host bracketed", () => {
    expect(wrapProxyUrl(BASE_URL, "http://[2001:db8::1]:8080/path")).toBe(
      `${BASE_URL}/http/[2001:db8::1]:8080/path`,
    )
  })

  it("leaves an already-wrapped proxy URL unchanged", () => {
    const wrapped = `${BASE_URL}/http/provider.example/path`
    expect(wrapProxyUrl(BASE_URL, wrapped)).toBe(wrapped)
  })

  it("leaves a loopback URL unchanged", () => {
    const loopback = "http://127.0.0.1:9000/foo"
    expect(wrapProxyUrl(BASE_URL, loopback)).toBe(loopback)
  })

  it("leaves a blob: URL unchanged", () => {
    const blob = "blob:https://provider.example/1234-5678"
    expect(wrapProxyUrl(BASE_URL, blob)).toBe(blob)
  })

  it("leaves a data: URL unchanged", () => {
    const data = "data:text/plain;base64,SGVsbG8="
    expect(wrapProxyUrl(BASE_URL, data)).toBe(data)
  })

  it("leaves an unparseable string unchanged", () => {
    expect(wrapProxyUrl(BASE_URL, "not a url")).toBe("not a url")
  })

  it("throws when the upstream URL carries userinfo", () => {
    expect(() => wrapProxyUrl(BASE_URL, "http://user:pass@provider.example/path")).toThrow()
  })

  it("round-trips through unwrapProxyUrl", () => {
    const upstream = "https://provider.example:8080/live/stream.m3u8?token=abc"
    const wrapped = wrapProxyUrl(BASE_URL, upstream)
    expect(unwrapProxyUrl(wrapped)).toBe(upstream)
  })

  it("round-trips an IPv6 literal host", () => {
    const upstream = "https://[2606:4700::1111]/live/stream.m3u8"
    expect(unwrapProxyUrl(wrapProxyUrl(BASE_URL, upstream))).toBe(upstream)
  })

  it("round-trips an IPv6 literal host with a port", () => {
    const upstream = "http://[2606:4700::1111]:8080/live/stream.m3u8?token=abc"
    expect(unwrapProxyUrl(wrapProxyUrl(BASE_URL, upstream))).toBe(upstream)
  })
})

describe("unwrapProxyUrl", () => {
  it("unwraps a wrapped http URL", () => {
    expect(unwrapProxyUrl(`${BASE_URL}/http/provider.example/live/stream.m3u8`)).toBe(
      "http://provider.example/live/stream.m3u8",
    )
  })

  it("unwraps a wrapped https URL with a port and query", () => {
    expect(
      unwrapProxyUrl(`${BASE_URL}/https/provider.example:8080/path?token=abc`),
    ).toBe("https://provider.example:8080/path?token=abc")
  })

  it("unwraps a wrapped IPv6 host", () => {
    expect(unwrapProxyUrl(`${BASE_URL}/http/[2001:db8::1]:8080/path`)).toBe(
      "http://[2001:db8::1]:8080/path",
    )
  })

  it("unwraps an IPv6 host whose brackets came back percent-encoded", () => {
    expect(unwrapProxyUrl(`${BASE_URL}/https/%5B2606:4700::1111%5D:8080/path`)).toBe(
      "https://[2606:4700::1111]:8080/path",
    )
  })

  it("leaves a non-proxy URL unchanged", () => {
    const plain = "https://provider.example/path"
    expect(unwrapProxyUrl(plain)).toBe(plain)
  })

  it("leaves a URL that merely looks similar but is not loopback unchanged", () => {
    const lookalike = "http://example.com/abc123token/http/provider.example/path"
    expect(unwrapProxyUrl(lookalike)).toBe(lookalike)
  })
})

describe("wrapProxyUrlKeepingUserinfo", () => {
  it("re-embeds userinfo into the wrapped loopback URL", () => {
    expect(
      wrapProxyUrlKeepingUserinfo(BASE_URL, "http://user:pass@provider.example/live/stream.m3u8"),
    ).toBe(`${BASE_URL}/http/provider.example/live/stream.m3u8`.replace("http://", "http://user:pass@"))
  })

  it("behaves like wrapProxyUrl when there is no userinfo", () => {
    expect(wrapProxyUrlKeepingUserinfo(BASE_URL, "http://provider.example/path")).toBe(
      wrapProxyUrl(BASE_URL, "http://provider.example/path"),
    )
  })

  it("preserves userinfo alongside a bracketed IPv6 upstream host", () => {
    const upstream = "http://user:pass@[2606:4700::1111]:8080/live/stream.m3u8"
    expect(wrapProxyUrlKeepingUserinfo(BASE_URL, upstream)).toBe(
      `${BASE_URL}/http/[2606:4700::1111]:8080/live/stream.m3u8`.replace("http://", "http://user:pass@"),
    )
  })

  it("leaves a loopback URL unchanged", () => {
    const loopback = "http://127.0.0.1:9000/foo"
    expect(wrapProxyUrlKeepingUserinfo(BASE_URL, loopback)).toBe(loopback)
  })

  it("leaves an already-wrapped proxy URL unchanged", () => {
    const wrapped = `${BASE_URL}/http/provider.example/path`
    expect(wrapProxyUrlKeepingUserinfo(BASE_URL, wrapped)).toBe(wrapped)
  })

  it("leaves an unparseable string unchanged", () => {
    expect(wrapProxyUrlKeepingUserinfo(BASE_URL, "not a url")).toBe("not a url")
  })
})

describe("isProxyUrl", () => {
  it("recognizes a wrapped URL", () => {
    expect(isProxyUrl(`${BASE_URL}/http/provider.example/path`)).toBe(true)
  })

  it("rejects a plain upstream URL", () => {
    expect(isProxyUrl("https://provider.example/path")).toBe(false)
  })

  it("rejects a loopback URL that does not match the wrapped shape", () => {
    expect(isProxyUrl("http://127.0.0.1:9000/foo")).toBe(false)
  })

  it("rejects an unparseable string", () => {
    expect(isProxyUrl("not a url")).toBe(false)
  })
})
