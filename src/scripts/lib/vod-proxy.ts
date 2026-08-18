// Desktop client for the Rust MKV tee-proxy (vod_proxy.rs).

import { log } from "@/scripts/lib/log.js"
import { getUserAgent, getDownloadDir } from "@/scripts/lib/app-settings.js"

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

export interface VodProxySession {
  playbackUrl: string
  mkvSession: MkvSubtitleSession | null
}

interface RegisterVodProxyResult {
  sessionId?: string
  proxyUrl?: string
}

async function invokeRegisterCommand(
  command: string,
  args: Record<string, unknown>,
): Promise<RegisterVodProxyResult> {
  const { invoke } = await import("@tauri-apps/api/core")
  return (await invoke(command, args)) as RegisterVodProxyResult
}

// Shared by the remote (register_vod_proxy) and local-file (register_vod_proxy_file) variants:
// listeners attach before the sessionId is known, buffering raw payloads so no early event is lost.
async function openMkvProxySession(
  register: () => Promise<RegisterVodProxyResult>,
): Promise<VodProxySession | null> {
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

    const result = await register()
    if (!result?.sessionId || !result?.proxyUrl) {
      throw new Error("vod proxy register command returned an unexpected shape")
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
    log.warn("[xt:vod-proxy] session registration failed:", err)
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
    return null
  }
}

export async function prepareVodPlayback(sourceUrl: string): Promise<VodProxySession> {
  const passthrough: VodProxySession = { playbackUrl: sourceUrl, mkvSession: null }
  if (!vodProxyAvailable || !isMkvProxyCandidate(sourceUrl)) return passthrough
  const session = await openMkvProxySession(() => {
    // An empty UA gets rejected or silently rerouted by some panels, so fall back to the WebView's own UA.
    const userAgent = getUserAgent() || (typeof navigator !== "undefined" ? navigator.userAgent : null) || null
    return invokeRegisterCommand("register_vod_proxy", { url: sourceUrl, userAgent })
  })
  if (session === null) log.warn("[xt:vod-proxy] falling back to direct playback")
  return session ?? passthrough
}

/**
 * Serves a completed download over local HTTP so the ffmpeg sidecar (http/pipe/tcp only, no file
 * protocol) can remux it. Used when a local .mkv can't play in the WebView (WebKit desktop). Null
 * means the proxy session failed to register - the caller has no direct-playback fallback for a
 * container that can't play natively, so it owns the error UI.
 */
export async function prepareLocalVodPlayback(filePath: string): Promise<VodProxySession | null> {
  if (!vodProxyAvailable) return null
  // A custom downloads dir can live outside the default roots the Rust side checks.
  const extraAllowedRoot = getDownloadDir() || null
  return openMkvProxySession(() =>
    invokeRegisterCommand("register_vod_proxy_file", { path: filePath, extraAllowedRoot }),
  )
}
