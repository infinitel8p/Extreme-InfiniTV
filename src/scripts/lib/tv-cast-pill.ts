// Floating "casting to <TV>" pill: mounts while a cast session is active, tracks the shared cast state feed.

import {
  getCastSession,
  updateCastSession,
  clearCastSession,
  fetchReceiverLogs,
  cacheReceiverLogSnapshot,
  getReceiverLogSnapshotAt,
  castPause,
  castResume,
  castSeek,
  castStop,
  castRetryLast,
  isCastPlaySettling,
  sessionAsDevice,
  tryReattachCastSession,
  hasReattachableCastBackup,
  CAST_SESSION_EVENT,
  type CastSession,
  type CastState,
  type TvDevice,
} from "@/scripts/lib/tv-cast.js"
import {
  subscribeCastStateFeed,
  pokeCastStateFeed,
  createIdleTeardownGuard,
  createCastLoadingStallGuard,
  type CastFeedHealth,
} from "@/scripts/lib/tv-cast-state-feed.js"
import { castNeighbor, createAutoAdvanceTracker, resolveNeighborAvailability, neighborAvailability } from "@/scripts/lib/tv-cast-next.js"
import { createCastProgressRecorder } from "@/scripts/lib/tv-cast-progress.js"
import {
  initCastMediaNotificationActions,
  updateCastMediaNotification,
  clearCastMediaNotification,
} from "@/scripts/lib/cast-media-notification.js"
import { RECONNECT_EVENT } from "@/scripts/lib/connectivity.ts"
import { toast } from "@/scripts/lib/toast.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { formatElapsedSinceStart, formatPaddedHms } from "@/scripts/lib/format.js"
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
const FEED_CADENCE_MS = 2000
// Always spans one full poll cadence, so a poll landing just after a manual seek can't roll it back.
const SEEK_SUPPRESS_MS = FEED_CADENCE_MS + 500
const SEEK_STEP_SECONDS = 30
const EXIT_ANIMATION_MS = 320
const LOG_SNAPSHOT_INTERVAL_MS = 60_000
const STOP_CONFIRM_WINDOW_MS = 3000
const IDLE_COLLAPSE_MS = 45_000
const POST_INTERACTION_GRACE_MS = 5000
// Swallows the click whose own focusin/pointerenter just expanded the collapsed chip.
const EXPAND_CLICK_SUPPRESS_MS = 400
const COLLAPSE_HIDDEN_ROLES = ["live", "live-elapsed", "time", "back30", "playpause", "forward30", "retry", "divider", "stop", "dismiss"]
const COLLAPSE_MARK_CLASS = "xt-idle-collapsed"

type PillStatus = "ok" | "reconnecting" | "error"

