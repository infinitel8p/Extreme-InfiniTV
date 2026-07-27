// Mono audio downmix for the embedded players (single-earbud use case).

import { getMonoAudioEnabled, MONO_AUDIO_EVENT } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"
import { getSharedAudioContext } from "@/scripts/lib/audio-context.ts"

interface MonoGraph {
  source: MediaElementAudioSourceNode
  gain: GainNode
}

const graphs = new WeakMap<HTMLVideoElement, MonoGraph>()

// createMediaElementSource() is permanent: once attached it can never be
// detached, so a later non-CORS cross-origin src on the same element plays
// silent forever. Only safe to attach on blob: (MSE) or same-origin sources.
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

/** Whether a permanent mono/gain graph is already attached to this element. */
export function hasMonoGraph(mediaEl: HTMLVideoElement | null): boolean {
  if (!mediaEl) return false
  return graphs.has(mediaEl)
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
      return
    }
    if (!monoEnabled) return
    if (!isSafeAudioSource(videoEl)) return
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
    if (!graph) return
    try { graph.source.disconnect() } catch {}
    try { graph.gain.disconnect() } catch {}
    if (mediaElement) graphs.delete(mediaElement)
  }
}
