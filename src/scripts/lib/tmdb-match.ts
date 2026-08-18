// Pure title cleanup + result matching so provider names resolve to the right TMDb id.
import { normalize } from "@/scripts/lib/text.ts"
import { parseNamePrefix, pickByTagPreference } from "@/scripts/lib/language-tags.ts"

const YEAR_MIN = 1900
const YEAR_MAX = 2099

const JUNK_TOKENS = [
  "4k", "uhd", "fhd", "hd", "sd", "1080p", "720p", "480p", "2160p",
  "hevc", "h264", "h265", "x264", "x265", "hdr", "dv", "webrip", "bluray", "brrip", "hdtv",
  "cam", "multi", "multisub", "vostfr", "dubbed", "extended", "remastered", "complete",
  // Jellyfin CleanStrings tokens
  "3d", "sbs", "tab", "hsbs", "htab", "mvc", "hdc", "ultrahd", "ac3", "dts", "aac", "dc",
  "divx", "divx5", "dsr", "dsrip", "dvd", "dvdrip", "dvdscr", "dvdscreener", "screener",
  "dvdivx", "fragment", "hdrip", "hdtvrip", "internal", "limited", "subs", "ntsc", "ogg",
  "ogm", "pal", "pdtv", "proper", "repack", "rerip", "retail", "r5", "bd5", "bd", "svcd",
  "nfofix", "unrated", "ws", "telesync", "telecine", "bdrip", "480i", "576p", "576i",
  "720i", "1080i", "hrhd", "hrhdtv", "hddvd", "blu-ray", "xvid", "xvidvd", "webdl", "web-dl",
]

function escapeRegExpToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const JUNK_TOKEN_PATTERN_SOURCE = `\\b(${JUNK_TOKENS.map(escapeRegExpToken).join("|")}|cd[1-9])\\b`
const QUALITY_TAGS_PATTERN = new RegExp(JUNK_TOKEN_PATTERN_SOURCE, "gi")
const FIRST_JUNK_TOKEN_PATTERN = new RegExp(JUNK_TOKEN_PATTERN_SOURCE, "i")

const LEADING_BRACKET_GROUP = /^\s*\[[^\]]+\]\s*/
const LEADING_ABBREVIATION_PREFIX = /^([A-Z]{2,3})\s*[-|:]\s*/
const LEADING_WORD_PREFIX = /^(english|german|french|spanish|italian|arabic|turkish|multi)\b[\s:|-]*\s*/i

// IPTV providers often prefix titles with a language code ("AL - ", "DE | ").
// Ambiguous with titles like "IT - Chapter Two"; the raw variant still matches exactly.
export function extractLangPrefix(rawName: string): string | null {
  const match = (rawName || "").trim().match(LEADING_ABBREVIATION_PREFIX)
  return match ? match[1] : null
}

// Delimiter-bounded year, rejecting longer digit runs and date-like sequences (Jellyfin rule).
const YEAR_DELIMITER = "[_,.()\\[\\]\\- ]"
const YEAR_PATTERN = new RegExp(
  `(?<=^|${YEAR_DELIMITER})(\\d{4})(?![0-9]+|\\W[0-9]{2}\\W[0-9]{2})(?=${YEAR_DELIMITER}|$)`,
  "g"
)

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function extractYear(input: string): { text: string; year: number | null } {
  const matches = [...input.matchAll(YEAR_PATTERN)]
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index]
    const candidate = Number(match[1])
    if (candidate >= YEAR_MIN && candidate <= YEAR_MAX) {
      const startIndex = match.index ?? 0
      return {
        text: input.slice(0, startIndex) + input.slice(startIndex + match[0].length),
        year: candidate,
      }
    }
  }
  return { text: input, year: null }
}

function stripLeadingBracketGroup(text: string): string {
  return text.replace(LEADING_BRACKET_GROUP, "")
}

function stripNonYearBrackets(text: string): string {
  return text.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ")
}

function stripQualityTags(text: string): string {
  return text.replace(QUALITY_TAGS_PATTERN, " ")
}

function stripLeadingLanguagePrefix(text: string): string {
  return text.replace(LEADING_ABBREVIATION_PREFIX, "").replace(LEADING_WORD_PREFIX, "")
}

function truncateAtFirstJunkToken(text: string): string {
  const match = FIRST_JUNK_TOKEN_PATTERN.exec(text)
  if (!match) return text
  return text.slice(0, match.index)
}

