// Desktop ffmpeg VOD audio-remux proxy client: one session at a time.

import { log } from "@/scripts/lib/log.js"
import { getFfmpegPath, SETTINGS_EVENT } from "@/scripts/lib/app-settings.js"

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

let cachedAvailability: Promise<boolean> | null = null
let activeSessionId: string | null = null

async function probeAvailability(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return !!(await invoke("vod_audio_remux_available", {
      ffmpegPath: getFfmpegPath() || null,
    }))
  } catch (err) {
    log.warn("[xt:vod-audio-proxy] availability check failed:", err)
    return false
  }
}

export async function vodAudioRemuxAvailable(): Promise<boolean> {
  if (!vodAudioRemuxPlatformAvailable) return false
  if (!cachedAvailability) cachedAvailability = probeAvailability()
  return cachedAvailability
}

if (vodAudioRemuxPlatformAvailable && typeof document !== "undefined") {
  document.addEventListener(SETTINGS_EVENT, (event: Event) => {
    const detail = (event as CustomEvent)?.detail
    if (detail?.key === "ffmpegPath") cachedAvailability = null
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
      userAgent: options.userAgent ?? null,
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
