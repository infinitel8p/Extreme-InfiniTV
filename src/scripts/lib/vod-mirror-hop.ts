// Shared, memoized "hop to the next Xtream mirror" attempt for the movie/series detail pages.
import { log } from "@/scripts/lib/log.js"
import { advanceMirror } from "@/scripts/lib/xtream-api.js"
import { shouldRepinMirror } from "@/scripts/lib/stream-reject.ts"

export interface MirrorHopRejection {
  errorDetail?: string | null
  httpStatus?: number | null
}

export interface MirrorHopperOptions {
  /** Null when the current source has no mirror candidates to hop to (e.g. a plain M3U entry). */
  buildUrl: ((candidate: { host: string; port: string; user: string; pass: string }) => string) | null
  /** False once a newer play request has superseded this attempt. */
  isCurrent(): boolean
  logTag: string
  hopsUsed: number
  /** Called once with the hopped URL and the new hop count when the hop succeeds. */
  onHop(url: string, hopsUsed: number): void
}

/** One hopper per play attempt; call the returned function from every error listener on that mount. */
export function createMirrorHopper(options: MirrorHopperOptions): (rejection: MirrorHopRejection) => Promise<boolean> {
  let hopPromise: Promise<boolean> | null = null
  return function tryMirrorHop(rejection: MirrorHopRejection): Promise<boolean> {
    if (hopPromise) return hopPromise
    hopPromise = (async () => {
      if (!options.buildUrl || !options.isCurrent()) return false
      const repin = shouldRepinMirror(rejection)
      const nextUrl = await advanceMirror(options.buildUrl, { hopsUsed: options.hopsUsed, repin })
      if (!nextUrl || !options.isCurrent()) return false
      log.warn(`${options.logTag} provider rejection - hopping to next mirror`, { hop: options.hopsUsed + 1 })
      options.onHop(nextUrl, options.hopsUsed + 1)
      return true
    })()
    return hopPromise
  }
}
