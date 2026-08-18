// One-line environment snapshot mirrored into the persistent log file once per app launch, so a
// bug report carries platform / version / player-backend context even with no other detail.
// No secrets: only platform-shape booleans and setting names/values that change playback behavior.

import { log } from "@/scripts/lib/log.js"
import { getCurrentAppVersion, isStoreBuild } from "@/scripts/lib/update-check.js"
import { deviceSupportsHevc, clearKeyAvailable } from "@/scripts/lib/codec-hints.js"
import { peekAudioTranscodeAvailable } from "@/scripts/lib/audio-proxy.js"
import { peekVodAudioRemuxAvailable } from "@/scripts/lib/vod-audio-proxy.js"
import {
  getPlayerBackend,
  getPerfMode,
  getNetworkTimeoutSeconds,
  getAudioTranscodeAuto,
  getUpdateChannel,
  getUserAgent,
  getFfmpegPath,
} from "@/scripts/lib/app-settings.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { getEntries, getActiveEntry } from "@/scripts/lib/creds.js"

export type PlatformFamily = "windows" | "macos" | "linux" | "android" | "web"

/** Shape of a stored playlist entry as read here: may carry serverUrl/username/password, but only type/mirrors/liveContainer are ever used. */
export interface SessionSnapshotPlaylistEntry {
  type?: string
  mirrors?: unknown
  liveContainer?: string
  [key: string]: unknown
}

export interface SessionSnapshotInputs {
  appVersion: string | null
  updateChannel: string | null
  storeBuild: boolean | null
  isTauri: boolean | null
  isWindows: boolean | null
  isMacOS: boolean | null
  isAndroid: boolean | null
  userAgent: string | null
  language: string | null
  screenWidth: number | null
  screenHeight: number | null
  devicePixelRatio: number | null
  hevcSupported: boolean | null
  clearKeySupported: boolean | null
  mseAvailable: boolean | null
  audioTranscodeAvailable: boolean | null
  vodAudioRemuxAvailable: boolean | null
  customFfmpegPathConfigured: boolean | null
  playerBackend: string | null
  perfMode: boolean | null
  perfModeAuto: boolean | null
  tvDevice: boolean | null
  networkTimeoutSeconds: number | null
  audioTranscodeAuto: boolean | null
  customUserAgentConfigured: boolean | null
  locale: string | null
  playlistCount: number | null
  activePlaylistEntry: SessionSnapshotPlaylistEntry | null
}

export interface SessionSnapshot {
  appVersion: string | null
  updateChannel: string | null
  storeBuild: boolean | null
  isTauri: boolean | null
  platform: PlatformFamily
  userAgent: string | null
  language: string | null
  screenWidth: number | null
  screenHeight: number | null
  devicePixelRatio: number | null
  hevcSupported: boolean | null
  clearKeySupported: boolean | null
  mseAvailable: boolean | null
  audioTranscodeAvailable: boolean | null
  vodAudioRemuxAvailable: boolean | null
  customFfmpegPathConfigured: boolean | null
  playerBackend: string | null
  perfMode: boolean | null
  perfModeAuto: boolean | null
  tvDevice: boolean | null
  networkTimeoutSeconds: number | null
  audioTranscodeAuto: boolean | null
  customUserAgentConfigured: boolean | null
  locale: string | null
  playlistCount: number | null
  activePlaylistType: string | null
  activePlaylistMirrorsConfigured: boolean | null
  activePlaylistLiveContainer: string | null
}

function derivePlatformFamily(
  input: Pick<SessionSnapshotInputs, "isTauri" | "isWindows" | "isMacOS" | "isAndroid">
): PlatformFamily {
  if (input.isAndroid) return "android"
  // Non-Tauri (browser tab) is its own family regardless of host OS - the
  // desktop-only capability probes below never apply there.
  if (!input.isTauri) return "web"
  if (input.isWindows) return "windows"
  if (input.isMacOS) return "macos"
  return "linux"
}

/** Pure builder: reads only type/mirrors/liveContainer off activePlaylistEntry, so a full stored entry (host/user/pass included) never reaches the output. */
export function buildSessionSnapshot(inputs: SessionSnapshotInputs): SessionSnapshot {
  const activeEntry = inputs.activePlaylistEntry
  const activePlaylistType = activeEntry?.type ?? null
  const isXtream = activePlaylistType === "xtream"

  return {
    appVersion: inputs.appVersion,
    updateChannel: inputs.updateChannel,
    storeBuild: inputs.storeBuild,
    isTauri: inputs.isTauri,
    platform: derivePlatformFamily(inputs),
    userAgent: inputs.userAgent,
    language: inputs.language,
    screenWidth: inputs.screenWidth,
    screenHeight: inputs.screenHeight,
    devicePixelRatio: inputs.devicePixelRatio,
    hevcSupported: inputs.hevcSupported,
    clearKeySupported: inputs.clearKeySupported,
    mseAvailable: inputs.mseAvailable,
    audioTranscodeAvailable: inputs.audioTranscodeAvailable,
    vodAudioRemuxAvailable: inputs.vodAudioRemuxAvailable,
    customFfmpegPathConfigured: inputs.customFfmpegPathConfigured,
    playerBackend: inputs.playerBackend,
    perfMode: inputs.perfMode,
    perfModeAuto: inputs.perfModeAuto,
    tvDevice: inputs.tvDevice,
    networkTimeoutSeconds: inputs.networkTimeoutSeconds,
    audioTranscodeAuto: inputs.audioTranscodeAuto,
    customUserAgentConfigured: inputs.customUserAgentConfigured,
    locale: inputs.locale,
    playlistCount: inputs.playlistCount,
    activePlaylistType,
    activePlaylistMirrorsConfigured: isXtream
      ? Array.isArray(activeEntry?.mirrors) && activeEntry.mirrors.length > 0
      : null,
    activePlaylistLiveContainer:
      isXtream && typeof activeEntry?.liveContainer === "string"
        ? activeEntry.liveContainer
        : null,
  }
}

