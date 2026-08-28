// Receiver playback engine abstraction: embedded WebView player vs the
// Android native ExoPlayer handoff. Both report through the same callbacks
// so the orchestrator (receiver.ts) doesn't need to know which one is live.
import {
  mountPlayer,
  playWhenReady,
  type Mounted,
  type VjsLikeHandle,
} from "@/scripts/lib/player-runtime"
import { getPlayerBackend } from "@/scripts/lib/app-settings.js"
import type { CastDescriptorV1 } from "@/scripts/lib/tv-cast-descriptor"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { decodedFrameCount } from "@/scripts/lib/player-telemetry.js"
import {
  classifyStartFailure,
  deviceSupportsHevc,
  hasHevcNameHint,
  httpStatusFromErrorDetail,
  isConnectionLimitStatus,
  type StartFailureKind,
  type StartFailureVerdict,
} from "@/scripts/lib/codec-hints.js"
import {
  launchAndroidNativeLive,
  launchAndroidNativeVod,
  subscribeAndroidNativeEvents,
  type AndroidNativeEvent,
} from "@/scripts/lib/android-video-launcher.js"
import {
  messageKeyForProbeVerdict,
  probeManifestSource,
  type ManifestProbeVerdict,
} from "@/scripts/lib/manifest-probe.js"

export type ReceiverPlaybackState =
  | "idle"
  | "loading"
  | "buffering"
  | "playing"
  | "paused"
  | "ended"
  | "error"

export interface ReceiverStatePartial {
  state?: ReceiverPlaybackState
  positionSeconds?: number
  durationSeconds?: number
  error?: string
  volume?: number
  muted?: boolean
}

export interface ReceiverEngineCallbacks {
  report(partial: ReceiverStatePartial): void
  onSessionEnded(): void
  onLiveChannelChanged?(channelId: string, channelName: string): void
  onFinished?(finalChannelId: string | null): void
}

export type ReceiverControlAction = "pause" | "resume" | "seek" | "stop"

export type NativeLiveChannel = Parameters<typeof launchAndroidNativeLive>[0]["channels"][number]

export interface ReceiverLiveContext {
  channels: NativeLiveChannel[]
  initialChannelId: string
}

export interface ReceiverPlayOptions {
  liveContext?: ReceiverLiveContext
}

export interface ReceiverEngine {
  play(descriptor: CastDescriptorV1, options?: ReceiverPlayOptions): Promise<boolean>
  control(action: ReceiverControlAction, seconds?: number): void
  setVolume(level: number, muted: boolean): void
  teardown(): void
}

/** Clamps to [0, 1], treating non-finite input as silence rather than throwing. */
export function clampReceiverVolume(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.min(1, Math.max(0, level))
}

/** A duration only means something once it is finite and positive: live HLS reports Infinity and a pre-metadata read is 0 or NaN. */
export function normalizeReportedDuration(seconds: number | null | undefined): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined
  return seconds
}

/** Same gate for the native player's millisecond payload; ExoPlayer omits the field for C.TIME_UNSET. */
export function durationSecondsFromMs(durationMs: number | null | undefined): number | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return undefined
  return Math.floor(durationMs / 1000)
}

/** The remote reveals its slider only for a report carrying a level, so "none" must mean "no volume surface". */
export function normalizeReportedVolume(level: number | null | undefined): number | undefined {
  if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) return undefined
  return level
}

// ---------------------------------------------------------------------
// Embedded engine: mountPlayer-backed playback inside the receiver page.
// ---------------------------------------------------------------------

export interface EmbeddedEngineDom {
  idleEl: HTMLElement | null
  playerViewEl: HTMLElement | null
  videoEl: HTMLVideoElement | null
  titleWrapEl: HTMLElement | null
  titleEl: HTMLElement | null
  loadingEl: HTMLElement | null
  loadingTitleEl: HTMLElement | null
  pausedEl: HTMLElement | null
  errorEl: HTMLElement | null
  errorMessageEl: HTMLElement | null
  errorCountdownEl: HTMLElement | null
  errorRetryEl: HTMLElement | null
}

