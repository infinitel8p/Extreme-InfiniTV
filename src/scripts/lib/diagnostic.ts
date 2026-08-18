// Multi-step connection diagnostic. Two entry points share the same logic:
//   - Login page: progressive disclosure under the Test result.
//   - Settings page: per-playlist "Run diagnostic" button inside the health panel.
//
// Xtream pipeline (4 steps):
//   1. Authenticate (get_account_info) - blocking; reach + creds + account info
//   2. Live channels   (get_live_streams,  parallel after auth)
//   3. Movies          (get_vod_streams,   parallel after auth)
//   4. Series          (get_series,        parallel after auth)
//
// Each catalogue probe streams its result as soon as it lands rather than
// waiting for the slowest, so on a typical run with 1s/4s/10s timings the
// user sees Live at 1s and Movies at 4s instead of both appearing together
// when Series finishes 10s in.
//
// M3U pipeline (2 steps):
//   1. Fetch playlist
//   2. Parse + count #EXTINF entries
//
// Step messages route through the same `classifyError` taxonomy the simple
// Test button uses, so users see the same wording across both surfaces.
// Auth failure stops downstream steps - no point probing catalogue
// endpoints with bad creds.
//
// Auxiliary steps (EPG, updater, sample stream) never affect the verdict
// beyond a warn. The sample stream probe also skips when the auth step
// reports the connection pool already at max_connections, so it never
// steals the user's own playback slot.

import { t } from "@/scripts/lib/i18n.js"
import { buildApiUrl, safeHttpUrl, isTauri } from "@/scripts/lib/creds.js"
import { classifyError } from "@/scripts/lib/provider-error.js"
import { redactUrl } from "@/scripts/lib/log.js"
import { buildLiveStreamUrl } from "@/scripts/lib/stream-urls.ts"
import {
  extractM3UHeaderEpgUrl,
  firstStreamUrlFromM3U,
  isAbsoluteHttpUrl,
  pickSampleLiveStreamId,
} from "@/scripts/lib/diagnostic-targets.ts"

export type StepStatus = "pass" | "warn" | "fail" | "skip"

export interface DiagnosticStep {
  /** Translation key for the step label (e.g. "diagnostic.step.reach"). */
  labelKey: string
  status: StepStatus
  latencyMs?: number
  /** Pre-translated detail line, optional. */
  detail?: string
  /** Item count, when the step produces a count (used in the detail line). */
  count?: number
  /** classifyError kind, when the step failed. */
  reason?: string
  /** HTTP status code, when present. */
  httpStatus?: number
}

export type DiagnosticVerdict = "ok" | "warn" | "fail" | "running"

export interface DiagnosticResult {
  steps: DiagnosticStep[]
  verdict: DiagnosticVerdict
  /** Pre-translated verdict line. */
  verdictMessage: string
}

// Steps every pipeline needs to function; everything else (EPG, updater,
// sample stream) is auxiliary and can never fail the overall verdict.
const CORE_STEP_KEYS = new Set([
  "diagnostic.step.auth",
  "diagnostic.step.live",
  "diagnostic.step.vod",
  "diagnostic.step.series",
  "diagnostic.step.fetch",
  "diagnostic.step.parse",
])

export function deriveVerdict(
  steps: DiagnosticStep[]
): { verdict: DiagnosticVerdict; messageKey: string } {
  let coreFail = false
  let coreWarn = false
  let auxIssue = false
  for (const step of steps) {
    const isCore = CORE_STEP_KEYS.has(step.labelKey)
    if (isCore) {
      if (step.status === "fail") coreFail = true
      else if (step.status === "warn") coreWarn = true
    } else if (step.status === "warn" || step.status === "fail") {
      auxIssue = true
    }
  }
  if (coreFail) return { verdict: "fail", messageKey: "diagnostic.verdict.partial" }
  if (coreWarn) return { verdict: "warn", messageKey: "diagnostic.verdict.partial" }
  if (auxIssue) return { verdict: "warn", messageKey: "diagnostic.verdict.auxWarn" }
  return { verdict: "ok", messageKey: "diagnostic.verdict.allGood" }
}

