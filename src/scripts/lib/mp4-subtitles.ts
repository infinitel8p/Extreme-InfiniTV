// Embedded tx3g subtitle probing + extraction for progressive MP4 VOD, via coalesced HTTP range reads.

import * as MP4Box from "mp4box"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { log, redactUrl } from "@/scripts/lib/log.js"
import { combineLanguageAndName } from "@/scripts/lib/audio-tracks.js"

export interface SubtitleCue {
  startSeconds: number
  endSeconds: number
  text: string
}

export interface Mp4TextTrackInfo {
  trackId: number
  language: string
  label: string
  sampleCount: number
}

export interface Mp4AudioTrackInfo {
  trackId: number
  /** Audio-only index; maps to ffmpeg's `-map 0:a:<index>`. */
  index: number
  language: string
  name?: string | null
  codec: string
}

export interface Mp4SubtitleSession {
  tracks: Mp4TextTrackInfo[]
  extract(
    trackId: number,
    opts: {
      startAtSeconds?: number
      signal?: AbortSignal
      onCues: (cues: SubtitleCue[]) => void
    },
  ): Promise<void>
}

export interface ByteRange {
  start: number
  end: number
}

interface RawTextTrack {
  trackId: number
  language: string
  sampleCount: number
  name?: string | null
}

const MP4_URL_PATTERN = /\.(mp4|m4v|mov)$/i
const MP4_MIME_TYPES = new Set(["video/mp4", "video/quicktime"])
const HEAD_PROBE_BYTES = 65536
const MOOV_SIZE_CAP_BYTES = 64 * 1024 * 1024
const RANGE_COALESCE_MAX_GAP_BYTES = 262144
const EXTRACT_FETCH_CONCURRENCY = 3
const MAX_SUBTITLE_SAMPLE_BYTES = 512 * 1024
const MAX_EXTRACTION_TOTAL_BYTES = 8 * 1024 * 1024
const UTF16_DECODE_CHUNK_UNITS = 8192

