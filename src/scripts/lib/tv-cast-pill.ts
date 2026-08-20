// Floating "casting to <TV>" pill: mounts while a cast session is active, polls the receiver's /state endpoint.

import {
  getCastSession,
  updateCastSession,
  clearCastSession,
  fetchCastState,
  fetchCastStateWithFallback,
  fetchReceiverLogs,
  cacheReceiverLogSnapshot,
  castPause,
  castResume,
  castSeek,
  castStop,
  sessionAsDevice,
  CAST_SESSION_EVENT,
  type CastSession,
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
const SEEK_SUPPRESS_MS = 2500
const EXIT_ANIMATION_MS = 320

type PillStatus = "ok" | "reconnecting" | "error"

let pillEl: HTMLElement | null = null
let pollHandle: ReturnType<typeof setInterval> | null = null
let consecutiveMisses = 0
let lastKnownPositionSeconds = 0
let lastKnownDurationSeconds: number | null = null
let initialized = false
let errorToastShown = false
let suppressPollPositionUntil = 0
let morePanelObserver: MutationObserver | null = null

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total >= 3600) return formatPaddedHms(total)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function positionAboveMobileNav(pill: HTMLElement): void {
  const navElement = document.querySelector<HTMLElement>("[data-mobile-nav]")
  pill.style.bottom = navElement && navElement.offsetHeight > 0 ? `${navElement.offsetHeight + 12}px` : ""
}

function onWindowResize(): void {
  if (pillEl) positionAboveMobileNav(pillEl)
}

// The mobile More panel slides into the pill's spot; dip out of the way while it's open.
function syncMorePanelOverlap(pill: HTMLElement): void {
  const panelOpen = document.getElementById("mobile-more-panel")?.dataset.open === "true"
  pill.classList.toggle("pointer-events-none", panelOpen)
  pill.classList.toggle("translate-y-2", panelOpen)
  pill.classList.toggle("opacity-0", panelOpen)
}

