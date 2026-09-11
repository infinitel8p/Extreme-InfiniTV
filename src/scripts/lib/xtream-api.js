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
  getEntryDnsOverride,
} from "@/scripts/lib/creds.js"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { getNetworkTimeoutSeconds } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"
import { toast } from "@/scripts/lib/toast.ts"
import { t } from "@/scripts/lib/i18n.js"

const failoverNoticed = new Set()
function candidateTimeoutMs() {
  return Math.max(8_000, getNetworkTimeoutSeconds() * 1000)
}
const allFailedAt = new Map()
const ALL_FAILED_TTL_MS = 15_000

function noticeFailover() {
  try {
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
  if (fetchOpts.dns === undefined) fetchOpts.dns = getEntryDnsOverride(entry)

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
        log.debug("[xt:xtream-api] mirror resolved", `action=${action} index=${index}/${candidates.length} host=${creds.host} attempts=${offset + 1}`)
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
    const reachable = response.ok || response.status === 206
    // Live streams are endless; release the body so the probe doesn't hold a connection slot.
    try { void response.body?.cancel?.()?.catch?.(() => {}) } catch {}
    return reachable
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    try { controller.abort() } catch {}
  }
}

/**
 * Probes candidates in ring order starting at `startIndex + startOffset`, wrapping, for exactly
 * `candidates.length - startOffset` steps. Shared by `resolveStreamUrl` (startOffset 0, probes the
 * pin first) and `advanceMirror` (startOffset 1, skips the pin that just rejected the stream).
 *
 * @param {{_id:string}} entry
 * @param {Array<{host:string,port:string,user:string,pass:string}>} candidates
 * @param {(creds: {host:string,port:string,user:string,pass:string}) => string} buildUrl
 * @param {number} startIndex
 * @param {number} startOffset
 * @returns {Promise<{index:number,url:string}|null>}
 */
async function probeCandidateRing(candidates, buildUrl, startIndex, startOffset) {
  for (let offset = startOffset; offset < candidates.length; offset++) {
    const index = (startIndex + offset) % candidates.length
    const url = buildUrl(candidates[index])
    if (!url) continue
    if (await probeStreamUrl(url)) return { index, url }
  }
  return null
}

/**
 * Force-advance to the next Xtream mirror after a provider rejection mid-play
 * (401/403/407/429/connection-limit). Unlike `resolveStreamUrl`, this always
 * probes starting right after the current pin - the pinned candidate is the
 * one that just rejected the stream, so re-probing it first would waste the
 * whole retry window.
 *
 * @param {(creds: {host:string,port:string,user:string,pass:string}) => string} buildUrl
 * @param {{hopsUsed?: number, repin?: boolean}} [options] - `hopsUsed` caps the hop at one per
 *   configured candidate. `repin` (default true) persists the hop for the rest of the session;
 *   pass false for a rejection scoped to a single channel (e.g. one that only exists on the
 *   mirror's package) so the rest of the session keeps using the primary.
 * @returns {Promise<string|null>} The next reachable candidate's URL, or null
 *   when the entry has fewer than 2 candidates, the hop budget is spent, or
 *   none of the others are reachable.
 */
export async function advanceMirror(buildUrl, { hopsUsed = 0, repin = true } = {}) {
  const entry = await getActiveEntry()
  const candidates = xtreamCandidatesFor(entry)
  if (!entry || candidates.length < 2) return null
  if (hopsUsed >= candidates.length - 1) return null

  const startIndex = Math.min(getMirrorPin(entry._id), candidates.length - 1)
  const found = await probeCandidateRing(candidates, buildUrl, startIndex, 1)
  if (!found) return null

  log.debug("[xt:xtream-api] mirror hop resolved", `from=${startIndex} to=${found.index}/${candidates.length} hopsUsed=${hopsUsed} repin=${repin}`)
  if (repin) {
    log.warn(`[xt:api] provider rejection: advancing from candidate ${startIndex} to ${found.index}`)
    setMirrorPin(entry._id, found.index)
    verifiedAt.set(entry._id, { index: found.index, at: Date.now() })
    if (!failoverNoticed.has(entry._id)) {
      failoverNoticed.add(entry._id)
      noticeFailover()
    }
  } else {
    log.info(
      `[xt:api] provider rejection on candidate ${startIndex}: using candidate ${found.index} for this request only`
    )
  }
  return found.url
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

  const found = await probeCandidateRing(candidates, buildUrl, startIndex, 0)
  if (!found) return buildUrl(candidates[startIndex])

  log.debug("[xt:xtream-api] stream mirror resolved", `index=${found.index}/${candidates.length} host=${candidates[found.index]?.host} changed=${found.index !== startIndex}`)
  if (found.index !== startIndex) {
    log.warn(`[xt:api] stream probe: candidate ${startIndex} dead, switching to ${found.index}`)
    if (!failoverNoticed.has(entry._id)) {
      failoverNoticed.add(entry._id)
      noticeFailover()
    }
  }
  setMirrorPin(entry._id, found.index)
  verifiedAt.set(entry._id, { index: found.index, at: Date.now() })
  return found.url
}
