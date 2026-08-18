// Shared container-plan-through-tune VOD mount pipeline for the movie and series detail pages.
import { log } from "@/scripts/lib/log.js"
import { toastError } from "@/scripts/lib/toast.js"
import { chooseMime } from "@/scripts/lib/morph-detail.js"
import {
  playWhenReady,
  desktopPlatform,
  isWindows,
  type VjsLikeHandle,
} from "@/scripts/lib/player-runtime.ts"
import { prepareVodPlayback, prepareLocalVodPlayback, type VodProxySession } from "@/scripts/lib/vod-proxy.ts"
import { vodAudioRemuxAvailable } from "@/scripts/lib/vod-audio-proxy.ts"
import {
  createVodAudioSwitcher,
  discoverVodAudioTracks,
  type VodAudioSwitcher,
  type VodAudioTrackOption,
} from "@/scripts/lib/vod-audio-switch.ts"
import type { AudioTrackSource } from "@/scripts/lib/audio-tracks.ts"
import {
  planVodContainerPlayback,
  planLocalVodContainerPlayback,
  detectVodContainer,
  detectVodContainerFromLocalPath,
  type VodContainerPlan,
  type VodContainerPlanEnv,
} from "@/scripts/lib/vod-container-plan.ts"
import { probeVodContainerAlternative, swapUrlExtension } from "@/scripts/lib/vod-container-probe.ts"
import { buildRemuxContentKey, isRemuxPinnedContent, type RemuxContentKind } from "@/scripts/lib/vod-remux-memory.ts"
import { attachQualityChip } from "@/scripts/lib/quality-badge.ts"
import { shouldTrustEndedEvent } from "@/scripts/lib/premature-ended.ts"
import type { StallWatchdogHandle } from "@/scripts/lib/stall-watchdog.ts"
import type { VodPlaybackToasts } from "@/scripts/lib/vod-playback-toasts.ts"
import {
  createRemuxFailureHandler,
  handlePlayerStartError,
  attachVodStallWatchdog,
} from "@/scripts/lib/vod-remux-recovery.ts"

export interface VodMountOptions {
  logTag: string
  /** Exact log-tag prefix for the "ignoring a premature ended event" line only. */
  prematureEndedLogTag: string
  contentId: number
  remuxContentKind: RemuxContentKind
  playlistId: string | null
  playSrc: string
  /** Fallback URL for MIME sniffing when the container plan didn't already resolve one. */
  mimeFallbackSrc: string
  localDownloadPath: string | null
  savedProgress: { duration?: number } | null
  resumePos: number
  /** Name searched for an HEVC hint when no codec is reported (movie name / episode title). */
  nameHintSource: string
  posterEl: HTMLElement | null
  playerWrap: HTMLElement | null
  videoElementId: string
  backend: string
  isAutomaticRetry: boolean
  ensureEmbeddedPlayer(backend: string): Promise<VjsLikeHandle | null>
  /** Binds the pip/scale/stats/health buttons and the subtitle-delay controller for this mount. */
  setupPlayerUi(player: VjsLikeHandle): void
  applyVideoScale(): void
  toasts: VodPlaybackToasts
  recordGiveUp(kind: string): void
  endGiveUpSession(): void
  clearAudioSwitcherIfOwn(own: VodAudioSwitcher | null): void
  clearActiveMkvSessionIfMatches(session: { stop(): void } | null | undefined): void
  isStale(): boolean
  retirePreviousPlaybackAndRetryRemux(): void
  /** Fallback session start on an automatic remux retry vs. a fresh insights session. */
  beginInsightsSession(isAutomaticRetry: boolean): void
  /** Known duration used to seed this mount's audio switcher (movie: cached vod info; episode: the specific episode played). */
  getKnownDurationSecondsForSwitcher(): number
  /** Known duration for the bound-once ended listener, read live so it always reflects whatever is currently playing. */
  getKnownDurationSecondsForEnded(): number | null
  getAudioSwitcher(): VodAudioSwitcher | null
  setAudioSwitcher(switcher: VodAudioSwitcher | null): void
  setActiveMkvSession(session: { stop(): void } | null | undefined): void
  setAudioDiscoveryController(controller: AbortController): void
  /** Detaches any previous stall watchdog before storing the new one. */
  replaceStallWatchdog(detach: StallWatchdogHandle | null): void
  setQualityChipDetach(detach: (() => void) | null): void
  /** Registers the timeupdate/ended listeners exactly once for the page's lifetime. */
  bindProgressListenersOnce(registerListeners: () => void): void
  /** Whether there is still a live playlist + item to write progress for; read live, not at mount time. */
  hasActiveContent(): boolean
  writeProgress(positionSeconds: number, durationSeconds: number): void
  recordPlaybackEndedSession(): void
  markContentCompleted(durationSeconds: number): void
  onMounted(): void
}

