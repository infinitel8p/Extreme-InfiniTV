// Floating "casting to <TV>" pill: mounts while a cast session is active, polls the receiver's /state endpoint.

import {
  getCastSession,
  updateCastSession,
  clearCastSession,
  fetchCastState,
  castPause,
  castResume,
  castSeek,
  castStop,
  CAST_SESSION_EVENT,
  type CastSession,
  type TvDevice,
} from "@/scripts/lib/tv-cast.js"
import { toast } from "@/scripts/lib/toast.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { formatPaddedHms } from "@/scripts/lib/format.js"
import {
  ICON_DEVICE_TV,
  ICON_PLAYER_PLAY,
  ICON_PLAYER_PAUSE,
  ICON_PLAYER_STOP,
  ICON_REWIND_BACKWARD_30,
  ICON_REWIND_FORWARD_30,
  ICON_X,
} from "@/scripts/lib/icons.js"

const PILL_ID = "xt-cast-pill"
const POLL_INTERVAL_MS = 2000
const MAX_CONSECUTIVE_MISSES = 3
const SEEK_STEP_SECONDS = 30

let pillEl: HTMLElement | null = null
let pollHandle: ReturnType<typeof setInterval> | null = null
let consecutiveMisses = 0
let lastKnownPositionSeconds = 0
let initialized = false
let errorToastShown = false

function sessionAsDevice(session: CastSession): TvDevice {
  return {
    id: session.deviceId,
    name: session.deviceName,
    host: session.host,
    port: session.port,
    key: session.key,
    createdAt: 0,
    lastSeenAt: 0,
  }
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total >= 3600) return formatPaddedHms(total)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function buildPill(): HTMLElement {
  const pill = document.createElement("div")
  pill.id = PILL_ID
  pill.className =
    "fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] z-40 " +
    "flex items-center gap-3 rounded-full border border-line bg-surface px-3 py-2 shadow-lg"
  pill.setAttribute("role", "group")

  const icon = document.createElement("span")
  icon.className = "shrink-0 text-fg-3"
  icon.setAttribute("aria-hidden", "true")
  icon.innerHTML = ICON_DEVICE_TV
  pill.appendChild(icon)

  const textCol = document.createElement("div")
  textCol.className = "flex flex-col min-w-0 leading-tight"
  const deviceNameEl = document.createElement("span")
  deviceNameEl.dataset.role = "device-name"
  deviceNameEl.className = "text-xs text-fg-3 truncate max-w-48"
  const titleEl = document.createElement("span")
  titleEl.dataset.role = "title"
  titleEl.className = "text-sm truncate max-w-48"
  textCol.appendChild(deviceNameEl)
  textCol.appendChild(titleEl)
  pill.appendChild(textCol)

  const liveEl = document.createElement("span")
  liveEl.dataset.role = "live"
  liveEl.className = "hidden text-xs font-semibold text-accent"
  liveEl.textContent = t("cast.pill.live")
  pill.appendChild(liveEl)

  const timeEl = document.createElement("span")
  timeEl.dataset.role = "time"
  timeEl.className = "hidden text-xs tabular-nums text-fg-3 shrink-0"
  pill.appendChild(timeEl)

  const back30 = document.createElement("button")
  back30.type = "button"
  back30.dataset.role = "back30"
  back30.className = "min-h-11 min-w-11 grid place-items-center rounded-full hover:bg-surface-2 focus-visible:bg-surface-2"
  back30.setAttribute("aria-label", t("cast.pill.back30"))
  back30.innerHTML = ICON_REWIND_BACKWARD_30
  pill.appendChild(back30)

  const playPause = document.createElement("button")
  playPause.type = "button"
  playPause.dataset.role = "playpause"
  playPause.className = "min-h-11 min-w-11 grid place-items-center rounded-full hover:bg-surface-2 focus-visible:bg-surface-2"
  playPause.innerHTML = ICON_PLAYER_PAUSE
  pill.appendChild(playPause)

  const forward30 = document.createElement("button")
  forward30.type = "button"
  forward30.dataset.role = "forward30"
  forward30.className = "min-h-11 min-w-11 grid place-items-center rounded-full hover:bg-surface-2 focus-visible:bg-surface-2"
  forward30.setAttribute("aria-label", t("cast.pill.forward30"))
  forward30.innerHTML = ICON_REWIND_FORWARD_30
  pill.appendChild(forward30)

  const stopBtn = document.createElement("button")
  stopBtn.type = "button"
  stopBtn.dataset.role = "stop"
  stopBtn.className = "min-h-11 min-w-11 grid place-items-center rounded-full text-bad hover:bg-surface-2 focus-visible:bg-surface-2"
  stopBtn.setAttribute("aria-label", t("cast.pill.stop"))
  stopBtn.innerHTML = ICON_PLAYER_STOP
  pill.appendChild(stopBtn)

  const dismissBtn = document.createElement("button")
  dismissBtn.type = "button"
  dismissBtn.dataset.role = "dismiss"
  dismissBtn.className = "min-h-11 min-w-11 grid place-items-center rounded-full text-fg-3 hover:bg-surface-2 focus-visible:bg-surface-2"
  dismissBtn.setAttribute("aria-label", t("cast.pill.dismiss"))
  dismissBtn.innerHTML = ICON_X
  pill.appendChild(dismissBtn)

  return pill
}