function buildPill(): HTMLElement {
  const pill = document.createElement("div")
  pill.id = PILL_ID
  pill.className =
    "fixed left-4 sm:left-auto right-4 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] z-40 " +
    "flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 shadow-lg overflow-hidden " +
    "transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
  pill.setAttribute("role", "group")

  const contentBtn = document.createElement("button")
  contentBtn.type = "button"
  contentBtn.dataset.role = "content"
  contentBtn.className =
    "flex min-w-0 flex-1 sm:flex-initial items-center gap-2.5 min-h-11 rounded-lg text-left px-1 -mx-1 " +
    "enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2"

  const icon = document.createElement("span")
  icon.dataset.role = "icon"
  icon.className = "shrink-0 text-fg-3"
  icon.setAttribute("aria-hidden", "true")
  icon.innerHTML = ICON_DEVICE_TV
  contentBtn.appendChild(icon)

  const textCol = document.createElement("div")
  textCol.className = "flex flex-col min-w-0 leading-tight"
  const deviceNameEl = document.createElement("span")
  deviceNameEl.dataset.role = "device-name"
  deviceNameEl.className = "text-xs text-fg-2 truncate sm:max-w-48 lg:max-w-72"
  const titleEl = document.createElement("span")
  titleEl.dataset.role = "title"
  titleEl.className = "text-sm truncate sm:max-w-48 lg:max-w-72"
  titleEl.setAttribute("aria-live", "polite")
  textCol.appendChild(deviceNameEl)
  textCol.appendChild(titleEl)
  contentBtn.appendChild(textCol)
  pill.appendChild(contentBtn)

  const liveEl = document.createElement("span")
  liveEl.dataset.role = "live"
  liveEl.className = "hidden text-xs font-semibold text-ok"
  liveEl.textContent = t("cast.pill.live")
  pill.appendChild(liveEl)

  const timeEl = document.createElement("span")
  timeEl.dataset.role = "time"
  timeEl.className = "hidden max-sm:hidden text-xs tabular-nums text-fg-3 shrink-0"
  pill.appendChild(timeEl)

  const back30 = document.createElement("button")
  back30.type = "button"
  back30.dataset.role = "back30"
  back30.className =
    "max-sm:hidden min-h-11 min-w-11 grid place-items-center rounded-full enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2"
  back30.setAttribute("aria-label", t("cast.pill.back30"))
  back30.title = t("cast.pill.back30")
  back30.innerHTML = ICON_REWIND_BACKWARD_30
  pill.appendChild(back30)

  const playPause = document.createElement("button")
  playPause.type = "button"
  playPause.dataset.role = "playpause"
  playPause.className = "min-h-11 min-w-11 grid place-items-center rounded-full enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2"
  playPause.innerHTML = ICON_PLAYER_PAUSE
  pill.appendChild(playPause)

  const forward30 = document.createElement("button")
  forward30.type = "button"
  forward30.dataset.role = "forward30"
  forward30.className =
    "max-sm:hidden min-h-11 min-w-11 grid place-items-center rounded-full enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2"
  forward30.setAttribute("aria-label", t("cast.pill.forward30"))
  forward30.title = t("cast.pill.forward30")
  forward30.innerHTML = ICON_REWIND_FORWARD_30
  pill.appendChild(forward30)

  const divider = document.createElement("span")
  divider.setAttribute("aria-hidden", "true")
  divider.className = "h-6 w-px shrink-0 bg-line"
  pill.appendChild(divider)

  const stopBtn = document.createElement("button")
  stopBtn.type = "button"
  stopBtn.dataset.role = "stop"
  stopBtn.className = "min-h-11 min-w-11 grid place-items-center rounded-full text-bad hover:bg-surface-2 focus-visible:bg-surface-2"
  stopBtn.setAttribute("aria-label", t("cast.pill.stop"))
  stopBtn.title = t("cast.pill.stop")
  stopBtn.innerHTML = ICON_PLAYER_STOP
  pill.appendChild(stopBtn)

  const dismissBtn = document.createElement("button")
  dismissBtn.type = "button"
  dismissBtn.dataset.role = "dismiss"
  dismissBtn.className = "min-h-11 min-w-11 grid place-items-center rounded-full text-fg-3 hover:bg-surface-2 focus-visible:bg-surface-2"
  dismissBtn.setAttribute("aria-label", t("cast.pill.dismiss"))
  dismissBtn.title = t("cast.pill.dismiss")
  dismissBtn.innerHTML = ICON_X
  pill.appendChild(dismissBtn)

  const progressEl = document.createElement("div")
  progressEl.dataset.role = "progress"
  progressEl.className = "absolute left-0 bottom-0 h-0.5 bg-accent hidden"
  pill.appendChild(progressEl)

  return pill
}

function applySessionToPill(pill: HTMLElement, session: CastSession): void {
  const connectedOnly = !!session.connectedOnly && !session.title
  pill.setAttribute("aria-label", t("settings.playOnTv.castingTo", { device: session.deviceName }))
  pill.querySelector<HTMLElement>('[data-role="device-name"]')!.textContent = session.deviceName
  pill.querySelector<HTMLElement>('[data-role="title"]')!.textContent = connectedOnly
    ? t("cast.pill.ready")
    : session.title
  pill.querySelector<HTMLElement>('[data-role="live"]')!.classList.toggle("hidden", connectedOnly || !session.isLive)
  pill.querySelector<HTMLElement>('[data-role="time"]')!.classList.toggle("hidden", connectedOnly || session.isLive)
  pill.querySelector<HTMLElement>('[data-role="back30"]')!.classList.toggle("hidden", connectedOnly || session.isLive)
  pill.querySelector<HTMLElement>('[data-role="forward30"]')!.classList.toggle("hidden", connectedOnly || session.isLive)
  pill.querySelector<HTMLElement>('[data-role="playpause"]')!.classList.toggle("hidden", connectedOnly)

  const contentBtn = pill.querySelector<HTMLButtonElement>('[data-role="content"]')!
  const canOpenContent = !connectedOnly && !!session.contentHref
  contentBtn.disabled = !canOpenContent
  contentBtn.classList.toggle("cursor-default", !canOpenContent)
  if (canOpenContent) {
    const label = t("cast.pill.openContent", { title: session.title })
    contentBtn.setAttribute("aria-label", label)
    contentBtn.title = label
  } else {
    contentBtn.removeAttribute("aria-label")
    contentBtn.removeAttribute("title")
  }

  if (connectedOnly || session.isLive) {
    pill.querySelector<HTMLElement>('[data-role="progress"]')!.classList.add("hidden")
  }
}

