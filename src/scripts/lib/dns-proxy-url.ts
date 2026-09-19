// Pure URL rewriting between an upstream URL and its DNS-proxy-wrapped form.

const PROXY_PATH_PATTERN = /^\/[^/]+\/(https?)\/[^/]+/

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || hostname.startsWith("127.")
}

export function isProxyUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:") return false
  if (!isLoopbackHost(parsed.hostname)) return false
  return PROXY_PATH_PATTERN.test(parsed.pathname)
}

function buildHostSegment(parsed: URL): string {
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
}

// baseUrl is "http://127.0.0.1:<port>/<token>"; only http/https upstreams are wrapped.
export function wrapProxyUrl(baseUrl: string, upstreamUrl: string): string {
  if (isProxyUrl(upstreamUrl)) return upstreamUrl
  let parsed: URL
  try {
    parsed = new URL(upstreamUrl)
  } catch {
    return upstreamUrl
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return upstreamUrl
  if (isLoopbackHost(parsed.hostname)) return upstreamUrl
  if (parsed.username || parsed.password) {
    throw new Error("wrapProxyUrl: upstream URL must not carry userinfo")
  }
  const scheme = parsed.protocol.slice(0, -1)
  const hostSegment = buildHostSegment(parsed)
  const normalizedBase = baseUrl.replace(/\/+$/, "")
  return `${normalizedBase}/${scheme}/${hostSegment}${parsed.pathname}${parsed.search}`
}

// Like wrapProxyUrl, but userinfo is re-embedded on the loopback URL instead of throwing.
export function wrapProxyUrlKeepingUserinfo(baseUrl: string, upstreamUrl: string): string {
  if (isProxyUrl(upstreamUrl)) return upstreamUrl
  let parsed: URL
  try {
    parsed = new URL(upstreamUrl)
  } catch {
    return upstreamUrl
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return upstreamUrl
  if (isLoopbackHost(parsed.hostname)) return upstreamUrl
  if (!parsed.username && !parsed.password) return wrapProxyUrl(baseUrl, upstreamUrl)
  const userinfo = `${parsed.username}:${parsed.password}@`
  parsed.username = ""
  parsed.password = ""
  return wrapProxyUrl(baseUrl, parsed.toString()).replace(/^(https?:\/\/)/, `$1${userinfo}`)
}

export function unwrapProxyUrl(url: string): string {
  if (!isProxyUrl(url)) return url
  const parsed = new URL(url)
  const parts = parsed.pathname.split("/")
  const scheme = parts[2]
  // Some URL implementations percent-encode the brackets of an IPv6 literal host in pathname.
  const hostSegment = parts[3].replace(/%5B/gi, "[").replace(/%5D/gi, "]")
  const restPath = `/${parts.slice(4).join("/")}`
  return `${scheme}://${hostSegment}${restPath}${parsed.search}`
}
