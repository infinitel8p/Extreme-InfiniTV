// Frontend facade for the Rust background catalog-warmup job runner (warmup.rs).

import {
  isTauri,
  getEntries,
  entryToCreds,
  xtreamCandidatesFor,
  getMirrorPin,
  setMirrorPin,
  isLikelyM3USource,
  isLocalM3UHost,
  isCustomHost,
  buildApiUrl,
} from "@/scripts/lib/creds.js"
import { hydrate, getCached, setCached, invalidateCustomDependents, hasInflightFetch } from "@/scripts/lib/cache.js"
import {
  ensureLive,
  ensureVod,
  ensureSeries,
  m3uToChannelList,
  CHANNELS_TTL_MS,
  VOD_TTL_MS,
  SERIES_TTL_MS,
  CATALOG_WARMED_EVENT,
  CATALOG_WARMING_START_EVENT,
  CATALOG_WARMING_PROGRESS_EVENT,
  CATALOG_WARMING_BYTES_EVENT,
} from "@/scripts/lib/catalog.js"
import {
  parseCategoriesToMap,
  mapXtreamLiveRows,
  mapXtreamVodRows,
  mapXtreamSeriesRows,
} from "@/scripts/lib/catalog-mappers.js"
import { ensureUserInfo } from "@/scripts/lib/account-info.js"
import { getUserAgent, getNetworkTimeoutSeconds } from "@/scripts/lib/app-settings.js"
import { DEFAULT_BROWSER_UA } from "@/scripts/lib/provider-fetch.js"
import { splitUrlAuth } from "@/scripts/lib/url-auth.ts"
import { parseM3U } from "@/scripts/lib/m3u-parser.ts"
import { log } from "@/scripts/lib/log.js"

export type WarmupKindName = "live" | "vod" | "series"
export type WarmupCacheKind = "live" | "m3u" | "vod" | "series"

// ---------------------------------------------------------------------------
// Wire types - must match warmup.rs serde shapes byte-for-byte.
// ---------------------------------------------------------------------------

interface StagedFile {
  step: string
  path: string
}

interface WarmupRequestSpec {
  url: string
  authorization: string | null
  userAgent: string | null
  mirrorIndex: number
}

interface WarmupStepSpec {
  name: string
  emitBytes: boolean
  candidates: WarmupRequestSpec[]
}

interface WarmupKindSpec {
  kind: WarmupKindName
  steps: WarmupStepSpec[]
}

export interface WarmupJobSpec {
  playlistId: string
  force: boolean
  timeoutMs: number
  kinds: WarmupKindSpec[]
}

interface WarmupKindStatus {
  kind: WarmupKindName
  state: string
  bytes: number
  totalBytes: number
  winningMirrorIndex: number | null
  stagedFiles: StagedFile[]
  error: string | null
}

interface WarmupStatus {
  jobId: string
  playlistId: string
  force: boolean
  state: string
  kinds: WarmupKindStatus[]
}

interface WarmupStartResult {
  jobId: string
  joined: boolean
  status: WarmupStatus
}

interface WarmupProgressEvent {
  jobId: string
  playlistId: string
  kind: WarmupKindName
  bytes: number
  totalBytes: number
}

interface WarmupKindDoneEvent {
  jobId: string
  playlistId: string
  kind: WarmupKindName
  winningMirrorIndex: number
  stagedFiles: StagedFile[]
}

interface WarmupKindErrorEvent {
  jobId: string
  playlistId: string
  kind: WarmupKindName
  error: string
}

const NATIVE_PROGRESS_EVENT = "xt:warmup-progress"
const NATIVE_KIND_DONE_EVENT = "xt:warmup-kind-done"
const NATIVE_KIND_ERROR_EVENT = "xt:warmup-kind-error"

// ---------------------------------------------------------------------------
// buildWarmupSpec - pure, all inputs passed in.
// ---------------------------------------------------------------------------

export interface XtreamCandidateInput {
  host: string
  port: string
  user: string
  pass: string
}

export interface BuildSpecInput {
  playlistId: string
  force: boolean
  timeoutSeconds: number
  userAgent: string
  kinds: WarmupKindName[]
  source:
    | { type: "xtream"; candidates: XtreamCandidateInput[]; startIndex: number }
    | { type: "m3u"; url: string }
}

