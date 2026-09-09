// Writes external mpv playback (progress, completion, audio/sub tracks) back into preferences.js.
import { log } from "@/scripts/lib/log.js"
import {
  getTrackPrefs,
  setProgress,
  markCompleted,
  setTrackPrefs,
  COMPLETED_THRESHOLD,
} from "@/scripts/lib/preferences.js"
import { pickTrack, type TrackCandidate } from "@/scripts/lib/track-match.ts"
import {
  externalPlayersAvailable,
  subscribeExternalPlayerState,
  subscribeExternalPlayerExit,
  setExternalPlayerProperty,
  type ExternalPlayerStateFrame,
} from "@/scripts/lib/player-runtime.ts"

const SESSION_STORAGE_KEY = "xt_ext_session_v1"
const STALE_SESSION_MS = 12 * 60 * 60 * 1000

export interface ExternalSession {
  sessionId: string
  kind: "mpv"
  src: string
  playlistId: string
  contentKind: "vod" | "episode"
  contentId: string
  extras: Record<string, unknown>
  startedAt: number
  trackCorrected?: boolean
  lastSeenAudioId?: number | null
  lastSeenSubId?: number | null
}

interface StoredTrackPrefs {
  audioLang: string | null
  audioId: number | null
  audioTitle: string | null
  subLang: string | null
  subId: number | null
  subTitle: string | null
  subOff: boolean
}

export interface ApplyExternalFrameDeps {
  getTrackPrefs(
    playlistId: string,
    kind: "vod" | "episode",
    id: string,
  ): StoredTrackPrefs | null
}

export type ExternalProgressWrite =
  | { type: "progress"; position: number; duration: number }
  | { type: "completed"; duration: number }
  | { type: "tracks"; patch: Partial<StoredTrackPrefs> }
  | { type: "setProperty"; name: "aid" | "sid"; value: unknown }

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

/** Pure core: maps one mpv state frame onto preference writes, given the session it belongs to. */
export function applyExternalFrame(
  session: ExternalSession,
  frame: ExternalPlayerStateFrame,
  deps: ApplyExternalFrameDeps,
): { session: ExternalSession | null; writes: ExternalProgressWrite[] } {
  if (frame.sessionId !== session.sessionId) return { session, writes: [] }
  if (Date.now() - session.startedAt > STALE_SESSION_MS) return { session, writes: [] }
  // A mismatched path can arrive from a reused mpv instance's stale event; ignore it, don't kill tracking.
  if (frame.path != null && stripTrailingSlash(frame.path) !== stripTrailingSlash(session.src)) {
    return { session, writes: [] }
  }

  const writes: ExternalProgressWrite[] = []
  const hasPosition =
    typeof frame.position === "number" && typeof frame.duration === "number" && frame.duration > 0
  if (hasPosition) {
    writes.push({ type: "progress", position: frame.position as number, duration: frame.duration as number })
  }
  const fraction = hasPosition ? (frame.position as number) / (frame.duration as number) : 0
  if (frame.eof || (hasPosition && fraction >= COMPLETED_THRESHOLD)) {
    writes.push({ type: "completed", duration: frame.duration || 0 })
  }

  let nextSession = session
  const wasCorrected = session.trackCorrected === true

  if (frame.tracks != null && !session.trackCorrected) {
    const prefs = deps.getTrackPrefs(session.playlistId, session.contentKind, session.contentId)
    if (prefs) {
      const audioTracks: TrackCandidate[] = frame.tracks.filter((track) => track.type === "audio")
      const subTracks: TrackCandidate[] = frame.tracks.filter((track) => track.type === "sub")
      const currentAudioId = frame.tracks.find((track) => track.type === "audio" && track.selected)?.id ?? null
      const currentSubId = frame.tracks.find((track) => track.type === "sub" && track.selected)?.id ?? null

      const pickedAudioId = pickTrack(audioTracks, {
        lang: prefs.audioLang,
        id: prefs.audioId,
        title: prefs.audioTitle,
      })
      if (pickedAudioId != null && pickedAudioId !== currentAudioId) {
        writes.push({ type: "setProperty", name: "aid", value: pickedAudioId })
      }

      if (prefs.subOff) {
        if (currentSubId != null) writes.push({ type: "setProperty", name: "sid", value: "no" })
      } else {
        const pickedSubId = pickTrack(subTracks, { lang: prefs.subLang, id: prefs.subId, title: prefs.subTitle })
        if (pickedSubId != null && pickedSubId !== currentSubId) {
          writes.push({ type: "setProperty", name: "sid", value: pickedSubId })
        }
      }
    }
    nextSession = { ...nextSession, trackCorrected: true }
  }

  if (frame.audio != null || frame.sub != null) {
    const audioId = frame.audio?.id ?? null
    const subId = frame.sub?.id ?? null
    const hasBaseline = session.lastSeenAudioId !== undefined && session.lastSeenSubId !== undefined
    if (wasCorrected && hasBaseline && (audioId !== session.lastSeenAudioId || subId !== session.lastSeenSubId)) {
      writes.push({
        type: "tracks",
        patch: {
          ...(frame.audio != null
            ? { audioLang: frame.audio.lang, audioId: frame.audio.id, audioTitle: frame.audio.title }
            : {}),
          ...(frame.sub != null ? { subLang: frame.sub.lang, subId: frame.sub.id, subTitle: frame.sub.title } : {}),
          subOff: frame.subOff,
        },
      })
    }
    nextSession = { ...nextSession, lastSeenAudioId: audioId, lastSeenSubId: subId }
  }

  return { session: nextSession, writes }
}

let activeSession: ExternalSession | null = null

function readStoredSession(): ExternalSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as ExternalSession) : null
  } catch {
    return null
  }
}

function writeStoredSession(session: ExternalSession | null): void {
  try {
    if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_STORAGE_KEY)
  } catch (err) {
    log.warn("[xt:external-progress] failed to persist session:", err)
  }
}

/** Call right after a successful mpv external launch, only when the launch returned a sessionId. */
export function beginExternalSession(session: ExternalSession): void {
  activeSession = session
  writeStoredSession(session)
}

function executeWrite(session: ExternalSession, write: ExternalProgressWrite): void {
  if (write.type === "progress") {
    setProgress(session.playlistId, session.contentKind, session.contentId, write.position, write.duration, session.extras)
  } else if (write.type === "completed") {
    markCompleted(session.playlistId, session.contentKind, session.contentId, {
      duration: write.duration,
      ...session.extras,
    })
  } else if (write.type === "tracks") {
    setTrackPrefs(session.playlistId, session.contentKind, session.contentId, write.patch)
  } else if (write.type === "setProperty") {
    void setExternalPlayerProperty("mpv", session.sessionId, write.name, write.value)
  }
}

let mounted = false

/** Idempotent; no-op off desktop or when external players are sandboxed. */
export function mountExternalProgressRecorder(): void {
  if (mounted) return
  mounted = true
  if (!externalPlayersAvailable) return
  if (!activeSession) activeSession = readStoredSession()

  subscribeExternalPlayerState((frame: ExternalPlayerStateFrame) => {
    const session = activeSession
    if (!session) return
    const result = applyExternalFrame(session, frame, { getTrackPrefs })
    activeSession = result.session
    writeStoredSession(activeSession)
    for (const write of result.writes) executeWrite(session, write)
  })

  subscribeExternalPlayerExit((kind) => {
    if (kind !== "mpv") return
    activeSession = null
    writeStoredSession(null)
  })
}
