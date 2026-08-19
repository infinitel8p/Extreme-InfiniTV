// TV receiver screen: pairing idle view + remote-controlled playback.
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  mountPlayer,
  playWhenReady,
  type Mounted,
  type VjsLikeHandle,
} from "@/scripts/lib/player-runtime"
import { getPlayerBackend, getReceiverDeviceName } from "@/scripts/lib/app-settings.js"
import { applyStreamHeaders } from "@/scripts/lib/stream-headers"
import { validateCastDescriptor } from "@/scripts/lib/tv-cast-descriptor"
import { t, initI18n } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
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
let currentIsLive = false
let currentPlaybackState = "idle"
let tearingDown = false
let lastTimeReportAt = 0

let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null
let pairedFlashTimer: ReturnType<typeof setTimeout> | null = null
let titleHideTimer: ReturnType<typeof setTimeout> | null = null
let errorHideTimer: ReturnType<typeof setTimeout> | null = null

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
  const name = getReceiverDeviceName()
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

function describePlaybackError(): string {
  try {
    const mediaError = getMediaElementFor(activeHandle)?.error
    if (mediaError?.message) return mediaError.message
    const errorDetail = activeHandle?.codecInfo?.()?.errorDetail
    if (errorDetail) return errorDetail
  } catch {}
  return t("receiver.error.title")
}

function handleError(): void {
  const message = describePlaybackError()
  if (errorMessageEl) errorMessageEl.textContent = message
  showLoading(false)
  errorEl?.classList.remove("hidden")
  reportState({ state: "error", error: message, positionSeconds: 0 })
  if (errorHideTimer) clearTimeout(errorHideTimer)
  errorHideTimer = setTimeout(() => teardownToIdle(), 10000)
}

function teardownToIdle(): void {
  tearingDown = true
  if (titleHideTimer) clearTimeout(titleHideTimer)
  if (errorHideTimer) clearTimeout(errorHideTimer)
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
  currentTitle = descriptor.title
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
