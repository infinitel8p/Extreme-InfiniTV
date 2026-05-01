// Probe a live-stream URL and report what the provider returns: HTTP status,
// content-type, and (for HLS) the parsed master/media playlist plus a HEAD
// against the first segment. Used by the "Test stream" context-menu action
// to triage "this channel doesn't play" reports.
import { providerFetch } from "@/scripts/lib/provider-fetch.js"

const FETCH_TIMEOUT_MS = 12_000

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label || "Request"} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ref
  }
}

function parseHlsPlaylist(text) {
  const lines = text.split(/\r?\n/)
  const isMaster = lines.some((line) => /^#EXT-X-STREAM-INF/i.test(line))
  const variants = []
  const segments = []
  let pendingSegmentDuration = 0
  let pendingVariantInfo = null
  let targetDuration = 0
  let totalDuration = 0

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim()
    if (!line) continue

    if (/^#EXT-X-TARGETDURATION:/i.test(line)) {
      targetDuration = Number(line.split(":")[1]) || 0
      continue
    }
    if (/^#EXTINF:/i.test(line)) {
      const after = line.slice("#EXTINF:".length)
      pendingSegmentDuration = parseFloat(after) || 0
      totalDuration += pendingSegmentDuration
      continue
    }
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const attrs = line.slice("#EXT-X-STREAM-INF:".length)
      pendingVariantInfo = {
        bandwidth: Number(/BANDWIDTH=(\d+)/i.exec(attrs)?.[1] || 0),
        resolution: /RESOLUTION=([^,]+)/i.exec(attrs)?.[1] || "",
        codecs: /CODECS="([^"]+)"/i.exec(attrs)?.[1] || "",
      }
      continue
    }
    if (line.startsWith("#")) continue

    if (isMaster && pendingVariantInfo) {
      variants.push({ ...pendingVariantInfo, uri: line })
      pendingVariantInfo = null
    } else {
      segments.push({ duration: pendingSegmentDuration, uri: line })
      pendingSegmentDuration = 0
    }
  }

  return {
    isMaster,
    variants,
    segments,
    targetDuration,
    totalDuration,
  }
}

async function headOrGet(url) {
  const start = performance.now()
  try {
    const response = await withTimeout(
      providerFetch(url, { method: "HEAD" }),
      FETCH_TIMEOUT_MS,
      "HEAD"
    )
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || "",
      contentType: response.headers.get("content-type") || "",
      contentLength: Number(response.headers.get("content-length") || 0),
      latencyMs: Math.round(performance.now() - start),
      method: "HEAD",
    }
  } catch (headError) {
    // Some HLS servers reject HEAD outright. Fall back to a tiny ranged GET
    // so the diagnostic still produces something useful.
    try {
      const response = await withTimeout(
        providerFetch(url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
        }),
        FETCH_TIMEOUT_MS,
        "GET"
      )
      return {
        ok: response.ok || response.status === 206,
        status: response.status,
        statusText: response.statusText || "",
        contentType: response.headers.get("content-type") || "",
        contentLength:
          Number(response.headers.get("content-length") || 0) ||
          Number(
            (response.headers.get("content-range") || "").match(/\/(\d+)\s*$/)?.[1] ||
              0
          ),
        latencyMs: Math.round(performance.now() - start),
        method: "GET (range)",
        fallback: String(headError?.message || headError),
      }
    } catch (getError) {
      return {
        ok: false,
        status: 0,
        statusText: "",
        contentType: "",
        contentLength: 0,
        latencyMs: Math.round(performance.now() - start),
        method: "HEAD",
        error: String(getError?.message || getError),
      }
    }
  }
}

/**
 * Probe a stream URL. Designed to be paged into the dialog as it makes
 * progress, so the consumer can render partial results.
 *
 * @param {string} url
 * @param {(stage: object) => void} [onUpdate]
 * @returns {Promise<object>}
 */
