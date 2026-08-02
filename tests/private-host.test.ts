import { describe, expect, it } from "vitest"
import { isPrivateOrLoopbackHost } from "../src/scripts/lib/private-host"

describe("isPrivateOrLoopbackHost", () => {
  it("does not block a public hostname or IP", () => {
    expect(isPrivateOrLoopbackHost("https://example.com/x.m3u8")).toBe(false)
    expect(isPrivateOrLoopbackHost("https://8.8.8.8/x.m3u8")).toBe(false)
  })

  it("does not block a public IPv6 address", () => {
    expect(isPrivateOrLoopbackHost("https://[2001:4860:4860::8888]/x.m3u8")).toBe(false)
  })

  it("blocks localhost and its subdomains", () => {
    expect(isPrivateOrLoopbackHost("http://localhost/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://foo.localhost/x.m3u8")).toBe(true)
  })

  it("blocks .local mDNS hostnames", () => {
    expect(isPrivateOrLoopbackHost("http://nas.local/x.m3u8")).toBe(true)
  })

  it("does not block a hostname that merely contains 'local' without the suffix", () => {
    expect(isPrivateOrLoopbackHost("http://foolocal.example.com/x.m3u8")).toBe(false)
  })

  it("blocks the standard private/loopback/link-local IPv4 ranges", () => {
    expect(isPrivateOrLoopbackHost("http://127.0.0.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://10.1.2.3/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://172.16.0.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://172.31.255.255/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://172.32.0.1/x.m3u8")).toBe(false)
    expect(isPrivateOrLoopbackHost("http://192.168.1.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://169.254.1.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://0.0.0.0/x.m3u8")).toBe(true)
  })

  it("blocks CGNAT, benchmarking, reserved, and broadcast IPv4 ranges", () => {
    expect(isPrivateOrLoopbackHost("http://100.64.0.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://100.127.255.255/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://100.63.255.255/x.m3u8")).toBe(false)
    expect(isPrivateOrLoopbackHost("http://198.18.0.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://198.19.255.255/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://198.20.0.1/x.m3u8")).toBe(false)
    expect(isPrivateOrLoopbackHost("http://240.0.0.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://255.255.255.255/x.m3u8")).toBe(true)
  })

  it("blocks IPv4 multicast", () => {
    expect(isPrivateOrLoopbackHost("http://224.0.0.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://239.255.255.255/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://223.255.255.255/x.m3u8")).toBe(false)
  })

  it("blocks all of 0.0.0.0/8", () => {
    expect(isPrivateOrLoopbackHost("http://0.0.0.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://0.255.255.255/x.m3u8")).toBe(true)
  })

  it("blocks bare-decimal, octal, and hex IPv4 encodings", () => {
    expect(isPrivateOrLoopbackHost("http://3232235777/x.m3u8")).toBe(true) // 192.168.1.1
    expect(isPrivateOrLoopbackHost("http://0177.0.0.1/x.m3u8")).toBe(true) // 127.0.0.1
    expect(isPrivateOrLoopbackHost("http://0300.0250.0.1/x.m3u8")).toBe(true) // 192.168.0.1
    expect(isPrivateOrLoopbackHost("http://0x7f000001/x.m3u8")).toBe(true) // 127.0.0.1
    expect(isPrivateOrLoopbackHost("http://0x7f.0x0.0x0.0x1/x.m3u8")).toBe(true) // 127.0.0.1
  })

  it("blocks short-form dotted IPv4 addresses", () => {
    expect(isPrivateOrLoopbackHost("http://127.1/x.m3u8")).toBe(true) // 127.0.0.1
    expect(isPrivateOrLoopbackHost("http://10.1/x.m3u8")).toBe(true) // 10.0.0.1
  })

  it("blocks malformed numeric-looking IPv4 hosts instead of letting them through", () => {
    expect(isPrivateOrLoopbackHost("http://999.1.1.1/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://089.0.0.1/x.m3u8")).toBe(true) // invalid octal digits
  })

  it("blocks IPv6 loopback, unspecified, link-local, ULA, and multicast", () => {
    expect(isPrivateOrLoopbackHost("http://[::1]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[::]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[fe80::1]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[fc00::1]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[fd12:3456::1]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[ff02::1]/x.m3u8")).toBe(true)
  })

  it("blocks IPv4-mapped, IPv4-compatible, and NAT64-embedded IPv6 addresses whose IPv4 is private", () => {
    expect(isPrivateOrLoopbackHost("http://[::ffff:127.0.0.1]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[::ffff:192.168.1.1]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[64:ff9b::10.0.0.1]/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("http://[::10.0.0.1]/x.m3u8")).toBe(true)
  })

  it("does not block an IPv4-mapped address whose embedded IPv4 is public", () => {
    expect(isPrivateOrLoopbackHost("http://[::ffff:8.8.8.8]/x.m3u8")).toBe(false)
  })

  it("blocks the deprecated IPv4-compatible address ::2", () => {
    expect(isPrivateOrLoopbackHost("http://[::2]/x.m3u8")).toBe(true)
  })

  it("blocks a URL that fails to parse or uses a non-http(s) scheme", () => {
    expect(isPrivateOrLoopbackHost("not a url at all")).toBe(true)
    expect(isPrivateOrLoopbackHost("ftp://example.com/x.m3u8")).toBe(true)
    expect(isPrivateOrLoopbackHost("blob:https://host.example/1234")).toBe(true)
  })
})
