// Backend identity only. Must stay import-free so small modules (pip-toggle.ts) can use it directly.

export type PlayerBackend = "videojs" | "artplayer" | "shaka" | "mpv-embedded" | "mpv" | "vlc"
export type ExternalPlayerKind = "mpv" | "vlc"

/** mpv decodes everything natively - MSE codec workarounds (transcode proxy, HEVC extension, wedge/dead-audio watchdogs) don't apply. */
export function isNativeVideoBackend(backend: PlayerBackend | string | null | undefined): boolean {
  return backend === "mpv-embedded"
}
