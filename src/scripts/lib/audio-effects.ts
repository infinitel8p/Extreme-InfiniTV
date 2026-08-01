// Mono audio downmix for the embedded players (single-earbud use case).

import { getMonoAudioEnabled, MONO_AUDIO_EVENT } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"
import { getSharedAudioContext } from "@/scripts/lib/audio-context.ts"

interface MonoGraph {
  source: MediaElementAudioSourceNode
  gain: GainNode
}

const graphs = new WeakMap<HTMLVideoElement, MonoGraph>()
const silenceWarned = new WeakSet<HTMLVideoElement>()

// createMediaElementSource() is permanent and emits silence for CORS-cross-origin
// resources, so the graph only attaches to blob: (MSE) or same-origin sources.
// Never force crossOrigin="anonymous" to widen that: most IPTV providers send no
// ACAO header, so a CORS-gated load fails playback entirely.
export function isSafeAudioSourceUrl(url: string): boolean {
  if (!url) return false
  if (url.startsWith("blob:")) return true
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

function isSafeAudioSource(videoEl: HTMLVideoElement): boolean {
  return isSafeAudioSourceUrl(videoEl.currentSrc)
}

/**
 * True when this element carries a permanent graph and `src` is cross-origin,
 * which the Web Audio spec renders as silence.
 */
function monoGraphWouldSilence(mediaEl: HTMLVideoElement | null, src: string): boolean {
  if (!mediaEl || !src) return false
  return graphs.has(mediaEl) && !isSafeAudioSourceUrl(src)
}

/** Warn once per element when an unsafe source lands on a graphed element. */
export function noteMonoSourceChange(mediaEl: HTMLVideoElement | null, src: string): void {
  if (!monoGraphWouldSilence(mediaEl, src)) return
  const element = mediaEl as HTMLVideoElement
  if (silenceWarned.has(element)) return
  silenceWarned.add(element)
  log.warn(
    "[xt:audio-effects] mono graph is attached and this source is cross-origin - " +
      "mono downmix is inactive for it. Turn mono audio off and reopen the player if audio is missing."
  )
}

function setMonoConfig(gain: GainNode, mono: boolean): void {
  if (mono) {
    gain.channelCount = 1
    gain.channelCountMode = "explicit"
    gain.channelInterpretation = "speakers"
  } else {
    gain.channelCount = 2
    gain.channelCountMode = "max"
  }
}

export function applyMonoPreference(videoEl: HTMLVideoElement | null): void {
  if (!videoEl) return
  try {
    const monoEnabled = getMonoAudioEnabled()
    const existing = graphs.get(videoEl)
    if (existing) {
      setMonoConfig(existing.gain, monoEnabled)
      if (monoEnabled) noteMonoSourceChange(videoEl, videoEl.currentSrc)
      return
    }
    if (!monoEnabled) return
    if (!isSafeAudioSource(videoEl)) {
      noteMonoSourceChange(videoEl, videoEl.currentSrc)
      return
    }
    const ctx = getSharedAudioContext()
    if (!ctx) return
    if (ctx.state === "suspended") void ctx.resume().catch(() => {})
    const source = ctx.createMediaElementSource(videoEl)
    const gain = ctx.createGain()
    source.connect(gain)
    gain.connect(ctx.destination)
    graphs.set(videoEl, { source, gain })
    setMonoConfig(gain, true)
  } catch (err) {
    log.warn("[xt:audio-effects] failed to apply mono preference", err)
  }
}

interface MonoAudioHandle {
  getMediaElement?(): HTMLVideoElement | null
  on(event: string, fn: (...args: unknown[]) => void): void
}

let currentHandle: MonoAudioHandle | null = null
let settingListenerRegistered = false

function applyToCurrentHandle(): void {
  try {
    applyMonoPreference(currentHandle?.getMediaElement?.() ?? null)
  } catch (err) {
    log.warn("[xt:audio-effects] apply on setting change failed", err)
  }
}

function ensureSettingListener(): void {
  if (settingListenerRegistered) return
  settingListenerRegistered = true
  document.addEventListener(MONO_AUDIO_EVENT, applyToCurrentHandle)
}

export function bindMonoAudio(handle: MonoAudioHandle): () => void {
  currentHandle = handle
  const apply = () => {
    try {
      applyMonoPreference(handle.getMediaElement?.() ?? null)
    } catch (err) {
      log.warn("[xt:audio-effects] apply on mount event failed", err)
    }
  }
  try {
    handle.on("loadedmetadata", apply)
    handle.on("playing", apply)
  } catch (err) {
    log.warn("[xt:audio-effects] failed to bind mount events", err)
  }
  ensureSettingListener()
  return () => {
    if (currentHandle === handle) currentHandle = null
    const mediaElement = handle.getMediaElement?.() ?? null
    const graph = mediaElement ? graphs.get(mediaElement) : undefined
    if (!graph || !mediaElement) return
    // The source node can never detach; disconnecting would mute a reused element
    // for good. Reset to stereo pass-through and keep the graph registered.
    try {
      setMonoConfig(graph.gain, false)
    } catch (err) {
      log.warn("[xt:audio-effects] failed to reset mono graph", err)
    }
  }
}
