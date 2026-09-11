// Shared "Test DNS server" check behind the login, Settings and TV DNS fields.

import { parseDnsServer, describeDnsServer, type DnsServer } from "@/scripts/lib/dns-config.ts"
import { testDnsServer } from "@/scripts/lib/dns-proxy.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"

const PROBE_TIMEOUT_MS = 6000

export type DnsReachability = "ok" | "unreachable" | "skipped"

export interface DnsCheckOutcome {
  addresses: string[]
  elapsedMs: number
  reachability: DnsReachability
}

function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `http://${url}`
}

export function hostnameOf(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ""
  try {
    return new URL(withScheme(trimmed)).hostname
  } catch {
    return ""
  }
}

// Does the address the resolver returned actually answer? Any HTTP status counts:
// a 403 or 404 still proves the connection landed somewhere.
async function probeReachable(probeUrl: string, server: DnsServer): Promise<boolean> {
  try {
    await providerFetch(withScheme(probeUrl), {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      logKind: "api",
      dns: server,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return true
  } catch (error) {
    log.warn("[xt:dns-test] reachability probe failed:", error)
    return false
  }
}

/** Resolves `host` through `server`, then (when `probeUrl` is given) checks that the answer answers. */
export async function runDnsCheck(
  server: DnsServer,
  host: string,
  probeUrl?: string | null
): Promise<DnsCheckOutcome> {
  const resolved = await testDnsServer(server, host)
  const reachability: DnsReachability = probeUrl
    ? (await probeReachable(probeUrl, server)) ? "ok" : "unreachable"
    : "skipped"
  return { addresses: resolved.addresses, elapsedMs: resolved.elapsedMs, reachability }
}

export function describeDnsError(error: unknown): string {
  const raw = String((error as Error)?.message || error || "")
  if (raw.startsWith("INVALID_SERVER:")) return t("dns.invalid")
  if (raw.startsWith("RESOLVE:")) return t("dns.errorResolve")
  if (raw.startsWith("TIMEOUT:")) return t("dns.errorTimeout")
  return t("dns.errorGeneric")
}

/** Outcome as a sentence, so a pass reads as a pass without relying on the tone colour. */
export function formatDnsOutcome(outcome: DnsCheckOutcome): string {
  const [first, ...rest] = outcome.addresses
  const ms = String(outcome.elapsedMs)
  const resolved = rest.length
    ? t("dns.resolvedMore", { address: first, count: String(rest.length), ms })
    : t("dns.resolved", { address: first || "", ms })
  if (outcome.reachability === "skipped") return resolved
  return `${resolved} ${outcome.reachability === "ok" ? t("dns.reachable") : t("dns.unreachable")}`
}

export function dnsOutcomeTone(outcome: DnsCheckOutcome): "good" | "warn" {
  return outcome.reachability === "unreachable" ? "warn" : "good"
}

/** Short label for the value, e.g. "1.1.1.1" or "DoH dnsforge.de"; null when unparseable. */
export function dnsShortLabel(raw: string | null | undefined): string | null {
  const server = parseDnsServer(raw)
  return server ? describeDnsServer(server) : null
}
