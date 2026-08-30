// XMLTV parser running in a dedicated Web Worker so 5-50MB feeds don't block
// the main thread. Workers have no DOMParser (a Window-only API), so this walks
// the markup with a small scanner; tests assert parity with epg-data.js.

import { EPG_PAST_WINDOW_MS } from "@/scripts/lib/epg-constants.ts"
import { isTrustedWorkerMessage } from "@/scripts/lib/worker-origin.ts"

type Programme = { start: number; stop: number; title: string; desc: string; catchupId?: string }

export type EpgWindow = { fromMs: number; toMs: number }

interface ParseRequest {
  type?: "parse"
  id: number
  xml: string
  window?: EpgWindow
  /** Memory-conservative TV tier: retain only the airing + upcoming programme per channel. */
  mode?: "now-next"
  nowMs?: number
  /** Tags the retained raw-xml copy so a later `programmesFor` can find it back. */
  feedId?: string
}

interface ProgrammesForRequest {
  type: "programmesFor"
  id: number
  feedId: string
  tvgId: string
  window?: EpgWindow
}

/** Streaming now-next flow: begin -> repeated chunk (transferred bytes) -> end. */
interface StreamBeginRequest {
  type: "begin"
  id: number
  mode: "now-next"
  feedId: string
  nowMs: number
  /** True when `chunk` bytes are the raw (still-compressed) network payload. */
  gzip: boolean
}

interface StreamChunkRequest {
  type: "chunk"
  id: number
  feedId: string
  bytes: ArrayBuffer
}

interface StreamEndRequest {
  type: "end"
  id: number
  feedId: string
}

export type WorkerRequest =
  | ParseRequest
  | ProgrammesForRequest
  | StreamBeginRequest
  | StreamChunkRequest
  | StreamEndRequest

interface ParseResponse {
  id: number
  programmes?: Array<[string, Programme[]]>
  channelNames?: Array<[string, string]>
  hasExplicitTimezones?: boolean
  error?: string
}

interface ProgrammesForResponse {
  id: number
  programmes?: Programme[]
  noFeed?: boolean
  error?: string
}

export type WorkerResponse = ParseResponse | ProgrammesForResponse

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

// The lookahead keeps `<programme` from matching `<programmes`; shared by the
// whole-string scanner and the incremental one so both agree on tag boundaries.
function openTagRegex(tagName: string): RegExp {
  return new RegExp(`<${tagName}(?=[\\s/>])([^>]*)>`, "g")
}

/**
 * Visit every `<tagName>` element. A trailing slash in the attribute run
 * marks a self-closing tag.
 */
