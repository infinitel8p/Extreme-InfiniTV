// Pure digit-buffer -> channel resolution for TV remote number-pad zapping.

export interface ZapChannel {
  id: string | number
  chno?: number | null
}

/** Exact channel-number match wins; otherwise a 1-based list position; null when neither resolves. */
export function resolveZapTarget<Channel extends ZapChannel>(digits: string, channels: Channel[]): Channel | null {
  const typed = Number(digits)
  if (!digits || !Number.isFinite(typed) || typed < 0) return null
  const byChno = channels.find((channel) => typeof channel.chno === "number" && channel.chno === typed)
  if (byChno) return byChno
  const index = typed - 1
  return index >= 0 && index < channels.length ? channels[index] : null
}
