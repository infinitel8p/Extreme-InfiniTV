// Audio-track switcher for native-played VOD: remux via ffmpeg, remount (desktop only).

import { log } from "@/scripts/lib/log.js"
import { t } from "@/scripts/lib/i18n.js"
import { toastError } from "@/scripts/lib/toast.js"
import { getUserAgent } from "@/scripts/lib/app-settings.js"
import { splitUrlAuth } from "@/scripts/lib/url-auth.ts"
import { labelAudioTracks, type AudioTrackSource } from "@/scripts/lib/audio-tracks.ts"
import {
  startVodAudioRemux,
  stopVodAudioRemux,
  onVodAudioError,
  shouldTranscodeVodAudio,
} from "@/scripts/lib/vod-audio-proxy.ts"
import { listMp4AudioTracks } from "@/scripts/lib/mp4-subtitles.ts"
import type { MkvSubtitleSession } from "@/scripts/lib/vod-proxy.ts"
import type { VjsLikeHandle } from "@/scripts/lib/player-runtime.ts"

export interface VodAudioTrackOption {
  id: string
  /** ffmpeg `-map 0:a:<index>` position, not the container's global track number. */
  audioStreamIndex: number
  codec: string
  language?: string | null
  name?: string | null
  isDefault: boolean
}

export interface VodAudioSwitcherOptions {
  handle: VjsLikeHandle
  originalSrc: string
  originalMime: string
  originalSubtitles?: { sourceUrl: string; mkvSession?: MkvSubtitleSession | null } | null
  /** Fallback remux source when remuxInputUrl is unset. */
  sourceUrl: string
  /** MKV: local tee URL, kept fed so it keeps demuxing subtitle cues. */
  remuxInputUrl?: string | null
  userAgent?: string | null
  getKnownDurationSeconds(): number | undefined
  tracks: VodAudioTrackOption[]
  /** Force-mount the remux session right away instead of waiting for a track switch; used when the container can't play natively (e.g. MKV on WebKit desktop). */
  mountRemuxImmediately?: boolean
  /** Only meaningful with mountRemuxImmediately: seconds to resume the mandatory initial remux at. */
  initialStartSeconds?: number
  /** Only meaningful with mountRemuxImmediately: fires once when the remux can't carry playback, either because the session failed to register or because it died mid-play. Remounting the original is not an option in that mode (the engine can't demux the container), so the caller owns the error UI. */
  onRemuxUnrecoverable?: (detail: string) => void
}

export interface VodAudioSwitcher {
  source: AudioTrackSource
  /** Replaces the selectable track list without touching the session already streaming; never remounts. */
  setTracks(tracks: VodAudioTrackOption[]): void
  /** Mandatory-remux only: restart after a stall; no-ops when already restarting, exhausted, or sessionless. */
  recoverRemuxStall(): void
  /** True while a mid-play restart is in flight. */
  isRecovering(): boolean
  dispose(): void
}

export interface BufferedRange {
  start: number
  end: number
}

/** Mirrors stream.ts's catch-up buffered-range slack. */
export function isSeekOutsideBufferedRanges(
  targetSeconds: number,
  ranges: BufferedRange[],
  beforeSlackSeconds = 1,
  afterSlackSeconds = 2,
): boolean {
  for (const range of ranges) {
    if (targetSeconds >= range.start - beforeSlackSeconds && targetSeconds <= range.end + afterSlackSeconds) {
      return false
    }
  }
  return true
}

export function timeRangesToArray(ranges: TimeRanges | null | undefined): BufferedRange[] {
  if (!ranges) return []
  const result: BufferedRange[] = []
  for (let i = 0; i < ranges.length; i++) result.push({ start: ranges.start(i), end: ranges.end(i) })
  return result
}

export interface VodAudioRemuxRequest {
  url: string
  userAgent: string | null
  authorization: string | null
  audioStreamIndex: number
  startSeconds: number
  transcodeAudio: boolean
}

export function buildVodAudioRemuxRequest(
  track: VodAudioTrackOption,
  cleanUrl: string,
  startSeconds: number,
  userAgent: string | null,
  authorization: string | null,
): VodAudioRemuxRequest {
  return {
    url: cleanUrl,
    userAgent,
    authorization,
    audioStreamIndex: track.audioStreamIndex,
    startSeconds: Math.max(0, startSeconds),
    transcodeAudio: shouldTranscodeVodAudio(track.codec),
  }
}

export interface VodAudioRemuxInput {
  cleanUrl: string
  userAgent: string | null
  authorization: string | null
}