const CATEGORY_ACTION: Record<WarmupKindName, string> = {
  live: "get_live_categories",
  vod: "get_vod_categories",
  series: "get_series_categories",
}
const STREAMS_ACTION: Record<WarmupKindName, string> = {
  live: "get_live_streams",
  vod: "get_vod_streams",
  series: "get_series",
}

function buildXtreamKindSpec(
  kind: WarmupKindName,
  candidates: XtreamCandidateInput[],
  startIndex: number,
  userAgent: string,
): WarmupKindSpec {
  const total = candidates.length
  const safeStart = total ? ((startIndex % total) + total) % total : 0
  const rotatedIndices = candidates.map((_candidate, offset) => (safeStart + offset) % total)

  const buildStepCandidates = (action: string): WarmupRequestSpec[] =>
    rotatedIndices.map((originalIndex) => ({
      url: buildApiUrl(candidates[originalIndex], action),
      authorization: null,
      userAgent,
      mirrorIndex: originalIndex,
    }))

  return {
    kind,
    steps: [
      { name: "categories", emitBytes: false, candidates: buildStepCandidates(CATEGORY_ACTION[kind]) },
      { name: "streams", emitBytes: true, candidates: buildStepCandidates(STREAMS_ACTION[kind]) },
    ],
  }
}

export function buildWarmupSpec(input: BuildSpecInput): WarmupJobSpec {
  const timeoutMs = Math.max(8000, input.timeoutSeconds * 1000)
  const kinds: WarmupKindSpec[] = []

  if (input.source.type === "xtream") {
    const { candidates, startIndex } = input.source
    for (const kind of input.kinds) {
      kinds.push(buildXtreamKindSpec(kind, candidates, startIndex, input.userAgent))
    }
  } else {
    const { url: cleanUrl, authorization } = splitUrlAuth(input.source.url)
    for (const kind of input.kinds) {
      if (kind !== "live") continue
      kinds.push({
        kind: "live",
        steps: [
          {
            name: "playlist",
            emitBytes: true,
            candidates: [{ url: cleanUrl, authorization, userAgent: input.userAgent, mirrorIndex: 0 }],
          },
        ],
      })
    }
  }

  return { playlistId: input.playlistId, force: input.force, timeoutMs, kinds }
}

// ---------------------------------------------------------------------------
// decideNativeKinds - pure: classifies each kind as native / cached / js.
// ---------------------------------------------------------------------------

export interface RunningStatusKind {
  kind: WarmupKindName
  state: string
}

export interface DecideNativeKindsInput {
  isM3U: boolean
  force: boolean
  allHot: boolean
  liveCached: boolean
  liveInflightJs: boolean
  vodCached: boolean
  vodInflightJs: boolean
  seriesCached: boolean
  seriesInflightJs: boolean
  // Only passed on a second pass, after a probe found a job already running
  // for this playlist. Null means "no probe performed / no job found".
  runningStatusKinds: RunningStatusKind[] | null
}

export interface DecideNativeKindsResult {
  nativeKinds: WarmupKindName[]
  // Already satisfied by cache; only needs an immediate "done" dispatch.
  cachedKinds: WarmupKindName[]
  // m3u vod/series: always resolved via the plain JS ensureVod/ensureSeries.
  jsKinds: WarmupKindName[]
  showWarming: boolean
  joinedRunningJob: boolean
}

function needsNativeFor(cached: boolean, inflightJs: boolean, force: boolean): boolean {
  return force || (!cached && !inflightJs)
}

export function decideNativeKinds(input: DecideNativeKindsInput): DecideNativeKindsResult {
  const jsKinds: WarmupKindName[] = input.isM3U ? ["vod", "series"] : []

  let nativeKinds: WarmupKindName[] = []
  if (needsNativeFor(input.liveCached, input.liveInflightJs, input.force)) nativeKinds.push("live")
  if (!input.isM3U && needsNativeFor(input.vodCached, input.vodInflightJs, input.force)) nativeKinds.push("vod")
  if (!input.isM3U && needsNativeFor(input.seriesCached, input.seriesInflightJs, input.force)) nativeKinds.push("series")

  // Local cache says every kind is satisfied, but a job may already be
  // downloading fresher data that just hasn't reached the cache yet.
  let joinedRunningJob = false
  if (!nativeKinds.length && input.runningStatusKinds?.length) {
    const adopted = input.runningStatusKinds
      .filter((kindStatus) => kindStatus.state !== "ingested")
      .map((kindStatus) => kindStatus.kind)
      .filter((kind) => kind === "live" || !input.isM3U)
    if (adopted.length) {
      nativeKinds = adopted
      joinedRunningJob = true
    }
  }

  const cachedKinds = (["live", "vod", "series"] as WarmupKindName[]).filter(
    (kind) => !nativeKinds.includes(kind) && !jsKinds.includes(kind),
  )

  return {
    nativeKinds,
    cachedKinds,
    jsKinds,
    showWarming: !input.allHot || joinedRunningJob,
    joinedRunningJob,
  }
}

