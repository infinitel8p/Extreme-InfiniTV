// Desktop client for the Rust custom-DNS proxy (dns_proxy commands).

import type { DnsServer } from "@/scripts/lib/dns-config.ts"
import { log } from "@/scripts/lib/log.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

export function dnsProxyAvailable(): boolean {
  return isTauri
}

interface CachedSession {
  serverRaw: string
  baseUrl: string
}

const sessionCache = new Map<string, CachedSession>()
const pendingRegistrations = new Map<string, Promise<string | null>>()

export async function ensureDnsProxy(sessionKey: string, server: DnsServer): Promise<string | null> {
  if (!dnsProxyAvailable()) return null
  const cached = sessionCache.get(sessionKey)
  if (cached && cached.serverRaw === server.raw) return cached.baseUrl

  const pending = pendingRegistrations.get(sessionKey)
  if (pending) return pending

  const registration = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const result = (await invoke("dns_proxy_register", { sessionKey, server: server.raw })) as { baseUrl?: string }
      if (!result?.baseUrl) throw new Error("dns_proxy_register returned an unexpected shape")
      sessionCache.set(sessionKey, { serverRaw: server.raw, baseUrl: result.baseUrl })
      return result.baseUrl
    } catch (err) {
      log.warn("[xt:dns-proxy] dns_proxy_register failed:", err)
      return null
    } finally {
      pendingRegistrations.delete(sessionKey)
    }
  })()
  pendingRegistrations.set(sessionKey, registration)
  return registration
}

export async function releaseDnsProxy(sessionKey: string): Promise<void> {
  if (!dnsProxyAvailable()) return
  if (!sessionCache.has(sessionKey)) return
  sessionCache.delete(sessionKey)
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("dns_proxy_unregister", { sessionKey })
  } catch (err) {
    log.warn("[xt:dns-proxy] dns_proxy_unregister failed:", err)
  }
}

export async function testDnsServer(
  server: DnsServer,
  host: string,
): Promise<{ addresses: string[]; elapsedMs: number }> {
  const { invoke } = await import("@tauri-apps/api/core")
  return (await invoke("dns_resolve_test", { server: server.raw, host })) as {
    addresses: string[]
    elapsedMs: number
  }
}

export function cachedDnsProxyBase(sessionKey: string): string | null {
  return sessionCache.get(sessionKey)?.baseUrl ?? null
}
