// XMLTV parser running in a dedicated Web Worker so 5-50MB feeds don't block
// the main thread. Mirrors parseXmlTv in epg-data.js. If DOMParser is missing
// (rare on very old Android WebView), we ask the caller to fall back.

type Programme = { start: number; stop: number; title: string; desc: string }

interface ParseRequest {
  id: number
  xml: string
}

interface ParseResponse {
  id: number
  programmes?: Array<[string, Programme[]]>
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

function parseXmlTv(xml: string): Map<string, Programme[]> {
  const out = new Map<string, Programme[]>()
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  const err = doc.querySelector("parsererror")
  if (err) {
    throw new Error(
      "XMLTV parse error: " + (err.textContent || "").slice(0, 200)
    )
  }

  const lo = Date.now() - 6 * 60 * 60 * 1000
  const hi = Date.now() + 36 * 60 * 60 * 1000

  const list = doc.querySelectorAll("programme")
  for (const programme of list) {
    const channelId = (programme.getAttribute("channel") || "").toLowerCase()
    if (!channelId) continue
    const start = parseXmlTvDate(programme.getAttribute("start") || "")
    const stop = parseXmlTvDate(programme.getAttribute("stop") || "")
    if (!start || !stop || stop <= start) continue
    if (stop < lo || start > hi) continue

    const title =
      programme.querySelector("title")?.textContent?.trim() || "Untitled"
    const desc = programme.querySelector("desc")?.textContent?.trim() || ""

    let arr = out.get(channelId)
    if (!arr) {
      arr = []
      out.set(channelId, arr)
    }
    arr.push({ start, stop, title, desc })
  }

  for (const arr of out.values()) {
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
  return out
}

const post = (msg: ParseResponse) => (self as unknown as Worker).postMessage(msg)

self.addEventListener("message", (event: MessageEvent<ParseRequest>) => {
  const { id, xml } = event.data || ({} as ParseRequest)
  if (typeof DOMParser === "undefined") {
    post({ id, fallback: true })
    return
  }
  try {
    const programmes = parseXmlTv(xml)
    post({ id, programmes: Array.from(programmes.entries()) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    post({ id, error: message })
  }
})