const SESSION_FLAG = "xt_session_snapshot_logged"
// Fails open below (logs once per launch even without sessionStorage) - the data matters more than the noise.
let loggedThisPageLoad = false

function markSessionOnce(): boolean {
  if (loggedThisPageLoad) return false
  try {
    if (sessionStorage.getItem(SESSION_FLAG)) return false
    sessionStorage.setItem(SESSION_FLAG, "1")
    return true
  } catch {
    return true
  }
}

function safeSync<Value>(probe: () => Value, fallback: Value): Value {
  try {
    return probe()
  } catch {
    return fallback
  }
}

async function safeAsync<Value>(probe: () => Promise<Value>, fallback: Value): Promise<Value> {
  try {
    return await probe()
  } catch {
    return fallback
  }
}

function detectIsTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)
  )
}

function detectIsWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "")
}

function detectIsMacOS(): boolean {
  if (typeof navigator === "undefined") return false
  const platform = (navigator as any).platform || ""
  return /Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(navigator.userAgent || "")
}

function detectIsAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")
}

function detectMseAvailable(): boolean {
  return (
    typeof (globalThis as any).MediaSource !== "undefined" ||
    typeof (globalThis as any).ManagedMediaSource !== "undefined"
  )
}

function detectTvDevice(): boolean | null {
  const bridge = (window as any).AndroidDeviceInfo
  if (!bridge || typeof bridge.isTv !== "function") return null
  return !!bridge.isTv()
}

async function gatherInputs(): Promise<SessionSnapshotInputs> {
  const entries = await safeAsync(() => getEntries(), null)
  const activeEntry = await safeAsync(() => getActiveEntry(), null)

  return {
    appVersion: await safeAsync(() => getCurrentAppVersion(), null),
    updateChannel: safeSync(() => getUpdateChannel(), null),
    storeBuild: await safeAsync(() => isStoreBuild(), null),
    isTauri: safeSync(detectIsTauri, null),
    isWindows: safeSync(detectIsWindows, null),
    isMacOS: safeSync(detectIsMacOS, null),
    isAndroid: safeSync(detectIsAndroid, null),
    userAgent: safeSync(() => navigator.userAgent || null, null),
    language: safeSync(() => navigator.language || null, null),
    screenWidth: safeSync(() => window.screen?.width ?? null, null),
    screenHeight: safeSync(() => window.screen?.height ?? null, null),
    devicePixelRatio: safeSync(() => window.devicePixelRatio ?? null, null),
    hevcSupported: safeSync(deviceSupportsHevc, null),
    clearKeySupported: await safeAsync(() => clearKeyAvailable(), null),
    mseAvailable: safeSync(detectMseAvailable, null),
    // Peeked, not probed, so this doesn't run an ffmpeg subprocess on every launch; the play-time "plan decided" log covers the real value.
    audioTranscodeAvailable: safeSync(peekAudioTranscodeAvailable, null),
    vodAudioRemuxAvailable: safeSync(peekVodAudioRemuxAvailable, null),
    customFfmpegPathConfigured: safeSync(() => !!getFfmpegPath(), null),
    playerBackend: safeSync(() => getPlayerBackend(), null),
    perfMode: safeSync(() => getPerfMode(), null),
    perfModeAuto: safeSync(() => localStorage.getItem("xt_perf_mode_auto") === "1", null),
    tvDevice: safeSync(detectTvDevice, null),
    networkTimeoutSeconds: safeSync(() => getNetworkTimeoutSeconds(), null),
    audioTranscodeAuto: safeSync(() => getAudioTranscodeAuto(), null),
    customUserAgentConfigured: safeSync(() => !!getUserAgent(), null),
    locale: safeSync(() => getActiveLocale(), null),
    playlistCount: Array.isArray(entries) ? entries.length : null,
    activePlaylistEntry: activeEntry as SessionSnapshotPlaylistEntry | null,
  }
}

/** Public entry point for callers that want the snapshot without the once-per-launch logging gate. */
export async function collectSessionSnapshot(): Promise<SessionSnapshot> {
  return buildSessionSnapshot(await gatherInputs())
}

/** Fires once per app launch (sessionStorage-gated); safe to call again on the same page load, a no-op once logged. */
export async function logSessionSnapshot(): Promise<void> {
  try {
    if (!markSessionOnce()) return
    loggedThisPageLoad = true
    const snapshot = await collectSessionSnapshot()
    log.info("[xt:session] environment", snapshot)
  } catch (err) {
    try {
      log.warn("[xt:session] snapshot failed:", err)
    } catch {
      /* best-effort diagnostics only - never let this take down boot */
    }
  }
}

// Idle scheduling can be dropped entirely by a fast navigation; retry once on pagehide as a
// last-chance flush (a no-op if the idle callback already logged).
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { void logSessionSnapshot() })
}
