// A provider refusal often arrives as a page with a 200, which any player reports as a malformed
// manifest - so the receiver blames the TV. Probing the source says what was really served.
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { isConnectionLimitStatus } from "@/scripts/lib/codec-hints.js"
import { log } from "@/scripts/lib/log.js"

export type ManifestProbeVerdict =
  | "connection-limit"
  /** Served something that isn't a stream at all: error page, JSON, HTTP error. */
  | "refused"
  | "manifest"
  | "inconclusive"

export interface ProbedManifest {
  status: number
  contentType: string | null
  bodyPrefix: string
}

const CONNECTION_LIMIT_PHRASES = [
  /max(?:imum)?\s+connections?/i,
  /connection\s+limit/i,
  /too\s+many\s+connections/i,
  /no\s+free\s+(?:connection|slot)/i,
]

const MANIFEST_SIGNATURES = [/^#EXTM3U/i, /<MPD[\s>]/i, /<SmoothStreamingMedia[\s>]/i]

const REFUSAL_SIGNATURES = [/^\s*<!doctype\s+html/i, /^\s*<html[\s>]/i, /^\s*\{/, /^\s*<\?xml[^>]*\?>\s*<(?!MPD)/i]

const REFUSAL_CONTENT_TYPES = [/text\/html/i, /application\/json/i, /application\/xhtml/i]

const ISO_BMFF_BOX_TYPES = ["ftyp", "styp", "moof", "moov", "sidx"]

/** Media bytes are playable though not a manifest, so they must never read as a refusal. */
function looksBinary(bodyPrefix: string): boolean {
  if (!bodyPrefix) return false
  if (bodyPrefix.charCodeAt(0) === 0x47) return true
  if (ISO_BMFF_BOX_TYPES.includes(bodyPrefix.slice(4, 8))) return true
  return bodyPrefix.includes("\u0000")
}

export function classifyProbedManifest(probed: ProbedManifest): ManifestProbeVerdict {
  const body = probed.bodyPrefix || ""
  if (isConnectionLimitStatus(probed.status)) return "connection-limit"
  if (!looksBinary(body) && CONNECTION_LIMIT_PHRASES.some((phrase) => phrase.test(body))) {
    return "connection-limit"
  }
  if (probed.status >= 400) return "refused"
  if (MANIFEST_SIGNATURES.some((signature) => signature.test(body.trimStart()))) return "manifest"
  if (looksBinary(body)) return "inconclusive"
  if (REFUSAL_SIGNATURES.some((signature) => signature.test(body))) return "refused"
  if (probed.contentType && REFUSAL_CONTENT_TYPES.some((type) => type.test(probed.contentType!))) return "refused"
  return "inconclusive"
}

export function messageKeyForProbeVerdict(verdict: ManifestProbeVerdict): string | null {
  if (verdict === "connection-limit") return "receiver.error.connectionLimit"
  if (verdict === "refused") return "receiver.error.providerRefused"
  return null
}

const PROBE_BYTES = 2048
const PROBE_TIMEOUT_MS = 2500

export interface ProbeSourceOptions {
  userAgent?: string | null
  timeoutMs?: number
}

export async function probeManifestSource(
  src: string,
  options: ProbeSourceOptions = {}
): Promise<ManifestProbeVerdict> {
  if (!src) return "inconclusive"
  const headers: Record<string, string> = { Range: `bytes=0-${PROBE_BYTES - 1}` }
  if (options.userAgent) headers["User-Agent"] = options.userAgent
  try {
    const response = await providerFetch(src, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      logKind: "manifest-probe",
    })
    const bodyPrefix = (await response.text()).slice(0, PROBE_BYTES)
    return classifyProbedManifest({
      status: response.status,
      contentType: response.headers?.get?.("content-type") ?? null,
      bodyPrefix,
    })
  } catch (err) {
    log.warn("[xt:manifest-probe] probe failed:", err)
    return "inconclusive"
  }
}
