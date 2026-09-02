// Frontend client for the embedded mpv Tauri backend (mpv-embed IPC contract). Desktop only.

import { log } from "@/scripts/lib/log.js"
import { t, getActiveLocale } from "@/scripts/lib/i18n"
import { toastError } from "@/scripts/lib/toast.js"
import { wrapForDnsProxyExternal } from "@/scripts/lib/player-runtime.js"
import { mountMpvControls } from "@/scripts/lib/mpv-controls.js"
import { openMpvTrackDialog } from "@/scripts/lib/mpv-track-dialog.js"
import { parseMpvAudioTracks, parseMpvSubtitleTracks, isMpvSubtitleActive } from "@/scripts/lib/mpv-tracks.js"
import type { VjsLikeHandle, PlaybackCodecInfo } from "@/scripts/lib/player-runtime.js"
import type { EngineEvent, EngineStats } from "@/scripts/lib/player-telemetry.js"

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

export interface LoadOptions {
  userAgent: string | null
  referer: string | null
  startSeconds: number | null
  isLive: boolean
  networkTimeoutSeconds: number | null
}

export interface MpvEmbeddedCreateOptions {
  userAgent?: string | null
  referer?: string | null
  networkTimeoutSeconds?: number | null
  resumeSeconds?: number
  videoElement?: HTMLVideoElement | null
}

export interface MpvProps {
  pause?: boolean
  timePos?: number
  duration?: number
  coreIdle?: boolean
  pausedForCache?: boolean
  seeking?: boolean
  eofReached?: boolean
  idleActive?: boolean
  demuxerCacheDuration?: number
  videoBitrate?: number
  hwdecCurrent?: string
  frameDropCount?: number
  estimatedVfFps?: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodecName?: string
  trackList?: unknown
  mediaTitle?: string
  subDelay?: number
  aid?: unknown
  sid?: unknown
}

interface MpvStateEventPayload {
  sessionId: string
  props: MpvProps
}

type MpvEventKind = "file-loaded" | "end-file" | "playback-restart" | "start-file" | "log"

interface MpvEventPayload {
  sessionId: string
  kind: MpvEventKind
  reason?: string | null
  detail?: string | null
}

interface MpvExitedEventPayload {
  sessionId: string
  code: number | null
  detail?: string | null
}

interface MpvEmbedAvailabilityResult {
  supported: boolean
  reason: string | null
  binary: string | null
}

interface MpvEmbedStartResult {
  sessionId: string
  pid: number
}

// Below this, a resume seek would restart from near-zero rather than actually resuming.
const RESUME_MIN_SECONDS = 5

// Sentinel dialog item id: never collides with mpv's own numeric track ids.
const LOAD_SUBTITLE_FILE_ID = "__load-subtitle-file__"
const SUBTITLE_FILE_EXTENSIONS = ["srt", "ass", "ssa", "vtt", "sub"]

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

const mpvEmbeddedPlatformAvailable = isTauri && !isAndroid

let cachedAvailability: Promise<boolean> | null = null

export async function mpvEmbeddedAvailable(): Promise<boolean> {
  if (!mpvEmbeddedPlatformAvailable) return false
  if (!cachedAvailability) {
    cachedAvailability = (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        const result = (await invoke("mpv_embed_available")) as MpvEmbedAvailabilityResult
        return !!result?.supported
      } catch (err) {
        log.warn("[xt:mpv-embed] mpv_embed_available failed:", err)
        return false
      }
    })()
  }
  return cachedAvailability
}

// Only a trailing "px" unit is trusted; percentages and other units round to no rounding.
function parseCssRadiusPx(radius: string | number | undefined): number {
  if (typeof radius === "number") return Number.isFinite(radius) ? radius : 0
  if (!radius) return 0
  const match = /^(-?[\d.]+)px$/.exec(radius.trim())
  if (!match) return 0
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : 0
}

export function cssRectToPhysicalBounds(
  rect: { x: number; y: number; width: number; height: number; radius?: string | number },
  devicePixelRatio: number,
): Bounds {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return {
    x: Math.round(rect.x * ratio),
    y: Math.round(rect.y * ratio),
    width: Math.round(rect.width * ratio),
    height: Math.round(rect.height * ratio),
    radius: Math.round(parseCssRadiusPx(rect.radius) * ratio),
  }
}

export function boundsEqual(left: Bounds | null, right: Bounds | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.radius === right.radius
  )
}

