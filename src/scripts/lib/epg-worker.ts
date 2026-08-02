// XMLTV parser running in a dedicated Web Worker so 5-50MB feeds don't block
// the main thread. Workers have no DOMParser (a Window-only API), so this walks
// the markup with a small scanner; tests assert parity with epg-data.js.

import { EPG_PAST_WINDOW_MS } from "@/scripts/lib/epg-constants.ts"

type Programme = { start: number; stop: number; title: string; desc: string; catchupId?: string }

interface ParseRequest {
  id: number
  xml: string
}

interface ParseResponse {
  id: number
  programmes?: Array<[string, Programme[]]>
  channelNames?: Array<[string, string]>
  hasExplicitTimezones?: boolean
  error?: string
  fallback?: boolean
}

function parseXmlTvDate(value: string): number {
  if (!value) return 0
  const trimmed = String(value).trim()
  const match = trimmed.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/
  )
  if (!match) return 0
  const [, y, mo, d, h, mi, s2, sign, oh, om] = match
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s2)
  if (!sign) return utc
  const offsetMs = (parseInt(oh, 10) * 60 + parseInt(om, 10)) * 60 * 1000
  return sign === "+" ? utc - offsetMs : utc + offsetMs
}

// Same shape as the sign group in parseXmlTvDate's regex - detects whether a raw
// XMLTV timestamp carried an explicit offset rather than a floating local time.
const TZ_SUFFIX_RX = /^\d{14}\s*[+-]\d{4}$/
function hasTzSuffix(raw: string): boolean {
  return TZ_SUFFIX_RX.test(String(raw || "").trim())
}

// ---------------------------------------------------------------------------
// Minimal XML scanning (no DOMParser)
// ---------------------------------------------------------------------------

// XML predefines exactly these five; anything else needs a DTD, which we reject.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

const ENTITY_RX = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text
  return text.replace(ENTITY_RX, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body[1] === "x" || body[1] === "X"
      const codePoint = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    // Entity names are case-sensitive in XML; leave unknown ones verbatim.
    const named = NAMED_ENTITIES[body]
    return named === undefined ? match : named
  })
}

const ATTR_RX = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function readAttrs(rawAttrs: string): Map<string, string> {
  const attrs = new Map<string, string>()
  if (!rawAttrs) return attrs
  ATTR_RX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_RX.exec(rawAttrs)) !== null) {
    attrs.set(match[1], decodeEntities(match[2] ?? match[3] ?? ""))
  }
  return attrs
}

/** Concatenated descendant text, mirroring DOM textContent. */
function innerTextOf(source: string): string {
  if (!source) return ""
  // Fast path: no markup at all.
  if (!source.includes("<")) return decodeEntities(source)
  let out = ""
  let i = 0
  while (i < source.length) {
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9)
      if (end === -1) {
        // Unterminated CDATA: take the rest literally, entities included.
        out += source.slice(i + 9)
        break
      }
      out += source.slice(i + 9, end)
      i = end + 3
      continue
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4)
      i = end === -1 ? source.length : end + 3
      continue
    }
    if (source[i] === "<") {
      const end = source.indexOf(">", i + 1)
      i = end === -1 ? source.length : end + 1
      continue
    }
    const next = source.indexOf("<", i)
    if (next === -1) {
      out += decodeEntities(source.slice(i))
      break
    }
    out += decodeEntities(source.slice(i, next))
    i = next
  }
  return out
}

/**
 * Drop XML comments so a tag mentioned inside one is never scanned as real
 * markup. CDATA-aware, because `<!--` inside CDATA is literal content.
 */
function stripComments(xml: string): string {
  if (!xml.includes("<!--")) return xml
  let out = ""
  let i = 0
  while (i < xml.length) {
    const comment = xml.indexOf("<!--", i)
    if (comment === -1) {
      out += xml.slice(i)
      break
    }
    const cdata = xml.indexOf("<![CDATA[", i)
    if (cdata !== -1 && cdata < comment) {
      const cdataEnd = xml.indexOf("]]>", cdata + 9)
      if (cdataEnd === -1) {
        out += xml.slice(i)
        break
      }
      out += xml.slice(i, cdataEnd + 3)
      i = cdataEnd + 3
      continue
    }
    out += xml.slice(i, comment)
    const commentEnd = xml.indexOf("-->", comment + 4)
    if (commentEnd === -1) break
    i = commentEnd + 3
  }
  return out
}

/**
 * Visit every `<tagName>` element. The lookahead keeps `<programme` from
 * matching `<programmes`, and a trailing slash in the attribute run marks a
 * self-closing tag.
 */
