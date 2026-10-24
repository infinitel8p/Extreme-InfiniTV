export type SubtitleSearchContext = {
  kind: "movie" | "episode"
  title: string
  year?: number | null
  season?: number | null
  episode?: number | null
  tmdbId?: number | null
  parentTmdbId?: number | null
  imdbId?: number | null
  parentImdbId?: number | null
}

export type HearingImpairedMode = "include" | "exclude" | "only"

export type OpenSubtitlesResult = {
  id: string
  fileId: number
  language: string
  release: string
  hearingImpaired: boolean
  fromTrusted: boolean
  machineTranslated: boolean
  aiTranslated: boolean
  downloadCount: number
  fps: number | null
  featureTitle: string | null
  featureYear: number | null
}

const LABEL_RELEASE_MAX = 60

function positiveInt(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function collapseTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase()
}

/** Ids are exact, so a query/year is only sent when no id is available. */
export function buildSubtitleSearchParams(
  context: SubtitleSearchContext,
  languages: string[],
  options: { page?: number; hearingImpaired?: HearingImpairedMode } = {}
): Record<string, string> {
  const params: Record<string, string> = { type: context.kind }
  const season = positiveInt(context.season)
  const episode = positiveInt(context.episode)
  const tmdbId = positiveInt(context.tmdbId)
  const parentTmdbId = positiveInt(context.parentTmdbId)
  const imdbId = positiveInt(context.imdbId)
  const parentImdbId = positiveInt(context.parentImdbId)

  if (context.kind === "episode") {
    if (parentTmdbId || parentImdbId) {
      if (parentTmdbId) params.parent_tmdb_id = String(parentTmdbId)
      else params.parent_imdb_id = String(parentImdbId)
      if (season) params.season_number = String(season)
      if (episode) params.episode_number = String(episode)
    } else if (tmdbId) {
      params.tmdb_id = String(tmdbId)
    } else if (imdbId) {
      params.imdb_id = String(imdbId)
    } else {
      params.query = collapseTitle(context.title)
      if (season) params.season_number = String(season)
      if (episode) params.episode_number = String(episode)
    }
  } else if (tmdbId) {
    params.tmdb_id = String(tmdbId)
  } else if (imdbId) {
    params.imdb_id = String(imdbId)
  } else {
    params.query = collapseTitle(context.title)
    const year = positiveInt(context.year)
    if (year) params.year = String(year)
  }

  const languageList = Array.from(
    new Set(languages.map((language) => language.trim().toLowerCase()).filter(Boolean))
  ).sort()
  if (languageList.length) params.languages = languageList.join(",")
  if (options.page && options.page > 1) params.page = String(Math.floor(options.page))
  if (options.hearingImpaired && options.hearingImpaired !== "include") {
    params.hearing_impaired = options.hearingImpaired
  }
  return params
}

export function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const value = encodeURIComponent(String(params[key]).toLowerCase()).replace(/%20/g, "+")
      return `${key}=${value}`
    })
    .join("&")
}

export function toOpenSubtitlesLanguage(localeOrLang: string): string {
  const lowered = String(localeOrLang || "").trim().toLowerCase().replace(/_/g, "-")
  if (!lowered) return ""
  if (lowered === "pt-br") return "pt-br"
  if (lowered === "pt-pt") return "pt-pt"
  if (lowered === "zh" || lowered === "zh-cn" || lowered === "zh-hans") return "zh-cn"
  if (lowered === "zh-tw" || lowered === "zh-hant") return "zh-tw"
  return lowered.split("-")[0]
}

export function dedupeByFile(results: OpenSubtitlesResult[]): OpenSubtitlesResult[] {
  const seen = new Set<number>()
  const unique: OpenSubtitlesResult[] = []
  for (const result of results) {
    if (seen.has(result.fileId)) continue
    seen.add(result.fileId)
    unique.push(result)
  }
  return unique
}

export function rankSubtitleResults(
  results: OpenSubtitlesResult[],
  preferred: { defaultLang: string; backupLang?: string | null }
): OpenSubtitlesResult[] {
  const defaultLang = toOpenSubtitlesLanguage(preferred.defaultLang)
  const backupLang = toOpenSubtitlesLanguage(preferred.backupLang || "")
  const tierOf = (result: OpenSubtitlesResult): number => {
    const language = result.language.toLowerCase()
    if (language === defaultLang) return 0
    if (backupLang && language === backupLang) return 1
    return 2
  }
  return dedupeByFile(results)
    .filter((result) => !result.machineTranslated)
    .map((result, index) => ({ result, index }))
    .sort((left, right) => {
      const tierDiff = tierOf(left.result) - tierOf(right.result)
      if (tierDiff) return tierDiff
      if (left.result.fromTrusted !== right.result.fromTrusted) {
        return left.result.fromTrusted ? -1 : 1
      }
      if (left.result.hearingImpaired !== right.result.hearingImpaired) {
        return left.result.hearingImpaired ? 1 : -1
      }
      const downloadDiff = right.result.downloadCount - left.result.downloadCount
      return downloadDiff || left.index - right.index
    })
    .map((entry) => entry.result)
}

export function subtitleResultLabel(
  result: OpenSubtitlesResult,
  translateLanguageName?: (code: string) => string
): string {
  const language = translateLanguageName
    ? translateLanguageName(result.language)
    : result.language.toUpperCase()
  const release =
    result.release.length > LABEL_RELEASE_MAX
      ? `${result.release.slice(0, LABEL_RELEASE_MAX - 3)}...`
      : result.release
  const base = release ? `${language} · ${release}` : language
  return result.hearingImpaired ? `${base} (HI)` : base
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

export function normalizeSearchResponse(json: unknown): {
  results: OpenSubtitlesResult[]
  page: number
  totalPages: number
} {
  const root = asRecord(json)
  const page = positiveInt(root?.page) ?? 1
  const totalPages = positiveInt(root?.total_pages) ?? 1
  const data = Array.isArray(root?.data) ? root.data : []
  const results: OpenSubtitlesResult[] = []
  for (const entry of data) {
    const attributes = asRecord(asRecord(entry)?.attributes)
    if (!attributes) continue
    const files = Array.isArray(attributes.files) ? attributes.files : []
    const fileId = positiveInt(asRecord(files[0])?.file_id)
    const language = stringOrNull(attributes.language)
    if (!fileId || !language) continue
    const details = asRecord(attributes.feature_details)
    const fps = Number(attributes.fps)
    results.push({
      id: String(asRecord(entry)?.id ?? attributes.subtitle_id ?? fileId),
      fileId,
      language: language.toLowerCase(),
      release: typeof attributes.release === "string" ? attributes.release : "",
      hearingImpaired: attributes.hearing_impaired === true,
      fromTrusted: attributes.from_trusted === true,
      machineTranslated: attributes.machine_translated === true,
      aiTranslated: attributes.ai_translated === true,
      downloadCount: Number(attributes.download_count) || 0,
      fps: Number.isFinite(fps) && fps > 0 ? fps : null,
      featureTitle: stringOrNull(details?.title) ?? stringOrNull(details?.movie_name),
      featureYear: positiveInt(details?.year),
    })
  }
  return { results, page, totalPages }
}
