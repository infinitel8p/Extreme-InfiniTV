// Android VOD dispatch: native ExoPlayer by default, "Open with" chooser when opted out.
import { getAndroidLocalUri, tryAndroidIntentPlayback } from "@/scripts/lib/downloads.js"
import { getAndroidNativePlayerEnabled } from "@/scripts/lib/app-settings.js"
import {
  androidNativePlayerAvailable,
  launchAndroidNativeVodWithProgress,
} from "@/scripts/lib/android-video-launcher.ts"

export interface AndroidNativeVodInput {
  playlistId: string
  kind: "vod" | "episode"
  id: string | number
  contentKey: string
  remoteUrl: string
  title?: string
  posterUrl?: string
  startMs?: number
  ua?: string
  referer?: string
  dns?: string | null
  progressExtras?: Record<string, unknown>
  onCompleted?: () => void
  isStale?: () => boolean
}

/** True when the native player or the chooser took over; caller skips in-app playback. */
export async function tryAndroidNativeVodPlayback(
  input: AndroidNativeVodInput,
): Promise<boolean> {
  if (!androidNativePlayerAvailable || !getAndroidNativePlayerEnabled()) {
    return tryAndroidIntentPlayback(input.remoteUrl)
  }

  const localUri = await getAndroidLocalUri(input.remoteUrl)
  if (input.isStale?.()) return true
  const launched = launchAndroidNativeVodWithProgress({
    playlistId: input.playlistId,
    contentKey: input.contentKey,
    kind: input.kind,
    id: input.id,
    url: localUri || input.remoteUrl,
    ua: input.ua,
    referer: input.referer,
    title: input.title,
    posterUrl: input.posterUrl,
    startMs: input.startMs,
    dns: input.dns,
    progressExtras: input.progressExtras,
    onCompleted: input.onCompleted,
  })
  if (launched) return true
  return localUri ? tryAndroidIntentPlayback(input.remoteUrl) : false
}
