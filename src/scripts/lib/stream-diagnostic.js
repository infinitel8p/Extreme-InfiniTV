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

function readMeta(response, method, startTs) {
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
    acao: response.headers.get("access-control-allow-origin"),
    // Final URL after redirects
    finalUrl: response.url || "",
    latencyMs: Math.round(performance.now() - startTs),
    method,
  }
}

async function headOrGet(url) {
  const start = performance.now()
  let headInfo = null
  try {
    const response = await withTimeout(
      providerFetch(url, { method: "HEAD" }),
      FETCH_TIMEOUT_MS,
      "HEAD"
    )
    headInfo = readMeta(response, "HEAD", start)
    if (headInfo.ok) return headInfo
  } catch (headError) {
    headInfo = { error: String(headError?.message || headError) }
  }
  try {
    const response = await withTimeout(
      providerFetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
      }),
      FETCH_TIMEOUT_MS,
      "GET"
    )
    const meta = readMeta(response, "GET (range)", start)
    if (headInfo?.error) meta.fallback = headInfo.error
    else if (headInfo?.status) meta.headStatus = headInfo.status
    return meta
  } catch (getError) {
    return {
      ok: false,
      status: headInfo?.status || 0,
      statusText: headInfo?.statusText || "",
      contentType: headInfo?.contentType || "",
      contentLength: 0,
      latencyMs: Math.round(performance.now() - start),
      method: headInfo?.status ? "HEAD+GET" : "HEAD",
      error: String(getError?.message || getError),
    }
  }
}

// Plain WebView fetch
async function probeWebViewFetch(url) {
  const start = performance.now()
  try {
    const response = await withTimeout(
      fetch(url, { method: "GET", mode: "cors" }),
      FETCH_TIMEOUT_MS,
      "WebView GET"
    )
    try {
      response.body?.cancel?.()
    } catch {}
    return {
      ok: response.ok || response.status === 206,
      status: response.status,
      acao: response.headers.get("access-control-allow-origin"),
      finalUrl: response.url || "",
      latencyMs: Math.round(performance.now() - start),
    }
  } catch (error) {
    // A thrown fetch here is the telltale CORS / mixed-content / network block.
    return {
      ok: false,
      blocked: true,
      latencyMs: Math.round(performance.now() - start),
      error: String(error?.message || error),
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
  const appOrigin = typeof location !== "undefined" ? location.origin : ""
  const secureContext =
    typeof isSecureContext !== "undefined"
      ? isSecureContext
      : /^https:/i.test(appOrigin)
  const report = {
    url,
    startedAt: Date.now(),
    appOrigin,
    secureContext,
    mixedContent: secureContext && /^http:\/\//i.test(url),
    head: null,
    playlist: null,
    firstSegment: null,
    webviewProbe: null,
    nonHttp: false,
    error: "",
  }

  function emit() {
    try {
      onUpdate?.(JSON.parse(JSON.stringify(report)))
    } catch {}
  }

  emit()

  // Non-HTTP schemes (rtsp/rtmp/udp/mms/...) can't be probed from a WebView
  if (!/^https?:\/\//i.test(url)) {
    report.nonHttp = true
    report.scheme = (url.split("://")[0] || "").toLowerCase()
    report.finishedAt = Date.now()
    emit()
    return report
  }

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

  // probe through the WebView's own fetch
  const probeTarget = report.firstSegment?.url || url
  report.webviewProbe = await probeWebViewFetch(probeTarget)
  report.webviewProbe.target = probeTarget
  emit()

  report.finishedAt = Date.now()
  emit()
  return report
}

import { t } from "@/scripts/lib/i18n.js"
import { findHevcInCodecList, deviceSupportsHevc } from "@/scripts/lib/codec-hints.ts"

export function summarizeReport(report) {
  if (!report) return { verdict: "unknown", reason: "" }
  if (report.nonHttp) {
    return {
      verdict: "info",
      reason:
        t("streamTest.summary.nonHttp", { scheme: report.scheme || "" }) ||
        `Can't test ${report.scheme}:// from the browser. Play it in MPV or VLC to verify.`,
    }
  }
  const head = report.head
  if (!head?.ok) {
    return {
      verdict: "fail",
      reason: head?.error
        ? t("streamTest.summary.cantReach", { error: head.error })
        : t("streamTest.summary.providerResponded", { status: head?.status || 0 }),
    }
  }
  if (report.playlist && !report.playlist.ok) {
    return {
      verdict: "fail",
      reason: report.playlist.error
        ? t("streamTest.summary.cantFetch", { error: report.playlist.error })
        : t("streamTest.summary.playlistResponded", { status: report.playlist.status || 0 }),
    }
  }

  const hevcCodec = findHevcInCodecList(report.playlist?.topVariant?.codecs)
  if (hevcCodec && !deviceSupportsHevc()) {
    return {
      verdict: "fail",
      reason: t("streamTest.summary.hevcUnsupported"),
    }
  }
  if (report.firstSegment && report.firstSegment.ok === false) {
    return {
      verdict: "warn",
      reason: report.firstSegment.error
        ? t("streamTest.summary.firstSegmentFailed", { error: report.firstSegment.error })
        : t("streamTest.summary.firstSegmentResponded", { status: report.firstSegment.status || 0 }),
    }
  }

  if (report.mixedContent) {
    return {
      verdict: "warn",
      reason:
        t("streamTest.summary.mixedContent") ||
        "Stream is http:// but the app runs in a secure context, so the embedded player blocks it as mixed content. Use an external player (MPV/VLC).",
    }
  }
  if (report.webviewProbe && report.webviewProbe.blocked) {
    return {
      verdict: "warn",
      reason:
        t("streamTest.summary.webviewBlocked") ||
        "Stream is reachable, but the embedded player is blocked by browser security (CORS / mixed content). On desktop it now routes around this; otherwise use an external player (MPV/VLC).",
    }
  }
  return {
    verdict: "ok",
    reason: report.playlist
      ? (report.playlist.isMaster ? t("streamTest.summary.playlistOk.master") : t("streamTest.summary.playlistOk.media"))
      : t("streamTest.summary.endpointReachable"),
  }
}
