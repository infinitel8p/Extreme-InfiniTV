// Playback-engine selection + fallback, shared by the receiver page and (eventually) TV browse.
import { isRtspSrc, type CastDescriptorV1 } from "@/scripts/lib/tv-cast-descriptor"
import type { ReceiverEngine, ReceiverPlayOptions } from "./engines"

export type ReceiverEnginePreference = "auto" | "embedded" | "native"

// Engines are looked up by name, never by position.
export interface EngineRegistry {
  embedded: ReceiverEngine
  native?: ReceiverEngine | null
}

export function selectEngine(
  registry: EngineRegistry,
  descriptor: CastDescriptorV1,
  preference: ReceiverEnginePreference,
): ReceiverEngine {
  if (!registry.native) return registry.embedded
  // The WebView has no RTSP at all - only the native engine can try these, whatever the preference says.
  if (isRtspSrc(descriptor.src)) return registry.native
  if (preference === "embedded") return registry.embedded
  if (preference === "native") return registry.native
  // The native ExoPlayer engine ignores timelineOffsetSeconds; catch-up needs the embedded engine to land on the right offset.
  const hasTimelineOffset = typeof descriptor.timelineOffsetSeconds === "number" && descriptor.timelineOffsetSeconds > 0
  return descriptor.drm || hasTimelineOffset ? registry.embedded : registry.native
}

export function fallbackEngineFor(
  registry: EngineRegistry,
  engine: ReceiverEngine,
  descriptor: CastDescriptorV1,
): ReceiverEngine | null {
  if (!registry.native || engine !== registry.native) return null
  if (isRtspSrc(descriptor.src)) return null
  return registry.embedded
}

export interface PlayWithFallbackOptions {
  preference: ReceiverEnginePreference
  start: (engine: ReceiverEngine, descriptor: CastDescriptorV1, playOptions?: ReceiverPlayOptions) => Promise<boolean>
  playOptions?: ReceiverPlayOptions
  onFallback?: (from: ReceiverEngine, to: ReceiverEngine) => void
}

export async function playWithFallback(
  registry: EngineRegistry,
  descriptor: CastDescriptorV1,
  options: PlayWithFallbackOptions,
): Promise<{ engine: ReceiverEngine | null; started: boolean }> {
  const engine = selectEngine(registry, descriptor, options.preference)
  if (await options.start(engine, descriptor, options.playOptions)) return { engine, started: true }

  const fallback = fallbackEngineFor(registry, engine, descriptor)
  if (fallback) {
    options.onFallback?.(engine, fallback)
    if (await options.start(fallback, descriptor, options.playOptions)) return { engine: fallback, started: true }
  }

  return { engine: null, started: false }
}
