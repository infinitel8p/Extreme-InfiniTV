// Mono audio downmix for the embedded players (single-earbud use case).

import { getMonoAudioEnabled, MONO_AUDIO_EVENT } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

interface MonoGraph {
  source: MediaElementAudioSourceNode
  gain: GainNode
}

let audioContext: AudioContext | null = null
const graphs = new WeakMap<HTMLVideoElement, MonoGraph>()

function getContext(): AudioContext | null {
  if (audioContext) return audioContext
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext
  if (!Ctor) return null
  audioContext = new Ctor()
  return audioContext
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
    // createMediaElementSource() is permanent, so only attach for blob: (MSE) sources.
    if (!videoEl.currentSrc || !videoEl.currentSrc.startsWith("blob:")) return
    const ctx = getContext()
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
  }
}
