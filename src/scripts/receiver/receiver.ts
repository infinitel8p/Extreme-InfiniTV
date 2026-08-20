// TV receiver screen: pairing idle view + remote-controlled playback.
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  mountPlayer,
  playWhenReady,
  type Mounted,
  type VjsLikeHandle,
} from "@/scripts/lib/player-runtime"
import { getPlayerBackend, getEffectiveReceiverDeviceName } from "@/scripts/lib/app-settings.js"
import { applyStreamHeaders } from "@/scripts/lib/stream-headers"
import { validateCastDescriptor } from "@/scripts/lib/tv-cast-descriptor"
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { decodedFrameCount } from "@/scripts/lib/player-telemetry.js"
import {
  classifyStartFailure,
  deviceSupportsHevc,
  hasHevcNameHint,
  type StartFailureKind,
  type StartFailureVerdict,
} from "@/scripts/lib/codec-hints.js"
import {
  formatReceiverAddress,
  formatReceiverPairCode,
  type ReceiverStatus,
} from "@/scripts/lib/receiver-shared.js"
import { advertiseReceiver } from "@/scripts/lib/receiver-discovery.js"

void initI18n()

const isKioskBuild = import.meta.env.PUBLIC_APP_MODE === "receiver"

interface ReceiverPlayPayload {
  descriptor: unknown
  deviceName?: string
}

interface ReceiverControlPayload {
  action: "pause" | "resume" | "stop" | "seek"
  seconds?: number
  deviceName?: string
}

const PENDING_PLAY_KEY = "xt_receiver_pending_play"
const OLED_NUDGE_INTERVAL_MS = 5 * 60 * 1000
const OLED_NUDGE_MAX_PX = 8

const idleEl = document.getElementById("receiver-idle")
const deviceNameEl = document.getElementById("receiver-device-name")
const addressesEl = document.getElementById("receiver-addresses")
const pairCodeEl = document.getElementById("receiver-pair-code")
const pairedFlashEl = document.getElementById("receiver-paired-flash")
const exitBtn = document.getElementById("receiver-exit")
const playerViewEl = document.getElementById("receiver-player")
const videoEl = document.getElementById("receiver-video") as HTMLVideoElement | null
const titleEl = document.getElementById("receiver-title")
const loadingEl = document.getElementById("receiver-loading")
const errorEl = document.getElementById("receiver-error")
const errorMessageEl = document.getElementById("receiver-error-message")

let mounted: Mounted | null = null
let activeHandle: VjsLikeHandle | null = null
let mediaListenersWired = false
let currentTitle = ""
let currentMime = ""
let currentIsLive = false
let currentPlaybackState = "idle"
let tearingDown = false
let lastTimeReportAt = 0

let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null
let pairedFlashTimer: ReturnType<typeof setTimeout> | null = null
let titleHideTimer: ReturnType<typeof setTimeout> | null = null
let errorHideTimer: ReturnType<typeof setTimeout> | null = null
let deadVideoTimer: ReturnType<typeof setTimeout> | null = null
let loadingTimeoutTimer: ReturnType<typeof setTimeout> | null = null

// Time to let a stream settle before judging zero decoded frames a decode failure.
const DEAD_VIDEO_CHECK_MS = 6000
const DEAD_VIDEO_RECHECK_MS = 4000
const DEAD_VIDEO_MIN_PLAYED_S = 3
// A descriptor that never reaches "playing" in this long is a stuck load, not a slow one.
const LOADING_TIMEOUT_MS = 30000

function getMediaElementFor(handle: VjsLikeHandle | null): HTMLVideoElement | null {
  return handle?.getMediaElement?.() ?? videoEl
}

