// Unified mount surface for the playback backends; the external MPV/VLC ones are desktop only.

import { log, redactUrl } from "@/scripts/lib/log.js"
import { DEFAULT_BROWSER_UA } from "@/scripts/lib/provider-fetch.js"
import { splitUrlAuth } from "@/scripts/lib/url-auth.js"
import { clearKeyAvailable } from "@/scripts/lib/codec-hints"
import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.js"
import { ICON_BADGE_CC } from "@/scripts/lib/icons.js"
import {
  createSubtitleManager,
  createNativeTrackRegistrar,
  createVideoJsTrackRegistrar,
} from "@/scripts/lib/subtitle-tracks.js"
import {
  createHlsAudioSource,
  createShakaAudioSource,
  attachVideoJsAudioMenu,
  attachArtplayerAudioControl,
  type AudioTrackSource,
} from "@/scripts/lib/audio-tracks.js"
import {
  getPlayerBackend,
  getPlayerPath,
  getPlayerExtraArgs,
  getPlayerReuseInstance,
  getUserAgent,
  EXTERNAL_PLAYER_BACKENDS,
} from "@/scripts/lib/app-settings.js"
import { bindMonoAudio, hasMonoGraph, isSafeAudioSourceUrl } from "@/scripts/lib/audio-effects.js"
import { sandboxRuntimeSync } from "@/scripts/lib/sandbox.ts"

export type PlayerBackend = "videojs" | "artplayer" | "shaka" | "mpv" | "vlc"
export type ExternalPlayerKind = "mpv" | "vlc"

export const RESUME_MIN_SECONDS_DEFAULT = 5

export interface PlaybackCodecInfo {
  videoCodec: string | null
  audioCodec: string | null
  errorDetail: string | null
}

export interface DrmOptions {
  manifestType?: string | null
  drmScheme?: string | null
  licenseKey?: string | null
}

export interface VjsLikeHandle {
  /** `isLive` defaults to true; pass false for a finite/seekable (catch-up) source. `durationSeconds` seeds duration when the container reports none (raw TS); `timelineOffsetSeconds` places a mid-programme remount on its timeline. `subtitles` opts a progressive MP4 source into embedded tx3g-subtitle extraction, or a `mkvSession` into push-mode subtitles from the MKV tee-proxy. `audio` backs track switching for engines with none (mpegts.js/native). */
  src(opts: { src: string; type: string; drm?: DrmOptions | null; isLive?: boolean; durationSeconds?: number; timelineOffsetSeconds?: number; subtitles?: { sourceUrl: string; mkvSession?: import("@/scripts/lib/vod-proxy.js").MkvSubtitleSession | null } | null; audio?: AudioTrackSource | null }): void
  play(): Promise<unknown> | void
  pause(): void
  paused?(): boolean
  muted?(value?: boolean): boolean | void
  reset?(): void
  dispose?(): void | Promise<void>
  duration?(): number
  currentTime?(value?: number): number
  on(event: string, fn: (...args: unknown[]) => void): void
  off?(event: string, fn: (...args: unknown[]) => void): void
  one?(event: string, fn: (...args: unknown[]) => void): void
  el?(): HTMLElement
  error?(): unknown
  requestFullscreen?(): Promise<void> | void
  userActive?(active: boolean): void
  /** What we learned about the current stream - feeds failure classification. */
  codecInfo?(): PlaybackCodecInfo
  /** The actual <video> element rendering playback - artplayer/shaka mount their own, distinct from the element passed to mountPlayer(). */
  getMediaElement?(): HTMLVideoElement | null
  /** Shifts subtitle timing by delta seconds; null if no subtitle track showing. */
  subtitleDelay?(deltaSeconds: number): number | null
}

export interface ExternalLaunchOptions {
  userAgent?: string | null
  referer?: string | null
  resumeSeconds?: number
  /** Localised "Couldn't launch <player>" toast title; caller-provided so we don't depend on i18n here. */
  // (not a function dep on purpose; toast wiring is at the call site)
}

export interface ExternalLauncher {
  /** Spawn the external player or reuse an existing window. Resolves once the IPC / spawn returns. */
  launch(
    src: string,
    options?: ExternalLaunchOptions,
  ): Promise<{ pid: number; reused: boolean }>
  kind: ExternalPlayerKind
  path: string
}

export type Mounted =
  | { kind: "embedded"; backend: "videojs" | "artplayer" | "shaka"; handle: VjsLikeHandle }
  | { kind: "external"; backend: ExternalPlayerKind; launcher: ExternalLauncher }

export interface MountOptions {
  liveui?: boolean
  fluid?: boolean
  aspectRatio?: string
  preload?: string
  autoplay?: boolean
  /** Hide Video.js's built-in PiP toggle when an Android native bridge handles it. */
  pictureInPictureToggle?: boolean
  controlBar?: Record<string, unknown>
  html5?: Record<string, unknown>
}

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const isAndroid = (() => {
  if (typeof navigator === "undefined") return false
  return /Android/i.test(navigator.userAgent || "")
})()

export const isMacOS = (() => {
  if (typeof navigator === "undefined") return false
  const platform = (navigator as any).platform || ""
  return /Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(navigator.userAgent || "")
})()

async function tauriWindowSetFullscreen(state: boolean): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().setFullscreen(state)
  } catch {}
}

async function subscribeTauriFullscreen(
  handler: (isFullscreen: boolean) => void,
): Promise<() => void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    const appWindow = getCurrentWindow()
    return await appWindow.onResized(async () => {
      try { handler(await appWindow.isFullscreen()) } catch {}
    })
  } catch {
    return () => {}
  }
}

function bindTauriFullscreenResync(
  onResync: (isFullscreen: boolean) => void,
): () => void {
  if (!(isTauri && isMacOS)) return () => {}
  let unlisten: (() => void) | null = null
  let disposed = false
  subscribeTauriFullscreen((isFs) => {
    try { onResync(isFs) } catch {}
  }).then((fn) => {
    if (disposed) { try { fn() } catch {} }
    else unlisten = fn
  })
  return () => {
    disposed = true
    try { unlisten?.() } catch {}
    unlisten = null
  }
}

const desktopPlatform = isTauri && !isAndroid

/** False on desktop when Snap/Flatpak confinement blocks host binaries. */
export const externalPlayersAvailable = desktopPlatform && !sandboxRuntimeSync()

export const androidExternalAvailable =
  isTauri &&
  isAndroid &&
  typeof window !== "undefined" &&
  !!(window as any).AndroidIntent

let invokePromise: Promise<((cmd: string, args: unknown) => Promise<unknown>) | null> | null = null
async function getInvoke() {
  if (!externalPlayersAvailable) return null
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as (cmd: string, args: unknown) => Promise<unknown>)
      .catch((error) => {
        log.warn("[xt:player] @tauri-apps/api/core import failed:", error)
        return null
      })
  }
  return invokePromise
}

// ---------------------------------------------------------------------------
// Argv builders (pure, unit-testable)
// ---------------------------------------------------------------------------
export interface ArgvInput {
  src: string
  userAgent?: string | null
  referer?: string | null
  resumeSeconds?: number
  extraArgs?: string[]
  /** Resume threshold; below this we don't pass a seek arg (avoids restart-from-credits glitch). */
  resumeMinSeconds?: number
}

export function buildMpvArgs(input: ArgvInput): string[] {
  const minResume = input.resumeMinSeconds ?? RESUME_MIN_SECONDS_DEFAULT
  const out: string[] = ["--force-window=immediate", "--no-terminal"]
  if (input.userAgent) out.push(`--user-agent=${input.userAgent}`)
  if (input.referer) out.push(`--referrer=${input.referer}`)
  if (/^rtsp:\/\//i.test(input.src)) {
    out.push("--demuxer-lavf-o=rtsp_transport=udp+tcp")
  }
  const resume = Number(input.resumeSeconds || 0)
  if (Number.isFinite(resume) && resume > minResume) {
    out.push(`--start=${Math.floor(resume)}`)
  }
  for (const arg of input.extraArgs || []) {
    if (arg && arg.trim()) out.push(arg)
  }
  out.push(input.src)
  return out
}

export function buildVlcArgs(input: ArgvInput): string[] {
  const minResume = input.resumeMinSeconds ?? RESUME_MIN_SECONDS_DEFAULT

  const out: string[] = isMacOS
    ? ["--no-fullscreen", "--play-and-exit"]
    : ["--no-qt-minimal-view", "--no-fullscreen", "--no-qt-error-dialogs", "--play-and-exit"]
  if (input.userAgent) out.push(`--http-user-agent=${input.userAgent}`)
  if (input.referer) out.push(`--http-referrer=${input.referer}`)
  const resume = Number(input.resumeSeconds || 0)
  if (Number.isFinite(resume) && resume > minResume) {
    out.push(`--start-time=${Math.floor(resume)}`)
  }
  for (const arg of input.extraArgs || []) {
    if (arg && arg.trim()) out.push(arg)
  }
  out.push(input.src)
  return out
}

export function buildArgsFor(kind: ExternalPlayerKind, input: ArgvInput): string[] {
  return kind === "mpv" ? buildMpvArgs(input) : buildVlcArgs(input)
}

// ---------------------------------------------------------------------------
// External launcher
// ---------------------------------------------------------------------------
export class PlayerNotConfiguredError extends Error {
  constructor(public readonly kind: ExternalPlayerKind) {
    super(`No path configured for ${kind}`)
    this.name = "PlayerNotConfiguredError"
  }
}

export class PlayerLaunchError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "PERMISSION" | "TIMEOUT" | "OTHER",
    public readonly kind: ExternalPlayerKind,
    public readonly path: string,
  ) {
    super(message)
    this.name = "PlayerLaunchError"
  }
}

export function classifyError(raw: unknown, kind: ExternalPlayerKind, path: string): PlayerLaunchError {
  const msg = typeof raw === "string" ? raw : (raw as Error)?.message || String(raw)
  const code = msg.startsWith("NOT_FOUND")
    ? "NOT_FOUND"
    : msg.startsWith("PERMISSION")
      ? "PERMISSION"
      : msg.startsWith("TIMEOUT")
        ? "TIMEOUT"
        : "OTHER"
  return new PlayerLaunchError(msg, code, kind, path)
}

export function getExternalLauncher(kind: ExternalPlayerKind): ExternalLauncher {
  const path = getPlayerPath(kind)
  return {
    kind,
    path,
    async launch(src, options = {}) {
      if (!path) throw new PlayerNotConfiguredError(kind)
      const invoke = await getInvoke()
      if (!invoke) {
        throw new PlayerLaunchError(
          "OTHER:Tauri invoke unavailable",
          "OTHER",
          kind,
          path,
        )
      }
      const args = buildArgsFor(kind, {
        src,
        userAgent: options.userAgent ?? getUserAgent() ?? null,
        referer: options.referer ?? null,
        resumeSeconds: options.resumeSeconds,
        extraArgs: getPlayerExtraArgs(kind),
      })
      const reuse = getPlayerReuseInstance(kind)
        ? { kind, enabled: true, url: src }
        : { kind, enabled: false, url: src }
      try {
        const result = (await invoke("launch_external_player", {
          path,
          args,
          mode: "launch",
          reuse,
        })) as { pid?: number; reused?: boolean }
        return { pid: Number(result?.pid) || 0, reused: !!result?.reused }
      } catch (raw) {
        throw classifyError(raw, kind, path)
      }
    },
  }
}

