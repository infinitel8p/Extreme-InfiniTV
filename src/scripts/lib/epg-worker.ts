// XMLTV parser running in a dedicated Web Worker so 5-50MB feeds don't block
// the main thread. Mirrors parseXmlTv in epg-data.js. If DOMParser is missing
// (rare on very old Android WebView), we ask the caller to fall back.

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

// Exported so tests can check parity with the main-thread parser in epg-data.js.
export function parseXmlTv(xml: string): {
  programmes: Map<string, Programme[]>
  channelNames: Map<string, string>
  hasExplicitTimezones: boolean
} {
  const programmes = new Map<string, Programme[]>()
  const channelNames = new Map<string, string>()
  const sanitized = xml.replace(/<!DOCTYPE[^>[]*>/i, "")
  if (/<!DOCTYPE\b/i.test(sanitized) || /<!ENTITY\b/i.test(sanitized)) {
    throw new Error("XMLTV contains forbidden DOCTYPE/ENTITY declaration")
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/xml")
  const err = doc.querySelector("parsererror")
  if (err) {
    throw new Error(
      "XMLTV parse error: " + (err.textContent || "").slice(0, 200)
    )
  }

  for (const channel of doc.querySelectorAll("channel")) {
    const id = (channel.getAttribute("id") || "").toLowerCase()
    if (!id) continue
    const name =
      channel.querySelector("display-name")?.textContent?.trim() || ""
    if (name) channelNames.set(id, name)
  }

  const lo = Date.now() - EPG_PAST_WINDOW_MS
  const hi = Date.now() + 36 * 60 * 60 * 1000

  let timezoneTimestampCount = 0
  let timezoneSuffixCount = 0

  const list = doc.querySelectorAll("programme")
  for (const programme of list) {
    const channelId = (programme.getAttribute("channel") || "").toLowerCase()
    if (!channelId) continue
    const startRaw = programme.getAttribute("start") || ""
    const stopRaw = programme.getAttribute("stop") || ""
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
    if (!start || !stop || stop <= start) continue
    if (stop < lo || start > hi) continue

    const title =
      programme.querySelector("title")?.textContent?.trim() || "Untitled"
    const desc = programme.querySelector("desc")?.textContent?.trim() || ""
    // Non-standard, some catchup providers require a programme-specific id in the catchup URL.
    const catchupId = programme.getAttribute("catchup-id") || undefined

    let arr = programmes.get(channelId)
    if (!arr) {
      arr = []
      programmes.set(channelId, arr)
    }
    arr.push({ start, stop, title, desc, catchupId })
  }

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
  if (typeof DOMParser === "undefined") {
    post({ id, fallback: true })
    return
  }
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