function forEachElement(
  xml: string,
  tagName: string,
  visit: (attrs: Map<string, string>, inner: string) => void
): void {
  const openRx = new RegExp(`<${tagName}(?=[\\s/>])([^>]*)>`, "g")
  const closeTag = `</${tagName}>`
  let match: RegExpExecArray | null
  while ((match = openRx.exec(xml)) !== null) {
    const rawAttrs = match[1] || ""
    const selfClosing = rawAttrs.endsWith("/")
    const attrs = readAttrs(selfClosing ? rawAttrs.slice(0, -1) : rawAttrs)
    if (selfClosing) {
      visit(attrs, "")
      continue
    }
    const contentStart = openRx.lastIndex
    const closeIdx = xml.indexOf(closeTag, contentStart)
    if (closeIdx === -1) {
      visit(attrs, xml.slice(contentStart))
      break
    }
    visit(attrs, xml.slice(contentStart, closeIdx))
    openRx.lastIndex = closeIdx + closeTag.length
  }
}

function firstElementText(source: string, tagName: string): string {
  let found: string | null = null
  forEachElement(source, tagName, (_attrs, inner) => {
    if (found === null) found = innerTextOf(inner)
  })
  return found ?? ""
}

// Exported so tests can check parity with the main-thread parser in epg-data.js.
export function parseXmlTv(xml: string): {
  programmes: Map<string, Programme[]>
  channelNames: Map<string, string>
  hasExplicitTimezones: boolean
} {
  const programmes = new Map<string, Programme[]>()
  const channelNames = new Map<string, string>()
  const declStripped = xml.replace(/<!DOCTYPE[^>[]*>/i, "")
  if (/<!DOCTYPE\b/i.test(declStripped) || /<!ENTITY\b/i.test(declStripped)) {
    throw new Error("XMLTV contains forbidden DOCTYPE/ENTITY declaration")
  }
  const sanitized = stripComments(declStripped)
  // Reject provider HTML error pages outright (no parsererror without a DOM).
  if (!/<tv[\s>]/i.test(sanitized)) {
    throw new Error("XMLTV parse error: no <tv> root element")
  }

  forEachElement(sanitized, "channel", (attrs, inner) => {
    const id = (attrs.get("id") || "").toLowerCase()
    if (!id) return
    const name = firstElementText(inner, "display-name").trim()
    if (name) channelNames.set(id, name)
  })

  const lo = Date.now() - EPG_PAST_WINDOW_MS
  const hi = Date.now() + 36 * 60 * 60 * 1000

  let timezoneTimestampCount = 0
  let timezoneSuffixCount = 0

  forEachElement(sanitized, "programme", (attrs, inner) => {
    const channelId = (attrs.get("channel") || "").toLowerCase()
    if (!channelId) return
    const startRaw = attrs.get("start") || ""
    const stopRaw = attrs.get("stop") || ""
    if (startRaw) {
      timezoneTimestampCount++
      if (hasTzSuffix(startRaw)) timezoneSuffixCount++
    }
    if (stopRaw) {
      timezoneTimestampCount++
      if (hasTzSuffix(stopRaw)) timezoneSuffixCount++
    }
    const start = parseXmlTvDate(startRaw)
    const stop = parseXmlTvDate(stopRaw)
    if (!start || !stop || stop <= start) return
    if (stop < lo || start > hi) return

    const title = firstElementText(inner, "title").trim() || "Untitled"
    const desc = firstElementText(inner, "desc").trim()
    // Non-standard, some catchup providers require a programme-specific id in the catchup URL.
    const catchupId = attrs.get("catchup-id") || undefined

    let arr = programmes.get(channelId)
    if (!arr) {
      arr = []
      programmes.set(channelId, arr)
    }
    arr.push({ start, stop, title, desc, catchupId })
  })

  for (const arr of programmes.values()) {
    arr.sort((first, second) => first.start - second.start)
    let lastStop = -Infinity
    let writeIdx = 0
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].start >= lastStop) {
        arr[writeIdx++] = arr[i]
        lastStop = arr[i].stop
      }
    }
    arr.length = writeIdx
  }
  const hasExplicitTimezones =
    timezoneTimestampCount > 0 && timezoneSuffixCount > timezoneTimestampCount / 2
  return { programmes, channelNames, hasExplicitTimezones }
}

const post = (msg: ParseResponse) => (self as unknown as Worker).postMessage(msg)

self.addEventListener("message", (event: MessageEvent<ParseRequest>) => {
  if (event.origin && event.origin !== self.location.origin) return
  const { id, xml } = event.data || ({} as ParseRequest)
  try {
    const { programmes, channelNames, hasExplicitTimezones } = parseXmlTv(xml)
    post({
      id,
      programmes: Array.from(programmes.entries()),
      channelNames: Array.from(channelNames.entries()),
      hasExplicitTimezones,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    post({ id, error: message })
  }
})
