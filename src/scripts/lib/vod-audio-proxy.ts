// Desktop ffmpeg VOD audio-remux proxy client: one session at a time.

import { log } from "@/scripts/lib/log.js"
import { getFfmpegPath, SETTINGS_EVENT } from "@/scripts/lib/app-settings.js"
import { t } from "@/scripts/lib/i18n.js"
import { toastWarn } from "@/scripts/lib/toast.js"

export interface VodAudioRemuxOptions {
  url: string
  userAgent?: string | null
  authorization?: string | null
  audioStreamIndex: number
  startSeconds: number
  transcodeAudio: boolean
}

export interface VodAudioRemuxSession {
  sessionId: string
  playbackUrl: string
}

export interface VodAudioErrorPayload {
  sessionId: string
  detail: string
}

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const vodAudioRemuxPlatformAvailable = isTauri && !isAndroid

interface VodAudioRemuxAvailability {
  available: boolean
  customPathIgnored: boolean
}

let cachedAvailability: Promise<VodAudioRemuxAvailability> | null = null
let resolvedAvailability: boolean | null = null
let activeSessionId: string | null = null
let lastWarnedIgnoredPath: string | null = null

async function probeAvailability(): Promise<VodAudioRemuxAvailability> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = (await invoke("vod_audio_remux_available", {
      ffmpegPath: getFfmpegPath() || null,
    })) as { available?: boolean; customPathIgnored?: boolean }
    const availability = { available: !!result?.available, customPathIgnored: !!result?.customPathIgnored }
    resolvedAvailability = availability.available
    return availability
  } catch (err) {
    log.warn("[xt:vod-audio-proxy] availability check failed:", err)
    resolvedAvailability = false
    return { available: false, customPathIgnored: false }
  }
}

function warnCustomPathIgnoredOnce(): void {
  const currentPath = getFfmpegPath()
  if (!currentPath || lastWarnedIgnoredPath === currentPath) return
  lastWarnedIgnoredPath = currentPath
  log.warn("[xt:vod-audio-proxy] custom ffmpeg path is not usable, using bundled ffmpeg instead")
  toastWarn(t("settings.playback.ffmpegCustomPathIgnored"))
}

export async function vodAudioRemuxAvailable(): Promise<boolean> {
  if (!vodAudioRemuxPlatformAvailable) return false
  if (!cachedAvailability) cachedAvailability = probeAvailability()
  const result = await cachedAvailability
  if (result.customPathIgnored) warnCustomPathIgnoredOnce()
  return result.available
}

/** Last resolved probe result without triggering one; null when no probe has run yet this session. */
export function peekVodAudioRemuxAvailable(): boolean | null {
  if (!vodAudioRemuxPlatformAvailable) return false
  return resolvedAvailability
}

if (vodAudioRemuxPlatformAvailable && typeof document !== "undefined") {
  document.addEventListener(SETTINGS_EVENT, (event: Event) => {
    const detail = (event as CustomEvent)?.detail
    if (detail?.key === "ffmpegPath") {
      cachedAvailability = null
      resolvedAvailability = null
      lastWarnedIgnoredPath = null
    }
  })
}

export async function startVodAudioRemux(
  options: VodAudioRemuxOptions,
): Promise<VodAudioRemuxSession | null> {
  if (!vodAudioRemuxPlatformAvailable) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = (await invoke("register_vod_audio_remux", {
      url: options.url,
      // An empty UA gets rejected or silently rerouted by some panels, so fall back to the WebView's own UA.
      userAgent: options.userAgent || (typeof navigator !== "undefined" ? navigator.userAgent : null) || null,
      authorization: options.authorization ?? null,
      audioStreamIndex: options.audioStreamIndex,
      startSeconds: options.startSeconds,
      transcodeAudio: options.transcodeAudio,
      ffmpegPath: getFfmpegPath() || null,
    })) as { sessionId?: string; playbackUrl?: string }
    if (!result?.sessionId || !result?.playbackUrl) {
      throw new Error("register_vod_audio_remux returned an unexpected shape")
    }
    activeSessionId = result.sessionId
    return { sessionId: result.sessionId, playbackUrl: result.playbackUrl }
  } catch (err) {
    log.warn("[xt:vod-audio-proxy] register_vod_audio_remux failed:", err)
    return null
  }
}

export async function stopVodAudioRemux(sessionId?: string): Promise<void> {
  const targetSessionId = sessionId ?? activeSessionId
  if (!targetSessionId) return
  if (sessionId == null || sessionId === activeSessionId) activeSessionId = null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("unregister_vod_audio_remux", { sessionId: targetSessionId })
  } catch (err) {
    log.warn("[xt:vod-audio-proxy] unregister_vod_audio_remux failed:", err)
  }
}

export function onVodAudioError(
  listener: (payload: VodAudioErrorPayload) => void,
): () => void {
  if (!vodAudioRemuxPlatformAvailable) return () => {}
  let unlisten: (() => void) | null = null
  let disposed = false
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event")
      const stopListening = await listen<VodAudioErrorPayload>(
        "xt:vodaudio-error",
        (event) => {
          if (event.payload) listener(event.payload)
        },
      )
      if (disposed) stopListening()
      else unlisten = stopListening
    } catch (err) {
      log.warn("[xt:vod-audio-proxy] failed to subscribe to error events:", err)
    }
  })()
  return () => {
    disposed = true
    try { unlisten?.() } catch (err) { log.warn("[xt:vod-audio-proxy] unlisten failed:", err) }
  }
}

/** Copy only for AAC/MP3 (any container); transcode everything else. */
export function shouldTranscodeVodAudio(codec: string): boolean {
  const normalized = (codec || "").trim().toLowerCase()
  if (!normalized) return true
  if (normalized === "aac" || normalized === "mp3") return false
  if (normalized.startsWith("a_aac")) return false // Matroska AAC, incl. A_AAC/MPEG4/... variants
  if (normalized === "a_mpeg/l3") return false // Matroska MP3
  if (normalized.startsWith("mp4a")) return false // MP4 AAC, incl. mp4a.40.2 object-type suffixes
  return true
}