// ---------------------------------------------------------------------------
// Ingestion - reads the staged files Rust downloaded and feeds the JS cache.
// ---------------------------------------------------------------------------

interface IngestContext {
  pid: string
  isM3U: boolean
  entry: any
  sourceUrl: string
}

function unwrapRows(parsed: unknown, arrayKey: "streams" | "movies" | "series"): unknown[] {
  if (Array.isArray(parsed)) return parsed
  const obj = parsed as Record<string, unknown> | null
  return (obj?.[arrayKey] as unknown[]) || (obj?.results as unknown[]) || []
}

async function ingestKind(
  jobId: string,
  jobKind: WarmupKindName,
  cacheKind: WarmupCacheKind,
  stagedFiles: StagedFile[],
  winningMirrorIndex: number,
  context: IngestContext,
): Promise<unknown[]> {
  const { invoke } = await import("@tauri-apps/api/core")
  const readStaged = (step: string) => invoke<string>("warmup_read_staged", { jobId, kind: jobKind, step })
  const fileFor = (step: string) => stagedFiles.find((file) => file.step === step)

  if (cacheKind === "m3u") {
    const playlistFile = fileFor("playlist")
    if (!playlistFile) return []
    const text = await readStaged(playlistFile.step)
    try {
      // Raw comma-joined list, matching the format catalog.js writes to the same key.
      const { epgUrls } = parseM3U(text)
      if (epgUrls.length && typeof localStorage !== "undefined") {
        localStorage.setItem(`xt_m3u_epg:${context.pid}`, epgUrls.join(","))
      }
    } catch {}
    const rows = m3uToChannelList(
      text,
      context.sourceUrl,
      context.entry?.streamHeaders,
      context.entry?.logo,
      context.entry?.manifestType,
      context.entry?.drmScheme,
      context.entry?.licenseKey,
    )
    setCached(context.pid, "m3u", rows, CHANNELS_TTL_MS)
    return rows
  }

  setMirrorPin(context.pid, winningMirrorIndex)
  const categoriesFile = fileFor("categories")
  const streamsFile = fileFor("streams")
  const categoriesRaw = categoriesFile ? JSON.parse(await readStaged(categoriesFile.step)) : []
  const categoryMap = parseCategoriesToMap(categoriesRaw)
  const streamsRaw = streamsFile ? JSON.parse(await readStaged(streamsFile.step)) : null

  if (jobKind === "live") {
    const rows = mapXtreamLiveRows(unwrapRows(streamsRaw, "streams"), categoryMap)
    setCached(context.pid, "live", rows, CHANNELS_TTL_MS)
    return rows
  }
  if (jobKind === "vod") {
    const rows = mapXtreamVodRows(unwrapRows(streamsRaw, "movies"), categoryMap)
    setCached(context.pid, "vod", rows, VOD_TTL_MS)
    return rows
  }
  const rows = mapXtreamSeriesRows(unwrapRows(streamsRaw, "series"), categoryMap)
  setCached(context.pid, "series", rows, SERIES_TTL_MS)
  return rows
}

// ---------------------------------------------------------------------------
// Job tracking - one active job at a time, matching the Rust slot.
// ---------------------------------------------------------------------------

interface KindTracker {
  cacheKind: WarmupCacheKind
  rows: unknown[]
  error: string | null
  settled: boolean
  // Guards the ingest window; settled alone flips too late to stop a re-entrant poll.
  ingesting: boolean
  settlePromise: Promise<void>
  resolveSettle: () => void
}

function createKindTracker(cacheKind: WarmupCacheKind): KindTracker {
  let resolveSettle: () => void = () => {}
  const settlePromise = new Promise<void>((resolve) => {
    resolveSettle = resolve
  })
  return { cacheKind, rows: [], error: null, settled: false, ingesting: false, settlePromise, resolveSettle }
}

function settleTracker(tracker: KindTracker): void {
  if (tracker.settled) return
  tracker.settled = true
  tracker.resolveSettle()
}

