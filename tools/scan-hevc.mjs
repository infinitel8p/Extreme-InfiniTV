// Scan a playlist for HEVC channels, so the playback-failure panel can be
// tested against real channels.
//
// Usage:
//   node tools/scan-hevc.mjs                         # active playlist from the app's Tauri store
//   node tools/scan-hevc.mjs --entry "Strong"        # pick a saved playlist by title substring
//   node tools/scan-hevc.mjs --xtream http://host:port --user U --pass P
//   node tools/scan-hevc.mjs --m3u <url>
//   node tools/scan-hevc.mjs --probe                 # also probe matched streams (default cap 12)
//   node tools/scan-hevc.mjs --probe --max 30        # raise probe cap
//   node tools/scan-hevc.mjs --probe --all 50        # probe the FIRST 50 channels regardless of name
//
// Probing fetches each stream once (playlist + ~256 KB of the first segment),
// sequentially with a small delay, and reports the actual video codec from
// the HLS CODECS attribute, the MPEG-TS PMT, or fMP4 sample-entry fourccs.

import { readFileSync } from "node:fs"
import { join } from "node:path"

const HEVC_NAME_RX = /(?:\bhevc\b|\bhvec\b|\bh\.?\s?265\b|\bx\.?265\b)/i
const PROBE_BYTES = 256 * 1024
const PROBE_DELAY_MS = 400
const FETCH_TIMEOUT_MS = 12_000

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 ? args[idx + 1] : null
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------
function loadStoreEntries() {
  const storePath = join(
    process.env.APPDATA || "",
    "com.infinitel8p.xtream",
    ".xtream.creds.json"
  )
  try {
    const store = JSON.parse(readFileSync(storePath, "utf8"))
    let playlists = store.xt_playlists
    if (typeof playlists === "string") playlists = JSON.parse(playlists)
    return playlists || null
  } catch {
    return null
  }
}

function resolveSource() {
  const xtreamUrl = opt("xtream")
  if (xtreamUrl) {
    return {
      type: "xtream",
      base: xtreamUrl.replace(/\/+$/, ""),
      user: opt("user") || "",
      pass: opt("pass") || "",
      title: xtreamUrl,
    }
  }
  const m3uUrl = opt("m3u")
  if (m3uUrl) return { type: "m3u", url: m3uUrl, title: m3uUrl }

  const playlists = loadStoreEntries()
  if (!playlists?.entries?.length) {
    console.error(
      "No saved playlists found. Pass --xtream <url> --user <u> --pass <p> or --m3u <url>."
    )
    process.exit(1)
  }
  const wanted = opt("entry")
  const entry = wanted
    ? playlists.entries.find((candidate) =>
        (candidate.title || "").toLowerCase().includes(wanted.toLowerCase())
      )
    : playlists.entries.find((candidate) => candidate._id === playlists.selectedId)
  if (!entry) {
    console.error(`No playlist matching "${wanted}". Saved playlists:`)
    for (const candidate of playlists.entries) {
      console.error(`  - ${candidate.title} (${candidate.type})`)
    }
    process.exit(1)
  }
  if (entry.type === "xtream") {
    return {
      type: "xtream",
      base: String(entry.serverUrl || "").replace(/\/+$/, ""),
      user: entry.username,
      pass: entry.password,
      title: entry.title,
    }
  }
  if (entry.type === "m3u") return { type: "m3u", url: entry.url, title: entry.title }
  console.error(
    `Playlist "${entry.title}" is ${entry.type}; only xtream / remote m3u are scannable here.`
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Channel listing
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function listChannels(source) {
  if (source.type === "xtream") {
    const api = `${source.base}/player_api.php?username=${encodeURIComponent(source.user)}&password=${encodeURIComponent(source.pass)}&action=get_live_streams`
    const response = await fetchWithTimeout(api)
    if (!response.ok) throw new Error(`get_live_streams responded ${response.status}`)
    const list = await response.json()
    return list.map((stream) => ({
      id: stream.stream_id,
      name: String(stream.name || ""),
      url: `${source.base}/live/${encodeURIComponent(source.user)}/${encodeURIComponent(source.pass)}/${stream.stream_id}.m3u8`,
    }))
  }
  const response = await fetchWithTimeout(source.url)
  if (!response.ok) throw new Error(`M3U fetch responded ${response.status}`)
  const text = await response.text()
  const channels = []
  let pendingName = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith("#EXTINF:")) {
      pendingName = line.slice(line.lastIndexOf(",") + 1).trim()
    } else if (line && !line.startsWith("#")) {
      channels.push({ id: channels.length + 1, name: pendingName || line, url: line })
      pendingName = null
    }
  }
  return channels
}

// ---------------------------------------------------------------------------
// Codec sniffing
// ---------------------------------------------------------------------------
const TS_STREAM_TYPES = {
  0x01: "MPEG-1 video",
  0x02: "MPEG-2 video",
  0x1b: "H.264",
  0x24: "HEVC",
  0x51: "AV1 (private)",
}

