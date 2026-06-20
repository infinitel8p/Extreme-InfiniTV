// Unified mount surface for the four playback backends.
//
// Returns a tagged union so call sites can branch cleanly between
// embedded (Video.js / HTML5) and external (MPV / VLC) playback. The
// embedded handle exposes a Video.js-shaped subset; the external launch
// is a fire-and-forget spawn with no progress / pause feedback.
//
// Reused utilities:
//   - getPlayerBackend    src/scripts/lib/app-settings.js
//   - getPlayerPath       src/scripts/lib/app-settings.js
//   - getPlayerExtraArgs  src/scripts/lib/app-settings.js
//   - log                 src/scripts/lib/log.js
//
// Desktop only - external backends invoke a Tauri command that's gated
// off on Android/iOS at the Rust side.

import { log } from "@/scripts/lib/log.js"
import {
  getPlayerBackend,
  getPlayerPath,
  getPlayerExtraArgs,
  getPlayerReuseInstance,
  getUserAgent,
  EXTERNAL_PLAYER_BACKENDS,
} from "@/scripts/lib/app-settings.js"

export type PlayerBackend = "videojs" | "artplayer" | "mpv" | "vlc"
export type ExternalPlayerKind = "mpv" | "vlc"

export const RESUME_MIN_SECONDS_DEFAULT = 5