export function cleanProviderTitle(rawName: string): { variants: string[]; year: number | null } {
  const raw = (rawName || "").trim()
  const withoutBracketGroup = stripLeadingBracketGroup(raw)
  const { text: afterYear, year } = extractYear(withoutBracketGroup)
  const afterLanguagePrefix = stripLeadingLanguagePrefix(afterYear)
  const afterTags = stripQualityTags(stripNonYearBrackets(afterYear))

  const cleanedNoPrefix = collapseWhitespace(afterTags)
  const fullyCleaned = collapseWhitespace(stripLeadingLanguagePrefix(afterTags))
  const truncated = collapseWhitespace(truncateAtFirstJunkToken(afterLanguagePrefix))

  const variants = [fullyCleaned, truncated, cleanedNoPrefix, raw].filter(Boolean)
  return { variants: [...new Set(variants)], year }
}

function extractYearFromDate(dateField?: string | null): number | null {
  if (!dateField) return null
  const match = dateField.match(/^(\d{4})/)
  return match ? Number(match[1]) : null
}

export interface TmdbMatchCandidate {
  id: number
  title?: string
  original_title?: string
  name?: string
  original_name?: string
  release_date?: string
  first_air_date?: string
  vote_count?: number
  popularity?: number
}

export interface TmdbMatchResult {
  id: number
  title: string
  year: number | null
}

export function pickTmdbMatch(
  results: TmdbMatchCandidate[] | null | undefined,
  { variants, year, mediaType }: { variants: string[]; year: number | null; mediaType: "movie" | "tv" }
): TmdbMatchResult | null {
  if (!results || !results.length) return null

  const normalizedVariants = variants.map((variant) => normalize(variant)).filter(Boolean)
  if (!normalizedVariants.length) return null

  const passing: Array<{
    result: TmdbMatchCandidate
    title: string
    resultYear: number | null
    isCloseYear: boolean
  }> = []

  for (const result of results) {
    const title =
      mediaType === "movie"
        ? result.title || result.original_title || ""
        : result.name || result.original_name || ""
    const dateField = mediaType === "movie" ? result.release_date : result.first_air_date
    const resultYear = extractYearFromDate(dateField)

    if (!normalizedVariants.includes(normalize(title))) continue

    let isCloseYear = false
    if (year != null) {
      if (resultYear == null) continue
      isCloseYear = Math.abs(resultYear - year) <= 1
      const isOlderTvOriginal = mediaType === "tv" && resultYear < year
      if (!isCloseYear && !isOlderTvOriginal) continue
    }

    passing.push({ result, title, resultYear, isCloseYear })
  }

  if (!passing.length) return null

  if (year == null) {
    if (passing.length !== 1) return null
    const onlyMatch = passing[0]
    return { id: onlyMatch.result.id, title: onlyMatch.title, year: onlyMatch.resultYear }
  }

  // Close-year candidates win; the older-TV allowance is only a fallback pool.
  const closeYearCandidates = passing.filter((candidate) => candidate.isCloseYear)
  const tieBreakPool = closeYearCandidates.length ? closeYearCandidates : passing

  tieBreakPool.sort((a, b) => {
    const voteDelta = (b.result.vote_count || 0) - (a.result.vote_count || 0)
    if (voteDelta !== 0) return voteDelta
    return (b.result.popularity || 0) - (a.result.popularity || 0)
  })
  const best = tieBreakPool[0]
  return { id: best.result.id, title: best.title, year: best.resultYear }
}

export interface TmdbCatalogEntry {
  id: string | number
  name: string
  year?: number | string | null
  logo?: string
}

export interface TmdbRecommendation {
  title?: string
  name?: string
  year?: number | string | null
  release_date?: string
  first_air_date?: string
}

function parseKnownYear(yearField?: number | string | null): number | null {
  if (yearField == null) return null
  if (typeof yearField === "number") return Number.isFinite(yearField) ? yearField : null
  const match = String(yearField).match(/(\d{4})/)
  return match ? Number(match[1]) : null
}

interface IndexedCatalogEntry {
  entry: TmdbCatalogEntry
  tag: string | null
}

