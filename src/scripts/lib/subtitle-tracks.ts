// Per-player subtitle manager: lazy per-track MP4 cue extraction, subtitles off by default.
import { log } from "@/scripts/lib/log.js"
import { t } from "@/scripts/lib/i18n.js"
import { toastError } from "@/scripts/lib/toast.js"
import {
  isMp4SubtitleCapableUrl,
  openMp4SubtitleSession,
  type Mp4SubtitleSession,
  type SubtitleCue,
} from "@/scripts/lib/mp4-subtitles.js"

export interface SubtitleRegistrar {
  addTrack(label: string, language: string): TextTrack | null
  removeAllTracks(): void
  trackListTarget(): EventTarget | null
}

export interface SubtitleManagerOptions {
  registrar: SubtitleRegistrar
  getCurrentTime: () => number
  onTracksReady?: (tracks: { index: number; label: string; language: string }[]) => void
}

export interface SubtitleManager {
  setSource(sourceUrl: string | null, mimeType?: string | null): void
  select(index: number): void
  detach(): void
}

interface ManagedTrack {
  trackId: number
  textTrack: TextTrack
  loaded: boolean
  loading: boolean
}

// TextTrack.cues is null while mode is "disabled" per spec, so draining needs a live mode first.
function drainTextTrackCues(track: TextTrack, restoreMode: TextTrackMode): void {
  if (track.mode === "disabled") track.mode = "hidden"
  while (track.cues && track.cues.length) {
    track.removeCue(track.cues[0]!)
  }
  track.mode = restoreMode
}

export function createSubtitleManager(options: SubtitleManagerOptions): SubtitleManager {
  const { registrar, getCurrentTime, onTracksReady } = options

  let managedTracks: ManagedTrack[] = []
  let session: Mp4SubtitleSession | null = null
  let sourceController: AbortController | null = null
  let extractionController: AbortController | null = null
  let activeExtractionIndex: number | null = null
  let currentSourceUrl: string | null = null
  let toastShownForSource = false
  let trackListTarget: EventTarget | null = null

  function addCues(textTrack: TextTrack, cues: SubtitleCue[]): void {
    const VTTCueCtor = (window as any).VTTCue
    if (!VTTCueCtor) return
    for (const cue of cues) {
      try {
        textTrack.addCue(new VTTCueCtor(cue.startSeconds, cue.endSeconds, cue.text))
      } catch (err) {
        log.warn("[xt:subtitles] failed to add cue:", err)
      }
    }
  }

  function startExtraction(index: number): void {
    const managed = managedTracks[index]
    if (!managed || !session) return
    if (managed.loaded || (managed.loading && activeExtractionIndex === index)) return
    if (typeof (window as any).VTTCue === "undefined") {
      log.warn("[xt:subtitles] VTTCue unsupported, skipping subtitle extraction")
      return
    }
    // A restart after a mid-flight abort would re-add the partial run's cues.
    drainTextTrackCues(managed.textTrack, managed.textTrack.mode)
    extractionController?.abort()
    const controller = new AbortController()
    extractionController = controller
    activeExtractionIndex = index
    managed.loading = true
    session
      .extract(managed.trackId, {
        startAtSeconds: Math.max(0, getCurrentTime() - 1),
        signal: controller.signal,
        onCues: (cues) => addCues(managed.textTrack, cues),
      })
      .then(() => {
        managed.loading = false
        // An aborted run resolves quietly; only an uninterrupted run counts as loaded.
        if (!controller.signal.aborted) managed.loaded = true
        if (activeExtractionIndex === index) activeExtractionIndex = null
      })
      .catch((err) => {
        managed.loading = false
        if (activeExtractionIndex === index) activeExtractionIndex = null
        if (err?.name === "AbortError") return
        log.warn("[xt:subtitles] extraction failed:", err)
        if (!toastShownForSource) {
          toastShownForSource = true
          toastError(t("player.subtitles.error"))
        }
      })
  }

  function onTrackListChange(): void {
    managedTracks.forEach((managed, index) => {
      if (managed.textTrack.mode === "disabled") return
      startExtraction(index)
    })
  }

  function teardownTracks(): void {
    if (trackListTarget) {
      trackListTarget.removeEventListener("change", onTrackListChange)
      trackListTarget = null
    }
    registrar.removeAllTracks()
    managedTracks = []
  }

  function setSource(sourceUrl: string | null, mimeType?: string | null): void {
    sourceController?.abort()
    extractionController?.abort()
    sourceController = null
    extractionController = null
    activeExtractionIndex = null
    session = null
    currentSourceUrl = sourceUrl
    toastShownForSource = false
    teardownTracks()

    if (!sourceUrl || !isMp4SubtitleCapableUrl(sourceUrl, mimeType ?? null)) return

    const controller = new AbortController()
    sourceController = controller
    openMp4SubtitleSession(sourceUrl, { signal: controller.signal })
      .then((openedSession) => {
        if (currentSourceUrl !== sourceUrl || controller.signal.aborted || !openedSession) return
        session = openedSession
        trackListTarget = registrar.trackListTarget()
        trackListTarget?.addEventListener("change", onTrackListChange)
        const readyTracks: { index: number; label: string; language: string }[] = []
        for (const trackInfo of openedSession.tracks) {
          const textTrack = registrar.addTrack(trackInfo.label, trackInfo.language)
          if (!textTrack) continue
          textTrack.mode = "disabled"
          const index = managedTracks.length
          managedTracks.push({ trackId: trackInfo.trackId, textTrack, loaded: false, loading: false })
          readyTracks.push({ index, label: trackInfo.label, language: trackInfo.language })
        }
        if (readyTracks.length) onTracksReady?.(readyTracks)
      })
      .catch((err) => {
        if (err?.name === "AbortError") return
        log.warn("[xt:subtitles] failed to open subtitle session:", err)
      })
  }

  function select(index: number): void {
    managedTracks.forEach((managed, managedIndex) => {
      managed.textTrack.mode = managedIndex === index ? "showing" : "disabled"
    })
    if (activeExtractionIndex !== null && activeExtractionIndex !== index) {
      extractionController?.abort()
      const stale = managedTracks[activeExtractionIndex]
      if (stale) stale.loading = false
      activeExtractionIndex = null
    }
    if (index >= 0) startExtraction(index)
  }

  function detach(): void {
    sourceController?.abort()
    extractionController?.abort()
    sourceController = null
    extractionController = null
    activeExtractionIndex = null
    session = null
    currentSourceUrl = null
    teardownTracks()
  }

  return { setSource, select, detach }
}