export const EXTERNAL_PLAYER_EXITED_EVENT = "xt:external-player-exited"

export interface ExternalPlayerExitPayload {
  kind: ExternalPlayerKind
}

/** Fires when a launched MPV/VLC process dies. No-op on web/Android. */
export function subscribeExternalPlayerExit(
  handler: (kind: ExternalPlayerKind) => void,
): () => void {
  if (!externalPlayersAvailable) return () => {}
  let unlisten: (() => void) | null = null
  let disposed = false
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event")
      const stopListening = await listen<ExternalPlayerExitPayload>(
        EXTERNAL_PLAYER_EXITED_EVENT,
        (event) => {
          if (event.payload?.kind) handler(event.payload.kind)
        },
      )
      if (disposed) stopListening()
      else unlisten = stopListening
    } catch (err) {
      log.warn("[xt:player] failed to subscribe to external-player-exit events:", err)
    }
  })()
  return () => {
    disposed = true
    try { unlisten?.() } catch (err) { log.warn("[xt:player] unlisten failed:", err) }
  }
}

// ---------------------------------------------------------------------------
// Android external handoff (parallel API to getExternalLauncher)
// ---------------------------------------------------------------------------
// The Android path doesn't spawn processes - it fires an Intent.ACTION_VIEW
// through the AndroidIntent bridge in MainActivity.kt. Two kinds:
//   "system"  - createChooser() so the user picks (Android remembers their
//               choice once they hit "Always").
//   "vlc"     - direct package-pinned launch to org.videolan.vlc. The UI
//               should only offer this when isVlcInstalled() returns true.

export type AndroidHandoffKind = "system" | "vlc"

interface AndroidIntentBridge {
  isVlcInstalled?: () => boolean
  isMxPlayerInstalled?: () => boolean
  viewStream?: (
    url: string,
    mime: string,
    userAgent: string,
    referer: string,
    title: string,
  ) => boolean
  openInVlc?: (
    url: string,
    mime: string,
    userAgent: string,
    referer: string,
    title: string,
  ) => boolean
  listVideoPlayerApps?: (url: string, mime: string) => string
  openInPackage?: (
    pkg: string,
    activity: string,
    url: string,
    mime: string,
    userAgent: string,
    referer: string,
    title: string,
  ) => boolean
}

export interface AndroidVideoApp {
  pkg: string
  label: string
  activity: string
  icon: string
}

function androidIntent(): AndroidIntentBridge | null {
  if (typeof window === "undefined") return null
  const bridge = (window as any).AndroidIntent as AndroidIntentBridge | undefined
  return bridge || null
}

export function isVlcInstalledOnAndroid(): boolean {
  try {
    return !!androidIntent()?.isVlcInstalled?.()
  } catch (err) {
    log.warn("[xt:player] AndroidIntent.isVlcInstalled threw:", err)
    return false
  }
}

export function isMxPlayerInstalledOnAndroid(): boolean {
  try {
    return !!androidIntent()?.isMxPlayerInstalled?.()
  } catch (err) {
    log.warn("[xt:player] AndroidIntent.isMxPlayerInstalled threw:", err)
    return false
  }
}

// Pick a sensible MIME hint for the Android Intent.
export function androidMimeForUrl(url: string | null | undefined): string {
  if (!url) return "video/*"
  const path = (url.split("?")[0] ?? "").toLowerCase()
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl"
  if (path.endsWith(".ts")) return "video/mp2t"
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4"
  if (path.endsWith(".mkv")) return "video/x-matroska"
  if (path.endsWith(".webm")) return "video/webm"
  if (path.endsWith(".mov")) return "video/quicktime"
  if (path.endsWith(".avi")) return "video/x-msvideo"
  if (path.endsWith(".mpd")) return "application/dash+xml"
  if (/\/live\/[^/]+\/[^/]+\/\d+$/i.test(path)) {
    return "application/vnd.apple.mpegurl"
  }
  return "video/*"
}

export class AndroidHandoffError extends Error {
  constructor(
    message: string,
    public readonly code: "NO_BRIDGE" | "NO_HANDLER" | "VLC_MISSING" | "OTHER",
    public readonly kind: AndroidHandoffKind,
  ) {
    super(message)
    this.name = "AndroidHandoffError"
  }
}

export interface AndroidHandoffOptions {
  userAgent?: string | null
  referer?: string | null
  title?: string | null
  mime?: string | null
}

export interface AndroidHandoffLauncher {
  kind: AndroidHandoffKind
  available(): boolean
  launch(src: string, options?: AndroidHandoffOptions): Promise<void>
}

export function getAndroidHandoffLauncher(kind: AndroidHandoffKind): AndroidHandoffLauncher {
  return {
    kind,
    available() {
      if (!androidExternalAvailable) return false
      if (kind === "vlc") return isVlcInstalledOnAndroid()
      return true
    },
    async launch(src, options = {}) {
      const bridge = androidIntent()
      if (!bridge) {
        throw new AndroidHandoffError(
          "AndroidIntent bridge not available",
          "NO_BRIDGE",
          kind,
        )
      }
      const mime = options.mime || androidMimeForUrl(src)
      const userAgent = options.userAgent || getUserAgent() || ""
      const referer = options.referer || ""
      const title = options.title || ""
      try {
        let ok = false
        if (kind === "vlc") {
          if (!bridge.isVlcInstalled?.()) {
            throw new AndroidHandoffError(
              "VLC for Android is not installed",
              "VLC_MISSING",
              kind,
            )
          }
          ok = !!bridge.openInVlc?.(src, mime, userAgent, referer, title)
        } else {
          ok = !!bridge.viewStream?.(src, mime, userAgent, referer, title)
        }
        if (!ok) {
          throw new AndroidHandoffError(
            kind === "vlc"
              ? "VLC refused to open the stream"
              : "No app on this device can handle this stream",
            kind === "vlc" ? "OTHER" : "NO_HANDLER",
            kind,
          )
        }
      } catch (err) {
        if (err instanceof AndroidHandoffError) throw err
        log.warn("[xt:player] AndroidIntent threw:", err)
        throw new AndroidHandoffError(String(err), "OTHER", kind)
      }
    },
  }
}

// Pre-resolve the chooser candidates so the UI can present its own picker.
// Used to dodge a long-standing VLC-on-Android quirk where chooser-routed
// intents resolve to the wrong activity inside VLC (its playback service
// starts but the player activity never foregrounds). Pairs with
// openStreamInAndroidPackage(), which launches via setPackage() - the same
// reliable path the dedicated VLC button uses.
export function listAndroidVideoPlayerApps(
  url: string,
  mime?: string | null,
): AndroidVideoApp[] {
  const bridge = androidIntent()
  if (!bridge?.listVideoPlayerApps) return []
  const resolvedMime = mime || androidMimeForUrl(url)
  try {
    const json = bridge.listVideoPlayerApps(url, resolvedMime)
    if (!json) return []
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => ({
        pkg: typeof entry?.pkg === "string" ? entry.pkg : "",
        label: typeof entry?.label === "string" ? entry.label : "",
        activity: typeof entry?.activity === "string" ? entry.activity : "",
        icon: typeof entry?.icon === "string" ? entry.icon : "",
      }))
      .filter((entry) => entry.pkg.length > 0)
  } catch (err) {
    log.warn("[xt:player] listVideoPlayerApps parse failed:", err)
    return []
  }
}

export interface AndroidPackageLaunchOptions extends AndroidHandoffOptions {
  /** Optional explicit activity component (from listAndroidVideoPlayerApps). */
  activity?: string | null
}

export async function openStreamInAndroidPackage(
  pkg: string,
  src: string,
  options: AndroidPackageLaunchOptions = {},
): Promise<void> {
  const bridge = androidIntent()
  if (!bridge?.openInPackage) {
    throw new AndroidHandoffError(
      "AndroidIntent bridge not available",
      "NO_BRIDGE",
      "system",
    )
  }
  const mime = options.mime || androidMimeForUrl(src)
  const userAgent = options.userAgent || getUserAgent() || ""
  const referer = options.referer || ""
  const title = options.title || ""
  const activity = options.activity || ""
  let ok = false
  try {
    ok = !!bridge.openInPackage(
      pkg,
      activity,
      src,
      mime,
      userAgent,
      referer,
      title,
    )
  } catch (err) {
    log.warn("[xt:player] AndroidIntent.openInPackage threw:", err)
    throw new AndroidHandoffError(String(err), "OTHER", "system")
  }
  if (!ok) {
    throw new AndroidHandoffError(
      `Couldn't launch ${pkg}`,
      "OTHER",
      "system",
    )
  }
}

export async function detectPlayer(
  kind: ExternalPlayerKind,
  candidatePath: string,
): Promise<{ ok: true; version: string } | { ok: false; error: PlayerLaunchError }> {
  if (!candidatePath) {
    return {
      ok: false,
      error: new PlayerLaunchError("NOT_FOUND:empty path", "NOT_FOUND", kind, ""),
    }
  }
  const invoke = await getInvoke()
  if (!invoke) {
    return {
      ok: false,
      error: new PlayerLaunchError(
        "OTHER:Tauri invoke unavailable",
        "OTHER",
        kind,
        candidatePath,
      ),
    }
  }
  const detectMode = kind === "vlc" ? "exists" : "detect"
  try {
    const result = (await invoke("launch_external_player", {
      path: candidatePath,
      args: [],
      mode: detectMode,
    })) as { version?: string }
    return { ok: true, version: String(result?.version || "").trim() }
  } catch (raw) {
    return { ok: false, error: classifyError(raw, kind, candidatePath) }
  }
}

// ---------------------------------------------------------------------------
// Container detection
// ---------------------------------------------------------------------------
// Two paths: a synchronous hint from URL extension or supplied MIME, and an
// async Content-Type probe used when the URL has no useful extension (e.g.
// Dispatcharr's `/proxy/ts/stream/<uuid>` or Xtream's bare `/live/<u>/<p>/<id>`
// which the server can serve as either HLS or raw TS).

type StreamKind = "hls" | "ts" | "native" | "dash"

function streamKindHint(src: string, type?: string): StreamKind | "unknown" {
  // URL extension wins: Live TV callers pass a stock
  // "application/x-mpegURL" MIME regardless of the real container, so
  // a contradicting extension overrides the MIME.
  if (/\.m3u8(\?|$)/i.test(src)) return "hls"
  if (/\.mpd(\?|$)/i.test(src)) return "dash"
  if (/\.ts(\?|$)/i.test(src)) return "ts"
  if (/\.(mp4|m4v|mkv|webm|mov|avi|m4a|mp3|aac|flac|ogg)(\?|$)/i.test(src)) return "native"

  const mime = (type || "").toLowerCase()
  if (mime.includes("dash+xml")) return "dash"
  if (mime === "video/mp2t" || mime === "video/mpeg") return "ts"
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "native"
  return "unknown"
}

function isDashSource(drm: DrmOptions | null | undefined, src: string, type?: string): boolean {
  const manifest = (drm?.manifestType || "").toLowerCase()
  if (manifest === "mpd" || manifest === "dash") return true
  return streamKindHint(src, type) === "dash"
}

const containerProbeCache = new Map<string, StreamKind>()