function renderStatus(status: ReceiverStatus): void {
  if (statusRefreshTimer) {
    clearTimeout(statusRefreshTimer)
    statusRefreshTimer = null
  }
  if (deviceNameEl) deviceNameEl.textContent = status.name || "-"
  if (addressesEl) {
    addressesEl.textContent = ""
    for (const ip of status.ips || []) {
      const row = document.createElement("div")
      row.textContent = formatReceiverAddress(ip, status.port)
      addressesEl.appendChild(row)
    }
  }
  if (pairCodeEl) pairCodeEl.textContent = formatReceiverPairCode(status.pairCode)
  const expiresIn = status.pairCodeExpiresInSeconds
  if (typeof expiresIn === "number" && expiresIn > 0) {
    statusRefreshTimer = setTimeout(() => { void refreshStatus() }, (expiresIn + 1) * 1000)
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await invoke<ReceiverStatus>("receiver_status")
    renderStatus(status)
  } catch (err) {
    log.warn("[xt:receiver] receiver_status refresh failed:", err)
  }
}

async function startReceiver(): Promise<void> {
  const name = getEffectiveReceiverDeviceName() || undefined
  try {
    const status = await invoke<ReceiverStatus>("receiver_start", { name })
    renderStatus(status)
    if (status.port !== undefined) advertiseReceiver(status.name, status.port)
    return
  } catch (err) {
    log.warn("[xt:receiver] receiver_start failed:", err)
  }
  try {
    const status = await invoke<ReceiverStatus>("receiver_status")
    renderStatus(status)
  } catch (err) {
    log.warn("[xt:receiver] receiver_status failed:", err)
  }
}

function showPairedFlash(deviceName: string): void {
  if (!pairedFlashEl) return
  pairedFlashEl.textContent = t("receiver.idle.paired", { deviceName })
  pairedFlashEl.classList.remove("hidden")
  if (pairedFlashTimer) clearTimeout(pairedFlashTimer)
  pairedFlashTimer = setTimeout(() => { pairedFlashEl?.classList.add("hidden") }, 4000)
}

function showLoading(show: boolean): void {
  loadingEl?.classList.toggle("hidden", !show)
}

function showPlayerView(title: string): void {
  idleEl?.classList.add("hidden")
  errorEl?.classList.add("hidden")
  playerViewEl?.classList.remove("hidden")
  if (!titleEl) return
  titleEl.textContent = title
  titleEl.classList.remove("hidden")
  if (titleHideTimer) clearTimeout(titleHideTimer)
  titleHideTimer = setTimeout(() => titleEl.classList.add("hidden"), 5000)
}

function reportState(partial: {
  state: string
  positionSeconds?: number
  durationSeconds?: number
  error?: string
}): void {
  currentPlaybackState = partial.state
  const mediaEl = getMediaElementFor(activeHandle)
  const payload = {
    state: partial.state,
    positionSeconds: partial.positionSeconds ?? mediaEl?.currentTime ?? 0,
    durationSeconds: partial.durationSeconds ?? activeHandle?.duration?.(),
    title: currentTitle || undefined,
    error: partial.error,
  }
  void invoke("receiver_report_state", { payload }).catch((err) => {
    log.warn("[xt:receiver] receiver_report_state failed:", err)
  })
}

