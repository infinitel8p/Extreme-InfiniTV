// Local-playback orchestrator for the Android TV browse UI, using the receiver's engine pair.
import {
  createAndroidNativeReceiverEngine,
  createEmbeddedReceiverEngine,
  normalizeReportedDuration,
  type EmbeddedEngineDom,
  type ReceiverEngine,
  type ReceiverEngineCallbacks,
  type ReceiverPlaybackState,
  type ReceiverPlayOptions,
  type ReceiverStatePartial,
} from "@/scripts/receiver/engines"
import {
  playWithFallback,
  selectEngine,
  type EngineRegistry,
  type ReceiverEnginePreference,
} from "@/scripts/receiver/engine-select"
import {
  buildVodCastDescriptor,
  isCastableSrc,
  type CastDescriptorV1,
} from "@/scripts/lib/tv-cast-descriptor"
import {
  resolveLiveChannelCastDescriptor,
  resolvePlaylistCreds,
} from "@/scripts/lib/tv-cast-live.js"
import { getActiveDnsOverrideAsync } from "@/scripts/lib/creds.js"
import { resolveCatchupCastDescriptor } from "@/scripts/lib/tv-cast-catchup.ts"
import type { CatchupRequestChannel } from "@/scripts/lib/catchup-resolve.ts"
import { buildMovieStreamUrl, buildSeriesStreamUrl, buildLiveStreamUrl } from "@/scripts/lib/stream-urls.ts"
import { markCompleted, pushRecent, setProgress } from "@/scripts/lib/preferences.js"
import { getReceiverEngine } from "@/scripts/lib/app-settings.js"
import { androidNativePlayerAvailable } from "@/scripts/lib/android-video-launcher.js"
import { registerBackInterceptor } from "@/scripts/lib/back-handler"
import { setKeepScreenOn } from "@/scripts/lib/keep-screen-on"
import { t } from "@/scripts/lib/i18n.js"
import { toast } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"
import {
  createThrottledProgressWriter,
  siblingsToLiveContext,
  type SiblingChannelInput,
  type ThrottledProgressWriter,
} from "@/scripts/tv/playback-progress"
import { createOsd, type OsdHandle, type OsdLiveChannel } from "@/scripts/tv/ui/osd"
import { resolveZapTarget } from "@/scripts/tv/osd-zap"

const PROGRESS_WRITE_INTERVAL_MS = 5000
const SEEK_STEP_SECONDS = 10
const ZAP_IDLE_COMMIT_MS = 1500
// Guards against a runaway digit buffer; no real channel list needs more than this many digits.
const ZAP_MAX_DIGITS = 6
const RETRY_BASE_DISABLE_MS = 2000
const RETRY_MAX_DISABLE_MS = 16000

/** Escalating backoff for the retry button: 2s, 4s, 8s, 16s (capped) per consecutive failure of the same descriptor. */
export function retryDisableMsForStreak(failureStreak: number): number {
  return Math.min(RETRY_BASE_DISABLE_MS * 2 ** Math.max(0, failureStreak), RETRY_MAX_DISABLE_MS)
}

export interface TvLiveChannel {
  id: string | number
  name: string
  logo?: string | null
  url?: string | null
  userAgent?: string | null
  referer?: string | null
  tvgId?: string | null
  tvgShift?: number | null
  chno?: number | null
}

export interface TvPlayLiveInput {
  playlistId: string
  channel: TvLiveChannel
  siblings: TvLiveChannel[]
  /** Identifies the siblings list's source group so the resolution cache can key on it; optional for callers with no stable group (e.g. search results). */
  groupKey?: string | null
}

export interface TvPlayVodInput {
  playlistId: string
  movieId: string | number
  title: string
  logo?: string | null
  containerExt?: string | null
  resumeSeconds?: number
  durationSeconds?: number
}

export interface TvPlayEpisodeInput {
  playlistId: string
  seriesId: string | number
  season: number
  episodeNum: number
  episodeId: string | number
  title: string
  seriesName?: string
  logo?: string | null
  containerExt?: string | null
  resumeSeconds?: number
}

export interface TvPlayCatchupInput {
  playlistId: string
  channel: CatchupRequestChannel
  startUtcMs: number
  stopUtcMs: number
  title: string
  catchupId?: string | null
  kind?: "programme" | "timeshift"
  timelineStartUtcMs?: number | null
  timelineStopUtcMs?: number | null
  timeshiftAnchorWindow?: { startUtcMs: number; stopUtcMs: number } | null
  seekSeconds?: number
  logo?: string | null
  headers?: { userAgent?: string | null; referer?: string | null }
}

