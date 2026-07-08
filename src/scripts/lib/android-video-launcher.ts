// Launcher + event subscription for the native ExoPlayer-backed Android
// playback activity. Opt-in path. Visible from /movies, /series, /livetv.
//
// JS surface:
//   - androidNativePlayerAvailable: boolean readiness signal
//   - launchAndroidNativeVod(opts): VOD path with optional resume position
//   - launchAndroidNativeLive(opts): Live TV path with full channel list
//   - subscribeAndroidNativeEvents(callback): receive progress / channel /
//     finished / error events. Routed by contentKey so multiple call sites
//     can listen independently.
//
// The Activity writes events into a SharedPreferences queue (EventQueue in
// VideoActivity.kt); MainActivity.onResume drains and dispatches them as
// DOM CustomEvents on the WebView. This module bridges those DOM events
// back to subscriber callbacks.

import type { ChannelInput } from "@/scripts/lib/channel-lite.js"
import { serializeChannelsJson } from "@/scripts/lib/channel-lite.js"
import { setProgress, markCompleted } from "@/scripts/lib/preferences.js"
import { log, redactUrl } from "@/scripts/lib/log.js"

export type AndroidNativeEventType =
  | "xt:android-native-progress"
  | "xt:android-native-channel-changed"
  | "xt:android-native-finished"
  | "xt:android-native-error"

export interface AndroidNativeEvent {
  type: AndroidNativeEventType
  payload: {
    contentKey?: string
    positionMs?: number
    durationMs?: number
    completed?: boolean
    finalPosMs?: number
    finalChannelId?: string
    channelId?: string
    channelName?: string
    mode?: string
    code?: string
    message?: string
  }
}

export interface VodLaunchOptions {
  contentKey: string
  url: string
  ua?: string
  referer?: string
  title?: string
  posterUrl?: string
  startMs?: number
}

export interface LiveLaunchOptions {
  contentKey: string
  channels: ChannelInput[]
  initialChannelId: string
  defaultUa?: string
  defaultReferer?: string
  programmes?: Map<string, Array<{ start: number; stop: number; title: string }>> | null
}

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

export const androidNativePlayerAvailable: boolean =
  typeof window !== "undefined" && isAndroid && !!window.AndroidVideo?.launchVod

/**
 * Launch the native VOD player. Returns true on success.
 */
export function launchAndroidNativeVod(opts: VodLaunchOptions): boolean {
  const bridge = window.AndroidVideo
  if (!bridge?.launchVod) return false
  try {
    return bridge.launchVod(
      opts.contentKey,
      opts.url,
      opts.ua || "",
      opts.referer || "",
      opts.title || "",
      opts.posterUrl || "",
      Math.max(0, Math.floor(opts.startMs || 0)),
    )
  } catch (err) {
    log.error("[xt:android-video] native VOD launch failed:", redactUrl(opts.url), err)
    return false
  }
}

/**
 * Launch the native Live TV player with an ordered channel list. The
 * Activity handles channel switching in-place via D-pad; each switch fires
 * xt:android-native-channel-changed which JS subscribers can use to keep
 * lastPlayContext + recents in sync.
 */
export function launchAndroidNativeLive(opts: LiveLaunchOptions): boolean {
  const bridge = window.AndroidVideo
  if (!bridge?.launchLive) return false
  try {
    const json = serializeChannelsJson(opts.channels, {
      defaultUa: opts.defaultUa,
      programmes: opts.programmes ?? null,
    })
    return bridge.launchLive(
      opts.contentKey,
      json,
      opts.initialChannelId,
      opts.defaultUa || "",
      opts.defaultReferer || "",
    )
  } catch (err) {
    log.error("[xt:android-video] native live launch failed:", err)
    return false
  }
}

// ---------------------------------------------------------------------
// Event subscription
// ---------------------------------------------------------------------

type Subscriber = (event: AndroidNativeEvent) => void

const subscribers = new Set<Subscriber>()
let listenersInstalled = false

function dispatchToSubscribers(type: AndroidNativeEventType, payload: unknown): void {
  const event: AndroidNativeEvent = {
    type,
    payload: (payload || {}) as AndroidNativeEvent["payload"],
  }
  for (const callback of subscribers) {
    try { callback(event) } catch {}
  }
}

function installListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  const types: AndroidNativeEventType[] = [
    "xt:android-native-progress",
    "xt:android-native-channel-changed",
    "xt:android-native-finished",
    "xt:android-native-error",
  ]
  for (const type of types) {
    document.addEventListener(type, (event: Event) => {
      const detail = (event as CustomEvent).detail
      dispatchToSubscribers(type, detail)
    })
  }
  // Also drain any events that piled up while we were detached (e.g. the
  // user came back to the WebView before MainActivity.onResume fired). Cheap
  // and idempotent.
  drainPending()
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") drainPending()
  })
}

function drainPending(): void {
  const bridge = window.AndroidVideo
  if (!bridge?.drainEvents) return
  let raw: string
  try {
    raw = bridge.drainEvents()
  } catch {
    return
  }
  if (!raw || raw === "[]") return
  try {
    const batch = JSON.parse(raw) as Array<{ type: string; payload: unknown }>
    for (const entry of batch) {
      if (!entry?.type) continue
      dispatchToSubscribers(entry.type as AndroidNativeEventType, entry.payload)
    }
  } catch {}
}

/**
 * Subscribe to native-player events. Returns an unsubscribe function. Safe
 * to call on non-Android - subscriber simply never fires.
 */
export function subscribeAndroidNativeEvents(callback: Subscriber): () => void {
  if (typeof window === "undefined") return () => {}
  if (androidNativePlayerAvailable) installListeners()
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}

export interface NativeVodProgressOptions {
  playlistId: string
  contentKey: string
  kind: "vod" | "episode"
  id: string | number
  url: string
  title?: string
  posterUrl?: string
  startMs?: number
  progressExtras?: Record<string, unknown>
  onCompleted?: () => void
}

export function launchAndroidNativeVodWithProgress(
  opts: NativeVodProgressOptions,
): boolean {
  const { playlistId, contentKey, kind, id, progressExtras } = opts
  const unsubscribe = subscribeAndroidNativeEvents((event) => {
    if (event.payload?.contentKey !== contentKey) return
    if (event.type === "xt:android-native-progress") {
      const pos = Math.max(0, Math.floor((event.payload.positionMs || 0) / 1000))
      const dur = Math.max(0, Math.floor((event.payload.durationMs || 0) / 1000))
      if (pos > 0) setProgress(playlistId, kind, id, pos, dur, progressExtras)
    } else if (event.type === "xt:android-native-finished") {
      if (event.payload.completed) {
        markCompleted(playlistId, kind, id, {
          duration: Math.max(0, Math.floor((event.payload.finalPosMs || 0) / 1000)),
          ...progressExtras,
        })
        try { opts.onCompleted?.() } catch {}
      }
      unsubscribe()
    } else if (event.type === "xt:android-native-error") {
      unsubscribe()
    }
  })
  const launched = launchAndroidNativeVod({
    contentKey,
    url: opts.url,
    title: opts.title,
    posterUrl: opts.posterUrl,
    startMs: opts.startMs,
  })
  if (!launched) unsubscribe()
  return launched
}