let lastDiagnosticResult: DiagnosticResult | null = null

/** Most recent diagnostic run, from either runner. Feeds a future bug-report attachment. */
export function getLastDiagnosticResult(): DiagnosticResult | null {
  return lastDiagnosticResult
}

function finish(result: DiagnosticResult): DiagnosticResult {
  lastDiagnosticResult = result
  return result
}

interface XtreamCreds {
  serverUrl: string
  username: string
  password: string
}

const STEP_TIMEOUT_MS = 12_000
const STREAM_PROBE_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms)
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

async function jsonCountAndData(
  response: Response,
  keys: string[]
): Promise<{ count: number; data: unknown }> {
  const data = await response.json()
  if (Array.isArray(data)) return { count: data.length, data }
  for (const key of keys) {
    const value = (data as any)?.[key]
    if (Array.isArray(value)) return { count: value.length, data: value }
  }
  // Server replied with 2xx + valid JSON, but the body isn't an array under
  // any expected key. Most often this means an Xtream panel returned
  // `{"error": "..."}` or a status object instead of the catalogue. Surface
  // as bad_response so the caller flags the step "warn" - reporting "0
  // entries" with a pass icon would be actively misleading.
  throw new Error("unexpected response shape")
}

/**
 * Format step latency for display. Sub-second results stay in ms ("245ms");
 * anything longer rolls up to one-decimal seconds ("1.4s", "10.2s") so the
 * eye doesn't have to count four digits at a glance.
 */
function fmtLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export interface DiagnosticRunOptions {
  /**
   * Fires after each step completes with the current step list. Used by the
   * UI to render progress without waiting for the whole wizard to finish.
   * Not called once more with the final list - the caller already has the
   * resolved promise for that.
   */
  onProgress?: (steps: DiagnosticStep[]) => void
  entry?: {
    epgUrl?: string
    additionalEpgUrls?: string[]
    disableProviderEpg?: boolean
    liveContainer?: string
    type?: string
  }
  sampleStreamUrl?: string
}

/** EPG target for the Xtream runner: same resolution `buildEpgUrlsFromEntry` uses elsewhere, so there's one implementation of the URL shape. */
async function resolveXtreamEpgTargetUrl(
  entry: DiagnosticRunOptions["entry"],
  creds: { host: string; port: string; user: string; pass: string }
): Promise<string | null> {
  try {
    const { buildEpgUrlsFromEntry } = await import("@/scripts/lib/epg-data.js")
    const sources = buildEpgUrlsFromEntry(entry ?? {}, creds, "", [])
    return sources.find((source: { kind: string }) => source.kind === "primary")?.url ?? null
  } catch {
    return null
  }
}

/** Shared EPG reachability probe for both runners. Never fails - a dead guide doesn't stop playback. */
async function probeEpgStep(targetUrl: string | null): Promise<DiagnosticStep> {
  if (!targetUrl) {
    return { labelKey: "diagnostic.step.epg", status: "skip", detail: t("diagnostic.detail.epgNone") }
  }
  try {
    const { probeStreamHead } = await import("@/scripts/lib/stream-diagnostic.js")
    const started = Date.now()
    const result = await probeStreamHead(targetUrl, undefined, "epg")
    return {
      labelKey: "diagnostic.step.epg",
      status: result.ok ? "pass" : "warn",
      latencyMs: Date.now() - started,
      detail: t("diagnostic.detail.epgSource", { url: redactUrl(targetUrl).slice(0, 80) }),
    }
  } catch {
    return { labelKey: "diagnostic.step.epg", status: "skip", detail: t("diagnostic.detail.epgNone") }
  }
}