export interface TvPlaybackEvents {
  onLiveChannelChanged?(channelId: string, channelName: string): void
  onEnded?(): void
}

interface ActiveProgressTarget {
  writer: ThrottledProgressWriter
}

interface ActiveLiveTarget {
  playlistId: string
  initialChannelId: string
  currentChannelId: string
  siblingsById: Map<string, { name: string; logo: string | null }>
  channels: TvLiveChannel[]
  channelInfo: OsdLiveChannel
}

let playerDom: EmbeddedEngineDom | null = null
let osd: OsdHandle | null = null
let zapDigits = ""
let zapIdleTimer: ReturnType<typeof setTimeout> | null = null
let registryInstance: EngineRegistry | null = null
let activeEngine: ReceiverEngine | null = null
let startingEngine: ReceiverEngine | null = null
let startingGeneration: number | null = null
let lastPlayAttempt: (() => Promise<boolean>) | null = null
// Identifies what lastPlayAttempt targets, so the retry button's backoff can tell a
// repeat failure against the same descriptor from a fresh one (see retryDisableMsForStreak).
let lastPlayAttemptKey: string | null = null
let focusedElementBeforePlayback: HTMLElement | null = null
let focusedKeyBeforePlayback: string | null = null
let currentEvents: TvPlaybackEvents | null = null
let currentIsLive = false
let currentPlaybackState: ReceiverPlaybackState = "idle"
let currentPositionSeconds = 0
let currentKnownDurationSeconds: number | undefined
let activeProgressTarget: ActiveProgressTarget | null = null
let activeLiveTarget: ActiveLiveTarget | null = null
let sessionErrorToasted = false
let embeddedPresentationActive = false
let playGeneration = 0
// Consecutive-failure streak for the retry button's escalating backoff, keyed to whatever
// lastPlayAttemptKey last errored - reset once a different descriptor starts or succeeds.
let retryFailureKey: string | null = null
let retryFailureStreak = 0
let retryReenableTimer: ReturnType<typeof setTimeout> | null = null

// Re-enables the retry button and drops its backoff timer immediately - called whenever
// a fresh play attempt targets a different descriptor, so its disabled state never outlives
// the failure that caused it.
function clearRetryButtonDisable(): void {
  if (retryReenableTimer) {
    clearTimeout(retryReenableTimer)
    retryReenableTimer = null
  }
  if (playerDom?.errorRetryEl) setRetryCooldown(playerDom.errorRetryEl, false)
}

// aria-disabled keeps D-pad focus on the button during the cooldown; a real `disabled` would blur it and strand focus.
function setRetryCooldown(button: HTMLButtonElement, active: boolean): void {
  if (active) button.setAttribute("aria-disabled", "true")
  else button.removeAttribute("aria-disabled")
}

function setLastPlayAttempt(attempt: () => Promise<boolean>, key: string): void {
  if (key !== lastPlayAttemptKey) clearRetryButtonDisable()
  lastPlayAttempt = attempt
  lastPlayAttemptKey = key
}

function beginPlayAttempt(): number {
  return ++playGeneration
}

function isStalePlayAttempt(generation: number): boolean {
  return generation !== playGeneration
}

function isEmbeddedActive(): boolean {
  return !!activeEngine && !!registryInstance && activeEngine === registryInstance.embedded
}

function showLiveBannerForCurrentChannel(): void {
  if (!activeLiveTarget) return
  osd?.showLiveBanner(activeLiveTarget.playlistId, activeLiveTarget.channelInfo)
}

function clearZapIdleTimer(): void {
  if (zapIdleTimer) {
    clearTimeout(zapIdleTimer)
    zapIdleTimer = null
  }
}

function cancelZap(): void {
  clearZapIdleTimer()
  zapDigits = ""
  osd?.hideZap()
}

function commitZap(): void {
  clearZapIdleTimer()
  const digits = zapDigits
  zapDigits = ""
  if (!digits || !activeLiveTarget) return
  const resolved = resolveZapTarget(digits, activeLiveTarget.channels)
  if (!resolved) {
    osd?.showZapMiss(digits)
    return
  }
  osd?.hideZap()
  const events = currentEvents ?? {}
  void playLive(
    { playlistId: activeLiveTarget.playlistId, channel: resolved, siblings: activeLiveTarget.channels },
    events
  )
}