export interface VjsLikeHandle {
  src(opts: { src: string; type: string }): void
  play(): Promise<unknown> | void
  pause(): void
  paused?(): boolean
  muted?(value?: boolean): boolean | void
  reset?(): void
  dispose?(): void
  duration?(): number
  currentTime?(value?: number): number
  on(event: string, fn: (...args: unknown[]) => void): void
  off?(event: string, fn: (...args: unknown[]) => void): void
  one?(event: string, fn: (...args: unknown[]) => void): void
  el?(): HTMLElement
  error?(): unknown
  requestFullscreen?(): Promise<void> | void
  userActive?(active: boolean): void
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
  | { kind: "embedded"; backend: "videojs" | "artplayer"; handle: VjsLikeHandle }
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

export const externalPlayersAvailable = isTauri && !isAndroid

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

type StreamKind = "hls" | "ts" | "native"

function streamKindHint(src: string, type?: string): StreamKind | "unknown" {
  // URL extension wins: Live TV callers pass a stock
  // "application/x-mpegURL" MIME regardless of the real container, so
  // a contradicting extension overrides the MIME.
  if (/\.m3u8(\?|$)/i.test(src)) return "hls"
  if (/\.ts(\?|$)/i.test(src)) return "ts"
  if (/\.(mp4|m4v|mkv|webm|mov|avi|m4a|mp3|aac|flac|ogg)(\?|$)/i.test(src)) return "native"

  const mime = (type || "").toLowerCase()
  if (mime === "video/mp2t" || mime === "video/mpeg") return "ts"
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "native"
  return "unknown"
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
      if (
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
        response.body?.cancel?.()
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

// Origins whose .ts live URLs actually serve an HLS playlist
const tsServesHlsOrigins = new Set<string>()

function originOf(src: string): string | null {
  try {
    return new URL(src).origin
  } catch {
    return null
  }
}

// Confirm a .ts source is really an HLS playlist before flipping a failed
// mpegts load over to hls.js
async function tsSourceIsActuallyHls(src: string): Promise<boolean> {
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
        try { response.body?.cancel?.() } catch {}
        return true
      }
      const head = await response.text()
      return /^\uFEFF?\s*#EXTM3U/.test(head)
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return false
  }
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
    private _abortController: AbortController | null = null
    private _requestAbort = false
    private _receivedLength = 0
    private _rangeFrom = 0

    static isSupported() {
      return isTauri
    }

    constructor(seekHandler: any) {
      super("tauri-stream-loader")
      this._seekHandler = seekHandler
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
        const customUa = getUserAgent()
        if (customUa && !headers.has("User-Agent")) headers.set("User-Agent", customUa)
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

// Custom hls.js loader
function createTauriHlsLoaderClass() {
  return class TauriHlsLoader {
    context: any = null
    stats: any
    private callbacks: any = null
    private abortController: AbortController | null = null
    private timeoutTimer: ReturnType<typeof setTimeout> | null = null
    private aborted = false

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
        if (this.aborted) return
        this.abortInternal()
        this.callbacks?.onTimeout?.(this.stats, this.context, null)
      }, timeoutMs)
      void this.run(context)
    }

    private async run(context: any) {
      try {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
        const headers = new Headers()
        const customUa = getUserAgent()
        if (customUa) headers.set("User-Agent", customUa)
        const { rangeStart, rangeEnd } = context
        if (
          Number.isFinite(rangeStart) &&
          Number.isFinite(rangeEnd) &&
          rangeEnd > rangeStart
        ) {
          // hls.js byte ranges are [start, end); the Range header end is inclusive.
          headers.set("Range", `bytes=${rangeStart}-${rangeEnd - 1}`)
        }
        const response = await tauriFetch(context.url, {
          method: "GET",
          headers,
          signal: this.abortController?.signal,
        })
        if (this.aborted) return
        this.clearTimer()
        this.stats.loading.first = performance.now()
        if (!response.ok && response.status !== 206) {
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
        if (this.aborted) return
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
        if (this.aborted) return
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

async function attachMpegts(
  videoEl: HTMLVideoElement,
  url: string,
  onFatalError?: (detail: string) => void,
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

  const teardown = () => {
    if (!player) return
    try { player.unload() } catch {}
    try { player.detachMediaElement() } catch {}
    try { player.destroy() } catch {}
    player = null
  }

  const start = (useTauriLoader: boolean) => {
    const config = useTauriLoader
      ? { customLoader: createTauriStreamLoaderClass(mpegts) }
      : undefined
    player = mpegts.createPlayer({ type: "mpegts", isLive: true, url }, config)
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
    player.load()
    try {
      const playPromise = player.play?.()
      if (playPromise && typeof (playPromise as Promise<void>).catch === "function") {
        (playPromise as Promise<void>).catch(() => {})
      }
    } catch {}
  }

  start(false)
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
  const player = videojs(videoEl, {
    liveui: options.liveui ?? false,
    fluid: options.fluid ?? true,
    preload: options.preload ?? "auto",
    autoplay: options.autoplay ?? false,
    aspectRatio: options.aspectRatio ?? "16:9",
    controlBar: options.controlBar ?? {
      volumePanel: { inline: false },
      pictureInPictureToggle: options.pictureInPictureToggle ?? true,
      playbackRateMenuButton: true,
      subsCapsButton: true,
      audioTrackButton: true,
      fullscreenToggle: true,
    },
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
  let pendingSrc: string | null = null

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

  function destroyMpegts() {
    if (activeMpegts) {
      try { activeMpegts.destroy() } catch {}
      activeMpegts = null
    }
  }

  function loadHls(src: string) {
    destroyMpegts()
    player.src({ src, type: "application/x-mpegURL" })
  }

  function loadNative(src: string, type?: string) {
    destroyMpegts()
    player.src({ src, type: type || "video/mp4" })
  }

  async function recoverFailedTs(src: string, detail: string) {
    if (pendingSrc !== src) return
    const actuallyHls = await tsSourceIsActuallyHls(src)
    if (pendingSrc !== src) return
    if (actuallyHls) {
      const origin = originOf(src)
      if (origin) tsServesHlsOrigins.add(origin)
      log.warn(
        "[xt:player] .ts source served an HLS playlist - falling back to hls.js:",
        src
      )
      loadHls(src)
      return
    }
    try { player.error?.({ code: 2, message: detail }) } catch {}
  }

  async function loadTs(src: string) {
    destroyMpegts()
    try { player.pause?.() } catch {}
    try { player.reset() } catch {}
    const videoElement = getUnderlyingVideo()
    if (!videoElement) {
      loadHls(src)
      return
    }
    const handle = await attachMpegts(videoElement, src, (detail) => {
      if (pendingSrc !== src) return
      activeMpegts = null
      void recoverFailedTs(src, detail)
    })
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
    src({ src, type }) {
      pendingSrc = src
      const hint = streamKindHint(src, type)
      if (hint === "ts") {
        const origin = originOf(src)
        if (origin && tsServesHlsOrigins.has(origin)) loadHls(src)
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
      try { player.reset() } catch {}
      probeContainer(src)
        .then((kind) => {
          if (pendingSrc !== src) return
          if (kind === "ts") loadTs(src)
          else if (kind === "native") loadNative(src, type)
          else loadHls(src)
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
      destroyMpegts()
      try { player.reset() } catch {}
    },
    dispose() {
      pendingSrc = null
      destroyMpegts()
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
  }
  return wrapped
}

async function mountArtPlayer(videoEl: HTMLVideoElement): Promise<VjsLikeHandle> {
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
  let pendingSrc: string | null = null

  // hls.js attach, shared by the m3u8 customType and the .ts -> HLS recovery
  // path below (some providers' .ts URLs redirect to / serve an HLS playlist,
  // which mpegts.js can't demux).
  function loadHlsIntoVideo(video: HTMLVideoElement, url: string) {
    if (activeHls) {
      try { activeHls.destroy() } catch {}
      activeHls = null
    }
    if (activeMpegts) {
      try { activeMpegts.destroy() } catch {}
      activeMpegts = null
    }
    const preferNative =
      isMacOS && video.canPlayType("application/vnd.apple.mpegurl")
    if (preferNative) {
      video.src = url
    } else if ((Hls as any).isSupported()) {
      const hlsConfig: Record<string, unknown> = { enableWorker: !isTauri }
      if (isTauri) hlsConfig.loader = createTauriHlsLoaderClass()
      const hls = new (Hls as any)(hlsConfig)
      let netRecover = 0
      let mediaRecover = 0
      hls.on((Hls as any).Events.ERROR, (_event: unknown, data: any) => {
        if (!data?.fatal || activeHls !== hls) return
        const ErrorTypes = (Hls as any).ErrorTypes
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
        if (activeHls === hls) activeHls = null
        try { video.dispatchEvent(new Event("error")) } catch {}
      })
      hls.loadSource(url)
      hls.attachMedia(video)
      activeHls = hls
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url
    } else {
      log.warn("[xt:player] hls.js unsupported and no native HLS; fallback to <video src>")
      video.src = url
    }
  }

  // On a fatal mpegts error, a .ts URL may actually serve (or redirect to) an
  // HLS playlist. Confirm and switch to hls.js, remembering the origin so later
  // tunes on the same provider skip mpegts. Otherwise surface the error.
  async function recoverFailedArtTs(
    video: HTMLVideoElement,
    url: string,
    detail: string,
  ) {
    if (pendingSrc !== url) return
    const actuallyHls = await tsSourceIsActuallyHls(url)
    if (pendingSrc !== url) return
    if (actuallyHls) {
      const origin = originOf(url)
      if (origin) tsServesHlsOrigins.add(origin)
      log.warn(
        "[xt:player] .ts source served an HLS playlist - switching to hls.js:",
        url
      )
      loadHlsIntoVideo(video, url)
      return
    }
    log.error("[xt:player] mpegts fatal error (artplayer):", detail)
    try { video.dispatchEvent(new Event("error")) } catch {}
  }

  const art = new Artplayer({
    container,
    url: "",
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
      async ts(video, url) {
        if (activeHls) {
          try { activeHls.destroy() } catch {}
          activeHls = null
        }
        if (activeMpegts) {
          try { activeMpegts.destroy() } catch {}
          activeMpegts = null
        }
        const handle = await attachMpegts(video, url, (detail) => {
          if (pendingSrc !== url) return
          activeMpegts = null
          void recoverFailedArtTs(video, url, detail)
        })
        if (!handle) {
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

  art.on("destroy", () => {
    if (activeHls) {
      try { activeHls.destroy() } catch {}
      activeHls = null
    }
    if (activeMpegts) {
      try { activeMpegts.destroy() } catch {}
      activeMpegts = null
    }
  })

  const handle: VjsLikeHandle = {
    src({ src, type }) {
      pendingSrc = src
      if (activeHls) {
        try { activeHls.destroy() } catch {}
        activeHls = null
      }
      if (activeMpegts) {
        try { activeMpegts.destroy() } catch {}
        activeMpegts = null
      }
      const hint = streamKindHint(src, type)
      if (hint === "hls") {
        art.type = "m3u8"
        art.url = src
        return
      }
      if (hint === "ts") {
        const origin = originOf(src)
        art.type = origin && tsServesHlsOrigins.has(origin) ? "m3u8" : "ts"
        art.url = src
        return
      }
      if (hint === "native") {
        art.type = ""
        art.url = src
        return
      }
      // Unknown - wait for the probe before loading anything so we don't
      // briefly hand a TS body to hls.js and trip MediaSource errors.
      art.url = ""
      probeContainer(src)
        .then((kind) => {
          if (pendingSrc !== src) return
          art.type = kind === "ts" ? "ts" : kind === "native" ? "" : "m3u8"
          art.url = src
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
      if (activeHls) {
        try { activeHls.destroy() } catch {}
        activeHls = null
      }
      if (activeMpegts) {
        try { activeMpegts.destroy() } catch {}
        activeMpegts = null
      }
      art.url = ""
    },
    dispose() {
      pendingSrc = null
      if (activeMpegts) {
        try { activeMpegts.destroy() } catch {}
        activeMpegts = null
      }
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
  }
  return handle
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
    return {
      kind: "embedded",
      backend: "videojs",
      handle,
    }
  }
  // artplayer (default)
  const handle = await mountArtPlayer(videoEl)
  return {
    kind: "embedded",
    backend: "artplayer",
    handle,
  }
}

export function isExternalBackend(backend: PlayerBackend): boolean {
  return EXTERNAL_PLAYER_BACKENDS.includes(backend as ExternalPlayerKind)
}
