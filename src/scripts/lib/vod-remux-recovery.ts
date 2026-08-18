// Shared remux-failure classification, player-error handling, and stall-watchdog wiring.
import { log } from "@/scripts/lib/log.js"
import { attachStallWatchdog, type StallWatchableVideo, type StallWatchdogHandle } from "@/scripts/lib/stall-watchdog.ts"
import { classifyStartFailure, hasHevcNameHint, deviceSupportsHevc } from "@/scripts/lib/codec-hints.ts"
import {
  detectVodContainer,
  detectVodContainerFromLocalPath,
  isUpstreamHttpFailure,
} from "@/scripts/lib/vod-container-plan.ts"
import { probeVodSourceHealth } from "@/scripts/lib/vod-container-probe.ts"
import { rememberRemuxPinnedContent } from "@/scripts/lib/vod-remux-memory.ts"
import type { VjsLikeHandle } from "@/scripts/lib/player-runtime.ts"
import type { VodAudioSwitcher } from "@/scripts/lib/vod-audio-switch.ts"
import type { VodPlaybackToasts } from "@/scripts/lib/vod-playback-toasts.ts"

export interface RemuxFailureHandlerOptions {
  player: VjsLikeHandle
  posterEl: HTMLElement | null
  playerWrap: HTMLElement | null
  /** The switcher owned by the currently mounted pipeline, if any is live right now. */
  getOwnAudioSwitcher(): VodAudioSwitcher | null
  /** Clears the module-level "live" switcher reference if it still points at ownAudioSwitcher. */
  clearAudioSwitcherIfOwn(ownAudioSwitcher: VodAudioSwitcher | null): void
  /** The tee-proxy session backing the current pipeline's `prepared` mount, if one exists. */
  getPipelineMkvSession(): { stop(): void } | null | undefined
  /** Clears the module-level "active" mkv-session reference if it still points at that session. */
  clearActiveMkvSessionIfMatches(mkvSession: { stop(): void } | null | undefined): void
  /** Name searched for an HEVC hint when no codec is reported (movie name / episode title). */
  nameHintSource: string
  /** buildRemuxContentKey("movie" | "episode", id), logged with the failure verdict. */
  contentKey: string
  recordGiveUp(kind: string): void
  endGiveUpSession(): void
  resolvedContainer: "mkv" | "mp4" | null
  playSrc: string
  toasts: VodPlaybackToasts
}

/** One path for post-mount decode failures and mid-play remux deaths: same classification and teardown. */
export function createRemuxFailureHandler(options: RemuxFailureHandlerOptions) {
  return function handleRemuxFailure(detail: string) {
    const ownAudioSwitcher = options.getOwnAudioSwitcher()
    ownAudioSwitcher?.dispose()
    options.clearAudioSwitcherIfOwn(ownAudioSwitcher)
    const pipelineMkvSession = options.getPipelineMkvSession()
    pipelineMkvSession?.stop()
    options.clearActiveMkvSessionIfMatches(pipelineMkvSession)
    if (options.posterEl) options.posterEl.classList.remove("hidden")
    if (options.playerWrap) options.playerWrap.classList.add("hidden")
    const upstreamFailure = isUpstreamHttpFailure(detail)
    const codecInfo = upstreamFailure ? null : options.player.codecInfo?.()
    const failure = upstreamFailure
      ? null
      : classifyStartFailure({
          videoCodec: codecInfo?.videoCodec,
          audioCodec: codecInfo?.audioCodec,
          errorDetail: detail,
          nameHint: hasHevcNameHint(options.nameHintSource),
          deviceHevc: deviceSupportsHevc(),
        })
    const toastPath = upstreamFailure
      ? "upstream-http"
      : failure?.kind === "hevc"
        ? "hevc"
        // Without a known codec we can't name it in the toast, so fall back to the container message.
        : failure?.kind === "audio" && failure.codec
          ? "audio"
          : "container"
    log.info("[xt:vod-mount] start-failure verdict", {
      kind: failure?.kind ?? null,
      codec: failure?.codec ?? null,
      toastPath,
      contentKey: options.contentKey,
    })
    options.recordGiveUp(failure?.kind ?? toastPath)
    // No automatic retry follows this failure - close the session now, not on the next play.
    options.endGiveUpSession()
    if (toastPath === "upstream-http") options.toasts.showSourceUnavailableToast()
    else if (toastPath === "hevc") options.toasts.showHevcUnsupportedToast()
    else if (toastPath === "audio") options.toasts.showAudioUnsupportedToast(failure?.codec ?? "")
    else options.toasts.showContainerUnsupportedToast(options.resolvedContainer || detectVodContainer(options.playSrc) || "mkv")
  }
}

