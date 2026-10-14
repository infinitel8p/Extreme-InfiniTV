// Pure parsing/formatting for per-playlist custom DNS server settings.

export type DnsServer =
  | { kind: "ip"; host: string; port: number; raw: string }
  | { kind: "doh"; url: string; raw: string }

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function isValidIpv4(address: string): boolean {
  const parts = address.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false
    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

// Not RFC-strict, but rejects hostnames/garbage while accepting compressed forms.
function isValidIpv6(address: string): boolean {
  if (!address.includes(":")) return false
  if ((address.match(/::/g) || []).length > 1) return false
  let groups: string[]
  if (address.includes("::")) {
    const [left, right] = address.split("::")
    const leftGroups = left === "" ? [] : left.split(":")
    const rightGroups = right === "" ? [] : right.split(":")
    if (leftGroups.length + rightGroups.length > 7) return false
    groups = [...leftGroups, ...rightGroups]
  } else {
    groups = address.split(":")
    if (groups.length !== 8) return false
  }
  return groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))
}

function buildIpServer(host: string, port: number): DnsServer {
  const raw = port === 53 ? host : host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
  return { kind: "ip", host, port, raw }
}

export function parseDnsServer(input: string | null | undefined): DnsServer | null {
  if (input == null) return null
  const trimmed = input.trim()
  if (trimmed === "") return null

  if (/^https:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (parsed.protocol !== "https:" || !parsed.hostname) return null
    return { kind: "doh", url: trimmed, raw: trimmed }
  }

  if (trimmed.startsWith("[")) {
    const bracketMatch = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed)
    if (!bracketMatch) return null
    const host = bracketMatch[1]
    if (!isValidIpv6(host)) return null
    const port = bracketMatch[2] ? Number(bracketMatch[2]) : 53
    if (!isValidPort(port)) return null
    return buildIpServer(host, port)
  }

  const ipv4Match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(trimmed)
  if (ipv4Match) {
    const host = ipv4Match[1]
    if (!isValidIpv4(host)) return null
    const port = ipv4Match[2] ? Number(ipv4Match[2]) : 53
    if (!isValidPort(port)) return null
    return buildIpServer(host, port)
  }

  if (isValidIpv6(trimmed)) return buildIpServer(trimmed, 53)

  return null
}

export function normalizeDnsInput(input: string | null | undefined): string | null {
  return parseDnsServer(input)?.raw ?? null
}

// Entry-level override wins, then the global default, else null (system DNS).
export function resolveDnsOverride(
  entryDns: string | null | undefined,
  globalDns: string | null | undefined,
): DnsServer | null {
  return parseDnsServer(entryDns) ?? parseDnsServer(globalDns)
}

export function describeDnsServer(server: DnsServer): string {
  if (server.kind === "ip") return server.raw
  try {
    return `DoH ${new URL(server.url).hostname}`
  } catch {
    return `DoH ${server.url}`
  }
}