let pillEl: HTMLElement | null = null
let feedUnsubscribe: (() => void) | null = null
let lastKnownPositionSeconds = 0
let lastKnownDurationSeconds: number | null = null
let initialized = false
let errorToastShown = false
let suppressPollPositionUntil = 0
let morePanelObserver: MutationObserver | null = null
let logSnapshotInFlight = false
// Tracked locally so an empty/failed fetch (never cached) still backs off for the interval.
let lastLogSnapshotAttemptAtMs = 0
let stopArmed = false
let stopArmTimeout: ReturnType<typeof setTimeout> | null = null
let lastAnnouncedPlaybackState: string | null = null
let lastAppliedTitle: string | null = null
let pillCollapsed = false
let idleCollapseTimeout: ReturnType<typeof setTimeout> | null = null
let lastPillInteractionAt = 0
let retryInFlight = false
let lastExpandFromCollapsedAtMs = 0
let autoAdvanceTracker = createAutoAdvanceTracker()
let autoAdvanceInFlight = false
// The receiver's idle report right after ended must wait for an in-flight advance to resolve.
let idleDeferredDuringAdvance = false
let liveElapsedTicker: ReturnType<typeof setInterval> | null = null
// Session-keyed, so it survives the locale-change remount and resets itself on a new cast.
const idleTeardownGuard = createIdleTeardownGuard()
let castLoadingStallGuard = createCastLoadingStallGuard()
const castProgressRecorder = createCastProgressRecorder()

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
  // end-6/bottom base of 1.5rem (not 1rem) so the pill clears a native scrollbar instead of touching it.
  pill.className =
    "fixed start-6 sm:start-auto end-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom,0px))] z-40 " +
    "flex items-center gap-2 rounded-full border border-line bg-surface py-2 shadow-lg overflow-hidden " +
    "transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
  pill.setAttribute("role", "group")

  // Full-height start segment of the capsule, so its hover/focus background isn't an inset rectangle.
  const contentBtn = document.createElement("button")
  contentBtn.type = "button"
  contentBtn.dataset.role = "content"
  contentBtn.className =
    "flex min-w-0 flex-1 sm:flex-initial items-center gap-2.5 self-stretch -my-2 min-h-11 rounded-s-full text-start px-3 " +
    "enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2"

  const icon = document.createElement("span")
  icon.dataset.role = "icon"
  icon.className = "shrink-0 text-fg-3"
  icon.setAttribute("aria-hidden", "true")
  icon.innerHTML = ICON_DEVICE_TV
  contentBtn.appendChild(icon)

  const textCol = document.createElement("div")
  textCol.dataset.role = "text-col"
  textCol.className =
    "flex flex-col min-w-0 leading-tight max-w-none overflow-hidden transition-[max-width,opacity] duration-200"
  const deviceNameEl = document.createElement("span")
  deviceNameEl.dataset.role = "device-name"
  deviceNameEl.className = "text-xs text-fg-2 truncate sm:max-w-48 lg:max-w-72"
  const titleEl = document.createElement("span")
  titleEl.dataset.role = "title"
  titleEl.className = "text-sm truncate sm:max-w-48 lg:max-w-72"
  textCol.appendChild(deviceNameEl)
  textCol.appendChild(titleEl)
  contentBtn.appendChild(textCol)

  // Only visible while collapsed: keeps "still casting, N minutes in" readable without reopening the pill.
  const chipClock = document.createElement("span")
  chipClock.dataset.role = "chip-clock"
  chipClock.className = "hidden ms-2 shrink-0 text-xs tabular-nums text-fg-3"
  contentBtn.appendChild(chipClock)
  pill.appendChild(contentBtn)

  const liveEl = document.createElement("span")
  liveEl.dataset.role = "live"
  liveEl.className = "hidden text-xs font-semibold text-ok"
  liveEl.textContent = t("cast.pill.live")
  pill.appendChild(liveEl)

  const liveElapsedEl = document.createElement("span")
  liveElapsedEl.dataset.role = "live-elapsed"
  liveElapsedEl.className = "hidden text-xs tabular-nums text-fg-3 shrink-0"
  pill.appendChild(liveElapsedEl)

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

  const retryBtn = document.createElement("button")
  retryBtn.type = "button"
  retryBtn.dataset.role = "retry"
  retryBtn.className =
    "hidden min-h-11 shrink-0 flex items-center justify-center rounded-full px-3 text-xs font-semibold text-accent " +
    "enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2 disabled:opacity-60"
  retryBtn.textContent = t("cast.pill.retry")
  retryBtn.title = t("cast.pill.retry")
  pill.appendChild(retryBtn)

  const divider = document.createElement("span")
  divider.dataset.role = "divider"
  divider.setAttribute("aria-hidden", "true")
  divider.className = "h-6 w-px shrink-0 bg-line"
  pill.appendChild(divider)

  // Icon stays first so arming the stop confirmation (which appends a label after it) never moves it.
  const stopBtn = document.createElement("button")
  stopBtn.type = "button"
  stopBtn.dataset.role = "stop"
  stopBtn.dataset.armed = "false"
  stopBtn.className =
    "min-h-11 min-w-11 flex items-center rounded-full text-bad enabled:hover:bg-surface-2 enabled:focus-visible:bg-surface-2"
  stopBtn.setAttribute("aria-label", t("cast.pill.stop"))
  stopBtn.title = t("cast.pill.stop")

  const stopIcon = document.createElement("span")
  stopIcon.dataset.role = "stop-icon"
  stopIcon.className = "grid h-11 w-11 shrink-0 place-items-center"
  stopIcon.setAttribute("aria-hidden", "true")
  stopIcon.innerHTML = ICON_PLAYER_STOP
  stopBtn.appendChild(stopIcon)

  const stopLabel = document.createElement("span")
  stopLabel.dataset.role = "stop-label"
  stopLabel.className =
    "max-w-0 overflow-hidden whitespace-nowrap text-xs font-semibold transition-[max-width,margin-inline-end] duration-200"
  stopLabel.textContent = t("cast.pill.stopConfirm")
  stopBtn.appendChild(stopLabel)
  stopBtn.addEventListener("blur", () => disarmStopButton(pill))
  pill.appendChild(stopBtn)

  // Mirrors contentBtn on the opposite end: full-height end segment carrying its own end padding.
  const dismissBtn = document.createElement("button")
  dismissBtn.type = "button"
  dismissBtn.dataset.role = "dismiss"
  dismissBtn.className =
    "self-stretch -my-2 min-h-11 min-w-11 grid place-items-center rounded-e-full -ml-2 px-3 text-fg-3 " +
    "hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg"
  dismissBtn.setAttribute("aria-label", t("cast.pill.dismiss"))
  dismissBtn.title = t("cast.pill.dismiss")
  dismissBtn.innerHTML = ICON_X
  pill.appendChild(dismissBtn)

  const progressEl = document.createElement("div")
  progressEl.dataset.role = "progress"
  progressEl.className = "absolute start-0 bottom-0 h-0.5 bg-accent hidden"
  pill.appendChild(progressEl)

  const srStatusEl = document.createElement("span")
  srStatusEl.dataset.role = "sr-status"
  srStatusEl.className = "sr-only"
  srStatusEl.setAttribute("aria-live", "polite")
  srStatusEl.setAttribute("role", "status")
  pill.appendChild(srStatusEl)

  return pill
}