/** Update-feed reachability probe. Skips on Android/web/store builds, since none of them use this feed. */
async function probeUpdaterStep(): Promise<DiagnosticStep> {
  const isAndroidApp = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")
  if (!isTauri || isAndroidApp) {
    return { labelKey: "diagnostic.step.updater", status: "skip", detail: t("diagnostic.detail.updaterNotApplicable") }
  }
  try {
    const { isStoreBuild, resolveUpdateFeedUrl } = await import("@/scripts/lib/update-check.js")
    if (await isStoreBuild()) {
      return { labelKey: "diagnostic.step.updater", status: "skip", detail: t("diagnostic.detail.updaterNotApplicable") }
    }
    const started = Date.now()
    try {
      const { providerFetch } = await import("@/scripts/lib/provider-fetch.js")
      const feedUrl = await resolveUpdateFeedUrl()
      const response = await withTimeout(
        providerFetch(feedUrl, { method: "GET", headers: { Range: "bytes=0-0" }, logKind: "update" }),
        STEP_TIMEOUT_MS
      )
      const latency = Date.now() - started
      if (response.status === 404) {
        return { labelKey: "diagnostic.step.updater", status: "warn", latencyMs: latency, detail: t("diagnostic.detail.updaterMissing") }
      }
      if (response.ok || response.status === 206 || (response.status >= 300 && response.status < 400)) {
        return { labelKey: "diagnostic.step.updater", status: "pass", latencyMs: latency, detail: t("diagnostic.detail.updaterOk") }
      }
      return {
        labelKey: "diagnostic.step.updater",
        status: "warn",
        latencyMs: latency,
        detail: t("diagnostic.detail.httpStatus", { status: String(response.status) }),
        httpStatus: response.status,
      }
    } catch (error) {
      const classified = classifyError({ error })
      return {
        labelKey: "diagnostic.step.updater",
        status: "warn",
        latencyMs: Date.now() - started,
        detail: t(`providerError.classify.${classified.kind}`),
        reason: classified.kind,
      }
    }
  } catch {
    return { labelKey: "diagnostic.step.updater", status: "skip", detail: t("diagnostic.detail.updaterNotApplicable") }
  }
}

interface SampleStreamProbeInput {
  isTauriApp: boolean
  entryType?: string
  targetUrl: string | null
  busy: boolean
}

/** Shared "can we actually watch a channel" probe. Runs last so it never delays the rest of the report. */
async function probeSampleStreamStep(input: SampleStreamProbeInput): Promise<DiagnosticStep> {
  if (!input.isTauriApp) {
    return { labelKey: "diagnostic.step.stream", status: "skip", detail: t("diagnostic.detail.skipWeb") }
  }
  if (input.busy) {
    return { labelKey: "diagnostic.step.stream", status: "skip", detail: t("diagnostic.detail.streamBusy") }
  }
  if (!input.targetUrl || input.entryType === "local-m3u" || input.entryType === "custom") {
    return { labelKey: "diagnostic.step.stream", status: "skip", detail: t("diagnostic.detail.streamNone") }
  }
  try {
    const { probeStreamHead } = await import("@/scripts/lib/stream-diagnostic.js")
    const started = Date.now()
    try {
      const result = await withTimeout(
        probeStreamHead(input.targetUrl, undefined, "media"),
        STREAM_PROBE_TIMEOUT_MS
      )
      const latency = Date.now() - started
      if (result.ok) {
        return {
          labelKey: "diagnostic.step.stream",
          status: "pass",
          latencyMs: latency,
          detail: t("diagnostic.detail.fetchOk", { status: String(result.status ?? "") }),
        }
      }
      if (result.status === 401 || result.status === 403) {
        return {
          labelKey: "diagnostic.step.stream",
          status: "fail",
          latencyMs: latency,
          detail: t("diagnostic.detail.streamAuth"),
          httpStatus: result.status,
        }
      }
      return {
        labelKey: "diagnostic.step.stream",
        status: "warn",
        latencyMs: latency,
        detail: t("diagnostic.detail.httpStatus", { status: String(result.status ?? 0) }),
        httpStatus: result.status ?? undefined,
      }
    } catch (error) {
      const classified = classifyError({ error })
      return {
        labelKey: "diagnostic.step.stream",
        status: "warn",
        latencyMs: Date.now() - started,
        detail: t(`providerError.classify.${classified.kind}`),
        reason: classified.kind,
      }
    }
  } catch {
    return { labelKey: "diagnostic.step.stream", status: "skip", detail: t("diagnostic.detail.streamNone") }
  }
}