async function probeContainer(src: string): Promise<StreamKind> {
  let origin: string
  try {
    origin = new URL(src).origin
  } catch {
    return "hls"
  }
  const cached = containerProbeCache.get(origin)
  if (cached) return cached
  try {
    const { providerFetch } = await import("@/scripts/lib/provider-fetch.js")
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 4000) : null
    let kind: StreamKind = "hls"
    try {
      const response = await providerFetch(src, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: controller?.signal,
      })
      const contentType = (response.headers.get("content-type") || "").toLowerCase()
      if (contentType.includes("dash+xml") || /\.mpd(\?|$)/i.test(response.url || "")) {
        kind = "dash"
      } else if (
        contentType.includes("mp2t") ||
        contentType.includes("mpeg-ts") ||
        contentType.includes("mpegts")
      ) {
        kind = "ts"
      } else if (
        contentType.startsWith("video/") ||
        contentType.startsWith("audio/")
      ) {
        kind = "native"
      }
      try {
        void response.body?.cancel?.()?.catch?.(() => {})
      } catch {}
    } finally {
      if (timer) clearTimeout(timer)
    }
    containerProbeCache.set(origin, kind)
    return kind
  } catch {
    return "hls"
  }
}

const tsSourcesServingHls = new Set<string>()
const tsSourcesNotHls = new Set<string>()

async function readBodyStart(response: Response, maxBytes: number): Promise<string> {
  const body = response.body
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text()
    return text.slice(0, maxBytes)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
  if (!total) return ""
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged.subarray(0, maxBytes))
}

// Confirm whether a .ts source is really an HLS playlist before flipping a
// failed mpegts load over to hls.js. Tri-state: "inconclusive" (empty read,
// timeout, or network error) must NOT be memoized as a negative, or a slow but
// valid HLS-over-.ts channel gets permanently locked out of recovery.
async function tsSourceIsActuallyHls(
  src: string,
): Promise<"hls" | "not-hls" | "inconclusive"> {
  try {
    const { providerFetch } = await import("@/scripts/lib/provider-fetch.js")
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 4000) : null
    try {
      const response = await providerFetch(src, {
        method: "GET",
        headers: { Range: "bytes=0-511" },
        signal: controller?.signal,
      })
      const contentType = (response.headers.get("content-type") || "").toLowerCase()
      if (contentType.includes("mpegurl")) {
        try { void response.body?.cancel?.()?.catch?.(() => {}) } catch {}
        return "hls"
      }
      const head = await readBodyStart(response, 64)
      if (!head) return "inconclusive"
      return /^\uFEFF?\s*#EXTM3U/.test(head) ? "hls" : "not-hls"
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return "inconclusive"
  }
}

async function resolveTsRecovery(
  src: string,
  isCurrent: () => boolean,
): Promise<"hls" | "error"> {
  if (!isCurrent()) return "error"
  if (tsSourcesServingHls.has(src)) return "hls"
  if (tsSourcesNotHls.has(src)) return "error"
  const verdict = await tsSourceIsActuallyHls(src)
  if (!isCurrent()) return "error"
  if (verdict === "hls") {
    tsSourcesServingHls.add(src)
    return "hls"
  }

  if (verdict === "not-hls") tsSourcesNotHls.add(src)
  return "error"
}

interface MpegtsHandle {
  destroy: () => void
}

// Custom mpegts.js loader that streams via tauri-plugin-http instead of the
// WebView's fetch. The plugin runs the request on the Rust side, so CORS
// doesn't apply - some providers (and their redirect targets) don't send
// Access-Control-Allow-Origin and would otherwise feed zero bytes to MSE.
// Used as a one-shot fallback after a network error on the default loader.
function createTauriStreamLoaderClass(mpegts: any) {
  const { BaseLoader, LoaderStatus, LoaderErrors } = mpegts

  return class TauriStreamLoader extends BaseLoader {
    private _seekHandler: any
    private _config: any
    private _abortController: AbortController | null = null
    private _requestAbort = false
    private _receivedLength = 0
    private _rangeFrom = 0

    static isSupported() {
      return isTauri
    }

    constructor(seekHandler: any, config: any) {
      super("tauri-stream-loader")
      this._seekHandler = seekHandler
      this._config = config
      this._needStash = true
    }

    destroy() {
      if (this.isWorking()) this.abort()
      super.destroy()
    }

    open(dataSource: any, range: { from: number; to: number }) {
      this._status = LoaderStatus.kConnecting
      this._requestAbort = false
      this._receivedLength = 0
      this._rangeFrom = range?.from > 0 ? range.from : 0
      this._abortController = new AbortController()
      const sourceURL = dataSource?.redirectedURL || dataSource?.url
      const seekConfig = this._seekHandler.getConfig(sourceURL, range)
      void this._openStream(seekConfig)
    }

    private async _openStream(seekConfig: { url: string; headers: any }) {
      try {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
        const headers = new Headers(seekConfig.headers || undefined)
        // Config headers (e.g. Authorization from a userinfo URL) only reach
        // built-in mpegts loaders; seekConfig.headers never includes them.
        const configHeaders = this._config?.headers
        if (configHeaders && typeof configHeaders === "object") {
          for (const [headerName, headerValue] of Object.entries(configHeaders)) {
            headers.set(headerName, String(headerValue))
          }
        }
        if (!headers.has("User-Agent")) {
          headers.set("User-Agent", getUserAgent() || DEFAULT_BROWSER_UA)
        }
        const response = await tauriFetch(seekConfig.url, {
          method: "GET",
          headers,
          signal: this._abortController?.signal,
        })
        if (this._requestAbort) {
          try { await response.body?.cancel() } catch {}
          return
        }
        if (!response.ok || !response.body) {
          try { await response.body?.cancel() } catch {}
          this._status = LoaderStatus.kError
          this.onError?.(LoaderErrors.HTTP_STATUS_CODE_INVALID, {
            code: response.status,
            msg: response.statusText || `HTTP ${response.status}`,
          })
          return
        }
        const contentLength = parseInt(response.headers.get("content-length") || "", 10)
        if (Number.isFinite(contentLength) && contentLength > 0) {
          this.onContentLengthKnown?.(contentLength)
        }
        this._status = LoaderStatus.kBuffering
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (this._requestAbort) {
            try { await reader.cancel() } catch {}
            return
          }
          if (done) {
            this._status = LoaderStatus.kComplete
            this.onComplete?.(this._rangeFrom, this._rangeFrom + this._receivedLength - 1)
            return
          }
          const byteStart = this._rangeFrom + this._receivedLength
          this._receivedLength += value.byteLength
          const chunk =
            value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
              ? value.buffer
              : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
          this.onDataArrival?.(chunk, byteStart, this._receivedLength)
        }
      } catch (fetchError: any) {
        if (this._requestAbort) return
        this._status = LoaderStatus.kError
        this.onError?.(LoaderErrors.EXCEPTION, {
          code: -1,
          msg: String(fetchError?.message || fetchError),
        })
      }
    }

    abort() {
      this._requestAbort = true
      try { this._abortController?.abort() } catch {}
    }
  }
}

function matchesAuthorizedOrigin(requestUrl: string, authorizedOrigin: string | null): boolean {
  if (!authorizedOrigin) return false
  try {
    return new URL(requestUrl).origin === authorizedOrigin
  } catch {
    return false
  }
}

// Custom hls.js loader
function createTauriHlsLoaderClass(
  authorization: string | null = null,
  authorizedOrigin: string | null = null,
) {
  return class TauriHlsLoader {
    context: any = null
    stats: any
    private callbacks: any = null
    private abortController: AbortController | null = null
    private timeoutTimer: ReturnType<typeof setTimeout> | null = null
    private aborted = false
    private timedOut = false

    constructor() {
      this.stats = {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      }
    }

    private clearTimer() {
      if (this.timeoutTimer) {
        clearTimeout(this.timeoutTimer)
        this.timeoutTimer = null
      }
    }

    destroy() {
      this.callbacks = null
      this.abortInternal()
      this.context = null
    }

    private abortInternal() {
      this.stats.aborted = true
      this.clearTimer()
      try { this.abortController?.abort() } catch {}
    }

    abort() {
      this.aborted = true
      this.abortInternal()
      this.callbacks?.onAbort?.(this.stats, this.context, null)
    }

    load(context: any, config: any, callbacks: any) {
      if (this.stats.loading.start) return
      this.context = context
      this.callbacks = callbacks
      this.stats.loading.start = performance.now()
      this.abortController =
        typeof AbortController !== "undefined" ? new AbortController() : null
      const timeoutMs =
        config?.loadPolicy?.maxLoadTimeMs || config?.timeout || 20_000
      this.timeoutTimer = setTimeout(() => {
        if (this.aborted || this.timedOut) return
        this.timedOut = true
        this.abortInternal()
        this.callbacks?.onTimeout?.(this.stats, this.context, null)
      }, timeoutMs)
      void this.run(context)
    }

    private async run(context: any) {
      try {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
        const { url: requestUrl, authorization: urlAuthorization } = splitUrlAuth(context.url)
        const headers = new Headers()
        headers.set("User-Agent", getUserAgent() || DEFAULT_BROWSER_UA)
        // Playlist credentials stay scoped to their origin so they never
        // leak to cross-origin segment/key hosts; per-URL userinfo always wins.
        const effectiveAuthorization =
          urlAuthorization ||
          (matchesAuthorizedOrigin(requestUrl, authorizedOrigin) ? authorization : null)
        if (effectiveAuthorization) headers.set("Authorization", effectiveAuthorization)
        const { rangeStart, rangeEnd } = context
        if (
          Number.isFinite(rangeStart) &&
          Number.isFinite(rangeEnd) &&
          rangeEnd > rangeStart
        ) {
          // hls.js byte ranges are [start, end); the Range header end is inclusive.
          headers.set("Range", `bytes=${rangeStart}-${rangeEnd - 1}`)
        }
        const response = await tauriFetch(requestUrl, {
          method: "GET",
          headers,
          signal: this.abortController?.signal,
        })
        if (this.aborted || this.timedOut) {
          try { void response.body?.cancel?.()?.catch?.(() => {}) } catch {}
          return
        }
        this.stats.loading.first = performance.now()
        if (!response.ok && response.status !== 206) {
          this.clearTimer()
          try { void response.body?.cancel?.()?.catch?.(() => {}) } catch {}
          this.callbacks?.onError?.(
            {
              code: response.status,
              text: response.statusText || `HTTP ${response.status}`,
            },
            this.context,
            null,
            this.stats
          )
          return
        }
        const wantsBuffer = context.responseType === "arraybuffer"
        const data: string | ArrayBuffer = wantsBuffer
          ? await response.arrayBuffer()
          : await response.text()
        if (this.aborted || this.timedOut) return
        this.clearTimer()
        const length =
          typeof data === "string" ? data.length : data.byteLength
        this.stats.loaded = length
        this.stats.total = length
        this.stats.loading.end = performance.now()
        this.callbacks?.onSuccess?.(
          { url: response.url || context.url, data, code: response.status },
          this.stats,
          this.context,
          null
        )
      } catch (error: any) {
        if (this.aborted || this.timedOut) return
        this.clearTimer()
        this.callbacks?.onError?.(
          { code: 0, text: String(error?.message || error) },
          this.context,
          null,
          this.stats
        )
      }
    }

    getCacheAge() {
      return null
    }

    getResponseHeader() {
      return null
    }
  }
}

