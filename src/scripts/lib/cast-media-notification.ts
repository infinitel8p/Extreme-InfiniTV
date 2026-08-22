// Android-only sender-side media notification for an active cast session, backed by the
// AndroidCastMedia bridge. No-ops everywhere else.
import { log } from "@/scripts/lib/log.js"

export interface CastMediaNotificationInput {
  title: string
  deviceName: string
  isPlaying: boolean
  isLive: boolean
  hasNext: boolean
  hasPrev: boolean
  artworkUrl?: string | null
}

export const CAST_MEDIA_ACTION_EVENT = "xt:cast-media-action"

let lastSignature: string | null = null
let actionListenerAttached = false

export function isCastMediaNotificationAvailable(): boolean {
  return typeof window !== "undefined" && !!window.AndroidCastMedia?.update
}

function signatureFor(input: CastMediaNotificationInput): string {
  return [input.title, input.deviceName, input.isPlaying, input.isLive, input.hasNext, input.hasPrev, input.artworkUrl || ""].join("|")
}

/** Skips the bridge call unless something the notification actually displays changed. */
export function updateCastMediaNotification(input: CastMediaNotificationInput): void {
  const bridge = window.AndroidCastMedia
  if (!bridge?.update) return
  const signature = signatureFor(input)
  if (signature === lastSignature) return
  lastSignature = signature
  bridge.update(input.title, input.deviceName, input.isPlaying, input.isLive, input.hasNext, input.hasPrev, input.artworkUrl || "")
}

export function clearCastMediaNotification(): void {
  lastSignature = null
  window.AndroidCastMedia?.clear?.()
}

async function handleMediaAction(event: Event): Promise<void> {
  const action = (event as CustomEvent<{ action?: string }>).detail?.action
  const { getCastSession, castPause, castResume, castStop, sessionAsDevice } = await import("@/scripts/lib/tv-cast.js")
  const session = getCastSession()
  if (!session) return
  const device = sessionAsDevice(session)
  try {
    switch (action) {
      case "pause":
        await castPause(device)
        break
      case "resume":
        await castResume(device)
        break
      case "stop":
        await castStop(device)
        break
      case "next": {
        const { castNeighbor } = await import("@/scripts/lib/tv-cast-next.js")
        await castNeighbor(1)
        break
      }
      case "prev": {
        const { castNeighbor } = await import("@/scripts/lib/tv-cast-next.js")
        await castNeighbor(-1)
        break
      }
      default:
        return
    }
    const { pokeCastStateFeed } = await import("@/scripts/lib/tv-cast-state-feed.js")
    pokeCastStateFeed()
  } catch (err) {
    log.warn("[xt:cast-media-notification] action failed:", err)
  }
}

/** Idempotent; safe to call from any page that mounts the cast pill. */
export function initCastMediaNotificationActions(): void {
  if (actionListenerAttached || !isCastMediaNotificationAvailable()) return
  actionListenerAttached = true
  document.addEventListener(CAST_MEDIA_ACTION_EVENT, handleMediaAction)
}
