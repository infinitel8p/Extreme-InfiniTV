// Pure classifier for network requests sniffed out of an embedded web page:
// decides whether a URL is a playable HLS/DASH manifest and ranks candidates.

export interface SniffClassification {
  kind: "hls" | "dash"
  isMaster: boolean
}

export interface SniffCandidate {
  url: string
  kind: "hls" | "dash"
  isMaster: boolean
  userAgent: string | null
  referer: string | null
}

const HLS_EXTENSION_RX = /\.m3u8$/i
const DASH_EXTENSION_RX = /\.mpd$/i

const HLS_MIME_TYPES = new Set([
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
])
const DASH_MIME_TYPES = new Set(["application/dash+xml"])

function normalizedMimeType(contentType?: string | null): string | null {
  if (!contentType) return null
  const withoutParameters = contentType.split(";")[0]?.trim().toLowerCase()
  return withoutParameters || null
}

// Resolving relative URLs against a dummy http base also filters out
// blob:/data:/ws: schemes, since those keep their own protocol after resolution.
function resolveUrl(url: string): URL | null {
  try {
    const parsed = new URL(url, "http://sniff-classify.invalid/")
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return parsed
  } catch {
    return null
  }
}

function isMasterPlaylist(pathname: string): boolean {
  const lowerPathname = pathname.toLowerCase()
  const filename = lowerPathname.slice(lowerPathname.lastIndexOf("/") + 1)
  return filename.includes("master") || lowerPathname.includes("/master")
}

export function classifySniffedUrl(
  url: string,
  contentType?: string | null,
): SniffClassification | null {
  const parsed = resolveUrl(url)
  if (!parsed) return null

  const mimeType = normalizedMimeType(contentType)
  if (mimeType && HLS_MIME_TYPES.has(mimeType)) {
    return { kind: "hls", isMaster: isMasterPlaylist(parsed.pathname) }
  }
  if (mimeType && DASH_MIME_TYPES.has(mimeType)) {
    return { kind: "dash", isMaster: false }
  }

  if (HLS_EXTENSION_RX.test(parsed.pathname)) {
    return { kind: "hls", isMaster: isMasterPlaylist(parsed.pathname) }
  }
  if (DASH_EXTENSION_RX.test(parsed.pathname)) {
    return { kind: "dash", isMaster: false }
  }

  return null
}

function candidateRank(candidate: SniffCandidate): number {
  if (candidate.kind === "hls" && candidate.isMaster) return 0
  if (candidate.kind === "hls") return 1
  return 2
}

export function rankSniffCandidates(candidates: SniffCandidate[]): SniffCandidate[] {
  const seenUrls = new Set<string>()
  const deduped: SniffCandidate[] = []
  for (const candidate of candidates) {
    if (seenUrls.has(candidate.url)) continue
    seenUrls.add(candidate.url)
    deduped.push(candidate)
  }
  return [...deduped].sort((a, b) => candidateRank(a) - candidateRank(b))
}