function announceStatus(pill: HTMLElement, text: string): void {
  pill.querySelector<HTMLElement>('[data-role="sr-status"]')!.textContent = text
}

function clearStopArmTimeout(): void {
  if (stopArmTimeout != null) {
    clearTimeout(stopArmTimeout)
    stopArmTimeout = null
  }
}

function armStopButton(pill: HTMLElement): void {
  stopArmed = true
  clearIdleCollapseTimeout()
  const stopBtn = pill.querySelector<HTMLButtonElement>('[data-role="stop"]')!
  const stopLabel = pill.querySelector<HTMLElement>('[data-role="stop-label"]')!
  stopBtn.dataset.armed = "true"
  stopBtn.setAttribute("aria-label", t("cast.pill.stopConfirmLabel"))
  stopBtn.title = t("cast.pill.stopConfirmLabel")
  stopLabel.classList.add("max-w-24", "me-3")
  announceStatus(pill, t("cast.pill.stopConfirmLabel"))
  clearStopArmTimeout()
  stopArmTimeout = setTimeout(() => disarmStopButton(pill), STOP_CONFIRM_WINDOW_MS)
}

function disarmStopButton(pill: HTMLElement): void {
  clearStopArmTimeout()
  if (!stopArmed) return
  stopArmed = false
  const stopBtn = pill.querySelector<HTMLButtonElement>('[data-role="stop"]')!
  const stopLabel = pill.querySelector<HTMLElement>('[data-role="stop-label"]')!
  stopBtn.dataset.armed = "false"
  stopBtn.setAttribute("aria-label", t("cast.pill.stop"))
  stopBtn.title = t("cast.pill.stop")
  stopLabel.classList.remove("max-w-24", "me-3")
  const session = getCastSession()
  if (session) restartIdleCollapseCountdown(pill, session)
}

/** Connected to a device but nothing chosen to play yet. */
function isConnectedOnlySession(session: CastSession): boolean {
  return !!session.connectedOnly && !session.title
}

/** Visibility that respects the idle-collapsed chip: a role hidden by the collapse stays hidden until it expands. */
function setRoleHidden(el: HTMLElement, hidden: boolean): void {
  if (!hidden && pillCollapsed && COLLAPSE_HIDDEN_ROLES.includes(el.dataset.role ?? "")) {
    el.classList.add("hidden", COLLAPSE_MARK_CLASS)
    return
  }
  el.classList.toggle("hidden", hidden)
  el.classList.remove(COLLAPSE_MARK_CLASS)
}

function applyTransportVisibility(pill: HTMLElement, session: CastSession): void {
  const connectedOnly = isConnectedOnlySession(session)
  setRoleHidden(pill.querySelector<HTMLElement>('[data-role="back30"]')!, connectedOnly || session.isLive)
  setRoleHidden(pill.querySelector<HTMLElement>('[data-role="forward30"]')!, connectedOnly || session.isLive)
  setRoleHidden(pill.querySelector<HTMLElement>('[data-role="playpause"]')!, connectedOnly)
}

function applyContentButtonAffordance(pill: HTMLElement, session: CastSession): void {
  const connectedOnly = isConnectedOnlySession(session)
  const contentBtn = pill.querySelector<HTMLButtonElement>('[data-role="content"]')!
  const canOpenContent = !connectedOnly && !!session.contentHref
  contentBtn.disabled = !canOpenContent
  contentBtn.classList.toggle("cursor-default", !canOpenContent)
  if (canOpenContent) {
    const label = t("cast.pill.openRemote")
    contentBtn.setAttribute("aria-label", label)
    contentBtn.title = label
  } else {
    contentBtn.removeAttribute("aria-label")
    contentBtn.removeAttribute("title")
  }
}

