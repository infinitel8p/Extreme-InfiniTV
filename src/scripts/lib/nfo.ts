// Kodi-compatible NFO sidecar XML builders

export type MovieNfoMeta = {
  type: "movie"
  title: string
  year?: string | number
  premiered?: string
  plot?: string
  genre?: string
  rating?: string | number
  runtimeMinutes?: number
  poster?: string
}

export type EpisodeNfoMeta = {
  type: "episode"
  showTitle: string
  title?: string
  season?: number | null
  episode?: number | null
  aired?: string
  plot?: string
  genre?: string
  rating?: string | number
  runtimeMinutes?: number
  poster?: string
}

export type NfoMeta = MovieNfoMeta | EpisodeNfoMeta

export function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function pushTag(lines: string[], tag: string, value: unknown): void {
  const text = value == null ? "" : String(value).trim()
  if (!text) return
  lines.push(`  <${tag}>${escapeXml(text)}</${tag}>`)
}

function extractYear(value: unknown): string | undefined {
  if (value == null || value === "") return undefined
  const match = String(value).match(/\b(19\d{2}|20\d{2})\b/)
  return match ? match[1] : undefined
}

function extractFullDate(value: unknown): string | undefined {
  if (value == null) return undefined
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : undefined
}

function splitGenres(value: unknown): string[] {
  if (!value) return []
  return String(value)
    .split(/[,/;|]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function formatRating(value: unknown): string | undefined {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return undefined
  const fixed = num.toFixed(1)
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
}

function isEmittableIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function wrapDocument(root: string, innerLines: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${root}>\n${innerLines.join("\n")}\n</${root}>\n`
}

function buildMovieNfo(meta: MovieNfoMeta): string {
  const lines: string[] = []
  pushTag(lines, "title", meta.title)
  const year = extractYear(meta.year)
  if (year) pushTag(lines, "year", year)
  const premiered = meta.premiered || extractFullDate(meta.year)
  pushTag(lines, "premiered", premiered)
  pushTag(lines, "plot", meta.plot)
  for (const genre of splitGenres(meta.genre)) pushTag(lines, "genre", genre)
  const rating = formatRating(meta.rating)
  pushTag(lines, "rating", rating)
  if (meta.runtimeMinutes && meta.runtimeMinutes > 0) {
    pushTag(lines, "runtime", String(Math.round(meta.runtimeMinutes)))
  }
  if (meta.poster) lines.push(`  <thumb aspect="poster">${escapeXml(meta.poster)}</thumb>`)
  return wrapDocument("movie", lines)
}

function buildEpisodeNfo(meta: EpisodeNfoMeta): string {
  const lines: string[] = []
  pushTag(lines, "title", meta.title)
  pushTag(lines, "showtitle", meta.showTitle)
  if (isEmittableIndex(meta.season)) lines.push(`  <season>${meta.season}</season>`)
  if (isEmittableIndex(meta.episode)) lines.push(`  <episode>${meta.episode}</episode>`)
  pushTag(lines, "aired", meta.aired)
  pushTag(lines, "plot", meta.plot)
  for (const genre of splitGenres(meta.genre)) pushTag(lines, "genre", genre)
  const rating = formatRating(meta.rating)
  pushTag(lines, "rating", rating)
  if (meta.runtimeMinutes && meta.runtimeMinutes > 0) {
    pushTag(lines, "runtime", String(Math.round(meta.runtimeMinutes)))
  }
  if (meta.poster) lines.push(`  <thumb>${escapeXml(meta.poster)}</thumb>`)
  return wrapDocument("episodedetails", lines)
}

export function buildNfo(meta: NfoMeta): string {
  return meta.type === "movie" ? buildMovieNfo(meta) : buildEpisodeNfo(meta)
}