function cacheKindFor(jobKind: WarmupKindName, isM3U: boolean): WarmupCacheKind {
  return jobKind === "live" && isM3U ? "m3u" : jobKind
}

/** Adds trackers for kinds not already tracked by this job; existing trackers are untouched. */
function ensureTrackersForKinds(job: ActiveJobState, jobKinds: WarmupKindName[], isM3U: boolean): void {
  for (const jobKind of jobKinds) {
    if (!job.trackers.has(jobKind)) {
      job.trackers.set(jobKind, createKindTracker(cacheKindFor(jobKind, isM3U)))
    }
  }
}

interface ActiveJobState {
  jobId: string
  playlistId: string
  context: IngestContext
  trackers: Map<WarmupKindName, KindTracker>
  pollFailureCount: number
  cleanup: () => void
  ingestAndSettle: (jobKind: WarmupKindName, winningMirrorIndex: number, stagedFiles: StagedFile[]) => Promise<void>
  errorAndSettle: (jobKind: WarmupKindName, error: string) => void
}

let activeJob: ActiveJobState | null = null
let pendingStatusCheck: Promise<WarmupStatus | null> | null = null
const POLL_INTERVAL_MS = 2500
const MAX_POLL_FAILURES = 3

function dispatch(name: string, detail: unknown): void {
  try {
    document.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {}
}

function maybeFinishJob(job: ActiveJobState): void {
  if (![...job.trackers.values()].every((tracker) => tracker.settled)) return
  job.cleanup()
  if (activeJob === job) activeJob = null
}

function reconcileFromStatus(job: ActiveJobState, status: WarmupStatus): void {
  for (const kindStatus of status.kinds) {
    const tracker = job.trackers.get(kindStatus.kind)
    if (!tracker || tracker.settled) continue
    if (kindStatus.state === "ingested") {
      const cached = getCached(job.playlistId, tracker.cacheKind)
      tracker.rows = (cached?.data as unknown[]) || []
      dispatch(CATALOG_WARMING_PROGRESS_EVENT, {
        playlistId: job.playlistId,
        kind: kindStatus.kind,
        status: "done",
        count: tracker.rows.length,
      })
      settleTracker(tracker)
    } else if (kindStatus.state === "done") {
      void job.ingestAndSettle(kindStatus.kind, kindStatus.winningMirrorIndex ?? 0, kindStatus.stagedFiles)
    } else if (kindStatus.state === "error") {
      job.errorAndSettle(kindStatus.kind, kindStatus.error || "OTHER:unknown")
    } else {
      dispatch(CATALOG_WARMING_BYTES_EVENT, {
        playlistId: job.playlistId,
        kind: kindStatus.kind,
        bytes: kindStatus.bytes,
        total: kindStatus.totalBytes,
      })
    }
  }
  maybeFinishJob(job)
}

async function pollJobStatus(job: ActiveJobState): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const status = (await invoke("warmup_status")) as WarmupStatus | null
    job.pollFailureCount = 0
    if (!status || status.jobId !== job.jobId) return
    reconcileFromStatus(job, status)
  } catch (err) {
    job.pollFailureCount += 1
    log.warn("[xt:warmup-native] status poll failed:", err)
    // Events and polling both dead: fall through so pages don't hang forever.
    if (job.pollFailureCount >= MAX_POLL_FAILURES) {
      log.warn("[xt:warmup-native] abandoning unreachable job:", job.jobId)
      forceSettleJob(job, "OTHER:poll_unavailable")
      if (activeJob === job) activeJob = null
    }
  }
}

