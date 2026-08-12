import { log, redactUrl } from "@/scripts/lib/log.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"

export type ProbedContainer = "mkv" | "mp4"

const PROBE_TIMEOUT_MS = 8000
const PROBE_BYTE_COUNT = 128
const MIN_CLASSIFIABLE_BYTES = 12
const MAX_ACCUMULATED_BYTES = 512

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

const probeCache = new Map<string, { url: string; container: ProbedContainer } | null>()

export function clearVodContainerProbeCache(): void {
  probeCache.clear()
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
    probeCache.set(originalUrl, hit)
    return hit
  }

  const swapCandidates: Array<{ url: string; expected: ProbedContainer }> = []
  const mp4Url = swapUrlExtension(originalUrl, "mp4")
  if (mp4Url) swapCandidates.push({ url: mp4Url, expected: "mp4" })
  const mkvUrl = swapUrlExtension(originalUrl, "mkv")
  if (mkvUrl) swapCandidates.push({ url: mkvUrl, expected: "mkv" })

  for (const candidate of swapCandidates) {
    const detected = await fetchAndClassify(candidate.url)
    if (detected === candidate.expected) {
      const hit = { url: candidate.url, container: candidate.expected }
      log.log("[xt:vod-probe] found working alternative:", candidate.expected, redactUrl(candidate.url))
      probeCache.set(originalUrl, hit)
      return hit
    }
  }

  log.log("[xt:vod-probe] no working alternative found for", redactUrl(originalUrl))
  probeCache.set(originalUrl, null)
  return null
}
