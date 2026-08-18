// Pure matcher for the iptv-org logo fallback; no DOM or network so it stays trivially unit-testable.

import { normalize } from "./text.ts"

export interface LogoApiRecord {
  channel: string
  feed: string | null
  in_use?: boolean
  width?: number
  height?: number
  format?: string
  url: string
}

const FORMAT_SCORES: Record<string, number> = {
  PNG: 100,
  SVG: 80,
  WEBP: 60,
  JPEG: 40,
  JPG: 40,
}

function scoreRecord(record: LogoApiRecord): number {
  let score = 0
  if (record.feed == null) score += 400
  if (record.in_use) score += 200
  score += FORMAT_SCORES[(record.format || "").toUpperCase()] || 0
  const width = Number(record.width) || 0
  score += (Math.min(width, 512) / 512) * 10
  return score
}

/** Reduce the raw iptv-org logos.json array to one best [channelId, url] pair per channel id. */
export function pickBestLogos(records: LogoApiRecord[]): Array<[string, string]> {
  const bestByLowerId = new Map<string, { score: number; url: string; channelId: string }>()
  for (const record of records) {
    const { channel, url } = record
    if (!channel || !url || !/^https?:\/\//i.test(url)) continue
    const score = scoreRecord(record)
    const lowerId = channel.toLowerCase()
    const existing = bestByLowerId.get(lowerId)
    if (!existing || score > existing.score || (score === existing.score && url < existing.url)) {
      bestByLowerId.set(lowerId, { score, url, channelId: channel })
    }
  }
  return [...bestByLowerId.values()].map((entry) => [entry.channelId, entry.url])
}

// Leading country/language tag; a hyphen only separates when whitespace-surrounded ("DE - ZDF" strips, "Al-Jazeera" survives).
const NAME_PREFIX_RE = /^[a-z]{2,3}(?:\s*[:|]\s*|\s+-\s+)/i

const COUNTRY_PREFIX_RE = /^([a-z]{2,3})(?:\s*[:|]\s*|\s+-\s+)/i

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "us",
  gb: "uk",
  gbr: "uk",
  eng: "uk",
  ger: "de",
  deu: "de",
  fra: "fr",
  esp: "es",
  spa: "es",
  ita: "it",
  nld: "nl",
  ned: "nl",
  hol: "nl",
  por: "pt",
  prt: "pt",
  bra: "br",
  tur: "tr",
  pol: "pl",
  rus: "ru",
  ukr: "ua",
  aus: "au",
  can: "ca",
  mex: "mx",
  arg: "ar",
  ind: "in",
  pak: "pk",
  swe: "se",
  nor: "no",
  den: "dk",
  dnk: "dk",
  fin: "fi",
  gre: "gr",
  grc: "gr",
  rou: "ro",
  rom: "ro",
  bul: "bg",
  bgr: "bg",
  hrv: "hr",
  cro: "hr",
  srb: "rs",
  cze: "cz",
  svk: "sk",
  hun: "hu",
  aut: "at",
  che: "ch",
  sui: "ch",
  bel: "be",
  irl: "ie",
  isr: "il",
  uae: "ae",
  sau: "sa",
  egy: "eg",
  mar: "ma",
  tun: "tn",
  zaf: "za",
  rsa: "za",
  jpn: "jp",
  kor: "kr",
  chn: "cn",
  twn: "tw",
  hkg: "hk",
  tha: "th",
  vnm: "vn",
  vie: "vn",
  phl: "ph",
  phi: "ph",
  idn: "id",
  mys: "my",
  sgp: "sg",
  nzl: "nz",
  alb: "al",
}

/** Resolve a raw 2-3 letter prefix code to the iptv-org 2-letter country code, or null if unknown. */
export function resolveCountryCode(code: string): string | null {
  const lowerCode = code.toLowerCase()
  if (COUNTRY_ALIASES[lowerCode]) return COUNTRY_ALIASES[lowerCode]
  if (/^[a-z]{2}$/.test(lowerCode)) return lowerCode
  return null
}

const JUNK_TOKENS = [
  "hd", "fhd", "uhd", "sd", "4k", "8k", "hevc", "h265", "h\\.265",
  "raw", "hq", "lq", "vip", "backup",
]
const JUNK_RE = new RegExp(`\\b(?:${JUNK_TOKENS.join("|")})\\b`, "gi")