function appendZapDigit(digit: string): void {
  osd?.hideLiveBanner()
  zapDigits = (zapDigits + digit).slice(-ZAP_MAX_DIGITS)
  osd?.showZapDigits(zapDigits)
  clearZapIdleTimer()
  zapIdleTimer = setTimeout(commitZap, ZAP_IDLE_COMMIT_MS)
}

// Cancels a play attempt that is still mounting (no activeEngine yet), so BACK during the gap works.
function cancelStartingPlayback(): void {
  playGeneration++
  startingEngine?.teardown()
  startingEngine = null
  startingGeneration = null
  currentEvents = null
  activeProgressTarget = null
  activeLiveTarget = null
  embeddedPresentationActive = false
  currentIsLive = false
  cancelZap()
  osd?.hideAll()
  ensureDom().playerViewEl?.classList.add("hidden")
  restoreFocusAfterPlayback()
}

function handleKeydown(event: KeyboardEvent): void {
  const key = event.key
  // Zapping stays live through the mount gap, when the player is on screen but has no engine yet.
  if (!activeEngine && embeddedPresentationActive && currentIsLive && /^[0-9]$/.test(key)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    appendZapDigit(key)
    return
  }
  if (!activeEngine && (startingEngine || embeddedPresentationActive) && (key === "Escape" || key === "GoBack" || key === "BrowserBack")) {
    event.preventDefault()
    event.stopImmediatePropagation()
    cancelStartingPlayback()
    return
  }
  if (!activeEngine) return
  if (document.activeElement === playerDom?.errorRetryEl) return
  const embeddedLive = isEmbeddedActive() && currentIsLive

  if (embeddedLive && /^[0-9]$/.test(key)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    appendZapDigit(key)
    return
  }
  if (embeddedLive && zapDigits && (key === "Enter" || key === " ")) {
    event.preventDefault()
    event.stopImmediatePropagation()
    commitZap()
    return
  }
  if (embeddedLive && zapDigits && (key === "Escape" || key === "GoBack" || key === "BrowserBack")) {
    event.preventDefault()
    event.stopImmediatePropagation()
    cancelZap()
    return
  }
  if (key === "Enter" || key === " " || key === "MediaPlayPause") {
    event.preventDefault()
    event.stopImmediatePropagation()
    activeEngine.control(currentPlaybackState === "paused" ? "resume" : "pause")
    if (isEmbeddedActive()) {
      if (currentIsLive) showLiveBannerForCurrentChannel()
      else osd?.showVodScrub(currentPositionSeconds, currentKnownDurationSeconds)
    }
    return
  }
  if (!currentIsLive && (key === "ArrowLeft" || key === "ArrowRight")) {
    event.preventDefault()
    event.stopImmediatePropagation()
    const delta = key === "ArrowLeft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
    const target = Math.max(0, currentPositionSeconds + delta)
    activeEngine.control("seek", target)
    if (isEmbeddedActive()) osd?.showVodScrub(target, currentKnownDurationSeconds, delta)
    return
  }
  if (embeddedLive && !zapDigits && (key === "ArrowUp" || key === "ArrowDown")) {
    event.preventDefault()
    event.stopImmediatePropagation()
    showLiveBannerForCurrentChannel()
    return
  }
  if (key === "Escape" || key === "GoBack" || key === "BrowserBack") {
    event.preventDefault()
    event.stopImmediatePropagation()
    stopPlayback()
  }
}

