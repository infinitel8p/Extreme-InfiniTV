// Pure timeline math for catch-up (archive) seeking. No DOM, no imports.

export const LIVE_RETURN_THRESHOLD_MS = 45_000
export const WINDOW_START_MARGIN_MS = 60_000

/** Clamp a requested seek target; classifies the outcome. */
export function clampSeekTarget(
  targetUtcMs: number,
  opts: { nowUtcMs: number; catchupWindowMs: number; liveThresholdMs?: number },
): { kind: "live" } | { kind: "shifted"; targetUtcMs: number } {
  const liveThresholdMs = opts.liveThresholdMs ?? LIVE_RETURN_THRESHOLD_MS
  if (opts.nowUtcMs - targetUtcMs <= liveThresholdMs) return { kind: "live" }
  const earliestUtcMs = opts.nowUtcMs - opts.catchupWindowMs + WINDOW_START_MARGIN_MS
  const clampedUtcMs = Math.max(earliestUtcMs, Math.min(targetUtcMs, opts.nowUtcMs))
  return { kind: "shifted", targetUtcMs: clampedUtcMs }
}

/** Xtream timeshift mounts start on whole minutes; split target into mount start + residual seek. */
export function splitMountStart(
  targetUtcMs: number,
  granularity: "minute" | "second",
): { mountStartUtcMs: number; seekSeconds: number } {
  const granularityMs = granularity === "minute" ? 60_000 : 1000
  const mountStartUtcMs = Math.floor(targetUtcMs / granularityMs) * granularityMs
  const seekSeconds = (targetUtcMs - mountStartUtcMs) / 1000
  return { mountStartUtcMs, seekSeconds }
}

/** true when playback of a finite shifted segment should snap back to live. */
export function shouldReturnToLive(
  absolutePositionUtcMs: number,
  nowUtcMs: number,
  thresholdMs: number = LIVE_RETURN_THRESHOLD_MS,
): boolean {
  return nowUtcMs - absolutePositionUtcMs <= thresholdMs
}
