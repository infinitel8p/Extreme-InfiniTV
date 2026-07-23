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
  catchupSource: string | null
  catchupCorrection: number | null
  userAgent: string | null
  referer: string | null
  tvgType: string | null
  isRadio: boolean
  // From `#KODIPROP:inputstream.adaptive.*`. licenseKey is raw `KID:KEY`.
  manifestType: string | null
  drmScheme: string | null
  licenseKey: string | null
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
        if (charAt === "\\" && (source[cursor + 1] === '"' || source[cursor + 1] === "\\")) {
          value += source[cursor + 1]
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

const HLS_MANIFEST_ONLY_PREFIXES = [
  "#EXT-X-STREAM-INF",
  "#EXT-X-TARGETDURATION",
  "#EXT-X-MEDIA-SEQUENCE",
]

/** These markers only occur in real HLS stream manifests, never in a channel-list M3U. */
export function isHlsStreamManifest(text: string): boolean {
  let payload = text
  if (payload.charCodeAt(0) === 0xfeff) payload = payload.slice(1)
  for (const raw of payload.split(/\r?\n/)) {
    const line = raw.trim().toUpperCase()
    for (const prefix of HLS_MANIFEST_ONLY_PREFIXES) {
      if (line.startsWith(prefix)) return true
    }
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

function firstCommaOutsideQuotes(text: string): number {
  let inQuote = false
  for (let idx = 0; idx < text.length; idx++) {
    const charAt = text[idx]
    if (charAt === '"' && text[idx - 1] !== "\\") inQuote = !inQuote
    else if (charAt === "," && !inQuote) return idx
  }
  return -1
}

/** Parse a decimal hour string (e.g. `catchup-correction`) into a number, or null when unset/non-finite. No clamping. */
function readHoursAttr(source: string, key: string): number | null {
  const raw = readAttr(source, key)
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * SIPTV legacy days-in-past hint: `timeshift="N"`, falling back to `tvg-rec="N"`
 * only when `timeshift` is absent or non-positive. Either becomes a `catchup="shift"`
 * default when the entry/header has no explicit catchup mode.
 */
function readSiptvDays(source: string): number {
  const timeshift = Number(readAttr(source, "timeshift"))
  if (Number.isFinite(timeshift) && timeshift > 0) return timeshift
  const tvgRec = Number(readAttr(source, "tvg-rec"))
  return Number.isFinite(tvgRec) && tvgRec > 0 ? tvgRec : 0
}

/**
 * Parse a `#EXTINF:...` directive into the structured M3UEntry shell. URL
 * is filled in by the caller from the next non-comment line. Detects the
 * alt-order `EXTINF:0,attrs,Name` form by checking whether the comma-tail
 * starts with a `key=` pattern; otherwise treats the standard `attrs,Name`.
 */
function parseExtinf(line: string): Omit<M3UEntry, "url"> & { siptvDays: number } {
  const directive = line.replace(/^#EXTINF\s*:?/i, "")
  // Quote-aware so a quoted attr value containing a comma (e.g. group-title="News, Sports")
  // isn't mistaken for the attrs/name separator; falls back to a naive split on malformed quotes.
  const quoteAwareCommaIdx = firstCommaOutsideQuotes(directive)
  const commaIdx = quoteAwareCommaIdx >= 0 ? quoteAwareCommaIdx : directive.indexOf(",")
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
  const tvgType = readAttr(attrs, "tvg-type") || null
  const radioAttr = readAttr(attrs, "radio") || ""
  const isRadio =
    (tvgType ? tvgType.trim().toLowerCase() === "radio" : false) ||
    radioAttr.trim().toLowerCase() === "true"
  return {
    name: finalName,
    logo: readAttr(attrs, "tvg-logo") || null,
    category: readAttr(attrs, "group-title") || null,
    tvgId:
      readAttr(attrs, "tvg-id") || readAttr(attrs, "channel-id") || null,
    tvgName,
    chno: Number.isFinite(chno) ? chno : null,
    catchup: readAttr(attrs, "catchup") || readAttr(attrs, "catchup-type") || null,
    catchupDays: Number.isFinite(catchupDays) ? catchupDays : null,
    catchupSource: readAttr(attrs, "catchup-source") || null,
    catchupCorrection: readHoursAttr(attrs, "catchup-correction"),
    siptvDays: readSiptvDays(attrs),
    userAgent: null,
    referer: null,
    tvgType,
    isRadio,
    manifestType: null,
    drmScheme: null,
    licenseKey: null,
  }
}

function nameFromBareUrl(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function bareUrlPending(url: string): Omit<M3UEntry, "url"> & { siptvDays: number } {
  return {
    name: nameFromBareUrl(url),
    logo: null,
    category: null,
    tvgId: null,
    tvgName: null,
    chno: null,
    catchup: null,
    catchupDays: null,
    catchupSource: null,
    catchupCorrection: null,
    siptvDays: 0,
    userAgent: null,
    referer: null,
    tvgType: null,
    isRadio: false,
    manifestType: null,
    drmScheme: null,
    licenseKey: null,
  }
}

export function parseM3U(text: string): M3UParseResult {
  let payload = text
  if (payload.charCodeAt(0) === 0xfeff) payload = payload.slice(1)

  const entries: M3UEntry[] = []
  let epgUrl = ""
  let pending: (Omit<M3UEntry, "url"> & { siptvDays: number }) | null = null
  let extgrpFallback: string | null = null
  // pvr.iptvsimple convention: #EXTM3U can carry catchup defaults for every
  // channel that doesn't set its own.
  let headerCatchup: string | null = null
  let headerCatchupDays: number | null = null
  let headerCatchupSource: string | null = null
  let headerCatchupCorrection: number | null = null
  let headerSiptvDays = 0

  for (const raw of payload.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith("#EXTM3U")) {
      epgUrl =
        readAttr(line, "x-tvg-url") ||
        readAttr(line, "tvg-url") ||
        readAttr(line, "url-tvg") ||
        epgUrl
      headerCatchup = readAttr(line, "catchup") || readAttr(line, "catchup-type") || headerCatchup
      const headerCatchupDaysRaw = readAttr(line, "catchup-days")
      if (headerCatchupDaysRaw) {
        const parsedDays = Number(headerCatchupDaysRaw)
        if (Number.isFinite(parsedDays)) headerCatchupDays = parsedDays
      }
      headerCatchupSource = readAttr(line, "catchup-source") || headerCatchupSource
      headerCatchupCorrection = readHoursAttr(line, "catchup-correction") ?? headerCatchupCorrection
      headerSiptvDays = readSiptvDays(line) || headerSiptvDays
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

    if (line.startsWith("#KODIPROP:")) {
      if (!pending) continue
      const tail = line.slice("#KODIPROP:".length)
      const eqIdx = tail.indexOf("=")
      if (eqIdx <= 0) continue
      const key = tail.slice(0, eqIdx).trim().toLowerCase()
      const value = tail.slice(eqIdx + 1).trim()
      if (!value) continue
      if (key === "inputstream.adaptive.manifest_type") pending.manifestType = value
      else if (key === "inputstream.adaptive.license_type") pending.drmScheme = value
      else if (key === "inputstream.adaptive.license_key") pending.licenseKey = value
      continue
    }
    if (isHlsTag(line)) continue
    if (line.startsWith("#")) continue

    // A bare http(s) URL with no preceding #EXTINF is still a valid M3U entry
    // (common for radio pointer .m3u files); synthesize a minimal channel.
    if (!pending) {
      if (/^https?:\/\//i.test(line)) pending = bareUrlPending(line)
      else continue
    }
    const category = pending.category ?? extgrpFallback
    const { siptvDays, ...pendingEntry } = pending
    let catchup = pendingEntry.catchup ?? headerCatchup
    let catchupDays = pendingEntry.catchupDays ?? headerCatchupDays
    const effectiveSiptvDays = siptvDays || headerSiptvDays
    if (!catchup && effectiveSiptvDays > 0) {
      catchup = "shift"
      if (catchupDays == null) catchupDays = effectiveSiptvDays
    }
    entries.push({
      ...pendingEntry,
      category,
      catchup,
      catchupDays,
      catchupSource: pendingEntry.catchupSource ?? headerCatchupSource,
      catchupCorrection: pendingEntry.catchupCorrection ?? headerCatchupCorrection,
      url: line,
    })
    pending = null
    extgrpFallback = null
  }

  return { entries, epgUrl }
}