function ensureDom(): EmbeddedEngineDom {
  if (playerDom) return playerDom
  const host = document.getElementById("tv-player-host")
  if (!host) throw new Error("[xt:tv-playback] #tv-player-host missing")

  host.innerHTML = `
    <video id="tv-player-video" class="h-full w-full" playsinline></video>
    <div id="tv-player-title-wrap" class="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 via-black/35 to-transparent pb-10 opacity-0 transition-opacity duration-500">
      <div id="tv-player-title" class="px-6 pt-5 text-xl sm:text-2xl font-medium text-white/95"></div>
    </div>
    <div id="tv-player-loading" class="hidden absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/40">
      <div class="size-10 rounded-full border-2 border-white/20 border-t-white/90 animate-spin motion-reduce:animate-none" aria-hidden="true"></div>
      <p id="tv-player-loading-title" class="max-w-lg px-6 text-center text-lg text-white/85"></p>
    </div>
    <div id="tv-player-paused" class="hidden absolute inset-0 flex items-center justify-center">
      <div class="flex size-24 items-center justify-center rounded-full bg-black/50">
        <svg viewBox="0 0 24 24" class="size-10 text-white/90" aria-hidden="true">
          <rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"></rect>
          <rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"></rect>
        </svg>
      </div>
    </div>
    <div id="tv-player-error" class="hidden absolute inset-0 flex items-center justify-center px-6">
      <div class="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-line bg-surface p-8 text-center">
        <p id="tv-player-error-title" class="text-xl font-semibold text-fg"></p>
        <p id="tv-player-error-message" class="text-base text-fg-3"></p>
        <button id="tv-player-error-retry" type="button" class="mt-2 inline-flex min-h-11 items-center justify-center rounded-xl bg-fg px-5 py-2 text-sm font-semibold text-bg transition-opacity hover:opacity-90 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"></button>
      </div>
    </div>
  `

  const errorTitleEl = host.querySelector<HTMLElement>("#tv-player-error-title")
  if (errorTitleEl) errorTitleEl.textContent = t("receiver.error.title")
  const errorRetryEl = host.querySelector<HTMLButtonElement>("#tv-player-error-retry")
  if (errorRetryEl) errorRetryEl.textContent = t("receiver.error.retry")
  errorRetryEl?.addEventListener("click", () => {
    if (errorRetryEl.getAttribute("aria-disabled") === "true") return
    const disableMs = retryDisableMsForStreak(retryFailureStreak)
    setRetryCooldown(errorRetryEl, true)
    if (retryReenableTimer) clearTimeout(retryReenableTimer)
    retryReenableTimer = setTimeout(() => {
      setRetryCooldown(errorRetryEl, false)
      retryReenableTimer = null
    }, disableMs)
    void lastPlayAttempt?.()
  })

  osd = createOsd(host)

  playerDom = {
    idleEl: null,
    playerViewEl: host,
    videoEl: host.querySelector<HTMLVideoElement>("#tv-player-video"),
    titleWrapEl: host.querySelector<HTMLElement>("#tv-player-title-wrap"),
    titleEl: host.querySelector<HTMLElement>("#tv-player-title"),
    loadingEl: host.querySelector<HTMLElement>("#tv-player-loading"),
    loadingTitleEl: host.querySelector<HTMLElement>("#tv-player-loading-title"),
    pausedEl: host.querySelector<HTMLElement>("#tv-player-paused"),
    errorEl: host.querySelector<HTMLElement>("#tv-player-error"),
    errorMessageEl: host.querySelector<HTMLElement>("#tv-player-error-message"),
    errorCountdownEl: null,
    errorRetryEl,
  }

  document.addEventListener("keydown", handleKeydown, true)
  registerBackInterceptor(() => {
    if (activeEngine) {
      stopPlayback()
      return true
    }
    if (startingEngine || embeddedPresentationActive) {
      cancelStartingPlayback()
      return true
    }
    return false
  })

  return playerDom
}

function handleReport(partial: ReceiverStatePartial): void {
  if (partial.state) {
    currentPlaybackState = partial.state
    setKeepScreenOn(partial.state === "playing" || partial.state === "loading" || partial.state === "buffering")
  }
  // idle/error report a reset-to-zero position from teardown, not a real playback
  // position; keeping the last tick lets handleSessionEnded's own write below persist it.
  if (typeof partial.positionSeconds === "number" && partial.state !== "idle" && partial.state !== "error") {
    currentPositionSeconds = partial.positionSeconds
  }
  const durationSeconds = normalizeReportedDuration(partial.durationSeconds)
  if (durationSeconds !== undefined) currentKnownDurationSeconds = durationSeconds
  activeProgressTarget?.writer.observe({
    state: partial.state ?? currentPlaybackState,
    positionSeconds: currentPositionSeconds,
    durationSeconds,
  })
  if (partial.state === "error" && activeEngine && !sessionErrorToasted) {
    const isNativeEngine = activeEngine === registryInstance?.native
    const errorPanelVisible = !!playerDom?.errorEl && !playerDom.errorEl.classList.contains("hidden")
    // Embedded engine paints its own error panel; only toast when nothing else told the user.
    if (isNativeEngine || !errorPanelVisible) {
      sessionErrorToasted = true
      toast({ title: t("receiver.error.title"), variant: "error" })
    }
  }
  if (partial.state === "error" && lastPlayAttemptKey) {
    retryFailureStreak = lastPlayAttemptKey === retryFailureKey ? retryFailureStreak + 1 : 1
    retryFailureKey = lastPlayAttemptKey
  } else if (partial.state === "playing" && lastPlayAttemptKey && lastPlayAttemptKey === retryFailureKey) {
    retryFailureKey = null
    retryFailureStreak = 0
  }
}