interface ActiveHlsRef {
  get: () => { destroy: () => void } | null
  set: (handle: { destroy: () => void } | null) => void
}

function attachHlsToVideo(
  Hls: any,
  video: HTMLVideoElement,
  url: string,
  codecState: PlaybackCodecInfo,
  active: ActiveHlsRef,
  onGiveUp: () => void,
): void {
  const existing = active.get()
  if (existing) {
    try { existing.destroy() } catch {}
    active.set(null)
  }
  // Native <video src> cannot carry a header, so those paths pass the
  // original url through as best-effort; the hls.js paths get the split form.
  const { url: cleanUrl, authorization } = splitUrlAuth(url)
  let authorizedOrigin: string | null = null
  if (authorization) {
    try { authorizedOrigin = new URL(cleanUrl).origin } catch {}
  }
  const preferNative =
    isMacOS && video.canPlayType("application/vnd.apple.mpegurl")
  if (preferNative) {
    // Force CORS when a mono graph is already attached: without it, this src plays silent forever.
    if (hasMonoGraph(video) && !isSafeAudioSourceUrl(url)) video.crossOrigin = "anonymous"
    video.src = url
    return
  }
  if (!Hls.isSupported()) {
    if (!video.canPlayType("application/vnd.apple.mpegurl")) {
      log.warn("[xt:player] hls.js unsupported and no native HLS; fallback to <video src>")
    }
    if (hasMonoGraph(video) && !isSafeAudioSourceUrl(url)) video.crossOrigin = "anonymous"
    video.src = url
    return
  }
  const hlsConfig: Record<string, unknown> = { enableWorker: true }
  if (isTauri) {
    hlsConfig.loader = createTauriHlsLoaderClass(authorization, authorizedOrigin)
  } else if (authorization) {
    // hls.js calls xhrSetup before its own open(); opening here lets us set
    // the Authorization header, and hls.js skips its open when already OPENED.
    // Skip cross-origin requests entirely so credentials stay on their host.
    hlsConfig.xhrSetup = (xhr: XMLHttpRequest, requestUrl: string) => {
      if (!matchesAuthorizedOrigin(requestUrl, authorizedOrigin)) return
      xhr.open("GET", requestUrl, true)
      xhr.setRequestHeader("Authorization", authorization)
    }
  }
  const hls = new Hls(hlsConfig)
  let netRecover = 0
  let mediaRecover = 0
  hls.on(Hls.Events.BUFFER_CODECS, (_event: unknown, data: any) => {
    if (active.get() !== hls) return
    const videoCodec = data?.video?.levelCodec || data?.video?.codec
    if (videoCodec) codecState.videoCodec = String(videoCodec)
    const audioCodec = data?.audio?.levelCodec || data?.audio?.codec
    if (audioCodec) codecState.audioCodec = String(audioCodec)
  })
  hls.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
    if (active.get() !== hls) return
    if (/codec/i.test(String(data?.details || ""))) {
      codecState.errorDetail = String(data.details)
      if (!codecState.videoCodec && typeof data?.mimeType === "string") {
        const fromMime = /codecs="?([^",]+)/i.exec(data.mimeType)?.[1]
        if (fromMime) codecState.videoCodec = fromMime
      }
    }
    if (!data?.fatal) return
    if (!codecState.errorDetail && data?.details) {
      codecState.errorDetail = String(data.details)
    }
    const ErrorTypes = Hls.ErrorTypes
    if (data.type === ErrorTypes.NETWORK_ERROR && netRecover < 2) {
      netRecover++
      try { hls.startLoad() } catch {}
      return
    }
    if (data.type === ErrorTypes.MEDIA_ERROR && mediaRecover < 2) {
      mediaRecover++
      try { hls.recoverMediaError() } catch {}
      return
    }
    try { hls.destroy() } catch {}
    if (active.get() === hls) active.set(null)
    onGiveUp()
  })
  hls.loadSource(cleanUrl)
  hls.attachMedia(video)
  active.set(hls)
}

function isClearKeyScheme(drmScheme: string | null | undefined): boolean {
  if (!drmScheme) return true
  return /clearkey/i.test(drmScheme)
}

function parseClearKeys(licenseKey: string | null | undefined): Record<string, string> | null {
  if (!licenseKey) return null
  if (/^https?:\/\//i.test(licenseKey.trim())) return null
  const keys: Record<string, string> = {}
  for (const pair of licenseKey.split(/\s+/)) {
    const [kid, key] = pair.split(":")
    if (kid && key) keys[kid.trim()] = key.trim()
  }
  return Object.keys(keys).length ? keys : null
}

// shaka.util.Error.Category values (stable across releases per shaka's own
// externs) - used to tell a genuine network failure apart from a
// decode/DRM one so classifyStartFailure() doesn't lump them together.
const SHAKA_CATEGORY_NETWORK = 1
const SHAKA_CATEGORY_MEDIA = 3
const SHAKA_CATEGORY_DRM = 6

// Shaka has no per-loader hook, so the Authorization header rides the WebView's fetch via a request filter.
function configureShakaDrmAndAuth(
  player: any,
  clearKeys: Record<string, string> | null,
  authorization: string | null,
  cleanUrl: string,
): void {
  player.configure({ drm: { clearKeys: clearKeys ?? {} } })
  if (!authorization) return
  let authorizedOrigin: string | null = null
  try { authorizedOrigin = new URL(cleanUrl).origin } catch {}
  player.getNetworkingEngine()?.registerRequestFilter((_type: unknown, request: any) => {
    const requestUrl = request?.uris?.[0]
    if (!requestUrl || !matchesAuthorizedOrigin(requestUrl, authorizedOrigin)) return
    request.headers = request.headers || {}
    request.headers["Authorization"] = authorization
  })
}

async function attachShaka(
  video: HTMLVideoElement,
  url: string,
  drm: DrmOptions | null | undefined,
  codecState: PlaybackCodecInfo,
  active: ActiveHlsRef,
  onGiveUp: (detail: string) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const existing = active.get()
  if (existing) {
    try { existing.destroy() } catch {}
    active.set(null)
  }
  const { url: cleanUrl, authorization } = splitUrlAuth(url)
  const mod = await import("shaka-player")
  if (!isCurrent()) return
  const shaka = (mod as any).default || mod
  shaka.polyfill.installAll()
  if (!shaka.Player.isBrowserSupported()) {
    onGiveUp("shaka:codec browser unsupported (no MediaSource/EME)")
    return
  }
  const clearKeys = isClearKeyScheme(drm?.drmScheme) ? parseClearKeys(drm?.licenseKey) : null
  if (clearKeys) {
    const supported = await clearKeyAvailable()
    if (!isCurrent()) return
    if (!supported) {
      onGiveUp("shaka:drm ClearKey (EME org.w3.clearkey) unsupported in this WebView")
      return
    }
  }
  const player = new shaka.Player()
  const handle = { destroy: () => { void player.destroy() }, player }
  configureShakaDrmAndAuth(player, clearKeys, authorization, cleanUrl)
  const fail = (raw: any) => {
    if (!isCurrent()) return
    const detail = describeShakaError(raw)
    log.warn("[xt:player] shaka/DASH error:", detail)
    codecState.errorDetail = detail
    if (!codecState.videoCodec) {
      const codecMatch = /codecs=\\?"?([^"\\,]+)/i.exec(detail)
      if (codecMatch) codecState.videoCodec = codecMatch[1]
    }
    onGiveUp(detail)
  }
  player.addEventListener("error", (event: any) => fail(event?.detail))
  try {
    await player.attach(video)
    if (!isCurrent()) {
      try { player.destroy() } catch {}
      return
    }
    await player.load(cleanUrl)
    if (!isCurrent()) {
      try { player.destroy() } catch {}
      return
    }
    active.set(handle)
    const track = player.getVariantTracks?.().find((variant: any) => variant.active)
    if (track?.videoCodec) codecState.videoCodec = String(track.videoCodec)
    if (track?.audioCodec) codecState.audioCodec = String(track.audioCodec)
    try { await video.play() } catch {}
  } catch (err: any) {
    if (!isCurrent()) return
    fail(err)
  }
}

function describeShakaError(detail: any): string {
  if (!detail) return "shaka: unknown error"
  const code = detail.code ?? detail.detail?.code
  const category = detail.category ?? detail.detail?.category
  const data = detail.data ?? detail.detail?.data
  const label =
    category === SHAKA_CATEGORY_DRM
      ? "drm"
      : category === SHAKA_CATEGORY_MEDIA
        ? "codec"
        : category === SHAKA_CATEGORY_NETWORK
          ? "network"
          : String(category ?? "unknown")
  return `shaka:${label}:${code}${data ? " " + JSON.stringify(data) : ""}`
}

/** Converts mpegts.js' native absolute offset back to its relative timeline. */
export function mpegtsRelativeTimestampOffset(nativeOffset: number, timelineOffset: number): number {
  return nativeOffset - timelineOffset
}

/** Rewraps a SourceBuffer's timestampOffset relative to baseSeconds; mpegts.js re-manages the native absolute value for audio drift. */
export function defineRelativeTimestampOffset(
  sourceBuffer: { timestampOffset: number },
  baseSeconds: number,
): void {
  const nativeDescriptor =
    Object.getOwnPropertyDescriptor(sourceBuffer, "timestampOffset")
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sourceBuffer), "timestampOffset")
  if (!nativeDescriptor) return
  let rawValue = nativeDescriptor.get ? nativeDescriptor.get.call(sourceBuffer) : sourceBuffer.timestampOffset
  const readNative = nativeDescriptor.get ? () => nativeDescriptor.get!.call(sourceBuffer) : () => rawValue
  const writeNative = nativeDescriptor.set
    ? (value: number) => nativeDescriptor.set!.call(sourceBuffer, value)
    : (value: number) => { rawValue = value }
  Object.defineProperty(sourceBuffer, "timestampOffset", {
    configurable: true,
    get() {
      return mpegtsRelativeTimestampOffset(readNative(), baseSeconds)
    },
    set(value: number) {
      writeNative(value + baseSeconds)
    },
  })
  writeNative(baseSeconds)
}