async function createTrackedJob(
  jobId: string,
  playlistId: string,
  wantedJobKinds: WarmupKindName[],
  context: IngestContext,
): Promise<ActiveJobState> {
  const trackers = new Map<WarmupKindName, KindTracker>()
  for (const jobKind of wantedJobKinds) {
    trackers.set(jobKind, createKindTracker(cacheKindFor(jobKind, context.isM3U)))
  }

  const unlistenFns: Array<() => void> = []
  let pollHandle: ReturnType<typeof setInterval> | null = null

  const job: ActiveJobState = {
    jobId,
    playlistId,
    context,
    trackers,
    pollFailureCount: 0,
    cleanup: () => {
      for (const unlisten of unlistenFns.splice(0)) {
        try {
          unlisten()
        } catch (err) {
          log.warn("[xt:warmup-native] unlisten failed:", err)
        }
      }
      if (pollHandle !== null) {
        clearInterval(pollHandle)
        pollHandle = null
      }
    },
    ingestAndSettle: async (jobKind, winningMirrorIndex, stagedFiles) => {
      const tracker = job.trackers.get(jobKind)
      if (!tracker || tracker.settled || tracker.ingesting) return
      tracker.ingesting = true
      try {
        const rows = await ingestKind(job.jobId, jobKind, tracker.cacheKind, stagedFiles, winningMirrorIndex, job.context)
        tracker.rows = rows
        const { invoke } = await import("@tauri-apps/api/core")
        await invoke("warmup_ack", { jobId: job.jobId, kind: jobKind })
        dispatch(CATALOG_WARMING_PROGRESS_EVENT, {
          playlistId: job.playlistId,
          kind: jobKind,
          status: "done",
          count: rows.length,
        })
      } catch (err) {
        tracker.error = String((err as Error)?.message || err)
        log.warn(`[xt:warmup-native] ingest failed for ${jobKind}:`, tracker.error)
        dispatch(CATALOG_WARMING_PROGRESS_EVENT, {
          playlistId: job.playlistId,
          kind: jobKind,
          status: "error",
          error: tracker.error,
        })
      } finally {
        settleTracker(tracker)
        maybeFinishJob(job)
      }
    },
    errorAndSettle: (jobKind, error) => {
      const tracker = job.trackers.get(jobKind)
      if (!tracker || tracker.settled) return
      tracker.error = error
      dispatch(CATALOG_WARMING_PROGRESS_EVENT, { playlistId: job.playlistId, kind: jobKind, status: "error", error })
      settleTracker(tracker)
      maybeFinishJob(job)
    },
  }

  try {
    const { listen } = await import("@tauri-apps/api/event")
    unlistenFns.push(
      await listen<WarmupProgressEvent>(NATIVE_PROGRESS_EVENT, (event) => {
        if (event.payload.jobId !== jobId) return
        dispatch(CATALOG_WARMING_BYTES_EVENT, {
          playlistId,
          kind: event.payload.kind,
          bytes: event.payload.bytes,
          total: event.payload.totalBytes,
        })
      }),
    )
    unlistenFns.push(
      await listen<WarmupKindDoneEvent>(NATIVE_KIND_DONE_EVENT, (event) => {
        if (event.payload.jobId !== jobId) return
        void job.ingestAndSettle(event.payload.kind, event.payload.winningMirrorIndex, event.payload.stagedFiles)
      }),
    )
    unlistenFns.push(
      await listen<WarmupKindErrorEvent>(NATIVE_KIND_ERROR_EVENT, (event) => {
        if (event.payload.jobId !== jobId) return
        job.errorAndSettle(event.payload.kind, event.payload.error)
      }),
    )
  } catch (err) {
    log.warn("[xt:warmup-native] listen setup failed:", err)
  }

  // Android can drop events during a webview reload; this is the safety net.
  pollHandle = setInterval(() => {
    void pollJobStatus(job)
  }, POLL_INTERVAL_MS)

  return job
}

function forceSettleJob(job: ActiveJobState, reason: string): void {
  for (const tracker of job.trackers.values()) {
    if (!tracker.settled) {
      tracker.error = tracker.error ?? reason
      settleTracker(tracker)
    }
  }
  job.cleanup()
}

function setActiveJob(next: ActiveJobState): void {
  if (activeJob && activeJob !== next) forceSettleJob(activeJob, "OTHER:superseded")
  activeJob = next
}

interface StartOrJoinResult {
  job: ActiveJobState
  // Wanted kinds actually present in the job's status - a joined job started
  // by another page may cover fewer kinds than this caller wants.
  coveredKinds: WarmupKindName[]
}

async function startOrJoinNativeJob(
  playlistId: string,
  spec: WarmupJobSpec,
  wantedJobKinds: WarmupKindName[],
  context: IngestContext,
): Promise<StartOrJoinResult> {
  const { invoke } = await import("@tauri-apps/api/core")
  const startResult = (await invoke("warmup_start", { spec })) as WarmupStartResult

  const jobKindsSet = new Set(startResult.status.kinds.map((kindStatus) => kindStatus.kind))
  const coveredKinds = wantedJobKinds.filter((jobKind) => jobKindsSet.has(jobKind))

  if (activeJob && activeJob.jobId === startResult.jobId) {
    ensureTrackersForKinds(activeJob, coveredKinds, context.isM3U)
    reconcileFromStatus(activeJob, startResult.status)
    return { job: activeJob, coveredKinds }
  }

  const job = await createTrackedJob(startResult.jobId, playlistId, coveredKinds, context)
  setActiveJob(job)
  if (startResult.joined) reconcileFromStatus(job, startResult.status)
  return { job, coveredKinds }
}