function applySessionToPill(pill: HTMLElement, session: CastSession): void {
  pill.querySelector<HTMLElement>('[data-role="device-name"]')!.textContent = session.deviceName
  pill.querySelector<HTMLElement>('[data-role="title"]')!.textContent = session.title
  pill.querySelector<HTMLElement>('[data-role="live"]')!.classList.toggle("hidden", !session.isLive)
  pill.querySelector<HTMLElement>('[data-role="time"]')!.classList.toggle("hidden", session.isLive)
  pill.querySelector<HTMLElement>('[data-role="back30"]')!.classList.toggle("hidden", session.isLive)
  pill.querySelector<HTMLElement>('[data-role="forward30"]')!.classList.toggle("hidden", session.isLive)
}

function setPlayPauseIcon(pill: HTMLElement, paused: boolean): void {
  const button = pill.querySelector<HTMLElement>('[data-role="playpause"]')!
  button.innerHTML = paused ? ICON_PLAYER_PLAY : ICON_PLAYER_PAUSE
  button.setAttribute("aria-label", paused ? t("cast.pill.resume") : t("cast.pill.pause"))
  button.dataset.paused = paused ? "true" : "false"
}

function updateTime(pill: HTMLElement, positionSeconds: number, durationSeconds?: number): void {
  const timeEl = pill.querySelector<HTMLElement>('[data-role="time"]')!
  timeEl.textContent =
    durationSeconds != null
      ? `${formatClock(positionSeconds)} / ${formatClock(durationSeconds)}`
      : formatClock(positionSeconds)
}

async function tick(): Promise<void> {
  const session = getCastSession()
  if (!session || !pillEl) return
  const device = sessionAsDevice(session)
  const state = await fetchCastState(device)
  if (!state) {
    consecutiveMisses++
    if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
      unmount()
      clearCastSession()
    }
    return
  }
  consecutiveMisses = 0
  lastKnownPositionSeconds = state.positionSeconds
  if (state.state === "idle") {
    unmount()
    clearCastSession()
    return
  }
  if (state.state === "error") {
    if (!errorToastShown) {
      errorToastShown = true
      toast({
        title: t("cast.toast.playbackError", { device: session.deviceName, error: state.error || t("receiver.error.title") }),
        variant: "error",
      })
    }
  } else {
    errorToastShown = false
  }
  setPlayPauseIcon(pillEl, state.state === "paused")
  if (!session.isLive) updateTime(pillEl, state.positionSeconds, state.durationSeconds)
}

function startPolling(): void {
  stopPolling()
  consecutiveMisses = 0
  pollHandle = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return
    void tick()
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollHandle != null) {
    clearInterval(pollHandle)
    pollHandle = null
  }
}

function onPillClick(event: Event): void {
  const target = event.target as HTMLElement | null
  if (!target || !pillEl) return
  const session = getCastSession()
  if (!session) return
  const device = sessionAsDevice(session)

  if (target.closest('[data-role="dismiss"]')) {
    updateCastSession({ dismissed: true })
    unmount()
    return
  }
  if (target.closest('[data-role="stop"]')) {
    castStop(device)
      .then(() => toast({ title: t("cast.toast.stopped", { device: device.name }) }))
      .catch((err) => log.warn("[xt:tv-cast-pill] stop failed:", err))
    unmount()
    return
  }
  if (target.closest('[data-role="playpause"]')) {
    const button = pillEl.querySelector<HTMLElement>('[data-role="playpause"]')!
    const paused = button.dataset.paused === "true"
    const action = paused ? castResume(device) : castPause(device)
    action.catch((err) => log.warn("[xt:tv-cast-pill] pause/resume failed:", err))
    setPlayPauseIcon(pillEl, !paused)
    return
  }
  if (target.closest('[data-role="back30"]')) {
    const seekTo = Math.max(0, lastKnownPositionSeconds - SEEK_STEP_SECONDS)
    castSeek(device, seekTo).catch((err) => log.warn("[xt:tv-cast-pill] seek failed:", err))
    lastKnownPositionSeconds = seekTo
    if (!session.isLive) updateTime(pillEl, seekTo)
    return
  }
  if (target.closest('[data-role="forward30"]')) {
    const seekTo = lastKnownPositionSeconds + SEEK_STEP_SECONDS
    castSeek(device, seekTo).catch((err) => log.warn("[xt:tv-cast-pill] seek failed:", err))
    lastKnownPositionSeconds = seekTo
    if (!session.isLive) updateTime(pillEl, seekTo)
    return
  }
}

function onLocaleChange(): void {
  const session = getCastSession()
  if (pillEl && session) {
    unmount()
    mount(session)
  }
}

function mount(session: CastSession): void {
  if (pillEl) unmount()
  errorToastShown = false
  const pill = buildPill()
  applySessionToPill(pill, session)
  setPlayPauseIcon(pill, false)
  pill.addEventListener("click", onPillClick)
  document.body.appendChild(pill)
  pillEl = pill
  startPolling()
  void tick()
}

function unmount(): void {
  if (!pillEl) return
  pillEl.removeEventListener("click", onPillClick)
  pillEl.remove()
  pillEl = null
  stopPolling()
}

function onSessionChanged(): void {
  const session = getCastSession()
  if (session && !session.dismissed) {
    mount(session)
  } else {
    unmount()
  }
}

export function initTvCastPill(): void {
  if (initialized) return
  initialized = true

  document.addEventListener(CAST_SESSION_EVENT, onSessionChanged)
  document.addEventListener(LOCALE_EVENT, onLocaleChange)

  const session = getCastSession()
  if (session && !session.dismissed) mount(session)
}
