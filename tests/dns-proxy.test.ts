import { describe, it, expect, beforeEach, vi } from "vitest"
import type { DnsServer } from "../src/scripts/lib/dns-config"

const invokeCalls: { command: string; args: unknown }[] = []

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invokeCalls.push({ command, args })
    if (command === "dns_proxy_register") return { baseUrl: "http://127.0.0.1:41234/tok" }
    if (command === "dns_resolve_test") return { addresses: ["1.2.3.4"], elapsedMs: 5 }
    return null
  },
}))

vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
}))

const server: DnsServer = { kind: "ip", host: "1.1.1.1", port: 53, raw: "1.1.1.1" }

describe("dns-proxy invoke payload contract", () => {
  beforeEach(() => {
    invokeCalls.length = 0
    vi.resetModules()
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
  })

  it("registers with server as the raw string, not the DnsServer object", async () => {
    const { ensureDnsProxy } = await import("../src/scripts/lib/dns-proxy")
    await ensureDnsProxy("dns:1.1.1.1", server)
    expect(invokeCalls).toEqual([
      { command: "dns_proxy_register", args: { sessionKey: "dns:1.1.1.1", server: "1.1.1.1" } },
    ])
  })

  it("resolve-tests with server as the raw string, not the DnsServer object", async () => {
    const { testDnsServer } = await import("../src/scripts/lib/dns-proxy")
    await testDnsServer(server, "example.com")
    expect(invokeCalls).toEqual([
      { command: "dns_resolve_test", args: { server: "1.1.1.1", host: "example.com" } },
    ])
  })
})
