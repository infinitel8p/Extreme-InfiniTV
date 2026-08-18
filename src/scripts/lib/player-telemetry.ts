// Normalized engine telemetry for hls.js / shaka / mpegts.js / native <video>.

export type EngineKind = "hls.js" | "shaka" | "mpegts.js" | "native"

export interface EngineStats {
  engine: EngineKind | null
  declaredBitrateBps: number | null
  measuredBitrateBps: number | null
  levelIndex: number | null
  levelCount: number | null
  autoLevel: boolean | null
  videoWidth: number | null
  videoHeight: number | null
  segmentDurationSeconds: number | null
  bufferedAheadSeconds: number | null
  droppedFrames: number | null
  totalFrames: number | null
  stalls: number | null
}

export type EngineEventKind = "variant" | "engine-error" | "fatal" | "engine-switch" | "recover"

export interface EngineEvent {
  kind: EngineEventKind
  at: number
  detail: string
}

export interface ResolvedEngine {
  kind: "hls" | "shaka" | "mpegts"
  instance: any
}

export interface PlaybackTelemetry {
  snapshot(): EngineStats | null
  emit(kind: EngineEventKind, detail: string): void
  noteMeasuredBitrate(bitsPerSecond: number): void
  noteSegmentDuration(seconds: number): void
  subscribe(listener: (event: EngineEvent) => void): () => void
  dispose(): void
}

interface BufferedRange {
  start: number
  end: number
}

export function bufferedAheadSeconds(ranges: BufferedRange[], currentTime: number): number {
  if (!Number.isFinite(currentTime)) return 0
  if (!Array.isArray(ranges) || ranges.length === 0) return 0
  for (const range of ranges) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) continue
    if (currentTime >= range.start - 1 && currentTime <= range.end + 1) {
      return Math.max(0, range.end - currentTime)
    }
  }
  return 0
}