function applySessionToPill(pill: HTMLElement, session: CastSession): void {
  const connectedOnly = isConnectedOnlySession(session)
  pill.setAttribute("aria-label", t("settings.playOnTv.castingTo", { device: session.deviceName }))
  const deviceNameEl = pill.querySelector<HTMLElement>('[data-role="device-name"]')!
  deviceNameEl.textContent = session.deviceName
  deviceNameEl.title = session.deviceName
  const titleEl = pill.querySelector<HTMLElement>('[data-role="title"]')!
  const displayTitle = connectedOnly ? t("cast.pill.connectedPrompt") : session.title
  titleEl.textContent = displayTitle
  titleEl.title = displayTitle
  const titleChanged = lastAppliedTitle !== null && session.title !== lastAppliedTitle
  lastAppliedTitle = session.title
  if (titleChanged) announceStatus(pill, displayTitle)
  setRoleHidden(pill.querySelector<HTMLElement>('[data-role="live"]')!, connectedOnly || !session.isLive)
  setRoleHidden(pill.querySelector<HTMLElement>('[data-role="time"]')!, connectedOnly || session.isLive)

  // A same-title patch must not re-run the transport/content visuals while collapsed.
  if (titleChanged) expandPill(pill, session)
  if (!pillCollapsed) {
    applyTransportVisibility(pill, session)
    applyContentButtonAffordance(pill, session)
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

/** Short single clock for the collapsed chip: elapsed for live, position for VOD. */
function chipClockText(session: CastSession): string | null {
  if (isConnectedOnlySession(session)) return null
  if (session.isLive) return session.startedAtMs == null ? null : formatElapsedSinceStart(session.startedAtMs, Date.now())
  return formatClock(lastKnownPositionSeconds)
}

function renderChipClock(pill: HTMLElement): void {
  const chipClock = pill.querySelector<HTMLElement>('[data-role="chip-clock"]')!
  const session = getCastSession()
  const text = pillCollapsed && session ? chipClockText(session) : null
  chipClock.textContent = text ?? ""
  chipClock.classList.toggle("hidden", text == null)
}

function updateTime(pill: HTMLElement, positionSeconds: number, durationSeconds?: number): void {
  const timeEl = pill.querySelector<HTMLElement>('[data-role="time"]')!
  timeEl.textContent =
    durationSeconds != null
      ? `${formatClock(positionSeconds)} / ${formatClock(durationSeconds)}`
      : formatClock(positionSeconds)
  renderChipClock(pill)
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

function isPillPlaybackPlaying(pill: HTMLElement): boolean {
  return pill.querySelector<HTMLElement>('[data-role="playpause"]')?.dataset.paused !== "true"
}

function stopLiveElapsedTicker(): void {
  if (liveElapsedTicker != null) {
    clearInterval(liveElapsedTicker)
    liveElapsedTicker = null
  }
}

function renderLiveElapsed(pill: HTMLElement, session: CastSession): void {
  const liveElapsedEl = pill.querySelector<HTMLElement>('[data-role="live-elapsed"]')!
  if (isConnectedOnlySession(session) || !session.isLive || session.startedAtMs == null) {
    setRoleHidden(liveElapsedEl, true)
    renderChipClock(pill)
    return
  }
  liveElapsedEl.textContent = formatElapsedSinceStart(session.startedAtMs, Date.now())
  setRoleHidden(liveElapsedEl, false)
  renderChipClock(pill)
}

/** Ticks the live elapsed clock only while playing; a paused/buffering/reconnecting state freezes it. */
function updateLiveElapsedTicking(pill: HTMLElement, session: CastSession, playing: boolean): void {
  renderLiveElapsed(pill, session)
  const shouldTick = playing && session.isLive && !isConnectedOnlySession(session) && session.startedAtMs != null
  if (!shouldTick) {
    stopLiveElapsedTicker()
    return
  }
  if (liveElapsedTicker != null) return
  liveElapsedTicker = setInterval(() => {
    const currentSession = getCastSession()
    if (!pillEl || !currentSession) {
      stopLiveElapsedTicker()
      return
    }
    renderLiveElapsed(pillEl, currentSession)
  }, 1000)
}

function resetRetryButton(pill: HTMLElement): void {
  const retryBtn = pill.querySelector<HTMLButtonElement>('[data-role="retry"]')!
  retryBtn.disabled = false
  retryBtn.classList.remove("opacity-60")
}

function renderStatus(pill: HTMLElement, session: CastSession, status: PillStatus): void {
  if (pill.dataset.status === status) return
  pill.dataset.status = status

  const connectedOnly = isConnectedOnlySession(session)
  const iconEl = pill.querySelector<HTMLElement>('[data-role="icon"]')!
  const titleEl = pill.querySelector<HTMLElement>('[data-role="title"]')!
  const retryBtn = pill.querySelector<HTMLButtonElement>('[data-role="retry"]')!
  const transportButtons = [
    pill.querySelector<HTMLButtonElement>('[data-role="back30"]')!,
    pill.querySelector<HTMLButtonElement>('[data-role="playpause"]')!,
    pill.querySelector<HTMLButtonElement>('[data-role="forward30"]')!,
  ]

  if (status === "reconnecting") {
    titleEl.textContent = t("cast.pill.reconnecting")
    titleEl.title = t("cast.pill.reconnecting")
    for (const button of transportButtons) {
      button.disabled = true
      button.classList.add("opacity-60")
    }
    setRoleHidden(retryBtn, true)
    lastAnnouncedPlaybackState = null
    announceStatus(pill, t("cast.pill.reconnecting"))
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
    titleEl.title = t("cast.pill.error")
    for (const button of transportButtons) setRoleHidden(button, true)
    resetRetryButton(pill)
    setRoleHidden(retryBtn, false)
    lastAnnouncedPlaybackState = null
    announceStatus(pill, titleEl.textContent)
    return
  }
  iconEl.classList.remove("text-bad")
  iconEl.classList.add("text-fg-3")
  setRoleHidden(retryBtn, true)
  applyTransportVisibility(pill, session)
  const displayTitle = connectedOnly ? t("cast.pill.connectedPrompt") : session.title
  titleEl.textContent = displayTitle
  titleEl.title = displayTitle
}

function prefersHardCutMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ||
    document.documentElement.dataset.perfMode === "on"
  )
}

/** Steady playback is the only state the idle-collapse chip is allowed to trigger from. */
function isSteadyPlaybackNow(pill: HTMLElement, session: CastSession): boolean {
  if (isConnectedOnlySession(session)) return false
  if (pill.dataset.status !== "ok") return false
  const playPauseButton = pill.querySelector<HTMLElement>('[data-role="playpause"]')
  return playPauseButton?.dataset.paused !== "true"
}

function setPillCollapsed(pill: HTMLElement, isCollapsed: boolean, session: CastSession): void {
  pillCollapsed = isCollapsed
  pill.dataset.collapsed = isCollapsed ? "true" : "false"
  const contentBtn = pill.querySelector<HTMLButtonElement>('[data-role="content"]')!
  const textCol = pill.querySelector<HTMLElement>('[data-role="text-col"]')!

  if (isCollapsed) {
    for (const role of COLLAPSE_HIDDEN_ROLES) {
      const roleEl = pill.querySelector<HTMLElement>(`[data-role="${role}"]`)
      if (roleEl && !roleEl.classList.contains("hidden")) roleEl.classList.add("hidden", COLLAPSE_MARK_CLASS)
    }
  } else {
    for (const role of COLLAPSE_HIDDEN_ROLES) {
      const roleEl = pill.querySelector<HTMLElement>(`[data-role="${role}"]`)
      if (roleEl?.classList.contains(COLLAPSE_MARK_CLASS)) roleEl.classList.remove("hidden", COLLAPSE_MARK_CLASS)
    }
  }

  contentBtn.classList.toggle("rounded-e-full", isCollapsed)
  contentBtn.classList.toggle("pe-3", isCollapsed)
  contentBtn.classList.toggle("gap-0", isCollapsed)
  contentBtn.classList.toggle("gap-2.5", !isCollapsed)
  textCol.style.transitionDuration = prefersHardCutMotion() ? "0s" : ""
  textCol.classList.toggle("max-w-0", isCollapsed)
  textCol.classList.toggle("max-w-none", !isCollapsed)
  textCol.classList.toggle("opacity-0", isCollapsed)
  renderChipClock(pill)

  if (isCollapsed) {
    contentBtn.disabled = false
    contentBtn.classList.remove("cursor-default")
    contentBtn.setAttribute("aria-label", t("cast.pill.expand"))
    contentBtn.title = t("cast.pill.expand")
  } else {
    applyContentButtonAffordance(pill, session)
  }
}

function clearIdleCollapseTimeout(): void {
  if (idleCollapseTimeout != null) {
    clearTimeout(idleCollapseTimeout)
    idleCollapseTimeout = null
  }
}

function tryIdleCollapse(pill: HTMLElement): void {
  idleCollapseTimeout = null
  if (pillCollapsed || stopArmed || retryInFlight) return
  const session = getCastSession()
  if (!session || !pillEl) return
  if (Date.now() - lastPillInteractionAt < POST_INTERACTION_GRACE_MS) return
  if (!isSteadyPlaybackNow(pill, session)) return
  setPillCollapsed(pill, true, session)
}

function scheduleIdleCollapse(pill: HTMLElement): void {
  clearIdleCollapseTimeout()
  idleCollapseTimeout = setTimeout(() => tryIdleCollapse(pill), IDLE_COLLAPSE_MS)
}

/** Called after state renders (feed ticks, session updates): never resets a timer already counting down. */
function refreshIdleCollapseState(pill: HTMLElement, session: CastSession): void {
  const steady = isSteadyPlaybackNow(pill, session)
  if (pillCollapsed) {
    if (!steady) expandPill(pill, session)
    return
  }
  if (!steady || stopArmed || retryInFlight) {
    clearIdleCollapseTimeout()
    return
  }
  if (idleCollapseTimeout == null) scheduleIdleCollapse(pill)
}

/** Called after real user interaction: always pushes the countdown back out to a fresh 45s. */
function restartIdleCollapseCountdown(pill: HTMLElement, session: CastSession): void {
  lastPillInteractionAt = Date.now()
  if (isSteadyPlaybackNow(pill, session) && !stopArmed && !retryInFlight) {
    scheduleIdleCollapse(pill)
  } else {
    clearIdleCollapseTimeout()
  }
}

function expandPill(pill: HTMLElement, session: CastSession): void {
  if (!pillCollapsed) return
  lastExpandFromCollapsedAtMs = Date.now()
  setPillCollapsed(pill, false, session)
  refreshIdleCollapseState(pill, session)
}

function onPillHoverOrFocus(): void {
  if (!pillEl) return
  const session = getCastSession()
  if (!session) return
  if (pillCollapsed) {
    expandPill(pillEl, session)
    return
  }
  restartIdleCollapseCountdown(pillEl, session)
}

function refreshReceiverLogSnapshotIfStale(session: CastSession, device: TvDevice): void {
  if (logSnapshotInFlight) return
  const nowMs = Date.now()
  if (nowMs - lastLogSnapshotAttemptAtMs < LOG_SNAPSHOT_INTERVAL_MS) return
  const snapshotAt = getReceiverLogSnapshotAt(session.deviceName)
  if (snapshotAt != null && nowMs - snapshotAt < LOG_SNAPSHOT_INTERVAL_MS) return
  lastLogSnapshotAttemptAtMs = nowMs
  logSnapshotInFlight = true
  void fetchReceiverLogs(device)
    .then((text) => {
      if (text) cacheReceiverLogSnapshot(session.deviceName, text)
    })
    .finally(() => {
      logSnapshotInFlight = false
    })
}

function performDeferredIdleTeardown(): void {
  if (!idleDeferredDuringAdvance) return
  idleDeferredDuringAdvance = false
  const session = getCastSession()
  if (session && !session.connectedOnly) {
    unmount()
    clearCastSession()
  }
}

/** Casts the next episode when a series session runs out; no-op (and no auto-retry) with no next episode. */
async function triggerAutoAdvance(session: CastSession): Promise<void> {
  autoAdvanceInFlight = true
  idleDeferredDuringAdvance = false
  try {
    const availability = await resolveNeighborAvailability(session)
    if (!availability.next) return
    const advanced = await castNeighbor(1)
    if (!advanced) return
    idleDeferredDuringAdvance = false
    pokeCastStateFeed()
  } catch (err) {
    log.warn("[xt:tv-cast-pill] auto-advance failed:", err)
  } finally {
    autoAdvanceInFlight = false
    performDeferredIdleTeardown()
  }
}

function onFeedState(state: CastState): void {
  const session = getCastSession()
  if (!session || !pillEl) return
  castProgressRecorder.observe(session, state)
  const device = sessionAsDevice(session)
  refreshReceiverLogSnapshotIfStale(session, device)
  if (state.durationSeconds != null) lastKnownDurationSeconds = state.durationSeconds
  if (autoAdvanceTracker.observe(session, state.state)) void triggerAutoAdvance(session)
  const loadingStalled = castLoadingStallGuard.observe({
    stateValue: state.state,
    playRequestedAtMs: session.startedAtMs ?? session.startedAt,
    nowMs: Date.now(),
  })
  if (loadingStalled) {
    log.warn("[xt:tv-cast-pill] cast never surfaced past loading on", session.deviceName)
    renderStatus(pillEl, session, "error")
    toast({ title: t("cast.toast.wakeFailed", { device: session.deviceName }), variant: "error" })
    void fetchReceiverLogs(device).then((text) => {
      if (text) cacheReceiverLogSnapshot(session.deviceName, text)
    })
    return
  }
  const idleTeardownAllowed = idleTeardownGuard.allowsTeardown({
    stateValue: state.state,
    sessionStartedAtMs: session.startedAtMs ?? session.startedAt,
    nowMs: Date.now(),
    playPending: isCastPlaySettling(),
  })
  if (state.state === "idle") {
    if (autoAdvanceInFlight) {
      idleDeferredDuringAdvance = true
      return
    }
    if (!idleTeardownAllowed) return
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
        title:
          state.error === "app-not-foreground"
            ? t("cast.toast.wakeFailed", { device: session.deviceName })
            : t("cast.toast.playbackError", { device: session.deviceName, error: state.error || t("receiver.error.title") }),
        variant: "error",
      })
      void fetchReceiverLogs(device).then((text) => {
        if (text) cacheReceiverLogSnapshot(session.deviceName, text)
      })
    }
  } else {
    errorToastShown = false
    renderStatus(pillEl, session, "ok")
    const paused = state.state === "paused"
    setPlayPauseIcon(pillEl, paused)
    if (state.state !== lastAnnouncedPlaybackState) {
      lastAnnouncedPlaybackState = state.state
      announceStatus(pillEl, paused ? t("cast.remote.statePaused") : t("cast.remote.statePlaying"))
    }
  }
  updateLiveElapsedTicking(pillEl, session, state.state === "playing")
  refreshIdleCollapseState(pillEl, session)
  if (!isConnectedOnlySession(session)) {
    const availability = neighborAvailability(session)
    updateCastMediaNotification({
      title: session.title,
      deviceName: session.deviceName,
      isPlaying: state.state === "playing",
      isLive: session.isLive,
      hasNext: availability.next,
      hasPrev: availability.previous,
      artworkUrl: session.logo,
    })
  }
  if (Date.now() < suppressPollPositionUntil) return
  lastKnownPositionSeconds = state.positionSeconds
  if (!session.isLive) {
    updateTime(pillEl, state.positionSeconds, state.durationSeconds)
    updateProgressBar(pillEl, state.positionSeconds, state.durationSeconds ?? null)
  }
}

