// Formatting layer plus the DOM overlay + keybinding for the player stats overlay.

import type { EngineStats, EngineEvent } from "@/scripts/lib/player-telemetry.js"
import { droppedFrameCount, deriveFps, readMediaFields } from "@/scripts/lib/player-telemetry.js"
import {
  startHealthSession,
  recordHealth as recordHealthEntry,
  endHealthSession,
  hasActiveHealthSession,
  type HealthKind,
} from "@/scripts/lib/stream-health.js"
import { t } from "@/scripts/lib/i18n.js"
import { toast } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"

export type Translate = (key: string, params?: Record<string, string | number>) => string

export interface StatsRow {
  label: string
  value: string
}

const UNAVAILABLE = "-"

export function formatBitrate(bitsPerSecond: number | null): string {
  if (typeof bitsPerSecond !== "number" || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return UNAVAILABLE
  if (bitsPerSecond < 1_000_000) return `${Math.round(bitsPerSecond / 1000)} kbps`
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
}

export function formatVariantLabel(
  stats: Pick<EngineStats, "levelIndex" | "levelCount" | "autoLevel" | "videoHeight" | "videoWidth">,
  translate: Translate,
): string {
  const fragments: string[] = []
  if (stats.autoLevel) fragments.push(translate("player.stats.auto"))
  if (
    typeof stats.levelIndex === "number" &&
    typeof stats.levelCount === "number" &&
    stats.levelCount > 0
  ) {
    fragments.push(`${stats.levelIndex + 1}/${stats.levelCount}`)
  }
  if (typeof stats.videoHeight === "number" && stats.videoHeight > 0) {
    fragments.push(`${stats.videoHeight}p`)
  } else if (typeof stats.videoWidth === "number" && stats.videoWidth > 0) {
    const height = typeof stats.videoHeight === "number" ? stats.videoHeight : 0
    fragments.push(`${stats.videoWidth}x${height}`)
  }
  if (fragments.length === 0) return UNAVAILABLE
  return fragments.join(" · ")
}

export function formatDroppedFrames(dropped: number | null, total: number | null): string {
  const hasDropped = typeof dropped === "number" && Number.isFinite(dropped)
  if (!hasDropped) return UNAVAILABLE
  const hasTotal = typeof total === "number" && Number.isFinite(total) && total > 0
  if (!hasTotal) return `${dropped}`
  const percent = (dropped / total) * 100
  return `${dropped} / ${total} (${percent.toFixed(1)}%)`
}

export function formatSeconds(seconds: number | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return UNAVAILABLE
  return `${seconds.toFixed(1)}s`
}

export function statsRows(
  stats: EngineStats | null,
  translate: Translate,
  extras?: { fps?: number | null },
): StatsRow[] {
  const declaredBitrate = stats?.declaredBitrateBps ?? null
  const measuredBitrate = stats?.measuredBitrateBps ?? null
  let bitrateValue: string
  if (declaredBitrate != null) {
    bitrateValue = formatBitrate(declaredBitrate)
    if (measuredBitrate != null) {
      bitrateValue += ` ${translate("player.stats.estimated", { value: formatBitrate(measuredBitrate) })}`
    }
  } else if (measuredBitrate != null) {
    bitrateValue = formatBitrate(measuredBitrate)
  } else {
    bitrateValue = UNAVAILABLE
  }

  const variantValue = formatVariantLabel(
    {
      levelIndex: stats?.levelIndex ?? null,
      levelCount: stats?.levelCount ?? null,
      autoLevel: stats?.autoLevel ?? null,
      videoHeight: stats?.videoHeight ?? null,
      videoWidth: stats?.videoWidth ?? null,
    },
    translate,
  )

  const resolutionValue =
    stats?.videoWidth && stats?.videoHeight ? `${stats.videoWidth}x${stats.videoHeight}` : UNAVAILABLE

  const fps = extras?.fps
  const fpsValue = typeof fps === "number" && Number.isFinite(fps) ? `${Math.round(fps)}` : UNAVAILABLE

  const droppedValue = formatDroppedFrames(stats?.droppedFrames ?? null, stats?.totalFrames ?? null)
  const bufferedValue = formatSeconds(stats?.bufferedAheadSeconds ?? null)
  const segmentValue = formatSeconds(stats?.segmentDurationSeconds ?? null)

  return [
    { label: translate("player.stats.engine"), value: stats?.engine ?? UNAVAILABLE },
    { label: translate("player.stats.bitrate"), value: bitrateValue },
    { label: translate("player.stats.variant"), value: variantValue },
    { label: translate("player.stats.resolution"), value: resolutionValue },
    { label: translate("player.stats.fps"), value: fpsValue },
    { label: translate("player.stats.dropped"), value: droppedValue },
    { label: translate("player.stats.buffered"), value: bufferedValue },
    { label: translate("player.stats.segment"), value: segmentValue },
  ]
}

// Minimal structural subset of VjsLikeHandle - avoids importing the full
// player-runtime type (heavy, and would cycle back into this module).
export interface VjsLikeHandleLike {
  getMediaElement?(): HTMLVideoElement | null
  engineStats?(): EngineStats | null
  onEngineEvent?(listener: (event: EngineEvent) => void): () => void
}

export interface PlayerInsightsOptions {
  getHandle(): VjsLikeHandleLike | null
  getContainer(): HTMLElement | null
  backendLabel(): string
  sessionKind: "live" | "vod" | "series"
  isSuppressed?(): boolean
}

export interface PlayerInsights {
  startSession(input: { label: string; seq?: number | null }): void
  endSession(reason?: string): void
  record(kind: HealthKind, detail?: string): void
  toggleOverlay(): boolean
  isOverlayVisible(): boolean
  openHealthDialog(): void
  teardown(): void
}

const STATS_OVERLAY_STORAGE_KEY = "xt_stats_overlay"
const STATS_TOGGLE_CODE = "KeyS"

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (typeof element.closest === "function" && element.closest("dialog[open]")) return true
  return false
}

