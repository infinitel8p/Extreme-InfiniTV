// M3U / M3U8 playlist parser. Single source of truth for both Live TV
// (`scripts/stream/stream.ts`) and the catalog warmup (`scripts/lib/catalog.js`).
//
// Parses what real-world IPTV providers ship: standard EXTINF lines in either
// attribute order, EXTGRP fallback for group, EXTVLCOPT per-channel UA / Referer
// hints, escaped quotes inside values, BOM-prefixed UTF-8, CRLF endings, and
// HLS sub-playlist tags interleaved without crashing.
//
// Pure: no DOM, no fetch, no i18n. Returns null for unset category/headers so
// callers apply their own fallbacks (locale-aware "Uncategorized", etc.).
//
// Note on header application: Referer is captured but cannot be applied at
// stream-playback time from within a WebView (browsers control that header).
// User-Agent CAN be applied via the Android WebView bridge (see
// `scripts/lib/stream-headers.ts`); on desktop Tauri (wry) and the web build,
// runtime UA changes are not reachable, so a per-channel UA is a best-effort
// hint there. See the wry tracker for upstream support.

export interface M3UEntry {
  name: string
  url: string
  logo: string | null
  category: string | null
  tvgId: string | null
  tvgName: string | null
  chno: number | null
  catchup: string | null
  catchupDays: number | null
  userAgent: string | null
  referer: string | null
}

export interface M3UParseResult {
  entries: M3UEntry[]
  epgUrl: string
}

const HLS_PREFIXES = ["#EXT-X-", "#EXTM3U:VERSION", "#EXT-X-VERSION"]

/**
 * Read an attribute from a `key=value` style line. Quoted values support
 * backslash-escaped quotes (`\"`). Unquoted values run until whitespace or
 * comma. Case-insensitive on the key. Returns "" when not present.
 */
function readAttr(source: string, key: string): string {
  const lower = source.toLowerCase()
  const needle = key.toLowerCase()
  let idx = 0
  while (idx < lower.length) {
    const found = lower.indexOf(needle, idx)
    if (found < 0) return ""
    const before = found === 0 ? "" : source[found - 1]
    if (before && /[A-Za-z0-9_-]/.test(before)) {
      idx = found + needle.length
      continue
    }
    const eqIdx = found + needle.length
    if (source[eqIdx] !== "=") {
      idx = eqIdx
      continue
    }
    let cursor = eqIdx + 1
    if (source[cursor] === '"') {
      cursor++
      let value = ""
      while (cursor < source.length) {
        const charAt = source[cursor]
        if (charAt === "\\" && source[cursor + 1] === '"') {
          value += '"'
          cursor += 2
          continue
        }
        if (charAt === '"') return value
        value += charAt
        cursor++
      }
      return value
    }
    let end = cursor
    while (end < source.length && source[end] !== " " && source[end] !== "\t" && source[end] !== ",") {
      end++
    }
    return source.slice(cursor, end)
  }
  return ""
}

/**
 * Strip the attribute pairs out of an EXTINF tail so the leftover is the
 * channel display name. Handles both `key="quoted, with comma"` and bare
 * `key=value` forms. Defensive against partially-quoted attrs.
 */
function stripAttrs(tail: string): string {
  let out = tail
  out = out.replace(/\b[A-Za-z][\w-]*="(?:[^"\\]|\\.)*"/g, "")
  out = out.replace(/\b[A-Za-z][\w-]*=[^\s,]+/g, "")
  return out.replace(/\s{2,}/g, " ").trim()
}

function isHlsTag(line: string): boolean {
  for (const prefix of HLS_PREFIXES) {
    if (line.startsWith(prefix)) return true
  }
  return false
}

function lastCommaOutsideQuotes(text: string): number {
  let inQuote = false
  let last = -1
  for (let idx = 0; idx < text.length; idx++) {
    const charAt = text[idx]
    if (charAt === '"' && text[idx - 1] !== "\\") inQuote = !inQuote
    else if (charAt === "," && !inQuote) last = idx
  }
  return last
}