// No removeTextTrack API exists, so removed native tracks are drained and pooled for reuse.
export function createNativeTrackRegistrar(
  getVideo: () => HTMLVideoElement | null,
): SubtitleRegistrar {
  const pool = new Map<string, TextTrack[]>()
  const managed: TextTrack[] = []

  function poolKey(language: string, label: string): string {
    return `${language}|${label}`
  }

  function drainCues(track: TextTrack): void {
    drainTextTrackCues(track, "disabled")
  }

  return {
    addTrack(label, language) {
      const video = getVideo()
      if (!video) return null
      const key = poolKey(language, label)
      const bucket = pool.get(key)
      const reused = bucket?.pop()
      if (reused) {
        drainCues(reused)
        managed.push(reused)
        return reused
      }
      const track = video.addTextTrack("subtitles", label, language)
      managed.push(track)
      return track
    },
    removeAllTracks() {
      for (const track of managed) {
        drainCues(track)
        const key = poolKey(track.language, track.label)
        const bucket = pool.get(key) ?? []
        bucket.push(track)
        pool.set(key, bucket)
      }
      managed.length = 0
    },
    trackListTarget() {
      return getVideo()?.textTracks ?? null
    },
  }
}

// videojs emulated tracks; manualCleanup true so removal stays ours, cues are added programmatically.
export function createVideoJsTrackRegistrar(player: any): SubtitleRegistrar {
  const elements: any[] = []

  return {
    addTrack(label, language) {
      const htmlTrackElement = player.addRemoteTextTrack(
        { kind: "subtitles", label, srclang: language },
        true,
      )
      if (!htmlTrackElement) return null
      elements.push(htmlTrackElement)
      return htmlTrackElement.track ?? null
    },
    removeAllTracks() {
      for (const element of elements) {
        try { player.removeRemoteTextTrack(element) } catch {}
      }
      elements.length = 0
    },
    trackListTarget() {
      return (player.textTracks?.() ?? null) as EventTarget | null
    },
  }
}