function setPlayPauseIcon(pill: HTMLElement, paused: boolean): void {
  const button = pill.querySelector<HTMLElement>('[data-role="playpause"]')!
  button.innerHTML = paused ? ICON_PLAYER_PLAY : ICON_PLAYER_PAUSE
  const label = paused ? t("cast.pill.resume") : t("cast.pill.pause")
  button.setAttribute("aria-label", label)
  button.title = label
  button.dataset.paused = paused ? "true" : "false"
}

function updateTime(pill: HTMLElement, positionSeconds: number, durationSeconds?: number): void {
  const timeEl = pill.querySelector<HTMLElement>('[data-role="time"]')!
  timeEl.textContent =
    durationSeconds != null
      ? `${formatClock(positionSeconds)} / ${formatClock(durationSeconds)}`
      : formatClock(positionSeconds)
}

function updateProgressBar(pill: HTMLElement, positionSeconds: number, durationSeconds: number | null): void {
  const progressEl = pill.querySelector<HTMLElement>('[data-role="progress"]')!
  if (durationSeconds == null || durationSeconds <= 0) {
    progressEl.classList.add("hidden")
    return
  }
  const pct = Math.min(100, Math.max(0, (positionSeconds / durationSeconds) * 100))
  progressEl.style.width = `${pct}%`
  progressEl.classList.remove("hidden")
}

function renderStatus(pill: HTMLElement, session: CastSession, status: PillStatus): void {
  if (pill.dataset.status === status) return
  pill.dataset.status = status

  const connectedOnly = !!session.connectedOnly && !session.title
  const iconEl = pill.querySelector<HTMLElement>('[data-role="icon"]')!
  const titleEl = pill.querySelector<HTMLElement>('[data-role="title"]')!
  const transportButtons = [
    pill.querySelector<HTMLButtonElement>('[data-role="back30"]')!,
    pill.querySelector<HTMLButtonElement>('[data-role="playpause"]')!,
    pill.querySelector<HTMLButtonElement>('[data-role="forward30"]')!,
  ]

  if (status === "reconnecting") {
    titleEl.textContent = t("cast.pill.reconnecting")
    for (const button of transportButtons) {
      button.disabled = true
      button.classList.add("opacity-60")
    }
    return
  }

  for (const button of transportButtons) {
    button.disabled = false
    button.classList.remove("opacity-60")
  }
  if (status === "error") {
    iconEl.classList.remove("text-fg-3")
    iconEl.classList.add("text-bad")
    titleEl.textContent = t("cast.pill.error")
    return
  }
  iconEl.classList.remove("text-bad")
  iconEl.classList.add("text-fg-3")
  titleEl.textContent = connectedOnly ? t("cast.pill.ready") : session.title
}

