import { describe, it, expect } from "vitest"
import {
  parseDnsServer,
  normalizeDnsInput,
  resolveDnsOverride,
  describeDnsServer,
} from "../src/scripts/lib/dns-config"

describe("parseDnsServer", () => {
  it("accepts a bare IPv4 address", () => {
    expect(parseDnsServer("1.1.1.1")).toEqual({
      kind: "ip",
      host: "1.1.1.1",
      port: 53,
      raw: "1.1.1.1",
    })
  })

  it("accepts an IPv4 address with a custom port", () => {
    expect(parseDnsServer("1.1.1.1:5353")).toEqual({
      kind: "ip",
      host: "1.1.1.1",
      port: 5353,
      raw: "1.1.1.1:5353",
    })
  })

  it("normalizes an explicit default port away", () => {
    expect(parseDnsServer("1.1.1.1:53")).toEqual({
      kind: "ip",
      host: "1.1.1.1",
      port: 53,
      raw: "1.1.1.1",
    })
  })

  it("accepts a bare IPv6 address", () => {
    expect(parseDnsServer("2606:4700::1111")).toEqual({
      kind: "ip",
      host: "2606:4700::1111",
      port: 53,
      raw: "2606:4700::1111",
    })
  })

  it("accepts a bracketed IPv6 address without a port", () => {
    expect(parseDnsServer("[2606:4700::1111]")).toEqual({
      kind: "ip",
      host: "2606:4700::1111",
      port: 53,
      raw: "2606:4700::1111",
    })
  })

  it("accepts a bracketed IPv6 address with a port", () => {
    expect(parseDnsServer("[2606:4700::1111]:853")).toEqual({
      kind: "ip",
      host: "2606:4700::1111",
      port: 853,
      raw: "[2606:4700::1111]:853",
    })
  })

  it("accepts the IPv6 unspecified address", () => {
    expect(parseDnsServer("::")).toEqual({
      kind: "ip",
      host: "::",
      port: 53,
      raw: "::",
    })
  })

  it("accepts the IPv6 loopback address", () => {
    expect(parseDnsServer("::1")).toEqual({
      kind: "ip",
      host: "::1",
      port: 53,
      raw: "::1",
    })
  })

  it("accepts a DoH URL unchanged", () => {
    expect(parseDnsServer("https://dnsforge.de/dns-query")).toEqual({
      kind: "doh",
      url: "https://dnsforge.de/dns-query",
      raw: "https://dnsforge.de/dns-query",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(parseDnsServer("  1.1.1.1  ")).toEqual({
      kind: "ip",
      host: "1.1.1.1",
      port: 53,
      raw: "1.1.1.1",
    })
  })

  it("rejects a hostname", () => {
    expect(parseDnsServer("dns.google")).toBeNull()
  })

  it("rejects an http:// DoH URL", () => {
    expect(parseDnsServer("http://dnsforge.de/dns-query")).toBeNull()
  })

  it("rejects an out-of-range port", () => {
    expect(parseDnsServer("1.1.1.1:70000")).toBeNull()
    expect(parseDnsServer("1.1.1.1:0")).toBeNull()
  })

  it("rejects an empty or blank input", () => {
    expect(parseDnsServer("")).toBeNull()
    expect(parseDnsServer("   ")).toBeNull()
  })

  it("rejects null and undefined", () => {
    expect(parseDnsServer(null)).toBeNull()
    expect(parseDnsServer(undefined)).toBeNull()
  })

  it("rejects an invalid IPv4 address", () => {
    expect(parseDnsServer("999.1.1.1")).toBeNull()
    expect(parseDnsServer("1.1.1")).toBeNull()
  })

  it("rejects an IPv4 octet with a leading zero", () => {
    expect(parseDnsServer("010.0.0.1")).toBeNull()
    expect(parseDnsServer("1.01.1.1")).toBeNull()
  })

  it("accepts IPv4 addresses with a literal zero octet", () => {
    expect(parseDnsServer("0.0.0.0")).toEqual({
      kind: "ip",
      host: "0.0.0.0",
      port: 53,
      raw: "0.0.0.0",
    })
    expect(parseDnsServer("10.0.0.1")).toEqual({
      kind: "ip",
      host: "10.0.0.1",
      port: 53,
      raw: "10.0.0.1",
    })
  })

  it("rejects an invalid IPv6 address", () => {
    expect(parseDnsServer("2606::4700::1111")).toBeNull()
    expect(parseDnsServer("gggg::1")).toBeNull()
  })

  it("rejects a malformed bracketed address", () => {
    expect(parseDnsServer("[2606:4700::1111")).toBeNull()
    expect(parseDnsServer("[not-ipv6]:53")).toBeNull()
  })

  it("rejects a malformed DoH URL", () => {
    expect(parseDnsServer("https://")).toBeNull()
  })
})

describe("normalizeDnsInput", () => {
  it("returns the normalized raw form for a valid input", () => {
    expect(normalizeDnsInput("1.1.1.1:53")).toBe("1.1.1.1")
    expect(normalizeDnsInput("[2606:4700::1111]:853")).toBe("[2606:4700::1111]:853")
  })

  it("returns null for an invalid input", () => {
    expect(normalizeDnsInput("dns.google")).toBeNull()
    expect(normalizeDnsInput(null)).toBeNull()
  })
})

describe("resolveDnsOverride", () => {
  it("prefers the entry-level override when both are set", () => {
    const resolved = resolveDnsOverride("1.1.1.1", "8.8.8.8")
    expect(resolved).toEqual({ kind: "ip", host: "1.1.1.1", port: 53, raw: "1.1.1.1" })
  })

  it("falls back to the global default when the entry has none", () => {
    const resolved = resolveDnsOverride(null, "8.8.8.8")
    expect(resolved).toEqual({ kind: "ip", host: "8.8.8.8", port: 53, raw: "8.8.8.8" })
  })

  it("falls back to the global default when the entry value is invalid", () => {
    const resolved = resolveDnsOverride("not-a-server", "8.8.8.8")
    expect(resolved).toEqual({ kind: "ip", host: "8.8.8.8", port: 53, raw: "8.8.8.8" })
  })

  it("returns null when neither is set", () => {
    expect(resolveDnsOverride(null, null)).toBeNull()
    expect(resolveDnsOverride(undefined, undefined)).toBeNull()
  })

  it("returns null when both are invalid", () => {
    expect(resolveDnsOverride("nope", "also-nope")).toBeNull()
  })
})

describe("describeDnsServer", () => {
  it("describes a plain IPv4 server", () => {
    expect(describeDnsServer(parseDnsServer("1.1.1.1")!)).toBe("1.1.1.1")
  })

  it("describes an IPv4 server with a custom port", () => {
    expect(describeDnsServer(parseDnsServer("1.1.1.1:5353")!)).toBe("1.1.1.1:5353")
  })

  it("describes a bracketed IPv6 server with a custom port", () => {
    expect(describeDnsServer(parseDnsServer("[2606::1]:853")!)).toBe("[2606::1]:853")
  })

  it("describes a bare IPv6 server at the default port without brackets", () => {
    expect(describeDnsServer(parseDnsServer("2606::1")!)).toBe("2606::1")
  })

  it("describes a DoH server by hostname", () => {
    expect(describeDnsServer(parseDnsServer("https://dnsforge.de/dns-query")!)).toBe(
      "DoH dnsforge.de",
    )
  })
})