/** Container plan, player mount, resume-seek, remux/audio-switcher setup, stall watchdog, and progress/ended listeners. */
export async function mountVodPlayback(options: VodMountOptions): Promise<void> {
  const mountStartedAt = Date.now()
  const remuxAvailable = await vodAudioRemuxAvailable()
  const remuxContentKey = buildRemuxContentKey(options.remuxContentKind, options.contentId)
  const forceRemux = options.playlistId ? isRemuxPinnedContent(options.playlistId, remuxContentKey) : false
  const containerPlanEnv: VodContainerPlanEnv = { isTauriDesktop: desktopPlatform, isWindows, remuxAvailable, forceRemux }
  let playSrc = options.playSrc
  let mimeFallbackSrc = options.mimeFallbackSrc
  let containerPlan: VodContainerPlan = options.localDownloadPath
    ? planLocalVodContainerPlayback(options.localDownloadPath, containerPlanEnv)
    : planVodContainerPlayback(playSrc, containerPlanEnv)
  let resolvedContainer: "mkv" | "mp4" | null = null

  if (containerPlan.mode === "unsupported" && containerPlan.container === "avi" && !options.localDownloadPath) {
    const alternative = await probeVodContainerAlternative(playSrc)
    if (options.isStale()) return
    if (alternative) {
      log.info(`${options.logTag} avi source has a playable alternative container`, {
        container: alternative.container,
      })
      playSrc = alternative.url
      mimeFallbackSrc = alternative.url
      resolvedContainer = alternative.container
      const planningUrl = swapUrlExtension(alternative.url, alternative.container) || alternative.url
      containerPlan = planVodContainerPlayback(planningUrl, containerPlanEnv)
    }
  }

  const detectedContainer = containerPlan.mode === "unsupported"
    ? containerPlan.container
    : options.localDownloadPath
      ? detectVodContainerFromLocalPath(options.localDownloadPath)
      : resolvedContainer || detectVodContainer(playSrc)
  log.info("[xt:vod-mount] plan decided", {
    mode: containerPlan.mode,
    container: detectedContainer,
    isTauriDesktop: desktopPlatform,
    isWindows,
    remuxAvailable,
    forceRemux,
    isLocalDownload: !!options.localDownloadPath,
  })
  if (containerPlan.mode === "unsupported") {
    options.toasts.showContainerUnsupportedToast(containerPlan.container)
    return
  }
  // In remux mode the audio switcher owns the mount; touching src/playhead here would re-register the remux.
  const remuxOwnsInitialMount = containerPlan.mode === "remux"

  if (options.posterEl) options.posterEl.classList.add("hidden")
  if (options.playerWrap) options.playerWrap.classList.remove("hidden")
  document.getElementById(options.videoElementId)?.removeAttribute("hidden")

  let player: VjsLikeHandle | null
  try {
    player = await options.ensureEmbeddedPlayer(options.backend)
  } catch (err) {
    log.error(`${options.logTag} failed to mount player:`, err)
    toastError("Couldn't start playback.")
    if (options.posterEl) options.posterEl.classList.remove("hidden")
    if (options.playerWrap) options.playerWrap.classList.add("hidden")
    return
  }
  if (!player) return
  if (options.isStale()) return
  const mountedPlayer = player
  options.setupPlayerUi(mountedPlayer)
  const mime = resolvedContainer === "mkv"
    ? "video/x-matroska"
    : resolvedContainer === "mp4"
      ? "video/mp4"
      : chooseMime(mimeFallbackSrc)

  const handleRemuxFailure = createRemuxFailureHandler({
    player: mountedPlayer,
    posterEl: options.posterEl,
    playerWrap: options.playerWrap,
    getOwnAudioSwitcher: () => ownAudioSwitcher,
    clearAudioSwitcherIfOwn: options.clearAudioSwitcherIfOwn,
    getPipelineMkvSession: () => preparedPlayback?.mkvSession,
    clearActiveMkvSessionIfMatches: options.clearActiveMkvSessionIfMatches,
    nameHintSource: options.nameHintSource,
    contentKey: remuxContentKey,
    recordGiveUp: options.recordGiveUp,
    endGiveUpSession: options.endGiveUpSession,
    resolvedContainer,
    playSrc,
    toasts: options.toasts,
  })

  // The reused player can emit 'error' mid-await (proxy registration in flight); buffer until init is safe to unwind.
  let pipelineReady = false
  let bufferedStartError = false

  function handleStartError() {
    handlePlayerStartError({
      logTag: options.logTag,
      player: mountedPlayer,
      isStale: options.isStale,
      containerPlanMode: containerPlan.mode,
      desktopPlatform,
      localDownloadPath: options.localDownloadPath,
      resolvedContainer,
      playSrc,
      remuxAvailable,
      activePlaylistId: options.playlistId,
      contentKey: remuxContentKey,
      posterEl: options.posterEl,
      playerWrap: options.playerWrap,
      handleRemuxFailure,
      retirePreviousPlaybackAndRetryRemux: options.retirePreviousPlaybackAndRetryRemux,
      toasts: options.toasts,
    })
  }

  mountedPlayer.one?.("error", () => {
    if (pipelineReady) handleStartError()
    else bufferedStartError = true
  })
  mountedPlayer.one?.("loadedmetadata", () => {
    if (options.isStale()) return
    log.info("[xt:vod-mount] first loadedmetadata", { elapsedMs: Date.now() - mountStartedAt })
  })

  if (options.resumePos > 0 && !remuxOwnsInitialMount) {
    mountedPlayer.one?.("loadedmetadata", () => {
      if (options.isStale()) return
      const dur = mountedPlayer.duration?.() || options.savedProgress?.duration || 0
      if (dur === 0 || options.resumePos / dur < 0.95) {
        try { mountedPlayer.currentTime?.(options.resumePos) } catch {}
      }
    })
  }

  // A local .mkv rides the same tee proxy, fed from its on-disk path since ffmpeg only speaks http/pipe/tcp.
  let prepared: VodProxySession | null
  if (remuxOwnsInitialMount && options.localDownloadPath) {
    prepared = await prepareLocalVodPlayback(options.localDownloadPath)
    if (options.isStale()) {
      prepared?.mkvSession?.stop()
      return
    }
    if (!prepared) {
      log.warn(`${options.logTag} local vod proxy failed to register, cannot remux this download`, {
        contentKey: remuxContentKey,
        container: detectVodContainerFromLocalPath(options.localDownloadPath),
      })
      if (options.posterEl) options.posterEl.classList.remove("hidden")
      if (options.playerWrap) options.playerWrap.classList.add("hidden")
      options.toasts.showContainerUnsupportedToast("mkv")
      return
    }
  } else {
    prepared = await prepareVodPlayback(playSrc)
    if (options.isStale()) {
      prepared.mkvSession?.stop()
      return
    }
  }
  const preparedPlayback = prepared

  // The previous pipeline was already retired by the caller before this mount started.
  const audioDiscoveryController = new AbortController()
  options.setAudioDiscoveryController(audioDiscoveryController)
  const discoverySignal = audioDiscoveryController.signal
  let initialAudioSource: AudioTrackSource | null = null
  // Only this pipeline's switcher, so a superseded pipeline tears down its own sessions and never the live one's.
  let ownAudioSwitcher: VodAudioSwitcher | null = null

  function buildAudioSwitcher(tracks: VodAudioTrackOption[]): VodAudioSwitcher {
    return createVodAudioSwitcher({
      handle: mountedPlayer,
      originalSrc: preparedPlayback.playbackUrl,
      originalMime: mime,
      originalSubtitles: { sourceUrl: playSrc, mkvSession: preparedPlayback.mkvSession },
      sourceUrl: playSrc,
      remuxInputUrl: preparedPlayback.mkvSession ? preparedPlayback.playbackUrl : null,
      getKnownDurationSeconds: () =>
        options.getKnownDurationSecondsForSwitcher() || options.savedProgress?.duration || mountedPlayer.duration?.() || 0,
      tracks,
      mountRemuxImmediately: remuxOwnsInitialMount,
      initialStartSeconds: options.resumePos,
      onRemuxUnrecoverable: (detail) => {
        log.warn(`${options.logTag} remux playback unavailable for this source:`, detail)
        handleRemuxFailure(detail)
      },
    })
  }

  if (remuxOwnsInitialMount) {
    // Registers against the synthetic default track now; setTracks delivers the real list with no remount.
    ownAudioSwitcher = buildAudioSwitcher([])
    options.setAudioSwitcher(ownAudioSwitcher)
    initialAudioSource = ownAudioSwitcher.source
  }

  // Dispose first: stops any remux session before the tee that feeds it goes away.
  function abandonOwnPipeline() {
    ownAudioSwitcher?.dispose()
    if (options.getAudioSwitcher() === ownAudioSwitcher) options.setAudioSwitcher(null)
    preparedPlayback.mkvSession?.stop()
  }

  pipelineReady = true
  if (bufferedStartError) {
    handleStartError()
    abandonOwnPipeline()
    return
  }

  if (options.isStale()) {
    abandonOwnPipeline()
    return
  }

  // This pipeline owns the mount from here on, so its tee session is the one the next tune must stop.
  options.setActiveMkvSession(preparedPlayback.mkvSession)
  // An automatic remux retry continues the same tune's session instead of opening a new one.
  options.beginInsightsSession(options.isAutomaticRetry)
  // Captured so the stall watchdog can re-issue the identical mount to recover a stuck download.
  function mountEmbeddedSrc() {
    mountedPlayer.src({
      src: preparedPlayback.playbackUrl,
      type: mime,
      isLive: false,
      subtitles: { sourceUrl: playSrc, mkvSession: preparedPlayback.mkvSession },
      audio: initialAudioSource,
    })
  }

  if (!remuxOwnsInitialMount) mountEmbeddedSrc()
  const stallVideoEl = mountedPlayer.getMediaElement?.()
  options.replaceStallWatchdog(attachVodStallWatchdog(stallVideoEl, {
    logTag: options.logTag,
    player: mountedPlayer,
    remuxOwnsInitialMount,
    isAudioSwitcherRecovering: () => ownAudioSwitcher?.isRecovering() ?? false,
    recoverRemuxStall: () => ownAudioSwitcher?.recoverRemuxStall(),
    mountEmbeddedSrc,
  }))
  if (options.playerWrap) options.setQualityChipDetach(attachQualityChip(options.playerWrap, mountedPlayer))
  options.applyVideoScale()

  options.bindProgressListenersOnce(() => {
    let lastWriteAt = 0
    mountedPlayer.on("timeupdate", () => {
      if (!options.hasActiveContent()) return
      const now = Date.now()
      if (now - lastWriteAt < 5000) return
      const pos = mountedPlayer.currentTime?.() || 0
      const dur = mountedPlayer.duration?.() || 0
      if (pos < 1) return
      lastWriteAt = now
      options.writeProgress(pos, dur)
    })
    mountedPlayer.on("ended", () => {
      // audioSwitcher tracks the live pipeline; this listener is bound once and outlives any single mount.
      const trusted = shouldTrustEndedEvent({
        currentTimeSeconds: mountedPlayer.currentTime?.() || 0,
        knownDurationSeconds: options.getKnownDurationSecondsForEnded(),
        recoveryInFlight: options.getAudioSwitcher()?.isRecovering?.() ?? false,
      })
      if (!trusted) {
        log.info(`${options.prematureEndedLogTag} ignoring a premature ended event short of the known duration`)
        options.getAudioSwitcher()?.recoverRemuxStall()
        return
      }
      options.recordPlaybackEndedSession()
      if (!options.hasActiveContent()) return
      const dur = mountedPlayer.duration?.() || 0
      options.markContentCompleted(dur)
    })
  })

  // The switcher-owned mount plays itself once its remux session is up.
  if (!remuxOwnsInitialMount) {
    playWhenReady(mountedPlayer, {
      isStale: options.isStale,
      onReject: (err) =>
        log.info(`${options.logTag} play() rejected - re-arming on canplay`, {
          error: err?.name || err?.message || String(err),
        }),
      onRetryReject: (err) =>
        log.warn(`${options.logTag} retry play() rejected:`, err?.name || err?.message || err),
    })
  }

  // Fire-and-forget network probe that must never sit ahead of the mount above.
  if (remuxAvailable) {
    discoverVodAudioTracks(preparedPlayback.mkvSession, playSrc, discoverySignal).then((audioTracks) => {
      if (options.isStale()) return
      if (remuxOwnsInitialMount) {
        if (audioTracks.length > 0) ownAudioSwitcher?.setTracks(audioTracks)
        return
      }
      if (audioTracks.length < 2) return
      ownAudioSwitcher = buildAudioSwitcher(audioTracks)
      options.setAudioSwitcher(ownAudioSwitcher)
      mountedPlayer.setAudioSource?.(ownAudioSwitcher.source)
    })
  }

  options.onMounted()
}