export function decodedFrameCount(video: HTMLVideoElement | null): number | null {
  if (!video) return null
  try {
    const quality = video.getVideoPlaybackQuality?.()
    if (quality && typeof quality.totalVideoFrames === "number") return quality.totalVideoFrames
  } catch {}
  const legacy = (video as unknown as { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount
  return typeof legacy === "number" ? legacy : null
}

export function droppedFrameCount(video: HTMLVideoElement | null): number | null {
  if (!video) return null
  try {
    const quality = video.getVideoPlaybackQuality?.()
    if (quality && typeof quality.droppedVideoFrames === "number") return quality.droppedVideoFrames
  } catch {}
  const legacy = (video as unknown as { webkitDroppedFrameCount?: number }).webkitDroppedFrameCount
  return typeof legacy === "number" ? legacy : null
}

export function deriveFps(
  previous: { frames: number; at: number } | null,
  next: { frames: number; at: number },
): number | null {
  if (!previous) return null
  const elapsedMs = next.at - previous.at
  if (!(elapsedMs > 0)) return null
  const frameDelta = next.frames - previous.frames
  if (frameDelta < 0) return null
  return Math.round((frameDelta / elapsedMs) * 1000)
}

function safeRead<T>(reader: () => T): T | null {
  try {
    const value = reader()
    return value === undefined ? null : value
  } catch {
    return null
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export interface MediaFields {
  videoWidth: number | null
  videoHeight: number | null
  bufferedAheadSeconds: number | null
  droppedFrames: number | null
  totalFrames: number | null
}

export function readMediaFields(video: HTMLVideoElement | null): MediaFields {
  if (!video) {
    return { videoWidth: null, videoHeight: null, bufferedAheadSeconds: null, droppedFrames: null, totalFrames: null }
  }
  const ranges = safeRead<BufferedRange[]>(() => {
    const buffered = video.buffered
    const collected: BufferedRange[] = []
    for (let index = 0; index < buffered.length; index++) {
      collected.push({ start: buffered.start(index), end: buffered.end(index) })
    }
    return collected
  }) ?? []
  const currentTime = safeRead(() => video.currentTime) ?? NaN
  return {
    videoWidth: numberOrNull(safeRead(() => video.videoWidth)),
    videoHeight: numberOrNull(safeRead(() => video.videoHeight)),
    bufferedAheadSeconds: bufferedAheadSeconds(ranges, currentTime),
    droppedFrames: droppedFrameCount(video),
    totalFrames: decodedFrameCount(video),
  }
}

interface EngineOverrides {
  declaredBitrateBps: number | null
  measuredBitrateBps: number | null
  levelIndex: number | null
  levelCount: number | null
  autoLevel: boolean | null
  segmentDurationSeconds: number | null
  stalls: number | null
  videoWidth: number | null
  videoHeight: number | null
}

function readHlsStats(instance: any, lastSegmentDurationSeconds: number | null): EngineOverrides {
  const currentLevel = safeRead(() => instance.currentLevel)
  const levels = safeRead(() => instance.levels)
  const level = typeof currentLevel === "number" && Array.isArray(levels) ? levels[currentLevel] : null
  const targetDuration = safeRead(() => level?.details?.targetduration)
  const autoLevel = safeRead(() => instance.autoLevelEnabled)
  return {
    declaredBitrateBps: numberOrNull(safeRead(() => level?.bitrate)),
    measuredBitrateBps: numberOrNull(safeRead(() => instance.bandwidthEstimate)),
    levelIndex: typeof currentLevel === "number" && currentLevel >= 0 ? currentLevel : null,
    levelCount: numberOrNull(safeRead(() => (Array.isArray(levels) ? levels.length : null))),
    autoLevel: typeof autoLevel === "boolean" ? autoLevel : null,
    segmentDurationSeconds: numberOrNull(targetDuration) ?? lastSegmentDurationSeconds,
    stalls: null,
    videoWidth: numberOrNull(safeRead(() => level?.width)),
    videoHeight: numberOrNull(safeRead(() => level?.height)),
  }
}

function readShakaStats(instance: any, lastSegmentDurationSeconds: number | null): EngineOverrides {
  const stats = safeRead(() => instance.getStats())
  const variantTracks = safeRead(() => instance.getVariantTracks())
  let levelIndex: number | null = null
  let levelCount: number | null = null
  if (Array.isArray(variantTracks)) {
    levelCount = variantTracks.length
    const activeIndex = variantTracks.findIndex((track: any) => track?.active)
    levelIndex = activeIndex >= 0 ? activeIndex : null
  }
  const autoLevel = safeRead(() => instance.getConfiguration?.()?.abr?.enabled)
  return {
    declaredBitrateBps: numberOrNull(safeRead(() => stats?.streamBandwidth)),
    measuredBitrateBps: numberOrNull(safeRead(() => stats?.estimatedBandwidth)),
    levelIndex,
    levelCount,
    autoLevel: typeof autoLevel === "boolean" ? autoLevel : null,
    segmentDurationSeconds: numberOrNull(safeRead(() => stats?.maxSegmentDuration)) ?? lastSegmentDurationSeconds,
    stalls: numberOrNull(safeRead(() => stats?.stallsDetected)),
    videoWidth: numberOrNull(safeRead(() => stats?.width)),
    videoHeight: numberOrNull(safeRead(() => stats?.height)),
  }
}

function readMpegtsStats(
  lastMeasuredBitrateBps: number | null,
  lastSegmentDurationSeconds: number | null,
): EngineOverrides {
  return {
    declaredBitrateBps: null,
    measuredBitrateBps: lastMeasuredBitrateBps,
    levelIndex: null,
    levelCount: null,
    autoLevel: null,
    segmentDurationSeconds: lastSegmentDurationSeconds,
    stalls: null,
    videoWidth: null,
    videoHeight: null,
  }
}

export function createPlaybackTelemetry(deps: {
  resolveEngine(): ResolvedEngine | null
  getMediaElement(): HTMLVideoElement | null
}): PlaybackTelemetry {
  const listeners = new Set<(event: EngineEvent) => void>()
  let lastMeasuredBitrateBps: number | null = null
  let lastSegmentDurationSeconds: number | null = null

  function snapshot(): EngineStats | null {
    const mediaFields = readMediaFields(safeRead(() => deps.getMediaElement()))
    const resolved = safeRead(() => deps.resolveEngine())

    let engine: EngineKind = "native"
    let overrides: EngineOverrides = {
      declaredBitrateBps: null,
      measuredBitrateBps: lastMeasuredBitrateBps,
      levelIndex: null,
      levelCount: null,
      autoLevel: null,
      segmentDurationSeconds: lastSegmentDurationSeconds,
      stalls: null,
      videoWidth: null,
      videoHeight: null,
    }
    if (resolved) {
      if (resolved.kind === "hls") {
        engine = "hls.js"
        overrides = readHlsStats(resolved.instance, lastSegmentDurationSeconds)
      } else if (resolved.kind === "shaka") {
        engine = "shaka"
        overrides = readShakaStats(resolved.instance, lastSegmentDurationSeconds)
      } else if (resolved.kind === "mpegts") {
        engine = "mpegts.js"
        overrides = readMpegtsStats(lastMeasuredBitrateBps, lastSegmentDurationSeconds)
      }
    }

    return {
      engine,
      declaredBitrateBps: overrides.declaredBitrateBps,
      measuredBitrateBps: overrides.measuredBitrateBps,
      levelIndex: overrides.levelIndex,
      levelCount: overrides.levelCount,
      autoLevel: overrides.autoLevel,
      segmentDurationSeconds: overrides.segmentDurationSeconds,
      stalls: overrides.stalls,
      videoWidth: mediaFields.videoWidth || overrides.videoWidth,
      videoHeight: mediaFields.videoHeight || overrides.videoHeight,
      bufferedAheadSeconds: mediaFields.bufferedAheadSeconds,
      droppedFrames: mediaFields.droppedFrames,
      totalFrames: mediaFields.totalFrames,
    }
  }

  function emit(kind: EngineEventKind, detail: string): void {
    const event: EngineEvent = { kind, at: Date.now(), detail }
    for (const listener of listeners) {
      try { listener(event) } catch {}
    }
  }

  function noteMeasuredBitrate(bitsPerSecond: number): void {
    if (Number.isFinite(bitsPerSecond)) lastMeasuredBitrateBps = bitsPerSecond
  }

  function noteSegmentDuration(seconds: number): void {
    if (Number.isFinite(seconds)) lastSegmentDurationSeconds = seconds
  }

  function subscribe(listener: (event: EngineEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function dispose(): void {
    listeners.clear()
  }

  return { snapshot, emit, noteMeasuredBitrate, noteSegmentDuration, subscribe, dispose }
}