const FAILURE_MESSAGE_KEYS: Partial<Record<StartFailureKind, string>> = {
  hevc: "receiver.error.hevc",
  codec: "receiver.error.videoCodec",
  audio: "receiver.error.audioCodec",
  parse: "receiver.error.container",
}

// Time to let a stream settle before judging zero decoded frames a decode failure.
const DEAD_VIDEO_CHECK_MS = 6000
const DEAD_VIDEO_RECHECK_MS = 4000
const DEAD_VIDEO_MIN_PLAYED_S = 3
// This long without a sign of load progress is a stuck load, not a slow one.
const LOADING_TIMEOUT_MS = 30000
// An MP4 with a tail moov box fires no media event until it parses, which can mean the whole file.
const VOD_LOADING_TIMEOUT_MS = 90000
const LOADING_MAX_WAIT_MS = 180000
const LOAD_PROGRESS_EVENTS = ["progress", "loadedmetadata", "loadeddata", "canplay", "seeked"]
const ERROR_HIDE_MS = 10000
const TITLE_HIDE_MS = 5000

export function createEmbeddedReceiverEngine(
  dom: EmbeddedEngineDom,
  callbacks: ReceiverEngineCallbacks,
): ReceiverEngine {
  let mounted: Mounted | null = null
  let activeHandle: VjsLikeHandle | null = null
  let mediaListenersWired = false
  let currentTitle = ""
  let currentMime = ""
  let currentSrc = ""
  let currentUserAgent: string | null = null
  let currentIsLive = false
  let currentPlaybackState: ReceiverPlaybackState = "idle"
  let knownDurationSeconds: number | undefined
  let tearingDown = false
  let errorReported = false
  let lastTimeReportAt = 0

  let titleHideTimer: ReturnType<typeof setTimeout> | null = null
  let errorHideTimer: ReturnType<typeof setTimeout> | null = null
  let deadVideoTimer: ReturnType<typeof setTimeout> | null = null
  let loadingTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  let lastLoadProgressAt = 0

  function getMediaElementFor(handle: VjsLikeHandle | null): HTMLVideoElement | null {
    return handle?.getMediaElement?.() ?? dom.videoEl
  }

  // Backends answer 0 for unknown; reporting 0 would pin the remote's scrubber range at zero.
  function currentDurationSeconds(explicit?: number): number | undefined {
    if (currentIsLive) return undefined
    const mediaEl = getMediaElementFor(activeHandle)
    return normalizeReportedDuration(explicit)
      ?? normalizeReportedDuration(activeHandle?.duration?.())
      ?? normalizeReportedDuration(mediaEl?.duration)
      ?? knownDurationSeconds
  }

  function report(partial: ReceiverStatePartial): void {
    if (partial.state) currentPlaybackState = partial.state
    const mediaEl = getMediaElementFor(activeHandle)
    const durationSeconds = currentDurationSeconds(partial.durationSeconds)
    if (durationSeconds !== undefined) knownDurationSeconds = durationSeconds
    // Read live off the media element so even a plain state transition carries a level.
    const volume = normalizeReportedVolume(partial.volume ?? mediaEl?.volume)
    callbacks.report({
      state: partial.state ?? currentPlaybackState,
      positionSeconds: partial.positionSeconds ?? mediaEl?.currentTime ?? 0,
      durationSeconds,
      error: partial.error,
      volume,
      muted: volume === undefined ? undefined : (partial.muted ?? mediaEl?.muted ?? false),
    })
  }

  function showLoading(show: boolean, title?: string): void {
    dom.loadingEl?.classList.toggle("hidden", !show)
    if (show) {
      if (dom.loadingTitleEl) {
        dom.loadingTitleEl.textContent = title ? t("receiver.loadingTitle", { title }) : t("receiver.loading")
      }
      dom.pausedEl?.classList.add("hidden")
    }
  }

  function showPlayerView(title: string): void {
    dom.idleEl?.classList.add("hidden")
    dom.errorEl?.classList.add("hidden")
    dom.playerViewEl?.classList.remove("hidden")
    if (!dom.titleEl || !dom.titleWrapEl) return
    dom.titleEl.textContent = title
    dom.titleWrapEl.classList.remove("opacity-0")
    if (titleHideTimer) clearTimeout(titleHideTimer)
    titleHideTimer = setTimeout(() => dom.titleWrapEl?.classList.add("opacity-0"), TITLE_HIDE_MS)
  }

  function mediaErrorMessageKey(code: number): string | null {
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return "receiver.error.container"
    if (code === MediaError.MEDIA_ERR_DECODE) return "receiver.error.videoCodec"
    if (code === MediaError.MEDIA_ERR_NETWORK) return "receiver.error.network"
    return null
  }

  function mediaErrorTechnical(mediaError: MediaError): string {
    const parts = [currentMime, `MediaError ${mediaError.code}${mediaError.message ? `: ${mediaError.message}` : ""}`]
    return parts.filter(Boolean).join("; ")
  }

  function classifyCurrentFailure(): StartFailureVerdict {
    const info = activeHandle?.codecInfo?.() ?? { videoCodec: null, audioCodec: null, errorDetail: null }
    return classifyStartFailure({
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      errorDetail: info.errorDetail,
      nameHint: hasHevcNameHint(currentTitle),
      deviceHevc: deviceSupportsHevc(),
    })
  }

  type FailureContext = "player" | "dead-video" | "timeout"

  function describePlaybackError(context: FailureContext): { messageKey: string; technical: string | null } {
    if (context === "timeout") return { messageKey: "receiver.error.timeout", technical: null }

    // A provider refusal is unambiguous, so it settles the message before any codec guesswork.
    const refusedStatus = httpStatusFromErrorDetail(activeHandle?.codecInfo?.()?.errorDetail)
    if (isConnectionLimitStatus(refusedStatus)) {
      return { messageKey: "receiver.error.connectionLimit", technical: `HTTP ${refusedStatus}` }
    }

    const verdict = classifyCurrentFailure()
    const knownKey = FAILURE_MESSAGE_KEYS[verdict.kind]
    if (knownKey) return { messageKey: knownKey, technical: verdict.codec }

    // A dead-video conviction is already known to be a video decode failure even without a codec string.
    if (context === "dead-video") return { messageKey: "receiver.error.videoCodec", technical: verdict.codec }

    const mediaError = getMediaElementFor(activeHandle)?.error
    if (mediaError) {
      const messageKey = mediaErrorMessageKey(mediaError.code)
      if (messageKey) return { messageKey, technical: mediaErrorTechnical(mediaError) }
    }

    const errorDetail = activeHandle?.codecInfo?.()?.errorDetail
    if (errorDetail) return { messageKey: "receiver.error.title", technical: errorDetail }

    return { messageKey: "receiver.error.title", technical: null }
  }

  async function handleError(context: FailureContext = "player"): Promise<void> {
    // A flapping stream fires error after error; the first report speaks for them all.
    if (errorReported) return
    errorReported = true
    clearDeadVideoWatchdog()
    clearLoadingWatchdog()
    const handleAtFailure = activeHandle
    const described = describePlaybackError(context)
    const refined = await refineParseFailureKey(described.messageKey, {
      src: currentSrc,
      userAgent: currentUserAgent,
    })
    // A new play() during the probe owns the screen; painting this error would clobber it.
    if (activeHandle !== handleAtFailure) return
    const message = t(refined.messageKey)
    const verdictPart = refined.verdict && refined.verdict !== "inconclusive" ? `probe ${refined.verdict}` : null
    const technical = [described.technical, verdictPart].filter(Boolean).join("; ") || null
    const detail = technical ? `${message} (${technical})`.slice(0, 300) : message
    log.error("[xt:receiver] playback failed:", detail)
    if (dom.errorMessageEl) dom.errorMessageEl.textContent = message
    showLoading(false)
    dom.pausedEl?.classList.add("hidden")
    dom.errorEl?.classList.remove("hidden")
    if (dom.errorCountdownEl) {
      dom.errorCountdownEl.classList.remove("receiver-countdown-run")
      void dom.errorCountdownEl.offsetWidth
      dom.errorCountdownEl.classList.add("receiver-countdown-run")
    }
    report({ state: "error", error: detail, positionSeconds: 0 })
    if (errorHideTimer) clearTimeout(errorHideTimer)
    errorHideTimer = setTimeout(() => teardownInternal(true), ERROR_HIDE_MS)
    // Single OK press retries: the panel's only control should already have focus.
    dom.errorRetryEl?.focus()
  }

  function clearDeadVideoWatchdog(): void {
    if (deadVideoTimer) {
      clearTimeout(deadVideoTimer)
      deadVideoTimer = null
    }
  }

  function armDeadVideoWatchdog(handle: VjsLikeHandle): void {
    clearDeadVideoWatchdog()
    const baselineTime = getMediaElementFor(handle)?.currentTime ?? 0
    let rechecked = false
    const check = () => {
      deadVideoTimer = null
      if (activeHandle !== handle) return
      const mediaEl = getMediaElementFor(handle)
      if (!mediaEl || mediaEl.paused) return
      if (mediaEl.videoWidth === 0 && mediaEl.videoHeight === 0) return
      const frames = decodedFrameCount(mediaEl)
      if (frames === null || frames > 0) return
      const playedEnough = (mediaEl.currentTime || 0) - baselineTime >= DEAD_VIDEO_MIN_PLAYED_S
      if (!playedEnough && !rechecked) {
        rechecked = true
        deadVideoTimer = setTimeout(check, DEAD_VIDEO_RECHECK_MS)
        return
      }
      log.warn("[xt:receiver] video track decoded zero frames - treating as start failure")
      try { handle.pause() } catch {}
      void handleError("dead-video")
    }
    deadVideoTimer = setTimeout(check, DEAD_VIDEO_CHECK_MS)
  }

  function clearLoadingWatchdog(): void {
    if (loadingTimeoutTimer) {
      clearTimeout(loadingTimeoutTimer)
      loadingTimeoutTimer = null
    }
  }

  function armLoadingWatchdog(handle: VjsLikeHandle): void {
    clearLoadingWatchdog()
    const armedAt = Date.now()
    const silenceWindowMs = currentIsLive ? LOADING_TIMEOUT_MS : VOD_LOADING_TIMEOUT_MS
    lastLoadProgressAt = armedAt
    const check = () => {
      loadingTimeoutTimer = null
      if (activeHandle !== handle || currentPlaybackState === "playing") return
      const sinceProgress = Date.now() - lastLoadProgressAt
      const sinceArmed = Date.now() - armedAt
      if (sinceProgress < silenceWindowMs && sinceArmed < LOADING_MAX_WAIT_MS) {
        const wait = Math.min(silenceWindowMs - sinceProgress, LOADING_MAX_WAIT_MS - sinceArmed)
        loadingTimeoutTimer = setTimeout(check, Math.max(wait, 0))
        return
      }
      log.warn("[xt:receiver] stream never reached playing state within timeout")
      void handleError("timeout")
    }
    loadingTimeoutTimer = setTimeout(check, silenceWindowMs)
  }

  function teardownInternal(notify: boolean): void {
    tearingDown = true
    if (titleHideTimer) clearTimeout(titleHideTimer)
    if (errorHideTimer) clearTimeout(errorHideTimer)
    clearDeadVideoWatchdog()
    clearLoadingWatchdog()
    try { activeHandle?.pause() } catch {}
    try { activeHandle?.reset?.() } catch {}
    dom.playerViewEl?.classList.add("hidden")
    dom.errorEl?.classList.add("hidden")
    dom.errorCountdownEl?.classList.remove("receiver-countdown-run")
    dom.titleWrapEl?.classList.add("opacity-0")
    dom.pausedEl?.classList.add("hidden")
    dom.idleEl?.classList.remove("hidden")
    knownDurationSeconds = undefined
    report({ state: "idle", positionSeconds: 0 })
    tearingDown = false
    if (notify) callbacks.onSessionEnded()
  }

  function wireMediaListeners(handle: VjsLikeHandle): void {
    if (mediaListenersWired) return
    mediaListenersWired = true
    handle.on("playing", () => {
      showLoading(false)
      dom.pausedEl?.classList.add("hidden")
      clearLoadingWatchdog()
      armDeadVideoWatchdog(handle)
      report({ state: "playing" })
    })
    handle.on("pause", () => {
      if (tearingDown) return
      clearLoadingWatchdog()
      dom.pausedEl?.classList.remove("hidden")
      report({ state: "paused" })
    })
    handle.on("waiting", () => {
      showLoading(true)
      // The initial arm is cleared on first playing, so a mid-stream stall had no timeout at all.
      armLoadingWatchdog(handle)
      report({ state: "buffering" })
    })
    handle.on("ended", () => {
      report({ state: "ended" })
      teardownInternal(true)
    })
    handle.on("error", () => void handleError())
    for (const event of LOAD_PROGRESS_EVENTS) {
      handle.on(event, () => { lastLoadProgressAt = Date.now() })
    }
    handle.on("timeupdate", () => {
      const now = Date.now()
      if (now - lastTimeReportAt < 1000) return
      lastTimeReportAt = now
      const mediaEl = getMediaElementFor(handle)
      report({
        state: currentPlaybackState,
        positionSeconds: mediaEl?.currentTime ?? 0,
        durationSeconds: handle.duration?.(),
      })
    })
  }

  async function ensurePlayer(): Promise<VjsLikeHandle | null> {
    if (mounted?.kind === "embedded") return mounted.handle
    if (!dom.videoEl) return null
    let backend = getPlayerBackend()
    if (backend === "mpv" || backend === "vlc") backend = "artplayer"
    const result = await mountPlayer(dom.videoEl, backend, { autoplay: true })
    if (result.kind !== "embedded") {
      log.warn("[xt:receiver] mountPlayer returned an external backend; receiver requires embedded playback")
      return null
    }
    mounted = result
    wireMediaListeners(result.handle)
    return result.handle
  }

  return {
    async play(descriptor: CastDescriptorV1): Promise<boolean> {
      tearingDown = false
      clearDeadVideoWatchdog()
      clearLoadingWatchdog()
      errorReported = false
      currentTitle = descriptor.title
      currentMime = descriptor.mime
      currentSrc = descriptor.src
      currentUserAgent = descriptor.headers?.userAgent ?? null
      currentIsLive = descriptor.isLive
      // Seeded from the sender's metadata so the first report already carries a range.
      knownDurationSeconds = descriptor.isLive ? undefined : normalizeReportedDuration(descriptor.durationSeconds)

      report({ state: "loading", positionSeconds: 0 })
      showLoading(true, descriptor.title)

      const handle = await ensurePlayer()
      if (!handle) return false
      activeHandle = handle

      handle.src({
        src: descriptor.src,
        type: descriptor.mime,
        drm: descriptor.drm ?? null,
        isLive: descriptor.isLive,
        durationSeconds: descriptor.durationSeconds,
        timelineOffsetSeconds: descriptor.timelineOffsetSeconds,
        preferNativeHls: descriptor.preferNativeHls,
      })
      armLoadingWatchdog(handle)

      if (!descriptor.isLive && (descriptor.resumeSeconds ?? 0) > 5) {
        const resumeSeconds = descriptor.resumeSeconds!
        getMediaElementFor(handle)?.addEventListener(
          "loadedmetadata",
          () => { handle.currentTime?.(resumeSeconds) },
          { once: true }
        )
      }

      playWhenReady(handle, {
        isStale: () => activeHandle !== handle,
        onReject: (err) => log.warn("[xt:receiver] play() rejected:", err),
      })

      showPlayerView(descriptor.title)
      return true
    },

    control(action: ReceiverControlAction, seconds?: number): void {
      switch (action) {
        case "pause":
          activeHandle?.pause()
          break
        case "resume":
          if (activeHandle) playWhenReady(activeHandle)
          break
        case "seek":
          if (activeHandle && !currentIsLive && typeof seconds === "number") {
            activeHandle.currentTime?.(seconds)
          }
          break
        case "stop":
          teardownInternal(true)
          break
        default:
          break
      }
    },

    setVolume(level: number, muted: boolean): void {
      const clamped = clampReceiverVolume(level)
      const mediaEl = getMediaElementFor(activeHandle)
      if (mediaEl) {
        mediaEl.volume = clamped
        mediaEl.muted = muted
      }
      activeHandle?.muted?.(muted)
      report({ volume: clamped, muted })
    },

    teardown(): void {
      teardownInternal(false)
    },
  }
}

