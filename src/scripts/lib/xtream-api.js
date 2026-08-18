// Xtream API fetch with mirror fallback.
//
// `xtreamApiFetch(action, params, opts)` builds the player_api.php URL for
// each candidate in [primary, ...mirrors] and fires them sequentially until
// one returns a 2xx response. The winning index is pinned in creds.js so
// subsequent calls (including stream-URL builds via loadCreds) target the
// same working host until the entry list changes.
//
// Failover triggers on any non-2xx response or thrown network/timeout error.
// 4xx is included on purpose: providers sometimes hand out different
// credentials per backup domain.

import {
  getActiveEntry,
  getEntries,
  buildApiUrl,
  xtreamCandidatesFor,
  getMirrorPin,
  setMirrorPin,
} from "@/scripts/lib/creds.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { getNetworkTimeoutSeconds } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

const failoverNoticed = new Set()
function candidateTimeoutMs() {
  return Math.max(8_000, getNetworkTimeoutSeconds() * 1000)
}
const allFailedAt = new Map()
const ALL_FAILED_TTL_MS = 15_000

async function noticeFailover() {
  try {
    const { toast } = await import("@/scripts/lib/toast.ts")
    const { t } = await import("@/scripts/lib/i18n.js")
    toast({
      title: t("backup.failoverNoticeTitle"),
      description: t("backup.failoverNoticeBody"),
      variant: "default",
    })
  } catch {}
}

async function fetchCandidate(url, opts) {
  const userSignal = opts?.signal
  if (typeof AbortController === "undefined") {
    return providerFetch(url, { ...opts, logKind: "api" })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), candidateTimeoutMs())
  if (userSignal) {
    if (userSignal.aborted) controller.abort()
    else userSignal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  try {
    return await providerFetch(url, { ...opts, signal: controller.signal, logKind: "api" })
  } finally {
    clearTimeout(timer)
  }
}

async function resolveTargetEntry(entryId) {
  if (!entryId) return getActiveEntry()
  const entries = await getEntries()
  return entries.find((entry) => entry._id === entryId) || null
}

/**
 * Fetch an Xtream player_api.php action with automatic mirror failover.
 *
 * @param {string} action - e.g. "get_live_categories"
 * @param {Record<string, string|number>} [params]
 * @param {RequestInit & { forceTauri?: boolean, entryId?: string }} [opts] -
 *   `entryId` targets a specific playlist entry instead of the active one.
 * @returns {Promise<Response>} The first 2xx response, or the last 4xx/5xx
 *   response when every candidate failed with HTTP errors. Throws when every
 *   candidate threw network/timeout errors.
 */
export async function xtreamApiFetch(action, params = {}, opts = {}) {
  const { entryId, ...fetchOpts } = opts
  const entry = await resolveTargetEntry(entryId)
  const candidates = xtreamCandidatesFor(entry)
  if (!entry || !candidates.length) {
    throw new Error("xtreamApiFetch: no active Xtream playlist")
  }

  const startIndex = Math.min(getMirrorPin(entry._id), candidates.length - 1)

  const lastAllFailed = allFailedAt.get(entry._id)
  if (lastAllFailed && Date.now() - lastAllFailed < ALL_FAILED_TTL_MS) {
    const creds = candidates[startIndex]
    const url = buildApiUrl(creds, action, params)
    const response = await fetchCandidate(url, fetchOpts)
    if (response.ok) allFailedAt.delete(entry._id)
    return response
  }

  let lastResponse = null
  let lastError = null

  for (let offset = 0; offset < candidates.length; offset++) {
    const index = (startIndex + offset) % candidates.length
    const creds = candidates[index]
    const url = buildApiUrl(creds, action, params)
    try {
      const response = await fetchCandidate(url, fetchOpts)
      if (response.ok) {
        if (index !== startIndex) {
          log.warn(
            `[xt:api] ${action}: pinned candidate ${startIndex} failed, switching to ${index}`
          )
          if (!failoverNoticed.has(entry._id)) {
            failoverNoticed.add(entry._id)
            noticeFailover()
          }
        }
        setMirrorPin(entry._id, index)
        allFailedAt.delete(entry._id)
        return response
      }
      lastResponse = response
      log.warn(
        `[xt:api] ${action}: candidate ${index} returned HTTP ${response.status}`
      )
    } catch (err) {
      lastError = err
      log.warn(
        `[xt:api] ${action}: candidate ${index} threw ${String(err?.message || err)}`
      )
    }
  }

  if (lastResponse) {
    allFailedAt.set(entry._id, Date.now())
    return lastResponse
  }
  throw lastError || new Error(`xtreamApiFetch: ${action} - all candidates failed`)
}

const STREAM_PROBE_TIMEOUT_MS = 5000

// entryId -> { index, at }. When a probe succeeds against `index`, the result
// is good for VERIFY_TTL_MS. Invalidated on entries-updated since the mirror
// list might have changed.
const verifiedAt = new Map()
const VERIFY_TTL_MS = 60_000

if (typeof document !== "undefined") {
  document.addEventListener("xt:entries-updated", () => {
    verifiedAt.clear()
    failoverNoticed.clear()
    allFailedAt.clear()
  })
}

async function probeStreamUrl(url) {
  if (typeof AbortController === "undefined") return true // no abort = skip the probe
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STREAM_PROBE_TIMEOUT_MS)
  try {
    const response = await providerFetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
      logKind: "api",
    })
    return response.ok || response.status === 206
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a stream URL with mirror failover. Probes the URL built from the
 * pinned candidate first, then falls through the remaining mirrors via a
 * cheap ranged GET. Updates the pin when a working candidate is found.
 *
 * No-op when the entry has no mirrors (probe wouldn't help and would just add
 * latency to play). Falls back to the pinned URL when every probe fails so
 * the player surfaces the actual error to the user.
 *
 * @param {(creds: {host:string,port:string,user:string,pass:string}) => string} buildUrl
 * @returns {Promise<string>}
 */
export async function resolveStreamUrl(buildUrl) {
  const entry = await getActiveEntry()
  const candidates = xtreamCandidatesFor(entry)
  if (!entry || candidates.length < 2) {
    return buildUrl(candidates[0] || { host: "", port: "", user: "", pass: "" })
  }
  const startIndex = Math.min(getMirrorPin(entry._id), candidates.length - 1)

  // Short-circuit when the pinned candidate was just verified
  const cached = verifiedAt.get(entry._id)
  if (
    cached &&
    cached.index === startIndex &&
    Date.now() - cached.at < VERIFY_TTL_MS
  ) {
    return buildUrl(candidates[startIndex])
  }

  for (let offset = 0; offset < candidates.length; offset++) {
    const index = (startIndex + offset) % candidates.length
    const url = buildUrl(candidates[index])
    if (!url) continue
    if (await probeStreamUrl(url)) {
      if (index !== startIndex) {
        log.warn(`[xt:api] stream probe: candidate ${startIndex} dead, switching to ${index}`)
        if (!failoverNoticed.has(entry._id)) {
          failoverNoticed.add(entry._id)
          noticeFailover()
        }
      }
      setMirrorPin(entry._id, index)
      verifiedAt.set(entry._id, { index, at: Date.now() })
      return url
    }
  }
  return buildUrl(candidates[startIndex])
}
