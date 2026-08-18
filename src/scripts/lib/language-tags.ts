// Helpers for the IPTV-provider name-prefix convention (not ISO), e.g. "EN - ", "DE-HDR - ", "4K-FR - ".

export interface LanguageTagInfo {
  bcp47: string | null
  label?: string
}

// Provider language tokens mapped to a BCP-47 tag for Intl.DisplayNames; `label` overrides when bcp47 would mislead.
export const LANGUAGE_TOKENS: Record<string, LanguageTagInfo> = {
  EN: { bcp47: "en" },
  DE: { bcp47: "de" },
  FR: { bcp47: "fr" },
  ES: { bcp47: "es" },
  IT: { bcp47: "it" },
  PT: { bcp47: "pt" },
  NL: { bcp47: "nl" },
  PL: { bcp47: "pl" },
  TR: { bcp47: "tr" },
  RU: { bcp47: "ru" },
  AR: { bcp47: "ar" },
  RO: { bcp47: "ro" },
  BG: { bcp47: "bg" },
  NO: { bcp47: "no" },
  FI: { bcp47: "fi" },
  IS: { bcp47: "is" },
  HU: { bcp47: "hu" },
  HR: { bcp47: "hr" },
  SR: { bcp47: "sr" },
  MK: { bcp47: "mk" },
  SK: { bcp47: "sk" },
  HI: { bcp47: "hi" },
  TA: { bcp47: "ta" },
  TE: { bcp47: "te" },
  ML: { bcp47: "ml" },
  KN: { bcp47: "kn" },
  BN: { bcp47: "bn" },
  ID: { bcp47: "id" },
  MY: { bcp47: "my" },
  VI: { bcp47: "vi" },
  TH: { bcp47: "th" },
  SO: { bcp47: "so" },
  HE: { bcp47: "he" },
  UR: { bcp47: "ur" },
  GR: { bcp47: "el" },
  IR: { bcp47: "fa" },
  AL: { bcp47: "sq" },
  SE: { bcp47: "sv" },
  DK: { bcp47: "da" },
  IL: { bcp47: "he" },
  IN: { bcp47: "hi", label: "Indian" },
  PK: { bcp47: "ur" },
  PH: { bcp47: "tl" },
  LA: { bcp47: "es-419" },
  QC: { bcp47: "fr-CA" },
  KU: { bcp47: "ku" },
  SC: { bcp47: null, label: "Nordic" },
  BR: { bcp47: "pt-BR" },
  CZ: { bcp47: "cs" },
  UA: { bcp47: "uk" },
  JP: { bcp47: "ja" },
  KR: { bcp47: "ko" },
  CN: { bcp47: "zh" },
  ZH: { bcp47: "zh" },
}

// Non-language tokens that match the prefix shape (streaming/quality/content tags); never treated as a language by parseNamePrefix.
export const NON_LANGUAGE_TOKENS: Set<string> = new Set([
  "TOP", "NF", "AMZ", "D+", "A+", "DSC+", "PRMT", "VP", "SOC", "EX", "XXX",
  "4K", "HDR", "CAM", "UNV", "ANM", "DOC", "POD", "XMAS", "KID", "KIDS",
  "MULTI", "NEW", "OLD",
  "SUB", "SUBS", "DUB", "DO", "S", "B", "HEVC", "H265", "FHD", "UHD", "HD", "SD", "VIP",
])

// Quality/format markers that can appear alongside a language token in the prefix (e.g. "4K-DE - ").
export const QUALITY_TOKENS: Set<string> = new Set([
  "4K", "UHD", "FHD", "HD", "SD", "HDR", "2160P", "1080P", "720P", "480P", "CAM",
])

// Tokens joined by "-", followed by " - " (space before dash required, tolerates a missing space after), "| " or ": ".
const PREFIX_PATTERN = /^([A-Z0-9+]{1,6}(?:-[A-Z0-9+]{1,6})*)(?:\s+-\s*|\s*[|:]\s+)/

function matchPrefixTokens(rawName: string): string[] | null {
  const trimmed = (rawName || "").trim()
  const match = trimmed.match(PREFIX_PATTERN)
  if (!match) return null
  const remainder = trimmed.slice(match[0].length)
  if (!remainder.trim()) return null
  return match[1].split("-")
}