// ---------------------------------------------------------------------
// Android native engine: hands off to VideoActivity's ExoPlayer.
// ---------------------------------------------------------------------

// Media3 PlaybackException.errorCodeName values, plus our synthetic
// "SOURCE_UNSUPPORTED" from VideoActivity's media-source construction catch.
export function mapNativeErrorCode(code: string | null | undefined, httpStatus?: number | null): string {
  const normalized = (code || "").toUpperCase()
  // A refusal outranks the transport code: BAD_HTTP_STATUS alone reads as a network fault.
  if (isConnectionLimitStatus(httpStatus)) return "receiver.error.connectionLimit"
  if (!normalized) return "receiver.error.title"
  if (normalized.includes("DECODING") || normalized.includes("DECODER") || normalized.includes("DRM")) {
    return "receiver.error.videoCodec"
  }
  if (normalized.includes("AUDIO_TRACK")) return "receiver.error.audioCodec"
  if (
    normalized.includes("PARSING") ||
    normalized.includes("SOURCE_UNSUPPORTED") ||
    normalized.includes("CONTAINER")
  ) {
    return "receiver.error.container"
  }
  if (normalized.includes("TIMEOUT")) return "receiver.error.timeout"
  if (normalized.includes("IO_") || normalized.includes("BAD_HTTP") || normalized.includes("NETWORK")) {
    return "receiver.error.network"
  }
  return "receiver.error.title"
}