export interface NativeVideoHoleVars {
  "--xt-video-x": string
  "--xt-video-y": string
  "--xt-video-w": string
  "--xt-video-h": string
  "--xt-video-r": string
}

/** CSS-pixel hole geometry for the transparent webview cutout; see native-video-hole-contract.md. */
export function cssRectToNativeVideoHoleVars(rect: {
  x: number
  y: number
  width: number
  height: number
  radius?: string | number
}): NativeVideoHoleVars {
  return {
    "--xt-video-x": `${rect.x}px`,
    "--xt-video-y": `${rect.y}px`,
    "--xt-video-w": `${rect.width}px`,
    "--xt-video-h": `${rect.height}px`,
    "--xt-video-r": `${parseCssRadiusPx(rect.radius)}px`,
  }
}

export interface BuildLoadOptionsInput {
  isLive?: boolean
  timelineOffsetSeconds?: number
  resumeSeconds?: number
  userAgent?: string | null
  referer?: string | null
  networkTimeoutSeconds?: number | null
}

export function buildLoadOptions(input: BuildLoadOptionsInput): LoadOptions {
  let startSeconds: number | null = null
  if (Number.isFinite(input.timelineOffsetSeconds) && (input.timelineOffsetSeconds as number) > 0) {
    startSeconds = input.timelineOffsetSeconds as number
  } else if (Number.isFinite(input.resumeSeconds) && (input.resumeSeconds as number) > RESUME_MIN_SECONDS) {
    startSeconds = input.resumeSeconds as number
  }
  return {
    userAgent: input.userAgent ?? null,
    referer: input.referer ?? null,
    startSeconds,
    isLive: input.isLive !== false,
    networkTimeoutSeconds:
      Number.isFinite(input.networkTimeoutSeconds) && (input.networkTimeoutSeconds as number) > 0
        ? (input.networkTimeoutSeconds as number)
        : null,
  }
}

/** Synthetic DOM-ish event names to fire for a props transition (prop-derived events only). */
export function deriveEvents(previousProps: MpvProps | null, nextProps: MpvProps): string[] {
  const previous = previousProps ?? {}
  const events: string[] = []

  if ((!previous.pausedForCache && nextProps.pausedForCache) || (!previous.seeking && nextProps.seeking)) {
    events.push("waiting")
  }
  if (previous.coreIdle !== false && nextProps.coreIdle === false && nextProps.pause === false) {
    events.push("playing")
  }
  if (typeof nextProps.timePos === "number" && nextProps.timePos !== previous.timePos) {
    events.push("timeupdate")
  }
  if (previous.pause !== true && nextProps.pause === true) {
    events.push("pause")
  }
  if (
    (typeof nextProps.width === "number" || typeof nextProps.height === "number") &&
    (nextProps.width !== previous.width || nextProps.height !== previous.height)
  ) {
    events.push("resize")
  }
  if (nextProps.trackList !== previous.trackList) {
    events.push("trackschanged")
  }
  return events
}

type SyntheticEventFn = (...args: unknown[]) => void

function createEmitter() {
  const listeners = new Map<string, Set<SyntheticEventFn>>()
  function on(event: string, fn: SyntheticEventFn): void {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(fn)
  }
  function off(event: string, fn: SyntheticEventFn): void {
    listeners.get(event)?.delete(fn)
  }
  function one(event: string, fn: SyntheticEventFn): void {
    const wrapped: SyntheticEventFn = (...args) => {
      off(event, wrapped)
      fn(...args)
    }
    on(event, wrapped)
  }
  function emit(event: string, ...args: unknown[]): void {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of Array.from(set)) {
      try {
        fn(...args)
      } catch (err) {
        log.warn(`[xt:mpv-embed] "${event}" listener threw:`, err)
      }
    }
  }
  function clear(): void {
    listeners.clear()
  }
  return { on, off, one, emit, clear }
}

function cssRectOf(
  container: HTMLElement,
): { x: number; y: number; width: number; height: number; radius: string } {
  const rect = container.getBoundingClientRect()
  const style = window.getComputedStyle(container)
  const radius = style.borderRadius || style.borderTopLeftRadius
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius }
}

function isScrollableAncestor(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element)
  return (
    /^(auto|scroll)$/.test(style.overflow) ||
    /^(auto|scroll)$/.test(style.overflowX) ||
    /^(auto|scroll)$/.test(style.overflowY)
  )
}