async function attachMpegts(
  videoEl: HTMLVideoElement,
  url: string,
  isLive: boolean,
  onFatalError?: (detail: string) => void,
  onMediaInfo?: (info: { videoCodec?: string; audioCodec?: string }) => void,
  durationSeconds?: number,
  timelineOffsetSeconds?: number,
): Promise<MpegtsHandle | null> {
  const mpegtsMod = await import("mpegts.js")
  const mpegts = (mpegtsMod as any).default || mpegtsMod
  if (!mpegts?.isSupported?.()) {
    log.warn("[xt:player] mpegts.js unsupported in this WebView")
    return null
  }

  let disposed = false
  let player: any = null
  let triedTauriLoader = false
  let durationRetryTimer: ReturnType<typeof setInterval> | null = null
  let offsetWrapTimer: ReturnType<typeof setInterval> | null = null

  const { url: cleanUrl, authorization } = splitUrlAuth(url)

  const teardown = () => {
    if (durationRetryTimer) {
      clearInterval(durationRetryTimer)
      durationRetryTimer = null
    }
    if (offsetWrapTimer) {
      clearInterval(offsetWrapTimer)
      offsetWrapTimer = null
    }
    if (!player) return
    try { player.unload() } catch {}
    try { player.detachMediaElement() } catch {}
    try { player.destroy() } catch {}
    player = null
  }

  const resolveMediaSource = () =>
    (player?._player_engine?._mse_controller ?? player?._mse_controller ?? player?._msectl)?._mediaSource

  // timestampOffset assignments are rebased via a wrapped setter because mpegts.js re-manages it for audio drift.
  const armTimelineOffsetWrap = () => {
    const baseSeconds = timelineOffsetSeconds
    if (isLive || !Number.isFinite(baseSeconds) || (baseSeconds as number) <= 0) return
    if (offsetWrapTimer) clearInterval(offsetWrapTimer)
    let attempts = 0
    offsetWrapTimer = setInterval(() => {
      attempts++
      if (disposed || !player) {
        if (offsetWrapTimer) {
          clearInterval(offsetWrapTimer)
          offsetWrapTimer = null
        }
        return
      }
      if (attempts > 200) {
        clearInterval(offsetWrapTimer!)
        offsetWrapTimer = null
        log.warn("[xt:player] timeline offset wrap gave up: mpegts.js internals not found after retry budget", { attempts })
        return
      }
      const mediaSource = resolveMediaSource()
      if (!mediaSource) return
      clearInterval(offsetWrapTimer!)
      offsetWrapTimer = null
      try {
        const originalAdd = mediaSource.addSourceBuffer.bind(mediaSource)
        mediaSource.addSourceBuffer = (mime: string) => {
          const sourceBuffer = originalAdd(mime)
          try {
            defineRelativeTimestampOffset(sourceBuffer, baseSeconds as number)
          } catch {}
          return sourceBuffer
        }
      } catch {}
    }, 25)
  }

  // mpegts.js never sets MediaSource.duration on the raw-TS path, so assign the known span directly (retried until source buffers are idle).
  const armDurationOverride = () => {
    if (isLive || !Number.isFinite(durationSeconds) || (durationSeconds as number) <= 0) return
    if (durationRetryTimer) clearInterval(durationRetryTimer)
    const spanSeconds = durationSeconds as number
    let attempts = 0
    durationRetryTimer = setInterval(() => {
      attempts++
      const stop = () => {
        if (durationRetryTimer) {
          clearInterval(durationRetryTimer)
          durationRetryTimer = null
        }
      }
      if (disposed || !player) return stop()
      if (attempts > 20) {
        stop()
        log.warn("[xt:player] duration override gave up: mpegts.js internals not found after retry budget", { attempts, spanSeconds })
        return
      }
      try {
        const mediaSource = resolveMediaSource()
        if (!mediaSource) return
        if (Number.isFinite(mediaSource.duration) && mediaSource.duration >= spanSeconds - 1) return stop()
        if (mediaSource.readyState !== "open") return
        const buffers: SourceBuffer[] = Array.from(mediaSource.sourceBuffers || [])
        if (buffers.some((buffer) => buffer.updating)) return
        mediaSource.duration = spanSeconds
        stop()
      } catch {}
    }, 300)
  }

  const start = (useTauriLoader: boolean) => {
    const config: Record<string, unknown> = {}
    if (useTauriLoader) config.customLoader = createTauriStreamLoaderClass(mpegts)
    if (authorization) config.headers = { Authorization: authorization }
    if (!isLive) {
      try {
        const hostname = new URL(cleanUrl).hostname
        // Lazy-load aborts kill stateful local proxy sessions.
        if (hostname === "127.0.0.1" || hostname === "localhost") config.lazyLoad = false
      } catch {}
    }
    const mediaDataSource: Record<string, unknown> = { type: "mpegts", isLive, url: cleanUrl }
    if (!isLive && Number.isFinite(durationSeconds) && (durationSeconds as number) > 0) {
      mediaDataSource.duration = Math.round((durationSeconds as number) * 1000)
    }
    player = mpegts.createPlayer(
      mediaDataSource,
      Object.keys(config).length ? config : undefined,
    )
    player.on(mpegts.Events.MEDIA_INFO, (info: any) => {
      if (disposed) return
      if (info?.videoCodec || info?.audioCodec) {
        onMediaInfo?.({
          videoCodec: info.videoCodec ? String(info.videoCodec) : undefined,
          audioCodec: info.audioCodec ? String(info.audioCodec) : undefined,
        })
      }
      armDurationOverride()
    })
    player.on(
      mpegts.Events.ERROR,
      (errorType: string, errorDetail: string, errorInfo: any) => {
        if (disposed) return
        // CORS-blocked or otherwise WebView-unreachable stream: retry once
        // through the Rust-side HTTP loader before declaring failure.
        if (
          errorType === mpegts.ErrorTypes.NETWORK_ERROR &&
          isTauri &&
          !triedTauriLoader
        ) {
          triedTauriLoader = true
          log.warn(
            "[xt:player] mpegts network error - retrying via Tauri HTTP loader:",
            errorDetail
          )
          teardown()
          start(true)
          return
        }
        const detail = errorInfo?.msg
          ? `${errorDetail}: ${errorInfo.msg}`
          : String(errorDetail || errorType)
        log.error("[xt:player] mpegts fatal error:", errorType, detail)
        teardown()
        onFatalError?.(detail)
      }
    )
    player.attachMediaElement(videoEl)
    armTimelineOffsetWrap()
    player.load()
    try {
      const playPromise = player.play?.()
      if (playPromise && typeof (playPromise as Promise<void>).catch === "function") {
        (playPromise as Promise<void>).catch(() => {})
      }
    } catch {}
  }

  // Browser fetch rejects userinfo URLs, so credentialed streams start straight on the Tauri HTTP loader.
  const startsWithTauriLoader = isTauri && Boolean(authorization)
  if (startsWithTauriLoader) triedTauriLoader = true
  start(startsWithTauriLoader)
  return {
    destroy() {
      disposed = true
      teardown()
    },
  }
}

