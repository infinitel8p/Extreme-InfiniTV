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
  type EngineRegistry,
  type ReceiverEnginePreference,
} from "@/scripts/receiver/engine-select"
import {
  buildVodCastDescriptor,
  isCastableSrc,
  type CastDescriptorV1,
} from "@/scripts/lib/tv-cast-descriptor"
import {
  resolveChannelSrc,
  resolveLiveChannelCastDescriptor,
  resolvePlaylistCreds,
} from "@/scripts/lib/tv-cast-live.js"
import { resolveCatchupCastDescriptor } from "@/scripts/lib/tv-cast-catchup.ts"
import type { CatchupRequestChannel } from "@/scripts/lib/catchup-resolve.ts"
import { buildMovieStreamUrl, buildSeriesStreamUrl } from "@/scripts/lib/stream-urls.ts"
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

const PROGRESS_WRITE_INTERVAL_MS = 5000
const SEEK_STEP_SECONDS = 10
const SEEK_FLASH_HIDE_MS = 900

export interface TvLiveChannel {
  id: string | number
  name: string
  logo?: string | null
  url?: string | null
  userAgent?: string | null
  referer?: string | null
  tvgId?: string | null
  tvgShift?: number | null
}

export interface TvPlayLiveInput {
  playlistId: string
  channel: TvLiveChannel
  siblings: TvLiveChannel[]
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
}

let playerDom: EmbeddedEngineDom | null = null
let seekFlashEl: HTMLElement | null = null
let seekFlashTimer: ReturnType<typeof setTimeout> | null = null
let registryInstance: EngineRegistry | null = null
let activeEngine: ReceiverEngine | null = null
let lastPlayAttempt: (() => Promise<boolean>) | null = null
let focusedElementBeforePlayback: HTMLElement | null = null
let currentEvents: TvPlaybackEvents | null = null
let currentIsLive = false
let currentPlaybackState: ReceiverPlaybackState = "idle"
let currentPositionSeconds = 0
let currentKnownDurationSeconds: number | undefined
let activeProgressTarget: ActiveProgressTarget | null = null
let activeLiveTarget: ActiveLiveTarget | null = null
let sessionErrorToasted = false

function showSeekFlash(deltaSeconds: number): void {
  if (!seekFlashEl) return
  seekFlashEl.textContent = (deltaSeconds > 0 ? "+" : "-") + Math.abs(deltaSeconds) + "s"
  seekFlashEl.classList.remove("hidden")
  if (seekFlashTimer) clearTimeout(seekFlashTimer)
  seekFlashTimer = setTimeout(() => seekFlashEl?.classList.add("hidden"), SEEK_FLASH_HIDE_MS)
}