// Scrollable descendants elsewhere on the page (channel list) never move the container.
function collectScrollableAncestors(container: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = []
  let node = container.parentElement
  while (node) {
    if (isScrollableAncestor(node)) ancestors.push(node)
    node = node.parentElement
  }
  return ancestors
}

export async function createMpvEmbeddedHandle(
  container: HTMLElement,
  options: MpvEmbeddedCreateOptions = {},
): Promise<VjsLikeHandle | null> {
  // Hide the empty <video> and show the spinner before any await, so there is never a bare box.
  const videoElement = options.videoElement ?? null
  const videoWasHidden = videoElement?.hidden ?? false
  if (videoElement) videoElement.hidden = true

  const loadingIndicator = document.createElement("div")
  loadingIndicator.className = "mpv-embed-loading"
  loadingIndicator.dataset.mpvEmbedLoading = ""
  loadingIndicator.setAttribute("role", "status")
  loadingIndicator.setAttribute("aria-live", "polite")
  loadingIndicator.textContent = t("common.loading")
  container.appendChild(loadingIndicator)

  function abort(): null {
    loadingIndicator.remove()
    if (videoElement) videoElement.hidden = videoWasHidden
    return null
  }

  if (!(await mpvEmbeddedAvailable())) return abort()

  let coreModule: typeof import("@tauri-apps/api/core")
  let eventModule: typeof import("@tauri-apps/api/event")
  try {
    coreModule = await import("@tauri-apps/api/core")
    eventModule = await import("@tauri-apps/api/event")
  } catch (err) {
    log.warn("[xt:mpv-embed] Tauri API import failed:", err)
    return abort()
  }
  const { invoke } = coreModule
  const { listen } = eventModule

  let sessionId: string
  try {
    const initialBounds = cssRectToPhysicalBounds(cssRectOf(container), window.devicePixelRatio || 1)
    const startResult = (await invoke("mpv_embed_start", { bounds: initialBounds })) as MpvEmbedStartResult
    if (!startResult?.sessionId) throw new Error("mpv_embed_start returned an unexpected shape")
    sessionId = startResult.sessionId
  } catch (err) {
    log.warn("[xt:mpv-embed] mpv_embed_start failed:", err)
    return abort()
  }

  const emitter = createEmitter()
  const engineEventListeners = new Set<(event: EngineEvent) => void>()
  let props: MpvProps = {}
  let pauseState = false
  let localMuted = false
  let localVolume = 1
  let lastErrorDetail: string | null = null
  let disposed = false

  let sawFileLoaded = false
  let firstFrameRevealed = false
  let hasLoadedSource = false
  let loadGeneration = 0
  function clearLoadingIndicator(): void {
    if (firstFrameRevealed) return
    firstFrameRevealed = true
    loadingIndicator.remove()
  }
  function showLoadingIndicator(): void {
    sawFileLoaded = false
    firstFrameRevealed = false
    if (!loadingIndicator.isConnected) container.appendChild(loadingIndicator)
  }
  // First-frame signal for a channel switch: reveal the surface and drop the spinner together.
  function revealSurface(): void {
    if (firstFrameRevealed) return
    clearLoadingIndicator()
    resetBoundsCache()
    void invoke("mpv_embed_set_visible", { sessionId, visible: true }).catch((err: unknown) => {
      log.warn("[xt:mpv-embed] mpv_embed_set_visible(true) failed:", err)
    })
    scheduleBoundsPush()
  }
  emitter.on("playing", revealSurface)
  emitter.on("error", revealSurface)

  function emitEngineEvent(kind: EngineEvent["kind"], detail: string): void {
    const event: EngineEvent = { kind, at: Date.now(), detail }
    for (const listener of engineEventListeners) {
      try {
        listener(event)
      } catch (err) {
        log.warn("[xt:mpv-embed] engine event listener threw:", err)
      }
    }
  }

  function setProperty(name: string, value: unknown): Promise<void> {
    return invoke<void>("mpv_embed_set_property", { sessionId, name, value }).catch((err: unknown) => {
      log.warn(`[xt:mpv-embed] mpv_embed_set_property(${name}) failed:`, err)
    })
  }

  function applyStateUpdate(patch: MpvProps): void {
    const previous = props
    props = { ...props, ...patch }
    if (typeof props.pause === "boolean") pauseState = props.pause
    for (const eventName of deriveEvents(previous, props)) emitter.emit(eventName)
    if (sawFileLoaded && previous.coreIdle !== false && props.coreIdle === false) revealSurface()
  }

  function handleMpvEvent(payload: MpvEventPayload): void {
    if (payload.sessionId !== sessionId) return
    if (payload.kind === "file-loaded") {
      sawFileLoaded = true
      emitter.emit("loadedmetadata")
    } else if (payload.kind === "end-file") {
      if (payload.reason === "eof") {
        emitter.emit("ended")
      } else if (payload.reason === "error") {
        lastErrorDetail = payload.detail || payload.reason || null
        emitter.emit("error")
        emitEngineEvent("engine-error", payload.detail || "mpv end-file error")
      }
    }
  }

  function handleMpvExited(payload: MpvExitedEventPayload): void {
    if (payload.sessionId !== sessionId) return
    lastErrorDetail = payload.detail || (payload.code != null ? `mpv exited (code ${payload.code})` : "mpv exited")
    emitter.emit("error")
    emitEngineEvent("fatal", lastErrorDetail)
  }

  const unlistenState = await listen<MpvStateEventPayload>("xt:mpv-state", (event) => {
    if (event.payload?.sessionId === sessionId) applyStateUpdate(event.payload.props || {})
  })
  const unlistenEvent = await listen<MpvEventPayload>("xt:mpv-event", (event) => {
    if (event.payload) handleMpvEvent(event.payload)
  })
  const unlistenExited = await listen<MpvExitedEventPayload>("xt:mpv-exited", (event) => {
    if (event.payload) handleMpvExited(event.payload)
  })

  // See native-video-hole-contract.md: the webview must cut a transparent hole for the video below it.
  function clearNativeVideoHole(): void {
    document.documentElement.removeAttribute("data-native-video")
    resetBoundsCache()
  }
  function publishNativeVideoHole(cssRect: { x: number; y: number; width: number; height: number; radius?: string }): void {
    document.documentElement.setAttribute("data-native-video", "on")
    const vars = cssRectToNativeVideoHoleVars(cssRect)
    for (const [property, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(property, value)
    }
  }

  let rafHandle: number | null = null
  let lastCssBounds: Bounds | null = null
  let lastPushedBounds: Bounds | null = null
  function resetBoundsCache(): void {
    lastCssBounds = null
    lastPushedBounds = null
  }
  function scheduleBoundsPush(): void {
    if (disposed || rafHandle != null) return
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null
      pushBounds()
    })
  }
  function pushBounds(): void {
    if (disposed || !container.isConnected) return
    const cssRect = cssRectOf(container)
    if (cssRect.width <= 0 || cssRect.height <= 0) return
    const cssBounds = cssRectToPhysicalBounds(cssRect, 1)
    if (!boundsEqual(cssBounds, lastCssBounds)) {
      lastCssBounds = cssBounds
      publishNativeVideoHole(cssRect)
    }
    const bounds = cssRectToPhysicalBounds(cssRect, window.devicePixelRatio || 1)
    if (boundsEqual(bounds, lastPushedBounds)) return
    lastPushedBounds = bounds
    void invoke("mpv_embed_set_bounds", { sessionId, bounds }).catch((err: unknown) => {
      log.warn("[xt:mpv-embed] mpv_embed_set_bounds failed:", err)
    })
  }

  const resizeObserver =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduleBoundsPush()) : null
  resizeObserver?.observe(container)
  window.addEventListener("resize", scheduleBoundsPush)
  // Scoped to ancestors that can actually move the container, not every scrollable descendant on the page.
  const scrollableAncestors = collectScrollableAncestors(container)
  window.addEventListener("scroll", scheduleBoundsPush, { passive: true })
  for (const ancestor of scrollableAncestors) ancestor.addEventListener("scroll", scheduleBoundsPush, { passive: true })

  // dppx media queries fire once per crossing, so the listener must re-register at the new ratio.
  let dprMediaQuery: MediaQueryList | null = null
  let dprChangeHandler: (() => void) | null = null
  function watchDevicePixelRatio(): void {
    const ratio = window.devicePixelRatio || 1
    dprMediaQuery = window.matchMedia(`(resolution: ${ratio}dppx)`)
    dprChangeHandler = () => {
      dprMediaQuery?.removeEventListener("change", dprChangeHandler as () => void)
      resetBoundsCache()
      scheduleBoundsPush()
      watchDevicePixelRatio()
    }
    dprMediaQuery.addEventListener("change", dprChangeHandler)
  }
  watchDevicePixelRatio()

  // Sole choke point for stop-on-navigate; a surviving mini-player changes only this.
  function stopPlaybackOnNavigate(): void {
    clearNativeVideoHole()
    void invoke("mpv_embed_set_visible", { sessionId, visible: false }).catch((err: unknown) => {
      log.warn("[xt:mpv-embed] mpv_embed_set_visible(false) failed:", err)
    })
    void invoke("mpv_embed_stop", { sessionId }).catch((err: unknown) => {
      log.warn("[xt:mpv-embed] mpv_embed_stop failed:", err)
    })
  }
  window.addEventListener("pagehide", stopPlaybackOnNavigate)
  window.addEventListener("beforeunload", stopPlaybackOnNavigate)

  // Fullscreen resizes the container without a scroll or resize event on it.
  function handleFullscreenChange(): void {
    resetBoundsCache()
    scheduleBoundsPush()
  }
  document.addEventListener("fullscreenchange", handleFullscreenChange)

  void invoke("mpv_embed_set_visible", { sessionId, visible: true }).catch((err: unknown) => {
    log.warn("[xt:mpv-embed] mpv_embed_set_visible(true) failed:", err)
  })
  pushBounds()
  // Matches every other backend: subtitles start off, mpv's own auto-selection would turn them on.
  void setProperty("sid", "no")

  async function openAudioTrackMenu(): Promise<void> {
    const tracks = parseMpvAudioTracks(props.trackList, props.aid, getActiveLocale())
    if (!tracks.length) return
    const picked = await openMpvTrackDialog(
      "audio",
      tracks.map((track) => ({ id: track.id, label: track.label, active: track.active })),
    )
    if (picked?.id != null) void setProperty("aid", Number(picked.id))
  }

  async function loadExternalSubtitleFile(): Promise<void> {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Subtitles", extensions: SUBTITLE_FILE_EXTENSIONS }],
      })
      if (!picked || typeof picked !== "string") return
      await invoke("mpv_embed_command", { sessionId, args: ["sub-add", picked, "select"] })
    } catch (err) {
      log.warn("[xt:mpv-embed] sub-add failed:", err)
      toastError(t("player.subtitles.error"))
    }
  }

  async function openSubtitleTrackMenu(): Promise<void> {
    const tracks = parseMpvSubtitleTracks(props.trackList, props.sid, getActiveLocale())
    const hasActiveTrack = tracks.some((track) => track.active)
    const picked = await openMpvTrackDialog("subtitles", [
      { id: null, label: t("player.subtitles.off"), active: !hasActiveTrack },
      ...tracks.map((track) => ({ id: String(track.id), label: track.label, active: track.active })),
      { id: LOAD_SUBTITLE_FILE_ID, label: t("player.subtitles.loadFile"), active: false },
    ])
    if (!picked) return
    if (picked.id === LOAD_SUBTITLE_FILE_ID) {
      void loadExternalSubtitleFile()
      return
    }
    void setProperty("sid", picked.id === null ? "no" : Number(picked.id))
  }

  const handle: VjsLikeHandle = {
    src(opts) {
      lastErrorDetail = null
      if (hasLoadedSource) {
        showLoadingIndicator()
        emitter.emit("emptied")
        clearNativeVideoHole()
        void invoke("mpv_embed_set_visible", { sessionId, visible: false }).catch((err: unknown) => {
          log.warn("[xt:mpv-embed] mpv_embed_set_visible(false) failed:", err)
        })
      }
      hasLoadedSource = true
      const loadOptions = buildLoadOptions({
        isLive: opts.isLive,
        timelineOffsetSeconds: opts.timelineOffsetSeconds,
        resumeSeconds: options.resumeSeconds,
        userAgent: options.userAgent,
        referer: options.referer,
        networkTimeoutSeconds: options.networkTimeoutSeconds,
      })
      const generation = ++loadGeneration
      const requestedSrc = opts.src
      void (async () => {
        // mpv does its own HTTP; only the userinfo-carrying external wrap applies here.
        const playbackUrl = await wrapForDnsProxyExternal(requestedSrc)
        if (generation !== loadGeneration) return
        await invoke("mpv_embed_load", { sessionId, url: playbackUrl, options: loadOptions })
      })().catch((err: unknown) => {
        log.warn("[xt:mpv-embed] mpv_embed_load failed:", err)
        lastErrorDetail = err instanceof Error ? err.message : String(err)
        emitter.emit("error")
      })
    },
    play() {
      pauseState = false
      return setProperty("pause", false)
    },
    pause() {
      pauseState = true
      void setProperty("pause", true)
    },
    paused() {
      return pauseState
    },
    muted(value) {
      if (value === undefined) return localMuted
      localMuted = value
      void setProperty("mute", value)
    },
    volume(value) {
      if (value === undefined) return localVolume
      localVolume = Math.min(1, Math.max(0, value))
      void setProperty("volume", Math.round(localVolume * 100))
      return localVolume
    },
    duration() {
      return props.duration ?? 0
    },
    currentTime(value) {
      if (value === undefined) return props.timePos ?? 0
      void invoke("mpv_embed_command", { sessionId, args: ["seek", String(value), "absolute"] }).catch(
        (err: unknown) => log.warn("[xt:mpv-embed] seek command failed:", err),
      )
      return value
    },
    // No-op: mpv exposes its own tracks via track-list/aid, picked from the "Audio tracks" menu.
    setAudioSource() {},
    setProperty,
    on: emitter.on,
    off: emitter.off,
    one: emitter.one,
    el() {
      return container
    },
    error() {
      return lastErrorDetail
    },
    getMediaElement() {
      return null
    },
    requestFullscreen() {
      return container.requestFullscreen?.()
    },
    isFullscreen() {
      return document.fullscreenElement === container
    },
    exitFullscreen() {
      if (document.fullscreenElement === container) void document.exitFullscreen()
    },
    codecInfo(): PlaybackCodecInfo {
      return {
        videoCodec: props.videoCodec ?? null,
        audioCodec: props.audioCodecName ?? null,
        errorDetail: lastErrorDetail,
      }
    },
    subtitleDelay(deltaSeconds) {
      if (!isMpvSubtitleActive(props.sid)) return null
      const next = (typeof props.subDelay === "number" ? props.subDelay : 0) + deltaSeconds
      props = { ...props, subDelay: next }
      void setProperty("sub-delay", next)
      return next
    },
    engineStats(): EngineStats {
      return {
        engine: null,
        declaredBitrateBps: typeof props.videoBitrate === "number" ? props.videoBitrate : null,
        measuredBitrateBps: null,
        levelIndex: null,
        levelCount: null,
        autoLevel: null,
        videoWidth: typeof props.width === "number" ? props.width : null,
        videoHeight: typeof props.height === "number" ? props.height : null,
        segmentDurationSeconds: null,
        bufferedAheadSeconds: typeof props.demuxerCacheDuration === "number" ? props.demuxerCacheDuration : null,
        droppedFrames: typeof props.frameDropCount === "number" ? props.frameDropCount : null,
        totalFrames: null,
        stalls: null,
      }
    },
    onEngineEvent(listener) {
      engineEventListeners.add(listener)
      return () => engineEventListeners.delete(listener)
    },
    dispose() {
      disposed = true
      clearLoadingIndicator()
      clearNativeVideoHole()
      if (videoElement) videoElement.hidden = videoWasHidden
      emitter.clear()
      engineEventListeners.clear()
      try { unlistenState() } catch (err) { log.warn("[xt:mpv-embed] unlisten state failed:", err) }
      try { unlistenEvent() } catch (err) { log.warn("[xt:mpv-embed] unlisten event failed:", err) }
      try { unlistenExited() } catch (err) { log.warn("[xt:mpv-embed] unlisten exited failed:", err) }
      resizeObserver?.disconnect()
      window.removeEventListener("resize", scheduleBoundsPush)
      window.removeEventListener("scroll", scheduleBoundsPush)
      for (const ancestor of scrollableAncestors) ancestor.removeEventListener("scroll", scheduleBoundsPush)
      window.removeEventListener("pagehide", stopPlaybackOnNavigate)
      window.removeEventListener("beforeunload", stopPlaybackOnNavigate)
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
      if (dprMediaQuery && dprChangeHandler) dprMediaQuery.removeEventListener("change", dprChangeHandler)
      if (rafHandle != null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
      return invoke<void>("mpv_embed_stop", { sessionId }).catch((err: unknown) => {
        log.warn("[xt:mpv-embed] mpv_embed_stop failed:", err)
      })
    },
  }

  const teardownControls = mountMpvControls(container, handle, {
    onAudioTracksClick: () => void openAudioTrackMenu(),
    onSubtitleTracksClick: () => void openSubtitleTrackMenu(),
    getTrackList: () => props.trackList,
  })
  const originalDispose = handle.dispose?.bind(handle)
  handle.dispose = () => {
    teardownControls()
    return originalDispose?.()
  }

  return handle
}