function sniffTsVideoCodec(buf) {
  let offset = -1
  for (let i = 0; i < Math.min(buf.length - 376, 188); i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) {
      offset = i
      break
    }
  }
  if (offset < 0) return null
  const pmtPids = new Set()
  const videoTypes = new Set()
  for (let p = offset; p + 188 <= buf.length; p += 188) {
    if (buf[p] !== 0x47) continue
    const pusi = (buf[p + 1] & 0x40) !== 0
    const pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2]
    const adaptation = (buf[p + 3] >> 4) & 0x3
    let payload = p + 4
    if (adaptation & 0x2) payload += 1 + buf[p + 4]
    if (!(adaptation & 0x1) || !pusi || payload >= p + 188) continue
    const section = payload + 1 + buf[payload]
    if (section >= p + 188) continue
    const tableId = buf[section]
    const sectionLength = ((buf[section + 1] & 0x0f) << 8) | buf[section + 2]
    if (pid === 0 && tableId === 0x00) {
      // PAT: program_number(2) + program_map_PID(2) entries after the 8-byte header
      const end = Math.min(section + 3 + sectionLength - 4, p + 188)
      for (let entry = section + 8; entry + 4 <= end; entry += 4) {
        const programNumber = (buf[entry] << 8) | buf[entry + 1]
        const mapPid = ((buf[entry + 2] & 0x1f) << 8) | buf[entry + 3]
        if (programNumber !== 0) pmtPids.add(mapPid)
      }
    } else if (pmtPids.has(pid) && tableId === 0x02) {
      const programInfoLength = ((buf[section + 10] & 0x0f) << 8) | buf[section + 11]
      const end = Math.min(section + 3 + sectionLength - 4, p + 188)
      let entry = section + 12 + programInfoLength
      while (entry + 5 <= end) {
        const streamType = buf[entry]
        const esInfoLength = ((buf[entry + 3] & 0x0f) << 8) | buf[entry + 4]
        if (TS_STREAM_TYPES[streamType]) videoTypes.add(TS_STREAM_TYPES[streamType])
        entry += 5 + esInfoLength
      }
    }
    if (videoTypes.size) break
  }
  if (videoTypes.size) return [...videoTypes].join("+")
  return pmtPids.size ? "TS (PMT video type not found in sample)" : null
}

function sniffMp4VideoCodec(buf) {
  const haystack = buf.toString("latin1")
  for (const fourcc of ["hvc1", "hev1", "avc1", "av01", "vp09"]) {
    if (haystack.includes(fourcc)) return fourcc
  }
  return null
}

async function readBodyPrefix(response, maxBytes) {
  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    received += value.byteLength
  }
  try {
    await reader.cancel()
  } catch {}
  return Buffer.concat(chunks)
}

async function probeStream(url, depth = 0) {
  if (depth > 2) return { codec: null, via: "too many playlist levels" }
  const response = await fetchWithTimeout(url)
  if (!response.ok) return { codec: null, via: `HTTP ${response.status}` }
  const contentType = (response.headers.get("content-type") || "").toLowerCase()
  const looksLikePlaylist =
    contentType.includes("mpegurl") || /\.m3u8(\?|$)/i.test(response.url || url)

  if (looksLikePlaylist) {
    const text = await response.text()
    const codecsAttr = /#EXT-X-STREAM-INF:[^\n]*CODECS="([^"]+)"/i.exec(text)?.[1]
    if (codecsAttr) {
      const video = codecsAttr
        .split(",")
        .map((codec) => codec.trim())
        .find((codec) => /^(hvc1|hev1|avc1|av01|vp09|mp4v|hevc|h265)/i.test(codec))
      return { codec: video || codecsAttr, via: "manifest CODECS" }
    }
    // Master without CODECS or media playlist: descend to the first URI line
    const firstUri = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"))
    if (!firstUri) return { codec: null, via: "empty playlist" }
    return probeStream(new URL(firstUri, response.url || url).toString(), depth + 1)
  }

  const buf = await readBodyPrefix(response, PROBE_BYTES)
  if (!buf.length) return { codec: null, via: "no bytes" }
  const tsCodec = sniffTsVideoCodec(buf)
  if (tsCodec) return { codec: tsCodec, via: "TS PMT" }
  const mp4Codec = sniffMp4VideoCodec(buf)
  if (mp4Codec) return { codec: mp4Codec, via: "fMP4 fourcc" }
  return { codec: null, via: `unrecognized payload (${contentType || "no content-type"})` }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const source = resolveSource()
console.log(`Scanning: ${source.title} (${source.type})`)
const channels = await listChannels(source)
console.log(`Channels: ${channels.length}`)

const tagged = channels.filter((channel) => HEVC_NAME_RX.test(channel.name))
console.log(`\nName-tagged HEVC channels: ${tagged.length}`)
for (const channel of tagged.slice(0, 100)) {
  console.log(`  [${channel.id}] ${channel.name}`)
}
if (tagged.length > 100) console.log(`  ... and ${tagged.length - 100} more`)

if (flag("probe")) {
  const all = Number(opt("all") || 0)
  const max = Number(opt("max") || 12)
  const targets = all > 0 ? channels.slice(0, all) : tagged.slice(0, max)
  if (all === 0 && tagged.length > max) {
    console.log(`\nProbing first ${max} of ${tagged.length} matches (raise with --max N)`)
  }
  console.log(`\nProbing ${targets.length} stream(s)...`)
  for (const channel of targets) {
    let result
    try {
      result = await probeStream(channel.url)
    } catch (error) {
      result = { codec: null, via: String(error?.message || error) }
    }
    const verdict = result.codec
      ? /hvc1|hev1|hevc|h265/i.test(result.codec)
        ? `HEVC  (${result.codec}, ${result.via})`
        : `${result.codec} (${result.via})`
      : `?     (${result.via})`
    console.log(`  [${channel.id}] ${verdict}  ${channel.name}`)
    await sleep(PROBE_DELAY_MS)
  }
}
