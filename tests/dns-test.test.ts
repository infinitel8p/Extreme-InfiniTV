import { describe, it, expect, beforeEach, vi } from "vitest"
import type { DnsServer } from "../src/scripts/lib/dns-config"

const EN: Record<string, string> = {
  "dns.resolved": "Resolved to {address} in {ms} ms.",
  "dns.resolvedMore": "Resolved to {address} and {count} more in {ms} ms.",
  "dns.reachable": "The server answered through it.",
  "dns.unreachable": "The server didn't answer through it.",
  "dns.invalid": "Enter an IP address or an https:// DNS-over-HTTPS URL.",
  "dns.errorResolve": "Couldn't resolve through that DNS server.",
  "dns.errorTimeout": "Timed out contacting that DNS server.",
  "dns.errorGeneric": "DNS test failed.",
}

vi.mock("@/scripts/lib/i18n.js", () => ({
  t: (key: string, params?: Record<string, string>) =>
    Object.entries(params || {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      EN[key] ?? key
    ),
}))

vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
}))

let resolveImpl: (server: DnsServer, host: string) => Promise<{ addresses: string[]; elapsedMs: number }>
vi.mock("@/scripts/lib/dns-proxy.ts", () => ({
  dnsProxyAvailable: () => true,
  testDnsServer: (server: DnsServer, host: string) => resolveImpl(server, host),
}))

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

import {
  runDnsCheck,
  describeDnsError,
  formatDnsOutcome,
  dnsOutcomeTone,
  dnsShortLabel,
  hostnameOf,
} from "@/scripts/lib/dns-test"

const SERVER: DnsServer = { kind: "ip", host: "10.0.0.5", port: 5353, raw: "10.0.0.5:5353" }

beforeEach(() => {
  providerFetchMock.mockReset()
  resolveImpl = async () => ({ addresses: ["1.2.3.4"], elapsedMs: 7 })
})

describe("runDnsCheck", () => {
  it("skips reachability when no probe url is given", async () => {
    const outcome = await runDnsCheck(SERVER, "provider.test")
    expect(outcome).toEqual({ addresses: ["1.2.3.4"], elapsedMs: 7, reachability: "skipped" })
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("probes the resolved address through the same server", async () => {
    providerFetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    const outcome = await runDnsCheck(SERVER, "provider.test", "provider.test:8080")
    expect(outcome.reachability).toBe("ok")
    const [url, init] = providerFetchMock.mock.calls[0]
    expect(url).toBe("http://provider.test:8080")
    expect(init.dns).toEqual(SERVER)
  })

  it("counts any http status as reachable", async () => {
    providerFetchMock.mockResolvedValue(new Response(null, { status: 403 }))
    expect((await runDnsCheck(SERVER, "provider.test", "http://provider.test")).reachability).toBe("ok")
  })

  it("reports unreachable when the probe throws", async () => {
    providerFetchMock.mockRejectedValue(new Error("connection refused"))
    expect((await runDnsCheck(SERVER, "provider.test", "http://provider.test")).reachability).toBe(
      "unreachable"
    )
  })

  it("lets a resolve failure through so the caller can classify it", async () => {
    resolveImpl = async () => {
      throw new Error("RESOLVE: no records")
    }
    await expect(runDnsCheck(SERVER, "provider.test", "http://provider.test")).rejects.toThrow(/RESOLVE/)
    expect(providerFetchMock).not.toHaveBeenCalled()
  })
})

describe("formatDnsOutcome", () => {
  it("states the outcome in words, not only a tone", () => {
    const text = formatDnsOutcome({ addresses: ["1.2.3.4"], elapsedMs: 7, reachability: "ok" })
    expect(text).toBe("Resolved to 1.2.3.4 in 7 ms. The server answered through it.")
  })

  it("summarises extra addresses instead of listing them", () => {
    const text = formatDnsOutcome({
      addresses: ["1.2.3.4", "5.6.7.8", "9.9.9.9"],
      elapsedMs: 12,
      reachability: "skipped",
    })
    expect(text).toBe("Resolved to 1.2.3.4 and 2 more in 12 ms.")
  })

  it("names an unreachable answer", () => {
    const text = formatDnsOutcome({ addresses: ["1.2.3.4"], elapsedMs: 7, reachability: "unreachable" })
    expect(text).toContain("didn't answer")
  })
})

describe("dnsOutcomeTone", () => {
  it("warns when the resolve worked but the host stayed silent", () => {
    expect(dnsOutcomeTone({ addresses: ["1.2.3.4"], elapsedMs: 1, reachability: "unreachable" })).toBe("warn")
    expect(dnsOutcomeTone({ addresses: ["1.2.3.4"], elapsedMs: 1, reachability: "ok" })).toBe("good")
    expect(dnsOutcomeTone({ addresses: ["1.2.3.4"], elapsedMs: 1, reachability: "skipped" })).toBe("good")
  })
})

describe("describeDnsError", () => {
  it("maps the rust error prefixes onto distinct copy", () => {
    expect(describeDnsError(new Error("RESOLVE: nope"))).toBe("Couldn't resolve through that DNS server.")
    expect(describeDnsError(new Error("TIMEOUT: nope"))).toBe("Timed out contacting that DNS server.")
    expect(describeDnsError(new Error("INVALID_SERVER: nope"))).toContain("IP address")
    expect(describeDnsError(new Error("boom"))).toBe("DNS test failed.")
  })
})

describe("dnsShortLabel", () => {
  it("keeps an ip with its port and shortens a DoH url to its host", () => {
    expect(dnsShortLabel("10.0.0.5:5353")).toBe("10.0.0.5:5353")
    expect(dnsShortLabel("1.1.1.1")).toBe("1.1.1.1")
    expect(dnsShortLabel("https://dnsforge.de/dns-query")).toBe("DoH dnsforge.de")
  })

  it("returns null for anything unparseable", () => {
    expect(dnsShortLabel("010.0.0.1")).toBeNull()
    expect(dnsShortLabel("")).toBeNull()
    expect(dnsShortLabel(null)).toBeNull()
  })
})

describe("hostnameOf", () => {
  it("takes the hostname from a bare host, a host:port and a full url", () => {
    expect(hostnameOf("provider.test")).toBe("provider.test")
    expect(hostnameOf("provider.test:8080")).toBe("provider.test")
    expect(hostnameOf("http://provider.test:8080/get.php?username=a")).toBe("provider.test")
    expect(hostnameOf("  ")).toBe("")
  })
})