async function tick(): Promise<void> {
  const session = getCastSession()
  if (!session || !pillEl) return
  const device = sessionAsDevice(session)
  // One miss away from giving up: walk the device's other known addresses before declaring it gone.
  const nearGiveUp = consecutiveMisses === MAX_CONSECUTIVE_MISSES - 1
  const state = nearGiveUp ? await fetchCastStateWithFallback(device) : await fetchCastState(device)
  if (!state) {
    consecutiveMisses++
    if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
      unmount()
      clearCastSession()
    } else {
      renderStatus(pillEl, session, "reconnecting")
    }
    return
  }
  consecutiveMisses = 0
  if (state.durationSeconds != null) lastKnownDurationSeconds = state.durationSeconds
  if (state.state === "idle") {
    // Connected-only mode is meant to survive receiver idle, not tear it down.
    if (!session.connectedOnly) {
      unmount()
      clearCastSession()
    }
    return
  }
  if (state.state === "error") {
    renderStatus(pillEl, session, "error")
    if (!errorToastShown) {
      errorToastShown = true
      log.error("[xt:cast] receiver playback error on", session.deviceName, ":", state.error)
      toast({
        title: t("cast.toast.playbackError", { device: session.deviceName, error: state.error || t("receiver.error.title") }),
        variant: "error",
      })
      void fetchReceiverLogs(device).then((text) => {
        if (text) cacheReceiverLogSnapshot(session.deviceName, text)
      })
    }
  } else {
    errorToastShown = false
    renderStatus(pillEl, session, "ok")
    setPlayPauseIcon(pillEl, state.state === "paused")
  }
  if (Date.now() < suppressPollPositionUntil) return
  lastKnownPositionSeconds = state.positionSeconds
  if (!session.isLive) {
    updateTime(pillEl, state.positionSeconds, state.durationSeconds)
    updateProgressBar(pillEl, state.positionSeconds, state.durationSeconds ?? null)
  }
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

  if (target.closest('[data-role="content"]')) {
    if (session.contentHref) window.location.assign(session.contentHref)
    return
  }
  if (target.closest('[data-role="dismiss"]')) {
    toast({ title: t("cast.toast.stillCasting"), duration: 3200 })
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
    suppressPollPositionUntil = Date.now() + SEEK_SUPPRESS_MS
    if (!session.isLive) {
      updateTime(pillEl, seekTo)
      updateProgressBar(pillEl, seekTo, lastKnownDurationSeconds)
    }
    return
  }
  if (target.closest('[data-role="forward30"]')) {
    const seekTo = lastKnownPositionSeconds + SEEK_STEP_SECONDS
    castSeek(device, seekTo).catch((err) => log.warn("[xt:tv-cast-pill] seek failed:", err))
    lastKnownPositionSeconds = seekTo
    suppressPollPositionUntil = Date.now() + SEEK_SUPPRESS_MS
    if (!session.isLive) {
      updateTime(pillEl, seekTo)
      updateProgressBar(pillEl, seekTo, lastKnownDurationSeconds)
    }
    return
  }
}

function onLocaleChange(): void {
  const session = getCastSession()
  if (pillEl && session) {
    unmount(false)
    mount(session)
  }
}

function mount(session: CastSession): void {
  if (pillEl) unmount(false)
  errorToastShown = false
  suppressPollPositionUntil = 0
  lastKnownDurationSeconds = null
  const pill = buildPill()
  pill.classList.add("translate-y-2", "opacity-0")
  applySessionToPill(pill, session)
  setPlayPauseIcon(pill, false)
  pill.addEventListener("click", onPillClick)
  document.body.appendChild(pill)
  pillEl = pill
  positionAboveMobileNav(pill)
  window.addEventListener("resize", onWindowResize)
  const morePanel = document.getElementById("mobile-more-panel")
  if (morePanel) {
    morePanelObserver = new MutationObserver(() => {
      if (pillEl) syncMorePanelOverlap(pillEl)
    })
    morePanelObserver.observe(morePanel, { attributes: true, attributeFilter: ["data-open"] })
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      pill.classList.remove("translate-y-2", "opacity-0")
      syncMorePanelOverlap(pill)
    })
  })
  startPolling()
  void tick()
}

function unmount(animate = true): void {
  if (!pillEl) return
  const pill = pillEl
  pill.removeEventListener("click", onPillClick)
  window.removeEventListener("resize", onWindowResize)
  morePanelObserver?.disconnect()
  morePanelObserver = null
  stopPolling()
  pillEl = null
  if (!animate) {
    pill.remove()
    return
  }
  pill.classList.add("translate-y-2", "opacity-0")
  setTimeout(() => pill.remove(), EXIT_ANIMATION_MS)
}

function onSessionChanged(): void {
  const session = getCastSession()
  if (session && !session.dismissed) {
    if (pillEl) {
      applySessionToPill(pillEl, session)
      renderStatus(pillEl, session, "ok")
    } else {
      mount(session)
    }
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
