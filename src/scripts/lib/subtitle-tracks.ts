// Per-player subtitle manager: lazy per-track MP4 cue extraction, subtitles off by default.
import { log } from "@/scripts/lib/log.js"
import { t, getActiveLocale } from "@/scripts/lib/i18n.js"
import { getCaptionsAutoEnabled } from "@/scripts/lib/app-settings.js"
import { toastError } from "@/scripts/lib/toast.js"
import {
  isMp4SubtitleCapableUrl,
  openMp4SubtitleSession,
  buildTrackLabels,
  type Mp4SubtitleSession,
  type SubtitleCue,
} from "@/scripts/lib/mp4-subtitles.js"
import type { MkvSubtitleSession, MkvCue } from "@/scripts/lib/vod-proxy.js"

export interface SubtitleRegistrar {
  addTrack(label: string, language: string): TextTrack | null
  removeAllTracks(): void
  trackListTarget(): EventTarget | null
}

export interface SubtitleManagerOptions {
  registrar: SubtitleRegistrar
  getCurrentTime: () => number
  /** -1 unless a selection carried over from a remount or captions-auto picked one. */
  onTracksReady?: (tracks: { index: number; label: string; language: string }[], activeIndex: number) => void
}

export interface SubtitleManager {
  setSource(sourceUrl: string | null, mimeType?: string | null, mkvSession?: MkvSubtitleSession | null): void
  select(index: number): void
  /** Shifts cue times by delta; delta 0 probes the offset without shifting. */
  nudgeDelay(deltaSeconds: number): number | null
  detach(): void
}

interface PushCueState {
  trackNumber: number
  pending: SubtitleCue[]
  flushedCount: number
  seen: Set<string>
}

interface ManagedTrack {
  kind: "mp4" | "push"
  trackId: number
  textTrack: TextTrack
  loaded: boolean
  loading: boolean
  pushState?: PushCueState
}

// TextTrack.cues is null while mode is "disabled" per spec, so draining needs a live mode first.
function drainTextTrackCues(track: TextTrack, restoreMode: TextTrackMode): void {
  if (track.mode === "disabled") track.mode = "hidden"
  while (track.cues && track.cues.length) {
    track.removeCue(track.cues[0]!)
  }
  track.mode = restoreMode
}

function primarySubtag(languageTag: string): string {
  return languageTag.split("-")[0]?.toLowerCase() ?? ""
}

export function pickAutoCaptionTrack(
  tracks: { index: number; label: string; language: string }[],
  locale: string,
): number {
  if (!tracks.length) return -1
  const localePrimary = primarySubtag(locale)
  const match = tracks.find((track) => track.language && primarySubtag(track.language) === localePrimary)
  return (match ?? tracks[0])!.index
}