function onFeedLost(): void {
  unmount()
  clearCastSession()
}

function onFeedHealth(health: CastFeedHealth): void {
  const session = getCastSession()
  if (!session || !pillEl) return
  renderStatus(pillEl, session, health.consecutiveMisses > 0 ? "reconnecting" : "ok")
  refreshIdleCollapseState(pillEl, session)
}

function startFeed(): void {
  stopFeed()
  feedUnsubscribe = subscribeCastStateFeed(onFeedState, {
    cadenceMs: FEED_CADENCE_MS,
    onLost: onFeedLost,
    onHealth: onFeedHealth,
  })
}

function stopFeed(): void {
  feedUnsubscribe?.()
  feedUnsubscribe = null
}

async function openRemoteOrNavigate(session: CastSession): Promise<void> {
  try {
    const { openCastRemote } = await import("@/scripts/lib/tv-cast-remote")
    openCastRemote()
  } catch {
    if (session.contentHref) window.location.assign(session.contentHref)
  }
}

async function handleRetryClick(session: CastSession, device: TvDevice): Promise<void> {
  const retryBtn = pillEl?.querySelector<HTMLButtonElement>('[data-role="retry"]')
  if (!retryBtn || retryBtn.disabled) return
  retryBtn.disabled = true
  retryBtn.classList.add("opacity-60")
  retryInFlight = true
  clearIdleCollapseTimeout()
  const retried = await castRetryLast(device)
  retryInFlight = false
  if (!retried) {
    retryBtn.disabled = false
    retryBtn.classList.remove("opacity-60")
    toast({ title: t("cast.toast.failed", { device: device.name }) })
  }
  if (pillEl) refreshIdleCollapseState(pillEl, session)
}

