// Pure classifier for sniffed network requests: playable HLS/DASH manifest or not, plus ranking.

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

// The dummy http base also filters blob:/data:/ws:, which keep their protocol after resolution.
function resolveUrl(url: string): URL | null {
  try {
    const parsed = new URL(url, "http://sniff-classify.invalid/")
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return parsed
  } catch {
    return null
  }
}

const MASTER_FILENAME_RX = /(?:^|[_.-])master[_.-]/i

function isMasterPlaylist(pathname: string): boolean {
  const lowerPathname = pathname.toLowerCase()
  const filename = lowerPathname.slice(lowerPathname.lastIndexOf("/") + 1)
  return MASTER_FILENAME_RX.test(filename) || lowerPathname.includes("/master/")
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

export interface HlsVariant {
  width: number | null
  height: number | null
  bandwidth: number | null
  uri: string | null
}

export interface HlsMediaRendition {
  type: string
  uri: string | null
  language: string | null
  name: string | null
}

export interface HlsMasterSummary {
  isMaster: boolean
  variants: HlsVariant[]
  media: HlsMediaRendition[]
}

const STREAM_INF_RX = /^#EXT-X-STREAM-INF:(.*)$/i
const MEDIA_TAG_RX = /^#EXT-X-MEDIA:(.*)$/i
const RESOLUTION_RX = /RESOLUTION=(\d+)x(\d+)/i
const BANDWIDTH_RX = /(?:^|,)\s*BANDWIDTH=(\d+)/i
const TYPE_ATTR_RX = /(?:^|,)\s*TYPE=([A-Z-]+)/i
const URI_ATTR_RX = /URI="([^"]*)"/i
const LANGUAGE_ATTR_RX = /LANGUAGE="([^"]*)"/i
const NAME_ATTR_RX = /NAME="([^"]*)"/i

/** The URI line belonging to a #EXT-X-STREAM-INF tag is the next non-blank, non-tag line. */
function variantUriAfter(lines: string[], streamInfLineIdx: number): string | null {
  for (let lineIdx = streamInfLineIdx + 1; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx].trim()
    if (!line) continue
    return line.startsWith("#") ? null : line
  }
  return null
}

/** Parses an HLS playlist text: variant streams (with resolved URI) plus alternate audio/subtitle renditions. */
export function summarizeHlsMaster(text: string): HlsMasterSummary {
  if (!text || typeof text !== "string") return { isMaster: false, variants: [], media: [] }
  const lines = text.split(/\r?\n/)
  const variants: HlsVariant[] = []
  const media: HlsMediaRendition[] = []
  lines.forEach((rawLine, lineIdx) => {
    const line = rawLine.trim()

    const streamInfMatch = STREAM_INF_RX.exec(line)
    if (streamInfMatch) {
      const attrs = streamInfMatch[1]
      const resolutionMatch = RESOLUTION_RX.exec(attrs)
      const bandwidthMatch = BANDWIDTH_RX.exec(attrs)
      variants.push({
        width: resolutionMatch ? Number(resolutionMatch[1]) : null,
        height: resolutionMatch ? Number(resolutionMatch[2]) : null,
        bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : null,
        uri: variantUriAfter(lines, lineIdx),
      })
      return
    }

    const mediaMatch = MEDIA_TAG_RX.exec(line)
    if (mediaMatch) {
      const attrs = mediaMatch[1]
      const typeMatch = TYPE_ATTR_RX.exec(attrs)
      const uriMatch = URI_ATTR_RX.exec(attrs)
      const languageMatch = LANGUAGE_ATTR_RX.exec(attrs)
      const nameMatch = NAME_ATTR_RX.exec(attrs)
      media.push({
        type: typeMatch ? typeMatch[1].toUpperCase() : "",
        uri: uriMatch ? uriMatch[1] : null,
        language: languageMatch ? languageMatch[1] : null,
        name: nameMatch ? nameMatch[1] : null,
      })
    }
  })
  return { isMaster: variants.length > 0, variants, media }
}

/** Picks a short quality label ("1080p", "1080p · 5.2 Mbps", "audio") from a master summary, or null when there's nothing to show. */
export function describeHlsQuality(summary: HlsMasterSummary, audioLabel: string): string | null {
  if (!summary.variants.length) return null
  const videoVariants = summary.variants.filter((variant) => variant.height)
  if (!videoVariants.length) return audioLabel
  const best = videoVariants.reduce((tallest, variant) =>
    (variant.height ?? 0) > (tallest.height ?? 0) ? variant : tallest
  )
  const heightLabel = `${best.height}p`
  if (!best.bandwidth) return heightLabel
  const megabitsPerSecond = (best.bandwidth / 1_000_000).toFixed(1)
  return `${heightLabel} · ${megabitsPerSecond} Mbps`
}
