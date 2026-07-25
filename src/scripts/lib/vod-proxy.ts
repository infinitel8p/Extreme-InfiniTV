// Desktop client for the Rust MKV tee-proxy (vod_proxy.rs).

import { log } from "@/scripts/lib/log.js"
import { getUserAgent } from "@/scripts/lib/app-settings.js"

export interface MkvSubtitleTrackInfo {
  number: number
  codec: string
  language: string | null
  name: string | null
}

export interface MkvAudioTrackInfo {
  number: number
  codec: string
  language: string | null
  name: string | null
  /** Matroska FlagDefault; optional until the Rust side always reports it. */
  default?: boolean
}

export interface MkvCue {
  startMs: number
  endMs: number
  text: string
}

export interface MkvSubtitleSession {
  tracks(): Promise<MkvSubtitleTrackInfo[]>
  audioTracks(): Promise<MkvAudioTrackInfo[]>
  onCues(listener: (trackNumber: number, cues: MkvCue[]) => void): void
  stop(): void
}

interface TracksEventPayload {
  sessionId: string
  tracks: MkvSubtitleTrackInfo[]
  audioTracks?: MkvAudioTrackInfo[]
}

interface CuesEventPayload {
  sessionId: string
  trackNumber: number
  cues: MkvCue[]
}

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const vodProxyAvailable = isTauri && !isAndroid

const TRACKS_TIMEOUT_MS = 20000

export function isMkvProxyCandidate(url: string): boolean {
  if (typeof url !== "string") return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const pathname = parsed.pathname.toLowerCase()
  return pathname.endsWith(".mkv") || pathname.endsWith(".webm")
}

// Listeners attach before the sessionId is known, buffering raw payloads so no early event is lost.
export async function prepareVodPlayback(
  sourceUrl: string,
): Promise<{ playbackUrl: string; mkvSession: MkvSubtitleSession | null }> {
  const passthrough = { playbackUrl: sourceUrl, mkvSession: null }
  if (!vodProxyAvailable || !isMkvProxyCandidate(sourceUrl)) return passthrough

  let ownSessionId: string | null = null
  const rawTracksBuffer: TracksEventPayload[] = []
  const rawCuesBuffer: CuesEventPayload[] = []
  // The tee never re-emits cues; late listeners replay from here.
  const cueHistory: Array<{ trackNumber: number; cues: MkvCue[] }> = []
  let cueListener: ((trackNumber: number, cues: MkvCue[]) => void) | null = null
  let tracksSettled = false
  let resolveTracks: ((tracks: MkvSubtitleTrackInfo[]) => void) | null = null
  const tracksPromise = new Promise<MkvSubtitleTrackInfo[]>((resolve) => {
    resolveTracks = resolve
  })
  let audioTracksSettled = false
  let resolveAudioTracks: ((audioTracks: MkvAudioTrackInfo[]) => void) | null = null
  const audioTracksPromise = new Promise<MkvAudioTrackInfo[]>((resolve) => {
    resolveAudioTracks = resolve
  })
  let unlistenTracks: (() => void) | null = null
  let unlistenCues: (() => void) | null = null

  function settleTracks(tracks: MkvSubtitleTrackInfo[]): void {
    if (tracksSettled) return
    tracksSettled = true
    resolveTracks?.(tracks)
  }

  function settleAudioTracks(audioTracks: MkvAudioTrackInfo[]): void {
    if (audioTracksSettled) return
    audioTracksSettled = true
    resolveAudioTracks?.(audioTracks)
  }

  function deliverCues(trackNumber: number, cues: MkvCue[]): void {
    cueHistory.push({ trackNumber, cues })
    cueListener?.(trackNumber, cues)
  }

  function handleTracksEvent(payload: TracksEventPayload | undefined): void {
    if (!payload) return
    if (ownSessionId === null) {
      rawTracksBuffer.push(payload)
      return
    }
    if (payload.sessionId !== ownSessionId) return
    settleTracks(payload.tracks ?? [])
    settleAudioTracks(payload.audioTracks ?? [])
  }

  function handleCuesEvent(payload: CuesEventPayload | undefined): void {
    if (!payload) return
    if (ownSessionId === null) {
      rawCuesBuffer.push(payload)
      return
    }
    if (payload.sessionId !== ownSessionId) return
    deliverCues(payload.trackNumber, payload.cues ?? [])
  }

  try {
    const { listen } = await import("@tauri-apps/api/event")
    unlistenTracks = await listen<TracksEventPayload>("xt:vodproxy-tracks", (event) =>
      handleTracksEvent(event.payload),
    )
    unlistenCues = await listen<CuesEventPayload>("xt:vodproxy-cues", (event) =>
      handleCuesEvent(event.payload),
    )

    const { invoke } = await import("@tauri-apps/api/core")
    const userAgent = getUserAgent() || null
    const result = (await invoke("register_vod_proxy", {
      url: sourceUrl,
      userAgent,
    })) as { sessionId?: string; proxyUrl?: string }
    if (!result?.sessionId || !result?.proxyUrl) {
      throw new Error("register_vod_proxy returned an unexpected shape")
    }

    ownSessionId = result.sessionId
    for (const payload of rawTracksBuffer.splice(0)) {
      if (payload.sessionId === ownSessionId) {
        settleTracks(payload.tracks ?? [])
        settleAudioTracks(payload.audioTracks ?? [])
      }
    }
    for (const payload of rawCuesBuffer.splice(0)) {
      if (payload.sessionId === ownSessionId) deliverCues(payload.trackNumber, payload.cues ?? [])
    }

    setTimeout(() => {
      settleTracks([])
      settleAudioTracks([])
    }, TRACKS_TIMEOUT_MS)

    const sessionId = ownSessionId
    let sessionStopped = false
    const session: MkvSubtitleSession = {
      tracks: () => tracksPromise,
      audioTracks: () => audioTracksPromise,
      onCues(listener) {
        cueListener = listener
        for (const { trackNumber, cues } of cueHistory) listener(trackNumber, cues)
      },
      stop() {
        if (sessionStopped) return
        sessionStopped = true
        cueListener = null
        cueHistory.length = 0
        try { unlistenTracks?.() } catch (err) { log.warn("[xt:vod-proxy] unlisten tracks failed:", err) }
        try { unlistenCues?.() } catch (err) { log.warn("[xt:vod-proxy] unlisten cues failed:", err) }
        unlistenTracks = null
        unlistenCues = null
        void (async () => {
          try {
            const { invoke: invokeUnregister } = await import("@tauri-apps/api/core")
            await invokeUnregister("unregister_vod_proxy", { sessionId })
          } catch (err) {
            log.warn("[xt:vod-proxy] unregister_vod_proxy failed:", err)
          }
        })()
      },
    }
    return { playbackUrl: result.proxyUrl, mkvSession: session }
  } catch (err) {
    log.warn("[xt:vod-proxy] falling back to direct playback:", err)
    try { unlistenTracks?.() } catch (unlistenErr) { log.warn("[xt:vod-proxy] unlisten tracks failed:", unlistenErr) }
    try { unlistenCues?.() } catch (unlistenErr) { log.warn("[xt:vod-proxy] unlisten cues failed:", unlistenErr) }
    if (ownSessionId) {
      const staleSessionId = ownSessionId
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core")
          await invoke("unregister_vod_proxy", { sessionId: staleSessionId })
        } catch (unregisterErr) {
          log.warn("[xt:vod-proxy] unregister after failed prepare failed:", unregisterErr)
        }
      })()
    }
    return passthrough
  }
}
