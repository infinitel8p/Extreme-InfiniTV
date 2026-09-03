// HTML control bar for mpv-embedded: mpv draws no chrome of its own. Desktop only, mounted by mpv-embedded.ts.

import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml, formatPaddedHms } from "@/scripts/lib/format.js"
import { mpvTrackChoiceAvailable } from "@/scripts/lib/mpv-tracks.js"
import { log } from "@/scripts/lib/log.js"
import {
  ICON_PLAYER_PLAY,
  ICON_PLAYER_PAUSE,
  ICON_VOLUME,
  ICON_VOLUME_OFF,
  ICON_BADGE_CC,
  ICON_LANGUAGE,
  ICON_MAXIMIZE,
  ICON_MINIMIZE,
} from "@/scripts/lib/icons.js"
import type { VjsLikeHandle } from "@/scripts/lib/player-runtime.js"

// Local icons: this file doesn't own icons.ts, so PiP/camera/gear are kept here (same Tabler outline style).
const wrapIcon = (paths: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  paths +
  "</svg>"

const ICON_PIP = wrapIcon(
  '<path d="M11 19h-6a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v4" />' +
    '<path d="M14 15a1 1 0 0 1 1 -1h5a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1l0 -3" />'
)

const ICON_PIP_EXIT = wrapIcon(
  '<path d="M11 19h-6a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v4" />' +
    '<path d="M14 15a1 1 0 0 1 1 -1h5a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1l0 -3" />' +
    '<path d="M7 9l4 4" />' +
    '<path d="M7 12v-3h3" />'
)

const ICON_CAMERA = wrapIcon(
  '<path d="M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2" />' +
    '<path d="M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />'
)

const ICON_SETTINGS = wrapIcon(
  '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065" />' +
    '<path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />'
)

const DEFAULT_AUTO_HIDE_MS = 3000
const SINGLE_CLICK_DELAY_MS = 250
const SCREENSHOT_FEEDBACK_MS = 250

export function seekFraction(currentTimeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  if (!Number.isFinite(currentTimeSeconds)) return 0
  return Math.min(1, Math.max(0, currentTimeSeconds / durationSeconds))
}

export function seekTargetFromFraction(fraction: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  return Math.min(1, Math.max(0, fraction)) * durationSeconds
}

/** `isLiveHint` is the isLive a load was started with; undefined falls back to duration. */
export function isSeekableContent(isLiveHint: boolean | undefined, durationSeconds: number): boolean {
  if (isLiveHint === true) return false
  if (isLiveHint === false) return true
  return Number.isFinite(durationSeconds) && durationSeconds > 0
}

/** Formatted clock time for a seek-bar hover tooltip at a given fraction of the timeline. */
export function seekTooltipTime(fraction: number, durationSeconds: number): string {
  return formatPaddedHms(seekTargetFromFraction(fraction, durationSeconds))
}

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export function formatPlaybackRate(rate: number): string {
  return `${rate}x`
}

export interface AutoHideState {
  visible: boolean
  focused: boolean
  paused: boolean
}

export type AutoHideEvent = "activity" | "focus" | "blur" | "play" | "pause" | "timeout" | "toggle"

export function nextAutoHideState(state: AutoHideState, event: AutoHideEvent): AutoHideState {
  switch (event) {
    case "activity":
      return { ...state, visible: true }
    case "focus":
      return { ...state, visible: true, focused: true }
    case "blur":
      return { ...state, focused: false }
    case "play":
      return { ...state, paused: false }
    case "pause":
      return { ...state, visible: true, paused: true }
    case "timeout":
      return state.paused || state.focused ? state : { ...state, visible: false }
    case "toggle":
      return { ...state, visible: !state.visible }
  }
}

export type MpvHotkeyAction =
  | "toggle-play"
  | "seek-back"
  | "seek-forward"
  | "volume-up"
  | "volume-down"
  | "toggle-fullscreen"
  | "toggle-mute"
  | "toggle-pip"
  | "screenshot"

export interface MpvHotkeyInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isSeekable: boolean
}

