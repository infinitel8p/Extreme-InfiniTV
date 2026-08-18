// Pure inverse of `m3u-parser.ts`: turns parsed entries back into M3U text.

import type { M3UEntry } from "@/scripts/lib/m3u-parser"

export interface M3UHeaderOptions {
  epgUrl?: string | null
  catchup?: string | null
  catchupDays?: number | null
  catchupSource?: string | null
  catchupCorrection?: number | null
  tvgShift?: number | null
}

/** Drop embedded CR/LF and other control chars so a field value can never fabricate a new line. */
function stripControlChars(value: string): string {
  return value.replace(/[\x00-\x1f]/g, "")
}

function escapeAttrValue(value: string): string {
  return stripControlChars(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function buildHeaderLine(header?: M3UHeaderOptions): string {
  let line = "#EXTM3U"
  if (!header) return line
  if (header.epgUrl != null) line += ` x-tvg-url="${escapeAttrValue(header.epgUrl)}"`
  if (header.catchup != null) line += ` catchup="${escapeAttrValue(header.catchup)}"`
  if (header.catchupDays != null) line += ` catchup-days="${header.catchupDays}"`
  if (header.catchupSource != null) line += ` catchup-source="${escapeAttrValue(header.catchupSource)}"`
  if (header.catchupCorrection != null) line += ` catchup-correction="${header.catchupCorrection}"`
  if (header.tvgShift != null) line += ` tvg-shift="${header.tvgShift}"`
  return line
}

/** group-title value for an entry: joined multi-group when `categories` is set, else the single `category`. */
function groupTitleValue(entry: M3UEntry): string | null {
  return Array.isArray(entry.categories) && entry.categories.length
    ? entry.categories.join(";")
    : entry.category
}

function buildExtinfAttrs(entry: M3UEntry): string {
  const attrs: string[] = []
  if (entry.tvgId != null) attrs.push(`tvg-id="${escapeAttrValue(entry.tvgId)}"`)
  if (entry.tvgName != null) attrs.push(`tvg-name="${escapeAttrValue(entry.tvgName)}"`)
  if (entry.logo != null) attrs.push(`tvg-logo="${escapeAttrValue(entry.logo)}"`)
  if (entry.chno != null) attrs.push(`tvg-chno="${entry.chno}"`)
  const groupTitle = groupTitleValue(entry)
  if (groupTitle != null) attrs.push(`group-title="${escapeAttrValue(groupTitle)}"`)
  if (entry.catchup != null) attrs.push(`catchup="${escapeAttrValue(entry.catchup)}"`)
  if (entry.catchupDays != null) attrs.push(`catchup-days="${entry.catchupDays}"`)
  if (entry.catchupSource != null) attrs.push(`catchup-source="${escapeAttrValue(entry.catchupSource)}"`)
  if (entry.catchupCorrection != null) attrs.push(`catchup-correction="${entry.catchupCorrection}"`)
  if (entry.tvgShift != null) attrs.push(`tvg-shift="${entry.tvgShift}"`)
  if (entry.tvgType != null) attrs.push(`tvg-type="${escapeAttrValue(entry.tvgType)}"`)
  if (entry.isRadio) attrs.push(`radio="true"`)
  return attrs.length ? " " + attrs.join(" ") : ""
}

function serializeEntry(entry: M3UEntry): string[] {
  const lines = [`#EXTINF:-1${buildExtinfAttrs(entry)},${stripControlChars(entry.name)}`]
  if (entry.userAgent != null) lines.push(`#EXTVLCOPT:http-user-agent=${stripControlChars(entry.userAgent)}`)
  if (entry.referer != null) lines.push(`#EXTVLCOPT:http-referrer=${stripControlChars(entry.referer)}`)
  if (entry.manifestType != null) lines.push(`#KODIPROP:inputstream.adaptive.manifest_type=${stripControlChars(entry.manifestType)}`)
  if (entry.drmScheme != null) lines.push(`#KODIPROP:inputstream.adaptive.license_type=${stripControlChars(entry.drmScheme)}`)
  if (entry.licenseKey != null) lines.push(`#KODIPROP:inputstream.adaptive.license_key=${stripControlChars(entry.licenseKey)}`)
  lines.push(stripControlChars(entry.url))
  return lines
}

export function serializeM3U(entries: M3UEntry[], header?: M3UHeaderOptions): string {
  const lines = [buildHeaderLine(header)]
  for (const entry of entries) {
    lines.push(...serializeEntry(entry))
  }
  return lines.join("\n") + "\n"
}