/**
 * Parse a `#EXTINF:...` directive into the structured M3UEntry shell. URL
 * is filled in by the caller from the next non-comment line. Detects the
 * alt-order `EXTINF:0,attrs,Name` form by checking whether the comma-tail
 * starts with a `key=` pattern; otherwise treats the standard `attrs,Name`.
 */
function parseExtinf(line: string): Omit<M3UEntry, "url"> {
  const directive = line.replace(/^#EXTINF\s*:?/i, "")
  const commaIdx = directive.indexOf(",")
  let attrs = ""
  let name = ""
  if (commaIdx < 0) {
    name = directive.trim()
  } else {
    const head = directive.slice(0, commaIdx)
    const tail = directive.slice(commaIdx + 1)
    const tailStartsWithAttr = /^\s*[A-Za-z][\w-]*\s*=/.test(tail)
    if (tailStartsWithAttr) {
      const splitIdx = lastCommaOutsideQuotes(tail)
      if (splitIdx >= 0) {
        attrs = head + " " + tail.slice(0, splitIdx)
        name = tail.slice(splitIdx + 1).trim()
      } else {
        attrs = head + " " + tail
        name = ""
      }
    } else {
      attrs = head
      name = stripAttrs(tail)
    }
  }
  const tvgName = readAttr(attrs, "tvg-name") || null
  const finalName = name || tvgName || ""
  const chnoRaw =
    readAttr(attrs, "tvg-chno") || readAttr(attrs, "channel-number") || ""
  const chno = chnoRaw ? Number(chnoRaw) : NaN
  const catchupDaysRaw = readAttr(attrs, "catchup-days") || ""
  const catchupDays = catchupDaysRaw ? Number(catchupDaysRaw) : NaN
  return {
    name: finalName,
    logo: readAttr(attrs, "tvg-logo") || null,
    category: readAttr(attrs, "group-title") || null,
    tvgId:
      readAttr(attrs, "tvg-id") || readAttr(attrs, "channel-id") || null,
    tvgName,
    chno: Number.isFinite(chno) ? chno : null,
    catchup: readAttr(attrs, "catchup") || null,
    catchupDays: Number.isFinite(catchupDays) ? catchupDays : null,
    userAgent: null,
    referer: null,
  }
}

export function parseM3U(text: string): M3UParseResult {
  let payload = text
  if (payload.charCodeAt(0) === 0xfeff) payload = payload.slice(1)

  const entries: M3UEntry[] = []
  let epgUrl = ""
  let pending: Omit<M3UEntry, "url"> | null = null
  let extgrpFallback: string | null = null

  for (const raw of payload.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith("#EXTM3U")) {
      epgUrl =
        readAttr(line, "x-tvg-url") ||
        readAttr(line, "tvg-url") ||
        readAttr(line, "url-tvg") ||
        epgUrl
      continue
    }

    if (line.startsWith("#EXTINF")) {
      pending = parseExtinf(line)
      continue
    }

    if (line.startsWith("#EXTGRP:")) {
      extgrpFallback = line.slice("#EXTGRP:".length).trim() || null
      continue
    }

    if (line.startsWith("#EXTVLCOPT:")) {
      if (!pending) continue
      const tail = line.slice("#EXTVLCOPT:".length)
      const eqIdx = tail.indexOf("=")
      if (eqIdx <= 0) continue
      const key = tail.slice(0, eqIdx).trim().toLowerCase()
      const value = tail.slice(eqIdx + 1).trim()
      if (!value) continue
      if (key === "http-user-agent") pending.userAgent = value
      else if (key === "http-referrer" || key === "http-referer") pending.referer = value
      continue
    }

    if (line.startsWith("#KODIPROP:")) continue
    if (isHlsTag(line)) continue
    if (line.startsWith("#")) continue

    if (!pending) continue
    const category = pending.category ?? extgrpFallback
    entries.push({
      ...pending,
      category,
      url: line,
    })
    pending = null
    extgrpFallback = null
  }

  return { entries, epgUrl }
}