/** Tee URL already has headers applied; MP4 path still needs them split. */
export function resolveVodAudioRemuxInput(
  remuxInputUrl: string | null | undefined,
  sourceUrl: string,
  resolvedUserAgent: string | null,
): VodAudioRemuxInput {
  if (remuxInputUrl) return { cleanUrl: remuxInputUrl, userAgent: null, authorization: null }
  const { url: cleanUrl, authorization } = splitUrlAuth(sourceUrl)
  return { cleanUrl, userAgent: resolvedUserAgent, authorization: authorization ?? null }
}

/** MKV reuses the tee's parsed tracks; MP4 does its own moov parse. */
export async function discoverVodAudioTracks(
  mkvSession: MkvSubtitleSession | null,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<VodAudioTrackOption[]> {
  try {
    if (mkvSession) {
      const tracks = await mkvSession.audioTracks()
      return tracks.map((track, index) => ({
        id: `mkv:${track.number}`,
        audioStreamIndex: index,
        codec: track.codec,
        language: track.language,
        name: track.name,
        isDefault: track.default ?? index === 0,
      }))
    }
    const tracks = await listMp4AudioTracks(sourceUrl, { signal })
    return tracks.map((track) => ({
      id: `mp4:${track.trackId}`,
      audioStreamIndex: track.index,
      codec: track.codec,
      language: track.language,
      name: track.name ?? null,
      isDefault: track.index === 0,
    }))
  } catch (err) {
    if (err instanceof Error && err.name !== "AbortError") {
      log.warn("[xt:vod-audio-switch] audio track discovery failed:", err)
    }
    return []
  }
}

const SEEK_SUPPRESSION_FALLBACK_MS = 1500

/** Mandatory-remux mid-play recovery: bounded restarts per playback session, forgiven after a healthy run. */
const MAX_MIDPLAY_RESTART_ATTEMPTS = 2
const MIDPLAY_RESTART_RESET_MS = 60000

/** A remux-only mount (no discovered tracks) still needs a track to remux against. */
const SYNTHETIC_DEFAULT_TRACK: VodAudioTrackOption = {
  id: "default",
  audioStreamIndex: 0,
  codec: "",
  isDefault: true,
}

export function createVodAudioSwitcher(options: VodAudioSwitcherOptions): VodAudioSwitcher {
  let tracks = options.tracks.length > 0 ? options.tracks : [SYNTHETIC_DEFAULT_TRACK]
  let tracksById = new Map(tracks.map((track) => [track.id, track]))
  let defaultTrackId = (tracks.find((track) => track.isDefault) ?? tracks[0] ?? null)?.id ?? null

  let activeTrackId = defaultTrackId
  let activeSessionId: string | null = null
  let disposed = false
  let remuxUnrecoverableReported = false
  // Guards against stale async resolutions after a newer switch.
  let generation = 0
  let seekingEl: HTMLVideoElement | null = null
  let seekingHandler: (() => void) | null = null
  let suppressNextSeek = false
  let suppressExpiryMs = 0
  const listeners = new Set<() => void>()
  let midPlayRestartAttempts = 0
  let midPlayRestartInFlight = false
  let midPlayHealthyResetTimer: ReturnType<typeof setTimeout> | null = null

  function bumpGeneration(): number {
    generation += 1
    return generation
  }

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function currentPlayheadSeconds(): number {
    return options.handle.currentTime?.() || 0
  }

  // Ignores the remount's own seek; times out so real seeks aren't lost.
  function armProgrammaticSeekSuppression(): void {
    suppressNextSeek = true
    suppressExpiryMs = Date.now() + SEEK_SUPPRESSION_FALLBACK_MS
  }

  function detachSeekInterceptor(): void {
    if (seekingEl && seekingHandler) seekingEl.removeEventListener("seeking", seekingHandler)
    seekingEl = null
    seekingHandler = null
  }

  function attachSeekInterceptor(): void {
    detachSeekInterceptor()
    const mediaEl = options.handle.getMediaElement?.()
    if (!mediaEl) return
    seekingHandler = () => {
      if (disposed || !activeSessionId) return
      if (suppressNextSeek) {
        suppressNextSeek = false
        if (Date.now() <= suppressExpiryMs) return
      }
      const targetSeconds = mediaEl.currentTime
      if (!isSeekOutsideBufferedRanges(targetSeconds, timeRangesToArray(mediaEl.buffered))) return
      void switchToRemux(activeTrackId, targetSeconds)
    }
    seekingEl = mediaEl
    mediaEl.addEventListener("seeking", seekingHandler)
  }

  function playQuietly(): void {
    const playResult = options.handle.play()
    if (playResult && typeof (playResult as Promise<unknown>).catch === "function") {
      (playResult as Promise<unknown>).catch(() => {})
    }
  }

  function remountOriginal(capturedTimeSeconds: number, sessionToStop: string | null): void {
    bumpGeneration()
    activeSessionId = null
    activeTrackId = defaultTrackId
    detachSeekInterceptor()
    options.handle.src({
      src: options.originalSrc,
      type: options.originalMime,
      isLive: false,
      durationSeconds: options.getKnownDurationSeconds(),
      subtitles: options.originalSubtitles ?? null,
      audio: sourceHandle,
    })
    // No further fallback if this remount also errors.
    options.handle.one?.("error", () => {
      log.warn("[xt:vod-audio-switch] fallback remount to the original audio also failed, giving up")
    })
    if (capturedTimeSeconds > 0.5) {
      options.handle.one?.("loadedmetadata", () => {
        try { options.handle.currentTime?.(capturedTimeSeconds) } catch {}
      })
    }
    playQuietly()
    if (sessionToStop) void stopVodAudioRemux(sessionToStop)
  }

  /** Fires the caller's error UI once; further failures stay silent. */
  function reportRemuxUnrecoverable(detail: string): void {
    if (remuxUnrecoverableReported) return
    remuxUnrecoverableReported = true
    options.onRemuxUnrecoverable?.(detail)
  }

  function clearMidPlayHealthyResetTimer(): void {
    if (midPlayHealthyResetTimer === null) return
    clearTimeout(midPlayHealthyResetTimer)
    midPlayHealthyResetTimer = null
  }

  function armMidPlayHealthyResetTimer(): void {
    clearMidPlayHealthyResetTimer()
    midPlayHealthyResetTimer = setTimeout(() => {
      midPlayRestartAttempts = 0
      midPlayHealthyResetTimer = null
    }, MIDPLAY_RESTART_RESET_MS)
  }

  function finalizeMidPlayUnrecoverable(deadSessionId: string | null, detail: string): void {
    log.warn(
      "[xt:vod-audio-switch] mandatory remux session failed mid-play, no playable fallback:",
      detail,
    )
    bumpGeneration()
    activeSessionId = null
    detachSeekInterceptor()
    if (deadSessionId) void stopVodAudioRemux(deadSessionId)
    reportRemuxUnrecoverable(detail)
  }

  /** Shared by the vodaudio-error listener and the stall watchdog's recovery hook. */
  function attemptMidPlayRestart(deadSessionId: string | null, detail: string): void {
    if (disposed || midPlayRestartInFlight) return
    if (midPlayRestartAttempts >= MAX_MIDPLAY_RESTART_ATTEMPTS) {
      finalizeMidPlayUnrecoverable(deadSessionId, detail)
      return
    }
    midPlayRestartInFlight = true
    midPlayRestartAttempts += 1
    const attemptNumber = midPlayRestartAttempts
    clearMidPlayHealthyResetTimer()
    log.warn(
      `[xt:vod-audio-switch] remux session died mid-play, restarting session (attempt ${attemptNumber}/${MAX_MIDPLAY_RESTART_ATTEMPTS})`,
      detail,
    )
    const capturedTimeSeconds = currentPlayheadSeconds()
    const restartTrackId = activeTrackId
    bumpGeneration()
    activeSessionId = null
    detachSeekInterceptor()
    if (deadSessionId) void stopVodAudioRemux(deadSessionId)
    void switchToRemux(restartTrackId, capturedTimeSeconds).finally(() => {
      midPlayRestartInFlight = false
    })
  }

  async function switchToRemux(trackId: string | null, startSeconds: number): Promise<void> {
    const track = trackId ? tracksById.get(trackId) : null
    if (!track) return
    const myGeneration = bumpGeneration()
    const previousTrackId = activeTrackId
    activeTrackId = track.id
    notify()
    const resolvedUserAgent = options.userAgent ?? getUserAgent() ?? null
    const { cleanUrl, userAgent, authorization } = resolveVodAudioRemuxInput(
      options.remuxInputUrl,
      options.sourceUrl,
      resolvedUserAgent,
    )
    const request = buildVodAudioRemuxRequest(track, cleanUrl, startSeconds, userAgent, authorization)
    const session = await startVodAudioRemux(request)
    if (myGeneration !== generation) {
      // Superseded while the register was in flight.
      if (session) void stopVodAudioRemux(session.sessionId)
      return
    }
    if (!session) {
      if (options.mountRemuxImmediately) {
        // The original container can't play here, so there is nothing to stay on.
        log.warn("[xt:vod-audio-switch] mandatory remux failed to register, nothing is mounted")
        reportRemuxUnrecoverable("register_vod_audio_remux failed")
      } else {
        log.warn("[xt:vod-audio-switch] register_vod_audio_remux failed, staying on the current mount")
      }
      activeTrackId = previousTrackId
      notify()
      return
    }
    activeSessionId = session.sessionId
    if (options.mountRemuxImmediately) {
      log.info("[xt:vod-mount] remux session registered", { sessionId: session.sessionId })
      armMidPlayHealthyResetTimer()
    }
    armProgrammaticSeekSuppression()
    options.handle.src({
      src: session.playbackUrl,
      type: "video/mp2t",
      isLive: false,
      durationSeconds: options.getKnownDurationSeconds(),
      timelineOffsetSeconds: startSeconds,
      subtitles: options.originalSubtitles ?? null,
      audio: sourceHandle,
    })
    attachSeekInterceptor()
    playQuietly()
  }

  const unsubscribeError = onVodAudioError((payload) => {
    if (disposed || payload.sessionId !== activeSessionId) return
    if (options.mountRemuxImmediately) {
      // Remounting the original source would just fail (MEDIA_ERR_SRC_NOT_SUPPORTED).
      attemptMidPlayRestart(payload.sessionId, payload.detail)
      return
    }
    log.warn(
      "[xt:vod-audio-switch] remux session failed mid-play, falling back to the original audio:",
      payload.detail,
    )
    const capturedTimeSeconds = currentPlayheadSeconds()
    // Server already tore the failed session down; nothing left to stop.
    remountOriginal(capturedTimeSeconds, null)
    notify()
    toastError(t("player.audio.switchFailed"))
  })

  function disposeAll(): void {
    if (disposed) return
    disposed = true
    bumpGeneration()
    clearMidPlayHealthyResetTimer()
    detachSeekInterceptor()
    unsubscribeError()
    if (activeSessionId) {
      const sessionId = activeSessionId
      activeSessionId = null
      void stopVodAudioRemux(sessionId)
    }
    listeners.clear()
  }

  function recoverRemuxStall(): void {
    if (!options.mountRemuxImmediately || disposed || remuxUnrecoverableReported) return
    if (!activeSessionId) return
    attemptMidPlayRestart(activeSessionId, "stall watchdog detected no playback progress")
  }

  function isRecovering(): boolean {
    return midPlayRestartInFlight
  }

  function setTracks(nextTracks: VodAudioTrackOption[]): void {
    if (disposed || nextTracks.length === 0) return
    const playingAudioStreamIndex = (activeTrackId && tracksById.get(activeTrackId)?.audioStreamIndex) ?? 0
    tracks = nextTracks
    tracksById = new Map(tracks.map((track) => [track.id, track]))
    defaultTrackId = (tracks.find((track) => track.isDefault) ?? tracks[0] ?? null)?.id ?? null
    // Only move the selection marker onto the matching discovered track; never remount for this.
    const matchingPlayingTrack = tracks.find((track) => track.audioStreamIndex === playingAudioStreamIndex)
    if (matchingPlayingTrack) activeTrackId = matchingPlayingTrack.id
    notify()
  }

  const sourceHandle: AudioTrackSource = {
    list() {
      return labelAudioTracks(
        tracks.map((track) => ({
          id: track.id,
          name: track.name ?? null,
          language: track.language ?? null,
          active: track.id === activeTrackId,
        })),
      )
    },
    select(id) {
      if (disposed || id === activeTrackId) return
      // With a mandatory remux mount, even the "default" track goes through the remux path.
      if (id === defaultTrackId && !options.mountRemuxImmediately) {
        const capturedTimeSeconds = currentPlayheadSeconds()
        const sessionToStop = activeSessionId
        remountOriginal(capturedTimeSeconds, sessionToStop)
        notify()
        return
      }
      void switchToRemux(id, currentPlayheadSeconds())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: disposeAll,
  }

  if (options.mountRemuxImmediately && defaultTrackId) {
    void switchToRemux(defaultTrackId, Math.max(0, options.initialStartSeconds ?? 0))
  }

  return { source: sourceHandle, setTracks, recoverRemuxStall, isRecovering, dispose: disposeAll }
}