const FAILURE_MESSAGE_KEYS: Partial<Record<StartFailureKind, string>> = {
  hevc: "receiver.error.hevc",
  codec: "receiver.error.videoCodec",
  audio: "receiver.error.audioCodec",
  parse: "receiver.error.container",
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

function describePlaybackError(context: FailureContext): { message: string; technical: string | null } {
  if (context === "timeout") return { message: t("receiver.error.timeout"), technical: null }

  const verdict = classifyCurrentFailure()
  const knownKey = FAILURE_MESSAGE_KEYS[verdict.kind]
  if (knownKey) return { message: t(knownKey), technical: verdict.codec }

  // A dead-video conviction is already known to be a video decode failure even without a codec string.
  if (context === "dead-video") return { message: t("receiver.error.videoCodec"), technical: verdict.codec }

  const mediaError = getMediaElementFor(activeHandle)?.error
  if (mediaError) {
    const messageKey = mediaErrorMessageKey(mediaError.code)
    if (messageKey) return { message: t(messageKey), technical: mediaErrorTechnical(mediaError) }
  }

  const errorDetail = activeHandle?.codecInfo?.()?.errorDetail
  if (errorDetail) return { message: t("receiver.error.title"), technical: errorDetail }

  return { message: t("receiver.error.title"), technical: null }
}

function handleError(context: FailureContext = "player"): void {
  clearDeadVideoWatchdog()
  clearLoadingWatchdog()
  const { message, technical } = describePlaybackError(context)
  const detail = technical ? `${message} (${technical})`.slice(0, 300) : message
  log.error("[xt:receiver] playback failed:", detail)
  if (errorMessageEl) errorMessageEl.textContent = message
  showLoading(false)
  errorEl?.classList.remove("hidden")
  reportState({ state: "error", error: detail, positionSeconds: 0 })
  if (errorHideTimer) clearTimeout(errorHideTimer)
  errorHideTimer = setTimeout(() => teardownToIdle(), 10000)
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
    handleError("dead-video")
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
  loadingTimeoutTimer = setTimeout(() => {
    loadingTimeoutTimer = null
    if (activeHandle !== handle || currentPlaybackState === "playing") return
    log.warn("[xt:receiver] stream never reached playing state within timeout")
    handleError("timeout")
  }, LOADING_TIMEOUT_MS)
}

function teardownToIdle(): void {
  tearingDown = true
  if (titleHideTimer) clearTimeout(titleHideTimer)
  if (errorHideTimer) clearTimeout(errorHideTimer)
  clearDeadVideoWatchdog()
  clearLoadingWatchdog()
  try { activeHandle?.pause() } catch {}
  try { activeHandle?.reset?.() } catch {}
  playerViewEl?.classList.add("hidden")
  errorEl?.classList.add("hidden")
  titleEl?.classList.add("hidden")
  idleEl?.classList.remove("hidden")
  reportState({ state: "idle", positionSeconds: 0 })
  tearingDown = false
}

function wireMediaListeners(handle: VjsLikeHandle): void {
  if (mediaListenersWired) return
  mediaListenersWired = true
  handle.on("playing", () => {
    showLoading(false)
    clearLoadingWatchdog()
    armDeadVideoWatchdog(handle)
    reportState({ state: "playing" })
  })
  handle.on("pause", () => {
    if (tearingDown) return
    reportState({ state: "paused" })
  })
  handle.on("waiting", () => {
    showLoading(true)
    reportState({ state: "buffering" })
  })
  handle.on("ended", () => {
    reportState({ state: "ended" })
    teardownToIdle()
  })
  handle.on("error", () => handleError())
  handle.on("timeupdate", () => {
    const now = Date.now()
    if (now - lastTimeReportAt < 1000) return
    lastTimeReportAt = now
    const mediaEl = getMediaElementFor(handle)
    reportState({
      state: currentPlaybackState,
      positionSeconds: mediaEl?.currentTime ?? 0,
      durationSeconds: handle.duration?.(),
    })
  })
}

async function ensurePlayer(): Promise<VjsLikeHandle | null> {
  if (mounted?.kind === "embedded") return mounted.handle
  if (!videoEl) return null
  let backend = getPlayerBackend()
  if (backend === "mpv" || backend === "vlc") backend = "artplayer"
  const result = await mountPlayer(videoEl, backend, { autoplay: true })
  if (result.kind !== "embedded") {
    log.warn("[xt:receiver] mountPlayer returned an external backend; receiver requires embedded playback")
    return null
  }
  mounted = result
  wireMediaListeners(result.handle)
  return result.handle
}

async function onPlay(rawDescriptor: unknown): Promise<void> {
  const descriptor = validateCastDescriptor(rawDescriptor)
  if (!descriptor) {
    reportState({ state: "error", error: "bad-descriptor", positionSeconds: 0 })
    return
  }

  tearingDown = false
  clearDeadVideoWatchdog()
  clearLoadingWatchdog()
  currentTitle = descriptor.title
  currentMime = descriptor.mime
  currentIsLive = descriptor.isLive

  await applyStreamHeaders(
    descriptor.headers
      ? { userAgent: descriptor.headers.userAgent ?? null, referer: descriptor.headers.referer ?? null }
      : null
  )

  reportState({ state: "loading", positionSeconds: 0 })
  showLoading(true)

  const handle = await ensurePlayer()
  if (!handle) {
    reportState({ state: "error", error: "player-unavailable", positionSeconds: 0 })
    return
  }
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
}

function consumePendingPlay(): void {
  try {
    const raw = sessionStorage.getItem(PENDING_PLAY_KEY)
    if (!raw) return
    sessionStorage.removeItem(PENDING_PLAY_KEY)
    void onPlay(JSON.parse(raw))
  } catch (err) {
    log.warn("[xt:receiver] pending play parse failed:", err)
  }
}

function onControl(payload: ReceiverControlPayload | undefined): void {
  if (!payload) return
  const handle = activeHandle
  switch (payload.action) {
    case "pause":
      handle?.pause()
      break
    case "resume":
      if (handle) playWhenReady(handle)
      break
    case "seek":
      if (handle && !currentIsLive && typeof payload.seconds === "number") {
        handle.currentTime?.(payload.seconds)
      }
      break
    case "stop":
      teardownToIdle()
      break
    default:
      break
  }
}

function isPlayerActive(): boolean {
  return !!playerViewEl && !playerViewEl.classList.contains("hidden")
}

document.addEventListener("keydown", (event) => {
  const key = event.key
  if (isPlayerActive()) {
    if (key === "Enter" || key === " " || key === "MediaPlayPause") {
      event.preventDefault()
      if (!activeHandle) return
      if (activeHandle.paused?.()) playWhenReady(activeHandle)
      else activeHandle.pause()
      return
    }
    if (!currentIsLive && (key === "ArrowLeft" || key === "ArrowRight")) {
      event.preventDefault()
      if (!activeHandle) return
      const mediaEl = getMediaElementFor(activeHandle)
      const current = mediaEl?.currentTime ?? activeHandle.currentTime?.() ?? 0
      const delta = key === "ArrowLeft" ? -10 : 10
      activeHandle.currentTime?.(Math.max(0, current + delta))
      return
    }
    if (key === "Escape" || key === "GoBack" || key === "BrowserBack") {
      event.preventDefault()
      teardownToIdle()
    }
    return
  }
  if ((key === "Escape" || key === "GoBack" || key === "BrowserBack") && !isKioskBuild) {
    event.preventDefault()
    exitReceiver()
  }
})

function exitReceiver(): void {
  try { sessionStorage.setItem("xt_receiver_exited", "1") } catch {}
  window.location.href = "/"
}

if (isKioskBuild) {
  exitBtn?.classList.add("hidden")
} else {
  exitBtn?.addEventListener("click", () => exitReceiver())
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

setInterval(() => {
  if (!idleEl || idleEl.classList.contains("hidden")) return
  if (document.documentElement.dataset.perfMode === "on" || prefersReducedMotion()) return
  const dx = Math.round((Math.random() - 0.5) * 2 * OLED_NUDGE_MAX_PX)
  const dy = Math.round((Math.random() - 0.5) * 2 * OLED_NUDGE_MAX_PX)
  idleEl.style.transform = `translate(${dx}px, ${dy}px)`
}, OLED_NUDGE_INTERVAL_MS)

void listen<ReceiverStatus>("xt:receiver-status", (event) => renderStatus(event.payload))
void listen<{ deviceName: string }>("xt:receiver-paired", (event) => showPairedFlash(event.payload?.deviceName || ""))
void listen<ReceiverPlayPayload>("xt:receiver-play", (event) => void onPlay(event.payload?.descriptor))
void listen<ReceiverControlPayload>("xt:receiver-control", (event) => onControl(event.payload))

void startReceiver()
consumePendingPlay()
