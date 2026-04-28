// EPG schedule grid view.
import {
  loadCreds,
  getActiveEntry,
  fmtBase,
  buildApiUrl,
  isLikelyM3USource,
} from "@/scripts/lib/creds.js"
import { getCached } from "@/scripts/lib/cache.js"
import { fetchAndMaybeGunzip } from "@/scripts/lib/network.js"

const PX_PER_HOUR = 200
const HOURS_VISIBLE = 6
const ROW_HEIGHT = 64
const CHANNEL_COL_WIDTH = 240
const MAX_CHANNELS = 150

// ----------------------------
// UI refs
// ----------------------------
const statusEl = document.getElementById("epg-status")
const gridEl = document.getElementById("epg-grid")
const headerInner = document.getElementById("epg-time-header-inner")
const bodyEl = document.getElementById("epg-body")
const titleEl = document.getElementById("epg-title")
const refreshBtn = document.getElementById("epg-refresh")

// ----------------------------
// State
// ----------------------------
/** @type {{host:string,port:string,user:string,pass:string}} */
let creds = { host: "", port: "", user: "", pass: "" }
let activePlaylistId = ""
let activeCat = ""
/** @type {Array<{id:number,name:string,logo?:string|null,tvgId?:string,category?:string}>} */
let channels = []
/** @type {Map<string, Array<{start:number,stop:number,title:string,desc:string}>>} channel id (tvg-id, lower-cased) → sorted programmes */
const programmes = new Map()
let viewStart = 0

function setStatus(text) {
  if (statusEl) statusEl.textContent = text
}

function showStatus(text) {
  if (statusEl) {
    statusEl.textContent = text
    statusEl.classList.remove("hidden")
  }
  if (gridEl) gridEl.classList.add("hidden")
}

function hideStatus() {
  if (statusEl) statusEl.classList.add("hidden")
  if (gridEl) gridEl.classList.remove("hidden")
}

// ----------------------------
// XMLTV parsing
// ----------------------------
function parseXmlTvDate(s) {
  if (!s) return 0
  const trimmed = s.trim()
  // 14 digits, optional space + signed 4-digit offset.
  const m = trimmed.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/
  )
  if (!m) return 0
  const [, y, mo, d, h, mi, s2, sign, oh, om] = m
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s2)
  if (!sign) return utc
  const offsetMs = (parseInt(oh, 10) * 60 + parseInt(om, 10)) * 60 * 1000
  return sign === "+" ? utc - offsetMs : utc + offsetMs
}

function parseXmlTv(xml) {
  programmes.clear()
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  const err = doc.querySelector("parsererror")
  if (err) throw new Error("XMLTV parse error: " + err.textContent.slice(0, 200))

  const lo = Date.now() - 60 * 60 * 1000
  const hi = Date.now() + 24 * 60 * 60 * 1000

  const list = doc.querySelectorAll("programme")
  for (const p of list) {
    const ch = (p.getAttribute("channel") || "").toLowerCase()
    if (!ch) continue
    const start = parseXmlTvDate(p.getAttribute("start") || "")
    const stop = parseXmlTvDate(p.getAttribute("stop") || "")
    if (!start || !stop || stop <= start) continue
    if (stop < lo || start > hi) continue

    const title =
      p.querySelector("title")?.textContent?.trim() || "Untitled"
    const desc = p.querySelector("desc")?.textContent?.trim() || ""

    let arr = programmes.get(ch)
    if (!arr) {
      arr = []
      programmes.set(ch, arr)
    }
    arr.push({ start, stop, title, desc })
  }

  // Sort and dedupe overlapping programmes per channel. Some providers ship
  // duplicate or near-duplicate programmes (regenerated EPGs that don't
  // replace, just append) — without this, two cells stack at the same
  // (left, width) and the titles render on top of each other.
  for (const arr of programmes.values()) {
    arr.sort((a, b) => a.start - b.start)
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
}

// ----------------------------
// Render
// ----------------------------
function roundHalfHourFloor(ts) {
  const half = 30 * 60 * 1000
  return Math.floor(ts / half) * half
}

function fmtTime(ts) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts))
}

