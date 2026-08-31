// Pure helpers backing tv/playback.ts: progress write throttling and sibling-channel mapping.

export interface ThrottledProgressSample {
  state: string
  positionSeconds: number
  durationSeconds?: number
}

export interface ThrottledProgressWriterOptions {
  intervalMs: number
  write(positionSeconds: number, durationSeconds: number | undefined, state: string): void
}

export interface ThrottledProgressWriter {
  observe(sample: ThrottledProgressSample): void
}

function isTerminalProgressState(state: string): boolean {
  return state === "paused" || state === "ended"
}

/** Writes on the first sample, then at most once per intervalMs, always bypassing the throttle on paused/ended. */
export function createThrottledProgressWriter(options: ThrottledProgressWriterOptions): ThrottledProgressWriter {
  let lastWriteAtMs = 0
  let hasWrittenOnce = false
  return {
    observe(sample) {
      const nowMs = Date.now()
      const dueForWrite = !hasWrittenOnce || isTerminalProgressState(sample.state) || nowMs - lastWriteAtMs >= options.intervalMs
      if (!dueForWrite) return
      hasWrittenOnce = true
      lastWriteAtMs = nowMs
      options.write(sample.positionSeconds, sample.durationSeconds, sample.state)
    },
  }
}

export interface SiblingChannelInput {
  id: string | number
  name: string
  logo?: string | null
  streamUrl?: string | null
  ua?: string | null
  referer?: string | null
  tvgId?: string | null
  tvgShift?: number | null
}

export interface ResolvedLiveContextChannel {
  id: string | number
  name: string
  logo?: string | null
  streamUrl: string
  ua?: string | null
  referer?: string | null
  tvgId?: string | null
  tvgShift?: number | null
}

export interface ResolvedLiveContext {
  channels: ResolvedLiveContextChannel[]
  initialChannelId: string
}

/** Maps a browsed group into the native player's channel list: drops unresolved streams, dedupes by id, keeps order. */
export function siblingsToLiveContext(
  channels: SiblingChannelInput[],
  initialChannel: SiblingChannelInput
): ResolvedLiveContext | null {
  const seenIds = new Set<string>()
  const resolvedChannels: ResolvedLiveContextChannel[] = []
  for (const channel of channels) {
    if (!channel?.streamUrl) continue
    const id = String(channel.id)
    if (seenIds.has(id)) continue
    seenIds.add(id)
    resolvedChannels.push({ ...channel, streamUrl: channel.streamUrl })
  }
  if (resolvedChannels.length === 0) return null
  const initialChannelId = String(initialChannel.id)
  if (!seenIds.has(initialChannelId)) return null
  return { channels: resolvedChannels, initialChannelId }
}