/**
 * Run the full Xtream diagnostic. Steps run sequentially up to auth (no
 * point probing endpoints with bad creds), then catalogue endpoints run in
 * parallel for the remaining steps.
 *
 * Reach + auth are intentionally collapsed into one step: if the
 * authenticate call returns, we reached the server; if classifyError says
 * `unreachable` / `timeout`, we didn't. A separate bare-GET probe to
 * `/player_api.php` produced false warnings because several Xtream panels
 * misuse HTTP 511 ("Network Authentication Required") when the endpoint is
 * hit without query params.
 */
export async function runXtreamDiagnostic(
  creds: XtreamCreds,
  options: DiagnosticRunOptions = {}
): Promise<DiagnosticResult> {
  const steps: DiagnosticStep[] = []
  const { providerFetch } = await import("@/scripts/lib/provider-fetch.js")
  const pushStep = (step: DiagnosticStep) => {
    steps.push(step)
    options.onProgress?.(steps.slice())
  }

  const base = safeHttpUrl(creds.serverUrl)
  if (!base) {
    pushStep({ labelKey: "diagnostic.step.auth", status: "fail", detail: t("diagnostic.detail.invalidUrl") })
    return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.invalidUrl") })
  }

  const apiCreds = {
    host: creds.serverUrl,
    port: "",
    user: creds.username,
    pass: creds.password,
  }

  // Connection slot is at capacity - probing the sample stream would steal it
  // from the user's own playback (some providers cap max_connections at 1).
  let connectionsAtLimit: boolean

  // Step 1: authenticate. The roundtrip latency doubles as the reach
  // measurement, and classifyError tells us whether the failure was
  // connectivity or auth. If auth fails we stop - no point hammering
  // catalogue endpoints with bad creds.
  const authStart = Date.now()
  try {
    const url = buildApiUrl(apiCreds, "get_account_info")
    const response = await withTimeout(providerFetch(url), STEP_TIMEOUT_MS)
    const latency = Date.now() - authStart
    if (!response.ok) {
      const classified = classifyError({ response })
      pushStep({
        labelKey: "diagnostic.step.auth",
        status: "fail",
        latencyMs: latency,
        detail: t(`providerError.classify.${classified.kind}`, { status: String(classified.httpStatus ?? "") }),
        reason: classified.kind,
        httpStatus: classified.httpStatus,
      })
      return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.authFailed") })
    }
    let data: any
    try {
      data = await response.json()
    } catch {
      pushStep({
        labelKey: "diagnostic.step.auth",
        status: "fail",
        latencyMs: latency,
        detail: t("providerError.classify.bad_response"),
        reason: "bad_response",
      })
      return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.badResponse") })
    }
    const info = data?.user_info
    if (info && (info.auth === 0 || info.auth === "0")) {
      pushStep({
        labelKey: "diagnostic.step.auth",
        status: "fail",
        latencyMs: latency,
        detail: t("providerError.classify.auth_rejected"),
        reason: "auth_rejected",
      })
      return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.authRejected") })
    }
    if (!info?.status) {
      pushStep({
        labelKey: "diagnostic.step.auth",
        status: "fail",
        latencyMs: latency,
        detail: t("providerError.classify.bad_response"),
        reason: "bad_response",
      })
      return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.badResponse") })
    }
    const maxCons = info.max_connections ?? "-"
    const activeCons = info.active_cons ?? "-"
    const accountStatus = String(info.status)
    const isActive = accountStatus === "Active"
    const maxConsNum = Number(info.max_connections)
    const activeConsNum = Number(info.active_cons)
    connectionsAtLimit =
      Number.isFinite(maxConsNum) &&
      maxConsNum > 0 &&
      Number.isFinite(activeConsNum) &&
      activeConsNum >= maxConsNum
    pushStep({
      labelKey: "diagnostic.step.auth",
      status: isActive ? "pass" : "warn",
      latencyMs: latency,
      detail: t("diagnostic.detail.accountInfo", {
        status: accountStatus,
        active: String(activeCons),
        max: String(maxCons),
      }),
    })
    if (!isActive) {
      return finish({
        steps,
        verdict: "warn",
        verdictMessage: t("diagnostic.verdict.accountInactive", { status: accountStatus }),
      })
    }
  } catch (error) {
    const classified = classifyError({ error })
    pushStep({
      labelKey: "diagnostic.step.auth",
      status: "fail",
      latencyMs: Date.now() - authStart,
      detail: t(`providerError.classify.${classified.kind}`),
      reason: classified.kind,
    })
    return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.authFailed") })
  }

  // Steps 2-4
  const probeStep = async (
    labelKey: string,
    action: string,
    countKeys: string[],
    onData?: (data: unknown) => void
  ): Promise<void> => {
    const started = Date.now()
    try {
      const response = await withTimeout(
        providerFetch(buildApiUrl(apiCreds, action)),
        STEP_TIMEOUT_MS
      )
      const latency = Date.now() - started
      if (!response.ok) {
        const classified = classifyError({ response })
        pushStep({
          labelKey,
          status: "warn",
          latencyMs: latency,
          detail: t(`providerError.classify.${classified.kind}`, { status: String(classified.httpStatus ?? "") }),
          reason: classified.kind,
          httpStatus: classified.httpStatus,
        })
        return
      }
      try {
        const { count, data } = await jsonCountAndData(response, countKeys)
        onData?.(data)
        pushStep({
          labelKey,
          status: "pass",
          latencyMs: latency,
          count,
          detail: t("diagnostic.detail.count", { count: count.toLocaleString() }),
        })
      } catch {
        pushStep({
          labelKey,
          status: "warn",
          latencyMs: latency,
          detail: t("providerError.classify.bad_response"),
          reason: "bad_response",
        })
      }
    } catch (error) {
      const classified = classifyError({ error })
      pushStep({
        labelKey,
        status: "warn",
        latencyMs: Date.now() - started,
        detail: t(`providerError.classify.${classified.kind}`),
        reason: classified.kind,
      })
    }
  }

  let liveStreamsPayload: unknown = null
  await Promise.all([
    probeStep("diagnostic.step.live", "get_live_streams", ["streams", "results"], (data) => {
      liveStreamsPayload = data
    }).catch(() => {}),
    probeStep("diagnostic.step.vod", "get_vod_streams", ["movies", "results"]).catch(() => {}),
    probeStep("diagnostic.step.series", "get_series", ["series", "results"]).catch(() => {}),
    resolveXtreamEpgTargetUrl(options.entry, apiCreds)
      .then(async (targetUrl) => {
        pushStep(await probeEpgStep(targetUrl))
      })
      .catch(() => {
        pushStep({ labelKey: "diagnostic.step.epg", status: "skip", detail: t("diagnostic.detail.epgNone") })
      }),
    probeUpdaterStep()
      .then((step) => pushStep(step))
      .catch(() => {
        pushStep({ labelKey: "diagnostic.step.updater", status: "skip", detail: t("diagnostic.detail.updaterNotApplicable") })
      }),
  ])

  const sampleStreamId = pickSampleLiveStreamId(liveStreamsPayload)
  const derivedStreamUrl = sampleStreamId
    ? buildLiveStreamUrl(apiCreds, sampleStreamId, options.entry?.liveContainer)
    : null
  pushStep(
    await probeSampleStreamStep({
      isTauriApp: isTauri,
      entryType: options.entry?.type,
      targetUrl: options.sampleStreamUrl || derivedStreamUrl,
      busy: connectionsAtLimit,
    })
  )

  const { verdict, messageKey } = deriveVerdict(steps)
  return finish({ steps, verdict, verdictMessage: t(messageKey) })
}