function timeToX(ts) {
  return ((ts - viewStart) / (60 * 60 * 1000)) * PX_PER_HOUR
}

function renderTimeHeader() {
  if (!headerInner) return
  headerInner.replaceChildren()
  headerInner.style.width = `${HOURS_VISIBLE * PX_PER_HOUR}px`

  // Half-hour ticks across the visible window.
  for (let i = 0; i <= HOURS_VISIBLE * 2; i++) {
    const ts = viewStart + i * 30 * 60 * 1000
    const tick = document.createElement("div")
    const isHour = i % 2 === 0
    tick.className =
      "absolute top-0 bottom-0 flex items-end pb-1 select-none " +
      (isHour
        ? "border-l border-line text-fg-2 text-xs tabular-nums px-1.5 font-medium"
        : "border-l border-line/40 text-fg-3 text-2xs tabular-nums px-1.5")
    tick.style.left = `${(i * 30 * PX_PER_HOUR) / 60}px`
    tick.textContent = fmtTime(ts)
    headerInner.appendChild(tick)
  }
}

function renderChannelRow(channel, programmesForRow) {
  const row = document.createElement("div")
  row.className = "epg-row flex items-stretch border-b border-line"
  row.style.height = `${ROW_HEIGHT}px`

  // Sticky channel info column.
  const info = document.createElement("div")
  info.className =
    "shrink-0 sticky left-0 z-10 bg-bg flex items-center gap-2 px-3 border-r border-line"
  info.style.width = `${CHANNEL_COL_WIDTH}px`

  const logo = document.createElement("div")
  logo.className =
    "h-9 w-9 shrink-0 rounded-md bg-surface-2 overflow-hidden ring-1 ring-inset ring-line"
  if (channel.logo) {
    const img = document.createElement("img")
    img.src = channel.logo
    img.alt = ""
    img.loading = "lazy"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-contain"
    img.onerror = () => img.remove()
    logo.appendChild(img)
  }
  info.appendChild(logo)

  const nameWrap = document.createElement("div")
  nameWrap.className = "min-w-0 flex-1"
  const nameEl = document.createElement("div")
  nameEl.className = "truncate text-sm font-medium text-fg"
  nameEl.textContent = channel.name
  const sub = document.createElement("div")
  sub.className = "truncate text-2xs text-fg-3 tabular-nums"
  sub.textContent = channel.tvgId || ""
  nameWrap.append(nameEl, sub)
  info.appendChild(nameWrap)

  row.appendChild(info)

  // Programme track — relative-positioned host for absolute cells.
  const track = document.createElement("div")
  track.className = "epg-track relative shrink-0"
  track.style.width = `${HOURS_VISIBLE * PX_PER_HOUR}px`

  // Background grid (half-hour stripes) for visual rhythm.
  for (let i = 1; i <= HOURS_VISIBLE * 2; i++) {
    const line = document.createElement("div")
    line.className =
      "absolute top-0 bottom-0 w-px " +
      (i % 2 === 0 ? "bg-line" : "bg-line/40")
    line.style.left = `${(i * 30 * PX_PER_HOUR) / 60}px`
    track.appendChild(line)
  }

  const visEnd = viewStart + HOURS_VISIBLE * 60 * 60 * 1000

  for (const p of programmesForRow) {
    if (p.stop <= viewStart || p.start >= visEnd) continue
    const left = Math.max(0, timeToX(p.start))
    const right = Math.min(timeToX(p.stop), HOURS_VISIBLE * PX_PER_HOUR)
    const width = Math.max(2, right - left)
    const isLive = p.start <= Date.now() && p.stop > Date.now()

    const cell = document.createElement("button")
    cell.type = "button"
    cell.className =
      "absolute top-1 bottom-1 rounded-lg px-2 py-1 text-left outline-none " +
      "border transition-colors overflow-hidden " +
      (isLive
        ? "border-accent bg-accent-soft text-fg hover:bg-accent/20 focus-visible:bg-accent/20"
        : "border-line bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg") +
      " focus-visible:ring-2 focus-visible:ring-accent"
    cell.style.left = `${left}px`
    cell.style.width = `${width}px`
    cell.title = `${fmtTime(p.start)}–${fmtTime(p.stop)} · ${p.title}${p.desc ? "\n\n" + p.desc : ""}`
    cell.addEventListener("click", () => {
      window.location.href = `/livetv?channel=${encodeURIComponent(channel.id)}`
    })

    const titleLine = document.createElement("div")
    titleLine.className = "truncate text-xs font-medium"
    titleLine.textContent = p.title
    const timeLine = document.createElement("div")
    timeLine.className = "truncate text-2xs text-fg-3 tabular-nums"
    timeLine.textContent = `${fmtTime(p.start)}–${fmtTime(p.stop)}`
    cell.append(titleLine, timeLine)

    track.appendChild(cell)
  }

  row.appendChild(track)
  return row
}