export function parseNamePrefix(rawName: string): { tag: string | null; rest: string } {
  const trimmed = (rawName || "").trim()
  const match = trimmed.match(PREFIX_PATTERN)
  if (!match) return { tag: null, rest: trimmed }

  const remainder = trimmed.slice(match[0].length)
  if (!remainder.trim()) return { tag: null, rest: trimmed }

  const tokens = match[1].split("-")
  const languageToken = tokens.find((token) => Object.prototype.hasOwnProperty.call(LANGUAGE_TOKENS, token))
  if (!languageToken) return { tag: null, rest: trimmed }

  return { tag: languageToken, rest: remainder }
}

// Quality tokens found in the name's prefix, in prefix order; empty when there is no recognized prefix.
export function prefixQualityTokens(rawName: string): string[] {
  const tokens = matchPrefixTokens(rawName)
  if (!tokens) return []
  return tokens.filter((token) => QUALITY_TOKENS.has(token))
}

function capitalizeFirst(value: string): string {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value
}

const languageDisplayNamesByLocale = new Map<string, Intl.DisplayNames>()

function getLanguageDisplayNames(locale: string): Intl.DisplayNames | null {
  const cached = languageDisplayNamesByLocale.get(locale)
  if (cached) return cached
  try {
    const displayNames = new Intl.DisplayNames([locale, "en"], { type: "language" })
    languageDisplayNamesByLocale.set(locale, displayNames)
    return displayNames
  } catch {
    return null
  }
}

export function languageTagLabel(tag: string, locale: string): string {
  const info = LANGUAGE_TOKENS[tag]
  if (info?.label) return info.label
  if (info?.bcp47) {
    const displayName = getLanguageDisplayNames(locale)?.of(info.bcp47)
    if (displayName) return capitalizeFirst(displayName)
  }
  return tag
}

const LOCALE_PREFERRED_TAGS: Record<string, string[]> = {
  en: ["EN"],
  de: ["DE"],
  fr: ["FR", "QC"],
  es: ["ES", "LA"],
  "pt-BR": ["BR", "PT"],
  it: ["IT"],
  ru: ["RU"],
  zh: ["ZH", "CN"],
  ja: ["JP"],
  tr: ["TR"],
  ar: ["AR"],
  ur: ["UR", "PK"],
  nl: ["NL"],
  hi: ["HI", "IN"],
  id: ["ID"],
  pl: ["PL"],
}

export function preferredTagsForLocale(locale: string): string[] {
  const direct = LOCALE_PREFERRED_TAGS[locale]
  if (direct) return direct
  const primarySubtag = (locale || "").split("-")[0].toUpperCase()
  return Object.prototype.hasOwnProperty.call(LANGUAGE_TOKENS, primarySubtag) ? [primarySubtag] : []
}

// Falls through sourcePrefix, preferredTags in order, unprefixed, then the first candidate: crossing language beats dropping the result.
export function pickByTagPreference<T>(
  candidates: T[],
  getTag: (candidate: T) => string | null,
  { sourcePrefix, preferredTags }: { sourcePrefix?: string | null; preferredTags?: string[] }
): T | null {
  if (sourcePrefix) {
    const sameTag = candidates.find((candidate) => getTag(candidate) === sourcePrefix)
    if (sameTag) return sameTag
  }
  for (const preferredTag of preferredTags || []) {
    const match = candidates.find((candidate) => getTag(candidate) === preferredTag)
    if (match) return match
  }
  const untagged = candidates.find((candidate) => getTag(candidate) == null)
  if (untagged) return untagged
  return candidates[0] || null
}

// Ordered tag preference: explicit content-language setting, then the interface locale, then English.
export function effectivePreferredTags(contentLanguage: string, locale: string): string[] {
  const localePreferred = preferredTagsForLocale(locale)
  const ordered = contentLanguage ? [contentLanguage, ...localePreferred, "EN"] : [...localePreferred, "EN"]

  const seen = new Set<string>()
  const deduped: string[] = []
  for (const tag of ordered) {
    if (seen.has(tag)) continue
    seen.add(tag)
    deduped.push(tag)
  }
  return deduped
}