export function isMp4SubtitleCapableUrl(url: string, mimeType?: string | null): boolean {
  const mime = mimeType?.toLowerCase()
  if (mime && MP4_MIME_TYPES.has(mime)) return true
  if (typeof url !== "string") return false
  const withoutQuery = url.split(/[?#]/)[0]
  return MP4_URL_PATTERN.test(withoutQuery)
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

async function rangedFetch(url: string, start: number, end: number, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = { headers: { Range: `bytes=${start}-${end}` }, signal }
  return isHttpUrl(url) ? providerFetch(url, { ...init, logKind: "media" }) : fetch(url, init)
}

function parseTotalSizeFromContentRange(contentRange: string | null): number | null {
  if (!contentRange) return null
  const match = /\/(\d+)\s*$/.exec(contentRange)
  if (!match) return null
  const totalSize = Number(match[1])
  return Number.isFinite(totalSize) && totalSize > 0 ? totalSize : null
}

/** Top-level ISO-BMFF box header at an offset; handles 64-bit largesize. */
export function parseBoxHeader(
  view: DataView,
  offsetInView: number,
): { type: string; size: number; headerSize: number } | null {
  if (offsetInView < 0 || offsetInView + 8 > view.byteLength) return null
  const size32 = view.getUint32(offsetInView)
  const type = String.fromCharCode(
    view.getUint8(offsetInView + 4),
    view.getUint8(offsetInView + 5),
    view.getUint8(offsetInView + 6),
    view.getUint8(offsetInView + 7),
  )
  if (size32 === 1) {
    if (offsetInView + 16 > view.byteLength) return null
    const size = Number(view.getBigUint64(offsetInView + 8))
    return { type, size, headerSize: 16 }
  }
  if (size32 !== 0 && size32 < 8) return null
  return { type, size: size32, headerSize: 8 }
}

interface MoovLocation {
  prefixBytes: ArrayBuffer
  moovBytes: ArrayBuffer
  /** Append position for moovBytes: mp4box stalls on a gap, so the moov follows the prefix directly. */
  moovAppendOffset: number
}

// Content-Range is CORS-hidden on most panels, so the walk tolerates an unknown file size and stops on 416 or a short body.
async function fetchBoxHeaderBytes(
  url: string,
  offset: number,
  totalSize: number | null,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  const headerEnd = totalSize != null ? Math.min(offset + 15, totalSize - 1) : offset + 15
  const headerResponse = await rangedFetch(url, offset, headerEnd, signal)
  if (headerResponse.status === 416) {
    log.warn("[xt:mp4-subtitles] reached end of file while walking boxes")
    return null
  }
  if (headerResponse.status !== 206) {
    log.warn("[xt:mp4-subtitles] server did not honor range request while walking boxes")
    return null
  }
  const headerBuffer = await headerResponse.arrayBuffer()
  if (headerBuffer.byteLength < 8) {
    log.warn("[xt:mp4-subtitles] reached end of file while walking boxes")
    return null
  }
  return headerBuffer
}

async function locateMoov(url: string, signal?: AbortSignal): Promise<MoovLocation | null> {
  const headResponse = await rangedFetch(url, 0, HEAD_PROBE_BYTES - 1, signal)
  if (headResponse.status !== 206) {
    log.warn("[xt:mp4-subtitles] server did not honor range request, skipping subtitle probe", redactUrl(url))
    return null
  }
  const totalSize = parseTotalSizeFromContentRange(headResponse.headers.get("content-range"))
  const headBuffer = await headResponse.arrayBuffer()
  const headView = new DataView(headBuffer)

  let offset = 0
  let ftypBytes: ArrayBuffer | null = null
  for (;;) {
    if (totalSize != null && offset >= totalSize) break
    let header = offset + 16 <= headBuffer.byteLength ? parseBoxHeader(headView, offset) : null
    if (!header) {
      const headerBuffer = await fetchBoxHeaderBytes(url, offset, totalSize, signal)
      if (!headerBuffer) return null
      header = parseBoxHeader(new DataView(headerBuffer), 0)
    }
    if (!header) {
      log.warn("[xt:mp4-subtitles] failed to parse a top-level box header")
      return null
    }
    let boxSize = header.size
    if (boxSize === 0) {
      if (totalSize != null) {
        boxSize = totalSize - offset
      } else if (header.type !== "moov") {
        log.warn("[xt:mp4-subtitles] non-moov box extends to EOF with an unknown file size, no moov can follow")
        return null
      } else {
        log.warn("[xt:mp4-subtitles] moov box extends to EOF but the file size is unknown")
        return null
      }
    }
    if (!Number.isFinite(boxSize) || boxSize <= 0) {
      log.warn("[xt:mp4-subtitles] encountered an invalid box size while walking")
      return null
    }
    if (header.type === "moov") {
      if (boxSize > MOOV_SIZE_CAP_BYTES) {
        log.warn("[xt:mp4-subtitles] moov box exceeds the size cap, skipping subtitle extraction")
        return null
      }
      const moovEnd = offset + boxSize - 1
      const moovResponse = await rangedFetch(url, offset, moovEnd, signal)
      if (moovResponse.status !== 206) {
        log.warn("[xt:mp4-subtitles] server did not honor range request while fetching moov")
        return null
      }
      const moovBytes = await moovResponse.arrayBuffer()
      if (ftypBytes) return { prefixBytes: ftypBytes, moovBytes, moovAppendOffset: ftypBytes.byteLength }
      return { prefixBytes: headBuffer, moovBytes, moovAppendOffset: offset }
    }
    if (header.type === "ftyp" && offset + boxSize <= headBuffer.byteLength) {
      ftypBytes = headBuffer.slice(offset, offset + boxSize)
    }
    offset += boxSize
  }
  log.warn("[xt:mp4-subtitles] no moov box found in file", redactUrl(url))
  return null
}

type Mp4BoxBufferLike = ArrayBuffer & { fileStart: number }

function withFileStart(buffer: ArrayBuffer, fileStart: number): Mp4BoxBufferLike {
  return Object.assign(buffer, { fileStart }) as Mp4BoxBufferLike
}

function parseTracksFromMoov(
  prefixBytes: ArrayBuffer,
  moovBytes: ArrayBuffer,
  moovAppendOffset: number,
): { mp4boxFile: MP4Box.ISOFile; movie: MP4Box.Movie } | null {
  const mp4boxFile = MP4Box.createFile(false)
  let movie: MP4Box.Movie | null = null
  mp4boxFile.onReady = (info) => { movie = info }
  mp4boxFile.appendBuffer(withFileStart(prefixBytes, 0) as unknown as MP4Box.MP4BoxBuffer)
  mp4boxFile.appendBuffer(withFileStart(moovBytes, moovAppendOffset) as unknown as MP4Box.MP4BoxBuffer)
  if (!movie) return null
  return { mp4boxFile, movie }
}

interface ParsedMp4Tracks {
  mp4boxFile: MP4Box.ISOFile
  movie: MP4Box.Movie
}

// Shared cache for subtitle + audio probes on the same file; FIFO-capped.
const PARSED_TRACKS_CACHE_MAX_ENTRIES = 4
const parsedTracksCache = new Map<string, Promise<ParsedMp4Tracks | null>>()

async function parseMp4TracksCached(url: string, signal?: AbortSignal): Promise<ParsedMp4Tracks | null> {
  const cached = parsedTracksCache.get(url)
  if (cached) return cached
  const parsePromise = (async () => {
    const moovLocation = await locateMoov(url, signal)
    if (!moovLocation) return null
    return parseTracksFromMoov(moovLocation.prefixBytes, moovLocation.moovBytes, moovLocation.moovAppendOffset)
  })()
  if (parsedTracksCache.size >= PARSED_TRACKS_CACHE_MAX_ENTRIES) {
    const oldestUrl = parsedTracksCache.keys().next().value
    if (oldestUrl !== undefined) parsedTracksCache.delete(oldestUrl)
  }
  parsedTracksCache.set(url, parsePromise)
  const parsed = await parsePromise
  if (!parsed) parsedTracksCache.delete(url)
  return parsed
}

function textTracksFromMovie(movie: MP4Box.Movie): RawTextTrack[] {
  return movie.tracks
    .filter((track) => {
      const trackType = track.type as string | undefined
      return trackType === "subtitles" || trackType === "text" || track.codec?.toLowerCase().startsWith("tx3g")
    })
    .map((track) => ({ trackId: track.id, language: track.language, sampleCount: track.nb_samples }))
}

function audioTracksFromMovie(movie: MP4Box.Movie): Mp4AudioTrackInfo[] {
  return movie.tracks
    .filter((track) => (track.type as string | undefined) === "audio")
    .map((track, index) => ({
      trackId: track.id,
      index,
      language: track.language,
      codec: track.codec,
    }))
}

function languageLabelFor(languageCode: string, displayNames: Intl.DisplayNames | null): string | null {
  if (!languageCode || languageCode === "und") return null
  if (!displayNames) return languageCode
  try {
    return displayNames.of(languageCode) || languageCode
  } catch {
    return languageCode
  }
}

/** Falls back to "Unknown"; duplicate labels get " 2", " 3" suffixes. */
export function buildTrackLabels(rawTracks: RawTextTrack[], locale: string): Mp4TextTrackInfo[] {
  let displayNames: Intl.DisplayNames | null = null
  try {
    displayNames = new Intl.DisplayNames([locale, "en"], { type: "language" })
  } catch {
    displayNames = null
  }
  const seenLabelCounts = new Map<string, number>()
  return rawTracks.map((rawTrack) => {
    const languageCode = (rawTrack.language || "").trim().toLowerCase()
    const languageDisplay = languageLabelFor(languageCode, displayNames)
    const trackName = rawTrack.name?.trim()
    const baseLabel = combineLanguageAndName(languageDisplay, trackName) || "Unknown"
    const occurrence = (seenLabelCounts.get(baseLabel) || 0) + 1
    seenLabelCounts.set(baseLabel, occurrence)
    return {
      trackId: rawTrack.trackId,
      language: rawTrack.language,
      label: occurrence > 1 ? `${baseLabel} ${occurrence}` : baseLabel,
      sampleCount: rawTrack.sampleCount,
    }
  })
}

/** Merge sample ranges with gaps <= maxGapBytes; end is exclusive. */
export function coalesceSampleRanges(
  samples: Array<{ offset: number; size: number }>,
  maxGapBytes: number,
): ByteRange[] {
  if (samples.length === 0) return []
  const sorted = [...samples].sort((sampleA, sampleB) => sampleA.offset - sampleB.offset)
  const ranges: ByteRange[] = []
  let current: ByteRange = { start: sorted[0].offset, end: sorted[0].offset + sorted[0].size }
  for (let i = 1; i < sorted.length; i++) {
    const sample = sorted[i]
    const sampleEnd = sample.offset + sample.size
    if (sample.offset - current.end <= maxGapBytes) {
      current.end = Math.max(current.end, sampleEnd)
    } else {
      ranges.push(current)
      current = { start: sample.offset, end: sampleEnd }
    }
  }
  ranges.push(current)
  return ranges
}

/** Rotate ranges to start at the one covering startAtSeconds, wrapping after. */
export function orderRangesFromTime(
  ranges: ByteRange[],
  samples: Array<{ offset: number; cts: number; duration: number; timescale: number }>,
  startAtSeconds = 0,
): ByteRange[] {
  if (ranges.length === 0 || startAtSeconds <= 0) return ranges
  const startingSample = samples.find((sample) => (sample.cts + sample.duration) / sample.timescale >= startAtSeconds)
  if (!startingSample) return ranges
  const startRangeIndex = ranges.findIndex(
    (range) => startingSample.offset >= range.start && startingSample.offset < range.end,
  )
  if (startRangeIndex <= 0) return ranges
  return [...ranges.slice(startRangeIndex), ...ranges.slice(0, startRangeIndex)]
}

function decodeUtf16BE(bytes: Uint8Array): string {
  const codeUnits: number[] = []
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    codeUnits.push((bytes[i] << 8) | bytes[i + 1])
  }
  let result = ""
  for (let i = 0; i < codeUnits.length; i += UTF16_DECODE_CHUNK_UNITS) {
    result += String.fromCharCode(...codeUnits.slice(i, i + UTF16_DECODE_CHUNK_UNITS))
  }
  return result
}

/** uint16 BE length + text (UTF-8 or BOM UTF-16); trailing style boxes ignored; empty -> null. */
export function decodeTx3gSample(bytes: Uint8Array): string | null {
  if (bytes.length < 2) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const declaredLength = view.getUint16(0)
  if (declaredLength === 0) return null
  const textLength = Math.min(declaredLength, bytes.length - 2)
  const textBytes = bytes.subarray(2, 2 + textLength)
  let text: string
  if (textBytes.length >= 2 && textBytes[0] === 0xfe && textBytes[1] === 0xff) {
    text = decodeUtf16BE(textBytes.subarray(2))
  } else if (textBytes.length >= 2 && textBytes[0] === 0xff && textBytes[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(textBytes.subarray(2))
  } else {
    text = new TextDecoder("utf-8").decode(textBytes)
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

async function extractTrackCues(
  url: string,
  mp4boxFile: MP4Box.ISOFile,
  trackId: number,
  opts: {
    startAtSeconds?: number
    signal?: AbortSignal
    onCues: (cues: SubtitleCue[]) => void
  },
): Promise<void> {
  const rawSamples = mp4boxFile.getTrackSamplesInfo(trackId)
  if (!rawSamples || rawSamples.length === 0) return
  const samples = rawSamples.filter((sample) => sample.size <= MAX_SUBTITLE_SAMPLE_BYTES)
  if (samples.length < rawSamples.length) {
    log.warn("[xt:mp4-subtitles] skipping oversized subtitle samples", { skipped: rawSamples.length - samples.length })
  }
  if (samples.length === 0) return
  const ranges = coalesceSampleRanges(samples, RANGE_COALESCE_MAX_GAP_BYTES)
  const orderedRanges = orderRangesFromTime(ranges, samples, opts.startAtSeconds ?? 0)
  const signal = opts.signal

  let rangeCursor = 0
  let totalBytesFetched = 0
  let budgetExceeded = false
  const workerCount = Math.min(EXTRACT_FETCH_CONCURRENCY, orderedRanges.length)
  const workers = Array.from({ length: workerCount }, () =>
    (async () => {
      while (rangeCursor < orderedRanges.length) {
        if (signal?.aborted) return
        if (totalBytesFetched >= MAX_EXTRACTION_TOTAL_BYTES) {
          if (!budgetExceeded) {
            budgetExceeded = true
            log.warn("[xt:mp4-subtitles] extraction byte budget exceeded, stopping early")
          }
          return
        }
        const range = orderedRanges[rangeCursor++]
        let response: Response
        try {
          response = await rangedFetch(url, range.start, range.end - 1, signal)
        } catch (error) {
          if (signal?.aborted) return
          log.warn("[xt:mp4-subtitles] range fetch failed during extraction:", error)
          return
        }
        if (signal?.aborted) return
        if (response.status !== 206) {
          log.warn("[xt:mp4-subtitles] server did not honor range request during extraction, stopping")
          return
        }
        const rangeBytes = new Uint8Array(await response.arrayBuffer())
        totalBytesFetched += rangeBytes.byteLength
        const cues: SubtitleCue[] = []
        for (const sample of samples) {
          if (sample.offset < range.start || sample.offset + sample.size > range.end) continue
          const sampleStart = sample.offset - range.start
          const sampleBytes = rangeBytes.subarray(sampleStart, sampleStart + sample.size)
          const text = decodeTx3gSample(sampleBytes)
          if (text == null) continue
          cues.push({
            startSeconds: sample.cts / sample.timescale,
            endSeconds: (sample.cts + sample.duration) / sample.timescale,
            text,
          })
        }
        if (cues.length > 0) {
          cues.sort((cueA, cueB) => cueA.startSeconds - cueB.startSeconds)
          opts.onCues(cues)
        }
      }
    })(),
  )
  await Promise.all(workers)
}

export async function openMp4SubtitleSession(
  url: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Mp4SubtitleSession | null> {
  if (!isMp4SubtitleCapableUrl(url)) return null
  try {
    const parsed = await parseMp4TracksCached(url, opts.signal)
    if (!parsed) return null
    const rawTextTracks = textTracksFromMovie(parsed.movie)
    if (rawTextTracks.length === 0) {
      log.warn("[xt:mp4-subtitles] no tx3g text tracks found", redactUrl(url))
      return null
    }
    const tracks = buildTrackLabels(rawTextTracks, getActiveLocale())
    return {
      tracks,
      extract: (trackId, extractOpts) => extractTrackCues(url, parsed.mp4boxFile, trackId, extractOpts),
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    log.warn("[xt:mp4-subtitles] failed to open subtitle session:", error)
    return null
  }
}

/** Shares its moov parse with openMp4SubtitleSession. */
export async function listMp4AudioTracks(
  url: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Mp4AudioTrackInfo[]> {
  if (!isMp4SubtitleCapableUrl(url)) return []
  try {
    const parsed = await parseMp4TracksCached(url, opts.signal)
    if (!parsed) return []
    return audioTracksFromMovie(parsed.movie)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    log.warn("[xt:mp4-subtitles] failed to list audio tracks:", error)
    return []
  }
}
