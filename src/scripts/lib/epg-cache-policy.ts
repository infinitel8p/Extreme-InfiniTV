// Pure reuse policy for the cached EPG parse: age + horizon-coverage gate.

export const EPG_REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const EPG_MIN_COVERAGE_MS = 24 * 60 * 60 * 1000

export function programmeHorizonMs(entries: Array<[string, Array<{ start: number; stop: number }>]>): number {
  let horizonMs = -Infinity
  for (const [, programmes] of entries) {
    for (const programme of programmes) {
      if (programme.stop > horizonMs) horizonMs = programme.stop
    }
  }
  return horizonMs
}

/** True when the cached parse is recent enough and still covers at least EPG_MIN_COVERAGE_MS ahead of now. */
export function shouldReuseCachedEpg(input: { fetchedAtMs: number; horizonMs: number; nowMs: number }): boolean {
  const ageMs = input.nowMs - input.fetchedAtMs
  if (ageMs < 0 || ageMs >= EPG_REUSE_MAX_AGE_MS) return false
  if (!Number.isFinite(input.horizonMs)) return false
  return input.horizonMs >= input.nowMs + EPG_MIN_COVERAGE_MS
}