function pickCandidateForPrefix(
  candidates: IndexedCatalogEntry[],
  { sourcePrefix, preferredTags }: { sourcePrefix?: string | null; preferredTags?: string[] }
): IndexedCatalogEntry | null {
  return pickByTagPreference(candidates, (candidate) => candidate.tag, { sourcePrefix, preferredTags })
}

function buildCatalogNameIndex(catalogEntries: TmdbCatalogEntry[]): Map<string, IndexedCatalogEntry[]> {
  const index = new Map<string, IndexedCatalogEntry[]>()
  for (const entry of catalogEntries) {
    const { variants } = cleanProviderTitle(entry.name)
    const key = normalize(variants[0] || entry.name)
    if (!key) continue
    const indexed = { entry, tag: parseNamePrefix(entry.name).tag }
    const bucket = index.get(key)
    if (bucket) bucket.push(indexed)
    else index.set(key, [indexed])
  }
  return index
}

export function matchRecommendationsToCatalog(
  recommendations: TmdbRecommendation[] | null | undefined,
  catalogEntries: TmdbCatalogEntry[] | null | undefined,
  {
    mediaType,
    limit = 12,
    sourcePrefix,
    preferredTags,
    groupKeyForEntry,
  }: {
    mediaType: "movie" | "tv"
    limit?: number
    sourcePrefix?: string | null
    preferredTags?: string[]
    groupKeyForEntry?: (entry: TmdbCatalogEntry) => string
  }
): TmdbCatalogEntry[] {
  if (!recommendations?.length || !catalogEntries?.length) return []

  const index = buildCatalogNameIndex(catalogEntries)

  const matched: TmdbCatalogEntry[] = []
  const seenIds = new Set<string | number>()
  const seenGroupKeys = new Set<string>()

  for (const recommendation of recommendations) {
    if (matched.length >= limit) break
    const title = mediaType === "movie" ? recommendation.title || "" : recommendation.name || ""
    if (!title) continue
    const candidates = index.get(normalize(title))
    if (!candidates?.length) continue
    const picked = pickCandidateForPrefix(candidates, { sourcePrefix, preferredTags })
    if (!picked) continue

    const groupKey = groupKeyForEntry?.(picked.entry)
    if (groupKey != null ? seenGroupKeys.has(groupKey) : seenIds.has(picked.entry.id)) continue

    const recommendationYear =
      parseKnownYear(recommendation.year) ??
      extractYearFromDate(mediaType === "movie" ? recommendation.release_date : recommendation.first_air_date)
    const catalogYear = parseKnownYear(picked.entry.year)
    if (recommendationYear != null && catalogYear != null && Math.abs(recommendationYear - catalogYear) > 1) {
      continue
    }

    if (groupKey != null) seenGroupKeys.add(groupKey)
    seenIds.add(picked.entry.id)
    matched.push(picked.entry)
  }

  return matched
}

function titleTextOf(title: TmdbRecommendation): string {
  return title.title || title.name || ""
}

function titleYearOf(title: TmdbRecommendation): number | null {
  return (
    parseKnownYear(title.year) ??
    extractYearFromDate(title.release_date) ??
    extractYearFromDate(title.first_air_date)
  )
}

/**
 * Like matchRecommendationsToCatalog but for a "does this person appear in X"
 * filter: every language version of a title should match, not just one pick.
 * No sourcePrefix, no skip-on-ambiguity - returns every candidate that passes
 * the title + year gate, deduped by id.
 */
export function matchAllTitlesToCatalog(
  titles: TmdbRecommendation[] | null | undefined,
  catalogEntries: TmdbCatalogEntry[] | null | undefined
): TmdbCatalogEntry[] {
  if (!titles?.length || !catalogEntries?.length) return []

  const index = buildCatalogNameIndex(catalogEntries)
  const matched: TmdbCatalogEntry[] = []
  const seenIds = new Set<string | number>()

  for (const title of titles) {
    const titleText = titleTextOf(title)
    if (!titleText) continue
    const candidates = index.get(normalize(titleText))
    if (!candidates?.length) continue
    const titleYear = titleYearOf(title)

    for (const candidate of candidates) {
      if (seenIds.has(candidate.entry.id)) continue
      const catalogYear = parseKnownYear(candidate.entry.year)
      if (titleYear != null && catalogYear != null && Math.abs(titleYear - catalogYear) > 1) continue
      seenIds.add(candidate.entry.id)
      matched.push(candidate.entry)
    }
  }

  return matched
}