// ---------------------------------------------------------------------------
// Entry helpers shared by the three exported functions.
// ---------------------------------------------------------------------------

function buildSourceInput(entry: any, creds: { host: string }, isM3U: boolean): BuildSpecInput["source"] {
  if (isM3U) return { type: "m3u", url: creds.host }
  const candidates: XtreamCandidateInput[] = xtreamCandidatesFor(entry).map((candidate: XtreamCandidateInput) => ({
    host: candidate.host,
    port: candidate.port,
    user: candidate.user,
    pass: candidate.pass,
  }))
  const startIndex = candidates.length ? Math.min(getMirrorPin(entry._id), candidates.length - 1) : 0
  return { type: "xtream", candidates, startIndex }
}

async function buildIngestContext(playlistId: string): Promise<IngestContext | null> {
  const entries = await getEntries()
  const entry = entries.find((candidate: { _id: string }) => candidate._id === playlistId)
  if (!entry || entry.type === "custom" || entry.type === "local-m3u") return null
  const creds = entryToCreds(entry)
  if (isCustomHost(creds.host) || isLocalM3UHost(creds.host)) return null
  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  return { pid: playlistId, isM3U, entry, sourceUrl: creds.host }
}

/** Immediate "done" for a kind that isn't going through native or JS fetch - it's already cached. */
function dispatchCachedDone(playlistId: string, kind: WarmupKindName, cacheKind: WarmupCacheKind): void {
  const rows = (getCached(playlistId, cacheKind)?.data as unknown[]) || []
  dispatch(CATALOG_WARMING_PROGRESS_EVENT, { playlistId, kind, status: "done", count: rows.length })
}

function ensureKind(kind: WarmupKindName, creds: { host: string }, playlistId: string, force: boolean) {
  if (kind === "live") return ensureLive(creds, playlistId, { force })
  if (kind === "vod") return ensureVod(creds, playlistId, { force })
  return ensureSeries(creds, playlistId, { force })
}