/** Pure keymap for in-player hotkeys; ArrowLeft/Right only resolve when the content is seekable (VOD). */
export function mpvHotkeyAction(input: MpvHotkeyInput): MpvHotkeyAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null
  const key = input.key
  if (key === " " || key === "Spacebar") return "toggle-play"
  if (key === "ArrowLeft") return input.isSeekable ? "seek-back" : null
  if (key === "ArrowRight") return input.isSeekable ? "seek-forward" : null
  if (key === "ArrowUp") return "volume-up"
  if (key === "ArrowDown") return "volume-down"
  const lower = key.toLowerCase()
  if (lower === "f") return "toggle-fullscreen"
  if (lower === "m") return "toggle-mute"
  if (lower === "p") return "toggle-pip"
  if (lower === "s") return "screenshot"
  return null
}

/** VjsLikeHandle plus a still-speculative flag a backend may set; feature-detected like everything else here. */
export interface MpvControlsHandle extends VjsLikeHandle {
  userActiveFlag?: boolean
}

export interface MpvControlsOptions {
  onAudioTracksClick?: () => void
  onSubtitleTracksClick?: () => void
  autoHideMs?: number
  getTrackList?: () => unknown
}

function markup(): string {
  const speedOptionsHtml = PLAYBACK_RATES.map((rate) => {
    const label = formatPlaybackRate(rate)
    return `<button type="button" class="mpv-controls__popover-option" role="radio" aria-checked="false"
      data-role="speed-btn" data-rate="${rate}"
      aria-label="${escapeHtml(t("player.controls.speedOption", { value: label }))}">${label}</button>`
  }).join("")

  return `
    <div class="mpv-controls__buffer-bar" data-role="buffer-bar" role="status"
      aria-label="${escapeHtml(t("stream.buffering"))}" hidden></div>
    <div class="mpv-controls__error-row" data-role="error-row" role="alert" hidden>
      <span data-role="error-text"></span>
      <button type="button" data-role="error-retry"></button>
    </div>
    <div class="mpv-controls__slider flex-1" data-role="seek-wrap" hidden>
      <div class="mpv-controls__track"></div>
      <div class="mpv-controls__fill mpv-controls__fill--buffered" data-role="seek-buffered"></div>
      <div class="mpv-controls__fill" data-role="seek-fill"></div>
      <input type="range" class="mpv-controls__range" data-role="seek-input" min="0" max="1000" step="1" value="0"
        aria-label="${escapeHtml(t("player.controls.seek"))}" />
      <div class="mpv-controls__seek-tooltip" data-role="seek-tooltip" hidden></div>
    </div>
    <div class="flex items-center gap-1">
      <button type="button" class="mpv-controls__btn text-xl" data-role="play-pause"></button>
      <span class="inline-flex items-center gap-1 px-1 text-xs font-medium tabular-nums text-white/85" data-role="time" hidden>
        <span data-role="elapsed">0:00</span><span aria-hidden="true">/</span><span data-role="duration">0:00</span>
      </span>
      <span class="inline-flex items-center gap-1.5 px-1 text-xs font-semibold tracking-wide text-white/90" data-role="live-badge" hidden>
        <span class="size-1.5 rounded-full bg-accent" aria-hidden="true"></span>${escapeHtml(t("player.controls.live"))}
      </span>
      <span class="grow"></span>
      <button type="button" class="mpv-controls__btn text-lg" data-role="subtitles"
        aria-label="${escapeHtml(t("player.subtitles"))}" title="${escapeHtml(t("player.subtitles"))}" hidden>${ICON_BADGE_CC}</button>
      <button type="button" class="mpv-controls__btn text-lg" data-role="audio"
        aria-label="${escapeHtml(t("player.audio"))}" title="${escapeHtml(t("player.audio"))}" hidden>${ICON_LANGUAGE}</button>
      <div class="relative" data-role="settings-wrap">
        <button type="button" class="mpv-controls__btn text-lg" data-role="settings" aria-haspopup="true" aria-expanded="false"
          aria-label="${escapeHtml(t("player.controls.settings"))}" title="${escapeHtml(t("player.controls.settings"))}">${ICON_SETTINGS}</button>
        <div class="mpv-controls__popover" data-role="settings-popover" role="menu"
          aria-label="${escapeHtml(t("player.controls.settings"))}" hidden>
          <div data-role="speed-section">
            <div class="mpv-controls__popover-title" data-role="speed-title">${escapeHtml(t("player.controls.speed"))}</div>
            <div class="mpv-controls__popover-options" data-role="speed-options" role="radiogroup"
              aria-label="${escapeHtml(t("player.controls.speed"))}">${speedOptionsHtml}</div>
          </div>
          <div data-role="subtitle-delay-section" hidden>
            <div class="mpv-controls__popover-title" data-role="subdelay-title">${escapeHtml(t("player.controls.subtitleDelay"))}</div>
            <div class="mpv-controls__popover-row">
              <button type="button" class="mpv-controls__btn" data-role="subdelay-minus"
                aria-label="${escapeHtml(t("player.controls.subtitleDelayEarlier"))}" title="${escapeHtml(t("player.controls.subtitleDelayEarlier"))}">-</button>
              <span data-role="subdelay-value">+0.0s</span>
              <button type="button" class="mpv-controls__btn" data-role="subdelay-plus"
                aria-label="${escapeHtml(t("player.controls.subtitleDelayLater"))}" title="${escapeHtml(t("player.controls.subtitleDelayLater"))}">+</button>
            </div>
          </div>
        </div>
      </div>
      <button type="button" class="mpv-controls__btn text-lg" data-role="screenshot"
        aria-label="${escapeHtml(t("player.controls.screenshot"))}" title="${escapeHtml(t("player.controls.screenshot"))}">${ICON_CAMERA}</button>
      <button type="button" class="mpv-controls__btn text-lg" data-role="pip" aria-pressed="false"
        aria-label="${escapeHtml(t("player.controls.pip"))}" title="${escapeHtml(t("player.controls.pip"))}"></button>
      <button type="button" class="mpv-controls__btn text-xl" data-role="mute"></button>
      <div class="mpv-controls__slider w-16 sm:w-20" data-role="volume-wrap">
        <div class="mpv-controls__track"></div>
        <div class="mpv-controls__fill" data-role="volume-fill"></div>
        <input type="range" class="mpv-controls__range" data-role="volume-input" min="0" max="100" step="1" value="100"
          aria-label="${escapeHtml(t("player.controls.volume"))}" />
      </div>
      <button type="button" class="mpv-controls__btn text-xl" data-role="fullscreen"></button>
    </div>
  `
}

function isHotkeyIgnoredTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return true
  if (typeof element.closest === "function" && element.closest("dialog[open]")) return true
  return false
}

function formatSubDelay(offsetSeconds: number): string {
  return `${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds.toFixed(1)}s`
}

/** Mounts the control bar into `container` (the player wrap, already `position: relative`). */
export function mountMpvControls(
  container: HTMLElement,
  handle: MpvControlsHandle,
  options: MpvControlsOptions = {},
): () => void {
  const bar = document.createElement("div")
  bar.className = "mpv-controls"
  bar.dataset.visible = "true"
  bar.innerHTML = markup()
  container.appendChild(bar)

  const query = <T extends HTMLElement>(role: string) => bar.querySelector<T>(`[data-role="${role}"]`)!
  const bufferBar = query("buffer-bar")
  const errorRow = query("error-row")
  const errorTextEl = query("error-text")
  const errorRetryBtn = query<HTMLButtonElement>("error-retry")
  const playPauseBtn = query<HTMLButtonElement>("play-pause")
  const timeEl = query("time")
  const elapsedEl = query("elapsed")
  const durationEl = query("duration")
  const liveBadge = query("live-badge")
  const seekWrap = query("seek-wrap")
  const seekBuffered = query("seek-buffered")
  const seekFill = query("seek-fill")
  const seekInput = query<HTMLInputElement>("seek-input")
  const seekTooltipEl = query("seek-tooltip")
  const muteBtn = query<HTMLButtonElement>("mute")
  const volumeFill = query("volume-fill")
  const volumeInput = query<HTMLInputElement>("volume-input")
  const fullscreenBtn = query<HTMLButtonElement>("fullscreen")
  const subtitlesBtn = query<HTMLButtonElement>("subtitles")
  const audioBtn = query<HTMLButtonElement>("audio")
  const screenshotBtn = query<HTMLButtonElement>("screenshot")
  const pipBtn = query<HTMLButtonElement>("pip")
  const settingsWrap = query<HTMLElement>("settings-wrap")
  const settingsBtn = query<HTMLButtonElement>("settings")
  const settingsPopover = query<HTMLElement>("settings-popover")
  const speedSection = query<HTMLElement>("speed-section")
  const speedOptionsEl = query<HTMLElement>("speed-options")
  const subtitleDelaySection = query<HTMLElement>("subtitle-delay-section")
  const subDelayValueEl = query("subdelay-value")
  const subDelayMinusBtn = query<HTMLButtonElement>("subdelay-minus")
  const subDelayPlusBtn = query<HTMLButtonElement>("subdelay-plus")

  errorRetryBtn.textContent = t("common.retry")

  if (options.onSubtitleTracksClick) subtitlesBtn.addEventListener("click", options.onSubtitleTracksClick)
  if (options.onAudioTracksClick) audioBtn.addEventListener("click", options.onAudioTracksClick)
  if (!handle.requestFullscreen) fullscreenBtn.hidden = true
  if (typeof handle.screenshot !== "function") screenshotBtn.hidden = true
  if (typeof handle.requestPip !== "function") pipBtn.hidden = true
  const speedAvailable = typeof handle.playbackRate === "function"
  const subtitleDelayCapable = typeof handle.subtitleDelay === "function"
  speedSection.hidden = !speedAvailable
  if (!speedAvailable && !subtitleDelayCapable) settingsBtn.hidden = true

  function updateTrackButtonsUi(): void {
    const trackList = options.getTrackList?.() ?? null
    audioBtn.hidden = !options.onAudioTracksClick || !mpvTrackChoiceAvailable(trackList, "audio")
    subtitlesBtn.hidden = !options.onSubtitleTracksClick || !mpvTrackChoiceAvailable(trackList, "sub")
  }

  const autoHideMs = options.autoHideMs ?? DEFAULT_AUTO_HIDE_MS
  let hideState: AutoHideState = { visible: true, focused: false, paused: handle.paused?.() ?? false }
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let latestIsLive: boolean | undefined
  let seekDragging = false
  let externalActive = false

  function applyHideState(): void {
    const visible = hideState.visible || externalActive
    bar.dataset.visible = String(visible)
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (visible && !hideState.paused && !hideState.focused && !externalActive) {
      hideTimer = setTimeout(() => dispatch("timeout"), autoHideMs)
    }
  }

  function dispatch(event: AutoHideEvent): void {
    hideState = nextAutoHideState(hideState, event)
    applyHideState()
  }

  function setExternalActive(active: boolean): void {
    if (active === externalActive) return
    externalActive = active
    applyHideState()
  }

  function currentIsLiveHint(): boolean | undefined {
    return handle.isLive ? handle.isLive() : latestIsLive
  }

  function updatePlayPauseUi(): void {
    const paused = handle.paused?.() ?? false
    playPauseBtn.innerHTML = paused ? ICON_PLAYER_PLAY : ICON_PLAYER_PAUSE
    const label = t(paused ? "player.controls.play" : "player.controls.pause")
    playPauseBtn.setAttribute("aria-label", label)
    playPauseBtn.title = label
  }

  function updateMuteUi(): void {
    const muted = handle.muted?.() ?? false
    muteBtn.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME
    const label = t(muted ? "player.controls.unmute" : "player.controls.mute")
    muteBtn.setAttribute("aria-label", label)
    muteBtn.title = label
  }

  function updateVolumeUi(): void {
    const muted = handle.muted?.() ?? false
    const volumeValue = (handle.volume?.() as number | undefined) ?? 1
    volumeInput.value = String(Math.round(volumeValue * 100))
    volumeFill.style.width = `${(muted ? 0 : volumeValue) * 100}%`
    updateMuteUi()
  }

  function updateFullscreenUi(): void {
    const fullscreen = handle.isFullscreen?.() ?? false
    fullscreenBtn.innerHTML = fullscreen ? ICON_MINIMIZE : ICON_MAXIMIZE
    const label = t(fullscreen ? "player.controls.fullscreenExit" : "player.controls.fullscreenEnter")
    fullscreenBtn.setAttribute("aria-label", label)
    fullscreenBtn.title = label
  }

  function updatePipUi(): void {
    if (pipBtn.hidden) return
    const active = handle.isPip?.() ?? false
    pipBtn.innerHTML = active ? ICON_PIP_EXIT : ICON_PIP
    pipBtn.setAttribute("aria-pressed", String(active))
    const label = t(active ? "player.controls.pipExit" : "player.controls.pip")
    pipBtn.setAttribute("aria-label", label)
    pipBtn.title = label
  }

  function updateSpeedOptionsUi(): void {
    if (!speedAvailable) return
    const current = (handle.playbackRate?.() as number | undefined) ?? 1
    for (const btn of speedOptionsEl.querySelectorAll<HTMLButtonElement>('[data-role="speed-btn"]')) {
      const rate = Number(btn.dataset.rate)
      const active = Number.isFinite(current) && Math.abs(rate - current) < 0.001
      btn.setAttribute("aria-checked", String(active))
    }
  }

  function updateSubtitleDelayUi(): void {
    if (!subtitleDelayCapable) {
      subtitleDelaySection.hidden = true
      return
    }
    const offset = handle.subtitleDelay?.(0) ?? null
    subtitleDelaySection.hidden = offset == null
    if (offset != null) subDelayValueEl.textContent = formatSubDelay(offset)
  }

  function updatePlaybackUi(): void {
    if (seekDragging) return
    const duration = handle.duration?.() ?? NaN
    const seekable = isSeekableContent(currentIsLiveHint(), duration)
    seekWrap.hidden = !seekable
    timeEl.hidden = !seekable
    liveBadge.hidden = seekable
    if (!seekable) return

    const currentTime = handle.currentTime?.() ?? 0
    elapsedEl.textContent = formatPaddedHms(currentTime)
    durationEl.textContent = formatPaddedHms(duration)

    const playedFraction = seekFraction(currentTime, duration)
    seekInput.value = String(Math.round(playedFraction * 1000))
    seekFill.style.width = `${playedFraction * 100}%`

    const bufferedAhead = handle.engineStats?.()?.bufferedAheadSeconds ?? 0
    seekBuffered.style.width = `${seekFraction(currentTime + Math.max(0, bufferedAhead), duration) * 100}%`
  }

  function showBufferIndicator(): void {
    bufferBar.hidden = false
  }
  function hideBufferIndicator(): void {
    bufferBar.hidden = true
  }

  function showErrorRow(): void {
    const detail = handle.error?.()
    errorTextEl.textContent = typeof detail === "string" && detail ? detail : t("player.controls.errorGeneric")
    errorRow.hidden = false
    hideBufferIndicator()
    dispatch("activity")
  }
  function hideErrorRow(): void {
    errorRow.hidden = true
  }

  errorRetryBtn.addEventListener("click", () => {
    hideErrorRow()
    container.dispatchEvent(new CustomEvent("xt:mpv-retry", { bubbles: true }))
  })

  function togglePlayPause(): void {
    if (handle.paused?.() ?? false) void handle.play()
    else handle.pause()
  }

  function toggleFullscreen(): void {
    if (handle.isFullscreen?.()) handle.exitFullscreen?.()
    else void handle.requestFullscreen?.()
  }

  function toggleMute(): void {
    handle.muted?.(!(handle.muted?.() ?? false))
    updateVolumeUi()
  }

  function togglePip(): void {
    if (pipBtn.hidden) return
    if (handle.isPip?.()) void handle.exitPip?.()
    else void handle.requestPip?.()
    updatePipUi()
  }

  let screenshotFeedbackTimer: ReturnType<typeof setTimeout> | null = null
  async function takeScreenshot(): Promise<void> {
    if (!handle.screenshot) return
    screenshotBtn.disabled = true
    screenshotBtn.classList.add("mpv-controls__btn--pressed")
    if (screenshotFeedbackTimer) clearTimeout(screenshotFeedbackTimer)
    try {
      // Success/failure toast is the handle's own responsibility - avoids a double toast.
      await handle.screenshot()
    } catch (err) {
      log.warn("[xt:mpv-controls] screenshot failed:", err)
    } finally {
      screenshotBtn.disabled = false
      screenshotFeedbackTimer = setTimeout(() => screenshotBtn.classList.remove("mpv-controls__btn--pressed"), SCREENSHOT_FEEDBACK_MS)
    }
  }

  function seekByDelta(deltaSeconds: number): void {
    const duration = handle.duration?.() ?? NaN
    if (!isSeekableContent(currentIsLiveHint(), duration)) return
    const current = handle.currentTime?.() ?? 0
    const ceiling = Number.isFinite(duration) ? duration : current + Math.abs(deltaSeconds)
    handle.currentTime?.(Math.min(Math.max(0, current + deltaSeconds), ceiling))
  }

  function adjustVolume(deltaVolume: number): void {
    const current = (handle.volume?.() as number | undefined) ?? 1
    const next = Math.min(1, Math.max(0, current + deltaVolume))
    handle.volume?.(next)
    if (next > 0 && (handle.muted?.() ?? false)) handle.muted?.(false)
    updateVolumeUi()
  }

  function runHotkeyAction(action: MpvHotkeyAction): void {
    switch (action) {
      case "toggle-play": togglePlayPause(); break
      case "seek-back": seekByDelta(-10); break
      case "seek-forward": seekByDelta(10); break
      case "volume-up": adjustVolume(0.05); break
      case "volume-down": adjustVolume(-0.05); break
      case "toggle-fullscreen": toggleFullscreen(); break
      case "toggle-mute": toggleMute(); break
      case "toggle-pip": togglePip(); break
      case "screenshot": void takeScreenshot(); break
    }
    dispatch("activity")
  }

  function handleHotkeyEvent(event: KeyboardEvent): void {
    if (isHotkeyIgnoredTarget(event.target)) return
    const duration = handle.duration?.() ?? NaN
    const action = mpvHotkeyAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isSeekable: isSeekableContent(currentIsLiveHint(), duration),
    })
    if (!action) return
    event.preventDefault()
    runHotkeyAction(action)
  }

  playPauseBtn.addEventListener("click", togglePlayPause)
  muteBtn.addEventListener("click", toggleMute)
  fullscreenBtn.addEventListener("click", toggleFullscreen)
  pipBtn.addEventListener("click", togglePip)
  screenshotBtn.addEventListener("click", () => void takeScreenshot())
  document.addEventListener("fullscreenchange", updateFullscreenUi)

  volumeInput.addEventListener("input", () => {
    const value = Number(volumeInput.value) / 100
    handle.volume?.(value)
    volumeFill.style.width = `${value * 100}%`
    if (value > 0 && (handle.muted?.() ?? false)) handle.muted?.(false)
    updateMuteUi()
    dispatch("activity")
  })

  seekInput.addEventListener("input", () => {
    seekDragging = true
    const duration = handle.duration?.() ?? NaN
    const previewFraction = Number(seekInput.value) / 1000
    elapsedEl.textContent = formatPaddedHms(seekTargetFromFraction(previewFraction, duration))
    seekFill.style.width = `${previewFraction * 100}%`
    dispatch("activity")
  })
  seekInput.addEventListener("change", () => {
    const duration = handle.duration?.() ?? NaN
    handle.currentTime?.(seekTargetFromFraction(Number(seekInput.value) / 1000, duration))
    seekDragging = false
    updatePlaybackUi()
  })
  // Home/End jump to min/max on a native <input type="range"> without extra code.

  function updateSeekTooltip(event: PointerEvent): void {
    if (event.pointerType && event.pointerType !== "mouse") return
    const rect = seekWrap.getBoundingClientRect()
    const duration = handle.duration?.() ?? NaN
    if (rect.width <= 0 || !isSeekableContent(currentIsLiveHint(), duration)) {
      seekTooltipEl.hidden = true
      return
    }
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    seekTooltipEl.textContent = seekTooltipTime(fraction, duration)
    seekTooltipEl.style.left = `${fraction * 100}%`
    seekTooltipEl.hidden = false
  }
  seekWrap.addEventListener("pointermove", updateSeekTooltip)
  seekWrap.addEventListener("pointerleave", () => { seekTooltipEl.hidden = true })

  // --- Settings popover: playback speed + subtitle delay ---
  function popoverFocusable(): HTMLElement[] {
    return Array.from(settingsPopover.querySelectorAll<HTMLElement>("button")).filter((el) => el.offsetParent !== null)
  }
  function onOutsidePointerDown(event: PointerEvent): void {
    if (settingsWrap.contains(event.target as Node | null)) return
    closeSettingsPopover(false)
  }
  function onPopoverKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault()
      closeSettingsPopover()
      return
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    const focusable = popoverFocusable()
    if (!focusable.length) return
    event.preventDefault()
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
    const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1
    focusable[(currentIndex + delta + focusable.length) % focusable.length]?.focus()
  }
  function openSettingsPopover(): void {
    updateSpeedOptionsUi()
    updateSubtitleDelayUi()
    settingsPopover.hidden = false
    settingsBtn.setAttribute("aria-expanded", "true")
    dispatch("activity")
    document.addEventListener("pointerdown", onOutsidePointerDown, true)
    document.addEventListener("keydown", onPopoverKeydown, true)
    popoverFocusable()[0]?.focus()
  }
  function closeSettingsPopover(returnFocus = true): void {
    if (settingsPopover.hidden) return
    settingsPopover.hidden = true
    settingsBtn.setAttribute("aria-expanded", "false")
    document.removeEventListener("pointerdown", onOutsidePointerDown, true)
    document.removeEventListener("keydown", onPopoverKeydown, true)
    if (returnFocus) settingsBtn.focus()
  }
  settingsBtn.addEventListener("click", () => {
    if (settingsPopover.hidden) openSettingsPopover()
    else closeSettingsPopover()
  })
  speedOptionsEl.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-role="speed-btn"]')
    if (!btn || !handle.playbackRate) return
    const rate = Number(btn.dataset.rate)
    if (!Number.isFinite(rate)) return
    handle.playbackRate?.(rate)
    updateSpeedOptionsUi()
    closeSettingsPopover()
  })
  subDelayMinusBtn.addEventListener("click", () => {
    const next = handle.subtitleDelay?.(-0.1)
    if (next != null) subDelayValueEl.textContent = formatSubDelay(next)
    dispatch("activity")
  })
  subDelayPlusBtn.addEventListener("click", () => {
    const next = handle.subtitleDelay?.(0.1)
    if (next != null) subDelayValueEl.textContent = formatSubDelay(next)
    dispatch("activity")
  })

  function onPlaying(): void {
    updatePlayPauseUi()
    hideBufferIndicator()
    hideErrorRow()
    dispatch("play")
  }
  function onPause(): void {
    updatePlayPauseUi()
    dispatch("pause")
  }
  function onTimeupdate(): void {
    updatePlaybackUi()
    if (typeof handle.userActiveFlag === "boolean" && handle.userActiveFlag !== externalActive) {
      setExternalActive(handle.userActiveFlag)
    }
  }
  function onLoadedMetadata(): void {
    updatePlaybackUi()
    dispatch("activity")
  }
  function onWaiting(): void {
    showBufferIndicator()
  }
  function onSeeking(): void {
    showBufferIndicator()
    updatePlaybackUi()
  }
  function onSeeked(): void {
    hideBufferIndicator()
    updatePlaybackUi()
  }
  function onCanPlay(): void {
    hideBufferIndicator()
    updatePlaybackUi()
  }
  function onDurationChange(): void {
    updatePlaybackUi()
  }
  function onError(): void {
    showErrorRow()
  }
  function onTracksChanged(): void {
    updateTrackButtonsUi()
    updateSubtitleDelayUi()
  }
  function onUserActive(...args: unknown[]): void {
    setExternalActive(args[0] === true)
  }

  handle.on("playing", onPlaying)
  handle.on("play", onPlaying)
  handle.on("pause", onPause)
  handle.on("timeupdate", onTimeupdate)
  handle.on("loadedmetadata", onLoadedMetadata)
  handle.on("waiting", onWaiting)
  handle.on("seeking", onSeeking)
  handle.on("seeked", onSeeked)
  handle.on("canplay", onCanPlay)
  handle.on("durationchange", onDurationChange)
  handle.on("volumechange", updateVolumeUi)
  handle.on("ratechange", updateSpeedOptionsUi)
  handle.on("error", onError)
  handle.on("trackschanged", onTracksChanged)
  handle.on("useractive", onUserActive)

  // Only place the control bar can learn a load's isLive - the handle itself has no getter for it.
  const originalSrc = handle.src.bind(handle)
  handle.src = (opts) => {
    // isLive defaults to true per the src() contract; only an explicit false means seekable.
    latestIsLive = opts.isLive !== false
    seekDragging = false
    hideErrorRow()
    originalSrc(opts)
    updatePlaybackUi()
  }

  let lastPointerType = "mouse"
  function onActivity(): void {
    dispatch("activity")
  }
  function onContainerPointerDown(event: PointerEvent): void {
    lastPointerType = event.pointerType || "mouse"
    if (lastPointerType !== "touch") onActivity()
  }
  container.addEventListener("pointermove", onActivity)
  container.addEventListener("pointerdown", onContainerPointerDown)

  let pointerInsideContainer = false
  function onPointerEnter(): void {
    pointerInsideContainer = true
  }
  function onPointerLeave(): void {
    pointerInsideContainer = false
  }
  container.addEventListener("pointerenter", onPointerEnter)
  container.addEventListener("pointerleave", onPointerLeave)

  // Hover-driven hotkeys only kick in with no other focus target on the page, so they never
  // steal input from a keyboard/D-pad user who deliberately focused something else.
  function onDocumentKeydown(event: KeyboardEvent): void {
    if (!pointerInsideContainer) return
    if (container.contains(document.activeElement)) return
    if (document.activeElement && document.activeElement !== document.body) return
    handleHotkeyEvent(event)
  }
  container.addEventListener("keydown", handleHotkeyEvent)
  document.addEventListener("keydown", onDocumentKeydown)

  let clickTimer: ReturnType<typeof setTimeout> | null = null
  function clearClickTimer(): void {
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
    }
  }
  function onContainerClick(event: MouseEvent): void {
    if (bar.contains(event.target as Node | null)) return
    clearClickTimer()
    clickTimer = setTimeout(() => {
      clickTimer = null
      if (lastPointerType === "touch") dispatch("toggle")
      else togglePlayPause()
    }, SINGLE_CLICK_DELAY_MS)
  }
  function onContainerDblClick(event: MouseEvent): void {
    if (bar.contains(event.target as Node | null)) return
    clearClickTimer()
    toggleFullscreen()
  }
  container.addEventListener("click", onContainerClick)
  container.addEventListener("dblclick", onContainerDblClick)

  bar.addEventListener("focusin", () => dispatch("focus"))
  bar.addEventListener("focusout", (event) => {
    if (!bar.contains(event.relatedTarget as Node | null)) dispatch("blur")
  })

  updatePlayPauseUi()
  updateVolumeUi()
  updateFullscreenUi()
  updatePipUi()
  updatePlaybackUi()
  updateTrackButtonsUi()
  updateSpeedOptionsUi()
  updateSubtitleDelayUi()
  applyHideState()

  return () => {
    clearClickTimer()
    if (screenshotFeedbackTimer) clearTimeout(screenshotFeedbackTimer)
    if (hideTimer) clearTimeout(hideTimer)
    closeSettingsPopover(false)
    handle.off?.("playing", onPlaying)
    handle.off?.("play", onPlaying)
    handle.off?.("pause", onPause)
    handle.off?.("timeupdate", onTimeupdate)
    handle.off?.("loadedmetadata", onLoadedMetadata)
    handle.off?.("waiting", onWaiting)
    handle.off?.("seeking", onSeeking)
    handle.off?.("seeked", onSeeked)
    handle.off?.("canplay", onCanPlay)
    handle.off?.("durationchange", onDurationChange)
    handle.off?.("volumechange", updateVolumeUi)
    handle.off?.("ratechange", updateSpeedOptionsUi)
    handle.off?.("error", onError)
    handle.off?.("trackschanged", onTracksChanged)
    handle.off?.("useractive", onUserActive)
    document.removeEventListener("fullscreenchange", updateFullscreenUi)
    document.removeEventListener("keydown", onDocumentKeydown)
    container.removeEventListener("pointermove", onActivity)
    container.removeEventListener("pointerdown", onContainerPointerDown)
    container.removeEventListener("pointerenter", onPointerEnter)
    container.removeEventListener("pointerleave", onPointerLeave)
    container.removeEventListener("keydown", handleHotkeyEvent)
    container.removeEventListener("click", onContainerClick)
    container.removeEventListener("dblclick", onContainerDblClick)
    bar.remove()
  }
}