export function createSubtitleManager(options: SubtitleManagerOptions): SubtitleManager {
  const { registrar, getCurrentTime, onTracksReady } = options

  let managedTracks: ManagedTrack[] = []
  let session: Mp4SubtitleSession | null = null
  let activeMkvSession: MkvSubtitleSession | null = null
  let sourceController: AbortController | null = null
  let extractionController: AbortController | null = null
  let activeExtractionIndex: number | null = null
  let currentSourceUrl: string | null = null
  let toastShownForSource = false
  let trackListTarget: EventTarget | null = null
  // Viewer's pick, kept across remounts (audio-track switch)
  let selectionSourceIdentity: MkvSubtitleSession | string | null = null
  let rememberedTrackKey: string | null = null
  // Distinguishes "never touched" from "explicitly turned off" (both collapse rememberedTrackKey to null)
  let hasMadeSubtitleSelection = false
  let offsetSeconds = 0

  function trackKeyOf(managed: ManagedTrack): string {
    return managed.kind === "push" ? `push:${managed.pushState?.trackNumber}` : `mp4:${managed.trackId}`
  }

  function rememberShowingTrack(): void {
    const showing = managedTracks.find((managed) => managed.textTrack.mode !== "disabled")
    rememberedTrackKey = showing ? trackKeyOf(showing) : null
  }

  function restoreRememberedSelection(): number {
    if (!rememberedTrackKey) return -1
    const index = managedTracks.findIndex((managed) => trackKeyOf(managed) === rememberedTrackKey)
    if (index < 0) return -1
    const managed = managedTracks[index]!
    managed.textTrack.mode = "showing"
    if (managed.kind === "push") flushPushCues(managed)
    else startExtraction(index)
    return index
  }

  function resolveInitialSelection(
    readyTracks: { index: number; label: string; language: string }[],
  ): number {
    const restoredIndex = restoreRememberedSelection()
    if (restoredIndex >= 0) return restoredIndex
    if (hasMadeSubtitleSelection || !readyTracks.length || !getCaptionsAutoEnabled()) return -1
    const autoIndex = pickAutoCaptionTrack(readyTracks, getActiveLocale())
    const managed = autoIndex >= 0 ? managedTracks[autoIndex] : undefined
    if (!managed) return -1
    managed.textTrack.mode = "showing"
    if (managed.kind === "push") flushPushCues(managed)
    else startExtraction(autoIndex)
    rememberShowingTrack()
    return autoIndex
  }

  function addCues(textTrack: TextTrack, cues: SubtitleCue[]): void {
    const VTTCueCtor = (window as any).VTTCue
    if (!VTTCueCtor) return
    for (const cue of cues) {
      try {
        textTrack.addCue(new VTTCueCtor(cue.startSeconds + offsetSeconds, cue.endSeconds + offsetSeconds, cue.text))
      } catch (err) {
        log.warn("[xt:subtitles] failed to add cue:", err)
      }
    }
  }

  function nudgeDelay(deltaSeconds: number): number | null {
    const hasShowingTrack = managedTracks.some((managed) => managed.textTrack.mode === "showing")
    if (!hasShowingTrack) return null
    if (deltaSeconds === 0) return offsetSeconds
    const roundedNewOffset = Math.round((offsetSeconds + deltaSeconds) * 1000) / 1000
    // Apply the rounded delta so cue times never drift sub-ms from the reported offset.
    const cueDelta = roundedNewOffset - offsetSeconds
    offsetSeconds = roundedNewOffset
    for (const managed of managedTracks) {
      const track = managed.textTrack
      const restoreMode = track.mode
      if (track.mode === "disabled") track.mode = "hidden"
      // Snapshot first: mutating startTime while iterating the live, time-sorted list can reorder it mid-loop.
      const cueSnapshot = track.cues ? Array.from(track.cues) : []
      for (const cue of cueSnapshot) {
        try {
          cue.startTime += cueDelta
          cue.endTime += cueDelta
        } catch (err) {
          log.warn("[xt:subtitles] failed to shift cue:", err)
        }
      }
      track.mode = restoreMode
    }
    return offsetSeconds
  }

  function startExtraction(index: number): void {
    const managed = managedTracks[index]
    if (!managed || managed.kind !== "mp4" || !session) return
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

  function flushPushCues(managed: ManagedTrack): void {
    const pushState = managed.pushState
    if (!pushState || pushState.flushedCount >= pushState.pending.length) return
    addCues(managed.textTrack, pushState.pending.slice(pushState.flushedCount))
    pushState.flushedCount = pushState.pending.length
  }

  function handlePushCues(managed: ManagedTrack, trackNumber: number, cues: MkvCue[]): void {
    const pushState = managed.pushState
    if (!pushState || pushState.trackNumber !== trackNumber) return
    const freshEntries: SubtitleCue[] = []
    for (const cue of cues) {
      const cueKey = `${cue.startMs}:${cue.text}`
      if (pushState.seen.has(cueKey)) continue
      pushState.seen.add(cueKey)
      const entry: SubtitleCue = {
        startSeconds: cue.startMs / 1000,
        endSeconds: cue.endMs / 1000,
        text: cue.text,
      }
      pushState.pending.push(entry)
      freshEntries.push(entry)
    }
    if (!freshEntries.length) return
    if (managed.textTrack.mode !== "disabled") {
      addCues(managed.textTrack, freshEntries)
      pushState.flushedCount = pushState.pending.length
    }
  }

  function onTrackListChange(): void {
    // videojs flips track modes directly instead of calling select().
    hasMadeSubtitleSelection = true
    rememberShowingTrack()
    managedTracks.forEach((managed, index) => {
      if (managed.textTrack.mode === "disabled") return
      if (managed.kind === "push") {
        flushPushCues(managed)
        return
      }
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

  function attachMkvSession(sourceUrl: string | null, mkvSession: MkvSubtitleSession, signal: AbortSignal): void {
    mkvSession
      .tracks()
      .then((tracks) => {
        if (currentSourceUrl !== sourceUrl || signal.aborted || !tracks.length) return

        trackListTarget = registrar.trackListTarget()
        trackListTarget?.addEventListener("change", onTrackListChange)

        const rawTracks = tracks.map((track) => ({
          trackId: track.number,
          language: track.language ?? "",
          sampleCount: 0,
          name: track.name,
        }))
        const labeledTracks = buildTrackLabels(rawTracks, getActiveLocale())

        const readyTracks: { index: number; label: string; language: string }[] = []
        labeledTracks.forEach((labeledTrack, position) => {
          const textTrack = registrar.addTrack(labeledTrack.label, labeledTrack.language)
          if (!textTrack) return
          textTrack.mode = "disabled"
          const index = managedTracks.length
          managedTracks.push({
            kind: "push",
            trackId: labeledTrack.trackId,
            textTrack,
            loaded: true,
            loading: false,
            pushState: { trackNumber: tracks[position].number, pending: [], flushedCount: 0, seen: new Set() },
          })
          readyTracks.push({ index, label: labeledTrack.label, language: labeledTrack.language })
        })
        const selectedIndex = resolveInitialSelection(readyTracks)
        if (readyTracks.length) onTracksReady?.(readyTracks, selectedIndex)

        mkvSession.onCues((trackNumber, cues) => {
          if (currentSourceUrl !== sourceUrl || signal.aborted) return
          const managed = managedTracks.find(
            (track) => track.kind === "push" && track.pushState?.trackNumber === trackNumber,
          )
          if (managed) handlePushCues(managed, trackNumber, cues)
        })
      })
      .catch((err) => {
        log.warn("[xt:subtitles] mkv session tracks() failed:", err)
      })
  }

  function setSource(
    sourceUrl: string | null,
    mimeType?: string | null,
    mkvSession?: MkvSubtitleSession | null,
  ): void {
    sourceController?.abort()
    extractionController?.abort()
    sourceController = null
    extractionController = null
    activeExtractionIndex = null
    session = null
    currentSourceUrl = sourceUrl
    toastShownForSource = false
    offsetSeconds = 0
    teardownTracks()
    // Same mkvSession can return on remux remount; don't stop a tee still in use.
    const incomingMkvSession = mkvSession ?? null
    if (activeMkvSession && activeMkvSession !== incomingMkvSession) {
      try { activeMkvSession.stop() } catch (err) { log.warn("[xt:subtitles] mkv session stop() failed:", err) }
    }
    activeMkvSession = incomingMkvSession

    // Identity: mkvSession for MKV, URL for MP4; stable across remux remounts.
    const incomingIdentity: MkvSubtitleSession | string | null = incomingMkvSession ?? sourceUrl
    if (!incomingIdentity || incomingIdentity !== selectionSourceIdentity) {
      rememberedTrackKey = null
      hasMadeSubtitleSelection = false
    }
    selectionSourceIdentity = incomingIdentity

    if (incomingMkvSession) {
      const controller = new AbortController()
      sourceController = controller
      attachMkvSession(sourceUrl, incomingMkvSession, controller.signal)
      return
    }

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
          managedTracks.push({ kind: "mp4", trackId: trackInfo.trackId, textTrack, loaded: false, loading: false })
          readyTracks.push({ index, label: trackInfo.label, language: trackInfo.language })
        }
        const selectedIndex = resolveInitialSelection(readyTracks)
        if (readyTracks.length) onTracksReady?.(readyTracks, selectedIndex)
      })
      .catch((err) => {
        if (err?.name === "AbortError") return
        log.warn("[xt:subtitles] failed to open subtitle session:", err)
      })
  }

  function select(index: number): void {
    hasMadeSubtitleSelection = true
    managedTracks.forEach((managed, managedIndex) => {
      managed.textTrack.mode = managedIndex === index ? "showing" : "disabled"
    })
    rememberShowingTrack()
    if (activeExtractionIndex !== null && activeExtractionIndex !== index) {
      extractionController?.abort()
      const stale = managedTracks[activeExtractionIndex]
      if (stale) stale.loading = false
      activeExtractionIndex = null
    }
    if (index < 0) return
    const managed = managedTracks[index]
    if (managed?.kind === "push") flushPushCues(managed)
    else startExtraction(index)
  }

  function detach(): void {
    sourceController?.abort()
    extractionController?.abort()
    sourceController = null
    extractionController = null
    activeExtractionIndex = null
    session = null
    currentSourceUrl = null
    selectionSourceIdentity = null
    rememberedTrackKey = null
    hasMadeSubtitleSelection = false
    offsetSeconds = 0
    if (activeMkvSession) {
      try { activeMkvSession.stop() } catch (err) { log.warn("[xt:subtitles] mkv session stop() failed:", err) }
      activeMkvSession = null
    }
    teardownTracks()
  }

  return { setSource, select, nudgeDelay, detach }
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