function handleKeydown(event: KeyboardEvent): void {
  if (!activeEngine) return
  if (document.activeElement === playerDom?.errorRetryEl) return
  const key = event.key
  if (key === "Enter" || key === " " || key === "MediaPlayPause") {
    event.preventDefault()
    event.stopImmediatePropagation()
    activeEngine.control(currentPlaybackState === "paused" ? "resume" : "pause")
    return
  }
  if (!currentIsLive && (key === "ArrowLeft" || key === "ArrowRight")) {
    event.preventDefault()
    event.stopImmediatePropagation()
    const delta = key === "ArrowLeft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
    activeEngine.control("seek", Math.max(0, currentPositionSeconds + delta))
    showSeekFlash(delta)
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
    <div id="tv-player-seek-flash" class="hidden absolute bottom-10 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-5 py-2 text-lg tabular-nums text-white/90"></div>
    <div id="tv-player-error" class="hidden absolute inset-0 flex items-center justify-center px-6">
      <div class="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-line bg-surface p-8 text-center">
        <p id="tv-player-error-title" class="text-xl font-semibold text-fg"></p>
        <p id="tv-player-error-message" class="text-base text-fg-3"></p>
        <button id="tv-player-error-retry" type="button" class="mt-2 inline-flex min-h-11 items-center justify-center rounded-xl bg-fg px-5 py-2 text-sm font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"></button>
      </div>
    </div>
  `

  const errorTitleEl = host.querySelector<HTMLElement>("#tv-player-error-title")
  if (errorTitleEl) errorTitleEl.textContent = t("receiver.error.title")
  const errorRetryEl = host.querySelector<HTMLButtonElement>("#tv-player-error-retry")
  if (errorRetryEl) errorRetryEl.textContent = t("receiver.error.retry")
  errorRetryEl?.addEventListener("click", () => { void lastPlayAttempt?.() })

  seekFlashEl = host.querySelector<HTMLElement>("#tv-player-seek-flash")

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
    if (!activeEngine) return false
    stopPlayback()
    return true
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
}

function restoreFocusAfterPlayback(): void {
  const target = focusedElementBeforePlayback
  focusedElementBeforePlayback = null
  if (target && document.contains(target)) target.focus()
}

function handleSessionEnded(): void {
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
  currentIsLive = false
  currentPlaybackState = "idle"
  currentKnownDurationSeconds = undefined
  setKeepScreenOn(false)
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
  const embedded = createEmbeddedReceiverEngine(dom, engineCallbacks)
  const native = androidNativePlayerAvailable ? createAndroidNativeReceiverEngine(engineCallbacks) : null
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

async function startSession(descriptor: CastDescriptorV1, session: StartSessionInput): Promise<boolean> {
  const registry = ensureRegistry()
  focusedElementBeforePlayback = document.activeElement instanceof HTMLElement ? document.activeElement : null

  activeEngine?.teardown()
  activeEngine = null
  currentEvents = session.events
  activeProgressTarget = session.progressTarget ?? null
  activeLiveTarget = session.liveTarget ?? null
  currentIsLive = descriptor.isLive
  currentPlaybackState = "loading"
  currentPositionSeconds = 0
  currentKnownDurationSeconds = undefined
  sessionErrorToasted = false

  const { started } = await playWithFallback(registry, descriptor, {
    preference: getReceiverEngine() as ReceiverEnginePreference,
    start: async (engine, candidateDescriptor, playOptions) => {
      const success = await engine.play(candidateDescriptor, playOptions)
      if (success) activeEngine = engine
      return success
    },
    playOptions: session.playOptions,
    onFallback: () => log.warn("[xt:tv-playback] native playback unavailable, falling back to embedded playback"),
  })
  if (started) return true

  currentEvents = null
  activeProgressTarget = null
  activeLiveTarget = null
  restoreFocusAfterPlayback()
  return failPlayback()
}

async function resolveSiblingChannel(playlistId: string, channel: TvLiveChannel): Promise<SiblingChannelInput> {
  let streamUrl: string | null = null
  try {
    streamUrl = await resolveChannelSrc(playlistId, channel, String(channel.id))
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

export function tvPlaybackAvailable(): boolean {
  return typeof document !== "undefined" && !!document.getElementById("tv-player-host")
}

export function isPlaybackActive(): boolean {
  return activeEngine !== null
}

export function stopPlayback(): void {
  activeEngine?.control("stop")
}

export async function playLive(input: TvPlayLiveInput, events: TvPlaybackEvents = {}): Promise<boolean> {
  lastPlayAttempt = () => playLive(input, events)
  return guardPlayback(async () => {
    const resolved = await resolveLiveChannelCastDescriptor(input.playlistId, input.channel.id)
    if (!resolved) return failPlayback()

    pushRecent(
      input.playlistId,
      "live",
      Number(input.channel.id),
      input.channel.name || resolved.channel?.name || "",
      input.channel.logo || resolved.channel?.logo || null
    )

    const siblingInputs = await Promise.all(input.siblings.map((sibling) => resolveSiblingChannel(input.playlistId, sibling)))
    const liveContextResult = siblingsToLiveContext(siblingInputs, {
      id: input.channel.id,
      name: input.channel.name || "",
    })

    const liveTarget: ActiveLiveTarget = {
      playlistId: input.playlistId,
      initialChannelId: String(input.channel.id),
      currentChannelId: String(input.channel.id),
      siblingsById: new Map(siblingInputs.map((channel) => [String(channel.id), { name: channel.name, logo: channel.logo ?? null }])),
    }

    return startSession(resolved.descriptor, {
      events,
      liveTarget,
      playOptions: liveContextResult ? { liveContext: liveContextResult } : undefined,
    })
  })
}

export async function playVod(input: TvPlayVodInput, events: TvPlaybackEvents = {}): Promise<boolean> {
  lastPlayAttempt = () => playVod(input, events)
  return guardPlayback(async () => {
    const creds = await resolvePlaylistCreds(input.playlistId)
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
  lastPlayAttempt = () => playEpisode(input, events)
  return guardPlayback(async () => {
    const creds = await resolvePlaylistCreds(input.playlistId)
    if (!creds?.host || !creds.user || !creds.pass) return failPlayback()
    const src = buildSeriesStreamUrl(creds, input.episodeId, input.containerExt ?? null)
    if (!isCastableSrc(src)) return failPlayback()

    const descriptor = buildVodCastDescriptor({
      src,
      title: input.title,
      logo: input.logo ?? undefined,
      resumeSeconds: input.resumeSeconds,
    })

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
  lastPlayAttempt = () => playCatchup(input, events)
  return guardPlayback(async () => {
    const creds = await resolvePlaylistCreds(input.playlistId)
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
    if (!descriptor) return failPlayback()

    return startSession(descriptor, { events })
  })
}

window.addEventListener("pagehide", () => setKeepScreenOn(false))
