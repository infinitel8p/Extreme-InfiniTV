// TV receiver screen: pairing idle view + remote-controlled playback.
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getEffectiveReceiverDeviceName, getReceiverEngine } from "@/scripts/lib/app-settings.js"
import { applyStreamHeaders } from "@/scripts/lib/stream-headers"
import { validateCastDescriptor, type CastDescriptorV1 } from "@/scripts/lib/tv-cast-descriptor"
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { androidNativePlayerAvailable } from "@/scripts/lib/android-video-launcher.js"
import {
  createAndroidNativeReceiverEngine,
  createEmbeddedReceiverEngine,
  type ReceiverControlAction,
  type ReceiverEngine,
  type ReceiverEngineCallbacks,
  type ReceiverPlaybackState,
  type ReceiverStatePartial,
} from "@/scripts/receiver/engines"
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
  action: ReceiverControlAction
  seconds?: number
  deviceName?: string
}

const PENDING_PLAY_KEY = "xt_receiver_pending_play"
const OLED_NUDGE_INTERVAL_MS = 5 * 60 * 1000
const OLED_NUDGE_MAX_PX = 8

const idleEl = document.getElementById("receiver-idle")
const deviceNameEl = document.getElementById("receiver-device-name")
const readyBadgeEl = document.getElementById("receiver-ready")
const addressesEl = document.getElementById("receiver-addresses")
const pairCodeEl = document.getElementById("receiver-pair-code")
const pairedFlashEl = document.getElementById("receiver-paired-flash")
const exitBtn = document.getElementById("receiver-exit")
const playerViewEl = document.getElementById("receiver-player")
const videoEl = document.getElementById("receiver-video") as HTMLVideoElement | null
const titleWrapEl = document.getElementById("receiver-title-wrap")
const titleEl = document.getElementById("receiver-title")
const loadingEl = document.getElementById("receiver-loading")
const loadingTitleEl = document.getElementById("receiver-loading-title")
const pausedEl = document.getElementById("receiver-paused")
const seekFlashEl = document.getElementById("receiver-seek-flash")
const errorEl = document.getElementById("receiver-error")
const errorMessageEl = document.getElementById("receiver-error-message")
const errorCountdownEl = document.getElementById("receiver-error-countdown")

let currentTitle = ""
let currentIsLive = false
let currentPlaybackState: ReceiverPlaybackState = "idle"
let lastKnownPositionSeconds = 0

let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null
let pairedFlashTimer: ReturnType<typeof setTimeout> | null = null
let seekFlashTimer: ReturnType<typeof setTimeout> | null = null

function renderStatus(status: ReceiverStatus): void {
  if (statusRefreshTimer) {
    clearTimeout(statusRefreshTimer)
    statusRefreshTimer = null
  }
  if (status.name) {
    if (deviceNameEl) deviceNameEl.textContent = status.name
    readyBadgeEl?.classList.remove("hidden")
  }
  const ips = status.ips || []
  if (addressesEl && ips.length > 0) {
    addressesEl.textContent = ""
    for (const ip of ips) {
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

function showSeekFlash(deltaSeconds: number): void {
  if (!seekFlashEl) return
  seekFlashEl.textContent = (deltaSeconds > 0 ? "+" : "-") + Math.abs(deltaSeconds) + "s"
  seekFlashEl.classList.remove("hidden")
  if (seekFlashTimer) clearTimeout(seekFlashTimer)
  seekFlashTimer = setTimeout(() => seekFlashEl.classList.add("hidden"), 900)
}

function reportState(partial: ReceiverStatePartial): void {
  currentPlaybackState = partial.state
  if (typeof partial.positionSeconds === "number") lastKnownPositionSeconds = partial.positionSeconds
  const payload = {
    state: partial.state,
    positionSeconds: partial.positionSeconds ?? lastKnownPositionSeconds,
    durationSeconds: partial.durationSeconds,
    title: currentTitle || undefined,
    error: partial.error,
  }
  void invoke("receiver_report_state", { payload }).catch((err) => {
    log.warn("[xt:receiver] receiver_report_state failed:", err)
  })
}

let activeEngine: ReceiverEngine | null = null

const engineCallbacks: ReceiverEngineCallbacks = {
  report: reportState,
  onSessionEnded: () => { activeEngine = null },
}

const embeddedEngine = createEmbeddedReceiverEngine(
  {
    idleEl,
    playerViewEl,
    videoEl,
    titleWrapEl,
    titleEl,
    loadingEl,
    loadingTitleEl,
    pausedEl,
    errorEl,
    errorMessageEl,
    errorCountdownEl,
  },
  engineCallbacks,
)

const androidNativeEngine = androidNativePlayerAvailable
  ? createAndroidNativeReceiverEngine(engineCallbacks)
  : null

function pickEngine(descriptor: CastDescriptorV1): ReceiverEngine {
  if (!androidNativeEngine) return embeddedEngine
  const preference = getReceiverEngine()
  if (preference === "embedded") return embeddedEngine
  if (preference === "native") return androidNativeEngine
  return descriptor.drm ? embeddedEngine : androidNativeEngine
}

async function startWithEngine(engine: ReceiverEngine, descriptor: CastDescriptorV1): Promise<boolean> {
  const started = await engine.play(descriptor)
  if (started) activeEngine = engine
  return started
}

async function onPlay(rawDescriptor: unknown): Promise<void> {
  const descriptor = validateCastDescriptor(rawDescriptor)
  if (!descriptor) {
    reportState({ state: "error", error: "bad-descriptor", positionSeconds: 0 })
    return
  }

  activeEngine?.teardown()
  activeEngine = null

  currentTitle = descriptor.title
  currentIsLive = descriptor.isLive

  await applyStreamHeaders(
    descriptor.headers
      ? { userAgent: descriptor.headers.userAgent ?? null, referer: descriptor.headers.referer ?? null }
      : null
  )

  const engine = pickEngine(descriptor)
  const started = await startWithEngine(engine, descriptor)
  if (started) return

  if (engine === androidNativeEngine) {
    log.warn("[xt:receiver] native playback unavailable, falling back to embedded playback")
    if (await startWithEngine(embeddedEngine, descriptor)) return
  }
  reportState({ state: "error", error: "player-unavailable", positionSeconds: 0 })
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
  activeEngine?.control(payload.action, payload.seconds)
}

function isPlayerActive(): boolean {
  if (activeEngine) return true
  return !!playerViewEl && !playerViewEl.classList.contains("hidden")
}

document.addEventListener("keydown", (event) => {
  const key = event.key
  if (isPlayerActive()) {
    if (key === "Enter" || key === " " || key === "MediaPlayPause") {
      event.preventDefault()
      if (!activeEngine) return
      activeEngine.control(currentPlaybackState === "paused" ? "resume" : "pause")
      return
    }
    if (!currentIsLive && (key === "ArrowLeft" || key === "ArrowRight")) {
      event.preventDefault()
      if (!activeEngine) return
      const delta = key === "ArrowLeft" ? -10 : 10
      activeEngine.control("seek", Math.max(0, lastKnownPositionSeconds + delta))
      showSeekFlash(delta)
      return
    }
    if (key === "Escape" || key === "GoBack" || key === "BrowserBack") {
      event.preventDefault()
      activeEngine?.control("stop")
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
