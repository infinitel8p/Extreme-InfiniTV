import { log, redactUrl } from "@/scripts/lib/log.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"

export type ProbedContainer = "mkv" | "mp4"

const PROBE_TIMEOUT_MS = 8000
const PROBE_BYTE_COUNT = 128
const MIN_CLASSIFIABLE_BYTES = 12
const MAX_ACCUMULATED_BYTES = 512
// Solo window for the preferred probe before the fallback is also fired.
const HEDGE_DELAY_MS = 1800

export function classifyContainerBytes(bytes: Uint8Array): "mkv" | "mp4" | "avi" | "ts" | null {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "mkv"
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "mp4"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49 && bytes[11] === 0x20
  ) {
    return "avi"
  }
  if (bytes[0] === 0x47) return "ts"
  return null
}

export function swapUrlExtension(url: string, newExtension: string): string | null {
  if (typeof url !== "string" || !url) return null
  let parsed: URL
  let isAbsolute = true
  try {
    parsed = new URL(url)
  } catch {
    try {
      parsed = new URL(url, "http://xt-vod-container-probe.invalid/")
      isAbsolute = false
    } catch {
      return null
    }
  }
  const segments = parsed.pathname.split("/")
  const lastSegment = segments[segments.length - 1] || ""
  const dotIndex = lastSegment.lastIndexOf(".")
  if (dotIndex <= 0) return null
  segments[segments.length - 1] = `${lastSegment.slice(0, dotIndex)}.${newExtension}`
  parsed.pathname = segments.join("/")
  return isAbsolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`
}

async function readClassifiableBytes(response: Response): Promise<Uint8Array | null> {
  const body = response.body
  if (!body || typeof body.getReader !== "function") {
    const buffer = await response.arrayBuffer()
    if (!buffer.byteLength) return null
    return new Uint8Array(buffer).subarray(0, MAX_ACCUMULATED_BYTES)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (totalBytes < MIN_CLASSIFIABLE_BYTES && totalBytes < MAX_ACCUMULATED_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength) {
        chunks.push(value)
        totalBytes += value.byteLength
      }
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
  if (!totalBytes) return null
  const merged = new Uint8Array(Math.min(totalBytes, MAX_ACCUMULATED_BYTES))
  let mergedOffset = 0
  for (const chunk of chunks) {
    if (mergedOffset >= merged.length) break
    const spaceLeft = merged.length - mergedOffset
    const toCopy = chunk.byteLength > spaceLeft ? chunk.subarray(0, spaceLeft) : chunk
    merged.set(toCopy, mergedOffset)
    mergedOffset += toCopy.byteLength
  }
  return merged
}

async function fetchAndClassify(url: string): Promise<"mkv" | "mp4" | "avi" | "ts" | null> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null
  try {
    const response = await providerFetch(url, {
      method: "GET",
      headers: { Range: `bytes=0-${PROBE_BYTE_COUNT - 1}` },
      signal: controller?.signal,
      logKind: "media",
    })
    if (!response.ok) {
      log.log("[xt:vod-probe] non-ok response", response.status, redactUrl(url))
      return null
    }
    // Some Xtream panels return 200 OK with an empty body for extensions they don't have.
    const bytes = await readClassifiableBytes(response)
    if (!bytes) {
      log.log("[xt:vod-probe] empty body", redactUrl(url))
      return null
    }
    return classifyContainerBytes(bytes)
  } catch (err) {
    log.log("[xt:vod-probe] fetch failed", redactUrl(url), String((err as Error)?.message || err))
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function classifySourceHealth(
  responseOk: boolean,
  bytes: Uint8Array | null,
): "unreachable" | "not-media" | "media" {
  if (!responseOk || bytes === null) return "unreachable"
  return classifyContainerBytes(bytes) !== null ? "media" : "not-media"
}

export async function probeVodSourceHealth(url: string): Promise<"unreachable" | "not-media" | "media"> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null
  try {
    const response = await providerFetch(url, {
      method: "GET",
      headers: { Range: `bytes=0-${PROBE_BYTE_COUNT - 1}` },
      signal: controller?.signal,
      logKind: "media",
    })
    const bytes = response.ok ? await readClassifiableBytes(response) : null
    return classifySourceHealth(response.ok, bytes)
  } catch (err) {
    log.log("[xt:vod-probe] source health fetch failed", redactUrl(url), String((err as Error)?.message || err))
    return "unreachable"
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const PROBE_CACHE_MAX_ENTRIES = 200

const probeCache = new Map<string, { url: string; container: ProbedContainer } | null>()

function cacheProbeResult(originalUrl: string, result: { url: string; container: ProbedContainer } | null): void {
  if (probeCache.size >= PROBE_CACHE_MAX_ENTRIES && !probeCache.has(originalUrl)) {
    const oldestKey = probeCache.keys().next().value
    if (oldestKey !== undefined) probeCache.delete(oldestKey)
  }
  probeCache.set(originalUrl, result)
}

export function clearVodContainerProbeCache(): void {
  probeCache.clear()
}

// Preferred probe starts now; fallback joins on early failure or after HEDGE_DELAY_MS.
async function hedgedProbe(
  candidates: Array<{ url: string; expected: ProbedContainer }>,
): Promise<{ url: string; container: ProbedContainer } | null> {
  if (candidates.length === 0) return null
  if (candidates.length === 1) {
    const [onlyCandidate] = candidates
    const detected = await fetchAndClassify(onlyCandidate.url)
    return detected === onlyCandidate.expected
      ? { url: onlyCandidate.url, container: onlyCandidate.expected }
      : null
  }

  const [preferredCandidate, fallbackCandidate] = candidates
  const preferredPromise = fetchAndClassify(preferredCandidate.url)

  let hedgeTimer: ReturnType<typeof setTimeout> | null = null
  const hedgeElapsed = new Promise<"hedge">((resolve) => {
    hedgeTimer = setTimeout(() => resolve("hedge"), HEDGE_DELAY_MS)
  })
  const winner = await Promise.race([preferredPromise.then(() => "preferred" as const), hedgeElapsed])
  if (hedgeTimer) clearTimeout(hedgeTimer)

  if (winner === "preferred") {
    const preferredDetected = await preferredPromise
    if (preferredDetected === preferredCandidate.expected) {
      return { url: preferredCandidate.url, container: preferredCandidate.expected }
    }
    // Preferred already failed: start the fallback immediately.
    const fallbackDetected = await fetchAndClassify(fallbackCandidate.url)
    return fallbackDetected === fallbackCandidate.expected
      ? { url: fallbackCandidate.url, container: fallbackCandidate.expected }
      : null
  }

  // Hedge window elapsed: run the fallback in parallel, preferred still wins.
  const fallbackPromise = fetchAndClassify(fallbackCandidate.url)
  const [preferredDetected, fallbackDetected] = await Promise.all([preferredPromise, fallbackPromise])
  if (preferredDetected === preferredCandidate.expected) {
    return { url: preferredCandidate.url, container: preferredCandidate.expected }
  }
  if (fallbackDetected === fallbackCandidate.expected) {
    return { url: fallbackCandidate.url, container: fallbackCandidate.expected }
  }
  return null
}

export async function probeVodContainerAlternative(
  originalUrl: string,
): Promise<{ url: string; container: ProbedContainer } | null> {
  if (probeCache.has(originalUrl)) return probeCache.get(originalUrl) ?? null

  log.log("[xt:vod-probe] probing alternative container for", redactUrl(originalUrl))

  const originalContainer = await fetchAndClassify(originalUrl)
  if (originalContainer === "mkv" || originalContainer === "mp4") {
    const hit = { url: originalUrl, container: originalContainer }
    log.log("[xt:vod-probe] original URL is mislabeled, actual container:", originalContainer)
    cacheProbeResult(originalUrl, hit)
    return hit
  }

  const swapCandidates: Array<{ url: string; expected: ProbedContainer }> = []
  const mp4Url = swapUrlExtension(originalUrl, "mp4")
  if (mp4Url) swapCandidates.push({ url: mp4Url, expected: "mp4" })
  const mkvUrl = swapUrlExtension(originalUrl, "mkv")
  if (mkvUrl) swapCandidates.push({ url: mkvUrl, expected: "mkv" })

  const hit = await hedgedProbe(swapCandidates)
  if (hit) {
    log.log("[xt:vod-probe] found working alternative:", hit.container, redactUrl(hit.url))
    cacheProbeResult(originalUrl, hit)
    return hit
  }

  log.log("[xt:vod-probe] no working alternative found for", redactUrl(originalUrl))
  cacheProbeResult(originalUrl, null)
  return null
}