function onPillClick(event: Event): void {
  const target = event.target as HTMLElement | null
  if (!target || !pillEl) return
  const session = getCastSession()
  if (!session) return

  if (pillCollapsed) {
    // Tapping the collapsed chip must only expand it, never fall through to an inner control's action.
    expandPill(pillEl, session)
    return
  }
  if (Date.now() - lastExpandFromCollapsedAtMs < EXPAND_CLICK_SUPPRESS_MS) {
    // This click's own focusin/pointerenter already expanded the chip; don't let it fall through.
    restartIdleCollapseCountdown(pillEl, session)
    return
  }
  restartIdleCollapseCountdown(pillEl, session)

  const device = sessionAsDevice(session)

  if (stopArmed && !target.closest('[data-role="stop"]')) disarmStopButton(pillEl)

  if (target.closest('[data-role="content"]')) {
    void openRemoteOrNavigate(session)
    return
  }
  if (target.closest('[data-role="dismiss"]')) {
    toast({ title: t("cast.toast.stillCasting"), duration: 3200 })
    updateCastSession({ dismissed: true })
    unmount()
    return
  }
  if (target.closest('[data-role="retry"]')) {
    void handleRetryClick(session, device)
    return
  }
  if (target.closest('[data-role="stop"]')) {
    if (!stopArmed) {
      armStopButton(pillEl)
      return
    }
    disarmStopButton(pillEl)
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

function onPillKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && pillEl && stopArmed) disarmStopButton(pillEl)
}

