// Desktop ffmpeg live audio-transcode proxy client: one session at a time.

import { log } from "@/scripts/lib/log.js"
import { splitUrlAuth } from "@/scripts/lib/url-auth.ts"
import { getFfmpegPath, SETTINGS_EVENT } from "@/scripts/lib/app-settings.js"

export interface AudioTranscodeSession {
  sessionId: string
  localUrl: string
}

export interface AudioProxyErrorPayload {
  sessionId: string
  detail: string
}

export interface AudioTranscodeStatus {
  available: boolean
  version: string | null
  path: string | null
  source: "custom" | "bundled" | "system" | null
  customError: string | null
}

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const audioProxyPlatformAvailable = isTauri && !isAndroid

let cachedAvailability: Promise<boolean> | null = null
let resolvedAvailability: boolean | null = null
let activeSessionId: string | null = null

function normalizeStatus(result: any): AudioTranscodeStatus {
  return {
    available: !!result?.available,
    version: result?.version ?? null,
    path: result?.path ?? null,
    source: result?.source ?? null,
    customError: result?.customError ?? null,
  }
}

async function probeAvailability(force: boolean): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke("audio_transcode_available", {
      customPath: getFfmpegPath() || null,
      force,
    })
    resolvedAvailability = normalizeStatus(result).available
    return resolvedAvailability
  } catch (err) {
    log.warn("[xt:audio-proxy] availability check failed:", err)
    resolvedAvailability = false
    return false
  }
}

export async function audioTranscodeAvailable(): Promise<boolean> {
  if (!audioProxyPlatformAvailable) return false
  if (!cachedAvailability) cachedAvailability = probeAvailability(false)
  return cachedAvailability
}

/** Last resolved probe result without triggering one; null when no probe has run yet this session. */
export function peekAudioTranscodeAvailable(): boolean | null {
  if (!audioProxyPlatformAvailable) return false
  return resolvedAvailability
}

/** Forces a fresh Rust-side probe (bypassing its resolution cache) after a settings change. */
export function refreshAudioTranscodeAvailability(): Promise<boolean> {
  if (!audioProxyPlatformAvailable) return Promise.resolve(false)
  cachedAvailability = probeAvailability(true)
  return cachedAvailability
}

/** Uncached probe with full detail, for the Settings status line and Test button. */
export async function audioTranscodeStatus(): Promise<AudioTranscodeStatus | null> {
  if (!audioProxyPlatformAvailable) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke("audio_transcode_available", {
      customPath: getFfmpegPath() || null,
      force: true,
    })
    return normalizeStatus(result)
  } catch (err) {
    log.warn("[xt:audio-proxy] status check failed:", err)
    return null
  }
}

if (audioProxyPlatformAvailable && typeof document !== "undefined") {
  document.addEventListener(SETTINGS_EVENT, (event: Event) => {
    const detail = (event as CustomEvent)?.detail
    if (detail?.key === "ffmpegPath") { cachedAvailability = null; resolvedAvailability = null }
  })
}

export async function startAudioTranscode(
  streamUrl: string,
  userAgent?: string | null,
): Promise<AudioTranscodeSession | null> {
  if (!audioProxyPlatformAvailable) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const { url, authorization } = splitUrlAuth(streamUrl)
    // Fall back to the WebView UA so the proxy's upstream request matches the direct-play fetch.
    const effectiveUserAgent =
      userAgent ||
      (typeof navigator !== "undefined" ? navigator.userAgent : null) ||
      null
    const result = (await invoke("register_audio_transcode", {
      url,
      userAgent: effectiveUserAgent,
      authorization,
      ffmpegPath: getFfmpegPath() || null,
    })) as { sessionId?: string; localUrl?: string }
    if (!result?.sessionId || !result?.localUrl) {
      throw new Error("register_audio_transcode returned an unexpected shape")
    }
    activeSessionId = result.sessionId
    return { sessionId: result.sessionId, localUrl: result.localUrl }
  } catch (err) {
    log.warn("[xt:audio-proxy] register_audio_transcode failed:", err)
    return null
  }
}

export async function stopAudioTranscode(sessionId?: string): Promise<void> {
  const targetSessionId = sessionId ?? activeSessionId
  if (!targetSessionId) return
  if (sessionId == null || sessionId === activeSessionId) activeSessionId = null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("unregister_audio_transcode", { sessionId: targetSessionId })
  } catch (err) {
    log.warn("[xt:audio-proxy] unregister_audio_transcode failed:", err)
  }
}

export function activeAudioTranscodeSessionId(): string | null {
  return activeSessionId
}

export function onAudioTranscodeError(
  listener: (payload: AudioProxyErrorPayload) => void,
): () => void {
  if (!audioProxyPlatformAvailable) return () => {}
  let unlisten: (() => void) | null = null
  let disposed = false
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event")
      const stopListening = await listen<AudioProxyErrorPayload>(
        "xt:audioproxy-error",
        (event) => {
          if (event.payload) listener(event.payload)
        },
      )
      if (disposed) stopListening()
      else unlisten = stopListening
    } catch (err) {
      log.warn("[xt:audio-proxy] failed to subscribe to error events:", err)
    }
  })()
  return () => {
    disposed = true
    try { unlisten?.() } catch (err) { log.warn("[xt:audio-proxy] unlisten failed:", err) }
  }
}

// Per-channel memory: a fixed channel tunes through the proxy immediately next time.
const MEMORY_KEY_PREFIX = "xt_audio_transcode:"

function readRememberedChannels(playlistId: string): string[] {
  if (!playlistId) return []
  try {
    const raw = localStorage.getItem(MEMORY_KEY_PREFIX + playlistId)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function writeRememberedChannels(playlistId: string, channelKeys: string[]): void {
  if (!playlistId) return
  try {
    localStorage.setItem(MEMORY_KEY_PREFIX + playlistId, JSON.stringify(channelKeys))
  } catch {}
}

export function rememberAudioTranscodeChannel(playlistId: string, channelKey: string): void {
  if (!playlistId || !channelKey) return
  const current = readRememberedChannels(playlistId)
  if (current.includes(channelKey)) return
  writeRememberedChannels(playlistId, [...current, channelKey])
}

export function forgetAudioTranscodeChannel(playlistId: string, channelKey: string): void {
  if (!playlistId || !channelKey) return
  const current = readRememberedChannels(playlistId)
  if (!current.includes(channelKey)) return
  writeRememberedChannels(playlistId, current.filter((key) => key !== channelKey))
}

export function isAudioTranscodeChannel(playlistId: string, channelKey: string): boolean {
  if (!playlistId || !channelKey) return false
  return readRememberedChannels(playlistId).includes(channelKey)
}