export interface PlayerStartErrorOptions {
  logTag: string
  player: VjsLikeHandle
  /** True once the "error" event is known to have arrived for a superseded run. */
  isStale(): boolean
  containerPlanMode: "direct" | "remux" | "unsupported"
  desktopPlatform: boolean
  localDownloadPath: string | null
  resolvedContainer: "mkv" | "mp4" | null
  playSrc: string
  remuxAvailable: boolean
  activePlaylistId: string | null
  contentKey: string
  posterEl: HTMLElement | null
  playerWrap: HTMLElement | null
  handleRemuxFailure(detail: string): void
  /** Ahead-of-the-error handleRemuxFailure teardown (audio switcher, mkv session, watchdog) then re-run the tune in remux mode. */
  retirePreviousPlaybackAndRetryRemux(): void
  toasts: VodPlaybackToasts
}

/** Superseded runs must not report or seek; a code-4 native failure pins the content to remux and retries once, so it cannot re-fire. */
export function handlePlayerStartError(options: PlayerStartErrorOptions) {
  if (options.isStale()) return
  const playerError = options.player.error?.() as { code?: number; message?: string } | null | undefined
  log.error(`${options.logTag} player error`, {
    code: playerError?.code,
    message: playerError?.message,
  })
  if (options.containerPlanMode === "remux") {
    // Code 4 here means the remux output itself was rejected, not the pre-remux source, so it's a genuine decode failure too.
    options.handleRemuxFailure(playerError?.message || "")
    return
  }
  if (options.desktopPlatform && playerError?.code === 4) {
    const unsupportedContainer = options.localDownloadPath
      ? detectVodContainerFromLocalPath(options.localDownloadPath)
      : options.resolvedContainer || detectVodContainer(options.playSrc)
    if (
      unsupportedContainer === "mkv" &&
      options.remuxAvailable &&
      options.activePlaylistId
    ) {
      rememberRemuxPinnedContent(options.activePlaylistId, options.contentKey)
      log.warn(`${options.logTag} WebView could not demux this MKV directly - remuxing with ffmpeg instead`, {
        contentKey: options.contentKey,
        container: unsupportedContainer,
      })
      options.retirePreviousPlaybackAndRetryRemux()
      return
    }
    if (options.posterEl) options.posterEl.classList.remove("hidden")
    if (options.playerWrap) options.playerWrap.classList.add("hidden")
    if (unsupportedContainer) {
      options.toasts.showContainerUnsupportedToast(unsupportedContainer)
      return
    }
    // Code 4 with no known container often means the server sent an error page, not a codec problem.
    void probeVodSourceHealth(options.playSrc).then((verdict) => {
      log.info("[xt:vod-mount] source health probe verdict", { verdict, contentKey: options.contentKey })
      if (verdict === "media") options.toasts.showFormatUnsupportedToast()
      else options.toasts.showSourceUnavailableToast()
    })
    return
  }
  // Demux succeeded but decoding failed (e.g. an HEVC .mkv played direct) - same treatment as a remux decode failure.
  if (playerError?.code === 3) {
    options.handleRemuxFailure(playerError?.message || "")
  }
}

export interface VodStallWatchdogOptions {
  logTag: string
  player: VjsLikeHandle
  remuxOwnsInitialMount: boolean
  isAudioSwitcherRecovering(): boolean
  recoverRemuxStall(): void
  /** Re-issues the identical mount at its current playhead to recover a stuck download. */
  mountEmbeddedSrc(): void
}

/** Caller detaches any previous watchdog first; this always attaches a fresh one for the given mount. */
export function attachVodStallWatchdog(
  videoEl: StallWatchableVideo | null | undefined,
  options: VodStallWatchdogOptions
): StallWatchdogHandle | null {
  if (!videoEl) return null
  const detach: StallWatchdogHandle = attachStallWatchdog(videoEl, {
    ...(options.remuxOwnsInitialMount
      ? { stallTimeoutMs: 12000, isSuspended: options.isAudioSwitcherRecovering }
      : {}),
    onStall: (attemptNumber) => {
      if (options.remuxOwnsInitialMount) {
        log.info(`${options.logTag} remux mount stalled - restarting the remux session to recover`, {
          attempt: attemptNumber,
        })
        options.recoverRemuxStall()
        detach?.resetStallClock()
        return
      }
      log.info(`${options.logTag} embedded player stalled - re-attaching src to recover`, {
        attempt: attemptNumber,
      })
      const resumeAt = videoEl.currentTime || 0
      options.mountEmbeddedSrc()
      options.player.one?.("loadedmetadata", () => {
        try { options.player.currentTime?.(resumeAt) } catch {}
        options.player.play?.()
      })
    },
  })
  return detach
}
