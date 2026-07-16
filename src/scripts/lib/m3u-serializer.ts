// Pure inverse of `m3u-parser.ts`: turns parsed entries back into M3U text.
// No DOM, no fetch, no i18n - callers own where the resulting text goes.

import type { M3UEntry } from "@/scripts/lib/m3u-parser"

export interface M3UHeaderOptions {
  epgUrl?: string | null
  catchup?: string | null
  catchupDays?: number | null
  catchupSource?: string | null
  catchupCorrection?: number | null
}

function escapeAttrValue(value: string): string {
  return value.replace(/"/g, '\\"')
}

function buildHeaderLine(header?: M3UHeaderOptions): string {
  let line = "#EXTM3U"
  if (!header) return line
  if (header.epgUrl != null) line += ` x-tvg-url="${escapeAttrValue(header.epgUrl)}"`
  if (header.catchup != null) line += ` catchup="${escapeAttrValue(header.catchup)}"`
  if (header.catchupDays != null) line += ` catchup-days="${header.catchupDays}"`
  if (header.catchupSource != null) line += ` catchup-source="${escapeAttrValue(header.catchupSource)}"`
  if (header.catchupCorrection != null) line += ` catchup-correction="${header.catchupCorrection}"`
  return line
}

function buildExtinfAttrs(entry: M3UEntry): string {
  const attrs: string[] = []
  if (entry.tvgId != null) attrs.push(`tvg-id="${escapeAttrValue(entry.tvgId)}"`)
  if (entry.tvgName != null) attrs.push(`tvg-name="${escapeAttrValue(entry.tvgName)}"`)
  if (entry.logo != null) attrs.push(`tvg-logo="${escapeAttrValue(entry.logo)}"`)
  if (entry.chno != null) attrs.push(`tvg-chno="${entry.chno}"`)
  if (entry.category != null) attrs.push(`group-title="${escapeAttrValue(entry.category)}"`)
  if (entry.catchup != null) attrs.push(`catchup="${escapeAttrValue(entry.catchup)}"`)
  if (entry.catchupDays != null) attrs.push(`catchup-days="${entry.catchupDays}"`)
  if (entry.catchupSource != null) attrs.push(`catchup-source="${escapeAttrValue(entry.catchupSource)}"`)
  if (entry.catchupCorrection != null) attrs.push(`catchup-correction="${entry.catchupCorrection}"`)
  if (entry.tvgType != null) attrs.push(`tvg-type="${escapeAttrValue(entry.tvgType)}"`)
  if (entry.isRadio) attrs.push(`radio="true"`)
  return attrs.length ? " " + attrs.join(" ") : ""
}

function serializeEntry(entry: M3UEntry): string[] {
  const lines = [`#EXTINF:-1${buildExtinfAttrs(entry)},${entry.name}`]
  if (entry.userAgent != null) lines.push(`#EXTVLCOPT:http-user-agent=${entry.userAgent}`)
  if (entry.referer != null) lines.push(`#EXTVLCOPT:http-referrer=${entry.referer}`)
  if (entry.manifestType != null) lines.push(`#KODIPROP:inputstream.adaptive.manifest_type=${entry.manifestType}`)
  if (entry.drmScheme != null) lines.push(`#KODIPROP:inputstream.adaptive.license_type=${entry.drmScheme}`)
  if (entry.licenseKey != null) lines.push(`#KODIPROP:inputstream.adaptive.license_key=${entry.licenseKey}`)
  lines.push(entry.url)
  return lines
}

export function serializeM3U(entries: M3UEntry[], header?: M3UHeaderOptions): string {
  const lines = [buildHeaderLine(header)]
  for (const entry of entries) {
    lines.push(...serializeEntry(entry))
  }
  return lines.join("\n") + "\n"
}
