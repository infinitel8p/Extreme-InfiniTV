// Sender-side playback progress recorder for TV cast sessions: mirrors the local movie/series
// detail pages so Continue Watching, resume, and watched-state see identical data either way.
import { ensureLoaded, setProgress, markCompleted } from "@/scripts/lib/preferences.js"
import { flattenSeriesEpisodes } from "@/scripts/lib/tv-cast-next.js"
import { log } from "@/scripts/lib/log.js"
import type { CastSession, CastState } from "@/scripts/lib/tv-cast.js"

// Matches the 5s throttle vod-mount.ts uses for local timeupdate progress writes.
export const CAST_PROGRESS_WRITE_THROTTLE_MS = 5000
const MIN_TRACKED_POSITION_SECONDS = 1

/** Only vod/series playback is tracked - never live, and never a connect-only session with nothing playing. */
export function isTrackableCastSession(session: CastSession | null): session is CastSession {
  if (!session || session.connectedOnly) return false
  return !!(session.vodContext || session.seriesContext)
}

export function hasSanePlaybackPosition(
  state: Pick<CastState, "positionSeconds" | "durationSeconds">
): boolean {
  return (
    typeof state.durationSeconds === "number" &&
    Number.isFinite(state.durationSeconds) &&
    state.durationSeconds > 0 &&
    typeof state.positionSeconds === "number" &&
    Number.isFinite(state.positionSeconds) &&
    state.positionSeconds >= 0
  )
}

export function shouldThrottleWrite(
  nowMs: number,
  lastWriteAtMs: number,
  minIntervalMs: number = CAST_PROGRESS_WRITE_THROTTLE_MS
): boolean {
  return nowMs - lastWriteAtMs < minIntervalMs
}

/** A paused/ended frame always writes a final position, bypassing the throttle. */
export function isTerminalCastStateValue(stateValue: string): boolean {
  return stateValue === "paused" || stateValue === "ended"
}

/** Stable identity for the item currently being tracked; a change flushes the outgoing one first. */
export function castProgressTargetKey(session: CastSession): string | null {
  if (session.vodContext) return `vod:${session.vodContext.playlistId}:${session.vodContext.vodId}`
  if (session.seriesContext) {
    const context = session.seriesContext
    return `episode:${context.playlistId}:${context.seriesId}:${context.season}:${context.episodeNum}`
  }
  return null
}

interface EpisodeTarget {
  episodeId: string
  extras: {
    seriesId: number
    season: number | string
    episodeNum: number | string
    episodeTitle: string
    seriesName: string
    seriesLogo: string | null
  }
}

const episodeTargetCache = new Map<string, EpisodeTarget | null>()

async function resolveEpisodeTarget(
  context: NonNullable<CastSession["seriesContext"]>,
  fallbackLogo?: string
): Promise<EpisodeTarget | null> {
  const cacheKey = `${context.playlistId}:${context.seriesId}:${context.season}:${context.episodeNum}`
  if (episodeTargetCache.has(cacheKey)) return episodeTargetCache.get(cacheKey) ?? null
  try {
    const { requestSeriesInfo } = await import("@/scripts/lib/series-seasons.js")
    const data = await requestSeriesInfo(context.playlistId, context.seriesId)
    const episodes = flattenSeriesEpisodes(data)
    const match = episodes.find(
      (episode) => episode.season === context.season && episode.episodeNum === context.episodeNum
    )
    if (!match) {
      episodeTargetCache.set(cacheKey, null)
      return null
    }
    const info = (data as { info?: { name?: string; title?: string; cover?: string } } | null)?.info || {}
    const target: EpisodeTarget = {
      episodeId: String(match.id),
      extras: {
        seriesId: Number(context.seriesId),
        season: context.season,
        episodeNum: context.episodeNum,
        episodeTitle: match.title || "",
        seriesName: info.name || info.title || "",
        seriesLogo: info.cover || fallbackLogo || null,
      },
    }
    episodeTargetCache.set(cacheKey, target)
    return target
  } catch (err) {
    log.warn("[xt:tv-cast-progress] episode resolution failed:", err)
    return null
  }
}

async function writeNow(session: CastSession, state: CastState): Promise<void> {
  if (!hasSanePlaybackPosition(state)) return
  const position = state.positionSeconds
  const duration = state.durationSeconds as number
  if (position < MIN_TRACKED_POSITION_SECONDS) return
  await ensureLoaded()

  if (session.vodContext) {
    const { playlistId, vodId } = session.vodContext
    setProgress(playlistId, "vod", vodId, position, duration, {
      name: session.title,
      logo: session.logo || null,
    })
    if (state.state === "ended") markCompleted(playlistId, "vod", vodId, { duration })
    return
  }

  if (session.seriesContext) {
    const target = await resolveEpisodeTarget(session.seriesContext, session.logo)
    if (!target) return
    const { playlistId } = session.seriesContext
    setProgress(playlistId, "episode", target.episodeId, position, duration, target.extras)
    if (state.state === "ended") {
      markCompleted(playlistId, "episode", target.episodeId, { duration, ...target.extras })
    }
  }
}

export interface CastProgressRecorder {
  /** Feed every cast-state feed frame; writes immediately, throttled, or on a terminal/target-change edge. */
  observe(session: CastSession | null, state: CastState): void
  /** Forces a final write of the last observed frame (unmount, feed loss). No-op with nothing tracked. */
  flush(): void
}

export function createCastProgressRecorder(): CastProgressRecorder {
  let currentKey: string | null = null
  let lastWriteAtMs = 0
  let lastObserved: { session: CastSession; state: CastState } | null = null
  // The receiver strips durationSeconds from its terminal "ended" report; without this the
  // last frame of a session is silently dropped instead of marking the item completed.
  let lastKnownDurationSeconds: number | null = null

  function writeCurrent(): void {
    if (!lastObserved) return
    const { session, state } = lastObserved
    void writeNow(session, state).catch((err) => log.warn("[xt:tv-cast-progress] write failed:", err))
  }

  function reset(): void {
    currentKey = null
    lastWriteAtMs = 0
    lastObserved = null
    lastKnownDurationSeconds = null
  }

  return {
    observe(session, state) {
      if (!isTrackableCastSession(session)) {
        if (currentKey != null) writeCurrent()
        reset()
        return
      }
      const key = castProgressTargetKey(session)
      if (key == null) return
      if (currentKey != null && currentKey !== key) {
        writeCurrent()
        lastWriteAtMs = 0
        lastKnownDurationSeconds = null
      }
      currentKey = key
      if (typeof state.durationSeconds === "number" && Number.isFinite(state.durationSeconds) && state.durationSeconds > 0) {
        lastKnownDurationSeconds = state.durationSeconds
      }
      const effectiveState =
        state.durationSeconds == null && isTerminalCastStateValue(state.state) && lastKnownDurationSeconds != null
          ? { ...state, durationSeconds: lastKnownDurationSeconds }
          : state
      lastObserved = { session, state: effectiveState }
      if (!hasSanePlaybackPosition(effectiveState)) return
      const nowMs = Date.now()
      if (isTerminalCastStateValue(effectiveState.state) || !shouldThrottleWrite(nowMs, lastWriteAtMs)) {
        lastWriteAtMs = nowMs
        writeCurrent()
      }
    },
    flush() {
      if (currentKey == null) return
      writeCurrent()
      reset()
    },
  }
}