export async function runM3UDiagnostic(
  url: string,
  options: DiagnosticRunOptions = {}
): Promise<DiagnosticResult> {
  const steps: DiagnosticStep[] = []
  const pushStep = (step: DiagnosticStep) => {
    steps.push(step)
    options.onProgress?.(steps.slice())
  }

  const trimmed = String(url || "").trim()
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    pushStep({
      labelKey: "diagnostic.step.fetch",
      status: "fail",
      detail: t("diagnostic.detail.invalidUrl"),
    })
    return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.invalidUrl") })
  }

  const { providerFetch } = await import("@/scripts/lib/provider-fetch.js")

  const fetchStart = Date.now()
  let text = ""
  try {
    const response = await withTimeout(providerFetch(trimmed), STEP_TIMEOUT_MS)
    const latency = Date.now() - fetchStart
    if (!response.ok) {
      const classified = classifyError({ response })
      pushStep({
        labelKey: "diagnostic.step.fetch",
        status: "fail",
        latencyMs: latency,
        detail: t(`providerError.classify.${classified.kind}`, { status: String(classified.httpStatus ?? "") }),
        reason: classified.kind,
        httpStatus: classified.httpStatus,
      })
      return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.fetchFailed") })
    }
    text = await response.text()
    pushStep({
      labelKey: "diagnostic.step.fetch",
      status: "pass",
      latencyMs: latency,
      detail: t("diagnostic.detail.fetchOk", { status: String(response.status) }),
    })
  } catch (error) {
    const classified = classifyError({ error })
    pushStep({
      labelKey: "diagnostic.step.fetch",
      status: "fail",
      latencyMs: Date.now() - fetchStart,
      detail: t(`providerError.classify.${classified.kind}`),
      reason: classified.kind,
    })
    return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.fetchFailed") })
  }

  const parseStart = Date.now()
  const head = text.slice(0, 4096)
  const looksLikeM3U = head.includes("#EXTM3U") || /#EXTINF\s*:/i.test(head)
  if (!looksLikeM3U) {
    pushStep({
      labelKey: "diagnostic.step.parse",
      status: "fail",
      latencyMs: Date.now() - parseStart,
      detail: t("providerError.classify.bad_response"),
      reason: "bad_response",
    })
    return finish({ steps, verdict: "fail", verdictMessage: t("diagnostic.verdict.badResponse") })
  }
  const matches = text.match(/#EXTINF\s*:/gi)
  const count = matches ? matches.length : 0
  pushStep({
    labelKey: "diagnostic.step.parse",
    status: "pass",
    latencyMs: Date.now() - parseStart,
    count,
    detail: t("diagnostic.detail.count", { count: count.toLocaleString() }),
  })

  await Promise.all([
    probeEpgStep(extractM3UHeaderEpgUrl(text))
      .then((step) => pushStep(step))
      .catch(() => {
        pushStep({ labelKey: "diagnostic.step.epg", status: "skip", detail: t("diagnostic.detail.epgNone") })
      }),
    probeUpdaterStep()
      .then((step) => pushStep(step))
      .catch(() => {
        pushStep({ labelKey: "diagnostic.step.updater", status: "skip", detail: t("diagnostic.detail.updaterNotApplicable") })
      }),
  ])

  const sampleStreamCandidate = options.sampleStreamUrl || firstStreamUrlFromM3U(text)
  pushStep(
    await probeSampleStreamStep({
      isTauriApp: isTauri,
      entryType: options.entry?.type,
      targetUrl: isAbsoluteHttpUrl(sampleStreamCandidate) ? sampleStreamCandidate : null,
      busy: false,
    })
  )

  const { verdict, messageKey } = deriveVerdict(steps)
  return finish({ steps, verdict, verdictMessage: t(messageKey) })
}