/** Keys that only mean "the player couldn't parse this" - a provider refusal looks identical. */
const PROBE_REFINABLE_KEYS = new Set(["receiver.error.container", "receiver.error.title"])

/** Asked only when the player's verdict is a parse guess, which a provider refusal mimics. */
export async function refineParseFailureKey(
  messageKey: string,
  source: { src: string; userAgent?: string | null }
): Promise<{ messageKey: string; verdict: ManifestProbeVerdict | null }> {
  if (!PROBE_REFINABLE_KEYS.has(messageKey) || !source.src) return { messageKey, verdict: null }
  const verdict = await probeManifestSource(source.src, { userAgent: source.userAgent })
  return { messageKey: messageKeyForProbeVerdict(verdict) ?? messageKey, verdict }
}

const RECEIVER_LIVE_CONTENT_KEY = "receiver-live"
const RECEIVER_VOD_CONTENT_KEY = "receiver-vod"
const RECEIVER_LIVE_CHANNEL_ID = "cast"

export function createAndroidNativeReceiverEngine(callbacks: ReceiverEngineCallbacks): ReceiverEngine {
  let unsubscribe: (() => void) | null = null
  let isLive = false
  // Kept for the error path's probe, which runs after the source is out of view.
  let activeSrc = ""
  let activeUserAgent: string | null = null
  let errorReported = false
  // Sticky so pause / resume / seek echoes keep carrying the range the progress ticks established.
  let knownDurationSeconds: number | undefined
  // Mirrors VideoActivity's ReceiverVolumeState so every report carries a level from the start.
  const volumeControlAvailable = typeof window !== "undefined" && !!window.AndroidVideo?.receiverVolume
  let knownVolume = 1
  let knownMuted = false
  // Bumped on every play() so a stale event from a torn-down session (its
  // finishPlayback() is async via runOnUiThread) can't clobber a newer one.
  let generation = 0
  let activeContentKey = ""
  // null = synthetic single "cast" channel
  let liveChannelIds: Set<string> | null = null

  function stopListening(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  function report(partial: ReceiverStatePartial): void {
    if (!volumeControlAvailable) {
      callbacks.report(partial)
      return
    }
    callbacks.report({
      ...partial,
      volume: partial.volume ?? knownVolume,
      muted: partial.muted ?? knownMuted,
    })
  }

  // Finishes the native activity and unwinds our end of the session. Safe to
  // call after the activity already finished itself (Kotlin no-ops).
  function finishAndEndSession(): void {
    knownDurationSeconds = undefined
    try { window.AndroidVideo?.receiverControl?.("stop", 0) } catch {}
    stopListening()
    try { window.AndroidVideo?.receiverSessionEnd?.() } catch {}
  }

  // VideoActivity's loadChannel catch reports "live:<channelId>", not the launch contentKey
  function isLiveChannelKey(contentKey: string): boolean {
    if (!contentKey.startsWith("live:")) return false
    const channelId = contentKey.slice("live:".length)
    return liveChannelIds ? liveChannelIds.has(channelId) : channelId === RECEIVER_LIVE_CHANNEL_ID
  }

  function isCurrentEvent(sessionGeneration: number, contentKey: string | undefined): boolean {
    if (sessionGeneration !== generation) return false
    if (!contentKey) return true
    return contentKey === activeContentKey || isLiveChannelKey(contentKey)
  }

  async function reportNativeError(sessionGeneration: number, event: AndroidNativeEvent): Promise<void> {
    if (errorReported) return
    errorReported = true
    const httpStatus = event.payload.httpStatus ?? null
    const mapped = mapNativeErrorCode(event.payload.code, httpStatus)
    const { messageKey, verdict } = httpStatus
      ? { messageKey: mapped, verdict: null }
      : await refineParseFailureKey(mapped, { src: activeSrc, userAgent: activeUserAgent })
    // A new play() during the probe owns the session; reporting this error would kill it.
    if (sessionGeneration !== generation) return
    const statusPart = httpStatus ? ` HTTP ${httpStatus}` : ""
    const verdictPart = verdict && verdict !== "inconclusive" ? `; probe ${verdict}` : ""
    const technical = `${event.payload.code || "?"}${statusPart}${event.payload.message ? `: ${event.payload.message}` : ""}${verdictPart}`
    const detail = `${t(messageKey)} (${technical})`.slice(0, 300)
    log.error("[xt:receiver] native playback failed:", detail)
    report({ state: "error", error: detail, positionSeconds: 0 })
    finishAndEndSession()
    callbacks.onSessionEnded()
  }

  function handleEvent(sessionGeneration: number, event: AndroidNativeEvent): void {
    if (!isCurrentEvent(sessionGeneration, event.payload.contentKey)) return
    switch (event.type) {
      case "xt:android-native-progress": {
        const reportedDuration = durationSecondsFromMs(event.payload.durationMs)
        if (reportedDuration !== undefined) knownDurationSeconds = reportedDuration
        report({
          state: "playing",
          positionSeconds: Math.max(0, Math.floor((event.payload.positionMs || 0) / 1000)),
          durationSeconds: knownDurationSeconds,
        })
        break
      }
      case "xt:android-native-play-state":
        // The only signal that can move a tick-less live cast off the one-shot "playing" from play().
        report({
          state: event.payload.playing ? "playing" : "paused",
          positionSeconds: Math.max(0, Math.floor((event.payload.positionMs || 0) / 1000)),
          durationSeconds: knownDurationSeconds,
        })
        break
      case "xt:android-native-error":
        void reportNativeError(sessionGeneration, event)
        break
      case "xt:android-native-channel-changed":
        if (event.payload.channelId) {
          callbacks.onLiveChannelChanged?.(event.payload.channelId, event.payload.channelName || "")
        }
        break
      case "xt:android-native-finished": {
        // Back-outs omit positionSeconds so the last progress tick survives the exit write.
        const finishedPositionSeconds = event.payload.completed
          ? Math.max(0, Math.floor((event.payload.finalPosMs || 0) / 1000))
          : undefined
        report({ state: event.payload.completed ? "ended" : "idle", positionSeconds: finishedPositionSeconds })
        callbacks.onFinished?.(event.payload.finalChannelId ?? null)
        finishAndEndSession()
        callbacks.onSessionEnded()
        break
      }
      case "xt:android-native-volume":
        knownVolume = normalizeReportedVolume(event.payload.volume) ?? knownVolume
        knownMuted = event.payload.muted ?? knownMuted
        report({ volume: knownVolume, muted: knownMuted })
        break
      default:
        break
    }
  }

  return {
    async play(descriptor: CastDescriptorV1, options?: ReceiverPlayOptions): Promise<boolean> {
      isLive = descriptor.isLive
      activeSrc = descriptor.src
      activeUserAgent = descriptor.headers?.userAgent ?? null
      errorReported = false
      // Seeded from the sender's metadata so the first report already carries a range.
      knownDurationSeconds = descriptor.isLive ? undefined : normalizeReportedDuration(descriptor.durationSeconds)
      const sessionStarted = window.AndroidVideo?.receiverSessionStart?.() ?? false
      if (!sessionStarted) return false
      const sessionGeneration = ++generation
      const contentKey = `${descriptor.isLive ? RECEIVER_LIVE_CONTENT_KEY : RECEIVER_VOD_CONTENT_KEY}-${sessionGeneration}`
      activeContentKey = contentKey
      const requestedLiveContext = options?.liveContext ?? null
      const liveContext = descriptor.isLive && requestedLiveContext && requestedLiveContext.channels.length > 0
        ? requestedLiveContext
        : null
      liveChannelIds = liveContext ? new Set(liveContext.channels.map((channel) => String(channel.id))) : null
      unsubscribe = subscribeAndroidNativeEvents((event) => handleEvent(sessionGeneration, event))
      report({ state: "loading", positionSeconds: 0, durationSeconds: knownDurationSeconds })

      const ua = descriptor.headers?.userAgent || ""
      const referer = descriptor.headers?.referer || ""
      const launched = descriptor.isLive
        ? launchAndroidNativeLive({
            contentKey,
            channels: liveContext
              ? liveContext.channels
              : [{ id: RECEIVER_LIVE_CHANNEL_ID, name: descriptor.title, streamUrl: descriptor.src, ua, referer }],
            initialChannelId: liveContext ? liveContext.initialChannelId : RECEIVER_LIVE_CHANNEL_ID,
            defaultUa: ua,
            defaultReferer: referer,
          })
        : launchAndroidNativeVod({
            contentKey,
            url: descriptor.src,
            ua,
            referer,
            title: descriptor.title,
            startMs: Math.max(0, Math.floor((descriptor.resumeSeconds || 0) * 1000)),
          })

      if (!launched) {
        log.warn("[xt:receiver] native launch failed, falling back to embedded playback")
        stopListening()
        try { window.AndroidVideo?.receiverSessionEnd?.() } catch {}
        return false
      }

      if (descriptor.isLive) report({ state: "playing", positionSeconds: 0 })
      return true
    },

    control(action: ReceiverControlAction, seconds?: number): void {
      if (action === "stop") {
        report({ state: "idle", positionSeconds: 0 })
        finishAndEndSession()
        callbacks.onSessionEnded()
        return
      }
      if (action === "seek" && isLive) return
      const positionMs = action === "seek" ? Math.max(0, Math.floor((seconds || 0) * 1000)) : 0
      const sessionGeneration = generation
      let reachedSession = false
      try { reachedSession = window.AndroidVideo?.receiverControl?.(action, positionMs) ?? false } catch {}
      if (!reachedSession || sessionGeneration !== generation) return
      if (action === "pause") report({ state: "paused", durationSeconds: knownDurationSeconds })
      else if (action === "resume") report({ state: "playing", durationSeconds: knownDurationSeconds })
      // A paused scrub gets no progress tick, so echo the requested position back to the remote.
      else if (action === "seek") {
        report({ positionSeconds: Math.floor(positionMs / 1000), durationSeconds: knownDurationSeconds })
      }
    },

    setVolume(level: number, muted: boolean): void {
      const clamped = clampReceiverVolume(level)
      let applied = false
      try { applied = window.AndroidVideo?.receiverVolume?.(clamped, muted) ?? false } catch {}
      if (!applied) return
      knownVolume = clamped
      knownMuted = muted
      report({ volume: clamped, muted })
    },

    teardown(): void {
      report({ state: "idle", positionSeconds: 0 })
      finishAndEndSession()
    },
  }
}