function mediaFallbackStats(video: HTMLVideoElement | null): EngineStats {
  return {
    engine: null,
    declaredBitrateBps: null,
    measuredBitrateBps: null,
    levelIndex: null,
    levelCount: null,
    autoLevel: null,
    segmentDurationSeconds: null,
    stalls: null,
    ...readMediaFields(video),
  }
}

export function attachPlayerInsights(options: PlayerInsightsOptions): PlayerInsights {
  let visible = false
  let overlayEl: HTMLElement | null = null
  let rowElements: { label: HTMLElement; value: HTMLElement }[] = []
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let sessionSamplerTimer: ReturnType<typeof setInterval> | null = null
  let boundMediaEl: HTMLVideoElement | null = null
  let engineUnsubscribe: (() => void) | null = null
  let engineSubscribedHandle: VjsLikeHandleLike | null = null
  let lastFrameSample: { frames: number; at: number } | null = null
  let lastFps: number | null = null
  let lastDroppedSample: number | null = null

  function isSuppressed(): boolean {
    return options.isSuppressed?.() ?? false
  }

  function readPersistedVisible(): boolean {
    try {
      return sessionStorage.getItem(STATS_OVERLAY_STORAGE_KEY) === "1"
    } catch {
      return false
    }
  }

  function persistVisible(value: boolean): void {
    try {
      sessionStorage.setItem(STATS_OVERLAY_STORAGE_KEY, value ? "1" : "0")
    } catch {}
  }

  function ensureOverlay(): HTMLElement | null {
    if (overlayEl) return overlayEl
    const container = options.getContainer()
    if (!container) return null
    const node = document.createElement("div")
    node.className = "stats-overlay"
    node.setAttribute("aria-hidden", "true")
    node.setAttribute("hidden", "")
    container.appendChild(node)
    overlayEl = node
    return node
  }

  function buildOverlaySkeleton(overlay: HTMLElement, rowCount: number): void {
    overlay.textContent = ""
    rowElements = []
    for (let index = 0; index < rowCount; index++) {
      const labelEl = document.createElement("span")
      labelEl.className = "stats-overlay__label"
      const valueEl = document.createElement("span")
      valueEl.className = "stats-overlay__value"
      overlay.appendChild(labelEl)
      overlay.appendChild(valueEl)
      rowElements.push({ label: labelEl, value: valueEl })
    }
  }

  function renderRows(rows: StatsRow[]): void {
    const overlay = ensureOverlay()
    if (!overlay) return
    if (rowElements.length !== rows.length) buildOverlaySkeleton(overlay, rows.length)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!
      const cell = rowElements[index]!
      if (cell.label.textContent !== row.label) cell.label.textContent = row.label
      if (cell.value.textContent !== row.value) cell.value.textContent = row.value
    }
  }

  function applyOverlayHiddenState(): void {
    const overlay = ensureOverlay()
    if (!overlay) return
    if (visible && !isSuppressed()) overlay.removeAttribute("hidden")
    else overlay.setAttribute("hidden", "")
  }

  function shouldPoll(): boolean {
    return visible && !isSuppressed() && document.visibilityState === "visible"
  }

  function pollTick(): void {
    if (!shouldPoll()) {
      stopPollTimer()
      return
    }
    const handle = options.getHandle()
    const mediaElement = handle?.getMediaElement?.() ?? null
    const stats = handle?.engineStats?.() ?? mediaFallbackStats(mediaElement)
    let fps = lastFps
    if (typeof stats.totalFrames === "number") {
      const now = Date.now()
      const derived = deriveFps(lastFrameSample, { frames: stats.totalFrames, at: now })
      if (derived != null) fps = derived
      lastFrameSample = { frames: stats.totalFrames, at: now }
    }
    lastFps = fps
    renderRows(statsRows(stats, t, { fps }))
  }

  function startPollTimer(): void {
    if (pollTimer || !shouldPoll()) return
    pollTimer = setInterval(pollTick, 1000)
    pollTick()
  }

  function stopPollTimer(): void {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  function reconcilePolling(): void {
    if (shouldPoll()) startPollTimer()
    else stopPollTimer()
  }

  function onMediaPlaying(): void {
    recordHealthEntry("playing")
  }
  function onMediaWaiting(): void {
    recordHealthEntry("waiting")
  }
  function onMediaStalled(): void {
    recordHealthEntry("stalled")
  }
  function onMediaEnded(): void {
    recordHealthEntry("end")
  }

  function unbindMediaEvents(): void {
    if (!boundMediaEl) return
    boundMediaEl.removeEventListener("playing", onMediaPlaying)
    boundMediaEl.removeEventListener("waiting", onMediaWaiting)
    boundMediaEl.removeEventListener("stalled", onMediaStalled)
    boundMediaEl.removeEventListener("ended", onMediaEnded)
    boundMediaEl = null
  }

  // The <video> element is swapped per playback session, so this is re-run on a timer.
  function bindMediaEvents(): void {
    const mediaElement = options.getHandle()?.getMediaElement?.() ?? null
    if (mediaElement === boundMediaEl) return
    unbindMediaEvents()
    boundMediaEl = mediaElement
    if (!boundMediaEl) return
    boundMediaEl.addEventListener("playing", onMediaPlaying)
    boundMediaEl.addEventListener("waiting", onMediaWaiting)
    boundMediaEl.addEventListener("stalled", onMediaStalled)
    boundMediaEl.addEventListener("ended", onMediaEnded)
  }

  function onEngineEvent(event: EngineEvent): void {
    if (event.kind === "variant") recordHealthEntry("variant", event.detail)
    else if (event.kind === "engine-error" || event.kind === "fatal") recordHealthEntry("error", event.detail)
    else if (event.kind === "engine-switch") recordHealthEntry("fallback", event.detail)
    else if (event.kind === "recover") recordHealthEntry("recover", event.detail)
  }

  // The handle is replaced on every remount, so a stale subscription must be swapped, not kept forever.
  function ensureEngineEventSubscription(): void {
    const handle = options.getHandle()
    if (handle === engineSubscribedHandle) return
    if (engineUnsubscribe) {
      engineUnsubscribe()
      engineUnsubscribe = null
    }
    engineSubscribedHandle = handle
    const unsubscribe = handle?.onEngineEvent?.(onEngineEvent)
    if (typeof unsubscribe === "function") engineUnsubscribe = unsubscribe
  }

  function sessionSamplerTick(): void {
    bindMediaEvents()
    ensureEngineEventSubscription()
    reconcilePolling()
    if (!hasActiveHealthSession()) return
    const dropped = droppedFrameCount(options.getHandle()?.getMediaElement?.() ?? null)
    if (dropped == null) return
    if (lastDroppedSample != null) {
      const delta = dropped - lastDroppedSample
      if (delta > 0) recordHealthEntry("dropped", String(delta))
    }
    lastDroppedSample = dropped
  }

  function startSessionSampler(): void {
    if (sessionSamplerTimer) return
    sessionSamplerTimer = setInterval(sessionSamplerTick, 5000)
  }

  function stopSessionSampler(): void {
    if (!sessionSamplerTimer) return
    clearInterval(sessionSamplerTimer)
    sessionSamplerTimer = null
  }

  function onFullscreenChange(): void {
    try {
      const overlay = overlayEl
      if (!overlay) return
      const mediaElement = options.getHandle()?.getMediaElement?.() ?? null
      const fullscreenElement = document.fullscreenElement
      if (fullscreenElement && mediaElement && fullscreenElement.contains(mediaElement)) {
        fullscreenElement.appendChild(overlay)
        overlay.setAttribute("data-fs", "on")
      } else {
        const container = options.getContainer()
        if (container && overlay.parentElement !== container) container.appendChild(overlay)
        overlay.removeAttribute("data-fs")
      }
    } catch {}
  }

  function onVisibilityChange(): void {
    reconcilePolling()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return
    if (event.code !== STATS_TOGGLE_CODE) return
    if (isTypingTarget(event.target) || document.querySelector("dialog[open]")) return
    event.preventDefault()
    toggleOverlay()
  }

  function startSession(input: { label: string; seq?: number | null }): void {
    lastFrameSample = null
    lastFps = null
    lastDroppedSample = null
    startHealthSession({
      label: input.label,
      kind: options.sessionKind,
      backend: options.backendLabel(),
      seq: input.seq ?? null,
    })
    bindMediaEvents()
    ensureEngineEventSubscription()
    startSessionSampler()
    reconcilePolling()
  }

  function endSession(reason?: string): void {
    endHealthSession(reason)
    stopSessionSampler()
  }

  function record(kind: HealthKind, detail?: string): void {
    recordHealthEntry(kind, detail)
  }

  function toggleOverlay(): boolean {
    visible = !visible
    persistVisible(visible)
    applyOverlayHiddenState()
    reconcilePolling()
    toast({ title: t(visible ? "player.stats.on" : "player.stats.off"), duration: 1500 })
    return visible
  }

  function isOverlayVisible(): boolean {
    return visible
  }

  function openHealthDialog(): void {
    import("@/scripts/lib/stream-health-dialog.js")
      .then((module) => module.openStreamHealthDialog())
      .catch((cause) => log.error("[xt:player-stats] health dialog failed", cause))
  }

  function teardown(): void {
    stopPollTimer()
    stopSessionSampler()
    unbindMediaEvents()
    if (engineUnsubscribe) {
      engineUnsubscribe()
      engineUnsubscribe = null
    }
    engineSubscribedHandle = null
    document.removeEventListener("keydown", onKeydown)
    document.removeEventListener("visibilitychange", onVisibilityChange)
    document.removeEventListener("fullscreenchange", onFullscreenChange)
    overlayEl?.remove()
    overlayEl = null
    rowElements = []
  }

  visible = readPersistedVisible()
  ensureOverlay()
  applyOverlayHiddenState()
  reconcilePolling()
  document.addEventListener("keydown", onKeydown)
  document.addEventListener("visibilitychange", onVisibilityChange)
  document.addEventListener("fullscreenchange", onFullscreenChange)

  return {
    startSession,
    endSession,
    record,
    toggleOverlay,
    isOverlayVisible,
    openHealthDialog,
    teardown,
  }
}