function mount(session: CastSession): void {
  if (pillEl) unmount(false)
  errorToastShown = false
  suppressPollPositionUntil = 0
  lastKnownDurationSeconds = null
  lastAnnouncedPlaybackState = null
  lastAppliedTitle = null
  stopArmed = false
  pillCollapsed = false
  retryInFlight = false
  lastPillInteractionAt = Date.now()
  lastExpandFromCollapsedAtMs = 0
  autoAdvanceTracker = createAutoAdvanceTracker()
  autoAdvanceInFlight = false
  idleDeferredDuringAdvance = false
  castLoadingStallGuard = createCastLoadingStallGuard()
  clearStopArmTimeout()
  clearIdleCollapseTimeout()
  const pill = buildPill()
  pill.classList.add("translate-y-2", "opacity-0")
  applySessionToPill(pill, session)
  setPlayPauseIcon(pill, false)
  updateLiveElapsedTicking(pill, session, true)
  pill.addEventListener("click", onPillClick)
  pill.addEventListener("keydown", onPillKeydown)
  pill.addEventListener("pointerenter", onPillHoverOrFocus)
  pill.addEventListener("focusin", onPillHoverOrFocus)
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
  startFeed()
  refreshIdleCollapseState(pill, session)
  if (!isConnectedOnlySession(session)) {
    const availability = neighborAvailability(session)
    updateCastMediaNotification({
      title: session.title,
      deviceName: session.deviceName,
      isPlaying: true,
      isLive: session.isLive,
      hasNext: availability.next,
      hasPrev: availability.previous,
      artworkUrl: session.logo,
    })
  }
}

