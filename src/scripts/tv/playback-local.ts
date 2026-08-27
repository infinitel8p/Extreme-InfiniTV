// Local playback for completed downloads on Android TV. The classic
// tryAndroidIntentPlayback chooser has no reliable handler on a TV, so this
// hands the content:// URI straight to the native ExoPlayer activity.
import { getAndroidLocalUri } from "@/scripts/lib/downloads.js"
import { getProgress } from "@/scripts/lib/preferences.js"
import {
  androidNativePlayerAvailable,
  launchAndroidNativeVodWithProgress,
} from "@/scripts/lib/android-video-launcher.ts"
import { toast } from "@/scripts/lib/toast.ts"
import { t } from "@/scripts/lib/i18n.ts"

export interface DownloadSource {
  kind: "vod" | "episode"
  playlistId: string
  id: string | number
  seriesId?: string | number | null
  seriesName?: string
  season?: number | null
  episode?: number | null
  logo?: string | null
}

export interface DownloadNfo {
  title?: string
  [key: string]: unknown
}

export interface DownloadItem {
  id: string
  url: string
  title: string
  status: string
  bytesDone?: number
  bytesTotal?: number
  error?: string
  userPaused?: boolean
  startedAt?: number
  source?: DownloadSource | null
  nfo?: DownloadNfo | null
}

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

export function localPlaybackAvailable(): boolean {
  return isAndroid && androidNativePlayerAvailable
}

function notifyUnavailable(): void {
  toast({ title: t("tv.downloads.playUnavailable"), variant: "error" })
}

export async function playDownloadedItem(item: DownloadItem): Promise<boolean> {
  if (!localPlaybackAvailable()) {
    notifyUnavailable()
    return false
  }

  const source = item.source
  if (!source?.playlistId || source.id == null) {
    notifyUnavailable()
    return false
  }

  const uri = await getAndroidLocalUri(item.url)
  if (!uri) {
    notifyUnavailable()
    return false
  }

  const kind = source.kind === "episode" ? "episode" : "vod"
  const contentKey = `${kind === "episode" ? "ep" : "vod"}:${source.id}`
  const saved = getProgress(source.playlistId, kind, source.id)
  const startMs = saved && !saved.completed ? Math.max(0, (saved.position || 0) * 1000) : 0

  const progressExtras =
    kind === "episode"
      ? {
          seriesId: source.seriesId ?? null,
          season: source.season ?? null,
          episodeNum: source.episode ?? null,
          episodeTitle: item.nfo?.title || item.title,
          seriesName: source.seriesName || "",
          seriesLogo: source.logo ?? null,
        }
      : { name: item.title, logo: source.logo ?? null }

  const launched = launchAndroidNativeVodWithProgress({
    playlistId: source.playlistId,
    contentKey,
    kind,
    id: source.id,
    url: uri,
    title: item.title,
    posterUrl: source.logo || "",
    startMs,
    progressExtras,
  })
  if (!launched) notifyUnavailable()
  return launched
}
