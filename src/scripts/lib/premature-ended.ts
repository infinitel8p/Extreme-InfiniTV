// Guards against a spurious `ended` fired by a remux pipe's dead session at the buffer end.

export interface ShouldTrustEndedEventInput {
  currentTimeSeconds: number
  knownDurationSeconds: number | null
  recoveryInFlight: boolean
}

const TRUSTED_END_FRACTION = 0.97

export function shouldTrustEndedEvent(input: ShouldTrustEndedEventInput): boolean {
  if (input.recoveryInFlight) return false
  const { knownDurationSeconds, currentTimeSeconds } = input
  if (Number.isFinite(knownDurationSeconds) && (knownDurationSeconds as number) > 0) {
    if (currentTimeSeconds < (knownDurationSeconds as number) * TRUSTED_END_FRACTION) return false
  }
  return true
}