/**
 * Render a diagnostic result into a container. Replaces existing children
 * so the caller can call this multiple times (e.g. after rerunning).
 *
 * Output structure:
 *   <header> verdict icon + verdict message
 *   <ul>     one <li> per step: icon, label, latency, detail
 */
export function renderDiagnosticInto(
  container: HTMLElement,
  result: DiagnosticResult
): void {
  const previousVerdict = container.dataset.diagnosticVerdict
  const isSettlement =
    previousVerdict === "running" && result.verdict !== "running"
  container.dataset.diagnosticVerdict = result.verdict

  container.replaceChildren()
  // Track managed classes on the element itself
  const prevManaged = container.dataset.diagnosticManaged
  if (prevManaged) {
    for (const cls of prevManaged.split(" ")) {
      if (cls) container.classList.remove(cls)
    }
  }
  const scaffold = [
    "flex",
    "flex-col",
    "gap-2.5",
    "rounded-xl",
    "border",
    "px-3.5",
    "py-3",
    "text-sm",
    "leading-relaxed",
    "transition-colors",
    "duration-300",
  ]
  let palette: string[]
  let verdictTextClass: string
  if (result.verdict === "ok") {
    palette = ["border-ok/40", "bg-ok/5"]
    verdictTextClass = "text-ok"
  } else if (result.verdict === "warn") {
    palette = ["border-warn/40", "bg-warn/5"]
    verdictTextClass = "text-warn"
  } else if (result.verdict === "running") {
    palette = ["border-line", "bg-surface"]
    verdictTextClass = "text-fg-2"
  } else {
    palette = ["border-bad/40", "bg-bad/5"]
    verdictTextClass = "text-bad"
  }
  const managed = [...scaffold, ...palette]
  container.classList.add(...managed)
  container.dataset.diagnosticManaged = managed.join(" ")

  const verdictRow = document.createElement("div")
  verdictRow.className = `flex items-center gap-2 font-semibold text-sm transition-colors duration-300 ${verdictTextClass}`
  const verdictIcon = document.createElement("span")
  verdictIcon.setAttribute("aria-hidden", "true")
  verdictIcon.className =
    "shrink-0 inline-flex items-center justify-center size-5 text-base tabular-nums leading-none " +
    (result.verdict === "running"
      ? "diagnostic-spinner"
      : isSettlement
      ? "diagnostic-verdict-settle"
      : "")
  verdictIcon.textContent =
    result.verdict === "ok"
      ? "✓"
      : result.verdict === "warn"
      ? "!"
      : result.verdict === "running"
      ? "⋯"
      : "✗"
  const verdictText = document.createElement("span")
  verdictText.textContent = result.verdictMessage
  verdictRow.append(verdictIcon, verdictText)
  container.appendChild(verdictRow)

  const list = document.createElement("ul")
  list.className = "flex flex-col gap-2 pl-0.5"
  for (const step of result.steps) {
    const item = document.createElement("li")
    item.className = "flex items-start gap-2 text-xs"
    const iconEl = document.createElement("span")
    iconEl.setAttribute("aria-hidden", "true")
    iconEl.className =
      "shrink-0 inline-flex items-center justify-center size-4 text-xs leading-none tabular-nums " +
      (step.status === "pass"
        ? "text-ok"
        : step.status === "warn"
        ? "text-warn"
        : step.status === "fail"
        ? "text-bad"
        : "text-fg-3")
    iconEl.textContent =
      step.status === "pass"
        ? "✓"
        : step.status === "warn"
        ? "!"
        : step.status === "fail"
        ? "✗"
        : "○"
    const body = document.createElement("div")
    body.className = "min-w-0 flex-1 text-fg"
    const labelRow = document.createElement("div")
    labelRow.className = "flex items-baseline justify-between gap-2"
    const label = document.createElement("span")
    label.className = "font-medium truncate"
    label.textContent = t(step.labelKey)
    labelRow.appendChild(label)
    if (step.latencyMs != null) {
      const latency = document.createElement("span")
      latency.className = "shrink-0 text-2xs text-fg-3 tabular-nums"
      latency.textContent = fmtLatency(step.latencyMs)
      labelRow.appendChild(latency)
    }
    body.appendChild(labelRow)
    if (step.detail) {
      const detail = document.createElement("div")
      detail.className = "mt-1 text-2xs text-fg-3 leading-relaxed"
      detail.textContent = step.detail
      body.appendChild(detail)
    }
    item.append(iconEl, body)
    list.appendChild(item)
  }
  container.appendChild(list)
}