// ---------------------------------------------------------------------------
// Embedded mounts
// ---------------------------------------------------------------------------
async function mountVideoJs(
  videoEl: HTMLVideoElement,
  options: MountOptions,
): Promise<VjsLikeHandle> {
  const [{ default: videojs }] = await Promise.all([
    import("video.js"),
    import("video.js/dist/video-js.css"),
  ])
  const controlBar = options.controlBar ?? {
    volumePanel: { inline: false },
    pictureInPictureToggle: options.pictureInPictureToggle ?? true,
    playbackRateMenuButton: true,
    subsCapsButton: true,
    audioTrackButton: true,
    fullscreenToggle: true,
  }
  // A non-empty playbackRates array surfaces its own rate control, so gate it like the menu button.
  const playbackRatesEnabled = controlBar.playbackRateMenuButton !== false
  const player = videojs(videoEl, {
    liveui: options.liveui ?? false,
    fluid: options.fluid ?? true,
    preload: options.preload ?? "auto",
    autoplay: options.autoplay ?? false,
    aspectRatio: options.aspectRatio ?? "16:9",
    controlBar,
    ...(playbackRatesEnabled ? { playbackRates: [0.75, 1, 1.25, 1.5, 2] } : {}),
    html5: options.html5 ?? {
      vhs: {
        overrideNative: !isMacOS,
        limitRenditionByPlayerDimensions: true,
        smoothQualityChange: true,
      },
    },
  }) as any

  let disposeFullscreenSync: () => void = () => {}
  if (isTauri && isMacOS) {
    player.requestFullscreen = async function () {
      try { player.addClass("vjs-fullscreen") } catch {}
      try { player.trigger("fullscreenchange") } catch {}
      await tauriWindowSetFullscreen(true)
    }
    player.exitFullscreen = async function () {
      try { player.removeClass("vjs-fullscreen") } catch {}
      try { player.trigger("fullscreenchange") } catch {}
      await tauriWindowSetFullscreen(false)
    }
    player.isFullscreen = function () {
      try { return player.hasClass?.("vjs-fullscreen") } catch { return false }
    }
    // Resync the vjs-fullscreen class when the window leaves/enters fullscreen
    // outside our overrides, so isFullscreen() stays truthful.
    disposeFullscreenSync = bindTauriFullscreenResync((isFs) => {
      if (isFs === !!player.hasClass?.("vjs-fullscreen")) return
      if (isFs) player.addClass("vjs-fullscreen")
      else player.removeClass("vjs-fullscreen")
      player.trigger("fullscreenchange")
    })
  }

  let activeMpegts: MpegtsHandle | null = null
  let pendingMpegtsAttach: Promise<MpegtsHandle | null> | null = null
  let activeHls: { destroy: () => void } | null = null
  let activeShaka: { destroy: () => void } | null = null
  let hlsModPromise: Promise<any> | null = null
  let pendingSrc: string | null = null
  let pendingIsLive = true
  let pendingDurationSeconds: number | undefined
  let pendingTimelineOffsetSeconds: number | undefined
  let pendingAudioSource: AudioTrackSource | null = null
  const codecState: PlaybackCodecInfo = { videoCodec: null, audioCodec: null, errorDetail: null }
  const subtitleManager = createSubtitleManager({
    registrar: createVideoJsTrackRegistrar(player),
    getCurrentTime: () => player.currentTime?.() || 0,
  })
  const audioMenu = attachVideoJsAudioMenu(videojs, player)

  function getUnderlyingVideo(): HTMLVideoElement | null {
    try {
      const tech = player.tech?.({ IWillNotUseThisInPlugins: true })
      const fromCall = tech?.el?.()
      if (fromCall instanceof HTMLVideoElement) return fromCall
      const fromField = tech?.el_
      if (fromField instanceof HTMLVideoElement) return fromField
    } catch {}
    return null
  }

  function destroyMpegts(): Promise<void> {
    if (activeMpegts) {
      try { activeMpegts.destroy() } catch {}
      activeMpegts = null
    }
    if (pendingMpegtsAttach) {
      const stale = pendingMpegtsAttach
      pendingMpegtsAttach = null
      return stale.then((handle) => { try { handle?.destroy() } catch {} }, () => {})
    }
    return Promise.resolve()
  }

  function destroyHls() {
    if (activeHls) {
      try { activeHls.destroy() } catch {}
      activeHls = null
    }
  }

  function destroyShaka() {
    if (activeShaka) {
      try { activeShaka.destroy() } catch {}
      activeShaka = null
    }
  }

  async function loadDash(src: string, drm: DrmOptions | null | undefined) {
    destroyMpegts()
    destroyHls()
    try { player.pause?.() } catch {}
    try { player.reset() } catch {}
    const video = getUnderlyingVideo()
    if (!video) {
      try { player.error?.({ code: 4, message: "DASH needs a media element" }) } catch {}
      return
    }
    await attachShaka(
      video,
      src,
      drm,
      codecState,
      { get: () => activeShaka, set: (handle) => { activeShaka = handle } },
      (detail) => {
        if (pendingSrc !== src) return
        audioMenu.setSource(pendingAudioSource)
        try { player.error?.({ code: 3, message: detail }) } catch {}
      },
      () => pendingSrc === src,
    )
    if (pendingSrc === src) {
      audioMenu.setSource(activeShaka ? createShakaAudioSource((activeShaka as any).player) : null)
    }
    try { player.hasStarted?.(true) } catch {}
  }

  function loadHls(src: string) {
    destroyMpegts()
    destroyShaka()
    // Credentialed URLs need hls.js too: VHS hands them to fetch/XHR, which
    // Chromium blocks for embedded credentials.
    if (isTauri || splitUrlAuth(src).authorization) {
      void loadHlsViaHlsJs(src)
      return
    }
    destroyHls()
    player.src({ src, type: "application/x-mpegURL" })
  }

  async function loadHlsViaHlsJs(src: string) {
    destroyHls()
    if (!getUnderlyingVideo()) {
      player.src({ src, type: "application/x-mpegURL" })
      return
    }
    try {
      if (!hlsModPromise) {
        hlsModPromise = import("hls.js").then((mod) => (mod as any).default || mod)
      }
      const Hls = await hlsModPromise
      if (pendingSrc !== src) return
      try { player.pause?.() } catch {}
      try { player.reset() } catch {}
      const video = getUnderlyingVideo()
      if (!video) {
        player.src({ src, type: "application/x-mpegURL" })
        return
      }
      attachHlsToVideo(
        Hls,
        video,
        src,
        codecState,
        { get: () => activeHls, set: (handle) => { activeHls = handle } },
        () => {
          if (pendingSrc !== src) return
          audioMenu.setSource(pendingAudioSource)
          try {
            player.error?.({
              code: 2,
              message: codecState.errorDetail || "HLS playback failed",
            })
          } catch {}
        },
      )
      audioMenu.setSource(activeHls ? createHlsAudioSource(activeHls as any) : null)
      try { player.hasStarted?.(true) } catch {}
    } catch (err) {
      log.warn("[xt:player] hls.js attach failed, falling back to VHS:", err)
      player.src({ src, type: "application/x-mpegURL" })
    }
  }

  function loadNative(src: string, type?: string) {
    destroyMpegts()
    destroyHls()
    destroyShaka()
    if (hasMonoGraph(videoEl) && !isSafeAudioSourceUrl(src)) videoEl.crossOrigin = "anonymous"
    player.src({ src, type: type || "video/mp4" })
  }

  async function recoverFailedTs(src: string, detail: string) {
    const outcome = await resolveTsRecovery(src, () => pendingSrc === src)
    if (outcome === "hls") {
      log.warn(
        "[xt:player] .ts source served an HLS playlist - falling back to hls.js:",
        redactUrl(src)
      )
      loadHls(src)
      return
    }
    if (pendingSrc !== src) return
    try { player.error?.({ code: 2, message: detail }) } catch {}
  }

  async function loadTs(src: string) {
    const mpegtsDrained = destroyMpegts()
    destroyHls()
    destroyShaka()
    try { player.pause?.() } catch {}
    try { player.reset() } catch {}
    const videoElement = getUnderlyingVideo()
    if (!videoElement) {
      loadHls(src)
      return
    }
    await mpegtsDrained
    if (pendingSrc !== src) return
    const attachPromise = attachMpegts(
      videoElement,
      src,
      pendingIsLive,
      (detail) => {
        if (pendingSrc !== src) return
        activeMpegts = null
        codecState.errorDetail = detail
        void recoverFailedTs(src, detail)
      },
      (info) => {
        if (pendingSrc !== src) return
        if (info.videoCodec) codecState.videoCodec = info.videoCodec
        if (info.audioCodec) codecState.audioCodec = info.audioCodec
      },
      pendingDurationSeconds,
      pendingTimelineOffsetSeconds,
    )
    pendingMpegtsAttach = attachPromise
    const handle = await attachPromise
    if (pendingMpegtsAttach === attachPromise) pendingMpegtsAttach = null
    if (!handle) {
      loadHls(src)
      return
    }
    if (pendingSrc !== src) {
      try { handle.destroy() } catch {}
      return
    }
    activeMpegts = handle
    try { player.hasStarted?.(true) } catch {}
  }

  const wrapped: VjsLikeHandle = {
    src({ src, type, drm, isLive, durationSeconds, timelineOffsetSeconds, subtitles, audio }) {
      pendingSrc = src
      pendingIsLive = isLive ?? true
      pendingDurationSeconds = durationSeconds
      pendingTimelineOffsetSeconds = timelineOffsetSeconds
      pendingAudioSource = audio ?? null
      codecState.videoCodec = null
      codecState.audioCodec = null
      codecState.errorDetail = null
      if (isDashSource(drm, src, type)) {
        subtitleManager.setSource(null)
        audioMenu.setSource(null)
        void loadDash(src, drm)
        return
      }
      const hint = streamKindHint(src, type)
      // ts/native lack engine audio switching; MKV subs come from the tee, not the container.
      const usesCallerSuppliedTracks = hint === "ts" || hint === "native"
      subtitleManager.setSource(
        usesCallerSuppliedTracks && subtitles ? subtitles.sourceUrl : null,
        type,
        usesCallerSuppliedTracks ? subtitles?.mkvSession ?? null : null,
      )
      audioMenu.setSource(usesCallerSuppliedTracks ? pendingAudioSource : null)
      if (hint === "ts") {
        if (tsSourcesServingHls.has(src)) loadHls(src)
        else loadTs(src)
        return
      }
      if (hint === "hls") {
        loadHls(src)
        return
      }
      if (hint === "native") {
        loadNative(src, type)
        return
      }
      // Unknown extension - probe and only load once we know the container
      destroyMpegts()
      destroyShaka()
      try { player.reset() } catch {}
      probeContainer(src)
        .then((kind) => {
          if (pendingSrc !== src) return
          if (kind === "dash") void loadDash(src, drm)
          else if (kind === "ts") {
            audioMenu.setSource(pendingAudioSource)
            if (subtitles) subtitleManager.setSource(subtitles.sourceUrl, type, subtitles?.mkvSession ?? null)
            loadTs(src)
          } else if (kind === "native") {
            audioMenu.setSource(pendingAudioSource)
            loadNative(src, type)
            if (subtitles) subtitleManager.setSource(subtitles.sourceUrl, type, subtitles?.mkvSession ?? null)
          } else loadHls(src)
        })
        .catch(() => {
          if (pendingSrc !== src) return
          loadHls(src)
        })
    },
    play() {
      return player.play()
    },
    pause() {
      player.pause()
    },
    paused() {
      return player.paused?.() ?? true
    },
    muted(value) {
      if (value === undefined) return player.muted?.() ?? false
      player.muted(!!value)
      return undefined
    },
    reset() {
      pendingSrc = null
      pendingAudioSource = null
      destroyMpegts()
      destroyHls()
      destroyShaka()
      subtitleManager.detach()
      audioMenu.setSource(null)
      try { player.reset() } catch {}
    },
    dispose() {
      pendingSrc = null
      pendingAudioSource = null
      destroyMpegts()
      destroyHls()
      destroyShaka()
      subtitleManager.detach()
      audioMenu.dispose()
      disposeFullscreenSync()
      try { player.dispose() } catch {}
    },
    duration() {
      const dur = player.duration?.()
      return Number.isFinite(dur) ? dur : 0
    },
    currentTime(value) {
      if (value === undefined) return player.currentTime?.() || 0
      player.currentTime(value)
      return value
    },
    on(event, fn) {
      player.on(event, fn)
    },
    off(event, fn) {
      player.off?.(event, fn)
    },
    one(event, fn) {
      player.one?.(event, fn)
    },
    el() {
      return player.el?.()
    },
    error() {
      return player.error?.() ?? null
    },
    requestFullscreen() {
      return player.requestFullscreen?.()
    },
    userActive(active) {
      try { player.userActive?.(active) } catch {}
    },
    codecInfo() {
      return { ...codecState }
    },
    getMediaElement() {
      return getUnderlyingVideo() ?? videoEl
    },
    subtitleDelay(deltaSeconds) {
      return subtitleManager.nudgeDelay(deltaSeconds)
    },
  }
  return wrapped
}