function unmount(animate = true): void {
  if (!pillEl) return
  castProgressRecorder.flush()
  clearCastMediaNotification()
  const pill = pillEl
  pill.removeEventListener("click", onPillClick)
  pill.removeEventListener("keydown", onPillKeydown)
  pill.removeEventListener("pointerenter", onPillHoverOrFocus)
  pill.removeEventListener("focusin", onPillHoverOrFocus)
  window.removeEventListener("resize", onWindowResize)
  morePanelObserver?.disconnect()
  morePanelObserver = null
  clearStopArmTimeout()
  clearIdleCollapseTimeout()
  stopArmed = false
  pillCollapsed = false
  retryInFlight = false
  stopFeed()
  stopLiveElapsedTicker()
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
      updateLiveElapsedTicking(pillEl, session, isPillPlaybackPlaying(pillEl))
      refreshIdleCollapseState(pillEl, session)
    } else {
      mount(session)
    }
  } else {
    unmount()
  }
}

const REATTACH_GUARD_KEY = "xt_cast_reattach_done"
// Fallback for the transient case when the network comes back without ever firing a browser "offline" event
// (e.g. Wi-Fi re-associating on wake) - xt:reconnected is the primary trigger.
const REATTACH_RETRY_DELAY_MS = 4000
const REATTACH_MAX_ATTEMPTS = 3

let reattachAttempts = 0
let reattachInFlight = false
let reattachRetryTimeout: ReturnType<typeof setTimeout> | null = null

function hasAttemptedReattachThisSession(): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(REATTACH_GUARD_KEY) === "1"
  } catch {
    return false
  }
}

function markReattachAttempted(): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(REATTACH_GUARD_KEY, "1")
  } catch {}
}

function clearReattachRetryTimeout(): void {
  if (reattachRetryTimeout != null) {
    clearTimeout(reattachRetryTimeout)
    reattachRetryTimeout = null
  }
}

function scheduleReattachRetry(): void {
  clearReattachRetryTimeout()
  reattachRetryTimeout = setTimeout(() => {
    reattachRetryTimeout = null
    attemptSessionReattach()
  }, REATTACH_RETRY_DELAY_MS)
}

/**
 * The guard is only set once an attempt is conclusive (a session was restored, or the backup was discarded
 * for good). A merely unreachable receiver leaves the backup in place, so retry on xt:reconnected plus a
 * delayed fallback instead of giving up for the rest of the session - bounded by REATTACH_MAX_ATTEMPTS.
 */
function attemptSessionReattach(): void {
  if (reattachInFlight || hasAttemptedReattachThisSession() || getCastSession()) return
  reattachInFlight = true
  reattachAttempts += 1
  void tryReattachCastSession().then((session) => {
    reattachInFlight = false
    if (session) {
      markReattachAttempted()
      if (!session.dismissed && !pillEl) mount(session)
      return
    }
    if (!hasReattachableCastBackup() || reattachAttempts >= REATTACH_MAX_ATTEMPTS) {
      markReattachAttempted()
      return
    }
    scheduleReattachRetry()
  })
}

function onReconnectedRetryReattach(): void {
  clearReattachRetryTimeout()
  attemptSessionReattach()
}

export function initTvCastPill(): void {
  if (initialized) return
  initialized = true

  initCastMediaNotificationActions()
  document.addEventListener(CAST_SESSION_EVENT, onSessionChanged)
  document.addEventListener(LOCALE_EVENT, onLocaleChange)
  document.addEventListener(RECONNECT_EVENT, onReconnectedRetryReattach)

  const session = getCastSession()
  if (session && !session.dismissed) {
    mount(session)
  } else if (!hasAttemptedReattachThisSession()) {
    attemptSessionReattach()
  }
}
