// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { DnsServer } from "../src/scripts/lib/dns-config"

const GLOBAL_SERVER: DnsServer = { kind: "ip", host: "10.0.0.5", port: 5353, raw: "10.0.0.5:5353" }
const PLAYLIST_SERVER: DnsServer = { kind: "ip", host: "10.0.0.9", port: 53, raw: "10.0.0.9" }

let globalDnsRaw: string | null = null

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getUserAgent: () => "",
  getNetworkTimeoutSeconds: () => 15,
  getGlobalDns: () => globalDnsRaw,
  DNS_EVENT: "xt:dns-changed",
}))

vi.mock("@/scripts/lib/creds.js", () => ({
  getActiveDnsOverrideAsync: async () => PLAYLIST_SERVER,
}))

vi.mock("@/scripts/lib/dns-proxy.ts", () => ({
  dnsProxyAvailable: () => true,
  ensureDnsProxy: async (_sessionKey: string, server: DnsServer) =>
    `http://127.0.0.1:41234/tok-${server.raw.replace(/[^a-z0-9]/gi, "-")}`,
}))

vi.mock("@/scripts/lib/log.js", async () => {
  const actual = await vi.importActual<typeof import("@/scripts/lib/log")>("@/scripts/lib/log.js")
  return { ...actual, log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} } }
})

async function resolve(url: string, explicit: unknown) {
  const { resolveDnsRoutedUrl } = await import("@/scripts/lib/provider-fetch.js")
  return resolveDnsRoutedUrl(url, explicit)
}

beforeEach(() => {
  vi.resetModules()
  globalDnsRaw = GLOBAL_SERVER.raw
})

describe("resolveDnsRoutedUrl scopes", () => {
  it("routes app-level endpoints through the global default", async () => {
    const { url, server } = await resolve("https://api.themoviedb.org/3/movie/1", "global")
    expect(url).toBe("http://127.0.0.1:41234/tok-10-0-0-5-5353/https/api.themoviedb.org/3/movie/1")
    expect(server).toEqual(GLOBAL_SERVER)
  })

  it("ignores the active playlist override for the global scope", async () => {
    const { server } = await resolve("https://api.github.com/repos/x/y/releases", "global")
    expect(server?.raw).toBe(GLOBAL_SERVER.raw)
  })

  it("leaves the global scope direct when no global default is set", async () => {
    globalDnsRaw = null
    const { url, server } = await resolve("https://api.themoviedb.org/3/movie/1", "global")
    expect(url).toBe("https://api.themoviedb.org/3/movie/1")
    expect(server).toBeNull()
  })

  it("still resolves the active playlist override when no scope is given", async () => {
    const { server } = await resolve("https://provider.test/player_api.php", undefined)
    expect(server?.raw).toBe(PLAYLIST_SERVER.raw)
  })

  it("keeps null as an explicit opt-out", async () => {
    const { url, server } = await resolve("https://provider.test/player_api.php", null)
    expect(url).toBe("https://provider.test/player_api.php")
    expect(server).toBeNull()
  })
})