function forEachElement(
  xml: string,
  tagName: string,
  visit: (attrs: Map<string, string>, inner: string) => void
): void {
  const openRx = openTagRegex(tagName)
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

/**
 * DOCTYPE/ENTITY rejection + comment stripping shared by every scan entry
 * point. Cheap to call on already-sanitized text: `.replace`/`stripComments`
 * both no-op (return the same string) when there's nothing to strip.
 */
function prepareXml(xml: string): string {
  const declStripped = xml.replace(/<!DOCTYPE[^>[]*>/i, "")
  if (/<!DOCTYPE\b/i.test(declStripped) || /<!ENTITY\b/i.test(declStripped)) {
    throw new Error("XMLTV contains forbidden DOCTYPE/ENTITY declaration")
  }
  const sanitized = stripComments(declStripped)
  // Reject provider HTML error pages outright (no parsererror without a DOM).
  if (!/<tv[\s>]/i.test(sanitized)) {
    throw new Error("XMLTV parse error: no <tv> root element")
  }
  return sanitized
}

/** Per-element `<channel>` visitor, shared by the whole-string and streaming scanners. */
function applyChannelElement(
  channelNames: Map<string, string>,
  attrs: Map<string, string>,
  inner: string
): void {
  const id = (attrs.get("id") || "").toLowerCase()
  if (!id) return
  const name = firstElementText(inner, "display-name").trim()
  if (name) channelNames.set(id, name)
}

function scanChannelNames(sanitized: string): Map<string, string> {
  const channelNames = new Map<string, string>()
  forEachElement(sanitized, "channel", (attrs, inner) => applyChannelElement(channelNames, attrs, inner))
  return channelNames
}

// Exported so tests can check parity with the main-thread parser in epg-data.js.
// window narrows (never widens) the default retention window, so a fromMs/toMs
// outside it has no effect - keeps peak heap bounded on memory-constrained callers.
export function parseXmlTv(
  xml: string,
  window?: EpgWindow
): {
  programmes: Map<string, Programme[]>
  channelNames: Map<string, string>
  hasExplicitTimezones: boolean
} {
  const programmes = new Map<string, Programme[]>()
  const sanitized = prepareXml(xml)
  const channelNames = scanChannelNames(sanitized)

  let lo = Date.now() - EPG_PAST_WINDOW_MS
  let hi = Date.now() + 36 * 60 * 60 * 1000
  if (window) {
    lo = Math.max(lo, window.fromMs)
    hi = Math.min(hi, window.toMs)
  }

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

// ---------------------------------------------------------------------------
// "now-next" mode: retains only the airing + upcoming programme per channel,
// so 50k+ channel feeds don't materialize a full per-channel array in heap.
// ---------------------------------------------------------------------------

interface NowNextSlot {
  current: Programme | null
  next: Programme | null
}

interface TzCounters {
  timestamps: number
  suffixed: number
}

/**
 * Per-element `<programme>` visitor for now-next reduction: keeps at most one
 * "current" and one "next" programme per channel, skipping anything already
 * over before title/desc are even extracted. Shared by the whole-string and
 * streaming scanners so both apply identical selection rules.
 */
function applyNowNextProgramme(
  slots: Map<string, NowNextSlot>,
  attrs: Map<string, string>,
  inner: string,
  nowMs: number,
  tz: TzCounters
): void {
  const channelId = (attrs.get("channel") || "").toLowerCase()
  if (!channelId) return
  const startRaw = attrs.get("start") || ""
  const stopRaw = attrs.get("stop") || ""
  if (startRaw) {
    tz.timestamps++
    if (hasTzSuffix(startRaw)) tz.suffixed++
  }
  if (stopRaw) {
    tz.timestamps++
    if (hasTzSuffix(stopRaw)) tz.suffixed++
  }
  const start = parseXmlTvDate(startRaw)
  const stop = parseXmlTvDate(stopRaw)
  if (!start || !stop || stop <= start || stop <= nowMs) return

  let slot = slots.get(channelId)
  if (!slot) {
    slot = { current: null, next: null }
    slots.set(channelId, slot)
  }
  const isCurrent = start <= nowMs
  if (isCurrent) {
    if (slot.current && slot.current.start >= start) return
  } else if (slot.next && slot.next.start <= start) {
    return
  }

  const title = firstElementText(inner, "title").trim() || "Untitled"
  const desc = firstElementText(inner, "desc").trim()
  const catchupId = attrs.get("catchup-id") || undefined
  const programme: Programme = { start, stop, title, desc, catchupId }
  if (isCurrent) slot.current = programme
  else slot.next = programme
}

function slotsToNowNextMap(slots: Map<string, NowNextSlot>): Map<string, Programme[]> {
  const programmes = new Map<string, Programme[]>()
  for (const [channelId, slot] of slots) {
    const arr: Programme[] = []
    if (slot.current) arr.push(slot.current)
    if (slot.next) arr.push(slot.next)
    if (arr.length) programmes.set(channelId, arr)
  }
  return programmes
}

/**
 * Single-pass scan keeping at most one "current" and one "next" programme per
 * channel. Not a substitute for `parseXmlTv` when the feed's channel order
 * interleaves out-of-sequence programmes for the same channel - acceptable
 * for a lite tier.
 */
export function parseXmlTvNowNext(
  xml: string,
  nowMs: number
): {
  programmes: Map<string, Programme[]>
  channelNames: Map<string, string>
  hasExplicitTimezones: boolean
  sanitized: string
} {
  const sanitized = prepareXml(xml)
  const channelNames = scanChannelNames(sanitized)

  const slots = new Map<string, NowNextSlot>()
  const tz: TzCounters = { timestamps: 0, suffixed: 0 }

  forEachElement(sanitized, "programme", (attrs, inner) => {
    applyNowNextProgramme(slots, attrs, inner, nowMs, tz)
  })

  const programmes = slotsToNowNextMap(slots)
  const hasExplicitTimezones = tz.timestamps > 0 && tz.suffixed > tz.timestamps / 2
  return { programmes, channelNames, hasExplicitTimezones, sanitized }
}

/** Per-element `<programme>` visitor for a single-channel full extraction (windowed). */
function applyChannelProgrammeFilter(
  out: Programme[],
  attrs: Map<string, string>,
  inner: string,
  targetChannelId: string,
  lo: number,
  hi: number
): void {
  if ((attrs.get("channel") || "").toLowerCase() !== targetChannelId) return
  const start = parseXmlTvDate(attrs.get("start") || "")
  const stop = parseXmlTvDate(attrs.get("stop") || "")
  if (!start || !stop || stop <= start) return
  if (stop < lo || start > hi) return
  const title = firstElementText(inner, "title").trim() || "Untitled"
  const desc = firstElementText(inner, "desc").trim()
  const catchupId = attrs.get("catchup-id") || undefined
  out.push({ start, stop, title, desc, catchupId })
}

function sortAndDedupeProgrammes(out: Programme[]): Programme[] {
  out.sort((first, second) => first.start - second.start)
  let lastStop = -Infinity
  let writeIdx = 0
  for (let i = 0; i < out.length; i++) {
    if (out[i].start >= lastStop) {
      out[writeIdx++] = out[i]
      lastStop = out[i].stop
    }
  }
  out.length = writeIdx
  return out
}

/** Full programme list for one channel, scanned from an (already-sanitized-or-not) xml string. */
export function extractChannelProgrammes(xml: string, tvgId: string, window?: EpgWindow): Programme[] {
  const sanitized = prepareXml(xml)
  const target = tvgId.toLowerCase()
  let lo = Date.now() - EPG_PAST_WINDOW_MS
  let hi = Date.now() + 36 * 60 * 60 * 1000
  if (window) {
    lo = Math.max(lo, window.fromMs)
    hi = Math.min(hi, window.toMs)
  }

  const out: Programme[] = []
  forEachElement(sanitized, "programme", (attrs, inner) => {
    applyChannelProgrammeFilter(out, attrs, inner, target, lo, hi)
  })

  return sortAndDedupeProgrammes(out)
}

// ---------------------------------------------------------------------------
// Streaming now-next scanner: never materializes the whole feed as one string
// in any isolate. Comments are stripped incrementally (tolerating a split
// across chunk boundaries); complete <channel>/<programme> elements are
// extracted from a bounded carry buffer via the same per-element visitors
// above, so the streaming and whole-string paths can never disagree.
// ---------------------------------------------------------------------------

interface IncrementalScanState {
  carry: string
  insideComment: boolean
}

/** Strips complete XML comments from `state.carry`, tolerating one split across chunk boundaries. */
function stripCarryComments(state: IncrementalScanState): void {
  const buffer = state.carry
  if (!state.insideComment && !buffer.includes("<!--")) return
  let clean = ""
  let i = 0
  let insideComment = state.insideComment
  while (i < buffer.length) {
    if (insideComment) {
      const end = buffer.indexOf("-->", i)
      if (end === -1) break
      i = end + 3
      insideComment = false
      continue
    }
    const start = buffer.indexOf("<!--", i)
    if (start === -1) {
      clean += buffer.slice(i)
      break
    }
    clean += buffer.slice(i, start)
    const end = buffer.indexOf("-->", start + 4)
    if (end === -1) {
      insideComment = true
      break
    }
    i = end + 3
  }
  state.insideComment = insideComment
  state.carry = clean
}

interface StreamElementFound {
  status: "found"
  tag: string
  attrs: Map<string, string>
  inner: string
  endIndex: number
}
interface StreamElementIncomplete {
  status: "incomplete"
  startIndex: number
}
interface StreamElementNone {
  status: "none"
}
type StreamElementResult = StreamElementFound | StreamElementIncomplete | StreamElementNone

/** Finds the earliest complete (or still-open) element among `tagNames`, starting at `fromIndex`. */
function nextStreamElement(
  text: string,
  tagNames: readonly string[],
  fromIndex: number
): StreamElementResult {
  let winnerTag: string | null = null
  let winnerMatch: RegExpExecArray | null = null
  for (const tagName of tagNames) {
    const openRx = openTagRegex(tagName)
    openRx.lastIndex = fromIndex
    const match = openRx.exec(text)
    if (match && (!winnerMatch || match.index < winnerMatch.index)) {
      winnerTag = tagName
      winnerMatch = match
    }
  }
  if (!winnerMatch || winnerTag === null) return { status: "none" }

  const rawAttrs = winnerMatch[1] || ""
  const selfClosing = rawAttrs.endsWith("/")
  const attrs = readAttrs(selfClosing ? rawAttrs.slice(0, -1) : rawAttrs)
  const afterOpenTag = winnerMatch.index + winnerMatch[0].length
  if (selfClosing) {
    return { status: "found", tag: winnerTag, attrs, inner: "", endIndex: afterOpenTag }
  }
  const closeTag = `</${winnerTag}>`
  const closeIdx = text.indexOf(closeTag, afterOpenTag)
  if (closeIdx === -1) {
    return { status: "incomplete", startIndex: winnerMatch.index }
  }
  return {
    status: "found",
    tag: winnerTag,
    attrs,
    inner: text.slice(afterOpenTag, closeIdx),
    endIndex: closeIdx + closeTag.length,
  }
}

/** Extracts every complete element for `tagNames` out of `state.carry`, leaving the unconsumed tail. */
function drainElements(
  state: IncrementalScanState,
  tagNames: readonly string[],
  visit: (tag: string, attrs: Map<string, string>, inner: string) => void
): void {
  let cursor = 0
  while (cursor < state.carry.length) {
    const result = nextStreamElement(state.carry, tagNames, cursor)
    if (result.status === "found") {
      visit(result.tag, result.attrs, result.inner)
      cursor = result.endIndex
      continue
    }
    if (result.status === "incomplete") {
      cursor = result.startIndex
      break
    }
    // Nothing recognizable ahead; keep a defensive tail in case a tag name
    // straddles the next chunk boundary.
    const remainder = state.carry.slice(cursor)
    const lastOpenBracket = remainder.lastIndexOf("<")
    cursor += lastOpenBracket === -1 ? remainder.length : lastOpenBracket
    break
  }
  state.carry = state.carry.slice(cursor)
}

function findNextTagBoundary(text: string, tagNames: readonly string[], fromIndex: number): number {
  let earliest = -1
  for (const tagName of tagNames) {
    const index = text.indexOf(`<${tagName}`, fromIndex)
    if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index
  }
  return earliest
}

const CARRY_CAP_CHARS = 512 * 1024

/**
 * Defensive overflow guard: a single programme element is never this large.
 * An overflowing carry always starts at the still-open element's own tag (see
 * `drainElements`'s "incomplete" branch), so the search for the next
 * boundary starts one character in - otherwise it would just re-match that
 * same tag and never actually advance.
 */
function capCarry(state: IncrementalScanState, tagNames: readonly string[]): void {
  if (state.carry.length <= CARRY_CAP_CHARS) return
  const boundary = findNextTagBoundary(state.carry, tagNames, 1)
  state.carry = boundary === -1 ? "" : state.carry.slice(boundary)
}

const STREAM_TAGS = ["programme", "channel"] as const

interface StreamSession {
  feedId: string
  gzip: boolean
  nowMs: number
  chunks: ArrayBuffer[]
  decoder: TextDecoder
  writer: WritableStreamDefaultWriter<BufferSource> | null
  pumpDone: Promise<void> | null
  writeQueue: Promise<void>
  scan: IncrementalScanState
  rootChecked: boolean
  slots: Map<string, NowNextSlot>
  channelNames: Map<string, string>
  tz: TzCounters
  error: string | null
}

const streamSessions = new Map<string, StreamSession>()

// Roughly 20-40MB off-heap for a big feed - fine. Replayed (re-decompressed +
// re-scanned) per programmesFor call instead of ever materializing full text.
let retainedStreamFeed: { feedId: string; gzip: boolean; chunks: ArrayBuffer[] } | null = null

function beginStream(request: StreamBeginRequest): void {
  const session: StreamSession = {
    feedId: request.feedId,
    gzip: request.gzip,
    nowMs: request.nowMs,
    chunks: [],
    decoder: new TextDecoder("utf-8", { fatal: false }),
    writer: null,
    pumpDone: null,
    writeQueue: Promise.resolve(),
    scan: { carry: "", insideComment: false },
    rootChecked: false,
    slots: new Map(),
    channelNames: new Map(),
    tz: { timestamps: 0, suffixed: 0 },
    error: null,
  }
  if (request.gzip) {
    if (typeof DecompressionStream !== "function") {
      session.error = "This browser/WebView can't decompress gzipped EPG payloads."
    } else {
      const decompressionStream = new DecompressionStream("gzip")
      session.writer = decompressionStream.writable.getWriter()
      session.pumpDone = pumpDecompressedText(decompressionStream.readable, session)
    }
  }
  streamSessions.set(request.feedId, session)
}

async function pumpDecompressedText(
  readable: ReadableStream<Uint8Array>,
  session: StreamSession
): Promise<void> {
  const reader = readable.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      ingestSessionText(session, session.decoder.decode(value, { stream: true }))
    }
    ingestSessionText(session, session.decoder.decode())
  } catch (error) {
    session.error = session.error ?? (error instanceof Error ? error.message : String(error))
  }
}

function feedStreamChunk(session: StreamSession, bytes: ArrayBuffer): Promise<void> {
  session.chunks.push(bytes)
  session.writeQueue = session.writeQueue.then(async () => {
    if (session.error) return
    try {
      if (session.writer) {
        await session.writer.write(new Uint8Array(bytes))
      } else {
        ingestSessionText(session, session.decoder.decode(bytes, { stream: true }))
      }
    } catch (error) {
      session.error = session.error ?? (error instanceof Error ? error.message : String(error))
    }
  })
  return session.writeQueue
}

/** Same DOCTYPE/ENTITY + `<tv>` root guards as `prepareXml`, applied lazily as text arrives. */
function ingestSessionText(session: StreamSession, text: string): void {
  if (session.error || !text) return

  if (!session.rootChecked) {
    session.scan.carry += text
    const declStripped = session.scan.carry.replace(/<!DOCTYPE[^>[]*>/i, "")
    if (/<!DOCTYPE\b/i.test(declStripped) || /<!ENTITY\b/i.test(declStripped)) {
      session.error = "XMLTV contains forbidden DOCTYPE/ENTITY declaration"
      return
    }
    if (!/<tv[\s>]/i.test(declStripped)) {
      if (session.scan.carry.length > CARRY_CAP_CHARS) {
        session.error = "XMLTV parse error: no <tv> root element"
      }
      return
    }
    session.scan.carry = declStripped
    session.rootChecked = true
  } else {
    session.scan.carry += text
  }

  stripCarryComments(session.scan)
  drainElements(session.scan, STREAM_TAGS, (tag, attrs, inner) => {
    if (tag === "channel") applyChannelElement(session.channelNames, attrs, inner)
    else applyNowNextProgramme(session.slots, attrs, inner, session.nowMs, session.tz)
  })
  capCarry(session.scan, STREAM_TAGS)
}

async function endStream(session: StreamSession): Promise<{
  programmes: Map<string, Programme[]>
  channelNames: Map<string, string>
  hasExplicitTimezones: boolean
}> {
  await session.writeQueue
  if (session.writer) {
    try {
      await session.writer.close()
    } catch (error) {
      session.error = session.error ?? (error instanceof Error ? error.message : String(error))
    }
    if (session.pumpDone) await session.pumpDone
  } else {
    ingestSessionText(session, session.decoder.decode())
  }

  streamSessions.delete(session.feedId)
  if (session.error) throw new Error(session.error)
  if (!session.rootChecked) throw new Error("XMLTV parse error: no <tv> root element")

  const programmes = slotsToNowNextMap(session.slots)
  const hasExplicitTimezones = session.tz.timestamps > 0 && session.tz.suffixed > session.tz.timestamps / 2

  retainedStreamFeed = { feedId: session.feedId, gzip: session.gzip, chunks: session.chunks }
  return { programmes, channelNames: session.channelNames, hasExplicitTimezones }
}

/** Re-decompresses + re-scans a retained streaming feed for one channel's full programme list. */
async function streamExtractChannelProgrammes(
  feed: { feedId: string; gzip: boolean; chunks: ArrayBuffer[] },
  tvgId: string,
  window?: EpgWindow
): Promise<Programme[]> {
  const target = tvgId.toLowerCase()
  let lo = Date.now() - EPG_PAST_WINDOW_MS
  let hi = Date.now() + 36 * 60 * 60 * 1000
  if (window) {
    lo = Math.max(lo, window.fromMs)
    hi = Math.min(hi, window.toMs)
  }

  const out: Programme[] = []
  const scan: IncrementalScanState = { carry: "", insideComment: false }
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const ingest = (text: string) => {
    if (!text) return
    scan.carry += text
    stripCarryComments(scan)
    drainElements(scan, ["programme"], (_tag, attrs, inner) => {
      applyChannelProgrammeFilter(out, attrs, inner, target, lo, hi)
    })
    capCarry(scan, ["programme"])
  }

  if (feed.gzip) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser/WebView can't decompress gzipped EPG payloads.")
    }
    const decompressionStream = new DecompressionStream("gzip")
    const writer = decompressionStream.writable.getWriter()
    const reader = decompressionStream.readable.getReader()
    const pump = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        ingest(decoder.decode(value, { stream: true }))
      }
      ingest(decoder.decode())
    })()
    for (const chunk of feed.chunks) await writer.write(new Uint8Array(chunk))
    await writer.close()
    await pump
  } else {
    for (const chunk of feed.chunks) ingest(decoder.decode(chunk, { stream: true }))
    ingest(decoder.decode())
  }

  return sortAndDedupeProgrammes(out)
}