function renderNowLine() {
  if (!bodyEl) return
  // Remove old indicator if any.
  bodyEl.querySelector("[data-now-line]")?.remove()
  const x = timeToX(Date.now())
  if (x < 0 || x > HOURS_VISIBLE * PX_PER_HOUR) return
  const line = document.createElement("div")
  line.dataset.nowLine = ""
  line.className =
    "absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-20"
  line.style.left = `${CHANNEL_COL_WIDTH + x}px`
  bodyEl.appendChild(line)
}

function render() {
  if (!gridEl || !bodyEl || !headerInner) return
  hideStatus()

  // Width of the grid content (channel col + visible time)
  const totalWidth = CHANNEL_COL_WIDTH + HOURS_VISIBLE * PX_PER_HOUR
  // Apply width to the inner sliding rail in case CSS hasn't.
  bodyEl.style.minWidth = `${totalWidth}px`
  headerInner.parentElement.style.minWidth = `${totalWidth}px`

  renderTimeHeader()

  const frag = document.createDocumentFragment()
  for (const ch of channels) {
    const key = (ch.tvgId || "").toLowerCase()
    const list = key ? programmes.get(key) || [] : []
    frag.appendChild(renderChannelRow(ch, list))
  }
  bodyEl.replaceChildren(frag)
  renderNowLine()

  // Add a tail "+ N more" hint if we capped channel count.
  if (channels.length === MAX_CHANNELS) {
    const tail = document.createElement("div")
    tail.className = "p-3 text-fg-3 text-xs text-center"
    tail.textContent = `Showing first ${MAX_CHANNELS} channels in this category. Filter to see others.`
    bodyEl.appendChild(tail)
  }

  try {
    window.SpatialNavigation?.makeFocusable?.()
  } catch {}
}

// ----------------------------
// Loaders
// ----------------------------
function pickChannels(cachedChannels) {
  const filtered = activeCat
    ? cachedChannels.filter((c) => (c.category || "") === activeCat)
    : cachedChannels.slice()
  // Drop channels with no tvg-id — they have no EPG match in XMLTV anyway.
  const withEpg = filtered.filter((c) => c.tvgId)
  return withEpg.slice(0, MAX_CHANNELS)
}

/**
 * Re-fetch the live channel list directly from the Xtream API. Mirrors the
 * shape stream.js produces (id, name, category, logo, tvgId), but doesn't
 * write to the cache — the assumption is that we're here precisely because
 * the cache write previously failed (quota). One round-trip for categories,
 * one for streams; most providers reply in under a second even for 50k+
 * channel libraries.
 */
async function fetchXtreamChannels() {
  // Categories first so we can resolve `category_id → name` for streams.
  const catRes = await fetch(buildApiUrl(creds, "get_live_categories"))
  if (!catRes.ok) throw new Error(`HTTP ${catRes.status}`)
  const catData = await catRes.json().catch(() => [])
  const catArr = Array.isArray(catData)
    ? catData
    : Array.isArray(catData?.categories)
    ? catData.categories
    : []
  const catMap = new Map(
    catArr
      .filter((c) => c && c.category_id != null)
      .map((c) => [
        String(c.category_id),
        String(c.category_name || "").trim(),
      ])
  )

  const r = await fetch(buildApiUrl(creds, "get_live_streams"))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json().catch(() => [])
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.streams)
    ? data.streams
    : []
  return arr
    .map((ch) => {
      const ids =
        (Array.isArray(ch.category_ids) &&
          ch.category_ids.length &&
          ch.category_ids) ||
        (ch.category_id != null ? [ch.category_id] : [])
      let category = String(ch.category_name || "").trim()
      if (!category && ids.length && catMap.size) {
        for (const id of ids) {
          const n = catMap.get(String(id))
          if (n) {
            category = n
            break
          }
        }
      }
      return {
        id: Number(ch.stream_id),
        name: String(ch.name || ""),
        category,
        logo: ch.stream_icon || null,
        tvgId: String(ch.epg_channel_id || "") || undefined,
      }
    })
    .filter((x) => x.id && x.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    )
}