function restoreFocusAfterPlayback(): void {
  const target = focusedElementBeforePlayback
  const key = focusedKeyBeforePlayback
  focusedElementBeforePlayback = null
  focusedKeyBeforePlayback = null
  if (target && document.contains(target)) {
    target.focus()
    return
  }
  if (!key) return
  document.querySelector<HTMLElement>(`#tv-main [data-focus-key="${CSS.escape(key)}"]`)?.focus()
}

function handleSessionEnded(): void {
  // A mid-resolve attempt has already claimed the next generation; don't bump past it.
  if (startingEngine !== null || activeEngine !== null) playGeneration++
  startingEngine = null
  startingGeneration = null
  if (activeProgressTarget && currentPlaybackState !== "ended" && currentPositionSeconds > 0) {
    activeProgressTarget.writer.observe({
      state: "paused",
      positionSeconds: currentPositionSeconds,
      durationSeconds: currentKnownDurationSeconds,
    })
  }
  activeEngine = null
  activeProgressTarget = null
  activeLiveTarget = null
  embeddedPresentationActive = false
  currentIsLive = false
  currentPlaybackState = "idle"
  currentKnownDurationSeconds = undefined
  setKeepScreenOn(false)
  cancelZap()
  osd?.hideAll()
  const events = currentEvents
  currentEvents = null
  restoreFocusAfterPlayback()
  events?.onEnded?.()
}

function handleLiveChannelChanged(channelId: string, channelName: string): void {
  if (!activeLiveTarget) return
  activeLiveTarget.currentChannelId = channelId
  const sibling = activeLiveTarget.siblingsById.get(channelId)
  pushRecent(activeLiveTarget.playlistId, "live", Number(channelId), channelName || sibling?.name || "", sibling?.logo ?? null)
  currentEvents?.onLiveChannelChanged?.(channelId, channelName)
}

function handleFinished(finalChannelId: string | null): void {
  if (!activeLiveTarget || !finalChannelId) return
  if (finalChannelId !== activeLiveTarget.initialChannelId) {
    currentEvents?.onLiveChannelChanged?.(finalChannelId, "")
  }
}

const engineCallbacks: ReceiverEngineCallbacks = {
  report: handleReport,
  onSessionEnded: handleSessionEnded,
  onLiveChannelChanged: handleLiveChannelChanged,
  onFinished: handleFinished,
}

function ensureRegistry(): EngineRegistry {
  if (registryInstance) return registryInstance
  const dom = ensureDom()
  // Singleton engines: only the owning attempt's reports count.
  const embedded: ReceiverEngine = createEmbeddedReceiverEngine(dom, {
    ...engineCallbacks,
    report: (partial) => { if (embedded === activeEngine || embedded === startingEngine) handleReport(partial) },
  })
  let native: ReceiverEngine | null = null
  if (androidNativePlayerAvailable) {
    native = createAndroidNativeReceiverEngine({
      ...engineCallbacks,
      report: (partial) => { if (native === activeEngine || native === startingEngine) handleReport(partial) },
    })
  }
  registryInstance = { embedded, native }
  return registryInstance
}

function failPlayback(): boolean {
  toast({ title: t("tv.player.unavailable"), variant: "error" })
  return false
}

async function guardPlayback(action: () => Promise<boolean>): Promise<boolean> {
  try {
    return await action()
  } catch (err) {
    log.warn("[xt:tv-playback] play failed:", err)
    return failPlayback()
  }
}

interface StartSessionInput {
  events: TvPlaybackEvents
  progressTarget?: ActiveProgressTarget
  liveTarget?: ActiveLiveTarget
  playOptions?: ReceiverPlayOptions
}

let startChain: Promise<void> = Promise.resolve()

/** Serializes runStartSession so two overlapping starts never mount the shared engine at once. */
function startSession(descriptor: CastDescriptorV1, session: StartSessionInput): Promise<boolean> {
  const generation = playGeneration
  const run = startChain.then(() => {
    if (isStalePlayAttempt(generation)) return false
    return runStartSession(descriptor, session)
  })
  startChain = run.then(() => undefined, () => undefined)
  return run
}

