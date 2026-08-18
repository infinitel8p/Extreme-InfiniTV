// Pure check for whether a provider episode title is generic filler worth replacing with TMDb's.
import { normalize } from "@/scripts/lib/text.ts"
import { parseNamePrefix } from "@/scripts/lib/language-tags.ts"

// Season/episode markers left over once language prefix + series name are stripped.
const GENERIC_REMAINDER_PATTERNS = [
  /^s\d{1,2}\s*[.x-]?\s*e?\d{1,3}$/i,
  /^(episode|ep|folge|e)\s*\d+$/i,
  /^\d{1,3}$/,
  // Bare "1x03" season x episode shorthand (no leading s/e letters).
  /^\d{1,2}[.x-]\d{1,3}$/i,
]

export interface IsGenericEpisodeTitleOptions {
  seriesName?: string | null
  fallbackTitle?: string | null
}

function stripLangPrefix(value: string): string {
  const { tag, rest } = parseNamePrefix(value)
  return tag != null ? rest : value
}

export function isGenericEpisodeTitle(
  rawTitle: string | null | undefined,
  { seriesName, fallbackTitle }: IsGenericEpisodeTitleOptions = {}
): boolean {
  const title = (rawTitle || "").trim()
  if (!title) return true
  if (fallbackTitle && title === fallbackTitle) return true

  const titleWithoutPrefix = stripLangPrefix(title)
  // Prefix-stripped first: it must win the match so a leftover "en " never survives into remainder.
  const titleVariants = [normalize(titleWithoutPrefix), normalize(title)]

  const seriesRaw = (seriesName || "").trim()
  const seriesVariants = [normalize(seriesRaw), normalize(stripLangPrefix(seriesRaw))].filter(Boolean)

  // The series name can carry its own language prefix independently of the
  // episode title's, so try both prefixed and unprefixed forms on each side.
  let remainder = normalize(titleWithoutPrefix)
  for (const seriesVariant of seriesVariants) {
    const titleVariant = titleVariants.find((variant) => variant.includes(seriesVariant))
    if (titleVariant) {
      remainder = titleVariant.replace(seriesVariant, "").replace(/\s+/g, " ").trim()
      break
    }
  }

  if (!remainder) return true
  return GENERIC_REMAINDER_PATTERNS.some((pattern) => pattern.test(remainder))
}