async function loadEpgXml() {
  if (isLikelyM3USource(creds.host, creds.user, creds.pass)) {
    const url =
      (() => {
        try {
          return localStorage.getItem(`xt_m3u_epg:${activePlaylistId}`) || ""
        } catch {
          return ""
        }
      })()
    if (!url) {
      throw new Error(
        "This M3U playlist doesn't expose an EPG URL (`x-tvg-url`)."
      )
    }
    return fetchAndMaybeGunzip(url)
  }
  const base = fmtBase(creds.host, creds.port).replace(/\/+$/, "")
  const url =
    `${base}/xmltv.php?username=${encodeURIComponent(creds.user)}` +
    `&password=${encodeURIComponent(creds.pass)}`
  return fetchAndMaybeGunzip(url)
}

async function init() {
  showStatus("Loading…")

  creds = await loadCreds()
  if (!creds.host) {
    showStatus("No playlist selected. Add one from the header.")
    return
  }

  const active = await getActiveEntry()
  if (!active) {
    showStatus("No playlist selected. Add one from the header.")
    return
  }
  activePlaylistId = active._id
  try {
    activeCat = localStorage.getItem("xt_active_cat") || ""
  } catch {
    activeCat = ""
  }
  const isSentinelCat =
    activeCat === "__favorites__" || activeCat === "__recents__"
  if (isSentinelCat) activeCat = ""
  if (titleEl) {
    titleEl.textContent = activeCat
      ? `EPG · ${activeCat}`
      : "EPG · All categories"
  }

  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  let cached =
    getCached(activePlaylistId, isM3U ? "m3u" : "live")?.data || null

  if (!cached?.length) {
    if (isM3U) {
      showStatus(
        "Open Live TV first so the M3U channel list is loaded — it's too big to refetch from this page."
      )
      return
    }
    showStatus("Loading channels…")
    try {
      cached = await fetchXtreamChannels()
    } catch (e) {
      console.error("[epg] channel re-fetch failed:", e)
      showStatus("Couldn't load channels. Check your login or try Refresh.")
      return
    }
  }

  channels = pickChannels(cached)
  if (!channels.length) {
    showStatus(
      "No channels in this category have EPG ids (`tvg-id`). Try a different category."
    )
    return
  }

  viewStart = Math.max(
    roundHalfHourFloor(Date.now() - 30 * 60 * 1000),
    roundHalfHourFloor(Date.now())
  )
  // Allow ~30 min of "what just ended" to remain visible.
  viewStart = roundHalfHourFloor(Date.now() - 30 * 60 * 1000)

  showStatus("Loading EPG (this can take a moment for large providers)…")

  try {
    const xml = await loadEpgXml()
    parseXmlTv(xml)
  } catch (e) {
    console.error("[epg] load failed:", e)
    showStatus(
      "Couldn't load EPG. Refresh, or check that your provider serves XMLTV."
    )
    return
  }

  if (!programmes.size) {
    showStatus(
      "EPG loaded, but no programmes matched any channel id. Provider might use different `tvg-id`s than the playlist."
    )
    return
  }

  render()
}

refreshBtn?.addEventListener("click", () => {
  programmes.clear()
  init()
})

// Re-render every minute so the now-line creeps right and the live highlight
// rolls onto the next programme.
setInterval(() => {
  if (programmes.size && channels.length) renderNowLine()
}, 60 * 1000)

document.addEventListener("xt:active-changed", () => {
  programmes.clear()
  init()
})

init()