async function runStartSession(descriptor: CastDescriptorV1, session: StartSessionInput): Promise<boolean> {
  const registry = ensureRegistry()
  const generation = playGeneration
  focusedElementBeforePlayback = document.activeElement instanceof HTMLElement ? document.activeElement : null
  focusedKeyBeforePlayback = focusedElementBeforePlayback?.closest<HTMLElement>("[data-focus-key]")?.dataset.focusKey ?? null

  activeEngine?.teardown()
  activeEngine = null
  startingEngine?.teardown()
  startingEngine = null
  startingGeneration = null
  cancelZap()
  currentEvents = session.events
  activeProgressTarget = session.progressTarget ?? null
  activeLiveTarget = session.liveTarget ?? null
  currentIsLive = descriptor.isLive
  currentPlaybackState = "loading"
  currentPositionSeconds = 0
  currentKnownDurationSeconds = undefined
  sessionErrorToasted = false

  const preference = getReceiverEngine() as ReceiverEnginePreference
  // The embedded engine only unhides the host once artplayer/hls.js have mounted, which is seconds
  // on a TV: reveal up front so the tune shows its loading state and banner right away.
  if (selectEngine(registry, descriptor, preference) === registry.embedded) {
    embeddedPresentationActive = true
    ensureDom().playerViewEl?.classList.remove("hidden")
    if (currentIsLive) showLiveBannerForCurrentChannel()
  }

  let started = false
  try {
    started = (await playWithFallback(registry, descriptor, {
      preference,
      start: async (engine, candidateDescriptor, playOptions) => {
        if (isStalePlayAttempt(generation)) return false
        startingEngine = engine
        startingGeneration = generation
        const success = await engine.play(candidateDescriptor, playOptions)
        const stillOwnsStarting = startingEngine === engine && startingGeneration === generation
        if (isStalePlayAttempt(generation)) {
          if (success && stillOwnsStarting) {
            // Orphaned: no newer attempt claimed this instance, so make it the controllable one.
            activeEngine = engine
          } else if (success && engine !== activeEngine) {
            engine.teardown()
          }
          if (stillOwnsStarting) {
            startingEngine = null
            startingGeneration = null
          }
          return false
        }
        if (success) activeEngine = engine
        if (stillOwnsStarting) {
          startingEngine = null
          startingGeneration = null
        }
        return success
      },
      playOptions: session.playOptions,
      onFallback: () => {
        if (!isStalePlayAttempt(generation)) {
          log.warn("[xt:tv-playback] native playback unavailable, falling back to embedded playback")
        }
      },
    })).started
  } catch (err) {
    // Catch here so the cleanup below still resets embeddedPresentationActive.
    log.warn("[xt:tv-playback] play failed:", err)
  }
  if (isStalePlayAttempt(generation)) return false
  if (started) return true

  // Not stale, so a leftover startingEngine (e.g. from a throw) is ours to clear.
  const danglingEngine = startingEngine as ReceiverEngine | null
  danglingEngine?.teardown()
  startingEngine = null
  startingGeneration = null
  currentEvents = null
  activeProgressTarget = null
  activeLiveTarget = null
  embeddedPresentationActive = false
  osd?.hideAll()
  ensureDom().playerViewEl?.classList.add("hidden")
  restoreFocusAfterPlayback()
  return failPlayback()
}

// Playlist creds are resolved once per playLive() call (see playLive) and threaded through
// here, instead of every sibling in the window re-fetching them via resolveChannelSrc.
async function resolveSiblingStreamUrl(channel: TvLiveChannel, creds: any | null): Promise<string | null> {
  if (channel.url) return channel.url
  if (!creds?.host || !creds.user || !creds.pass) return null
  return buildLiveStreamUrl(creds, String(channel.id), creds.liveContainer || null)
}

async function resolveSiblingChannel(channel: TvLiveChannel, creds: any | null): Promise<SiblingChannelInput> {
  let streamUrl: string | null = null
  try {
    streamUrl = await resolveSiblingStreamUrl(channel, creds)
  } catch (err) {
    log.warn("[xt:tv-playback] sibling channel resolution failed:", channel.id, err)
  }
  return {
    id: channel.id,
    name: channel.name || "",
    logo: channel.logo ?? null,
    streamUrl,
    ua: channel.userAgent ?? null,
    referer: channel.referer ?? null,
    tvgId: channel.tvgId ?? null,
    tvgShift: channel.tvgShift ?? null,
  }
}