async function mountArtPlayer(videoEl: HTMLVideoElement, options: MountOptions = {}): Promise<VjsLikeHandle> {
  const [{ default: Artplayer }, { default: Hls }] = await Promise.all([
    import("artplayer"),
    import("hls.js"),
  ])

  const parent = videoEl.parentElement
  if (!parent) {
    throw new Error("[xt:player] ArtPlayer mount: videoEl has no parent")
  }
  const container = document.createElement("div")
  container.id = videoEl.id
  container.className = videoEl.className
  for (const attr of Array.from(videoEl.attributes)) {
    if (attr.name === "id" || attr.name === "class") continue
    container.setAttribute(attr.name, attr.value)
  }
  container.style.width = "100%"
  container.style.height = "100%"
  parent.replaceChild(container, videoEl)

  let activeHls: { destroy: () => void } | null = null
  let activeMpegts: MpegtsHandle | null = null
  let pendingMpegtsAttach: Promise<MpegtsHandle | null> | null = null
  let activeShaka: { destroy: () => void } | null = null
  let pendingSrc: string | null = null
  let pendingDrm: DrmOptions | null = null
  let pendingIsLive = true
  let pendingDurationSeconds: number | undefined
  let pendingTimelineOffsetSeconds: number | undefined
  let pendingAudioSource: AudioTrackSource | null = null
  const codecState: PlaybackCodecInfo = { videoCodec: null, audioCodec: null, errorDetail: null }

  function destroyMpegts(): Promise<void> {
    if (activeMpegts) {
      try { activeMpegts.destroy() } catch {}
      activeMpegts = null
    }
    if (pendingMpegtsAttach) {
      const stale = pendingMpegtsAttach
      pendingMpegtsAttach = null
      return stale.then((handle) => { try { handle?.destroy() } catch {} }, () => {})
    }
    return Promise.resolve()
  }

  function destroyArtEngines(includeHls = true) {
    if (includeHls && activeHls) {
      try { activeHls.destroy() } catch {}
      activeHls = null
    }
    destroyMpegts()
    if (activeShaka) {
      try { activeShaka.destroy() } catch {}
      activeShaka = null
    }
  }

  function loadDashIntoVideo(video: HTMLVideoElement, url: string, drm: DrmOptions | null) {
    destroyArtEngines()
    audioControl.setSource(null)
    attachShaka(
      video,
      url,
      drm,
      codecState,
      { get: () => activeShaka, set: (handle) => { activeShaka = handle } },
      () => {
        if (pendingSrc !== url) return
        audioControl.setSource(pendingAudioSource)
        try { video.dispatchEvent(new Event("error")) } catch {}
      },
      () => pendingSrc === url,
    ).then(() => {
      if (pendingSrc !== url) return
      audioControl.setSource(activeShaka ? createShakaAudioSource((activeShaka as any).player) : null)
    })
  }

  // hls.js attach, shared by the m3u8 customType and the .ts -> HLS recovery
  // path below (some providers' .ts URLs redirect to / serve an HLS playlist,
  // which mpegts.js can't demux).
  function loadHlsIntoVideo(video: HTMLVideoElement, url: string) {
    destroyMpegts()
    if (activeShaka) {
      try { activeShaka.destroy() } catch {}
      activeShaka = null
    }
    attachHlsToVideo(
      Hls,
      video,
      url,
      codecState,
      { get: () => activeHls, set: (handle) => { activeHls = handle } },
      () => {
        if (pendingSrc !== url) return
        audioControl.setSource(pendingAudioSource)
        try { video.dispatchEvent(new Event("error")) } catch {}
      },
    )
    audioControl.setSource(activeHls ? createHlsAudioSource(activeHls as any) : null)
  }

  // On a fatal mpegts error, a .ts URL may actually serve (or redirect to) an
  // HLS playlist. Confirm and switch to hls.js, remembering the URL so a later
  // tune of the same channel skips mpegts. Otherwise surface the error.
  async function recoverFailedArtTs(
    video: HTMLVideoElement,
    url: string,
    detail: string,
  ) {
    const outcome = await resolveTsRecovery(url, () => pendingSrc === url)
    if (outcome === "hls") {
      log.warn(
        "[xt:player] .ts source served an HLS playlist - switching to hls.js:",
        redactUrl(url)
      )
      loadHlsIntoVideo(video, url)
      return
    }
    if (pendingSrc !== url) return
    log.error("[xt:player] mpegts fatal error (artplayer):", detail)
    try { video.dispatchEvent(new Event("error")) } catch {}
  }

  const accentColor = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim()
    || "oklch(0.78 0.15 330)"
  const art = new Artplayer({
    container,
    url: "",
    isLive: !!options.liveui,
    theme: accentColor,
    volume: 1,
    autoplay: false,
    autoSize: false,
    autoMini: false,
    setting: false,
    flip: false,
    pip: true,
    playbackRate: true,
    aspectRatio: false,
    fullscreen: true,
    fullscreenWeb: true,
    miniProgressBar: false,
    mutex: true,
    backdrop: false,
    playsInline: true,
    customType: {
      m3u8(video, url) {
        loadHlsIntoVideo(video, url)
      },
      mpd(video, url) {
        loadDashIntoVideo(video, url, pendingDrm)
      },
      async ts(video, url) {
        if (activeHls) {
          try { activeHls.destroy() } catch {}
          activeHls = null
        }
        await destroyMpegts()
        if (pendingSrc !== url) return
        const attachPromise = attachMpegts(
          video,
          url,
          pendingIsLive,
          (detail) => {
            if (pendingSrc !== url) return
            activeMpegts = null
            codecState.errorDetail = detail
            void recoverFailedArtTs(video, url, detail)
          },
          (info) => {
            if (pendingSrc !== url) return
            if (info.videoCodec) codecState.videoCodec = info.videoCodec
            if (info.audioCodec) codecState.audioCodec = info.audioCodec
          },
          pendingDurationSeconds,
          pendingTimelineOffsetSeconds,
        )
        pendingMpegtsAttach = attachPromise
        const handle = await attachPromise
        if (pendingMpegtsAttach === attachPromise) pendingMpegtsAttach = null
        if (!handle) {
          if (hasMonoGraph(video)) video.crossOrigin = "anonymous"
          video.src = url
          return
        }
        if (pendingSrc !== url) {
          try { handle.destroy() } catch {}
          return
        }
        activeMpegts = handle
      },
    },
  })

  let disposeFullscreenSync: () => void = () => {}
  if (isTauri && isMacOS) {
    art.on("ready", () => {
      const btn = container.querySelector(".art-control-fullscreen") as HTMLElement | null
      if (!btn) return
      const replacement = btn.cloneNode(true) as HTMLElement
      btn.replaceWith(replacement)
      replacement.addEventListener("click", async (event) => {
        event.preventDefault()
        event.stopPropagation()
        const next = !art.fullscreenWeb
        art.fullscreenWeb = next
        await tauriWindowSetFullscreen(next)
      })
    })
    // Resync art.fullscreenWeb when the window leaves fullscreen out-of-band
    // (green button / Esc / gesture), so the next toggle goes the right way.
    disposeFullscreenSync = bindTauriFullscreenResync((isFs) => {
      if (art.fullscreenWeb !== isFs) art.fullscreenWeb = isFs
    })
  }

  const subtitleManager = createSubtitleManager({
    registrar: createNativeTrackRegistrar(() => art.video ?? null),
    getCurrentTime: () => art.currentTime || 0,
    onTracksReady: (tracks, activeIndex) => installSubtitleControl(tracks, activeIndex),
  })
  const audioControl = attachArtplayerAudioControl(art, t)

  art.on("destroy", () => {
    destroyArtEngines()
    subtitleManager.detach()
    audioControl.dispose()
  })

  function removeSubtitleControl(): void {
    try { art.controls.remove("xtSubtitles") } catch {}
  }

  // Inline fill beats artplayer's svg fill rule; no tooltip since it would overlap the selector panel.
  const subtitleControlIcon = ICON_BADGE_CC.replace(
    "<svg ",
    '<svg style="fill:none;width:22px;height:22px" ',
  ).replace('aria-hidden="true"', `role="img" aria-label="${t("player.subtitles").replace(/"/g, "&quot;")}"`)

  function installSubtitleControl(
    tracks: { index: number; label: string; language: string }[],
    activeIndex = -1,
  ): void {
    removeSubtitleControl()
    if (!tracks.length) return
    const add = () => {
      try {
        art.controls.add({
          name: "xtSubtitles",
          position: "right",
          index: 5,
          html: subtitleControlIcon,
          selector: [
            { html: escapeHtml(t("player.subtitles.off")), default: activeIndex < 0, value: -1 },
            ...tracks.map((track) => ({
              html: escapeHtml(track.label),
              value: track.index,
              default: track.index === activeIndex,
            })),
          ],
          onSelect(item) {
            subtitleManager.select(typeof item.value === "number" ? item.value : -1)
            return item.html
          },
        })
      } catch (err) {
        log.warn("[xt:player] artplayer subtitle control add failed:", err)
      }
    }
    if (art.isReady) add()
    else art.on("ready", add)
  }

  function setSubtitleSource(
    sourceUrl: string | null,
    mimeType?: string | null,
    mkvSession?: import("@/scripts/lib/vod-proxy.js").MkvSubtitleSession | null,
  ): void {
    removeSubtitleControl()
    subtitleManager.setSource(sourceUrl, mimeType, mkvSession ?? null)
  }

  const handle: VjsLikeHandle = {
    src({ src, type, drm, isLive, durationSeconds, timelineOffsetSeconds, subtitles, audio }) {
      pendingSrc = src
      pendingDrm = drm ?? null
      pendingIsLive = isLive ?? true
      pendingDurationSeconds = durationSeconds
      pendingTimelineOffsetSeconds = timelineOffsetSeconds
      pendingAudioSource = audio ?? null
      codecState.videoCodec = null
      codecState.audioCodec = null
      codecState.errorDetail = null
      destroyArtEngines()
      if (isDashSource(drm, src, type)) {
        setSubtitleSource(null)
        audioControl.setSource(null)
        art.type = "mpd"
        art.url = src
        return
      }
      const hint = streamKindHint(src, type)
      // ts/native lack engine audio switching; MKV subs come from the tee, not the container.
      const usesCallerSuppliedTracks = hint === "ts" || hint === "native"
      setSubtitleSource(
        usesCallerSuppliedTracks && subtitles ? subtitles.sourceUrl : null,
        type,
        usesCallerSuppliedTracks ? subtitles?.mkvSession ?? null : null,
      )
      audioControl.setSource(usesCallerSuppliedTracks ? pendingAudioSource : null)
      if (hint === "hls") {
        art.type = "m3u8"
        art.url = src
        return
      }
      if (hint === "ts") {
        art.type = tsSourcesServingHls.has(src) ? "m3u8" : "ts"
        art.url = src
        return
      }
      if (hint === "native") {
        art.type = ""
        // artplayer's default (non-customType) handling sets el.src directly.
        if (art.video && hasMonoGraph(art.video) && !isSafeAudioSourceUrl(src)) art.video.crossOrigin = "anonymous"
        art.url = src
        return
      }
      // Unknown - wait for the probe before loading anything so we don't
      // briefly hand a TS body to hls.js and trip MediaSource errors.
      art.url = ""
      probeContainer(src)
        .then((kind) => {
          if (pendingSrc !== src) return
          art.type = kind === "dash" ? "mpd" : kind === "ts" ? "ts" : kind === "native" ? "" : "m3u8"
          if (kind === "native" && art.video && hasMonoGraph(art.video) && !isSafeAudioSourceUrl(src)) {
            art.video.crossOrigin = "anonymous"
          }
          art.url = src
          if (kind === "ts" || kind === "native") audioControl.setSource(pendingAudioSource)
          if ((kind === "ts" || kind === "native") && subtitles) {
            setSubtitleSource(subtitles.sourceUrl, type, subtitles?.mkvSession ?? null)
          }
        })
        .catch(() => {
          if (pendingSrc !== src) return
          art.type = "m3u8"
          art.url = src
        })
    },
    play() {
      return art.play()
    },
    pause() {
      art.pause()
    },
    paused() {
      return art.video?.paused ?? true
    },
    muted(value) {
      if (value === undefined) return art.muted
      art.muted = !!value
      return undefined
    },
    reset() {
      pendingSrc = null
      pendingAudioSource = null
      destroyArtEngines()
      setSubtitleSource(null)
      audioControl.setSource(null)
      art.url = ""
    },
    dispose() {
      pendingSrc = null
      pendingAudioSource = null
      destroyArtEngines()
      disposeFullscreenSync()
      try { art.destroy(false) } catch {}
    },
    duration() {
      const dur = art.duration
      return Number.isFinite(dur) ? dur : 0
    },
    currentTime(value) {
      if (value === undefined) return art.currentTime || 0
      art.currentTime = value
      return value
    },
    on(event, fn) {
      art.video?.addEventListener(event, fn as EventListener)
    },
    off(event, fn) {
      art.video?.removeEventListener(event, fn as EventListener)
    },
    one(event, fn) {
      art.video?.addEventListener(event, fn as EventListener, { once: true })
    },
    el() {
      return container
    },
    error() {
      return art.video?.error ?? null
    },
    requestFullscreen() {
      art.fullscreen = true
    },
    codecInfo() {
      return { ...codecState }
    },
    getMediaElement() {
      return art.video ?? null
    },
    subtitleDelay(deltaSeconds) {
      return subtitleManager.nudgeDelay(deltaSeconds)
    },
  }
  return handle
}