// Exported only so the showWarming dispatch gate has direct test coverage.
export function wrapJsKind(
  playlistId: string,
  kind: WarmupKindName,
  run: () => Promise<unknown[]>,
  errors: Record<string, string>,
  showWarming: boolean,
): Promise<unknown[]> {
  return run()
    .then((rows) => {
      if (showWarming) {
        dispatch(CATALOG_WARMING_PROGRESS_EVENT, {
          playlistId,
          kind,
          status: "done",
          count: Array.isArray(rows) ? rows.length : 0,
        })
      }
      return rows
    })
    .catch((err) => {
      errors[kind] = String(err?.message || err)
      log.warn(`[xt:warmup-native] ${kind} warmup failed:`, errors[kind])
      if (showWarming) {
        dispatch(CATALOG_WARMING_PROGRESS_EVENT, { playlistId, kind, status: "error", error: errors[kind] })
      }
      return []
    })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WarmupNativeResult {
  live: unknown[]
  vod: unknown[]
  series: unknown[]
  errors: Record<string, string>
}

/** Native replacement for catalog.js's warmupActive(). Returns null when the
 *  caller should fall back to the plain JS fetch path. */
export async function warmupActiveNative(
  playlistId: string,
  opts: { force: boolean },
): Promise<WarmupNativeResult | null> {
  if (!isTauri) return null

  const entries = await getEntries()
  const entry = entries.find((candidate: { _id: string }) => candidate._id === playlistId)
  if (!entry || entry.type === "custom" || entry.type === "local-m3u") return null

  const creds = entryToCreds(entry)
  if (isCustomHost(creds.host) || isLocalM3UHost(creds.host)) return null
  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  const liveCacheKind: WarmupCacheKind = isM3U ? "m3u" : "live"
  const force = !!opts.force

  await Promise.all([hydrate(playlistId, liveCacheKind), hydrate(playlistId, "vod"), hydrate(playlistId, "series")])

  const allHot =
    !force &&
    !!getCached(playlistId, liveCacheKind) &&
    !!getCached(playlistId, "vod") &&
    !!getCached(playlistId, "series")

  const cacheSnapshot = {
    isM3U,
    force,
    allHot,
    liveCached: !!getCached(playlistId, liveCacheKind),
    liveInflightJs: hasInflightFetch(playlistId, liveCacheKind),
    vodCached: !!getCached(playlistId, "vod"),
    vodInflightJs: hasInflightFetch(playlistId, "vod"),
    seriesCached: !!getCached(playlistId, "series"),
    seriesInflightJs: hasInflightFetch(playlistId, "series"),
  }

  let plan = decideNativeKinds({ ...cacheSnapshot, runningStatusKinds: null })
  if (!plan.nativeKinds.length) {
    // Local cache looks fully satisfied, but a job may already be running
    // for this playlist - joining it is the only way the indicator/cache
    // learn about a still-in-flight refresh started before this navigation.
    if (!pendingStatusCheck) pendingStatusCheck = queryWarmupStatusOnce()
    const runningStatus = await pendingStatusCheck
    const runningStatusKinds =
      runningStatus && runningStatus.state === "running" && runningStatus.playlistId === playlistId
        ? runningStatus.kinds.map((kindStatus) => ({ kind: kindStatus.kind, state: kindStatus.state }))
        : null
    plan = decideNativeKinds({ ...cacheSnapshot, runningStatusKinds })
  }
  if (!plan.nativeKinds.length) return null

  if (plan.showWarming) {
    dispatch(CATALOG_WARMING_START_EVENT, { playlistId, kinds: ["live", "vod", "series"] })
  }

  const errors: Record<string, string> = {}
  const context: IngestContext = { pid: playlistId, isM3U, entry, sourceUrl: creds.host }
  const userInfoPromise = ensureUserInfo(creds, playlistId, { force }).catch(() => null)

  let vodRows: unknown[] = (getCached(playlistId, "vod")?.data as unknown[]) || []
  let seriesRows: unknown[] = (getCached(playlistId, "series")?.data as unknown[]) || []
  let liveRows: unknown[] = (getCached(playlistId, liveCacheKind)?.data as unknown[]) || []

  const jsKindPromises: Promise<void>[] = []
  if (plan.jsKinds.includes("vod")) {
    jsKindPromises.push(
      wrapJsKind(playlistId, "vod", () => ensureVod(creds, playlistId, { force }), errors, plan.showWarming).then(
        (rows) => {
          vodRows = rows
        },
      ),
    )
  }
  if (plan.jsKinds.includes("series")) {
    jsKindPromises.push(
      wrapJsKind(
        playlistId,
        "series",
        () => ensureSeries(creds, playlistId, { force }),
        errors,
        plan.showWarming,
      ).then((rows) => {
        seriesRows = rows
      }),
    )
  }

  if (plan.showWarming) {
    for (const kind of plan.cachedKinds) dispatchCachedDone(playlistId, kind, cacheKindFor(kind, isM3U))
  }

  try {
    const timeoutSeconds = getNetworkTimeoutSeconds()
    const userAgent = getUserAgent() || DEFAULT_BROWSER_UA
    const source = buildSourceInput(entry, creds, isM3U)
    const spec = buildWarmupSpec({ playlistId, force, timeoutSeconds, userAgent, kinds: plan.nativeKinds, source })

    const { job, coveredKinds } = await startOrJoinNativeJob(playlistId, spec, plan.nativeKinds, context)

    // A joined job started elsewhere may not cover everything this page wanted natively.
    for (const kind of plan.nativeKinds) {
      if (coveredKinds.includes(kind)) continue
      const cacheKind = cacheKindFor(kind, isM3U)
      const cached = getCached(playlistId, cacheKind)
      if (cached) {
        if (plan.showWarming) dispatchCachedDone(playlistId, kind, cacheKind)
        continue
      }
      // Genuinely uncached and not covered by the joined job - fetch it for real.
      jsKindPromises.push(
        wrapJsKind(playlistId, kind, () => ensureKind(kind, creds, playlistId, force), errors, plan.showWarming).then(
          (rows) => {
            if (kind === "live") liveRows = rows
            else if (kind === "vod") vodRows = rows
            else seriesRows = rows
          },
        ),
      )
    }

    await Promise.all(
      coveredKinds.map(async (jobKind) => {
        const tracker = job.trackers.get(jobKind)
        if (!tracker) return
        await tracker.settlePromise
        if (tracker.error) {
          errors[jobKind] = tracker.error
        } else if (jobKind === "live") {
          liveRows = tracker.rows
        } else if (jobKind === "vod") {
          vodRows = tracker.rows
        } else {
          seriesRows = tracker.rows
        }
      }),
    )
  } catch (err) {
    log.warn("[xt:warmup-native] native job failed to start:", err)
    return null
  }

  await Promise.all([userInfoPromise, ...jsKindPromises])

  if (force) await invalidateCustomDependents(playlistId)
  dispatch(CATALOG_WARMED_EVENT, { playlistId, errors })

  return { live: liveRows, vod: vodRows, series: seriesRows, errors }
}

async function queryWarmupStatusOnce(): Promise<WarmupStatus | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return (await invoke("warmup_status")) as WarmupStatus | null
  } catch (err) {
    log.warn("[xt:warmup-native] status query failed:", err)
    return null
  } finally {
    pendingStatusCheck = null
  }
}

