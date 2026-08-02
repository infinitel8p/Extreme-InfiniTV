// SSRF pre-filter: literal hostnames/addresses that must never be probed client-side.

const IPV4_PART_RX = /^(0x[0-9a-f]+|[0-9]+)$/i

function parseIPv4PartValue(part: string): number | null {
  if (part.length === 0) return null
  let radix = 10
  let digits = part
  if (/^0x/i.test(part)) {
    radix = 16
    digits = part.slice(2)
  } else if (part.length > 1 && part[0] === "0") {
    radix = 8
    digits = part.slice(1)
  }
  if (digits.length === 0) return null
  const validDigitsRx = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/
  if (!validDigitsRx.test(digits)) return null
  return parseInt(digits, radix)
}

/** Parses inet_aton-style dotted/short/decimal/octal/hex IPv4 forms into a 32-bit address. */
function parseIPv4(host: string): number | null {
  const parts = host.split(".")
  if (parts.length < 1 || parts.length > 4) return null
  const values = parts.map(parseIPv4PartValue)
  if (values.some((value) => value === null)) return null
  const numParts = values.length
  for (let index = 0; index < numParts - 1; index++) {
    if ((values[index] as number) > 255) return null
  }
  const lastValueBits = 32 - 8 * (numParts - 1)
  const lastMax = Math.pow(2, lastValueBits) - 1
  const lastValue = values[numParts - 1] as number
  if (lastValue > lastMax) return null
  let address = 0
  for (let index = 0; index < numParts - 1; index++) address = address * 256 + (values[index] as number)
  return address * Math.pow(2, lastValueBits) + lastValue
}

function looksLikeIPv4Attempt(host: string): boolean {
  const parts = host.split(".")
  return parts.length >= 1 && parts.length <= 4 && parts.every((part) => IPV4_PART_RX.test(part))
}

function isBlockedIPv4Address(address: number): boolean {
  const octet0 = (address >>> 24) & 0xff
  const octet1 = (address >>> 16) & 0xff
  if (octet0 === 0) return true
  if (octet0 === 127) return true
  if (octet0 === 10) return true
  if (octet0 === 172 && octet1 >= 16 && octet1 <= 31) return true
  if (octet0 === 192 && octet1 === 168) return true
  if (octet0 === 169 && octet1 === 254) return true
  if (octet0 === 100 && octet1 >= 64 && octet1 <= 127) return true
  if (octet0 === 198 && (octet1 === 18 || octet1 === 19)) return true
  if (octet0 >= 224 && octet0 <= 239) return true
  if (octet0 >= 240) return true
  return false
}

function parseHexGroup(group: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
  return parseInt(group, 16)
}

/** Expands "::" and a trailing embedded-IPv4 tail (mapped/compatible/NAT64) into 8 groups. */
function parseIPv6Groups(rawAddress: string): number[] | null {
  let address = rawAddress
  let embeddedIPv4: number | null = null
  const lastColonIndex = address.lastIndexOf(":")
  const tail = lastColonIndex === -1 ? address : address.slice(lastColonIndex + 1)
  if (tail.includes(".")) {
    embeddedIPv4 = parseIPv4(tail)
    if (embeddedIPv4 === null) return null
    address = lastColonIndex === -1 ? "0:0" : `${address.slice(0, lastColonIndex + 1)}0:0`
  }

  const sections = address.split("::")
  if (sections.length > 2) return null
  const isCompressed = sections.length === 2
  const headTokens = sections[0] ? sections[0].split(":") : []
  const tailTokens = isCompressed && sections[1] ? sections[1].split(":") : []
  if (!isCompressed && headTokens.length !== 8) return null
  if (isCompressed && headTokens.length + tailTokens.length >= 8) return null

  const headValues = headTokens.map(parseHexGroup)
  const tailValues = tailTokens.map(parseHexGroup)
  if (headValues.some((value) => value === null) || tailValues.some((value) => value === null)) return null

  const groups = isCompressed
    ? [...headValues, ...Array(8 - headValues.length - tailValues.length).fill(0), ...tailValues]
    : headValues
  const result = groups as number[]

  if (embeddedIPv4 !== null) {
    result[6] = (embeddedIPv4 >>> 16) & 0xffff
    result[7] = embeddedIPv4 & 0xffff
  }
  return result
}

function extractEmbeddedIPv4(groups: number[]): number | null {
  const [group0, group1, group2, group3, group4, group5, group6, group7] = groups
  if (group0 === 0 && group1 === 0 && group2 === 0 && group3 === 0 && group4 === 0 && group5 === 0xffff) {
    return group6 * 65536 + group7 // IPv4-mapped ::ffff:a.b.c.d
  }
  if (group0 === 0x64 && group1 === 0xff9b && group2 === 0 && group3 === 0 && group4 === 0 && group5 === 0) {
    return group6 * 65536 + group7 // NAT64 well-known prefix 64:ff9b::/96
  }
  if (group0 === 0 && group1 === 0 && group2 === 0 && group3 === 0 && group4 === 0 && group5 === 0 && (group6 !== 0 || group7 > 1)) {
    return group6 * 65536 + group7 // deprecated IPv4-compatible ::a.b.c.d
  }
  return null
}

function isBlockedIPv6Address(bareHost: string): boolean {
  const groups = parseIPv6Groups(bareHost)
  if (!groups) return true
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  if ((groups[0] & 0xff00) === 0xff00) return true
  const embeddedIPv4 = extractEmbeddedIPv4(groups)
  return embeddedIPv4 !== null && isBlockedIPv4Address(embeddedIPv4)
}

/** Name-only SSRF guard; the Rust probe does the real resolved-IP check. */
export function isPrivateOrLoopbackHost(urlString: string): boolean {
  let hostname: string
  try {
    const parsed = new URL(urlString)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true
    hostname = parsed.hostname.toLowerCase()
  } catch {
    return true
  }

  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (bareHost === "localhost" || bareHost.endsWith(".localhost") || bareHost.endsWith(".local")) return true
  if (bareHost.includes(":")) return isBlockedIPv6Address(bareHost)
  if (looksLikeIPv4Attempt(bareHost)) {
    const address = parseIPv4(bareHost)
    return address === null || isBlockedIPv4Address(address)
  }
  return false
}
