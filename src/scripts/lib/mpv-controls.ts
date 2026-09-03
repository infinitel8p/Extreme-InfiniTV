// HTML control bar for mpv-embedded: mpv draws no chrome of its own. Desktop only, mounted by mpv-embedded.ts.

import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml, formatPaddedHms } from "@/scripts/lib/format.js"
import { mpvTrackChoiceAvailable } from "@/scripts/lib/mpv-tracks.js"
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

const DEFAULT_AUTO_HIDE_MS = 3000

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

export interface AutoHideState {
  visible: boolean
  focused: boolean
  paused: boolean
}

export type AutoHideEvent = "activity" | "focus" | "blur" | "play" | "pause" | "timeout"

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
  }
}

export interface MpvControlsOptions {
  onAudioTracksClick?: () => void
  onSubtitleTracksClick?: () => void
  autoHideMs?: number
  getTrackList?: () => unknown
}

function markup(): string {
  return `
    <div class="mpv-controls__slider flex-1" data-role="seek-wrap" hidden>
      <div class="mpv-controls__track"></div>
      <div class="mpv-controls__fill mpv-controls__fill--buffered" data-role="seek-buffered"></div>
      <div class="mpv-controls__fill" data-role="seek-fill"></div>
      <input type="range" class="mpv-controls__range" data-role="seek-input" min="0" max="1000" step="1" value="0"
        aria-label="${escapeHtml(t("player.controls.seek"))}" />
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
      <button type="button" class="mpv-controls__btn text-lg" data-role="subtitles" aria-label="${escapeHtml(t("player.subtitles"))}" hidden>${ICON_BADGE_CC}</button>
      <button type="button" class="mpv-controls__btn text-lg" data-role="audio" aria-label="${escapeHtml(t("player.audio"))}" hidden>${ICON_LANGUAGE}</button>
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

/** Mounts the control bar into `container` (the player wrap, already `position: relative`). */
export function mountMpvControls(
  container: HTMLElement,
  handle: VjsLikeHandle,
  options: MpvControlsOptions = {},
): () => void {
  const bar = document.createElement("div")
  bar.className = "mpv-controls"
  bar.dataset.visible = "true"
  bar.innerHTML = markup()
  container.appendChild(bar)

  const query = <T extends HTMLElement>(role: string) => bar.querySelector<T>(`[data-role="${role}"]`)!
  const playPauseBtn = query<HTMLButtonElement>("play-pause")
  const timeEl = query("time")
  const elapsedEl = query("elapsed")
  const durationEl = query("duration")
  const liveBadge = query("live-badge")
  const seekWrap = query("seek-wrap")
  const seekBuffered = query("seek-buffered")
  const seekFill = query("seek-fill")
  const seekInput = query<HTMLInputElement>("seek-input")
  const muteBtn = query<HTMLButtonElement>("mute")
  const volumeFill = query("volume-fill")
  const volumeInput = query<HTMLInputElement>("volume-input")
  const fullscreenBtn = query<HTMLButtonElement>("fullscreen")
  const subtitlesBtn = query<HTMLButtonElement>("subtitles")
  const audioBtn = query<HTMLButtonElement>("audio")

  if (options.onSubtitleTracksClick) subtitlesBtn.addEventListener("click", options.onSubtitleTracksClick)
  if (options.onAudioTracksClick) audioBtn.addEventListener("click", options.onAudioTracksClick)
  if (!handle.requestFullscreen) fullscreenBtn.hidden = true

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

  function applyHideState(): void {
    bar.dataset.visible = String(hideState.visible)
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (hideState.visible && !hideState.paused && !hideState.focused) {
      hideTimer = setTimeout(() => dispatch("timeout"), autoHideMs)
    }
  }

  function dispatch(event: AutoHideEvent): void {
    hideState = nextAutoHideState(hideState, event)
    applyHideState()
  }

  function updatePlayPauseUi(): void {
    const paused = handle.paused?.() ?? false
    playPauseBtn.innerHTML = paused ? ICON_PLAYER_PLAY : ICON_PLAYER_PAUSE
    playPauseBtn.setAttribute("aria-label", t(paused ? "player.controls.play" : "player.controls.pause"))
  }

  function updateMuteUi(): void {
    const muted = handle.muted?.() ?? false
    muteBtn.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME
    muteBtn.setAttribute("aria-label", t(muted ? "player.controls.unmute" : "player.controls.mute"))
  }

  function updateFullscreenUi(): void {
    const fullscreen = handle.isFullscreen?.() ?? false
    fullscreenBtn.innerHTML = fullscreen ? ICON_MINIMIZE : ICON_MAXIMIZE
    fullscreenBtn.setAttribute(
      "aria-label",
      t(fullscreen ? "player.controls.fullscreenExit" : "player.controls.fullscreenEnter"),
    )
  }

  function updatePlaybackUi(): void {
    if (seekDragging) return
    const duration = handle.duration?.() ?? NaN
    const seekable = isSeekableContent(latestIsLive, duration)
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

  playPauseBtn.addEventListener("click", () => {
    if (handle.paused?.() ?? false) void handle.play()
    else handle.pause()
  })

  muteBtn.addEventListener("click", () => {
    handle.muted?.(!(handle.muted?.() ?? false))
    updateMuteUi()
  })

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

  fullscreenBtn.addEventListener("click", () => {
    if (handle.isFullscreen?.()) handle.exitFullscreen?.()
    else void handle.requestFullscreen?.()
  })
  document.addEventListener("fullscreenchange", updateFullscreenUi)

  function onPlaying(): void {
    updatePlayPauseUi()
    dispatch("play")
  }
  function onPause(): void {
    updatePlayPauseUi()
    dispatch("pause")
  }
  function onTimeupdate(): void {
    updatePlaybackUi()
  }
  function onLoadedMetadata(): void {
    updatePlaybackUi()
    dispatch("activity")
  }
  handle.on("playing", onPlaying)
  handle.on("pause", onPause)
  handle.on("timeupdate", onTimeupdate)
  handle.on("loadedmetadata", onLoadedMetadata)
  handle.on("trackschanged", updateTrackButtonsUi)

  // Only place the control bar can learn a load's isLive - the handle itself has no getter for it.
  const originalSrc = handle.src.bind(handle)
  handle.src = (opts) => {
    // isLive defaults to true per the src() contract; only an explicit false means seekable.
    latestIsLive = opts.isLive !== false
    seekDragging = false
    originalSrc(opts)
    updatePlaybackUi()
  }

  function onActivity(): void {
    dispatch("activity")
  }
  container.addEventListener("pointermove", onActivity)
  container.addEventListener("pointerdown", onActivity)
  bar.addEventListener("focusin", () => dispatch("focus"))
  bar.addEventListener("focusout", (event) => {
    if (!bar.contains(event.relatedTarget as Node | null)) dispatch("blur")
  })

  updatePlayPauseUi()
  updateMuteUi()
  updateFullscreenUi()
  updatePlaybackUi()
  updateTrackButtonsUi()
  applyHideState()

  return () => {
    if (hideTimer) clearTimeout(hideTimer)
    handle.off?.("playing", onPlaying)
    handle.off?.("pause", onPause)
    handle.off?.("timeupdate", onTimeupdate)
    handle.off?.("loadedmetadata", onLoadedMetadata)
    handle.off?.("trackschanged", updateTrackButtonsUi)
    document.removeEventListener("fullscreenchange", updateFullscreenUi)
    container.removeEventListener("pointermove", onActivity)
    container.removeEventListener("pointerdown", onActivity)
    bar.remove()
  }
}