// Single retained copy: a now-next parse posts its xml here (sanitized, so a
// later `programmesFor` doesn't re-run the DOCTYPE/comment scan) tagged with
// the caller's feedId. Replaced wholesale by the next now-next parse.
let retainedFeed: { feedId: string; xml: string } | null = null

function toErrorResponse(id: number, error: unknown): WorkerResponse {
  return { id, error: error instanceof Error ? error.message : String(error) }
}

function endStreamResponse(id: number, session: StreamSession): Promise<WorkerResponse> {
  return endStream(session).then(
    (result) => ({
      id,
      programmes: Array.from(result.programmes.entries()),
      channelNames: Array.from(result.channelNames.entries()),
      hasExplicitTimezones: result.hasExplicitTimezones,
    }),
    (error) => toErrorResponse(id, error)
  )
}

/**
 * Pure request handler, exported so tests can drive the worker's message
 * contract directly. `begin`/`chunk` never reply (null); `end` and a
 * streamed `programmesFor` resolve asynchronously since decompression uses
 * the Streams API. Every other request replies synchronously, unchanged -
 * overloaded so existing callers keep their non-nullable, non-Promise type.
 */
export function handleWorkerRequest(request: ParseRequest): WorkerResponse
export function handleWorkerRequest(
  request: ProgrammesForRequest
): WorkerResponse | Promise<WorkerResponse>
export function handleWorkerRequest(request: StreamBeginRequest | StreamChunkRequest): null
export function handleWorkerRequest(request: StreamEndRequest): Promise<WorkerResponse>
export function handleWorkerRequest(
  request: WorkerRequest
): WorkerResponse | Promise<WorkerResponse> | null
export function handleWorkerRequest(
  request: WorkerRequest
): WorkerResponse | Promise<WorkerResponse> | null {
  const { id } = request
  try {
    if (request.type === "begin") {
      beginStream(request)
      return null
    }

    if (request.type === "chunk") {
      const session = streamSessions.get(request.feedId)
      if (session) void feedStreamChunk(session, request.bytes)
      return null
    }

    if (request.type === "end") {
      const session = streamSessions.get(request.feedId)
      if (!session) return { id, error: `unknown stream feedId: ${request.feedId}` }
      return endStreamResponse(id, session)
    }

    if (request.type === "programmesFor") {
      if (retainedFeed && retainedFeed.feedId === request.feedId) {
        const programmes = extractChannelProgrammes(retainedFeed.xml, request.tvgId, request.window)
        return { id, programmes }
      }
      if (retainedStreamFeed && retainedStreamFeed.feedId === request.feedId) {
        return streamExtractChannelProgrammes(retainedStreamFeed, request.tvgId, request.window).then(
          (programmes) => ({ id, programmes }),
          (error) => toErrorResponse(id, error)
        )
      }
      return { id, noFeed: true }
    }

    if (request.mode === "now-next") {
      const { programmes, channelNames, hasExplicitTimezones, sanitized } = parseXmlTvNowNext(
        request.xml,
        request.nowMs ?? Date.now()
      )
      if (request.feedId) retainedFeed = { feedId: request.feedId, xml: sanitized }
      return {
        id,
        programmes: Array.from(programmes.entries()),
        channelNames: Array.from(channelNames.entries()),
        hasExplicitTimezones,
      }
    }

    const { programmes, channelNames, hasExplicitTimezones } = parseXmlTv(request.xml, request.window)
    return {
      id,
      programmes: Array.from(programmes.entries()),
      channelNames: Array.from(channelNames.entries()),
      hasExplicitTimezones,
    }
  } catch (error) {
    return toErrorResponse(id, error)
  }
}

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg)

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  if (!isTrustedWorkerMessage(event)) return
  const request = event.data || ({} as WorkerRequest)
  const result = handleWorkerRequest(request)
  if (result === null) return
  if (result instanceof Promise) {
    void result.then(post)
    return
  }
  post(result)
})