/** Clean a display name into a compact match key: strip country prefix, quality junk, then normalize. */
export function logoNameKey(rawName: string): string {
  const withoutPrefix = (rawName || "").replace(NAME_PREFIX_RE, "")
  const withoutJunk = withoutPrefix.replace(JUNK_RE, " ")
  return normalize(withoutJunk).replace(/[^a-z0-9]/g, "")
}

export interface LogoIndex {
  byId: Map<string, string>
  byName: Map<string, Array<{ country: string; url: string }>>
}

/** Index pairs by full channel id (lowercased) and by a loose name key (for country-agnostic matching). */
export function buildLogoIndex(pairs: Array<[string, string]>): LogoIndex {
  const byId = new Map<string, string>()
  const byName = new Map<string, Array<{ country: string; url: string }>>()
  for (const [channelId, url] of pairs) {
    byId.set(channelId.toLowerCase(), url)

    const lastDotIndex = channelId.lastIndexOf(".")
    let namePart: string
    let country: string
    if (lastDotIndex === -1) {
      namePart = channelId
      country = ""
    } else {
      namePart = channelId.slice(0, lastDotIndex)
      const countryCandidate = channelId.slice(lastDotIndex + 1).toLowerCase()
      country = /^[a-z]{2}$/.test(countryCandidate) ? countryCandidate : ""
    }
    const nameKey = namePart.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (!nameKey) continue
    const bucket = byName.get(nameKey)
    if (bucket) bucket.push({ country, url })
    else byName.set(nameKey, [{ country, url }])
  }
  return { byId, byName }
}

/** Strip an "@feed" suffix, if any, from a tvgId-style string. */
function stripFeedSuffix(value: string): string {
  const atIndex = value.indexOf("@")
  return atIndex === -1 ? value : value.slice(0, atIndex)
}

/** Best-effort 2-letter country guess from tvgId ("BBCOne.uk@HD" -> "uk") or a name prefix ("DE: ZDF" -> "de"). */
export function countryHint(name: string | undefined, tvgId: string | undefined): string | null {
  if (tvgId) {
    const withoutFeed = stripFeedSuffix(tvgId.trim())
    const match = /\.([a-z]{2,3})$/i.exec(withoutFeed)
    if (match) {
      const resolved = resolveCountryCode(match[1])
      if (resolved) return resolved
    }
  }
  if (name) {
    const match = COUNTRY_PREFIX_RE.exec(name)
    if (match) {
      const resolved = resolveCountryCode(match[1])
      if (resolved) return resolved
    }
  }
  return null
}

/** Match a channel's name/tvgId against a built LogoIndex; returns a logo URL or null. */
export function matchLogo(
  index: LogoIndex,
  channel: { name?: string | null; tvgId?: string | null }
): string | null {
  const tvgId = channel.tvgId ? channel.tvgId.trim() : ""

  if (tvgId) {
    const idKey = stripFeedSuffix(tvgId).toLowerCase()
    const idHit = index.byId.get(idKey)
    if (idHit) return idHit
  }

  const displayKey = logoNameKey(channel.name || "")

  let tvgNameKey = ""
  if (tvgId) {
    const withoutFeed = stripFeedSuffix(tvgId)
    const lastDotIndex = withoutFeed.lastIndexOf(".")
    const tvgNamePart = lastDotIndex === -1 ? withoutFeed : withoutFeed.slice(0, lastDotIndex)
    tvgNameKey = logoNameKey(tvgNamePart)
  }

  if (displayKey.length < 3 && (!tvgNameKey || tvgNameKey.length < 3)) return null

  let bucket = index.byName.get(displayKey)
  if (!bucket && tvgNameKey) bucket = index.byName.get(tvgNameKey)
  if (!bucket || !bucket.length) return null

  if (bucket.length === 1) return bucket[0].url

  const hint = countryHint(channel.name || undefined, channel.tvgId || undefined)
  if (hint) {
    const hinted = bucket.find((candidate) => candidate.country === hint)
    if (hinted) return hinted.url
  }

  // No hint among several countries: only a shared url is safe to return.
  const firstUrl = bucket[0].url
  const allSameUrl = bucket.every((candidate) => candidate.url === firstUrl)
  return allSameUrl ? firstUrl : null
}