export async function diagnoseStream(url, onUpdate) {
  const report = {
    url,
    startedAt: Date.now(),
    head: null,
    playlist: null,
    firstSegment: null,
    error: "",
  }

  function emit() {
    try {
      onUpdate?.(JSON.parse(JSON.stringify(report)))
    } catch {}
  }

  emit()

  report.head = await headOrGet(url)
  emit()

  const looksLikeHls =
    /\.m3u8($|\?)/i.test(url) ||
    /mpegurl/i.test(report.head.contentType || "")

  if (looksLikeHls) {
    try {
      const start = performance.now()
      const response = await withTimeout(
        providerFetch(url),
        FETCH_TIMEOUT_MS,
        "Playlist GET"
      )
      const text = await response.text()
      const parsed = parseHlsPlaylist(text)
      report.playlist = {
        ok: response.ok,
        status: response.status,
        latencyMs: Math.round(performance.now() - start),
        bytes: text.length,
        isMaster: parsed.isMaster,
        variantCount: parsed.variants.length,
        segmentCount: parsed.segments.length,
        targetDuration: parsed.targetDuration,
        totalDuration: parsed.totalDuration,
        topVariant: parsed.variants[0]
          ? {
              bandwidth: parsed.variants[0].bandwidth,
              resolution: parsed.variants[0].resolution,
              codecs: parsed.variants[0].codecs,
            }
          : null,
      }
      emit()

      let firstSegmentUri = parsed.segments[0]?.uri
      let firstSegmentDuration = parsed.segments[0]?.duration || 0

      // For a master playlist, descend into the top variant first.
      if (parsed.isMaster && parsed.variants[0]?.uri) {
        const variantUrl = resolveUrl(url, parsed.variants[0].uri)
        try {
          const variantResp = await withTimeout(
            providerFetch(variantUrl),
            FETCH_TIMEOUT_MS,
            "Variant GET"
          )
          const variantText = await variantResp.text()
          const variantParsed = parseHlsPlaylist(variantText)
          firstSegmentUri = variantParsed.segments[0]?.uri
          firstSegmentDuration = variantParsed.segments[0]?.duration || 0
          report.playlist.descendedVariant = {
            url: variantUrl,
            segmentCount: variantParsed.segments.length,
            targetDuration: variantParsed.targetDuration,
          }
          emit()
        } catch (variantErr) {
          report.playlist.descendedVariant = {
            url: variantUrl,
            error: String(variantErr?.message || variantErr),
          }
          emit()
        }
      }

      if (firstSegmentUri) {
        const segmentUrl = resolveUrl(
          parsed.isMaster && report.playlist.descendedVariant
            ? report.playlist.descendedVariant.url
            : url,
          firstSegmentUri
        )
        const segHead = await headOrGet(segmentUrl)
        report.firstSegment = {
          ...segHead,
          url: segmentUrl,
          declaredDuration: firstSegmentDuration,
        }
        emit()
      }
    } catch (playlistErr) {
      report.playlist = {
        ok: false,
        error: String(playlistErr?.message || playlistErr),
      }
      emit()
    }
  }

  report.finishedAt = Date.now()
  emit()
  return report
}

export function summarizeReport(report) {
  if (!report) return { verdict: "unknown", reason: "" }
  const head = report.head
  if (!head?.ok) {
    return {
      verdict: "fail",
      reason: head?.error
        ? `Couldn't reach the stream: ${head.error}`
        : `Provider responded ${head?.status || 0}.`,
    }
  }
  if (report.playlist && !report.playlist.ok) {
    return {
      verdict: "fail",
      reason: report.playlist.error
        ? `Couldn't fetch the HLS playlist: ${report.playlist.error}`
        : `Playlist responded ${report.playlist.status || 0}.`,
    }
  }
  if (report.firstSegment && report.firstSegment.ok === false) {
    return {
      verdict: "warn",
      reason: report.firstSegment.error
        ? `First segment HEAD failed: ${report.firstSegment.error}`
        : `First segment responded ${report.firstSegment.status || 0}.`,
    }
  }
  return {
    verdict: "ok",
    reason: report.playlist
      ? `${report.playlist.isMaster ? "Master" : "Media"} playlist OK; first segment reachable.`
      : "Endpoint reachable.",
  }
}