async function mountShaka(videoEl: HTMLVideoElement, options: MountOptions = {}): Promise<VjsLikeHandle> {
  const [shakaModule] = await Promise.all([
    import("shaka-player/dist/shaka-player.ui.js"),
    import("shaka-player/dist/controls.css"),
  ])
  const shaka = (shakaModule as any).default || shakaModule
  shaka.polyfill.installAll()
  if (!shaka.Player.isBrowserSupported()) {
    throw new Error("[xt:player] Shaka mount: browser unsupported (no MediaSource/EME)")
  }

  const parent = videoEl.parentElement
  if (!parent) {
    throw new Error("[xt:player] Shaka mount: videoEl has no parent")
  }
  const container = document.createElement("div")
  container.id = videoEl.id
  container.className = videoEl.className
  for (const attr of Array.from(videoEl.attributes)) {
    if (attr.name === "id" || attr.name === "class") continue
    container.setAttribute(attr.name, attr.value)
  }
  container.style.width = "100%"
  container.style.height = "100%"
  container.style.position = "relative"
  const video = document.createElement("video")
  video.playsInline = true
  video.autoplay = options.autoplay ?? false
  video.style.width = "100%"
  video.style.height = "100%"
  container.appendChild(video)
  parent.replaceChild(container, videoEl)

  let player: any
  let ui: any
  let controls: any
  try {
    player = new shaka.Player()
    await player.attach(video)
    ui = new shaka.ui.Overlay(player, container, video)
    controls = ui.getControls()

    const accentColor = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim()
      || "oklch(0.78 0.15 330)"
    ui.configure({
      seekBarColors: { played: accentColor },
      volumeBarColors: { level: accentColor },
    })
  } catch (err) {
    try { ui?.destroy?.() } catch {}
    try { player?.destroy?.() } catch {}
    parent.replaceChild(videoEl, container)
    throw err
  }

  let activeMpegts: MpegtsHandle | null = null
  let pendingMpegtsAttach: Promise<MpegtsHandle | null> | null = null
  let pendingSrc: string | null = null
  let pendingDrm: DrmOptions | null = null
  let pendingIsLive = true
  let pendingDurationSeconds: number | undefined
  let pendingTimelineOffsetSeconds: number | undefined
  const codecState: PlaybackCodecInfo = { videoCodec: null, audioCodec: null, errorDetail: null }
  const subtitleManager = createSubtitleManager({
    registrar: createNativeTrackRegistrar(() => video),
    getCurrentTime: () => video.currentTime || 0,
  })

  function destroyMpegts(): Promise<void> {
    if (activeMpegts) {
      try { activeMpegts.destroy() } catch {}
      activeMpegts = null
    }
    if (pendingMpegtsAttach) {
      const stale = pendingMpegtsAttach
      pendingMpegtsAttach = null
      return stale.then((handle) => { try { handle?.destroy() } catch {} }, () => {})
    }
    return Promise.resolve()
  }

  function fail(src: string, detail: string) {
    if (pendingSrc !== src) return
    codecState.errorDetail = detail
    try { video.dispatchEvent(new Event("error")) } catch {}
  }

  player.addEventListener("error", (event: any) => {
    if (!pendingSrc) return
    fail(pendingSrc, describeShakaError(event?.detail))
  })

  async function loadIntoShaka(src: string, drm: DrmOptions | null | undefined, mimeTypeHint?: string) {
    destroyMpegts()
    const { url: cleanUrl, authorization } = splitUrlAuth(src)
    const clearKeys = isClearKeyScheme(drm?.drmScheme) ? parseClearKeys(drm?.licenseKey) : null
    if (clearKeys) {
      const supported = await clearKeyAvailable()
      if (pendingSrc !== src) return
      if (!supported) {
        fail(src, "shaka:drm ClearKey (EME org.w3.clearkey) unsupported in this WebView")
        return
      }
    }
    try {
      await player.attach(video)
      if (pendingSrc !== src) return
      setNativeControls(false)
      setShakaSeekBar(true)
      player.getNetworkingEngine()?.clearAllRequestFilters()
      configureShakaDrmAndAuth(player, clearKeys, authorization, cleanUrl)
      // Shaka can fall back to src= for non-MSE-able content, setting el.src directly.
      if (hasMonoGraph(video) && !isSafeAudioSourceUrl(cleanUrl)) video.crossOrigin = "anonymous"
      await player.load(cleanUrl, null, mimeTypeHint || undefined)
      if (pendingSrc !== src) return
      const track = player.getVariantTracks?.().find((variant: any) => variant.active)
      if (track?.videoCodec) codecState.videoCodec = String(track.videoCodec)
      if (track?.audioCodec) codecState.audioCodec = String(track.audioCodec)
    } catch (err: any) {
      if (pendingSrc !== src) return
      fail(src, describeShakaError(err))
    }
  }

  // A .ts URL that fails may actually be serving an HLS playlist - confirm and switch to shaka.
  async function recoverFailedTs(src: string, detail: string) {
    const outcome = await resolveTsRecovery(src, () => pendingSrc === src)
    if (outcome === "hls") {
      log.warn(
        "[xt:player] .ts source served an HLS playlist - switching to shaka:",
        redactUrl(src)
      )
      void loadIntoShaka(src, pendingDrm, "application/x-mpegURL")
      return
    }
    if (pendingSrc !== src) return
    fail(src, detail)
  }

  async function loadTs(src: string) {
    const mpegtsDrained = destroyMpegts()
    try { await player.detach() } catch {}
    if (pendingSrc !== src) return
    await mpegtsDrained
    if (pendingSrc !== src) return
    const attachPromise = attachMpegts(
      video,
      src,
      pendingIsLive,
      (detail) => {
        if (pendingSrc !== src) return
        activeMpegts = null
        codecState.errorDetail = detail
        void recoverFailedTs(src, detail)
      },
      (info) => {
        if (pendingSrc !== src) return
        if (info.videoCodec) codecState.videoCodec = info.videoCodec
        if (info.audioCodec) codecState.audioCodec = info.audioCodec
      },
      pendingDurationSeconds,
      pendingTimelineOffsetSeconds,
    )
    pendingMpegtsAttach = attachPromise
    const mpegtsHandle = await attachPromise
    if (pendingMpegtsAttach === attachPromise) pendingMpegtsAttach = null
    if (!mpegtsHandle) {
      void loadIntoShaka(src, pendingDrm, "application/x-mpegURL")
      return
    }
    if (pendingSrc !== src) {
      try { mpegtsHandle.destroy() } catch {}
      return
    }
    activeMpegts = mpegtsHandle
    // Shaka's seek bar reads its own (unloaded) player during raw TS, so finite mounts use native controls instead.
    setNativeControls(!pendingIsLive)
    setShakaSeekBar(false)
  }

  function setNativeControls(useNative: boolean) {
    try { controls?.setEnabledShakaControls?.(!useNative) } catch {}
    try { video.controls = useNative } catch {}
  }

  function setShakaSeekBar(enabled: boolean) {
    try { ui.configure({ addSeekBar: enabled }) } catch {}
  }

  const handle: VjsLikeHandle = {
    src({ src, type, drm, isLive, durationSeconds, timelineOffsetSeconds, subtitles }) {
      pendingSrc = src
      pendingDrm = drm ?? null
      pendingIsLive = isLive ?? true
      pendingDurationSeconds = durationSeconds
      pendingTimelineOffsetSeconds = timelineOffsetSeconds
      codecState.videoCodec = null
      codecState.audioCodec = null
      codecState.errorDetail = null
      if (isDashSource(drm, src, type)) {
        subtitleManager.setSource(null)
        void loadIntoShaka(src, drm, "application/dash+xml")
        return
      }
      const hint = streamKindHint(src, type)
      subtitleManager.setSource(
        hint === "native" && subtitles ? subtitles.sourceUrl : null,
        type,
        hint === "native" ? subtitles?.mkvSession ?? null : null,
      )
      // Shaka can't demux raw MPEG-TS; route it through mpegts.js instead.
      if (hint === "ts") {
        if (tsSourcesServingHls.has(src)) void loadIntoShaka(src, drm, "application/x-mpegURL")
        else void loadTs(src)
        return
      }
      if (hint === "hls") {
        void loadIntoShaka(src, drm, "application/x-mpegURL")
        return
      }
      if (hint === "native") {
        void loadIntoShaka(src, drm, type || undefined)
        return
      }
      destroyMpegts()
      probeContainer(src)
        .then((kind) => {
          if (pendingSrc !== src) return
          if (kind === "ts") void loadTs(src)
          else if (kind === "dash") void loadIntoShaka(src, drm, "application/dash+xml")
          else if (kind === "native") {
            void loadIntoShaka(src, drm, type || undefined)
            if (subtitles) subtitleManager.setSource(subtitles.sourceUrl, type, subtitles?.mkvSession ?? null)
          } else void loadIntoShaka(src, drm, "application/x-mpegURL")
        })
        .catch(() => {
          if (pendingSrc !== src) return
          void loadIntoShaka(src, drm, "application/x-mpegURL")
        })
    },
    play() {
      return video.play()
    },
    pause() {
      video.pause()
    },
    paused() {
      return video.paused ?? true
    },
    muted(value) {
      if (value === undefined) return video.muted
      video.muted = !!value
      return undefined
    },
    reset() {
      pendingSrc = null
      destroyMpegts()
      subtitleManager.detach()
      void player.unload().catch(() => {})
    },
    dispose() {
      pendingSrc = null
      destroyMpegts()
      subtitleManager.detach()
      const restoreOriginalVideoElement = () => {
        if (container.parentElement) container.parentElement.replaceChild(videoEl, container)
      }
      // Awaitable: a live<->catchup remount must not race the DOM restore.
      return ui.destroy().then(restoreOriginalVideoElement, restoreOriginalVideoElement)
    },
    duration() {
      return Number.isFinite(video.duration) ? video.duration : 0
    },
    currentTime(value) {
      if (value === undefined) return video.currentTime || 0
      video.currentTime = value
      return value
    },
    on(event, fn) {
      video.addEventListener(event, fn as EventListener)
    },
    off(event, fn) {
      video.removeEventListener(event, fn as EventListener)
    },
    one(event, fn) {
      video.addEventListener(event, fn as EventListener, { once: true })
    },
    el() {
      return container
    },
    error() {
      return video.error ?? null
    },
    requestFullscreen() {
      try {
        if (!controls?.isFullScreenEnabled?.()) return controls?.toggleFullScreen?.()
      } catch {}
    },
    codecInfo() {
      return { ...codecState }
    },
    getMediaElement() {
      return video
    },
    subtitleDelay(deltaSeconds) {
      return subtitleManager.nudgeDelay(deltaSeconds)
    },
  }
  return handle
}

// Runs the mono-graph disposer on player teardown so its nodes disconnect.
function wireMonoAudioDisposal(handle: VjsLikeHandle): void {
  const disposeMonoAudio = bindMonoAudio(handle)
  const originalDispose = handle.dispose?.bind(handle)
  handle.dispose = () => {
    disposeMonoAudio()
    return originalDispose?.()
  }
}

// ---------------------------------------------------------------------------
// Mount entry point
// ---------------------------------------------------------------------------
export async function mountPlayer(
  videoEl: HTMLVideoElement,
  backend: PlayerBackend = getPlayerBackend(),
  options: MountOptions = {},
): Promise<Mounted> {
  if (backend === "artplayer" && isAndroid) backend = "videojs"
  if (backend === "mpv" || backend === "vlc") {
    if (!externalPlayersAvailable) {
      log.warn(`[xt:player] external backend "${backend}" requested but not available; falling back to artplayer`)
      try {
        document.dispatchEvent(
          new CustomEvent("xt:player-fallback", {
            detail: { requested: backend, used: "artplayer" },
          }),
        )
      } catch {}
      return mountPlayer(videoEl, "artplayer", options)
    }
    return {
      kind: "external",
      backend,
      launcher: getExternalLauncher(backend),
    }
  }
  if (backend === "videojs") {
    const handle = await mountVideoJs(videoEl, options)
    wireMonoAudioDisposal(handle)
    return {
      kind: "embedded",
      backend: "videojs",
      handle,
    }
  }
  if (backend === "shaka") {
    const handle = await mountShaka(videoEl, options)
    wireMonoAudioDisposal(handle)
    return {
      kind: "embedded",
      backend: "shaka",
      handle,
    }
  }
  // artplayer (default)
  const handle = await mountArtPlayer(videoEl, options)
  wireMonoAudioDisposal(handle)
  return {
    kind: "embedded",
    backend: "artplayer",
    handle,
  }
}

export function isExternalBackend(backend: PlayerBackend): boolean {
  return EXTERNAL_PLAYER_BACKENDS.includes(backend as ExternalPlayerKind)
}
