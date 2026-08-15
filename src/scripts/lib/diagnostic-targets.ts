// Cheap, prefix-only probe-target pickers for the connection diagnostic.

const PROBE_PREFIX_CHARS = 8192

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Read a `key=value` attribute off a single line. Case-insensitive key; single/double-quoted or bare value. */
function readHeaderAttr(source: string, key: string): string {
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
    const quoteChar = source[cursor]
    if (quoteChar === '"' || quoteChar === "'") {
      cursor++
      let value = ""
      while (cursor < source.length) {
        const charAt = source[cursor]
        if (charAt === "\\" && (source[cursor + 1] === quoteChar || source[cursor + 1] === "\\")) {
          value += source[cursor + 1]
          cursor += 2
          continue
        }
        if (charAt === quoteChar) return value
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

/** First `x-tvg-url` / `tvg-url` / `url-tvg` value off the `#EXTM3U` header line, matching m3u-parser.ts precedence. */
export function extractM3UHeaderEpgUrl(text: string): string | null {
  const prefix = stripBom(text).slice(0, PROBE_PREFIX_CHARS)
  const firstLine = prefix.split(/\r?\n/).find((line) => line.trim().length > 0)
  if (!firstLine || !firstLine.trim().toUpperCase().startsWith("#EXTM3U")) return null
  const raw =
    readHeaderAttr(firstLine, "x-tvg-url") ||
    readHeaderAttr(firstLine, "tvg-url") ||
    readHeaderAttr(firstLine, "url-tvg")
  if (!raw) return null
  // Split only on commas followed by a scheme (or protocol-relative //) so query-string commas survive.
  const first = raw.split(/\s*,+\s*(?=(?:https?:)?\/\/)/i)[0]?.trim() ?? ""
  return /^(?:https?:)?\/\//i.test(first) ? first : null
}

/** First non-comment, non-blank line of an M3U, trimmed. Scheme not validated (relative URLs exist in the wild). */
export function firstStreamUrlFromM3U(text: string): string | null {
  const prefix = stripBom(text).slice(0, PROBE_PREFIX_CHARS)
  for (const raw of prefix.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    return line
  }
  return null
}

/** True when the candidate is an absolute http(s) URL, safe to probe directly (a relative path would resolve against the app's own origin). */
export function isAbsoluteHttpUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value)
}

function looksNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string") return /^-?\d+(\.\d+)?$/.test(value.trim())
  return false
}

/** First usable `stream_id` (as a string) from an already-parsed `get_live_streams` response. */
export function pickSampleLiveStreamId(payload: unknown): string | null {
  try {
    let list: unknown
    if (Array.isArray(payload)) {
      list = payload
    } else if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>
      if (Array.isArray(record.streams)) list = record.streams
      else if (Array.isArray(record.results)) list = record.results
    }
    if (!Array.isArray(list)) return null
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const streamId = (item as Record<string, unknown>).stream_id
      if (streamId == null) continue
      if (typeof streamId === "string" && streamId.trim() === "") continue
      if (!looksNumeric(streamId)) continue
      return String(streamId).trim()
    }
    return null
  } catch {
    return null
  }
}