// Reuses the resolved sibling list (creds fetch + per-channel URL build) across repeat
// playLive() calls for the same (playlistId, groupKey) as long as the exact same siblings
// array is handed back in - e.g. a retry, or a native-engine fallback to embedded for the
// same tune. Cleared whenever the underlying catalog or active playlist could have changed.
interface SiblingResolutionCacheEntry {
  siblingsRef: TvLiveChannel[]
  resolved: SiblingChannelInput[]
}
const siblingResolutionCache = new Map<string, SiblingResolutionCacheEntry>()

function siblingResolutionCacheKey(playlistId: string, groupKey: string | null | undefined): string {
  return `${playlistId}::${groupKey ?? ""}`
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:catalog-warmed", () => siblingResolutionCache.clear())
  document.addEventListener("xt:active-changed", () => siblingResolutionCache.clear())
}

export function tvPlaybackAvailable(): boolean {
  return typeof document !== "undefined" && !!document.getElementById("tv-player-host")
}

export function isPlaybackActive(): boolean {
  return activeEngine !== null
}

export function stopPlayback(): void {
  playGeneration++
  activeEngine?.control("stop")
}

export async function playLive(input: TvPlayLiveInput, events: TvPlaybackEvents = {}): Promise<boolean> {
  setLastPlayAttempt(() => playLive(input, events), `live:${input.playlistId}:${input.channel.id}`)
  const generation = beginPlayAttempt()
  return guardPlayback(async () => {
    const resolved = await resolveLiveChannelCastDescriptor(input.playlistId, input.channel.id)
    if (isStalePlayAttempt(generation)) return false
    if (!resolved) return failPlayback()

    pushRecent(
      input.playlistId,
      "live",
      Number(input.channel.id),
      input.channel.name || resolved.channel?.name || "",
      input.channel.logo || resolved.channel?.logo || null
    )

    const cacheKey = siblingResolutionCacheKey(input.playlistId, input.groupKey)
    const cachedResolution = siblingResolutionCache.get(cacheKey)
    let siblingInputs: SiblingChannelInput[]
    if (cachedResolution && cachedResolution.siblingsRef === input.siblings) {
      siblingInputs = cachedResolution.resolved
    } else {
      const siblingCreds = await resolvePlaylistCreds(input.playlistId)
      if (isStalePlayAttempt(generation)) return false
      siblingInputs = await Promise.all(input.siblings.map((sibling) => resolveSiblingChannel(sibling, siblingCreds)))
      siblingResolutionCache.set(cacheKey, { siblingsRef: input.siblings, resolved: siblingInputs })
    }
    if (isStalePlayAttempt(generation)) return false
    const liveContextResult = siblingsToLiveContext(siblingInputs, {
      id: input.channel.id,
      name: input.channel.name || "",
    })

    const siblingIndex = input.siblings.findIndex((candidate) => String(candidate.id) === String(input.channel.id))
    const channelNumber = input.channel.chno ?? (siblingIndex >= 0 ? siblingIndex + 1 : null)

    const liveTarget: ActiveLiveTarget = {
      playlistId: input.playlistId,
      initialChannelId: String(input.channel.id),
      currentChannelId: String(input.channel.id),
      siblingsById: new Map(siblingInputs.map((channel) => [String(channel.id), { name: channel.name, logo: channel.logo ?? null }])),
      channels: input.siblings,
      channelInfo: {
        id: input.channel.id,
        name: input.channel.name || resolved.channel?.name || "",
        logo: input.channel.logo ?? resolved.channel?.logo ?? null,
        number: channelNumber,
        tvgId: input.channel.tvgId ?? null,
        tvgShift: input.channel.tvgShift ?? null,
      },
    }

    const started = await startSession(resolved.descriptor, {
      events,
      liveTarget,
      playOptions: liveContextResult ? { liveContext: liveContextResult } : undefined,
    })
    if (started && isEmbeddedActive() && !osd?.liveBannerVisible()) showLiveBannerForCurrentChannel()
    return started
  })
}