/** Resolves once the given cache kind's native fetch (if any) has settled. Never rejects. */
export async function awaitNativeKind(playlistId: string, cacheKind: WarmupCacheKind): Promise<void> {
  if (!isTauri) return
  const jobKind: WarmupKindName = cacheKind === "m3u" ? "live" : cacheKind

  if (activeJob && activeJob.playlistId === playlistId) {
    const tracker = activeJob.trackers.get(jobKind)
    if (tracker) {
      await tracker.settlePromise
      return
    }
  }

  if (!pendingStatusCheck) pendingStatusCheck = queryWarmupStatusOnce()
  const status = await pendingStatusCheck
  if (!status || status.state !== "running" || status.playlistId !== playlistId) return
  const kindStatus = status.kinds.find((candidateKindStatus) => candidateKindStatus.kind === jobKind)
  if (!kindStatus || kindStatus.state === "ingested") return

  // Same job as the active one: merge a tracker in rather than replacing the
  // job, which would force-settle its other in-flight kinds as superseded.
  if (activeJob && activeJob.jobId === status.jobId) {
    ensureTrackersForKinds(activeJob, [jobKind], activeJob.context.isM3U)
    reconcileFromStatus(activeJob, status)
    const tracker = activeJob.trackers.get(jobKind)
    if (tracker) await tracker.settlePromise
    return
  }

  const context = await buildIngestContext(playlistId)
  if (!context) return

  const job = await createTrackedJob(status.jobId, status.playlistId, [jobKind], context)
  setActiveJob(job)
  reconcileFromStatus(job, status)

  const tracker = job.trackers.get(jobKind)
  if (tracker) await tracker.settlePromise
}

/** Force a native re-fetch of one kind. Returns false when the caller should fall back to the JS retry path. */
export async function retryKindNative(playlistId: string, kind: WarmupKindName): Promise<boolean> {
  if (!isTauri) return false
  const entries = await getEntries()
  const entry = entries.find((candidate: { _id: string }) => candidate._id === playlistId)
  if (!entry || entry.type === "custom" || entry.type === "local-m3u") return false

  const creds = entryToCreds(entry)
  if (isCustomHost(creds.host) || isLocalM3UHost(creds.host)) return false
  const isM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  if (isM3U && kind !== "live") return false

  dispatch(CATALOG_WARMING_PROGRESS_EVENT, { playlistId, kind, status: "pending" })

  try {
    const timeoutSeconds = getNetworkTimeoutSeconds()
    const userAgent = getUserAgent() || DEFAULT_BROWSER_UA
    const source = buildSourceInput(entry, creds, isM3U)
    const spec = buildWarmupSpec({ playlistId, force: true, timeoutSeconds, userAgent, kinds: [kind], source })
    const context: IngestContext = { pid: playlistId, isM3U, entry, sourceUrl: creds.host }

    const { job, coveredKinds } = await startOrJoinNativeJob(playlistId, spec, [kind], context)
    if (!coveredKinds.includes(kind)) return false
    const tracker = job.trackers.get(kind)
    if (!tracker) return false
    await tracker.settlePromise

    if (tracker.error) {
      dispatch(CATALOG_WARMING_PROGRESS_EVENT, { playlistId, kind, status: "error", error: tracker.error })
    } else {
      if (kind === "live") await invalidateCustomDependents(playlistId)
      dispatch(CATALOG_WARMING_PROGRESS_EVENT, { playlistId, kind, status: "done", count: tracker.rows.length })
    }
    return true
  } catch (err) {
    log.warn(`[xt:warmup-native] retry ${kind} failed:`, err)
    return false
  }
}