export async function playVod(input: TvPlayVodInput, events: TvPlaybackEvents = {}): Promise<boolean> {
  setLastPlayAttempt(() => playVod(input, events), `vod:${input.playlistId}:${input.movieId}`)
  const generation = beginPlayAttempt()
  return guardPlayback(async () => {
    const creds = await resolvePlaylistCreds(input.playlistId)
    if (isStalePlayAttempt(generation)) return false
    if (!creds?.host || !creds.user || !creds.pass) return failPlayback()
    const src = buildMovieStreamUrl(creds, input.movieId, input.containerExt ?? null)
    if (!isCastableSrc(src)) return failPlayback()

    const descriptor = buildVodCastDescriptor({
      src,
      title: input.title,
      logo: input.logo ?? undefined,
      resumeSeconds: input.resumeSeconds,
      durationSeconds: input.durationSeconds,
    })
    descriptor.dns = (await getActiveDnsOverrideAsync())?.raw ?? null

    const progressTarget: ActiveProgressTarget = {
      writer: createThrottledProgressWriter({
        intervalMs: PROGRESS_WRITE_INTERVAL_MS,
        write: (positionSeconds, durationSeconds, state) => {
          if (positionSeconds < 1) return
          setProgress(input.playlistId, "vod", input.movieId, positionSeconds, durationSeconds || 0, {
            name: input.title,
            logo: input.logo ?? null,
          })
          if (state === "ended") markCompleted(input.playlistId, "vod", input.movieId, { duration: durationSeconds || 0 })
        },
      }),
    }

    return startSession(descriptor, { events, progressTarget })
  })
}

export async function playEpisode(input: TvPlayEpisodeInput, events: TvPlaybackEvents = {}): Promise<boolean> {
  setLastPlayAttempt(() => playEpisode(input, events), `episode:${input.playlistId}:${input.episodeId}`)
  const generation = beginPlayAttempt()
  return guardPlayback(async () => {
    const creds = await resolvePlaylistCreds(input.playlistId)
    if (isStalePlayAttempt(generation)) return false
    if (!creds?.host || !creds.user || !creds.pass) return failPlayback()
    const src = buildSeriesStreamUrl(creds, input.episodeId, input.containerExt ?? null)
    if (!isCastableSrc(src)) return failPlayback()

    const descriptor = buildVodCastDescriptor({
      src,
      title: input.title,
      logo: input.logo ?? undefined,
      resumeSeconds: input.resumeSeconds,
    })
    descriptor.dns = (await getActiveDnsOverrideAsync())?.raw ?? null

    const progressExtras = {
      seriesId: input.seriesId,
      season: input.season,
      episodeNum: input.episodeNum,
      episodeTitle: input.title,
      seriesName: input.seriesName ?? "",
      seriesLogo: input.logo ?? null,
    }
    const progressTarget: ActiveProgressTarget = {
      writer: createThrottledProgressWriter({
        intervalMs: PROGRESS_WRITE_INTERVAL_MS,
        write: (positionSeconds, durationSeconds, state) => {
          if (positionSeconds < 1) return
          setProgress(input.playlistId, "episode", input.episodeId, positionSeconds, durationSeconds || 0, progressExtras)
          if (state === "ended") {
            markCompleted(input.playlistId, "episode", input.episodeId, { duration: durationSeconds || 0, ...progressExtras })
          }
        },
      }),
    }

    return startSession(descriptor, { events, progressTarget })
  })
}

export async function playCatchup(input: TvPlayCatchupInput, events: TvPlaybackEvents = {}): Promise<boolean> {
  setLastPlayAttempt(
    () => playCatchup(input, events),
    `catchup:${input.playlistId}:${input.catchupId ?? input.channel.id}:${input.startUtcMs}`
  )
  const generation = beginPlayAttempt()
  return guardPlayback(async () => {
    const creds = await resolvePlaylistCreds(input.playlistId)
    if (isStalePlayAttempt(generation)) return false
    if (!creds?.host || !creds.user || !creds.pass) return failPlayback()

    const descriptor = await resolveCatchupCastDescriptor({
      playlistId: input.playlistId,
      creds,
      channel: input.channel,
      startUtcMs: input.startUtcMs,
      stopUtcMs: input.stopUtcMs,
      catchupId: input.catchupId,
      kind: input.kind,
      timelineStartUtcMs: input.timelineStartUtcMs,
      timelineStopUtcMs: input.timelineStopUtcMs,
      timeshiftAnchorWindow: input.timeshiftAnchorWindow,
      seekSeconds: input.seekSeconds,
      title: input.title,
      logo: input.logo,
      headers: input.headers,
    })
    if (isStalePlayAttempt(generation)) return false
    if (!descriptor) return failPlayback()

    return startSession(descriptor, { events })
  })
}

window.addEventListener("pagehide", () => setKeepScreenOn(false))
